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

SUPPORTED = {"filter", "select_columns", "drop_columns", "sort", "dedupe", "split_by", "date_part"}

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
    # not yet in the add-in (must be recognised, not guessed)
    "total amount by category", "pivot amount by category and txn type", "top 10 by amount",
    "rank by amount", "highlight debits in red", "trim spaces", "add column gst = amount * 0.18",
    "bar chart of total amount by category", "rename amount to amt", "round amount to 2 decimals",
]


def clean(o):
    """Drop None values so Python's plan and the TypeScript plan compare equal."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return o


def cell(v):
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA:
        return None
    if hasattr(v, "item"):
        v = v.item()
    return v


def result_of(sheets, plan):
    out = {}
    sort_cols = [s.columns for s in plan.steps if s.op == "sort"]
    for name, df in sheets.items():
        entry = {"rows": int(len(df)), "ids": sorted(int(i) for i in df["txn_id"]) if "txn_id" in df else None,
                 "columns": [str(c) for c in df.columns]}
        if sort_cols:
            entry["order"] = [[cell(v) for v in row] for row in df[sort_cols[-1]].itertuples(index=False)]
        out[name] = entry
    return out


def main():
    df = make_bank_df()
    sheets = {"Sheet1": df}
    data = {str(c): [cell(v) for v in df[c]] for c in df.columns}
    cases = []
    for cmd in COMMANDS:
        plan = make_plan(sheets, cmd)
        case = {"command": cmd, "question": plan.clarification_question,
                "plan": clean(plan.model_dump())["steps"] if plan.steps else [],
                "summary": plan.summary, "runnable": False}
        if plan.steps and all(s.op in SUPPORTED for s in plan.steps):
            case["runnable"] = True
            case["result"] = result_of(engine.apply_plan(sheets, plan), plan)
        cases.append(case)
    os.makedirs(os.path.join(HERE, "..", "test", "golden"), exist_ok=True)
    with open(os.path.join(HERE, "..", "test", "golden", "cases.json"), "w") as f:
        json.dump({"data": data, "cases": cases}, f)
    print(f"wrote {len(cases)} cases")


if __name__ == "__main__":
    main()
