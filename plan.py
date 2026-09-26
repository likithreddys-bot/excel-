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


Step = Union[
    FilterStep, SelectColumnsStep, DropColumnsStep, SortStep, DedupeStep, GroupByStep,
    SplitByStep, PivotStep, TopNStep, DatePartStep, CalculateStep,
]


class Plan(BaseModel):
    clarification_question: str | None = Field(
        None,
        description="Set ONLY if the request is genuinely ambiguous; then leave steps empty.",
    )
    summary: str = Field(description="One or two plain-English sentences describing what will be done.")
    steps: list[Step]
