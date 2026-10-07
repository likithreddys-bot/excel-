"""Writes test/golden/cases.json: the Python reference parser's answer for each command.

The TypeScript parser in src/engine must produce the same plans and the same results. Run from the
repo root's Python environment (needs pandas + pydantic); `npm test` runs this first. The generated
file holds synthetic data only and is git-ignored.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

from datetime import date, timedelta  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import engine  # noqa: E402
from planner import make_plan  # noqa: E402


def make_bank_df(n=2000, seed=0) -> pd.DataFrame:
    """Same synthetic bank file as tests/test_planner.py (copied so this needs no pytest)."""
    today = date.today()
    rng = np.random.default_rng(seed)
    days_ago = rng.integers(0, 800, n)
    df = pd.DataFrame({
        "txn_id": np.arange(100000, 100000 + n),
        "txn_date": [(today - timedelta(days=int(d))).strftime("%d/%m/%Y") for d in days_ago],
        "description": rng.choice(["AMAZON PAY", "ATM WDL MG ROAD", "SALARY CREDIT ACME", "UPI/SWIGGY",
                                   "NEFT RENT", "UPI/ZOMATO", "IRCTC TICKET"], n),
        "category": rng.choice(["Food and Dining", "Travel", "Rent", "Shopping", "Salary", "Cash"], n),
        "txn_type": rng.choice(["DEBIT", "CREDIT"], n),
        "amount": rng.integers(10, 200000, n).astype(float),
        "balance": rng.integers(0, 1000000, n).astype(float),
        "branch": rng.choice(["Mumbai", "Pune", None], n),
    })
    df.loc[5] = df.loc[4]  # one exact duplicate row
    return df

SUPPORTED = {"filter", "select_columns", "drop_columns", "sort", "dedupe", "split_by", "date_part",
             "group_by", "pivot", "top_n", "calculate", "compute", "label",
             "clean_text", "fill_blanks", "drop_blank_rows", "replace", "split_column", "merge_columns", "rename", "convert",
             "lookup", "append", "compare", "highlight", "number_format", "chart"}

COMMANDS = [
    # filters
    "only debits over 5000", "only debit transactions", "debits over Rs. 5,000",
    "transactions in the last 30 days", "show last 3 months", "transactions older than 1 year",
    "rows not in the last 60 days", "remove rows where description contains ATM",
    "description contains amazon", "category is travel or rent", "category in travel, rent",
    "category is food and dining", "amount between 1000 and 5000", "amount over 5k and under 1 lakh",
    "amount >= 50000", "amount = 500", "txn_type = DEBIT", "amont > 100", "txn date after 01/03/2025",
    "transactions after 01/03/2025", "in 2024", "debits in march 2025", "exclude credits",
    "everything except cash", "remove transactions in 2023", "branch is empty", "branch is not empty",
    "where branch is pune", "rows with no branch", "description contains zomato or swiggy",
    "give me transactions between 01/01/2025 and 31/03/2025",
    "show me all debit transactions above 10000 from pune branch", "I want only salary credits",
    "only debits over 5000 in the last 90 days", "transactions in march 2025",
    "txn_type is debit and amount > 100000", "category is not cash", "description does not contain upi",
    "amount below 500 or amount above 150000", "balance less than 1000", "txn id = 100010",
    # split
    "split by category", "segregate by category and txn type", "split by branch", "split by month",
    "split by year", "split by weekday", "split by txn_date", "split by description",
    # sort
    "sort by amount descending", "sort by ammount", "sort by date newest first",
    "order by balance high to low", "sort by category then amount", "sort by category and amount descending",
    "sort by txn type", "arrange by amount lowest first",
    # columns
    "keep columns date, description, amount", "keep only description and amount", "drop the balance column",
    "remove branch", "hide balance and branch", "select txn_id, amount", "keep columns date, foobar",
    # dedupe
    "remove duplicates by txn id", "remove duplicate rows", "remove duplicates by description keeping the last",
    # multi
    "only debits over 5000, split by category and sort by amount descending",
    "filter debits then keep columns date, amount", "only credits and sort by amount descending",
    "debits over 1000 and drop balance", "add column month", "add column txn_date year",
    # asks
    "make it pretty", "category is groceries", "amount is lots", "", "txn_id", "amount, balance",
    "amnt, balanc", "category is travel and amount > 100 or branch is pune",
    # totals and counts
    "total amount by category", "count transactions per category", "average and max amount by txn type",
    "how many debits per branch", "total amount by month", "monthly totals by category",
    "quarterly total amount by txn type", "count transactions by weekday", "total amount and balance by branch",
    "sum of amount for each category", "min amount by category", "unique branch count by category",
    "how many transactions by txn type in 2025", "total amount by category with % of total",
    "percentage share of amount by category", "count by branch",
    # pivots
    "pivot amount by category and txn type", "total amount by category with txn type as columns",
    "count by branch across txn type", "pivot of total amount with branch in rows and category in columns",
    "pivot amount by month and txn type", "pivot by category", "average amount by category and txn type",
    "pivot total amount and balance by branch",
    # top / bottom
    "top 10 debits by amount", "bottom 5 by balance", "lowest 3 amounts per category", "latest 5 transactions",
    "first 10 rows", "last 5 rows", "top 3 by amount per branch", "oldest 4 transactions",
    # percent of total, running total, rank
    "add % of total amount", "add running total of amount", "running total of amount per category",
    "rank by amount", "rank by amount within category lowest first", "rank branches by total amount",
    "cumulative sum of amount sorted by date", "percent of total amount per category",
    # calculated columns on the bank file
    "add column gst = amount * 0.18", "add column net = balance - amount", "round amount to 2 decimals",
    "add column size = high if amount > 50000 else low",
    # formatting
    "highlight debits in red", "highlight rows where amount > 1 lakh in red", "highlight amount above 150000",
    "highlight debits in green", "highlight duplicates in description", "highlight blanks in branch",
    "highlight rows where amount > 150000 in red, then keep only debits", "show amount in rupees",
    "format balance with commas", "show balance with 0 decimals", "show balance as whole numbers",
    "show balance to 1 decimal", "show txn date as dd-mmm-yyyy", "show description in rupees",
    "highlight rows where amount > 100000 in dark blue and show amount in rupees",
    "show amount and balance as percent",
    "bar chart of total amount by category", "line chart of amount by month", "pie chart of count by txn type",
    "horizontal bar chart of average amount by branch", "plot total balance by year",
    "chart debits amount by category", "chart amount by txn id", "chart amount",
    "total amount by category and add a pie chart of it by category", "trim spaces", "rename amount to amt",
]

LEDGER_COMMANDS = [
    "add column gst = amount * 0.18", "add a new column called gst = amount * 18%", "add gst as 18% of amount",
    "gst = amount times 0.18", "create column gst as amount multiplied by 0.18",
    "add column net = credit - debit", "add column net2 = credit-debit", "add column x = (amount + credit) / 2",
    "add column y = amount + credit / 2", "add column with tax = amount + 18%", "add column discounted = amount - 10%",
    "add column in lakhs = amount / 1 lakh", "add column per unit = amount / qty",
    "add column double = [Amount (INR)] * 2", "add column gst = amount * 0.18 and sort by gst descending",
    "add column third = amount / 3 and round third to 2 decimals", "add column k = round(amount / 3, 1)",
    "add column double = amt text * 2", "add column x = colour * 2", "add column amount = amount * 2",
    "set amount = amount * 2", "round amount to 1 decimal", "round amount",
    "add column size = high if amount > 50000 else low", "add column size: if amount > 50000 then high else low",
    "add band: high if amount > 1 lakh, medium if amount > 10000, else low",
    "add column status = 'Record Found' if result code is 101 otherwise 'Not Found'",
    "add column big = yes if amount > 50000", "add column big debit = yes if txn type is debit and amount > 50000 else no",
    "add column is credit = 1 if txn type is credit else 0", "label amount over 1 lakh as large, otherwise small",
    "flag rows where amount > 50000", "add column duration = days between start date and end date",
    "add column m = months between start date and end date", "add column w = weeks between start date and end date",
    "add days since end date", "add column age = years since dob", "add age from dob",
    "add column d = days since amount", "set amount = 0 if txn type is credit", "add column big = amount > 100000",
    "txn_type = DEBIT", "amount = 1000",
    "add column pct = credit * 100 / amount and total pct by txn type",
    "add column pct = credit * 100 / amount and pivot by txn type with pct",
    "add column pct = credit * 100 / amount and average pct by txn type",
    "add column pct = credit * 100 / amount and total credit and amount by txn type",
]


def make_ledger_df() -> pd.DataFrame:
    """Same small file as tests/test_formulas.py: numbers, text dates and blanks."""
    return pd.DataFrame({
        "txn_type": ["DEBIT", "CREDIT", "DEBIT", "CREDIT"],
        "amount": [1000.0, 60000.0, 250000.0, 0.0],
        "credit": [0.0, 60000.0, 0.0, 10.0],
        "debit": [1000.0, 0.0, 250000.0, 0.0],
        "qty": [2, 0, 5, 1],
        "result_code": [101, 109, 101, 109],
        "Amount (INR)": [1.0, 2.0, 3.0, 4.0],
        "amt text": ["₹1,200", "5", None, "abc"],
        "start date": ["01/01/2024", "15/06/2024", None, "29/02/2024"],
        "end date": ["31/03/2025", "14/06/2025", "01/01/2025", "28/02/2025"],
        "dob": ["15/08/1990", "01/01/2000", "31/12/1985", None],
    })


def make_messy_df() -> pd.DataFrame:
    """Same file as tests/test_cleaning.py: stray spaces, odd case, blanks, rupee text, mixed date formats."""
    return pd.DataFrame({
        "name": ["  Asha  Rao ", "vikram SINGH", None, "  ", "Meera iyer", "Ravi Kumar Das"],
        "city": ["pune", "MUMBAI ", "Pune", None, None, "delhi"],
        "state": ["MH", "MH", "MH", None, "KA", "DL"],
        "email": ["asha@x.com", "vik@y.in", None, None, "meera@z.org", "ravi@x.com"],
        "description": ["UPI/SWIGGY", "UPI/ZOMATO", "N/A", None, "ATM WDL", "NEFT RENT"],
        "amt": ["₹1,200", "Rs. 90", "3,400.50", None, "", "INR 5,00,000"],
        "txn date": ["01/03/2025", "2025-04-02", "15/01/2024", None, "28/02/2025", "31/12/2025"],
        "score": [10.0, 0.0, 5.0, None, 0.0, 7.0],
    })


CLEAN_COMMANDS = [
    "trim spaces", "trim name", "remove extra spaces from name", "trim the name column",
    "make city title case", "capitalize city", "convert city to uppercase", "lowercase city", "city in proper case",
    "make score uppercase",
    "fill blank city with Unknown", "fill empty values in city with 'Not Known'", "fill down city",
    "fill blanks with 0", "replace blanks in state with NA", "fill up city", "fill blank score with 0",
    "remove blank rows", "remove rows with any blank values", "remove rows where city is empty",
    'replace "UPI/" with "" in description', 'remove "UPI/" from description', "replace 'UPI/' with nothing in description",
    "replace pune with Pune in city", "replace N/A with blank", "replace 0 with blank in score",
    "replace mh in state with Maharashtra", 'replace "Rs. " with "INR, " in amt', "replace score with 9",
    "get rid of 'UPI/' in description",
    "split name into first and last", "split email on @ into user and domain", "split description by slash",
    "split name into 3 columns", "split by state",
    'combine city and state with ", " into location', "merge city and state into place", "merge city and state",
    "rename amt to amount", "rename city to City Name and amt to Amount", "rename nothing to x",
    "convert amt to number", "change txn date to date", "make score text", "convert city to number",
    "convert description to date", "make state text",
    "trim spaces, make city title case and fill blank city with Unknown",
    "trim name, split name into first and last",
    "remove duplicates by email", "remove rows where description contains ATM", "drop the score column", "sort by city",
]


def main_df() -> pd.DataFrame:
    """Same files as tests/test_files.py."""
    return pd.DataFrame({
        "pan": ["ABCDE1234F", "XYZAB9876K", "PQRST1111A", None, "LMNOP2222B"],
        "result_code": [101.0, 109.0, 101.0, 101.0, 109.0],
        "amount": [100, 200, 300, 400, 500],
    })


def customers() -> pd.DataFrame:
    return pd.DataFrame({
        "PAN": ["abcde1234f", " xyzab9876k", "XYZAB9876K", "NEWPN0000Z"],
        "email": ["a@x.com", "b@y.com", "dup@y.com", "n@z.com"],
        "city": ["Pune", "Delhi", "Delhi", "Goa"],
        "amount": [1, 2, 3, 4],
    })


def march() -> pd.DataFrame:
    return pd.DataFrame({"PAN": ["ABCDE1234F", "NEWPN0000Z"], "Result Code": [101, 101],
                         "amount": [100, 999], "branch": ["Pune", "Goa"]})


FILE_SUITES = [
    ("files", main_df, {"customers": customers, "march": march}, [
        "bring email from customers on pan", "lookup email from customers using pan",
        "vlookup email from customers.xlsx by pan", "get the email from the customers file matching on pan",
        "match with customers on pan and bring email", "bring email and city from customers on pan",
        "match with customers on pan", "bring email from customers", "bring y from other",
        "append march", "add the rows from march", "rows not in march on pan",
        "show rows that are also in march on pan", "rows in march but not in this file on pan",
        "rows not in march on pan", "rows missing from march", "compare with march", "rows in march but not here",
        "only result code 101 and bring email from customers on pan", "total amount by result code",
        "add column gst = amount * 0.18", "rows in both files on pan",
    ]),
    ("files-codes", main_df, {"codes": lambda: pd.DataFrame({"result_code": ["101", "109"], "meaning": ["Record Found", "No record"]})}, [
        "bring meaning from codes on result code",
    ]),
    ("files-ref", main_df, {"ref": lambda: pd.DataFrame({"PAN Number": ["ABCDE1234F"], "score": [7]})}, [
        "bring score from ref matching pan with pan number",
    ]),
    ("files-one", main_df, {"customers": customers}, [
        "bring city from the other file on pan", "bring email from customers on pan",
    ]),
    ("files-both", main_df, {"march": march}, ["rows in both files on pan"]),
    ("files-other", main_df, {"other": lambda: pd.DataFrame({"amount": [100, 300], "Result Code": [101, 999]})}, [
        "rows also in other",
    ]),
    ("files-amount", main_df, {"amount": lambda: pd.DataFrame({"pan": ["ABCDE1234F"], "limit": [5]})}, [
        "add column double = amount * 2", "bring limit from amount file on pan",
    ]),
]


def clean(o):
    """Drop None values so Python's plan and the TypeScript plan compare equal."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return o


