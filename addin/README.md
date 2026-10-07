# Sheet Assistant: the Excel add-in

Describe what you want done with your table in plain English, inside Excel. The answer appears on new sheets; your own data is never touched.

- **No AI / LLM.** A rule-based parser turns the sentence into a small typed plan; a plain engine runs it.
- **Data never leaves the machine.** Everything runs inside the task pane. There is no server to send data to, only static files to host.
- **Preview first.** Every command shows what it will do, with exact row counts, before anything is written.

## What it can do so far (v0.1)

Filter rows, sort, split into one sheet per value (including by month / year / weekday), remove duplicates, keep or drop columns, and several of these in one sentence: `only debits over 5000, split by category and sort by amount descending`.

Totals, pivots, calculated columns, cleaning, lookups and charts follow. The Python app in the repo root already has them, and the add-in is being brought up to the same level step by step. Until a command is ported, the add-in says so instead of guessing.

## Run it

```bash
cd addin
npm install
npm run certs      # one-off: a trusted https certificate for localhost (Excel insists on https)
npm run dev        # serves https://localhost:3000
```

Then load `manifest.xml` into Excel:

- **Excel on the web:** Home → Add-ins → More Add-ins → My Add-ins → Upload My Add-in → choose `manifest.xml`.
- **Excel for Windows / Mac:** follow Microsoft's [sideload guide](https://learn.microsoft.com/office/dev/add-ins/testing/test-debug-office-add-ins). The "Sheet Assistant" button appears on the Home tab.

Open `https://localhost:3000/taskpane.html` in an ordinary browser to try it with made-up data and no Excel (a demo host stands in for the workbook).

## How it works

```
sentence ──► parser.ts ──► Plan (typed steps) ──► engine.ts ──► tables ──► new worksheets (excel/io.ts)
             rule-based     plan.ts                pure functions
```

| Path | Role |
|---|---|
| `src/engine/parser.ts` | Plain English → `Plan`, or a question when unsure. A port of `planner.py` |
| `src/engine/engine.ts` | Runs a plan on in-memory tables |
| `src/engine/plan.ts`, `describe.ts` | The plan format (same as `plan.py`) and its plain-English description |
| `src/excel/io.ts` | Reads the selected table / writes result sheets as real Excel Tables (Office.js) |
| `src/excel/demo.ts` | Stand-in workbook for browsers |
| `src/taskpane.ts` | The task pane UI |

## Tests

```bash
npm test
```

`npm test` first asks the Python reference (`../planner.py`, `../engine.py`) to answer about 90 commands on a made-up bank file. It then checks that the TypeScript parser produces the **same plans, summaries and results**. This needs Python with pandas, numpy and pydantic.

When porting a new feature, add its commands to `tools/gen_golden.py` first. Generated data stays out of git.

## Not done yet

- Ports of the remaining operations: totals, pivots as native PivotTables, calculated columns as live formulas, cleaning, lookup across sheets, compare, highlight, charts.
- Beginner mode (file profile and one-click suggestions) and a guided builder for sentences it can't read.
- Packaging for company-wide deployment (Microsoft 365 admin center).
- The Office.js read/write layer (`src/excel/io.ts`) has not yet been run inside a real Excel; the engine and task pane have been tested in a browser only.
