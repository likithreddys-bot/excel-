# Excel GPT with AI — the product plan

*Drop in any spreadsheet. Ask for anything in plain words. Get the finished work back in a sheet — a pivot table, a chart, a cleaned table, a lookup, a reconciliation — the way a very good Excel analyst would deliver it. Works on lakhs to crores of rows.*

This replaces the "rules only" approach as the way the product **understands**. `EXCEL_GPT_PLAN.md` stays as the engine/large-data reference; this file is the AI-first design. The rule parser is kept only as an offline fallback for the simplest sentences.

---

## 1. Why the last version felt bad, and what changes

| Problem | Root cause | Fix in this plan |
|---|---|---|
| "It doesn't understand the sheet" | Fixed rules match known sentence shapes. Real questions are endless, and words like *old user*, *on time*, *bounce*, *NPA* mean different things per file. | A language model **reads the sheet's profile** (names, types, stats, sample values, past definitions) and **plans** the work. |
| Wrong or zero answers | Guessing which column the user meant. | The model picks columns from the profile, **shows its reading**, asks when unsure, and the answer is checked (section 7). |
| Only a few task types | Each task was hand-coded. | The model composes from a **full toolbox** (section 5) including SQL, so new tasks need no new code. |
| Big files | Everything held in memory. | DuckDB engine does the work (section 6); the model never touches rows. |

---

## 2. The one rule that makes it both smart and safe

> **The model decides *what to do*. The engine does *all the doing*.**

- The model sees: column names, types, null %, distinct counts, min/max, a **small sample of values per column**, the user's question, and saved definitions. **Never the rows.** Never a number it has to calculate.
- The model outputs: a **plan** (typed JSON steps) or a **SQL query**, plus a one-line explanation.
- The engine runs the plan on the full data and writes the result to a sheet. Every figure comes from the engine, so it is exact and repeatable. A model cannot "hallucinate" a total.

Privacy modes (pick one per deployment, section 9): **A** profile + samples, **B** names/types/stats only (no sample values), **C** fully local model, nothing leaves the machine.

---

## 3. How it feels to use (the happy path)

1. Drop in a file (`.xlsx`, `.csv`, several files). It opens in seconds, shows a preview, and builds a **profile** in the background.
2. Ask: *"repayment percentage of old users and new users as a pivot table."*
3. The assistant replies with its **reading**, in plain words, before running:
   *"I'll treat **Old = cx_repeat_flag is 1** and **New = 0**. Repayment % = **tot_amt ÷ alloc_amt** (sum over sum). Grouped by user type. Good?"* — one click to accept or change.
4. A **pivot sheet** appears: `User type | Due | Repaid | Repayment %`, with a Total row. Download as `.xlsx`.
5. Follow-ups work as a conversation: *"now by state"*, *"only last 3 months"*, *"add a bar chart"*, *"why is New lower?"*. Each builds on the last result.
6. Definitions you confirmed are **remembered** (per file layout, exportable to share with the team).

---

## 4. Architecture

```
 Browser / Excel add-in / Desktop app
 ┌──────────────────────────────────────────────────────────────────┐
 │  Chat UI  ──►  Orchestrator (agent loop)  ──►  Result writer     │
 │                   │        ▲                    (sheet, pivot,   │
 │                   ▼        │                     chart, .xlsx)   │
 │            Profile + Dictionary          Data engine (DuckDB)    │
 │            (names, stats, samples,       reads file in chunks,   │
 │             saved definitions)           runs SQL/plan on ALL rows│
 └───────────────────┬──────────────────────────────────────────────┘
                     │ only: question + profile (no rows)
                     ▼
              Model gateway  ──►  Hosted / private / local model
```

Components:

1. **Reader**: streaming `.xlsx`/`.csv` → columnar store (already built; goes into DuckDB at M3).
2. **Profiler**: per column — type, null %, distinct count, min/max/mean, top values, 5–10 sample values, date range, "looks like" (id, amount, date, flag, state, percentage).
3. **Dictionary** (already built): saved meanings — `Old user = cx_repeat_flag = 1`, `Repaid = tot_amt`, `Due = alloc_amt`, `On time = paid_date <= due_date`.
4. **Orchestrator**: builds the prompt, calls the model, validates the reply, runs it, checks the result, and loops on errors (section 7).
5. **Data engine**: DuckDB (WASM in the browser, native in the desktop app).
6. **Result writer**: sheet, native Excel PivotTable (add-in), chart, formatting, `.xlsx` export.
7. **Model gateway**: one interface, swappable provider; logs prompts (without data) for audit.