def cell(v):
    if v is pd.NaT:
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.date().isoformat()
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA:
        return None
    if hasattr(v, "item"):
        v = v.item()
    return v


def cells_of(df):
    """The whole result for small tables (summaries), so values and order are compared exactly."""
    if len(df) > 60:
        return None
    return [[cell(v) for v in row] for row in df.itertuples(index=False)]


def result_of(sheets, plan):
    out = {}
    # "order": the result's sort/top-N columns in result order. Rows that tie on them can come out in any
    # order (pandas' sort is not stable), so for those plans only this order is compared, not whole rows.
    sort_cols = [s.columns for s in plan.steps if s.op == "sort"]
    top_cols = [(s.per or []) + [s.column] for s in plan.steps if s.op == "top_n" and s.column]
    order_cols = top_cols or sort_cols
    for name, df in sheets.items():
        entry = {"rows": int(len(df)), "columns": [str(c) for c in df.columns],
                 "ids": None if top_cols or "txn_id" not in df else sorted(int(i) for i in df["txn_id"]),
                 "cells": None if top_cols else cells_of(df)}
        if order_cols:
            entry["order"] = [[cell(v) for v in row] for row in df[order_cols[-1]].itertuples(index=False)]
        out[name] = entry
    return out


def tabulate(df):
    return {str(c): [cell(v) for v in df[c]] for c in df.columns}


