"""Phase 4: working with another file - lookup (VLOOKUP), append, compare."""
import io

import pandas as pd
import pytest

import engine
from planner import make_plan


def main_df() -> pd.DataFrame:
    return pd.DataFrame({
        "pan": ["ABCDE1234F", "XYZAB9876K", "PQRST1111A", None, "LMNOP2222B"],
        "result_code": [101.0, 109.0, 101.0, 101.0, 109.0],
        "amount": [100, 200, 300, 400, 500],
    })


def customers() -> pd.DataFrame:
    return pd.DataFrame({
        "PAN": ["abcde1234f", " xyzab9876k", "XYZAB9876K", "NEWPN0000Z"],  # case/space differences, one duplicate
        "email": ["a@x.com", "b@y.com", "dup@y.com", "n@z.com"],
        "city": ["Pune", "Delhi", "Delhi", "Goa"],
        "amount": [1, 2, 3, 4],
    })


def march() -> pd.DataFrame:
    return pd.DataFrame({
        "PAN": ["ABCDE1234F", "NEWPN0000Z"],
        "Result Code": [101, 101],
        "amount": [100, 999],
        "branch": ["Pune", "Goa"],
    })


@pytest.fixture
def sheets():
    return {"S": main_df()}


@pytest.fixture
def files():
    return {"customers": customers(), "march": march()}


def run(sheets, files, cmd):
    p = make_plan(sheets, cmd, files)
    assert p.clarification_question is None, f"{cmd!r} -> asked: {p.clarification_question}"
    notes: list[str] = []
    return p, engine.apply_plan(sheets, p, files=files, notes=notes)["S"], notes


def only(p):
    (step,) = p.steps
    return step


# ---------- lookup ----------

@pytest.mark.parametrize("cmd", [
    "bring email from customers on pan",
    "lookup email from customers using pan",
    "vlookup email from customers.xlsx by pan",
    "get the email from the customers file matching on pan",
    "match with customers on pan and bring email",
])
def test_lookup_phrasings(sheets, files, cmd):
    p, out, notes = run(sheets, files, cmd)
    step = only(p)
    assert (step.op, step.file, step.left_on, step.right_on) == ("lookup", "customers", "pan", "PAN")
    assert step.columns == ["email"]
    assert out.email.tolist()[:3] == ["a@x.com", "b@y.com", None] or pd.isna(out.email[2])


def test_lookup_matches_loosely_and_uses_first_duplicate(sheets, files):
    _, out, notes = run(sheets, files, "bring email and city from customers on pan")
    assert out.email.tolist()[:2] == ["a@x.com", "b@y.com"]  # " xyzab9876k" matched, first of the duplicates
    assert out.city.tolist()[:2] == ["Pune", "Delhi"]
    assert any("repeated PAN" in n for n in notes)
    assert "2 of 5 rows found a match in customers; 3 had no match" in notes[-1]
    assert len(out) == 5  # never multiplies rows


def test_lookup_all_columns_and_name_clash(sheets, files):
    p, out, _ = run(sheets, files, "match with customers on pan")
    assert only(p).columns == ["email", "city", "amount"]
    assert "amount (customers)" in out.columns and out.amount.tolist()[0] == 100


def test_lookup_numeric_keys_match_across_types(sheets):
    codes = pd.DataFrame({"result_code": ["101", "109"], "meaning": ["Record Found", "No record"]})
    _, out, _ = run(sheets, {"codes": codes}, "bring meaning from codes on result code")
    assert out.meaning.tolist() == ["Record Found", "No record", "Record Found", "Record Found", "No record"]


def test_lookup_key_named_differently(sheets):
    ref = pd.DataFrame({"PAN Number": ["ABCDE1234F"], "score": [7]})
    p, out, _ = run(sheets, {"ref": ref}, "bring score from ref matching pan with pan number")
    assert (only(p).left_on, only(p).right_on) == ("pan", "PAN Number")
    assert out.score.tolist()[0] == 7


def test_lookup_guesses_the_only_shared_column(sheets, files):
    p, _, _ = run(sheets, files, "bring email from customers")
    assert (only(p).left_on, only(p).right_on) == ("pan", "PAN")


def test_lookup_asks_when_key_unclear(sheets):
    other = pd.DataFrame({"x": [1], "y": [2]})
    p = make_plan(sheets, "bring y from other", {"other": other})
    assert p.steps == [] and "match on" in p.clarification_question


def test_the_other_file(sheets):
    p, _, _ = run(sheets, {"customers": customers()}, "bring city from the other file on pan")
    assert only(p).file == "customers"


def test_file_name_that_is_also_a_column(sheets):
    files = {"amount": pd.DataFrame({"pan": ["ABCDE1234F"], "limit": [5]})}
    assert only(make_plan(sheets, "add column double = amount * 2", files)).op == "compute"
    assert only(make_plan(sheets, "bring limit from amount file on pan", files)).op == "lookup"


