# Excel Agent for fintech reporting — plan

*Status: plan only. Nothing in this file is built yet except what section 3 marks as existing.*

## Context

The team receives four kinds of data on a regular cycle: **new-customer data, old-customer data, repayment data, and new-policy data**. Analysts spend a long time turning these into Excel reports. They want an **agent** that reads the whole file (or several files together), understands it, and answers what they ask by producing the finished table, pivot, chart or full report in Excel.

What exists today (in `addin/`, branch `claude/compassionate-euler-l15iz3`): a rule-based assistant for one table at a time, a data engine (filter, group, pivot, ratio-of-sums, rate, label, lookup, charts), streaming readers for large `.xlsx`/`.csv`, a data dictionary ("old user = cx_repeat_flag is 1"), a validated planner seam, and an unfinished Gemini planner (profile, prompt, plan checker, repair loop; uncommitted, typecheck error at `taskpane.ts:519-521`). Its weakness: it only understands sentence shapes it was coded for, works on one table, and cannot do a *whole report*.

The full AI design is in `docs/EXCEL_GPT_AI_PLAN.md` (PR #10). **This plan extends it for the fintech multi-file reporting case.** 

## 1. What the agent is

> Drop in the month's files. Ask: *"Repayment % of new vs old customers, by state, for loans under the new policy vs the old policy, and give me the monthly report."* Get back an Excel workbook: summary sheet, pivots, charts, notes on how each number was calculated.

Principle kept from the AI plan: **the model decides what to do; the engine does all the calculating on every row.** The model sees column names, types, ranges and a few safe category values, never rows.

## 2. What is new compared with today

| Need | Today | Add |
|---|---|---|
| Four datasets together | One table at a time | **Workspace**: several files/sheets loaded at once; the agent knows each table's role (new customers, old customers, repayments, policy) |
| Linking them | Manual lookup | **Relationship finder**: proposes join keys (customer_id, loan_id, policy_id) from names + value overlap, asked once and remembered |
| Whole-file analysis | Answers one question | **Agent loop**: plan → run → look at the result → next step; can do several steps for one request |
| Reports, not answers | Single result sheet | **Report builder**: a workbook with a summary sheet, several pivots/charts, notes; saved as a reusable **recipe** to rerun next month on new files |
| Policy analysis | Not covered | **Before/after + cohort comparison**: policy A vs B, effective-date split, repayment/delinquency by cohort |
| Trust | Preview + Apply | **"How calculated"** sheet, row-count reconciliation, checks (Old+New=Total, % in 0..100), same recipe → same numbers |
| Business words | Old/new users only | **Data dictionary v2**: old/new customer, repayment %, on-time, DPD buckets, NPA, policy cohort; shared and exportable across the team |
| Large data | JS engine, ~8M cells | **DuckDB engine** (WASM in browser, native in a desktop app) for crores of rows, multi-file joins |

## 3. Architecture (reuses what exists)

```
Files (xlsx/csv, several) -> Workspace (tables, roles, relationships)
        |                                  |
   Profiler (columns, roles,        Dictionary v2 (definitions, joins)
   safe values)  [src/ai/profile.ts]       |
        \________________  Agent loop  ___/        model = Gemini (free, test data)
                  plan -> validate -> run -> check -> next step / ask user
                              |                       model sees profile only
                     Data engine (existing JS -> DuckDB)
                              |
                  Report builder -> Excel workbook (+ native pivots/charts), recipe saved
```

Reuse: `src/ai/{profile,schema,prompt,gemini,run,ui}.ts` (written, uncommitted), `src/planner.ts` (`validatePlan`), `src/engine/*` (pivot, group_by with calculated, rate, label, lookup, chart), `src/engine/dictionary.ts`, readers/writers in `src/web/`, `docs/EXCEL_GPT_PLAN.md` (measured DuckDB-WASM numbers).

## 4. Phases

| # | Deliverable | You can see |
|---|---|---|
| **P0** | Finish and commit the Gemini planner (fix typecheck at `taskpane.ts:519`, tests, mocked-Gemini browser test); privacy rules (no ids/phones/PAN, values only for low-cardinality columns) | Free-form single-table questions understood |
| **P1** | **Workspace + relationships**: load multiple files, tag roles, confirm join keys once | "Repayment % of new customers by state" across customer + repayment files |
| **P2** | **Agent loop + "how calculated"** sheet and checks | Multi-step asks; every number explainable and reconciled |
| **P3** | **Report builder + recipes**: monthly report workbook, rerun on next month's files | One click to regenerate the monthly report |
| **P4** | **Policy analysis**: before/after, cohorts, comparison charts | New-policy vs old-policy repayment and delinquency |
| **P5** | **DuckDB engine** for multi-file joins and crores of rows | Large files in seconds |
| **P6** | Excel add-in + desktop app, dictionary sharing, audit log, golden-set CI gate | Whole team uses one definition of every term |

## 5. Quality gate (what "good" means)

- **Golden set**: ~25-50 real questions + real report layouts, each with an independently computed answer (Python); target >= 90% exactly right before rollout, zero wrong figures when checks pass.
- Reconciliation checks on every result (group totals = grand total, % within range, no silently dropped rows).
- Red-team set: ambiguous words, duplicate column names, mixed date formats, empty-heavy columns, multi-file key mismatches.
- Median answer < 10 s on a 1-lakh-row file.

## 6. Privacy and hosting (decided: Gemini)

- Start on **Gemini free tier with masked/fake data only** (free-tier prompts can be used by Google). Move real data to a paid, private option (Gemini/Claude via your cloud account, or a model on your own server) before production.
- API key stays in the user's browser (dev) -> small internal gateway (prod). One model interface, so changing provider is a settings change.
- Sent to the model: question, column names, types, ranges, empty share, common values of category columns. Never rows or personal fields.

## 7. Decisions / inputs needed from you

1. **The reports**: list your recurring reports (name, who gets it, columns/rows layout, frequency) and a masked sample of each. This defines P3.
2. **The four datasets**: a masked sample of each (real column names) and how they link (which column is the customer id, loan id, policy id).
3. **Definitions**: old vs new customer, repayment %, on time, policy effective date, delinquency bucket.
4. **25 real questions** your team asks.
5. **Biggest file** (rows x columns x MB) and laptop RAM.
6. **Where it runs**: website, Excel add-in, desktop app; and whether a small internal server is allowed (for the key and big files).

## 8. Risks

- Model misreads a request -> mitigated by reading shown first, validation, checks, easy correction.
- Joins on dirty keys (spaces, leading zeros) -> relationship finder normalises and reports unmatched counts.
- Domain terms differ per file -> ask once, remember, share.
- Free-tier limits -> fine for development; not for production.

## 9. Verification (once implemented)

- `cd addin && npm test` (unit + golden), `npm run typecheck`, `npm run build`.
- Browser test (Playwright, mocked Gemini) of: single-table question, multi-file join question, clarifying question flow, report generation, download and check of the `.xlsx` with openpyxl.
- Compare every golden-set answer with the independent Python numbers.

## 10. Next step

Wait for the inputs in section 7. Then finish P0 (the Gemini planner, partly written but not committed) and build P1 onward.
