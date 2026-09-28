"""Regressions from a real session on a 740K-row loan schedule file (replayed here on synthetic data
with the same columns)."""
import io

import numpy as np
import pandas as pd
import pytest

import engine
from planner import examples, make_plan, reply_columns, split_clauses


def make_loans(n=3000, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    disb = pd.Timestamp("2025-01-01") + pd.to_timedelta(rng.integers(0, 365, n), unit="D")
    sched = rng.integers(1, 4, n)
    due = disb + pd.to_timedelta(sched * 30, unit="D")
    alloc = rng.integers(1000, 50000, n).astype(float)
    b0 = (alloc * rng.uniform(0, 1, n)).round(0)
    tot = np.minimum(alloc, b0 + (alloc * rng.uniform(0, 0.4, n)).round(0))
    return pd.DataFrame({
        "loan_schedule_id": np.arange(n) + 1, "loan_id": rng.integers(1, n // 2, n), "user_id": rng.integers(1, n // 3, n),
        "disb_date": disb.strftime("%Y-%m-%d"), "schedule_num": sched, "orignal_tenure_days": sched * 30,
        "principal_amt": (alloc * 0.9).round(0), "due_date": due.strftime("%Y-%m-%d"), "alloc_amt": alloc,
        "before_b0_amt": (b0 * 0.1).round(0), "b0_amt": b0, "b1_amt": ((tot - b0) * 0.6).round(0),
        "b2_amt": ((tot - b0) * 0.4).round(0), "within_120d": tot, "tot_amt": tot,
    })


@pytest.fixture(scope="module")
def df():
    return make_loans()


@pytest.fixture(scope="module")
def sheets(df):
    return {"S": df}


def expected_by_month(df):
    g = df.assign(m=df.due_date.str[:7]).groupby("m")[["b0_amt", "tot_amt", "alloc_amt"]].sum()
    return pd.DataFrame({"B0%": g.b0_amt * 100 / g.alloc_amt, "overall_repay%": g.tot_amt * 100 / g.alloc_amt})


# ---------- the exact messages from the session ----------

@pytest.mark.parametrize("message", [
    "B0% = b0_amt*100/alloc_amt and overall_repay% = tot_amt*100/alloc_amt now do pivot wrt due_month "
    "with these columns B0% and overall_repay%",
    "B0% = b0_amt*100/'alloc_amt' overall_repay% = tot_amt*100/'alloc_amt' now do pivot wrt due_month "
    "with these columns B0% and overall_repay%",
    "B0% = b0_amt*100/alloc_amt, overall_repay% = tot_amt*100/alloc_amt then pivot w.r.t. due_month with B0% and overall_repay%",
])
def test_formulas_then_pivot_by_due_month(sheets, df, message):
    p = make_plan(sheets, message)
    assert p.clarification_question is None, p.clarification_question
    assert [s.op for s in p.steps] == ["compute", "compute", "date_part", "pivot"]
    pivot = p.steps[-1]
    assert pivot.rows == ["due_month"] and set(pivot.calculated) == {"B0%", "overall_repay%"}
    out = engine.apply_plan(sheets, p)["S"].set_index("due_month")
    expected = expected_by_month(df)
    # From each month's totals (calculated field), not the average of row percentages.
    pd.testing.assert_frame_equal(out.drop("Total"), expected, check_names=False, check_index_type=False)
    assert out.loc["Total", "B0%"] == pytest.approx(df.b0_amt.sum() * 100 / df.alloc_amt.sum())
    assert "not an average of row values" in p.summary


def test_totals_differ_from_averaging_row_percentages(df):
    m = df[df.due_date.str[:7] == df.due_date.str[:7].min()]
    assert abs((m.b0_amt * 100 / m.alloc_amt).mean() - m.b0_amt.sum() * 100 / m.alloc_amt.sum()) > 0.5


def test_average_explicitly_asked_means_average_of_rows(sheets, df):
    p = make_plan(sheets, "B0% = b0_amt*100/alloc_amt and pivot average B0% by due_month")
    pivot = p.steps[-1]
    assert (pivot.values, pivot.func, pivot.calculated) == ("B0%", "mean", {})


def test_formula_from_an_earlier_message_still_uses_totals(sheets, df):
    first = make_plan(sheets, "B0% = b0_amt*100/alloc_amt")
    with_col = engine.apply_plan(sheets, first)
    p = make_plan(with_col, "total B0% by due_month", computed={"B0%": first.steps[0].expr})
    group = p.steps[-1]
    assert group.calculated == {"B0%": "[b0_amt] * 100 / [alloc_amt]"}
    out = engine.apply_plan(with_col, p)["S"].set_index("due_month")["B0%"]
    assert out.to_dict() == pytest.approx(expected_by_month(df)["B0%"].to_dict())


@pytest.mark.parametrize("message", ["do pivot on due_month", "pivot by due month", "count by due_month"])
def test_due_month_is_the_month_of_due_date(sheets, message):
    p = make_plan(sheets, message)
    assert p.clarification_question is None, p.clarification_question
    part = p.steps[0]
    assert (part.op, part.column, part.part) == ("date_part", "due_date", "month")


def test_add_column_due_month(sheets):
    (step,) = make_plan(sheets, "add column due_month").steps
    assert (step.name, step.column, step.part) == ("due_month", "due_date", "month")


def test_disb_year(sheets):
    p = make_plan(sheets, "total alloc_amt by disb_year")
    assert (p.steps[0].column, p.steps[0].part) == ("disb_date", "year")


# ---------- splitting a message into steps ----------

def test_split_two_formulas_and_now():
    assert split_clauses("a% = x*100/y and b% = z*100/y now do pivot by m") == ["a% = x*100/y", "b% = z*100/y", "pivot by m"]
    assert split_clauses("a% = x*100/y b% = z*100/y") == ["a% = x*100/y", "b% = z*100/y"]


def test_equals_filters_are_not_split():
    assert split_clauses("txn_type = DEBIT or txn_type = CREDIT") == ["txn_type = DEBIT or txn_type = CREDIT"]
    assert split_clauses("amount >= 5000 and txn_type = DEBIT") == ["amount >= 5000 and txn_type = DEBIT"]


def test_percent_sign_in_a_column_name_is_not_percent_of_total(sheets):
    p = make_plan(sheets, "B0% = b0_amt*100/alloc_amt and sort by B0% descending")
    assert [s.op for s in p.steps] == ["compute", "sort"]


# ---------- replying to a question with column names ----------

def test_question_then_reply(sheets):
    q = make_plan(sheets, "total amount by schedule_num")
    assert q.awaits_columns and "Reply with the column name" in q.clarification_question
    p = make_plan(sheets, "total amount by schedule_num", answer=["alloc_amt", "b0_amt", "tot_amt"])
    (group,) = p.steps
    assert [a.column for a in group.aggregations] == ["alloc_amt", "b0_amt", "tot_amt"]


def test_reply_columns(sheets):
    assert reply_columns(sheets, "alloc_amt, tot_amt") == (["alloc_amt", "tot_amt"], [])
    assert reply_columns(sheets, "alloc_amt,bo_amt,tot_amt") == (["alloc_amt", "tot_amt"], ["'bo_amt' (did you mean b0_amt?)"])
    assert reply_columns(sheets, "keep columns alloc_amt") is None
    assert reply_columns(sheets, "sort by alloc_amt") is None


def test_bare_column_name_gets_suggestions(sheets):
    q = make_plan(sheets, "alloc_amt").clarification_question
    assert "What should I do with alloc_amt?" in q and "total alloc_amt by" in q


# ---------- examples use the file's own columns ----------

def test_examples_use_this_files_columns(sheets):
    ex = examples(sheets)
    assert all("debit" not in e.lower() and "ATM" not in e for e in ex)
    assert any("_amt" in e for e in ex) and any("disb_month" in e or "due_month" in e for e in ex)
    for e in ex:  # every example actually works on this file
        p = make_plan(sheets, e)
        assert p.clarification_question is None, (e, p.clarification_question)
        engine.apply_plan(sheets, p)


def test_couldnt_understand_shows_this_files_examples(sheets):
    q = make_plan(sheets, "otal amount by category").clarification_question
    assert "ATM" not in q and "_amt" in q


# ---------- the same through the app ----------

def test_app_session_replay(client, df):
    buf = io.BytesIO()
    df.to_csv(buf, index=False)
    r = client.post("/api/upload", files={"file": ("loans.csv", buf.getvalue())}).json()
    sid = r["session_id"]
    assert any("_amt" in e for e in r["examples"])

    ask = client.post("/api/plan", json={"session_id": sid, "message": "total amount by schedule_num"}).json()
    assert "Reply with the column name" in ask["clarification_question"]
    typo = client.post("/api/plan", json={"session_id": sid, "message": "alloc_amt,bo_amt,tot_amt"}).json()
    assert "did you mean b0_amt" in typo["clarification_question"]
    plan = client.post("/api/plan", json={"session_id": sid, "message": "alloc_amt, b0_amt, tot_amt"}).json()
    assert plan["steps"] == ["Group by schedule_num with sum of alloc_amt, sum of b0_amt, sum of tot_amt"]
    client.post("/api/undo", json={"session_id": sid})

    plan = client.post("/api/plan", json={"session_id": sid, "message": "B0% = b0_amt*100/alloc_amt"}).json()
    client.post("/api/execute", json={"session_id": sid})
    plan = client.post("/api/plan", json={"session_id": sid, "message": "pivot by due_month with B0%"}).json()
    assert "total b0_amt * 100 / total alloc_amt" in plan["steps"][-1]
    st = client.post("/api/execute", json={"session_id": sid}).json()
    data = st["sheets"][0]
    assert data["columns"] == ["due_month", "B0%"]
    assert data["data"][0][1] == pytest.approx(expected_by_month(df)["B0%"].iloc[0])
