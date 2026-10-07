# Sheet Assistant

Describe what you want done to a spreadsheet in plain English (*"only debits over 5000, split by category"*) and get the finished file back in seconds.

- **No AI / LLM.** Commands are understood by a rule-based parser written in plain Python.
- **Data stays on the machine that runs it.** Nothing is sent to any external service.
- **Nothing runs without confirmation.** Every command first shows what will happen, with exact row counts, before it is applied.

> **Excel add-in:** the same assistant, running inside Excel instead of a browser, is being built in [`addin/`](addin/README.md) (TypeScript, no server, data never leaves the machine). This Python app is its reference implementation.

## Quick start

Requires Python 3.11+ (tested on 3.14).

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python users.py add yourname          # create an account (asks for a password, 8+ characters)
python -m uvicorn app:app --port 8000
```

Open http://localhost:8000 and upload a CSV or XLSX file.

This repository contains no data files. To create a synthetic file to try it with (fake bank transactions, 5,000 rows):

```bash
python -c "import sys; sys.path.insert(0, 'tests'); from test_planner import make_bank_df; import os; os.makedirs('samples', exist_ok=True); make_bank_df(5000).to_csv('samples/bank_transactions.csv', index=False)"
```

## Using it

1. **Upload** a `.csv` or `.xlsx` (up to ~100K rows is comfortable).
2. **Type a command.** Click an example chip for a starting point.
3. **Check the preview**: the steps it understood and the row count per sheet. Click **Run it** or **Cancel**.
4. **Keep going**: each command builds on the previous result. **Undo / Redo** at any time.
5. **Download** as XLSX, or CSV (a `.zip` of CSVs when there are several sheets).

If a command can't be understood confidently, it asks instead of guessing: for example, it names the values that exist in a column, or the columns you could split by.
- **When it asks "Which column…?", you can reply with just the column names** (`alloc_amt, b0_amt`). Typos get a suggestion ("did you mean b0_amt?").
- **The example chips and the "try commands like…" suggestions use your file's own columns.**

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
| Pivot / cross-tab | `pivot amount by category and txn type` · `pivot wrt due_month with these columns B0% and overall_repay%` · `total amount by category with txn type as columns` · `count by branch across txn type` · `pivot of total amount with branch in rows and category in columns` (row and column totals included) |
| By period | `total amount by month` · `pivot by due_month` (the month of `due_date`; also `disb_year`, `due week`…) · `monthly totals by category` · `quarterly total amount by txn type` · `count transactions by weekday` · `split by year` · `pivot amount by month and txn type` |
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
| Calculated columns | `add column gst = amount * 0.18` · `B0% = b0_amt*100/alloc_amt and overall_repay% = tot_amt*100/alloc_amt` (several at once) · `add gst as 18% of amount` · `add column net = credit - debit` · `add column with tax = amount + 18%` (increase by 18%) · `add column per unit = amount / qty` · `add column double = [Amount (INR)] * 2` (brackets for names with symbols) |
| Rounding | `round amount to 2 decimals` · `add column k = round(amount / 3, 1)` |
| If / else labels | `add column size = high if amount > 50000 else low` · `add band: high if amount > 1 lakh, medium if amount > 10000, else low` · `add column status = 'Record Found' if result code is 101 otherwise 'Not Found'` · `add column big = amount > 100000` (Yes/No) · `label amount over 1 lakh as large, otherwise small` · `flag rows where amount > 50000` |
| Dates | `add days since txn date` · `add column duration = days between start date and end date` · `add column m = months between start date and end date` · `add age from dob` |
| Overwrite a column | `set amount = amount * 100` · `set category = Other if category is Cash` (other rows keep their value) |
| Lookup (VLOOKUP) | `bring email and phone from customers on pan` · `lookup email from customers using pan` · `match with customers on pan` (all their columns) · `bring score from ref matching pan with pan number` (keys named differently) |
| Append files | `append march` · `add the rows from march` |
| Compare files | `rows not in march on pan` · `rows in march but not here` · `rows also in customers on pan` · `rows in both files` (without `on …`, a clear ID column like pan is used, otherwise whole rows) |
| Highlight | `highlight rows where amount > 1 lakh in red` · `highlight amount above 50000` (just those cells) · `highlight debits in green` · `highlight duplicates in pan` · `highlight blanks in branch` |
| Number formats | `show amount in rupees` (₹12,34,567.00) · `format balance with commas` · `show amount with 0 decimals` · `show % of total sum_amount as percent` · `show txn date as dd-mmm-yyyy` |
| Charts | `bar chart of total amount by category` · `line chart of amount by month` · `pie chart of count by txn type` · `horizontal bar chart of average amount by branch` · `chart debits amount by category` |
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

**Formula columns in pivots and totals use the totals, like an Excel calculated field.** After `B0% = b0_amt*100/alloc_amt`:
- `pivot by due_month with B0%` shows, for each month, **total b0_amt × 100 ÷ total alloc_amt**. It doesn't average the row percentages, which would count a ₹1,000 loan as much as a ₹50,000 one. The preview says which way it's calculated.
- If you really want the plain average of the row values, say `average B0% by due_month`.

**Formulas are restricted by design.** A command becomes a small formula such as `[amount] * 0.18`, which the engine's own calculator evaluates. It never uses Python `eval`, so a formula can only do arithmetic, `round`, `abs` and date differences.
- **Math on a text column stops and says to convert it first**, rather than treating the text as blank.
- **Dividing by zero gives a blank cell.**
- **`add column x` won't overwrite an existing column.** Use `set x = ...` to do that on purpose.
- **Later parts of a command can use columns created earlier in it**, e.g. `add column gst = amount * 0.18 and sort by gst`.

**Working with a second file.** Use **+ Add lookup file** to load another CSV/XLSX, then refer to it by its file name (`customers` for `customers.xlsx`), or as "the other file" when only one is loaded.
- **The preview shows match results**, e.g. "20,000 of 43,728 rows found a match in customers; 23,728 had no match". It also reports repeated keys in the lookup file (the first match is used, like VLOOKUP), so **rows are never multiplied**.
- **Keys match ignoring case, spaces, and `101` vs `101.0`.** Columns line up by name ignoring case, spaces and underscores (`PAN` = `pan`, `Result Code` = `result_code`).
- **Appending reports columns that exist in only one of the files.** Comparing reports rows with a blank key.
- **A file whose name is also a column** only counts as the file when it's clearly used that way: `from amount`, `amount.xlsx`, `amount file`.

**Formatting changes only the Excel download, never the data.**
- **Every XLSX download has a bold, shaded, frozen header row and fitted column widths.**
- **Highlights also show in the on-screen preview**, and the preview card says how many rows will be highlighted.
- **Highlights are worked out on the final data**, so they still apply after later filters or sorts.
- **Charts go on their own "Chart N" sheet** with a small summary table. Your data isn't grouped to make them.
- **CSV downloads have no formatting.**
- **A date format on dates stored as text** (e.g. "15/11/2024") adds a visible "convert to date" step first.

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
| `plan.py` | The plan format: `filter`, `select_columns`, `drop_columns`, `sort`, `dedupe`, `group_by`, `split_by`, `pivot`, `top_n`, `date_part`, `calculate`, `clean_text`, `fill_blanks`, `drop_blank_rows`, `replace`, `split_column`, `merge_columns`, `rename`, `convert`, `compute`, `label`, `lookup`, `append`, `compare`, `highlight`, `number_format`, `chart` |
| `engine.py` | Executes a plan on pandas DataFrames; file loading; XLSX export (xlsxwriter, with formatting and charts) and CSV |
| `app.py` | FastAPI server: login, upload, extra files, plan (dry run with notes), execute, undo/redo, download, idle clean-up |
| `auth.py` / `users.py` | Accounts (hashed passwords), logins, lockout / the command to add and remove accounts |
| `static/index.html` | The web UI (chat on the left, spreadsheet preview on the right) |
| `tests/` | Parser tests (`test_planner.py`), analysis (`test_analysis.py`), cleaning (`test_cleaning.py`), formulas (`test_formulas.py`), other files (`test_files.py`), formatting (`test_formatting.py`) end-to-end API tests (`test_app.py`) and login / data clearing (`test_auth.py`) |

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

- **Everyone logs in**, and each person can only open their own uploads. Another user's session ID behaves exactly like one that doesn't exist.
- **Uploaded files are held in memory only**, never written to disk.
- **Uploaded data is deleted automatically**:
  - after **60 minutes without activity**, checked every minute even when nobody is using the app;
  - **immediately on "Log out"**;
  - on server restart.

### Accounts

Accounts are created by an administrator. There is no self-signup.

```bash
python users.py add priya       # prompts for the password
python users.py remove priya    # also ends their current login
python users.py list
```

- **Passwords are stored as salted PBKDF2-SHA256 hashes** (600,000 rounds) in `users.json` next to the app. `users.json` is in `.gitignore`, so it never goes to git.
- **Usernames are not case-sensitive.**
- **A login lasts 8 hours**, in an HTTP-only, SameSite=Strict cookie.
- **5 wrong passwords lock that username for 5 minutes.** The error message never reveals whether a username exists.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SHEET_ASSISTANT_IDLE_MINUTES` | `60` | Delete uploaded data after this many minutes without activity |
| `SHEET_ASSISTANT_LOGIN_HOURS` | `8` | How long a login lasts |
| `SHEET_ASSISTANT_USERS` | `users.json` next to the app | Where accounts are stored |
| `SHEET_ASSISTANT_HTTPS` | off | Set to `1` when served over HTTPS, so the login cookie is only ever sent encrypted |