def build(df, commands, files=None):
    files = files or {}
    sheets = {"Sheet1": df}
    data = tabulate(df)
    cases = []
    for cmd in commands:
        plan = make_plan(sheets, cmd, files)
        case = {"command": cmd, "question": plan.clarification_question,
                "plan": clean(plan.model_dump())["steps"] if plan.steps else [],
                "summary": plan.summary, "runnable": False}
        if plan.steps and all(s.op in SUPPORTED for s in plan.steps):
            case["runnable"] = True
            try:
                notes: list[str] = []
                result = engine.apply_plan(sheets, plan, files=files, notes=notes)
                case["result"] = result_of(result, plan)
                case["notes"] = notes
                # What each chart is drawn from.
                case["charts"] = [{"columns": [str(c) for c in f.columns], "cells": cells_of(f)} for f in (
                    engine.chart_data(pd.concat(list(result.values()), ignore_index=True), st)
                    for st in plan.steps if st.op == "chart")]
            except engine.PlanError as e:  # parses fine but can't run on this data: the add-in must refuse too
                case["run_error"] = str(e)
        cases.append(case)
    return {"data": data, "files": {k: tabulate(v) for k, v in files.items()}, "cases": cases}


def main():
    suites = {"bank": build(make_bank_df(), COMMANDS), "ledger": build(make_ledger_df(), LEDGER_COMMANDS),
              "messy": build(make_messy_df(), CLEAN_COMMANDS)}
    for name, main, files, commands in FILE_SUITES:
        suites[name] = build(main(), commands, {k: f() for k, f in files.items()})
    os.makedirs(os.path.join(HERE, "..", "test", "golden"), exist_ok=True)
    with open(os.path.join(HERE, "..", "test", "golden", "cases.json"), "w") as f:
        json.dump({"suites": suites}, f)
    print("wrote", {k: len(v["cases"]) for k, v in suites.items()})


if __name__ == "__main__":
    main()
