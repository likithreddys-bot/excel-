# Sheet Assistant: the Excel add-in

Describe what you want done with your table in plain English, inside Excel. The answer appears on new sheets; your own data is never touched.

- **No AI / LLM.** A rule-based parser turns the sentence into a small typed plan; a plain engine runs it.
- **Data never leaves the machine.** Everything runs inside the task pane. There is no server to send data to, only static files to host.
- **Preview first.** Every command shows what it will do, with exact row counts, before anything is written.

## What it can do so far (v0.3)

- **Rows and columns:** filter rows, sort, split into one sheet per value (including by month / year / weekday), remove duplicates, keep or drop columns.
- **Summaries:** `total amount by category`, `how many debits per branch`, `monthly totals by category`, `pivot amount by category and txn type` (with totals), `top 10 by amount`, `lowest 3 amounts per category`, `add % of total amount`, `running total of amount per category`, `rank by amount`.
- **Calculated columns:** `add column gst = amount * 0.18`, `add column net = credit - debit`, `add column size = high if amount > 50000 else low`, `add days since txn date`, `round amount to 2 decimals`, `set amount = amount * 100`, `flag rows where amount > 50000`. A column made by a formula is totalled the Excel "calculated field" way in later totals and pivots.
- **Excel-style formulas:** type them the way you would in Excel, with column names in `[brackets]`: `add column grade = IF(amount>50000,"High",IF(amount>10000,"Medium","Low"))`, `add column each = IFERROR(amount/qty, 0)`, `add column user = LEFT(email, FIND("@", email) - 1)`, `add column due = EOMONTH(date, 1)`, `add column dup = COUNTIF(pan, pan) > 1`, `keep rows where =AND(type="DEBIT", amount>1000)`. About 70 functions: IF, IFS, IFERROR, AND, OR, NOT, SWITCH, ROUND, MOD, SUM / AVERAGE / MIN / MAX over a whole column, COUNTIF(S), SUMIF(S), AVERAGEIF, LEFT, RIGHT, MID, LEN, UPPER, LOWER, PROPER, TRIM, SUBSTITUTE, FIND, SEARCH, TEXT, VALUE, CONCAT, TEXTJOIN, TODAY, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, DATE, DATEDIF, NETWORKDAYS and more. A wrong name gets "did you mean…?"; a row that errors is left blank and counted in the preview.
- **Plain-English text and dates:** `first 3 characters of name`, `last 4 characters of pan`, `text before @ in email`, `year of date`, `name of the month of date`, `end of month of date`, `date plus 2 months`, `amount / qty, or 0 if error`.
- **Cleaning:** `trim spaces`, `make city title case`, `fill blank city with Unknown`, `fill down city`, `remove blank rows`, `replace "UPI/" with "" in description`, `split name into first and last`, `combine city and state into location`, `rename amt to amount`, `convert amt to number` (understands ₹, Rs., INR, commas), `change txn date to date`.
- **Other sheets in the workbook:** `bring email from Customers on pan` (VLOOKUP), `rows not in March on pan`, `rows also in Customers`, `append March`. The sheet is named in the sentence; only the sheets you mention are read.
- **Beginner mode:** when you press **Use my table**, the add-in looks the table over and lists what it noticed (repeated rows, empty rows, stray spaces, amounts saved as text, the same value spelled differently, blanks, dates stored two ways). Each item has a **Fix…** button that opens the usual preview, so nothing changes without a look.
- **Highlights, number formats and charts:** `highlight rows where amount > 1 lakh in red`, `highlight duplicates in pan`, `show amount in rupees`, `show date as dd-mmm-yyyy`, `bar chart of total amount by category`, `line chart of amount by month`. Applied to the new sheet; the preview shows which rows will be coloured and what a chart will plot.
- **Menus instead of typing:** press **Build it with menus…** (or the button offered when a sentence isn't understood) and pick from lists: keep rows, sort, split, totals, pivot, top N, remove repeats, keep columns, new column (calculation / if-else / Excel formula), tidy up, bring columns from another sheet, chart, highlight. The menus write the sentence and run the same preview, so nothing is hidden.
- **Several at once:** `only debits over 5000, split by category and sort by amount descending`.

Results are written as values by default, so they match the preview exactly. Tick **Keep results live** in the pane and, where Excel can do it exactly, a new column becomes a real formula in the result table (`=IF([@[amount]]>10000,"High","Low")`), and a plain total or pivot on your own table becomes a native PivotTable. After writing formulas the add-in reads Excel's answers back; a column where Excel disagrees with the preview is kept as values and you are told.

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

## Putting it in front of a team

See [`DEPLOY.md`](DEPLOY.md): hosting, `npm run manifest -- <https address>`, installing for everyone from the Microsoft 365 admin center, and a short note on what leaves the computer (nothing) for security review.

## Tests

```bash
npm test
```

`npm test` first asks the Python reference (`../planner.py`, `../engine.py`) to answer about 250 commands on made-up files (bank transactions, a ledger, a messy contact list, and a few files for lookups). It then checks that the TypeScript parser produces the **same plans, summaries and results**. This needs Python with the app's requirements (`pip install -r ../requirements.txt`).

When porting a new feature, add its commands to `tools/gen_golden.py` first. Generated data stays out of git.

## Not done yet

- The Office.js read/write layer (`src/excel/io.ts`) has not yet been run inside a real Excel; the engine and task pane have been tested in a browser only.
