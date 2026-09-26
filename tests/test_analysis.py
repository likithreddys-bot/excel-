"""Phase 1 analysis: pivots, date parts, top N, % of total, running total, rank."""
import pandas as pd
import pytest

import engine
from planner import make_plan
from test_planner import make_bank_df


@pytest.fixture(scope="module")
def sheets():
    return {"Sheet1": make_bank_df()}


@pytest.fixture(scope="module")
def df(sheets):
    return sheets["Sheet1"]


def run(sheets, cmd):
    p = make_plan(sheets, cmd)
    assert p.clarification_question is None, f"{cmd!r} -> asked: {p.clarification_question}"
    return p, engine.apply_plan(sheets, p)


def ops(plan):
    return [s.op for s in plan.steps]


# ---------- pivot ----------

@pytest.mark.parametrize("cmd", [
    "pivot amount by category and txn type",
    "total amount by category with txn type as columns",
    "sum of amount by category across txn type",
    "cross tab of amount by category and txn type",
])
def test_pivot_sum(sheets, df, cmd):
    p, out = run(sheets, cmd)
    (step,) = p.steps
    assert (step.op, step.rows, step.columns, step.values, step.func) == ("pivot", ["category"], ["txn_type"], "amount", "sum")
    t = out["Sheet1"].set_index("category")
    assert list(t.columns) == ["CREDIT", "DEBIT", "Total"]
    assert t.loc["Travel", "DEBIT"] == df[(df.category == "Travel") & (df.txn_type == "DEBIT")].amount.sum()
    assert t.loc["Travel", "Total"] == df[df.category == "Travel"].amount.sum()
    assert t.loc["Total", "Total"] == df.amount.sum()


def test_pivot_count_keeps_blanks(sheets, df):
    p, out = run(sheets, "count by branch across txn type")
    (step,) = p.steps
    assert (step.rows, step.columns, step.values, step.func) == (["branch"], ["txn_type"], None, "count")
    t = out["Sheet1"].set_index("branch")
    assert t.loc["(blank)", "Total"] == df.branch.isna().sum()
    assert t.loc["Total", "Total"] == len(df)


def test_pivot_average_totals_are_real_averages(sheets, df):
    _, out = run(sheets, "pivot average amount by category and txn type")
    t = out["Sheet1"].set_index("category")
    assert t.loc["Total", "Total"] == pytest.approx(df.amount.mean())  # not a sum of cell averages


def test_pivot_by_month(sheets):
    p, out = run(sheets, "pivot amount by month and txn type")
    assert ops(p) == ["date_part", "pivot"]
    assert p.steps[1].rows == ["month"]
    months = out["Sheet1"]["month"].tolist()
    assert months[:-1] == sorted(months[:-1]) and months[-1] == "Total"


def test_pivot_refuses_huge_column_count(sheets):
    p = make_plan(sheets, "pivot amount by category across txn id")
    assert p.steps == [] and "different values" in p.clarification_question


def test_pivot_with_filter(sheets, df):
    p, out = run(sheets, "pivot debits amount by category and branch")
    assert ops(p) == ["filter", "pivot"]
    t = out["Sheet1"].set_index("category")
    assert t.loc["Total", "Total"] == df[df.txn_type == "DEBIT"].amount.sum()


# ---------- date parts ----------

def test_total_by_month(sheets, df):
    p, out = run(sheets, "total amount by month")
    assert ops(p) == ["date_part", "group_by"]
    dates = pd.to_datetime(df.txn_date, format="%d/%m/%Y")
    expected = df.groupby(dates.dt.strftime("%Y-%m")).amount.sum()
    got = out["Sheet1"].set_index("month")["sum_amount"]
    assert got.to_dict() == expected.to_dict()


def test_count_by_weekday_in_order(sheets):
    _, out = run(sheets, "count transactions by weekday")
    assert out["Sheet1"]["weekday"].tolist() == engine.WEEKDAYS


