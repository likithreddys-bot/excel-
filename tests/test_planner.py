"""Plain-English commands -> expected plans, on a bank-transaction-style file."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

import engine
from planner import make_plan

TODAY = date.today()


def make_bank_df(n=2000, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    days_ago = rng.integers(0, 800, n)
    df = pd.DataFrame({
        "txn_id": np.arange(100000, 100000 + n),
        "txn_date": [(TODAY - timedelta(days=int(d))).strftime("%d/%m/%Y") for d in days_ago],
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


@pytest.fixture(scope="module")
def sheets():
    return {"Sheet1": make_bank_df()}


def plan_for(sheets, cmd):
    p = make_plan(sheets, cmd)
    assert p.clarification_question is None, f"{cmd!r} -> asked: {p.clarification_question}"
    engine.apply_plan(sheets, p)  # every plan must also execute
    return p


def conds(step):
    return [(c.column, c.operator, tuple(c.values) if c.values else c.value) for c in step.conditions]


def only_filter(sheets, cmd):
    p = plan_for(sheets, cmd)
    assert [s.op for s in p.steps] == ["filter"], p.steps
    return p.steps[0]


@pytest.mark.parametrize("cmd, expected, match", [
    ("only debits over 5000", [("txn_type", "equals", "DEBIT"), ("amount", "gt", "5000")], "all"),
    ("only debit transactions", [("txn_type", "equals", "DEBIT")], "all"),
    ("debits over Rs. 5,000", [("txn_type", "equals", "DEBIT"), ("amount", "gt", "5000")], "all"),
    ("transactions in the last 30 days", [("txn_date", "within_last_days", "30")], "all"),
    ("show last 3 months", [("txn_date", "within_last_days", "90")], "all"),
    ("transactions older than 1 year", [("txn_date", "older_than_days", "365")], "all"),
    ("rows not in the last 60 days", [("txn_date", "older_than_days", "60")], "all"),
    ("remove rows where description contains ATM", [("description", "not_contains", "ATM")], "all"),
    ("description contains amazon", [("description", "contains", "amazon")], "all"),
    ("category is travel or rent", [("category", "equals", "Travel"), ("category", "equals", "Rent")], "any"),
    ("category in travel, rent", [("category", "in", ("Travel", "Rent"))], "all"),
    ("category is food and dining", [("category", "equals", "Food and Dining")], "all"),
    ("amount between 1000 and 5000", [("amount", "gte", "1000"), ("amount", "lte", "5000")], "all"),
    ("amount over 5k and under 1 lakh", [("amount", "gt", "5000"), ("amount", "lt", "100000")], "all"),
    ("amount >= 50000", [("amount", "gte", "50000")], "all"),
    ("amount = 500", [("amount", "equals", "500")], "all"),
    ("txn_type = DEBIT", [("txn_type", "equals", "DEBIT")], "all"),
    ("amont > 100", [("amount", "gt", "100")], "all"),
    ("txn date after 01/03/2025", [("txn_date", "gt", "2025-03-01")], "all"),
    ("transactions after 01/03/2025", [("txn_date", "gt", "2025-03-01")], "all"),
    ("in 2024", [("txn_date", "gte", "2024-01-01"), ("txn_date", "lt", "2025-01-01")], "all"),
    ("debits in march 2025", [("txn_date", "gte", "2025-03-01"), ("txn_date", "lt", "2025-04-01"),
                              ("txn_type", "equals", "DEBIT")], "all"),
    ("exclude credits", [("txn_type", "not_equals", "CREDIT")], "all"),
    ("everything except cash", [("category", "not_equals", "Cash")], "all"),
    ("remove transactions in 2023", [("txn_date", "lt", "2023-01-01"), ("txn_date", "gte", "2024-01-01")], "any"),
    ("branch is empty", [("branch", "is_empty", None)], "all"),
    ("branch is not empty", [("branch", "not_empty", None)], "all"),
    ("where branch is pune", [("branch", "equals", "Pune")], "all"),
    ("rows with no branch", [("branch", "is_empty", None)], "all"),
    ("description contains zomato or swiggy",
     [("description", "contains", "zomato"), ("description", "contains", "swiggy")], "any"),
    ("give me transactions between 01/01/2025 and 31/03/2025",
     [("txn_date", "gte", "2025-01-01"), ("txn_date", "lte", "2025-03-31")], "all"),
    ("show me all debit transactions above 10000 from pune branch",
     [("txn_type", "equals", "DEBIT"), ("branch", "equals", "Pune"), ("amount", "gt", "10000")], "all"),
    ("I want only salary credits", [("category", "equals", "Salary"), ("txn_type", "equals", "CREDIT")], "all"),
])
def test_filters(sheets, cmd, expected, match):
    step = only_filter(sheets, cmd)
    assert sorted(conds(step)) == sorted(expected)
    assert step.match == match


def test_split(sheets):
    p = plan_for(sheets, "split by category")
    assert [(s.op, s.column) for s in p.steps] == [("split_by", "category")]
    p = plan_for(sheets, "segregate by category and txn type")
    assert [s.column for s in p.steps] == ["category", "txn_type"]


@pytest.mark.parametrize("cmd, cols, ascending", [
    ("sort by amount descending", ["amount"], False),
    ("sort by ammount", ["amount"], True),
    ("sort by date newest first", ["txn_date"], False),
    ("order by balance high to low", ["balance"], False),
])
def test_sort(sheets, cmd, cols, ascending):
    (step,) = plan_for(sheets, cmd).steps
    assert (step.op, step.columns, step.ascending) == ("sort", cols, ascending)


@pytest.mark.parametrize("cmd, op, cols", [
    ("keep columns date, description, amount", "select_columns", ["txn_date", "description", "amount"]),
    ("keep only description and amount", "select_columns", ["description", "amount"]),
    ("drop the balance column", "drop_columns", ["balance"]),
    ("remove branch", "drop_columns", ["branch"]),
])
def test_columns(sheets, cmd, op, cols):
    (step,) = plan_for(sheets, cmd).steps
    assert (step.op, step.columns) == (op, cols)


@pytest.mark.parametrize("cmd, group, aggs", [
    ("total amount by category", ["category"], [("amount", "sum")]),
    ("count transactions per category", ["category"], [("category", "count")]),
    ("average and max amount by txn type", ["txn_type"], [("amount", "mean"), ("amount", "max")]),
])
def test_group(sheets, cmd, group, aggs):
    (step,) = plan_for(sheets, cmd).steps
    assert step.op == "group_by" and step.columns == group
    assert [(a.column, a.func) for a in step.aggregations] == aggs


def test_group_with_filter_word(sheets):
    f, g = plan_for(sheets, "how many debits per branch").steps
    assert conds(f) == [("txn_type", "equals", "DEBIT")]
    assert (g.op, g.columns) == ("group_by", ["branch"])


def test_dedupe(sheets):
    (step,) = plan_for(sheets, "remove duplicates by txn id").steps
    assert (step.op, step.columns) == ("dedupe", ["txn_id"])
    (step,) = plan_for(sheets, "remove duplicate rows").steps
    assert (step.op, step.columns) == ("dedupe", None)
    out = engine.apply_plan(sheets, make_plan(sheets, "remove duplicate rows"))
    assert len(out["Sheet1"]) == len(sheets["Sheet1"]) - 1


def test_multi_step(sheets):
    p = plan_for(sheets, "only debits over 5000, split by category and sort by amount descending")
    assert [s.op for s in p.steps] == ["filter", "split_by", "sort"]
    p = plan_for(sheets, "filter debits then keep columns date, amount")
    assert [s.op for s in p.steps] == ["filter", "select_columns"]


@pytest.mark.parametrize("cmd, expect_in_question", [
    ("make it pretty", "couldn't understand"),
    ("category is groceries", "doesn't appear"),
    ("keep columns date, colour", "colour"),
    ("amount is lots", "not a number"),
])
def test_asks_instead_of_guessing(sheets, cmd, expect_in_question):
    p = make_plan(sheets, cmd)
    assert p.clarification_question and expect_in_question in p.clarification_question
    assert p.steps == []


def test_results_match_pandas(sheets):
    df = sheets["Sheet1"]
    dates = pd.to_datetime(df["txn_date"], format="%d/%m/%Y")
    out = engine.apply_plan(sheets, make_plan(sheets, "only debits over 5000 in the last 90 days"))["Sheet1"]
    cutoff = pd.Timestamp(TODAY) - pd.Timedelta(days=90)
    expected = df[(df.txn_type == "DEBIT") & (df.amount > 5000) & (dates >= cutoff)]
    assert out.index.equals(expected.index)

    out = engine.apply_plan(sheets, make_plan(sheets, "transactions in march 2025"))["Sheet1"]
    assert out.index.equals(df[(dates >= "2025-03-01") & (dates < "2025-04-01")].index)



def test_refuses_split_into_thousands_of_sheets():
    df = pd.DataFrame({"result_code": [101.0, 109.0] * 100, "response": [f"r{i}" for i in range(200)]})
    p = make_plan({"Output": df}, "split by response")
    assert p.steps == []
    assert "200 different values" in p.clarification_question
    assert "result_code (2)" in p.clarification_question
