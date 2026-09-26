"""The structured plan format the parser produces and the engine executes."""
from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field


class Condition(BaseModel):
    column: str
    operator: Literal[
        "equals", "not_equals", "contains", "not_contains", "in", "not_in",
        "is_empty", "not_empty", "gt", "gte", "lt", "lte",
        "within_last_days", "older_than_days",
    ]
    value: str | None = Field(
        None,
        description="Single value. Numbers/dates as strings (dates ISO yyyy-mm-dd). "
        "For within_last_days/older_than_days, the number of days.",
    )
    values: list[str] | None = Field(None, description="List of values, only for in/not_in.")


class FilterStep(BaseModel):
    op: Literal["filter"]
    conditions: list[Condition]
    match: Literal["all", "any"] = Field(description="all = AND, any = OR")


class SelectColumnsStep(BaseModel):
    op: Literal["select_columns"]
    columns: list[str] = Field(description="Columns to keep, in output order")


class DropColumnsStep(BaseModel):
    op: Literal["drop_columns"]
    columns: list[str]


class SortStep(BaseModel):
    op: Literal["sort"]
    columns: list[str]
    ascending: bool


class DedupeStep(BaseModel):
    op: Literal["dedupe"]
    columns: list[str] | None = Field(None, description="Columns that define a duplicate; null = whole row")
    keep: Literal["first", "last"]


class Aggregation(BaseModel):
    column: str
    func: Literal["count", "sum", "mean", "min", "max", "nunique"]


class GroupByStep(BaseModel):
    op: Literal["group_by"]
    columns: list[str]
    aggregations: list[Aggregation]


class SplitByStep(BaseModel):
    op: Literal["split_by"]
    column: str = Field(description="One output sheet per distinct value of this column")


class PivotStep(BaseModel):
    op: Literal["pivot"]
    rows: list[str]
    columns: list[str] = Field(description="Values of these become the column headers; may be empty")
    values: str | None = Field(None, description="Column to aggregate; None = count rows")
    func: Literal["count", "sum", "mean", "min", "max", "nunique"]
    totals: bool = True


class TopNStep(BaseModel):
    op: Literal["top_n"]
    n: int
    column: str | None = Field(None, description="None = first/last n rows in current order")
    largest: bool = Field(description="True = highest values (or first rows); False = lowest (or last rows)")
    per: list[str] | None = Field(None, description="Top n within each group")


class DatePartStep(BaseModel):
    op: Literal["date_part"]
    column: str
    part: Literal["year", "quarter", "month", "week", "weekday", "day"]
    name: str = Field(description="Name of the new column")


class CalculateStep(BaseModel):
    op: Literal["calculate"]
    kind: Literal["percent_of_total", "running_total", "rank"]
    column: str
    per: list[str] | None = Field(None, description="Calculate within each group")
    descending: bool = Field(True, description="rank only: highest value gets rank 1")
    name: str = Field(description="Name of the new column")


class CleanTextStep(BaseModel):
    op: Literal["clean_text"]
    columns: list[str] | None = Field(None, description="None = all text columns")
    action: Literal["trim", "upper", "lower", "title"]


class FillBlanksStep(BaseModel):
    op: Literal["fill_blanks"]
    columns: list[str] | None = Field(None, description="None = all columns")
    method: Literal["value", "down", "up"]
    value: str | None = Field(None, description="Only for method=value")


class DropBlankRowsStep(BaseModel):
    op: Literal["drop_blank_rows"]
    how: Literal["all", "any"] = Field(description="all = row is completely empty; any = any cell is empty")


class ReplaceStep(BaseModel):
    op: Literal["replace"]
    columns: list[str] | None = Field(None, description="None = all text columns")
    find: str
    replace: str = Field(description="Empty string removes the text; a cell left empty becomes blank")


class SplitColumnStep(BaseModel):
    op: Literal["split_column"]
    column: str
    delimiter: str
    names: list[str] = Field(description="New columns; the last one keeps any remaining text")


class MergeColumnsStep(BaseModel):
    op: Literal["merge_columns"]
    columns: list[str]
    separator: str
    name: str


class RenameStep(BaseModel):
    op: Literal["rename"]
    mapping: dict[str, str]


class ConvertStep(BaseModel):
    op: Literal["convert"]
    columns: list[str]
    to: Literal["number", "date", "text"]


class ComputeStep(BaseModel):
    op: Literal["compute"]
    name: str
    expr: str = Field(description="Restricted formula: numbers, [column], + - * / ( ), "
                                  "round(x, n), abs(x), days/weeks/months/years(start, end), today()")
    replace: bool = Field(False, description="Overwrite an existing column of the same name")


class LabelCase(BaseModel):
    when: FilterStep
    value: str


class LabelStep(BaseModel):
    op: Literal["label"]
    name: str
    cases: list[LabelCase] = Field(description="First matching case wins")
    default: str | None = Field(None, description="Value when no case matches; None = blank")
    replace: bool = False


Step = Union[
    FilterStep, SelectColumnsStep, DropColumnsStep, SortStep, DedupeStep, GroupByStep,
    SplitByStep, PivotStep, TopNStep, DatePartStep, CalculateStep,
    CleanTextStep, FillBlanksStep, DropBlankRowsStep, ReplaceStep, SplitColumnStep,
    MergeColumnsStep, RenameStep, ConvertStep, ComputeStep, LabelStep,
]


class Plan(BaseModel):
    clarification_question: str | None = Field(
        None,
        description="Set ONLY if the request is genuinely ambiguous; then leave steps empty.",
    )
    summary: str = Field(description="One or two plain-English sentences describing what will be done.")
    steps: list[Step]
