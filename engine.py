"""Deterministic execution engine: applies typed plan steps to DataFrames.

State is a dict of sheet name -> DataFrame. Every step runs on every sheet,
so a `split_by` early in a plan makes later steps apply per sheet.
"""
from __future__ import annotations

import io
import re
import zipfile

import pandas as pd

import xlsxwriter

from plan import FORMAT_OPS, Condition, Plan, Step

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
    # ISO (yyyy-mm-dd) as-is; anything else is read day-first (dd/mm/yyyy). The common fixed layouts are
    # parsed in one go (fast on 700K+ rows); only values they miss are parsed one by one.
    text = s.astype(str)
    iso = text.str.match(r"\d{4}-\d{1,2}-\d{1,2}")
    out = pd.to_datetime(text.where(iso), errors="coerce", format="ISO8601")
    out = out.fillna(pd.to_datetime(text.where(~iso), errors="coerce", format="%d/%m/%Y"))
    rest = out.isna() & s.notna() & text.str.strip().ne("")
    if rest.any():
        slow = text[rest]
        slow_iso = iso[rest]
        out[rest] = pd.to_datetime(slow.where(slow_iso), errors="coerce", format="mixed").fillna(
            pd.to_datetime(slow.where(~slow_iso), errors="coerce", format="mixed", dayfirst=True))
    return out


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
            return _format_dates(d, "%Y-%m")
        case "week":
            return _format_dates(d, "%G-W%V")
        case "weekday":
            return pd.Series(pd.Categorical(d.dt.day_name(), categories=WEEKDAYS, ordered=True), index=s.index)
        case "day":
            return _format_dates(d, "%Y-%m-%d")
    raise PlanError(f"Unknown date part {part}")


def _format_dates(d: pd.Series, fmt: str) -> pd.Series:
    """strftime on each distinct day only: 740K rows usually hold a few hundred distinct dates."""
    codes, days = pd.factorize(d.dt.normalize())
    text = pd.DatetimeIndex(days).strftime(fmt).to_numpy(dtype=object)
    return pd.Series([text[c] if c >= 0 else None for c in codes], index=d.index, dtype=object)