def test_split_by_year(sheets, df):
    _, out = run(sheets, "split by year")
    years = pd.to_datetime(df.txn_date, format="%d/%m/%Y").dt.year.value_counts()
    assert engine.row_counts(out) == {str(y): n for y, n in sorted(years.items())}


def test_quarterly_totals(sheets):
    p, out = run(sheets, "quarterly total amount by txn type")
    assert p.steps[0].part == "quarter"
    assert out["Sheet1"]["quarter"].str.match(r"\d{4}-Q[1-4]").all()


# ---------- top / bottom N ----------

def test_top_debits(sheets, df):
    p, out = run(sheets, "top 10 debits by amount")
    assert ops(p) == ["filter", "top_n"]
    expected = df[df.txn_type == "DEBIT"].nlargest(10, "amount").amount.tolist()
    assert out["Sheet1"].amount.tolist() == expected


@pytest.mark.parametrize("cmd, column, largest, n", [
    ("top 10 highest amounts", "amount", True, 10),
    ("bottom 5 by balance", "balance", False, 5),
    ("top 10 lowest amounts", "amount", False, 10),
    ("top 5 transactions", "amount", True, 5),
    ("latest 5 transactions", "txn_date", True, 5),
    ("oldest 3 transactions", "txn_date", False, 3),
])
def test_top_n_variants(sheets, cmd, column, largest, n):
    p, _ = run(sheets, cmd)
    (step,) = p.steps
    assert (step.column, step.largest, step.n) == (column, largest, n)


def test_latest_uses_real_dates(sheets, df):
    _, out = run(sheets, "latest 5 transactions")
    newest = pd.to_datetime(df.txn_date, format="%d/%m/%Y").max()
    assert pd.to_datetime(out["Sheet1"].txn_date.iloc[0], format="%d/%m/%Y") == newest


def test_top_n_per_group(sheets, df):
    p, out = run(sheets, "lowest 3 amounts per category")
    assert p.steps[0].per == ["category"]
    assert len(out["Sheet1"]) == 3 * df.category.nunique()


def test_first_and_last_rows(sheets, df):
    _, out = run(sheets, "first 10 rows")
    assert out["Sheet1"].index.tolist() == df.index[:10].tolist()
    _, out = run(sheets, "last 5 rows")
    assert out["Sheet1"].index.tolist() == df.index[-5:].tolist()


def test_last_30_days_is_not_top_n(sheets):
    p, _ = run(sheets, "transactions in the last 30 days")
    assert ops(p) == ["filter"]


def test_top_with_date_filter(sheets):
    p, _ = run(sheets, "top 5 debits by amount in the last 90 days")
    assert ops(p) == ["filter", "top_n"]
    assert {c.operator for c in p.steps[0].conditions} == {"equals", "within_last_days"}


# ---------- % of total, running total, rank ----------

def test_group_with_percent_of_total(sheets):
    p, out = run(sheets, "total amount by category with % of total")
    assert ops(p) == ["group_by", "calculate"]
    assert out["Sheet1"]["% of total sum_amount"].sum() == pytest.approx(100, abs=0.05)


def test_percent_as_follow_up_command(sheets):
    grouped = engine.apply_plan(sheets, make_plan(sheets, "total amount by category"))
    p, out = run(grouped, "add % of total")
    assert p.steps[0].column == "sum_amount"


def test_running_total(sheets, df):
    p, out = run(sheets, "add running total of amount")
    (step,) = p.steps
    assert (step.kind, step.column) == ("running_total", "amount")
    assert out["Sheet1"]["running total amount"].iloc[-1] == df.amount.sum()


def test_running_total_per_group(sheets, df):
    _, out = run(sheets, "running total of amount per category")
    last = out["Sheet1"].groupby("category")["running total amount"].last()
    assert last.to_dict() == df.groupby("category").amount.sum().to_dict()


def test_rank(sheets, df):
    p, out = run(sheets, "rank by amount")
    (step,) = p.steps
    assert (step.kind, step.column, step.descending) == ("rank", "amount", True)
    o = out["Sheet1"]
    assert o.loc[o["rank by amount"] == 1, "amount"].iloc[0] == df.amount.max()


