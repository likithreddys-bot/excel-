"""Phase 3 calculated columns: arithmetic, rounding, if/else labels, date differences."""
from datetime import date

import pandas as pd
import pytest

import engine
from planner import make_plan


def ledger() -> pd.DataFrame:
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


@pytest.fixture
def sheets():
    return {"S": ledger()}


def run(sheets, cmd):
    p = make_plan(sheets, cmd)
    assert p.clarification_question is None, f"{cmd!r} -> asked: {p.clarification_question}"
    return p, engine.apply_plan(sheets, p)["S"]


def only(p):
    (step,) = p.steps
    return step


def asks(sheets, cmd, text):
    p = make_plan(sheets, cmd)
    assert p.steps == [] and text.lower() in p.clarification_question.lower(), p.clarification_question


# ---------- arithmetic ----------

@pytest.mark.parametrize("cmd", [
    "add column gst = amount * 0.18",
    "add a new column called gst = amount * 18%",
    "add gst as 18% of amount",
    "gst = amount times 0.18",
    "create column gst as amount multiplied by 0.18",
])
def test_gst(sheets, cmd):
    p, out = run(sheets, cmd)
    step = only(p)
    assert (step.op, step.name) == ("compute", "gst")
    assert out.gst.tolist() == [180.0, 10800.0, 45000.0, 0.0]


def test_subtract_columns(sheets):
    p, out = run(sheets, "add column net = credit - debit")
    assert only(p).expr == "[credit] - [debit]"
    assert out.net.tolist() == [-1000.0, 60000.0, -250000.0, 10.0]


def test_subtract_without_spaces(sheets):
    _, out = run(sheets, "net = credit-debit")
    assert out.net.tolist()[0] == -1000.0


def test_precedence_and_brackets(sheets):
    _, out = run(sheets, "add column x = (amount + credit) / 2")
    assert out.x.tolist()[1] == 60000.0
    _, out = run(sheets, "add column y = amount + credit / 2")
    assert out.y.tolist()[1] == 90000.0


def test_increase_by_percent(sheets):
    p, out = run(sheets, "add column with tax = amount + 18%")
    assert out["with tax"].tolist()[0] == 1180.0
    _, out = run(sheets, "add column discounted = amount - 10%")
    assert out.discounted.tolist()[0] == 900.0


def test_numbers_in_words(sheets):
    _, out = run(sheets, "add column in lakhs = amount / 1 lakh")
    assert out["in lakhs"].tolist()[2] == 2.5


def test_divide_by_zero_is_blank(sheets):
    _, out = run(sheets, "add column per unit = amount / qty")
    assert out["per unit"].tolist()[0] == 500.0
    assert pd.isna(out["per unit"][1])


def test_bracketed_column_name(sheets):
    p, out = run(sheets, "add column double = [Amount (INR)] * 2")
    assert out.double.tolist() == [2.0, 4.0, 6.0, 8.0]


def test_new_column_usable_in_same_command(sheets):
    p, out = run(sheets, "add column gst = amount * 0.18 and sort by gst descending")
    assert [s.op for s in p.steps] == ["compute", "sort"]
    assert out.gst.tolist()[0] == 45000.0


def test_round(sheets):
    p, out = run(sheets, "add column third = amount / 3 and round third to 2 decimals")
    assert (p.steps[1].name, p.steps[1].replace) == ("third", True)
    assert out.third.tolist()[0] == 333.33


def test_round_in_formula(sheets):
    _, out = run(sheets, "add column k = round(amount / 3, 1)")
    assert out.k.tolist()[0] == 333.3


# ---------- safety ----------

def test_text_column_in_math_stops(sheets):
    p = make_plan(sheets, "add column double = amt text * 2")
    with pytest.raises(engine.PlanError, match="convert amt text to number"):
        engine.apply_plan(sheets, p)  # the preview (dry run) shows this message instead of blanking values


def test_unknown_column_asks(sheets):
    asks(sheets, "add column x = colour * 2", "couldn't find")


def test_add_existing_column_refuses(sheets):
    asks(sheets, "add column amount = amount * 2", "already a column")


def test_set_overwrites(sheets):
    p, out = run(sheets, "set amount = amount * 2")
    assert only(p).replace is True
    assert out.amount.tolist()[0] == 2000.0


def test_equals_on_existing_column_is_still_a_filter(sheets):
    assert only(make_plan(sheets, "txn_type = DEBIT")).op == "filter"
    assert only(make_plan(sheets, "only debits with amount >= 5000")).op == "filter"
    assert only(make_plan(sheets, "amount >= 50000")).op == "filter"