def _blank_to_label(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Missing group keys become "(blank)" so they are kept in pivots instead of dropped."""
    for c in cols:
        if df[c].isna().any():
            df = df.assign(**{c: df[c].map(lambda v: "(blank)" if pd.isna(v) else _fmt_key(v))})
    return df


def calculated_totals(df: pd.DataFrame, keys: list[str], calculated: dict[str, str]) -> pd.DataFrame:
    """Each formula worked out on each group's totals, like an Excel pivot calculated field:
    "[b0_amt] * 100 / [alloc_amt]" gives total b0_amt * 100 / total alloc_amt per group - not an
    average of the row-level percentages, which would weigh a small loan the same as a big one."""
    refs = sorted({r for expr in calculated.values() for r in re.findall(r"\[([^\]]+)\]", expr)})
    _check_columns(df, keys + refs)
    numbers = pd.DataFrame({r: _num(df[r]) for r in refs}, index=df.index)
    if keys:
        sums = numbers.groupby([df[k] for k in keys], dropna=False, observed=True).sum(min_count=1)
    else:
        sums = numbers.sum(min_count=1).to_frame().T
    return pd.DataFrame({name: evaluate(sums, expr) for name, expr in calculated.items()}, index=sums.index)


def _pivot(df: pd.DataFrame, step) -> pd.DataFrame:
    df = _blank_to_label(df, step.rows + step.columns)
    if step.calculated:
        body = calculated_totals(df, step.rows, step.calculated).reset_index()
        if step.totals:
            total = calculated_totals(df, [], step.calculated)
            label = {c: "" for c in step.rows}
            label[step.rows[0]] = "Total"
            body = pd.concat([body, total.assign(**label)[body.columns]], ignore_index=True)
        return body

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
            return df[_filter_mask(df, step)]
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
            grouped = df.groupby(step.columns, dropna=False, observed=True)
            out = grouped.agg(**agg) if agg else None
            for a in step.aggregations:
                if a.func == "count" and a.column in step.columns:
                    out[f"count_{a.column}"] = grouped.size()  # counting rows: a blank group must not count as 0
            if step.calculated:
                calc = calculated_totals(df, step.columns, step.calculated)
                out = calc if out is None else out.join(calc)
            return out.reset_index()
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
        case "compute":
            _check_new_column(df, step.name, step.replace)
            return df.assign(**{step.name: evaluate(df, step.expr)})
        case "label":
            _check_new_column(df, step.name, step.replace)
            masks = [_filter_mask(df, case.when) for case in step.cases]
            values = [case.value for case in step.cases] + ([step.default] if step.default is not None else [])
            # Overwriting a column with no "else": rows that match no rule keep their current value.
            keep = step.replace and step.default is None
            numeric = all(re.fullmatch(r"-?\d+(\.\d+)?", v) for v in values) and (
                not keep or pd.api.types.is_numeric_dtype(df[step.name]))
            out = df[step.name].astype(object).copy() if keep else pd.Series(pd.NA, index=df.index, dtype=object)
            if step.default is not None:
                out[:] = float(step.default) if numeric else step.default
            for mask, case in reversed(list(zip(masks, step.cases))):  # first matching case wins
                out[mask] = float(case.value) if numeric else case.value
            return df.assign(**{step.name: pd.to_numeric(out) if numeric else out})
    raise PlanError(f"Unknown step {step.op}")


def _filter_mask(df: pd.DataFrame, step) -> pd.Series:
    masks = [_mask(df, c) for c in step.conditions]
    combined = masks[0]
    for m in masks[1:]:
        combined = (combined & m) if step.match == "all" else (combined | m)
    return combined.fillna(False).astype(bool)


def _check_new_column(df: pd.DataFrame, name: str, replace: bool) -> None:
    if name in df.columns and not replace:
        raise PlanError(f"There is already a column called {name}. Use 'set {name} = ...' to overwrite it.")


# ---------- restricted formulas: numbers, [column], + - * / ( ), and a few functions ----------

_TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|\[(?P<col>[^\]]+)\]|(?P<fn>[a-z_]+)(?=\s*\()|(?P<op>[-+*/(),]))")
_FUNCS = {"round", "abs", "days", "weeks", "months", "years", "today"}


def evaluate(df: pd.DataFrame, expr: str) -> pd.Series:
    tokens, pos = [], 0
    while expr[pos:].strip():
        m = _TOKEN.match(expr, pos)
        if not m:
            raise PlanError(f"Can't read the formula near '{expr[pos:].strip()}'")
        tokens.append((m.lastgroup, m.group(m.lastgroup)))
        pos = m.end()
    ev = _Evaluator(df, tokens)
    out = ev.expr()
    if ev.i != len(tokens):
        raise PlanError(f"Can't read the formula near '{tokens[ev.i][1]}'")
    if not isinstance(out, pd.Series):
        out = pd.Series(out, index=df.index)
    if pd.api.types.is_float_dtype(out):
        out = out.replace([float("inf"), float("-inf")], float("nan")).round(10)  # x/0 -> blank; 0.1*3 -> 0.3
    return out


class _Evaluator:
    """Recursive-descent evaluator over pandas Series. Only the grammar below can run."""

    def __init__(self, df: pd.DataFrame, tokens: list[tuple[str, str]]):
        self.df, self.tokens, self.i = df, tokens, 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self, value=None):
        kind, v = self.peek()
        if kind is None or (value is not None and v != value):
            raise PlanError(f"Formula expected '{value or 'a value'}'")
        self.i += 1
        return kind, v

    def expr(self):
        left = self.term()
        while self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            right = self.term()
            left = _num(left) + _num(right) if op == "+" else _num(left) - _num(right)
        return left

    def term(self):
        left = self.factor()
        while self.peek()[1] in ("*", "/"):
            op = self.take()[1]
            right = self.factor()
            left = _num(left) * _num(right) if op == "*" else _num(left) / _num(right)
        return left

    def factor(self):
        kind, v = self.take()
        if kind == "num":
            return float(v)
        if kind == "col":
            _check_columns(self.df, [v])
            return self.df[v]
        if v == "-":
            return -_num(self.factor())
        if v == "(":
            out = self.expr()
            self.take(")")
            return out
        if kind == "fn" and v in _FUNCS:
            self.take("(")
            args = []
            while self.peek()[1] != ")":
                args.append(self.expr())
                if self.peek()[1] == ",":
                    self.take(",")
            self.take(")")
            return _call(v, args, self.df.index)
        raise PlanError(f"Unexpected '{v}' in formula")


def _num(x):
    if not isinstance(x, pd.Series) or pd.api.types.is_numeric_dtype(x):
        return x
    out = pd.to_numeric(x, errors="coerce")
    bad = x[out.isna() & ~_is_blank(x)]
    if len(bad):
        name = x.name or "a column"
        raise PlanError(f"{name} has text like {str(bad.iloc[0])!r}, so it can't be used in a calculation. "
                        f"Convert it first: convert {name} to number")
    return out


def _date_arg(a, index) -> pd.Series:
    if isinstance(a, pd.Series):
        return a if pd.api.types.is_datetime64_any_dtype(a) else _as_date(a)
    return pd.Series(a, index=index)  # today()


def _call(fn: str, args: list, index) -> pd.Series | float | pd.Timestamp:
    if fn == "today":
        return pd.Timestamp.today().normalize()
    if fn == "round":
        x, n = _num(args[0]), int(args[1]) if len(args) > 1 else 0
        return x.round(n) if isinstance(x, pd.Series) else round(x, n)
    if fn == "abs":
        return abs(_num(args[0]))
    if len(args) != 2:
        raise PlanError(f"{fn}() needs a start and an end date")
    start, end = (_date_arg(a, index) for a in args)
    days = (end - start).dt.days
    if fn == "days":
        return days
    if fn == "weeks":
        return days // 7
    months = (end.dt.year - start.dt.year) * 12 + (end.dt.month - start.dt.month) - (end.dt.day < start.dt.day)
    return months if fn == "months" else months // 12


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


def apply_plan(sheets: Sheets, plan: Plan, files: dict[str, pd.DataFrame] | None = None,
               notes: list[str] | None = None) -> Sheets:
    """`files` are other uploaded tables (for lookup/append/compare); `notes` collects things the
    user should know about the result, e.g. how many rows found a lookup match."""
    for step in plan.steps:
        out: Sheets = {}
        for name, df in sheets.items():
            if step.op in ("lookup", "append", "compare") or step.op in FORMAT_OPS:
                sheet_notes: list[str] = []
                if step.op in FORMAT_OPS:
                    result = _check_format(df, step, sheet_notes)  # data unchanged; applied in to_xlsx
                else:
                    result = _apply_file_step(df, step, files or {}, sheet_notes)
                if notes is not None:
                    notes += [f"{name}: {n}" if len(sheets) > 1 else n for n in sheet_notes]
            else:
                result = _apply_step(df, step)
            if isinstance(result, dict):
                for key, part in result.items():
                    out[_sheet_name(name, key, len(sheets))] = part
            else:
                out[name] = result
        sheets = out
    return sheets


# ---------- working with another file: lookup, append, compare ----------

def match_key(s: pd.Series) -> pd.Series:
    """Values as they should match across files: 101 == 101.0 == " 101 ", and case is ignored."""
    return s.map(lambda v: pd.NA if pd.isna(v) or str(v).strip() == "" else _fmt_key(v).strip().lower())


def _col_key(c) -> str:
    """Column names line up across files ignoring case, spaces and underscores: "PAN" == "pan", "Txn Date" == "txn_date"."""
    return re.sub(r"[^a-z0-9]", "", str(c).lower())


def _other(files: dict[str, pd.DataFrame], name: str) -> pd.DataFrame:
    if name not in files:
        raise PlanError(f"The file '{name}' isn't loaded. Add it with 'Add lookup file' first.")
    return files[name]


def _apply_file_step(df: pd.DataFrame, step, files: dict[str, pd.DataFrame], notes: list[str]) -> pd.DataFrame:
    other = _other(files, step.file)
    match step.op:
        case "lookup":
            _check_columns(df, [step.left_on])
            _check_columns(other, [step.right_on] + step.columns)
            rk = match_key(other[step.right_on])
            dup = rk.duplicated() & rk.notna()
            if dup.any():
                notes.append(f"{step.file} has {dup.sum():,} repeated {step.right_on} value(s); the first match was used "
                             f"(like VLOOKUP).")
            table = other[~dup & rk.notna()].set_axis(rk[~dup & rk.notna()])
            lk = match_key(df[step.left_on])
            found = lk.isin(table.index)
            new = {}
            for c in step.columns:
                name = c if c not in df.columns and c not in new else f"{c} ({step.file})"
                new[name] = lk.map(table[c])
            missing = (~found).sum()
            notes.append(f"{found.sum():,} of {len(df):,} rows found a match in {step.file}"
                         + (f"; {missing:,} had no match (left blank)." if missing else "."))
            return df.assign(**new)
        case "append":
            by_key = {_col_key(c): c for c in df.columns}
            renamed = other.rename(columns=lambda c: by_key.get(_col_key(c), c))
            only_there = [c for c in renamed.columns if c not in df.columns]
            only_here = [c for c in df.columns if c not in renamed.columns]
            if only_there:
                notes.append(f"Columns only in {step.file} (added, blank for existing rows): {', '.join(map(str, only_there))}.")
            if only_here:
                notes.append(f"Columns missing from {step.file} (blank for its rows): {', '.join(map(str, only_here))}.")
            notes.append(f"Added {len(other):,} rows from {step.file}.")
            return pd.concat([df, renamed], ignore_index=True)
        case "compare":
            if step.left_on:
                _check_columns(df, [step.left_on])
                _check_columns(other, [step.right_on])
                lk, rk = match_key(df[step.left_on]), match_key(other[step.right_on])
                what = f"{step.left_on}"
            else:
                theirs = {_col_key(c): c for c in other.columns}
                pairs = [(c, theirs[_col_key(c)]) for c in df.columns if _col_key(c) in theirs]
                if not pairs:
                    raise PlanError(f"This data and {step.file} have no columns in common. Say which column to compare on.")
                lk = pd.concat([match_key(df[a]).fillna("") for a, _ in pairs], axis=1).agg("\x1f".join, axis=1)
                rk = pd.concat([match_key(other[b]).fillna("") for _, b in pairs], axis=1).agg("\x1f".join, axis=1)
                what = f"whole rows ({', '.join(str(a) for a, _ in pairs)})"
            blank = lk.isna().sum()
            if blank:
                notes.append(f"{blank:,} row(s) have a blank {step.left_on} and can't match anything.")
            if step.keep == "only_there":
                out = other[~rk.isin(set(lk.dropna()))]
                notes.append(f"{len(out):,} row(s) of {step.file} are not in this data (compared by {what}).")
                return out
            in_other = lk.isin(set(rk.dropna()))
            out = df[in_other] if step.keep == "both" else df[~in_other]
            where = f"also in {step.file}" if step.keep == "both" else f"not in {step.file}"
            notes.append(f"{len(out):,} of {len(df):,} rows are {where} (compared by {what}).")
            return out
    raise PlanError(f"Unknown step {step.op}")


def row_counts(sheets: Sheets) -> dict[str, int]:
    return {name: len(df) for name, df in sheets.items()}


# ---------- formatting: highlights, number formats, charts (Excel download only) ----------

NUMBER_FORMATS = {
    # Indian grouping: 12,34,56,789.00
    "rupees": '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00',
    "commas": "#,##0.00",
    "percent": '0.00"%"',  # values like 15.79 are already percentages
}


def highlight_mask(df: pd.DataFrame, step) -> pd.Series:
    if step.duplicates_in:
        s = match_key(df[step.duplicates_in])
        return s.duplicated(keep=False) & s.notna()
    return _filter_mask(df, step.when)


def _format_columns(step) -> list[str]:
    match step.op:
        case "highlight":
            return ([c.column for c in step.when.conditions] if step.when else []) + \
                   [c for c in (step.duplicates_in, step.column) if c]
        case "number_format":
            return step.columns or []
        case "chart":
            return [step.x] + ([step.y] if step.y else []) + ([c.column for c in step.when.conditions] if step.when else [])
    return []


def _check_format(df: pd.DataFrame, step, notes: list[str]) -> pd.DataFrame:
    _check_columns(df, _format_columns(step))
    if step.op == "highlight":
        notes.append(f"{highlight_mask(df, step).sum():,} of {len(df):,} rows will be highlighted.")
    if step.op == "number_format" and step.style == "date":
        text = [c for c in (step.columns or []) if not pd.api.types.is_datetime64_any_dtype(df[c])]
        if text:
            raise PlanError(f"{', '.join(text)} isn't stored as dates. Convert it first: convert {text[0]} to date")
    if step.op == "number_format" and step.style != "date":
        text = [c for c in (step.columns or []) if not pd.api.types.is_numeric_dtype(df[c])]
        if text:
            raise PlanError(f"{', '.join(text)} holds text, so a number format won't show. Convert it first: "
                            f"convert {text[0]} to number")
    if step.op == "chart":
        n = chart_data(df, step).shape[0]
        if n > 50:
            raise PlanError(f"That chart would have {n:,} bars/points. Chart by a column with fewer values.")
    notes.append("Formatting and charts appear in the Excel download (not CSV).")
    return df


def chart_data(df: pd.DataFrame, step) -> pd.DataFrame:
    if step.when:
        df = df[_filter_mask(df, step.when)]
    x = date_part(df[step.x], step.x_part) if step.x_part else df[step.x]
    label = step.x_part or step.x
    g = pd.Series(1, index=df.index) if step.y is None else _num(df[step.y])
    out = g.groupby(x.rename(label), observed=True).agg("count" if step.y is None else step.func)
    name = "count" if step.y is None else f"{step.func} of {step.y}"
    return out.rename(name).reset_index()


def preview_styles(df: pd.DataFrame, formats: list, rows: int) -> list[dict]:
    """Highlight colours for the on-screen preview: per row, {"row": colour, "cells": {column: colour}}."""
    styles = [{"row": None, "cells": {}} for _ in range(min(rows, len(df)))]
    for step in formats:
        if step.op != "highlight" or any(c not in df.columns for c in _format_columns(step)):
            continue
        for i, hit in enumerate(highlight_mask(df, step).head(rows)):
            if hit and step.column:
                styles[i]["cells"][str(step.column)] = step.color
            elif hit:
                styles[i]["row"] = step.color
    return styles


def _number_format(step) -> str:
    if step.style == "date":
        return step.date_pattern
    if step.style == "decimals":
        return "#,##0" + ("." + "0" * step.decimals if step.decimals else "")
    return NUMBER_FORMATS[step.style]


def _write_sheet(wb, fmt, name: str, df: pd.DataFrame, formats: list) -> None:
    ws = wb.add_worksheet(name)
    cols = [str(c) for c in df.columns]
    live = [f for f in formats if all(str(c) in cols for c in _format_columns(f))]  # skip columns removed later

    col_fmt: dict[int, str] = {}  # column index -> number format
    for j, c in enumerate(df.columns):
        s = df[c]
        if pd.api.types.is_datetime64_any_dtype(s):
            col_fmt[j] = "yyyy-mm-dd" if (s.dropna() == s.dropna().dt.normalize()).all() else "yyyy-mm-dd hh:mm"
    for step in (f for f in live if f.op == "number_format"):
        for c in step.columns or [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]:
            col_fmt[cols.index(str(c))] = _number_format(step)

    row_fill: dict[int, str] = {}              # row -> colour
    cell_fill: dict[tuple[int, int], str] = {}  # (row, column) -> colour
    for step in (f for f in live if f.op == "highlight"):
        for i in highlight_mask(df, step).to_numpy().nonzero()[0]:
            if step.column:
                cell_fill[(i, cols.index(str(step.column)))] = step.color
            else:
                row_fill[i] = step.color

    ws.freeze_panes(1, 0)
    ws.write_row(0, 0, cols, fmt(bold=True, bg_color="#DDE3EA", border=1))
    for j, c in enumerate(df.columns):
        sample = [len(cols[j])] + [len(str(v)) for v in df[c].head(1000) if not pd.isna(v)]
        ws.set_column(j, j, min(max(sample) + 2, 50), fmt(num_format=col_fmt[j]) if j in col_fmt else None)

    # Dates go in as Excel date numbers so the column's date format applies (otherwise the writer's
    # default date format wins).
    out = df.assign(**{df.columns[j]: (df.iloc[:, j] - pd.Timestamp("1899-12-30")) / pd.Timedelta(days=1)
                       for j in range(len(df.columns)) if pd.api.types.is_datetime64_any_dtype(df.iloc[:, j])})
    values = out.astype(object).where(out.notna(), None).to_numpy().tolist()
    for i, row in enumerate(values):
        fill = row_fill.get(i)
        if fill is None and not cell_fill:
            ws.write_row(i + 1, 0, row)  # plain row: column formats apply
            continue
        for j, v in enumerate(row):
            colour = cell_fill.get((i, j), fill)
            if colour:  # a cell with its own fill must repeat the column's number format
                ws.write(i + 1, j, v, fmt(bg_color="#" + colour, num_format=col_fmt.get(j)))
            else:
                ws.write(i + 1, j, v)


def _write_chart(wb, fmt, sheets: Sheets, step, n: int) -> None:
    data = chart_data(pd.concat(list(sheets.values()), ignore_index=True), step)
    name = f"Chart {n}"
    ws = wb.add_worksheet(name)
    ws.write_row(0, 0, list(data.columns), fmt(bold=True, bg_color="#DDE3EA", border=1))
    for i, row in enumerate(data.astype(object).where(data.notna(), None).to_numpy().tolist(), start=1):
        ws.write_row(i, 0, row)
    ws.set_column(0, 0, min(max(len(str(v)) for v in [data.columns[0], *data.iloc[:, 0]]) + 2, 40))
    ws.set_column(1, 1, 18, fmt(num_format="#,##0.##"))
    chart = wb.add_chart({"type": step.kind})
    chart.add_series({"name": [name, 0, 1], "categories": [name, 1, 0, len(data), 0],
                      "values": [name, 1, 1, len(data), 1], "data_labels": {"value": step.kind == "pie"}})
    chart.set_title({"name": step.title})
    if step.kind != "pie":
        chart.set_legend({"none": True})
    chart.set_size({"width": 720, "height": 400})
    ws.insert_chart(1, 3, chart)


def to_xlsx(sheets: Sheets, formats: list | None = None, unformatted: Sheets | None = None) -> bytes:
    """`unformatted` sheets (e.g. a workbook's summary sheet) are written as-is, after the others."""
    formats = formats or []
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"strings_to_urls": False, "strings_to_numbers": False,
                                   "nan_inf_to_errors": True, "default_date_format": "yyyy-mm-dd"})
    cache: dict[tuple, object] = {}

    def fmt(**props):
        """One Format object per distinct style (Excel files have a limit on how many styles they hold)."""
        props = {k: v for k, v in props.items() if v is not None}
        key = tuple(sorted(props.items()))
        if key not in cache:
            cache[key] = wb.add_format(props)
        return cache[key]

    for name, df in sheets.items():
        _write_sheet(wb, fmt, name, df, formats)
    for name, df in (unformatted or {}).items():
        _write_sheet(wb, fmt, name, df, [])
    all_columns = {str(c) for df in sheets.values() for c in df.columns}
    for n, step in enumerate([f for f in formats if f.op == "chart"], start=1):
        if all(str(c) in all_columns for c in _format_columns(step)):
            _write_chart(wb, fmt, sheets, step, n)
    wb.close()
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