def test_rank_within_group_lowest_first(sheets, df):
    p, out = run(sheets, "rank by amount within category lowest first")
    (step,) = p.steps
    assert (step.per, step.descending) == (["category"], False)
    o = out["Sheet1"]
    firsts = o[o["rank by amount"] == 1].groupby("category").amount.first()
    assert firsts.to_dict() == df.groupby("category").amount.min().to_dict()


# ---------- combinations ----------

def test_multi_step_analysis(sheets):
    p, out = run(sheets, "only debits, split by category and top 3 by amount")
    assert ops(p) == ["filter", "split_by", "top_n"]
    assert all(len(d) == 3 for d in out.values())


def test_sort_by_date_is_chronological(sheets, df):
    _, out = run(sheets, "sort by date newest first")
    dates = pd.to_datetime(out["Sheet1"].txn_date, format="%d/%m/%Y")
    assert dates.is_monotonic_decreasing


# ---------- regressions found by trying unscripted phrasings ----------

def test_pivot_with_explicit_rows_and_columns(sheets, df):
    p, out = run(sheets, "show me a pivot of total amount with branch in rows and category in columns")
    step = p.steps[-1]
    assert (step.rows, step.columns, step.values, step.func) == (["branch"], ["category"], "amount", "sum")
    assert len(out["Sheet1"]) == df.branch.nunique(dropna=False) + 1  # branches + Total row


def test_rank_groups_by_total(sheets, df):
    p, out = run(sheets, "rank branches by total amount")
    assert ops(p) == ["group_by", "calculate", "sort"]
    o = out["Sheet1"]
    assert o.iloc[0]["rank by sum_amount"] == 1
    assert o.iloc[0]["sum_amount"] == df.groupby("branch", dropna=False).amount.sum().max()  # blank branch counts too


def test_rank_entity_without_total_asks(sheets):
    p = make_plan(sheets, "rank branches by amount")
    assert p.steps == [] and "rank each row" in p.clarification_question.lower()


def test_running_total_sorted_by_date(sheets, df):
    p, out = run(sheets, "cumulative sum of amount sorted by date")
    assert ops(p) == ["sort", "calculate"]
    assert p.steps[1].per is None
    assert out["Sheet1"]["running total amount"].iloc[-1] == df.amount.sum()


def test_percentage_share_by_category(sheets):
    p, out = run(sheets, "percentage share of amount by category")
    assert ops(p) == ["group_by", "calculate"]
    assert out["Sheet1"]["% of total sum_amount"].sum() == pytest.approx(100, abs=0.05)


def test_plural_totals(sheets):
    p, _ = run(sheets, "monthly totals by category")
    assert ops(p) == ["date_part", "group_by"]
    assert p.steps[1].columns == ["month", "category"]


def test_date_word_inside_column_name():
    df = pd.DataFrame({"result_code": [101, 109, 101], "assessment_year": [2024, 2025, 2025]})
    p = make_plan({"Output": df}, "pivot count by result code and assessment year")
    assert p.clarification_question is None
    step = p.steps[-1]
    assert (step.rows, step.columns) == (["result_code"], ["assessment_year"])


def test_condition_after_for_is_a_filter():
    df = pd.DataFrame({"result_code": [101, 109, 101, 101], "assessment_year": [2024, 2025, 2025, 2025]})
    p = make_plan({"Output": df}, "count by assessment year for result code 101")
    assert [s.op for s in p.steps] == ["filter", "group_by"]
    assert p.steps[1].columns == ["assessment_year"]
    out = engine.apply_plan({"Output": df}, p)["Output"]
    assert out.set_index("assessment_year").iloc[:, 0].to_dict() == {2024: 1, 2025: 2}


def test_pivot_counts_are_whole_numbers(sheets):
    _, out = run(sheets, "count by branch across txn type")
    assert all(str(t).startswith("int") for t in out["Sheet1"].dtypes.iloc[1:])
