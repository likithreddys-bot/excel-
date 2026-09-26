# Sheet Assistant

Describe what you want done to a spreadsheet in plain English (*"only debits over 5000, split by category"*) and get the finished file back in seconds.

- **No AI / LLM.** Commands are understood by a rule-based parser written in plain Python.
- **Data stays on the machine that runs it.** Nothing is sent to any external service.
- **Nothing runs without confirmation.** Every command first shows what will happen, with exact row counts, before it is applied.

## Quick start

Requires Python 3.11+ (tested on 3.14).

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python -m uvicorn app:app --port 8000
```

Open http://localhost:8000 and upload a CSV or XLSX file. `samples/bank_transactions.csv` is a synthetic file to try it with.

## Using it

1. **Upload** a `.csv` or `.xlsx` (up to ~100K rows is comfortable).
2. **Type a command.** Click an example chip for a starting point.
3. **Check the preview**: the steps it understood and the row count per sheet. Click **Run it** or **Cancel**.
4. **Keep going**: each command builds on the previous result. **Undo / Redo** at any time.
5. **Download** as XLSX, or CSV (a `.zip` of CSVs when there are several sheets).

If a command can't be understood confidently, it asks instead of guessing: for example, it names the values that exist in a column, or the columns you could split by.

### What you can say

| Operation | Examples |
|---|---|
| Filter rows | `only debits over 5000` · `category is travel or rent` · `category in travel, rent` · `description contains ATM` · `amount between 1000 and 5000` · `branch is empty` · `rows with no branch` |
| Exclude rows | `remove rows where description contains ATM` · `exclude credits` · `everything except cash` |
| Dates | `in the last 30 days` · `last 3 months` · `older than 1 year` · `this month` · `in 2024` · `in march 2025` · `after 01/03/2025` · `between 01/01/2025 and 31/03/2025` |
| Split into sheets | `split by category` · `segregate by category and txn type` (one sheet per combination) |
| Sort | `sort by amount descending` · `sort by date newest first` · `order by balance high to low` |
| Choose columns | `keep columns date, description, amount` · `keep only description and amount` · `drop the balance column` |
| Totals / counts | `total amount by category` · `count transactions per category` · `average and max amount by txn type` · `how many debits per branch` · `count by assessment year for result code 101` |
| Pivot / cross-tab | `pivot amount by category and txn type` · `total amount by category with txn type as columns` · `count by branch across txn type` · `pivot of total amount with branch in rows and category in columns` (row and column totals included) |
| By period | `total amount by month` · `monthly totals by category` · `quarterly total amount by txn type` · `count transactions by weekday` · `split by year` · `pivot amount by month and txn type` |
| Top / bottom N | `top 10 debits by amount` · `bottom 5 by balance` · `lowest 3 amounts per category` · `latest 5 transactions` · `first 10 rows` |
| % of total | `total amount by category with % of total` · `percentage share of amount by category` · `add % of total` (after a grouping) |
| Running total | `add running total of amount` · `running total of amount per category` · `cumulative sum of amount sorted by date` |
| Rank | `rank by amount` · `rank by amount within category lowest first` · `rank branches by total amount` |
| Duplicates | `remove duplicate rows` · `remove duplicates by txn id` |
| Trim / case | `trim spaces` · `trim name` · `make city title case` · `convert name to uppercase` · `lowercase email` |
| Blanks | `fill blank city with Unknown` · `fill blanks with 0` · `fill down city` (copy the value from above) · `remove blank rows` · `remove rows with any blank` |
| Find & replace | `replace "UPI/" with "" in description` · `remove "UPI/" from description` · `replace pune with Pune in city` · `replace N/A with blank` |
| Text to columns | `split name into first and last` · `split email on @ into user and domain` · `split description by slash` |
| Merge columns | `merge first and last into full name` · `combine city and state with ", " into location` |
| Rename | `rename amt to amount` · `rename city to City Name and amt to Amount` |
| Change type | `convert amt to number` (understands ₹, Rs., INR, commas) · `change txn date to date` · `make pan text` |
| Calculated columns | `add column gst = amount * 0.18` · `add gst as 18% of amount` · `add column net = credit - debit` · `add column with tax = amount + 18%` (increase by 18%) · `add column per unit = amount / qty` · `add column double = [Amount (INR)] * 2` (brackets for names with symbols) |
| Rounding | `round amount to 2 decimals` · `add column k = round(amount / 3, 1)` |
| If / else labels | `add column size = high if amount > 50000 else low` · `add band: high if amount > 1 lakh, medium if amount > 10000, else low` · `add column status = 'Record Found' if result code is 101 otherwise 'Not Found'` · `add column big = amount > 100000` (Yes/No) · `label amount over 1 lakh as large, otherwise small` · `flag rows where amount > 50000` |
| Dates | `add days since txn date` · `add column duration = days between start date and end date` · `add column m = months between start date and end date` · `add age from dob` |
| Overwrite a column | `set amount = amount * 100` · `set category = Other if category is Cash` (other rows keep their value) |
| Several at once | `only debits over 5000, split by category and sort by amount descending` |

Understood automatically:
- **Column names** despite underscores, plurals and small typos: `txn date`, `ammount`.
- **Values** matched against what's in the data: `debits` finds `DEBIT` in `txn_type`.
- **Amounts** written as `5k`, `1 lakh`, `2 crore` or `Rs. 5,000`.
- **Dates** read as `dd/mm/yyyy`, with ISO `yyyy-mm-dd` also accepted.

**Cleaning is careful by design:**
- **Text to columns and merge keep the original column** and add the new ones beside it.
- **Type conversion stops instead of blanking values it can't read.** It shows examples, e.g. `'abc'`, so you can fix or remove them first.
- **Find & replace ignores case and matches inside text** in text columns, like Excel's default. In number columns it matches whole values only, so `replace 0 with blank` won't turn 10 into 1.
- **Put text in quotes when it has spaces or punctuation:** `replace "Rs. " with ""`.

**Formulas are restricted by design.** A command becomes a small formula such as `[amount] * 0.18`, which the engine's own calculator evaluates. It never uses Python `eval`, so a formula can only do arithmetic, `round`, `abs` and date differences.
- **Math on a text column stops and says to convert it first**, rather than treating the text as blank.
- **Dividing by zero gives a blank cell.**
- **`add column x` won't overwrite an existing column.** Use `set x = ...` to do that on purpose.
- **Later parts of a command can use columns created earlier in it**, e.g. `add column gst = amount * 0.18 and sort by gst`.

**Workbooks with several sheets:** commands apply to the main data sheet, meaning the one with the most rows. Other sheets, such as a summary, are kept unchanged and included in the download.

## How it works

```
command ──► planner.py ──► Plan (typed steps) ──► engine.py (pandas) ──► result sheets
            rule-based      plan.py                 deterministic
            parser
