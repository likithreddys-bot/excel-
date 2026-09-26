"""Deterministic execution engine: applies typed plan steps to DataFrames.

State is a dict of sheet name -> DataFrame. Every step runs on every sheet,
so a `split_by` early in a plan makes later steps apply per sheet.
"""
from __future__ import annotations

import io
import re
import zipfile

import pandas as pd

from plan import Condition, Plan, Step

Sheets = dict[str, pd.DataFrame]


class PlanError(ValueError):
    pass


def load_file(filename: str, data: bytes) -> Sheets:
    name = filename.lower()
    if name.endswith(".csv"):
        return {"Sheet1": pd.read_csv(io.BytesIO(data))}
    if name.endswith((".xlsx", ".xlsm", ".xls")):
        return pd.read_excel(io.BytesIO(data), sheet_name=None)
    raise PlanError("Only .csv and .xlsx files are supported")


def _check_columns(df: pd.DataFrame, cols: list[str]) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise PlanError(f"Unknown column(s): {', '.join(missing)}")


def _as_number(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def _as_date(s: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(s):
        return s
    # ISO (yyyy-mm-dd) as-is; anything else is read day-first (dd/mm/yyyy).
    text = s.astype(str)
    iso = text.str.match(r"\d{4}-\d{1,2}-\d{1,2}")
    out = pd.to_datetime(text.where(iso), errors="coerce", format="mixed")
    return out.fillna(pd.to_datetime(text.where(~iso), errors="coerce", format="mixed", dayfirst=True))


def _sort_key(s: pd.Series) -> pd.Series:
    """Sort text columns that hold dates (e.g. dd/mm/yyyy) as dates, not alphabetically."""
    if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_datetime64_any_dtype(s) or isinstance(s.dtype, pd.CategoricalDtype):
        return s
    sample = s.dropna().head(200)
    if len(sample) and _as_date(sample).notna().mean() > 0.8 and not sample.astype(str).str.fullmatch(r"\s*\d+(\.\d+)?\s*").all():
        return _as_date(s)
    return s


WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def date_part(s: pd.Series, part: str) -> pd.Series:
    d = _as_date(s)
    match part:
        case "year":
            return d.dt.year.astype("Int64")
        case "quarter":
            return (d.dt.year.astype("Int64").astype(str) + "-Q" + d.dt.quarter.astype("Int64").astype(str)).where(d.notna())
        case "month":
            return d.dt.strftime("%Y-%m")
        case "week":
            return d.dt.strftime("%G-W%V")
        case "weekday":
            return pd.Series(pd.Categorical(d.dt.day_name(), categories=WEEKDAYS, ordered=True), index=s.index)
        case "day":
            return d.dt.strftime("%Y-%m-%d")
    raise PlanError(f"Unknown date part {part}")


def _blank_to_label(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Missing group keys become "(blank)" so they are kept in pivots instead of dropped."""
    for c in cols:
        if df[c].isna().any():
            df = df.assign(**{c: df[c].map(lambda v: "(blank)" if pd.isna(v) else _fmt_key(v))})
    return df


def _pivot(df: pd.DataFrame, step) -> pd.DataFrame:
    df = _blank_to_label(df, step.rows + step.columns)

    def agg(keys):
        g = df.groupby(keys, observed=True) if keys else None
        if step.values is None:
            return g.size() if g is not None else len(df)
        return g[step.values].agg(step.func) if g is not None else df[step.values].agg(step.func)

    body = agg(step.rows + step.columns)
    if step.columns:
        body = body.unstack(step.columns)
        body.columns = [" / ".join(map(_fmt_key, c)) if isinstance(c, tuple) else _fmt_key(c) for c in body.columns]
    else:
        body = body.to_frame(step.func if step.values is None else f"{step.func}_{step.values}")
    if step.func in ("count", "nunique") or step.values is None:
        body = body.fillna(0).astype("int64")  # counts are whole numbers, not 1909.0
    elif step.func == "sum":
        body = body.fillna(0)
    if step.totals:
        # Totals are computed from the data, not by adding cells, so they're right for mean/min/max too.
        if step.columns:
            body["Total"] = agg(step.rows)
            col_totals = agg(step.columns)
            col_totals.index = [" / ".join(map(_fmt_key, i)) if isinstance(i, tuple) else _fmt_key(i) for i in col_totals.index]
            total_row = {**col_totals.to_dict(), "Total": agg([])}
        else:
            total_row = {body.columns[0]: agg([])}
        body = body.reset_index()
        label = {c: "" for c in step.rows}
        label[step.rows[0]] = "Total"
        body = pd.concat([body, pd.DataFrame([{**label, **total_row}])], ignore_index=True)
        return body
    return body.reset_index()


def _calculate(df: pd.DataFrame, step) -> pd.DataFrame:
    s = df[step.column] if step.kind == "rank" else _as_number(df[step.column])
    if step.kind == "rank" and not pd.api.types.is_numeric_dtype(s):
        s = _sort_key(s)
    g = s.groupby([df[c] for c in step.per], observed=True, dropna=False) if step.per else None
    match step.kind:
        case "percent_of_total":
            total = g.transform("sum") if g is not None else s.sum()
            out = (s / total * 100).round(2)
        case "running_total":
            out = g.cumsum() if g is not None else s.cumsum()
        case "rank":
            out = (g if g is not None else s).rank(method="min", ascending=not step.descending).astype("Int64")
    return df.assign(**{step.name: out})


def _compare(s: pd.Series, op: str, value: str) -> pd.Series:
    # Numeric value -> numeric comparison; otherwise treat both sides as dates.
    try:
        v, left = float(value), _as_number(s)
    except ValueError:
        v, left = pd.to_datetime(value), _as_date(s)
    return {"gt": left > v, "gte": left >= v, "lt": left < v, "lte": left <= v}[op]


def _mask(df: pd.DataFrame, c: Condition) -> pd.Series:
    _check_columns(df, [c.column])
    s = df[c.column]
    text = s.astype(str).str.strip().str.lower()
    val = (c.value or "").strip().lower()
    vals = [v.strip().lower() for v in (c.values or [])]
    if c.operator in ("equals", "not_equals") and pd.api.types.is_numeric_dtype(s):
        eq = _as_number(s) == float(c.value)
        return eq if c.operator == "equals" else ~eq
    match c.operator:
        case "equals":
            return text == val
        case "not_equals":
            return text != val
        case "contains":
            return text.str.contains(val, regex=False)
        case "not_contains":
            return ~text.str.contains(val, regex=False)
        case "in":
            return text.isin(vals)
        case "not_in":
            return ~text.isin(vals)
        case "is_empty":
            return s.isna() | (text == "")
        case "not_empty":
            return s.notna() & (text != "")
        case "gt" | "gte" | "lt" | "lte":
            return _compare(s, c.operator, c.value or "")
        case "within_last_days":
            cutoff = pd.Timestamp.now().normalize() - pd.Timedelta(days=int(c.value))
            return _as_date(s) >= cutoff
        case "older_than_days":
            cutoff = pd.Timestamp.now().normalize() - pd.Timedelta(days=int(c.value))
            return _as_date(s) < cutoff
    raise PlanError(f"Unknown operator {c.operator}")


def _apply_step(df: pd.DataFrame, step: Step) -> Sheets | pd.DataFrame:
    match step.op:
        case "filter":
            masks = [_mask(df, c) for c in step.conditions]
            combined = masks[0]
            for m in masks[1:]:
                combined = (combined & m) if step.match == "all" else (combined | m)
            return df[combined.fillna(False)]
        case "select_columns":
            _check_columns(df, step.columns)
            return df[step.columns]
        case "drop_columns":
            _check_columns(df, step.columns)
            return df.drop(columns=step.columns)
        case "sort":
            _check_columns(df, step.columns)
            return df.sort_values(step.columns, ascending=step.ascending, key=_sort_key)
        case "dedupe":
            _check_columns(df, step.columns or [])
            return df.drop_duplicates(subset=step.columns or None, keep=step.keep)
        case "group_by":
            _check_columns(df, step.columns + [a.column for a in step.aggregations])
            agg = {f"{a.func}_{a.column}": (a.column, a.func) for a in step.aggregations}
            return df.groupby(step.columns, dropna=False, observed=True).agg(**agg).reset_index()
        case "split_by":
            _check_columns(df, [step.column])
            groups = df.groupby(df[step.column], sort=True, dropna=False, observed=True)
            return {"(blank)" if pd.isna(key) else _fmt_key(key): part for key, part in groups}
        case "pivot":
            _check_columns(df, step.rows + step.columns + ([step.values] if step.values else []))
            return _pivot(df, step)
        case "top_n":
            _check_columns(df, ([step.column] if step.column else []) + (step.per or []))
            if step.column is None:
                return df.head(step.n) if step.largest else df.tail(step.n)
            ranked = df.sort_values(step.column, ascending=not step.largest, key=_sort_key, na_position="last")
            if step.per:
                return ranked.groupby(step.per, observed=True, dropna=False).head(step.n)
            return ranked.head(step.n)
        case "date_part":
            _check_columns(df, [step.column])
            return df.assign(**{step.name: date_part(df[step.column], step.part)})
        case "calculate":
            _check_columns(df, [step.column] + (step.per or []))
            return _calculate(df, step)
        case "clean_text":
            cols = step.columns or text_columns(df)
            _check_columns(df, cols)
            return df.assign(**{c: _clean_text(df[c], step.action) for c in cols})
        case "fill_blanks":
            cols = step.columns or list(df.columns)
            _check_columns(df, cols)
            return df.assign(**{c: _fill(df[c], step) for c in cols})
        case "drop_blank_rows":
            blank = pd.DataFrame({c: _is_blank(df[c]) for c in df.columns})
            return df[~(blank.all(axis=1) if step.how == "all" else blank.any(axis=1))]
        case "replace":
            cols = step.columns or text_columns(df)
            _check_columns(df, cols)
            return df.assign(**{c: _replace(df[c], step.find, step.replace) for c in cols})
        case "split_column":
            _check_columns(df, [step.column])
            text = df[step.column].astype("string")
            parts = text.str.split(step.delimiter, n=len(step.names) - 1, expand=True, regex=False)
            parts = parts.reindex(columns=range(len(step.names))).apply(lambda s: s.str.strip())
            parts.columns = step.names
            return _insert_after(df, step.column, parts)
        case "merge_columns":
            _check_columns(df, step.columns)
            cells = df[step.columns].astype("string").apply(lambda s: s.str.strip())
            merged = cells.apply(lambda r: step.separator.join(v for v in r if pd.notna(v) and v != ""), axis=1)
            return _insert_after(df, step.columns[-1], pd.DataFrame({step.name: merged.replace("", pd.NA)}))
        case "rename":
            _check_columns(df, list(step.mapping))
            clash = [n for n in step.mapping.values() if n in df.columns and n not in step.mapping]
            if clash:
                raise PlanError(f"There is already a column called {', '.join(clash)}")
            return df.rename(columns=step.mapping)
        case "convert":
            _check_columns(df, step.columns)
            return df.assign(**{c: _convert(df[c], c, step.to) for c in step.columns})
    raise PlanError(f"Unknown step {step.op}")


def text_columns(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns if pd.api.types.is_object_dtype(df[c]) or pd.api.types.is_string_dtype(df[c])]


def _is_blank(s: pd.Series) -> pd.Series:
    return s.isna() | s.astype("string").str.strip().eq("").fillna(False)


def _clean_text(s: pd.Series, action: str) -> pd.Series:
    t = s.astype("string")
    match action:
        case "trim":
            t = t.str.strip().str.replace(r"\s+", " ", regex=True)
            t = t.mask(t.eq(""))  # a cell of only spaces is blank
        case "upper":
            t = t.str.upper()
        case "lower":
            t = t.str.lower()
        case "title":
            t = t.str.title()
    return t.where(s.notna(), pd.NA).astype(object)


def _fill(s: pd.Series, step) -> pd.Series:
    s = s.mask(_is_blank(s))
    if step.method == "down":
        return s.ffill()
    if step.method == "up":
        return s.bfill()
    value = step.value
    if pd.api.types.is_numeric_dtype(s):
        try:
            value = float(value)
        except ValueError:
            s = s.astype(object)  # e.g. "N/A" into a number column
    return s.fillna(value)


def _replace(s: pd.Series, find: str, repl: str) -> pd.Series:
    if pd.api.types.is_numeric_dtype(s):
        # Numbers match as whole values: "replace 0 with blank" must not turn 10 into 1.
        try:
            target = float(find)
        except ValueError:
            return s
        new = pd.NA if not repl.strip() else repl
        try:
            new = float(repl)
        except ValueError:
            pass
        return (s if isinstance(new, float) else s.astype(object)).mask(s == target, new)
    t = s.astype("string").str.replace(re.escape(find), lambda m: repl, case=False, regex=True)
    t = t.mask(t.str.strip().eq(""))  # a cell that became empty is blank
    return t.where(s.notna(), pd.NA).astype(object)


def _insert_after(df: pd.DataFrame, after: str, new: pd.DataFrame) -> pd.DataFrame:
    clash = [c for c in new.columns if c in df.columns]
    if clash:
        raise PlanError(f"There is already a column called {', '.join(clash)}")
    pos = list(df.columns).index(after) + 1
    return pd.concat([df.iloc[:, :pos], new.set_axis(df.index), df.iloc[:, pos:]], axis=1)


def _convert(s: pd.Series, name: str, to: str) -> pd.Series:
    if to == "text":
        return s.map(lambda v: v if pd.isna(v) else _fmt_key(v)).astype(object)
    if to == "number":
        # "Rs." must go together with its dot, or "Rs. 90" would become ".90".
        cleaned = s.astype("string").str.replace(r"(?<![a-z])(?:rs|inr)\.?|[₹$€£,\s]", "", regex=True, case=False)
        out = pd.to_numeric(cleaned, errors="coerce")
    else:
        out = _as_date(s)
    bad = s[out.isna() & ~_is_blank(s)]
    if len(bad):
        examples = ", ".join(repr(str(v)) for v in bad.unique()[:3])
        raise PlanError(f"{len(bad):,} value(s) in '{name}' can't be read as a {to}, e.g. {examples}. "
                        f"Fix or remove those first (e.g. replace {examples.split(',')[0]} with blank).")
    return out


def _fmt_key(key) -> str:
    return str(int(key)) if isinstance(key, float) and key.is_integer() else str(key)


def _sheet_name(parent: str, key: str, total_parents: int) -> str:
    # Excel sheet names: max 31 chars, no []:*?/\
    name = key if total_parents == 1 else f"{parent}-{key}"
    for ch in "[]:*?/\\":
        name = name.replace(ch, "_")
    return name[:31] or "blank"


def apply_plan(sheets: Sheets, plan: Plan) -> Sheets:
    for step in plan.steps:
        out: Sheets = {}
        for name, df in sheets.items():
            result = _apply_step(df, step)
            if isinstance(result, dict):
                for key, part in result.items():
                    out[_sheet_name(name, key, len(sheets))] = part
            else:
                out[name] = result
        sheets = out
    return sheets


def row_counts(sheets: Sheets) -> dict[str, int]:
    return {name: len(df) for name, df in sheets.items()}


def to_xlsx(sheets: Sheets) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        for name, df in sheets.items():
            # Dates without a time of day are written as plain dates, not "2024-01-01 00:00:00".
            for c in df.columns:
                s = df[c]
                if pd.api.types.is_datetime64_any_dtype(s) and (s.dropna() == s.dropna().dt.normalize()).all():
                    df = df.assign(**{c: s.dt.date})
            df.to_excel(writer, sheet_name=name, index=False)
    return buf.getvalue()


def to_csv(sheets: Sheets) -> tuple[bytes, str]:
    """Single sheet -> .csv; multiple sheets -> .zip of CSVs."""
    if len(sheets) == 1:
        return next(iter(sheets.values())).to_csv(index=False).encode(), "csv"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, df in sheets.items():
            z.writestr(f"{name}.csv", df.to_csv(index=False))
    return buf.getvalue(), "zip"