---

## 5. The toolbox the model can use

The model does not write free-form code against your data. It calls these **tools**; the orchestrator executes them.

| Tool | What it does |
|---|---|
| `describe_columns(names?)` | Return profile for chosen columns (stats, samples). |
| `value_counts(column, top)` | Distinct values and counts, so it can see that `state` has `MH, KA, …`. |
| `run_sql(query)` | Read-only SQL on the loaded tables (SELECT only; validated, row-limited output). |
| `make_pivot(rows, cols, values, calculated)` | Pivot with sum/avg/count and **ratio-of-sums** calculated fields. |
| `make_chart(kind, x, y)` | Bar / column / line / pie from a result. |
| `transform(table, steps)` | Clean-up: trim, case, fill, split, merge, dedupe, type convert, rename. |
| `lookup(left, right, key)` | VLOOKUP/XLOOKUP/joins across sheets and files. |
| `compare(a, b, key)` | Reconcile two tables: missing, extra, changed. |
| `format(rules)` | Conditional highlight, number formats (₹, lakh/crore), freeze, widths. |
| `ask_user(question, options)` | Ask a clarifying question when the request is ambiguous. |
| `save_definition(name, rule)` | Remember "old user", "NPA", "on time" for next time. |

Covers what a human Excel pro does: filter, sort, group, pivot, ratios, running totals, ranks, top-N, lookups, joins, de-duplication, date maths, text clean-up, reconciliation, conditional formatting, charts, summaries ("what stands out?"), and what-if columns.

---

## 6. Handling large data (lakhs to crores of rows)

| Tier | Where | Size | How |
|---|---|---|---|
| 1 | Browser, JS engine | up to ~8M cells | Today's engine. Instant for small files. |
| 2 | Browser, **DuckDB-WASM** in a worker | tens of millions of rows × few columns | Columns pruned on read, spills avoided, results (usually tiny) go to the sheet. Measured numbers are in `EXCEL_GPT_PLAN.md` §8. |
| 3 | **Desktop app / local server, native DuckDB** | crores of rows, GB files | Streams from disk, uses all cores. No browser memory limit. |

Rules: only the columns a question needs are loaded; a result sheet is always small enough to open (aggregates, top-N, or a capped detail export with a clear note); the preview never loads the whole file; long jobs show progress and can be cancelled.

---

## 7. Making it trustworthy (this is what separates a product from a demo)

1. **Reading shown first**: the assistant states columns and definitions it will use, in plain words, before running (can be set to "run immediately, show reading after" for trusted questions).
2. **Plan validation**: every column exists, types fit the operation, SQL is read-only and parses. Invalid → the error goes back to the model for one or two repairs, then it asks the user.
3. **Result checks**: row counts reconcile (group totals = overall total), percentages are within range, no silent null-dropping — shown as a small "checks passed" line.
4. **Show the work**: every result carries "How this was calculated" with the SQL/plan, and a **Re-run** button. Same plan → same answer, always.
5. **Never guess silently**: ambiguous term or two plausible columns → `ask_user` with buttons (remembered afterwards).
6. **Your original data is never modified**; results always go to new sheets.
7. **Golden tests**: a fixed set of real questions with verified answers runs on every change (section 10). A model upgrade cannot ship if it lowers the score.

---

## 8. Worked example: your repayment question

Profile (excerpt the model sees, no rows):

```
cx_repeat_flag  int   values {0: 41%, 1: 59%}     looks like: flag
loan_order_cnt  int   min 1  max 14               looks like: count
alloc_amt       num   min 0  max 480000           looks like: amount (due)
tot_amt         num   min 0  max 480000           looks like: amount (collected)
state           text  28 distinct  samples: MH, KA, TN, UP, GJ
```

Question: *"repayment percentage of old users and new users as pivot table"*

Model plan (typed, validated):