def test_phase1_add_commands_unaffected(sheets):
    assert only(make_plan(sheets, "add running total of amount")).kind == "running_total"
    grouped = engine.apply_plan(sheets, make_plan(sheets, "total amount by txn type"))
    assert only(make_plan(grouped, "add % of total")).kind == "percent_of_total"


# ---------- if / else labels ----------

@pytest.mark.parametrize("cmd", [
    "add column size = high if amount > 50000 else low",
    "size = high if amount > 50000, otherwise low",
    "add column size: if amount > 50000 then high else low",
])
def test_two_way_label(sheets, cmd):
    p, out = run(sheets, cmd)
    assert (only(p).op, only(p).name, only(p).default) == ("label", "size", "low")
    assert out["size"].tolist() == ["low", "high", "high", "low"]


def test_three_way_label_first_match_wins(sheets):
    _, out = run(sheets, "add band: high if amount > 1 lakh, medium if amount > 10000, else low")
    assert out.band.tolist() == ["low", "medium", "high", "low"]


def test_label_with_text_condition_and_quoted_values(sheets):
    _, out = run(sheets, "add column status = 'Record Found' if result code is 101 otherwise 'Not Found'")
    assert out.status.tolist() == ["Record Found", "Not Found", "Record Found", "Not Found"]


def test_label_without_else_leaves_blank(sheets):
    _, out = run(sheets, "add column big = yes if amount > 50000")
    assert out.big.tolist()[1] == "yes" and pd.isna(out.big[0])


def test_label_with_combined_condition(sheets):
    _, out = run(sheets, "add column big debit = yes if txn type is debit and amount > 50000 else no")
    assert out["big debit"].tolist() == ["no", "no", "yes", "no"]


def test_numeric_labels_become_numbers(sheets):
    _, out = run(sheets, "add column is credit = 1 if txn type is credit else 0")
    assert out["is credit"].tolist() == [0, 1, 0, 1]
    assert pd.api.types.is_numeric_dtype(out["is credit"])


def test_label_command(sheets):
    p, out = run(sheets, "label amount over 1 lakh as large, otherwise small")
    assert only(p).name == "label"
    assert out.label.tolist() == ["small", "small", "large", "small"]


def test_flag_command(sheets):
    _, out = run(sheets, "flag rows where amount > 50000")
    assert out.flag.tolist()[1] == "Yes" and pd.isna(out.flag[0])


# ---------- dates ----------

def test_days_between(sheets):
    p, out = run(sheets, "add column duration = days between start date and end date")
    assert only(p).expr == "days([start date], [end date])"
    assert out.duration.tolist()[0] == (date(2025, 3, 31) - date(2024, 1, 1)).days
    assert pd.isna(out.duration[2])


def test_months_between_counts_whole_months(sheets):
    _, out = run(sheets, "add column m = months between start date and end date")
    assert out.m.tolist()[:2] == [14, 11]  # 15 Jun 2024 -> 14 Jun 2025 is not yet 12 months


def test_days_since_uses_today(sheets):
    p, out = run(sheets, "add days since end date")
    assert only(p).name == "days since end date"
    assert out["days since end date"].tolist()[0] == (date.today() - date(2025, 3, 31)).days


def test_age(sheets):
    _, out = run(sheets, "add column age = years since dob")
    t = date.today()
    expected = t.year - 1990 - ((t.month, t.day) < (8, 15))
    assert out.age.tolist()[0] == expected


def test_age_shortcut(sheets):
    p, _ = run(sheets, "add age from dob")
    assert (only(p).name, only(p).expr) == ("age", "years([dob], today())")


def test_date_math_needs_a_date_column(sheets):
    asks(sheets, "add column d = days since amount", "doesn't look like a date")


# ---------- regressions found by trying unscripted phrasings ----------

def test_set_with_if_and_no_else_keeps_other_values():
    df = pd.DataFrame({"category": ["Cash", "Rent", None, "Cash"]})
    p = make_plan({"S": df}, "set category = Other if category is Cash")
    out = engine.apply_plan({"S": df}, p)["S"]
    assert out.category.tolist()[:2] == ["Other", "Rent"] and pd.isna(out.category[2])
    assert "keep the current value" in p.summary


def test_set_numeric_column_with_if_keeps_numbers(sheets):
    _, out = run(sheets, "set amount = 0 if txn type is credit")
    assert out.amount.tolist() == [1000.0, 0.0, 250000.0, 0.0]
    assert pd.api.types.is_numeric_dtype(out.amount)


def test_x_means_multiply(sheets):
    _, out = run(sheets, "make a new column doubled = amount x 2")
    assert out.doubled.tolist()[0] == 2000.0


def test_condition_alone_gives_yes_no(sheets):
    p, out = run(sheets, "add column big = amount > 100000")
    assert out.big.tolist() == ["No", "No", "Yes", "No"]