def test_commands_without_files_unaffected(sheets, files):
    assert only(make_plan(sheets, "total amount by result code", files)).op == "group_by"
    assert only(make_plan(sheets, "add column gst = amount * 0.18", files)).op == "compute"


# ---------- append ----------

def test_append_lines_up_columns(sheets, files):
    p, out, notes = run(sheets, files, "append march")
    assert only(p).op == "append"
    assert len(out) == 7
    assert out.result_code.tolist()[-2:] == [101, 101]  # "Result Code" lined up with result_code
    assert any("only in march" in n and "branch" in n for n in notes)
    assert any("Added 2 rows" in n for n in notes)


def test_add_rows_from(sheets, files):
    p, _, _ = run(sheets, files, "add the rows from march")
    assert only(p).op == "append"


# ---------- compare ----------

@pytest.mark.parametrize("cmd, keep, pans", [
    ("rows not in march on pan", "only_here", ["XYZAB9876K", "PQRST1111A", None, "LMNOP2222B"]),
    ("show rows that are also in march on pan", "both", ["ABCDE1234F"]),
])
def test_compare_keep_here(sheets, files, cmd, keep, pans):
    p, out, notes = run(sheets, files, cmd)
    assert (only(p).op, only(p).keep) == ("compare", keep)
    got = out.pan.tolist()
    assert [None if pd.isna(v) else v for v in got] == pans


def test_both_files_with_one_extra_file(sheets):
    p, out, _ = run(sheets, {"march": march()}, "rows in both files on pan")
    assert (only(p).file, only(p).keep) == ("march", "both")
    assert out.pan.tolist() == ["ABCDE1234F"]


def test_ambiguous_file_is_not_guessed(sheets, files):
    p = make_plan(sheets, "rows in both files on pan", files)
    assert p.steps == []


def test_rows_of_other_file_not_here(sheets, files):
    p, out, notes = run(sheets, files, "rows in march but not in this file on pan")
    assert only(p).keep == "only_there"
    assert out.PAN.tolist() == ["NEWPN0000Z"]


def test_compare_blank_key_is_reported(sheets, files):
    _, _, notes = run(sheets, files, "rows not in march on pan")
    assert any("blank pan" in n for n in notes)


def test_compare_guesses_key(sheets, files):
    p, _, _ = run(sheets, files, "rows missing from march")
    assert (only(p).left_on, only(p).keep) == ("pan", "only_here")


def test_compare_whole_rows_when_no_key(sheets):
    other = pd.DataFrame({"amount": [100, 300], "Result Code": [101, 999]})
    p, out, notes = run(sheets, {"other": other}, "rows also in other")
    assert only(p).left_on is None
    assert out.amount.tolist() == [100]  # 300 differs in result code
    assert "whole rows (result_code, amount)" in notes[-1]


def test_bare_compare_asks(sheets, files):
    p = make_plan(sheets, "compare with march", files)
    assert p.steps == [] and "not in march" in p.clarification_question


# ---------- through the app ----------

def xlsx(df):
    b = io.BytesIO()
    df.to_excel(b, index=False)
    return b.getvalue()


def test_app_add_file_lookup_undo_redo(client):
    c = client
    sid = c.post("/api/upload", files={"file": ("main.xlsx", xlsx(main_df()))}).json()["session_id"]
    st = c.post("/api/files", data={"session_id": sid}, files={"file": ("customers.xlsx", xlsx(customers()))}).json()
    assert st["files"][0]["name"] == "customers"
    r = c.post("/api/plan", json={"session_id": sid, "message": "bring email from customers on pan"}).json()
    assert r["notes"] and "found a match" in r["notes"][-1]
    st = c.post("/api/execute", json={"session_id": sid}).json()
    assert "email" in st["sheets"][0]["columns"]
    assert "email" not in c.post("/api/undo", json={"session_id": sid}).json()["sheets"][0]["columns"]
    assert "email" in c.post("/api/redo", json={"session_id": sid}).json()["sheets"][0]["columns"]


def test_app_unknown_file_mentions_do_not_break_planning(client):
    c = client
    sid = c.post("/api/upload", files={"file": ("main.xlsx", xlsx(main_df()))}).json()["session_id"]
    r = c.post("/api/plan", json={"session_id": sid, "message": "bring email from customers on pan"}).json()
    assert "clarification_question" in r or "error" in r


# ---------- regressions from a trial on a real 43K-row file ----------

def test_filter_before_lookup_is_kept(sheets, files):
    p, out, _ = run(sheets, files, "only result code 101 and bring email from customers on pan")
    assert [s.op for s in p.steps] == ["filter", "lookup"]
    assert len(out) == 3


def test_rows_there_but_not_here(sheets, files):
    p, out, _ = run(sheets, files, "rows in march but not here")
    assert only(p).keep == "only_there"
    assert out.PAN.tolist() == ["NEWPN0000Z"]
