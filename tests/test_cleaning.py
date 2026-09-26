"""Phase 2 cleaning: trim, case, fill blanks, blank rows, find & replace, text to columns,
merge, rename, change type."""
import pandas as pd
import pytest

import engine
from planner import make_plan


def messy() -> pd.DataFrame:
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


@pytest.fixture
def sheets():
    return {"Sheet1": messy()}


def run(sheets, cmd):
    p = make_plan(sheets, cmd)
    assert p.clarification_question is None, f"{cmd!r} -> asked: {p.clarification_question}"
    return p, engine.apply_plan(sheets, p)["Sheet1"]


def only(p):
    (step,) = p.steps
    return step


def asks(sheets, cmd, text):
    p = make_plan(sheets, cmd)
    assert p.steps == [] and text.lower() in p.clarification_question.lower(), p.clarification_question


# ---------- trim / case ----------

def test_trim_all_text(sheets):
    p, out = run(sheets, "trim spaces")
    assert (only(p).op, only(p).action, only(p).columns) == ("clean_text", "trim", None)
    assert out.name.tolist()[:2] == ["Asha Rao", "vikram SINGH"]
    assert pd.isna(out.name[3])  # a cell of only spaces becomes blank
    assert out.score.equals(sheets["Sheet1"].score)  # number columns untouched


@pytest.mark.parametrize("cmd", ["trim name", "remove extra spaces from name", "trim the name column"])
def test_trim_one_column(sheets, cmd):
    p, _ = run(sheets, cmd)
    assert only(p).columns == ["name"]


@pytest.mark.parametrize("cmd, action, expected", [
    ("make city title case", "title", ["Pune", "Mumbai "]),
    ("capitalize city", "title", ["Pune", "Mumbai "]),
    ("convert city to uppercase", "upper", ["PUNE", "MUMBAI "]),
    ("lowercase city", "lower", ["pune", "mumbai "]),
    ("city in proper case", "title", ["Pune", "Mumbai "]),
])
def test_case(sheets, cmd, action, expected):
    p, out = run(sheets, cmd)
    assert (only(p).action, only(p).columns) == (action, ["city"])
    assert out.city.tolist()[:2] == expected


def test_case_on_number_column_asks(sheets):
    asks(sheets, "make score uppercase", "numbers")


# ---------- blanks ----------

def test_fill_blank_with_value(sheets):
    p, out = run(sheets, "fill blank city with Unknown")
    assert (only(p).method, only(p).value, only(p).columns) == ("value", "Unknown", ["city"])
    assert out.city.tolist() == ["pune", "MUMBAI ", "Pune", "Unknown", "Unknown", "delhi"]


def test_fill_quoted_value_keeps_case(sheets):
    p, _ = run(sheets, "fill empty values in city with 'Not Known'")
    assert only(p).value == "Not Known"


def test_fill_down(sheets):
    p, out = run(sheets, "fill down city")
    assert only(p).method == "down"
    assert out.city.tolist() == ["pune", "MUMBAI ", "Pune", "Pune", "Pune", "delhi"]


def test_fill_blanks_everywhere_with_zero(sheets):
    p, out = run(sheets, "fill blanks with 0")
    assert only(p).columns is None
    assert out.score[3] == 0 and out.city[3] == "0"


def test_replace_blanks_means_fill(sheets):
    p, _ = run(sheets, "replace blanks in state with NA")
    assert (only(p).op, only(p).value, only(p).columns) == ("fill_blanks", "NA", ["state"])


def test_fill_without_value_asks(sheets):
    asks(sheets, "fill blank city", "with what")


def test_remove_blank_rows(sheets):
    p, out = run(sheets, "remove blank rows")
    assert (only(p).op, only(p).how) == ("drop_blank_rows", "all")
    assert out.index.tolist() == [0, 1, 2, 4, 5]  # row 3 is only spaces and blanks


def test_remove_rows_with_any_blank(sheets):
    p, out = run(sheets, "remove rows with any blank values")
    assert only(p).how == "any"
    assert out.index.tolist() == [0, 1, 5]


def test_blank_filter_on_one_column_still_a_filter(sheets):
    p, _ = run(sheets, "remove rows where city is empty")
    assert only(p).op == "filter"


# ---------- find & replace ----------

@pytest.mark.parametrize("cmd", [
    'replace "UPI/" with "" in description',
    'remove "UPI/" from description',
    "replace 'UPI/' with nothing in description",
])
def test_remove_text(sheets, cmd):
    p, out = run(sheets, cmd)
    assert (only(p).op, only(p).find, only(p).replace, only(p).columns) == ("replace", "UPI/", "", ["description"])
    assert out.description.tolist()[:2] == ["SWIGGY", "ZOMATO"]


def test_replace_case_insensitive(sheets):
    _, out = run(sheets, "replace pune with Pune in city")
    assert out.city.tolist()[:3] == ["Pune", "MUMBAI ", "Pune"]