Run it as **one server process** (don't use `--workers`). Logins and uploaded data live in that process's memory.
- `.gitignore` blocks all `.csv` / `.xlsx` / `.xls` / `.zip` files and the `samples/` folder, so no data can be committed by accident. The repository is code only.

## Known limitations

- Pivots are produced as a normal sheet (a cross-tab with totals), not an interactive Excel PivotTable. Excel's own PivotTable can still be built from the downloaded file.
- A pivot shows one calculation of one column at a time (`sum of amount`, not `sum and average of amount`).
- Months are shown as `2025-03` so they sort correctly; quarters as `2025-Q1`.
- A filter can't mix `and` with `or` in one command; split it into two commands.
- Values that only appear *inside* a longer text need `contains`: `description contains zomato`, not `only zomato`.

## Before company-wide rollout

Login and automatic data clearing are in place. Still to do before offering it to the whole company:
- **Hosting.** Run it on an internal server behind HTTPS rather than a laptop, and set `SHEET_ASSISTANT_HTTPS=1`.
- **Limits on upload size and on sessions per user**, so one huge file can't slow the server for everyone.
- **Load testing** with the largest real files people will use.
- **Optional: company single sign-on** (Microsoft/Google) instead of separate passwords. This needs the app registered by IT.

Background and product thinking: [excel-assistant-concept.md](excel-assistant-concept.md). It was written before the no-AI decision, so its LLM-based technical approach has been replaced by the rule-based parser.