```

| File | Role |
|---|---|
| `planner.py` | Rule-based parser: plain English → `Plan`, or a clarification question |
| `plan.py` | The plan format: `filter`, `select_columns`, `drop_columns`, `sort`, `dedupe`, `group_by`, `split_by`, `pivot`, `top_n`, `date_part`, `calculate`, `clean_text`, `fill_blanks`, `drop_blank_rows`, `replace`, `split_column`, `merge_columns`, `rename`, `convert`, `compute`, `label` |
| `engine.py` | Executes a plan on pandas DataFrames; file loading and XLSX/CSV export |
| `app.py` | FastAPI server: upload, plan (dry run), execute, undo/redo, download |
| `static/index.html` | The web UI (chat on the left, spreadsheet preview on the right) |
| `tests/` | Parser tests (`test_planner.py`), analysis (`test_analysis.py`), cleaning (`test_cleaning.py`), formulas (`test_formulas.py`) and end-to-end API tests (`test_app.py`) |

The parser only ever produces a `Plan`. The engine is the only code that touches the data. That separation keeps every result reproducible and every step visible to the user before it runs.

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest
```

**Adding support for a new phrasing:**
1. Add the command and its expected plan to `tests/test_planner.py` and watch it fail.
2. Add or adjust the pattern in `planner.py` until it passes.
3. Check the rest of the suite still passes. Many patterns interact, so a new rule can break an old one.

## Data handling

- Uploaded files are held **in memory only**, one session per upload, and are lost when the server restarts. Nothing is written to disk.
- `.gitignore` blocks all `.csv` / `.xlsx` files except the synthetic sample, so real data can't be committed by accident.

## Known limitations

- Pivots are produced as a normal sheet (a cross-tab with totals), not an interactive Excel PivotTable. Excel's own PivotTable can still be built from the downloaded file.
- A pivot shows one calculation of one column at a time (`sum of amount`, not `sum and average of amount`).
- Months are shown as `2025-03` so they sort correctly; quarters as `2025-Q1`.
- A filter can't mix `and` with `or` in one command; split it into two commands.
- Values that only appear *inside* a longer text need `contains`: `description contains zomato`, not `only zomato`.

## Before company-wide rollout

The current version is fine for single-user or small-team use on a trusted network. Before offering it to the whole company:
- **Login / access control.** Anyone who can reach the server can currently use it.
- **Session expiry.** Uploaded data stays in memory until the server restarts.
- **Hosting.** Run it on an internal server behind HTTPS rather than a laptop.
- **Load testing** with the largest real files people will use.

Background and product thinking: [excel-assistant-concept.md](excel-assistant-concept.md). It was written before the no-AI decision, so its LLM-based technical approach has been replaced by the rule-based parser.