def test_replace_whole_cell_with_blank(sheets):
    p, out = run(sheets, "replace N/A with blank")
    assert only(p).columns is None
    assert pd.isna(out.description[2])


def test_replace_in_number_column_matches_whole_values(sheets):
    _, out = run(sheets, "replace 0 with blank in score")
    assert out.score.tolist()[:3] == [10.0, None, 5.0] or (out.score[0] == 10 and pd.isna(out.score[1]))


def test_replace_order_variant(sheets):
    p, _ = run(sheets, "replace mh in state with Maharashtra")
    assert (only(p).find, only(p).replace, only(p).columns) == ("mh", "Maharashtra", ["state"])


def test_replace_quoted_text_with_dot_and_comma(sheets):
    p, _ = run(sheets, 'replace "Rs. " with "INR, " in amt')
    assert (only(p).find, only(p).replace) == ("Rs. ", "INR, ")


# ---------- text to columns / merge ----------

def test_split_name_into_first_and_last(sheets):
    trimmed = engine.apply_plan(sheets, make_plan(sheets, "trim name"))
    p, out = run(trimmed, "split name into first and last")
    step = only(p)
    assert (step.op, step.column, step.delimiter, step.names) == ("split_column", "name", " ", ["first", "last"])
    assert list(out.columns[:3]) == ["name", "first", "last"]  # original kept, new ones next to it
    assert out.loc[5, ["first", "last"]].tolist() == ["Ravi", "Kumar Das"]  # the rest stays in the last column


def test_split_email_on_at(sheets):
    p, out = run(sheets, "split email on @ into user and domain")
    assert only(p).delimiter == "@"
    assert out.loc[0, ["user", "domain"]].tolist() == ["asha", "x.com"]


def test_split_by_word_delimiter_default_names(sheets):
    p, out = run(sheets, "split description by slash")
    assert (only(p).delimiter, only(p).names) == ("/", ["description 1", "description 2"])
    assert out.loc[0, "description 2"] == "SWIGGY"


def test_split_by_column_is_still_sheets(sheets):
    p = make_plan(sheets, "split by state")
    assert only(p).op == "split_by"


def test_merge_columns(sheets):
    p, out = run(sheets, 'combine city and state with ", " into location')
    step = only(p)
    assert (step.op, step.columns, step.separator, step.name) == ("merge_columns", ["city", "state"], ", ", "location")
    assert out.location.tolist()[:3] == ["pune, MH", "MUMBAI, MH", "Pune, MH"]
    assert pd.isna(out.location[3])  # both blank -> blank, not ", "


def test_merge_default_space_separator(sheets):
    p, _ = run(sheets, "merge city and state into place")
    assert only(p).separator == " "


# ---------- rename / convert ----------

def test_rename(sheets):
    p, out = run(sheets, "rename amt to amount")
    assert only(p).mapping == {"amt": "amount"}
    assert "amount" in out.columns and "amt" not in out.columns


def test_rename_several(sheets):
    p, _ = run(sheets, "rename city to City Name and amt to Amount")
    assert only(p).mapping == {"city": "City Name", "amt": "Amount"}


def test_rename_unknown_column_asks(sheets):
    asks(sheets, "rename colour to color", "couldn't find")


def test_convert_to_number(sheets):
    p, out = run(sheets, "convert amt to number")
    assert (only(p).op, only(p).to) == ("convert", "number")
    assert out.amt.tolist()[:3] == [1200.0, 90.0, 3400.5]
    assert out.amt[5] == 500000.0


def test_convert_to_date(sheets):
    _, out = run(sheets, "change txn date to date")
    assert out["txn date"].tolist()[:2] == [pd.Timestamp("2025-03-01"), pd.Timestamp("2025-04-02")]


def test_convert_to_text(sheets):
    p, out = run(sheets, "make score text")
    assert only(p).to == "text"
    assert out.score[0] == "10"


def test_convert_refuses_to_blank_out_bad_values(sheets):
    p = make_plan(sheets, "convert city to number")
    with pytest.raises(engine.PlanError, match="can't be read as a number"):
        engine.apply_plan(sheets, p)


# ---------- combined ----------

def test_cleaning_chain(sheets):
    p, out = run(sheets, "trim spaces, make city title case and fill blank city with Unknown")
    assert [s.op for s in p.steps] == ["clean_text", "clean_text", "fill_blanks"]
    assert out.city.tolist() == ["Pune", "Mumbai", "Pune", "Unknown", "Unknown", "Delhi"]


def test_earlier_commands_unaffected(sheets):
    assert only(make_plan(sheets, "remove duplicates by email")).op == "dedupe"
    assert only(make_plan(sheets, "remove rows where description contains ATM")).op == "filter"
    assert only(make_plan(sheets, "drop the score column")).op == "drop_columns"
    assert only(make_plan(sheets, "sort by city")).op == "sort"


def test_get_rid_of_quoted_text(sheets):
    p, _ = run(sheets, "get rid of 'UPI/' in description")
    assert (only(p).op, only(p).find, only(p).columns) == ("replace", "UPI/", ["description"])