```json
{
  "tool": "make_pivot",
  "rows": [{"derive": "user_type", "case": [
      {"when": "cx_repeat_flag = 1", "then": "Old"},
      {"else": "New"}]}],
  "values": [{"sum": "alloc_amt", "as": "Due"}, {"sum": "tot_amt", "as": "Repaid"}],
  "calculated": [{"as": "Repayment %", "formula": "Repaid / Due * 100"}],
  "totals": true,
  "assumptions": ["Old user = cx_repeat_flag is 1", "Repayment % = sum(tot_amt)/sum(alloc_amt)"]
}
```

The engine runs it over all rows, writes the pivot, and the verified check line reads: *"Old + New = Total ✔, % between 0 and 100 ✔."* If "old user" had not been saved, the model would first call `ask_user` with the two best readings.

---

## 9. Which model, and where it runs (privacy)

| Mode | Model runs | Sees | Use when |
|---|---|---|---|
| **A. Hosted API** | Provider's cloud under your agreement (e.g. Claude Sonnet 5.5 for planning, Haiku 5.5 for cheap/simple steps) | Question + profile with samples | Best accuracy; data policy allows schema + samples out. |
| **B. Hosted, schema only** | Same | Question + names/types/stats, **no sample values** | Stricter policy. Slightly weaker at telling columns apart. |
| **C. Private/local** | Open-weights model in your network, or on the laptop | Same as A | Nothing may leave the network. Needs a GPU server (or a small local model with lower accuracy). |

Always: no raw rows to any model, API key never in the browser (a small gateway holds it), prompts logged without data, an admin switch to turn the model off (falls back to the rule parser).

Cost/latency target: planning call ≈ 2–6 s, a few cents or less per question; heavy lifting is local so file size does not raise model cost.

---

## 10. How we will know it is good (evaluation)

- **Golden set**: 25–50 real questions from your team, each with a file and a verified answer (computed independently in Python). Metric: *correct-answer rate* and *asked-a-needless-question rate*.
- **Targets**: ≥ 90% correct on the golden set before launch; 0 wrong numbers where the checks pass; median answer < 10 s on a 1-lakh-row file.
- **Regression gate in CI**: the golden set runs against the planner with a recorded-response mode (deterministic) and a live mode (nightly).
- **Red-team set**: ambiguous words, misspelled columns, columns with the same name, empty/blank-heavy columns, mixed date formats.

---

## 11. Roadmap

| M | Deliverable | Result you can see |
|---|---|---|
| **M0 ✔** | Engine, dictionary, old/new pivot, planner seam | Old/new users pivot on a wide file. |
| **M1** | **Profiler** + profile panel ("what I understood about your sheet") | You see column roles it inferred and can correct them. |
| **M2** | **Model planner** behind the gateway, reading shown first, repair loop, `ask_user` | Free-form questions understood; "reading" confirmation. |
| **M3** | **DuckDB-WASM** engine + `run_sql` tool | Joins, window functions, crores-scale aggregates in the browser. |
| **M4** | Charts, formatting, native PivotTable export, follow-up conversation | "Now by state", "add a chart". |
| **M5** | Result checks, "How calculated", saved recipes, shared definitions | Trust features; reusable monthly reports. |
| **M6** | Desktop app with native DuckDB | Multi-GB files. |
| **M7** | Hardening: audit log, admin controls, golden-set gate, docs | Ready for the whole team. |

M1 and M2 are what fix "it doesn't understand my sheet". Everything after builds on them.

---

## 12. Risks and honest limits

- **A model can misread a request.** Mitigation: reading shown first, validation, result checks, easy correction. It will not silently invent numbers.
- **Domain terms differ per file.** Mitigation: ask once, remember, share; start with your real question list.
- **A hosted model means schema and samples leave the machine** (mode A/B). If policy forbids it, use mode C; accuracy depends on the local model.
- **Browser memory is finite.** Beyond tier 2, use the desktop app.
- **I have not seen your real file or question list.** Until I do, accuracy on your data is unproven. The 25 questions are the fastest way to fix that.

---

## 13. What I need from you to start M1/M2

1. **Model policy**: mode A, B or C (section 9)? Which provider/endpoint, and who holds the API key?
2. **25 real questions** and the file each applies to (a sample with fake or masked values is fine, but columns must be real).
3. **Biggest file**: rows × columns × MB, and laptop RAM.
4. **Where people work**: website only, or Excel add-in and desktop app too.
