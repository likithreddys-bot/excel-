# Excel GPT — plan

*A tool where a person drops in a spreadsheet, asks for anything in plain words, and gets the finished work back in a sheet (a pivot table, a chart, a cleaned table, a lookup), the way a very good Excel analyst would deliver it, on files with lakhs to crores of rows.*

Status: **draft for your decision; M0 is built.** The first thing to read is section 0: five decisions only you can make.

**M0 delivered (this branch):** your example, *"repayment percentage of old users and new users as pivot table"*, works end to end on a 298-column file. The app asks once what "old user" means (options built from the file's own columns, e.g. `cx_repeat_flag` is 1), remembers the answer for that file layout, and returns the pivot (`user_type | Due | Repaid | Repayment %`, rows Old / New / Total, % as a ratio of sums), downloadable as `.xlsx`. On a 60,000 × 298 test file the numbers matched an independent Python calculation exactly (Old 88.12, New 69.77, Total 77.99). Also built: the plan validator, a model-prompt builder proven to contain no data rows, and a mock planner (the seam where a model plugs in at M2). The benchmark in section 8 is measured.

---

## 0. Decisions I need from you

| # | Decision | Why it matters | My recommendation |
|---|---|---|---|
| **D1** | **May a language model be used to understand the question?** | Your first brief said "no AI/LLMs" (banking data, privacy). This brief ("do *anything* a human Excel pro can do, from a plain-words request") **cannot be met by fixed rules**: people phrase things endlessly, and words like "old user" or "on time" mean different things in different files. A rule-based parser is what I built so far, and it is why it feels bad. | **Yes, but only as a translator. The model sees column names and your question, never a single data row, and it never calculates a number.** Our own engine does all the calculating. See section 5 and 11. If even that is not allowed, say so: I will keep the rule parser and make it ask better questions, but it will stay narrow. |
| **D2** | **Where does the model run?** | Decides whether anything leaves the bank network. | **Best: a model hosted inside your network (open-weights, for example Qwen or Llama on one GPU server).** Nothing leaves. Second: a private cloud endpoint under your agreement, schema-only prompts. Third (weakest): in-browser small model, no server needed but much less capable. |
| **D3** | **Where do people use it?** | Web page, Excel add-in, desktop app, internal server. | Web page for everyone (works today) **plus** a desktop app for the very large files (crores of rows). |
| **D4** | **Largest file you must handle**, and the laptops people have (RAM). | Sets the engine tier (section 8). | Tell me rows × columns × MB of your biggest real file. |
| **D5** | **25 real questions your team asks** (with the file each one applies to). | These become the test set that decides whether the product is "good". Without them I am guessing, which is what has been going wrong. | Please send them, even badly worded. |

---

## 1. What "good" looks like (the test I will be judged on)

You drop in the repayment file (`new_cxs_repayment_data1`, about 1 lakh rows × 298 columns, `.xlsx` or `.csv`) and type:

> **repayment percentage of old users and new users, as a pivot table**

Expected, with no column picking and no formula knowledge:

1. The tool reads only the columns it needs (`cx_repeat_flag` or `loan_order_cnt`, `tot_amt`, `alloc_amt`, and so on). A few seconds.
2. It does not know what "old user" means in this file, so it **asks once**, with the likely answers as buttons: *"Old user = `cx_repeat_flag` is 1 (repeat customer)? or `loan_order_cnt` > 1?"* You click one. It **remembers** (per file, shareable with your team).
3. It shows a **pivot table**:

   | User type | Due (alloc_amt) | Repaid (tot_amt) | **Repayment %** |
   |---|---|---|---|
   | Old | … | … | **xx.xx** |
   | New | … | … | **yy.yy** |
   | Total | … | … | **zz.zz** |

4. It says in one line what it did ("Old = repeat customers; repayment % = total repaid ÷ total due, summed per group"), gives the row counts, and offers **Download as Excel** (a real pivot sheet), "change the definition", and "also split by state".
5. The numbers are checkable: the totals reconcile with the whole file, and one click shows the exact steps.

Every feature below exists to make that experience work for *any* such request.

---

## 2. Honest status today, and why it disappoints

**What exists** (all working, 436 automated tests): a website and an Excel add-in that read `.xlsx` / `.csv` (streaming, only the columns needed, files over 170 MB tested), a plan executor (filters, sorts, group totals, pivots, top N, running totals, ranks, text / date / IF formulas, lookups across sheets, cleaning, highlights, number formats, charts), preview-before-run, download as `.xlsx`.

**Why it feels bad:** the front end is a **phrase parser**. It understands only sentences it was taught. Every new phrasing ("state wise", "paid b0 percentage", "repayment of old users") needed another hand-written rule, and when a rule is missing it either asks an awkward question or, worse, gives a wrong table. Two other root causes:

* **No business vocabulary.** "Old user", "on time", "B0", "repayment" are not in the column names. Nothing in the tool can learn or remember what they mean in your data.
* **Output is a preview card, not a finished sheet.** The target is the Excel an analyst would hand over.

**What is solid and will be kept:** the executor, the file readers and writer, the preview / undo flow, the column-aware reading. The part to replace is the *understanding* layer.

---

## 3. Principles

1. **The answer is a sheet**, not a paragraph: real tables, pivots, charts, formats; downloadable as `.xlsx`.
2. **The model translates; the engine computes.** Language models are good at understanding requests and bad at arithmetic and at being exactly reproducible. So the model only produces a *plan* (structured steps). Numbers always come from the engine, so the same question on the same data gives the same answer.
3. **Never guess silently.** If the request has more than one sensible meaning, ask one short question with buttons, then remember the answer.
4. **Show your work.** Every result lists its steps, row counts and the formula behind each number; totals reconcile to the source.
5. **Data stays on the user's machine.** No rows in any prompt. Provider choice is configurable, including "no model".
6. **Big data is normal.** Crores of rows must work, with progress and cancel.
7. **Measured, not claimed.** A test set of real questions with expected answers runs on every change; nothing ships if accuracy drops.

---

## 4. Architecture

```
 file(s) ──► Readers (streaming, column-pruned) ──► Data engine  ◄────────────┐
 (xlsx/csv/parquet)                                    (JS · DuckDB-WASM · native DuckDB)
                                                              ▲               │
  question ─► Planner ─► Plan (typed steps) ─► Validator ─► Compiler ─► Results ─► Sheet writer
              ├ rules (fast, deterministic)         │            (SQL / JS)          (xlsx, pivot,
              └ model (open-ended)                  └─ asks the user when unsure      charts, formats)
                    ▲
        Data dictionary (what columns and words mean, per file, shared) ──┘
```

* **Plan** = the existing typed step format (filter, group, pivot, calculate, label, lookup, …), extended. Both planners produce it, so everything downstream is shared and testable.
* **Validator** rejects any plan that uses a column that does not exist, a wrong type, or an unsupported step *before* anything runs; it asks the planner to repair, or asks the user.
* **Compiler** turns a plan into SQL (for DuckDB) or runs it in the JS engine (small data).

---

## 5. The planner (how a question becomes work)

Two planners behind one interface, tried in order:

1. **Rules (today's parser).** Deterministic and instant. Handles the common phrasings. Kept as the first attempt and as the fallback if no model is allowed.
2. **Model planner (new, per D1/D2).** Input: *only* (a) the question, (b) the file's column names with types and a few safe statistics (distinct count, min / max; no values unless policy allows), (c) the data dictionary entries, (d) the list of plan steps with their JSON schema. Output: a plan as JSON (constrained by the schema), or a clarifying question with options. Then the validator checks it, the UI shows it in plain English, and the engine runs it.

Repair loop: if the validator rejects the plan, the error goes back to the planner (max 2 tries), then to the user as a question.

The model is **never** shown rows, never given tool access to the file, and never writes the numbers.

---

## 6. Data dictionary (the missing piece)

A small, shareable file per dataset (JSON; exportable / importable; stored locally and optionally in a team location):

* **Segments**: "old user = `cx_repeat_flag` is 1", "new user = otherwise".
* **Measures**: "repayment % = sum(`tot_amt`) ÷ sum(`alloc_amt`) × 100", "on-time repayment % = sum(`b0_amt`) ÷ sum(`alloc_amt`) × 100".
* **Aliases**: "state" → `statename`; "EMI" → `alloc_amt`.
* **Grains**: one row = one EMI of one loan; a customer = `user_id`.

Built three ways: **inferred** from names and values (suggested, never silently applied), **asked** in-app the first time a word is used, **imported** from your team's definitions. This is also what lets a non-expert get a correct answer: the definitions are agreed once by someone who knows.

---

## 7. Capability map: "everything an Excel pro does"

| Area | Examples | Today | Target |
|---|---|---|---|
| Read / clean | wide files, dates, text-numbers, trim, case, fill blanks, split / merge columns, remove duplicates | ✔ | M1 |
| Filter / sort / top N | multiple conditions, within group | ✔ | — |
| Totals / group by | sum, count, average, min, max, distinct count | ✔ | — |
| **Pivot tables** | multi-level rows / columns, % of row / column / total, calculated fields, date grouping (month, quarter), bins, subtotals, filters | partial (values only) | **M1–M3** |
| **Segments & cohorts** | old vs new, by vintage, first vs repeat, bucket / DPD bands | ✘ | **M1** |
| **Rates / ratios** | repayment %, on-time %, default rate, collection efficiency | partial | **M1** |
| Conditional logic | IF / IFS / SWITCH, nested, lookup tables | ✔ | M2 |
| Lookups / joins | VLOOKUP / XLOOKUP / INDEX-MATCH, many files, left / inner / anti join | ✔ (sheets) | M3 |
| Window / running | rank, running total, moving average, year-on-year, share of total | partial | M3 |
| Dates | ages, differences, month-end, business days, fiscal year | partial | M2 |
| Text | extract, clean, PAN / phone checks, fuzzy match | partial | M3 |
| Charts | column, bar, line, pie, combo, on pivot | ✔ (simple) | M4 (native charts in the `.xlsx`) |
| Formatting | highlights, conditional formatting, number formats, tables | ✔ (basic) | M4 |
| Reconcile / audit | compare two files, find differences, totals tie-out | ✔ (basic) | M3 |
| What-if | scenarios, goal seek, forecast | ✘ | M6 |
| Repeatable recipes | save the steps, re-run on tomorrow's file ("macro") | ✘ | M5 |
| Multi-step requests | "clean this, add a grade, then pivot by state and chart it" | partial | M2 |

---

## 8. Data engine and large data

**What I measured** (headless Chromium on a modest server; a laptop is usually faster):

| Engine | Data | Result |
|---|---|---|
| Current JS engine | 2 lakh rows × 10 columns `.xlsx` | open 4 s; each question ≈ 1 s |
| Current JS engine | 1,06,394 × 298 `.xlsx` (173 MB), 4 columns | first read ≈ 20 s (unpacking the file); then 0.2 s |
| **DuckDB-WASM** (a real SQL database running in the browser) | **20 lakh (2,000,000) rows × 12 columns, 137 MB CSV** | load into a table **3.8 s**; **then each group-by / pivot 0.13–0.22 s**; straight off the CSV ≈ 2 s |
| DuckDB-WASM | 60,000 × 298 CSV (98 MB) | first scan 12 s; one question 2.6 s |

So the plan is **three tiers**, chosen automatically by file size:

1. **Small (≤ ~10 lakh cells)**: current in-memory JS engine. Instant, simple.
2. **Large (up to ~5 crore cells)**: **DuckDB-WASM** in a background worker. The plan compiles to SQL. Load once into a columnar table (cache it in the browser's file store so re-opening the same file is instant), then every question is sub-second. Progress bar and cancel.
3. **Very large (crores of rows, multi-GB)**: a **desktop app** (or an internal server) running native DuckDB, which streams from disk and uses all cores, with the same UI and the same plans. `.xlsx` is read once and converted to a column file (Parquet) for speed; CSV and Parquet are read directly.

Details that matter: column pruning (read only what the question needs, already done), type inference once and remembered, dictionary-encoded text, previews computed on a sample but **final numbers always on all rows**, no 8-lakh-row ceiling in the plan (the `.xlsx` format itself stops at 10,48,575 rows per sheet, so huge results are written as CSV / Parquet or split across sheets, with a clear message).

---

## 9. Results as real Excel

* **M1:** a pivot-style sheet (grouped values, totals row, percentages), formatted, filter buttons, frozen header, number formats; downloadable.
* **M3:** a **native Excel PivotTable** inside the downloaded file (the pivot cache and definition written directly in the file format), so the person can drag fields in Excel. Until then, the Excel add-in already builds native PivotTables through Excel itself.
* **M4:** native charts inside the `.xlsx`, conditional formatting rules, named tables, and optional live formulas for the simple cases.
* For results above the sheet row limit: CSV / Parquet download and a multi-sheet split.

---

## 10. Trust: verification and evaluation

* **Show the work**: plain-English steps, the SQL / formula, row counts in and out, and "how this number was calculated" per cell.
* **Automatic checks**: group totals reconcile to the whole; counts match; percentages within 0–100 unless the definition allows more; warnings for blanks treated as zero, duplicate keys, mixed types.
* **Evaluation set**: the 25+ real questions from D5, plus a growing library (target 300), each with the exact expected table. Runs in the build; a regression blocks release. Reported as accuracy per area.
* **Model safety**: the validator guarantees no plan can touch a missing column or run an unsupported action; the model cannot execute anything; prompts are logged (schema only) for audit.

---

## 11. Security, privacy, compliance

* Files are read **in the browser tab or on the user's machine**; nothing is uploaded by default.
* **With a model (D1/D2):** prompts contain column names, types and counts only; no rows. Sample values only if you explicitly allow them for a column (and never for columns tagged PII such as PAN, phone, name, address). Provider options: (A) hosted inside your network; (B) a private endpoint under your contract; (C) none, rules only.
* Audit log of questions and plans (no data); role-based sharing of the dictionary.
* This is a design intention, not legal advice: your information-security and compliance teams must approve the model hosting and data-handling before use.

---

## 12. Roadmap

| M | What ships | You can test it by |
|---|---|---|
| **M0 (this week)** | This plan; benchmark above; the **old / new users pivot** end to end (definitions you confirm once, remembered; pivot output with totals and %; download) on your file; plan-validator and the model-planner interface with a mock | Your exact example in section 1 |
| **M1** | Data dictionary (segments, measures, aliases) with import / export; ask-then-remember flow; pivots with % of total / row / column and date grouping | 10 of your D5 questions answered correctly |
| **M2** | **Model planner** behind the interface (provider per D2), multi-step requests, repair loop, evaluation harness in CI | 25 D5 questions ≥ 90 % correct; no data in prompts (verified by test) |
| **M3** | **DuckDB-WASM tier** (SQL compiler, cached columnar table, worker, progress / cancel); native-pivot export; joins; window functions | 20-lakh-row file: every question < 1 s after load |
| **M4** | Native charts, conditional formatting, tables in the exported `.xlsx` | Output opens in Excel with live pivot + chart |
| **M5** | Saved recipes ("run this again on a new file"), team sharing of dictionary and recipes | A daily report re-run in one click |
| **M6** | Desktop app with native DuckDB for multi-GB files; what-if tools | A 5 GB file, any question in seconds |
| **M7** | Hardening: accuracy dashboard, role access, audit, installer, documentation | Sign-off by your security and ops teams |

Rough effort: M0–M2 are a few focused weeks; M3 and M6 are the heaviest. The order is chosen so that you get a better product at every step, not at the end.

---

## 13. Risks

* **Ambiguous language is infinite.** Mitigation: ask-then-remember, the dictionary, the evaluation set, never-guess rule.
* **Model quality / hosting.** An in-network model needs a GPU server and some tuning; a weaker model asks more questions. Mitigation: provider interface, tests per model, rules as fallback.
* **Browser memory limits** (about 2–4 GB per tab). Mitigation: column pruning, DuckDB tier, desktop tier.
* **`.xlsx` is slow to read at scale** (it is a zip of huge XML). Mitigation: convert once to Parquet and cache; recommend CSV / Parquet for very large files.
* **Native PivotTable writing is intricate.** Mitigation: ship the formatted pivot first (M0–M2), native after.
* **Scope.** "Everything an Excel pro does" is a direction, not a finish line; the capability map and the evaluation set keep it honest.

---

## 14. What I am building first (M0), concretely

1. This plan and the benchmark (done).
2. **Segments and the dictionary (first version)**: "old users and new users" resolves through a saved definition; if missing, the tool asks with buttons built from your real columns.
3. **Pivot output for ratios**: rows = the segment (optionally state), value = repayment % as a calculated field (sum ÷ sum), totals row, formatted; **Download as Excel**.
4. **Plan validator** and the **model-planner interface** with a mock model, so M2 is a provider swap, not a rewrite.
5. A test for your exact example.
