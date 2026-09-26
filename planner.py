"""Rule-based parser: turns a plain-English command into a typed Plan.

No AI/ML. It recognises a fixed set of command patterns, matches words to column
names (tolerating underscores, plurals and small typos) and to values that actually
occur in the data. Anything it can't parse confidently becomes a clarification
question instead of a guess.
"""
from __future__ import annotations

import difflib
import re
import warnings
from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd

from engine import PlanError, Sheets, apply_plan, date_part
from plan import (
    Aggregation, CalculateStep, CleanTextStep, ComputeStep, Condition, ConvertStep, DatePartStep, DedupeStep,
    DropBlankRowsStep, DropColumnsStep, FillBlanksStep, FilterStep, GroupByStep, LabelCase, LabelStep, MergeColumnsStep,
    PivotStep, Plan, RenameStep, ReplaceStep, SelectColumnsStep, SortStep, SplitByStep, SplitColumnStep,
    Step, TopNStep,
)

EXAMPLES = [
    "only debits over 5000",
    "transactions in the last 30 days",
    "remove rows where description contains ATM",
    "split by category",
    "sort by amount descending",
    "keep columns date, description, amount",
    "total amount by category",
    "remove duplicates by transaction id",
]

STOP = {
    "a", "an", "the", "and", "or", "by", "of", "in", "on", "to", "for", "with", "where", "is",
    "are", "all", "any", "only", "just", "keep", "show", "rows", "row", "records", "data",
    "sheet", "sheets", "file", "last", "first", "next", "past", "days", "day", "month",
    "months", "year", "years", "week", "weeks", "that", "this", "than", "more", "less",
    "over", "under", "each", "every", "into", "from", "not", "no", "be", "it", "them",
}
FILLER_WORDS = STOP | {
    "filter", "remove", "exclude", "delete", "drop", "hide", "out", "get", "rid", "give", "me",
    "find", "list", "select", "include", "entries", "lines", "items", "ones", "which", "whose",
    "having", "if", "when", "please", "everything", "except", "excluding", "without", "take",
    "leave", "who", "have", "has", "been", "was", "were", "also", "then", "now",
}

MAX_SPLIT_SHEETS = 50
DATE_UNITS ={"day": 1, "week": 7, "month": 30, "year": 365}
MONTHS = {m.lower(): i for i, m in enumerate(
    ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]) if m}
AMOUNT_WORDS = {"amount", "amt", "value", "price", "total", "revenue", "sales", "cost"}
ID_WORDS = {"id", "no", "num", "number", "code", "pin", "zip", "phone", "mobile", "account", "acct"}

# Verbs that start a new clause when they follow "and", "then" or a comma.
VERB = (r"(?:sort|order|arrange|split|segregate|separate|keep|remove|drop|delete|exclude|filter"
        r"|show|dedupe|group|select|get|give|calculate|compute|find|hide|add|rank|pivot|top|bottom"
        r"|rename|replace|trim|fill|merge|combine|convert|change|make|capitali[sz]e"
        r"|create|insert|set|update|round|label|tag|flag|mark)")
CLAUSE_SPLIT = re.compile(
    rf"\s*(?:[;\n]+|(?<![Rr][Ss])\.\s+|\.$|,?\s*\b(?:and\s+then|and\s+also|then|also|and)\s+(?={VERB}\b)"
    rf"|,\s*(?={VERB}\b))\s*", re.I)


GROUP_MARKER = re.compile(r"\b(?:grouped\s+by|group\s+by|by|per|for\s+each|for\s+every|across|each)\b", re.I)
PIVOT = re.compile(r"\bpivot\w*|\bcross[\s-]?tab\w*|\bmatrix\b|\b(?:as|in)\s+(?:the\s+)?columns\b|\bacross\b", re.I)
PERCENT = re.compile(r"(?:,?\s*\b(?:with|and|plus|including)\s+(?:a\s+|the\s+)?)?(?:%|\bpercent(?:age)?s?\b|\bshare\b)"
                     r"(?:\s+of\s+(?:the\s+)?(?:grand\s+)?total)?", re.I)
TOP_N = re.compile(r"\b(top|bottom|first|last|highest|lowest|largest|smallest|biggest|latest|newest|oldest|earliest)"
                   r"\s+(\d+)\b(?!\s*(?:days?|weeks?|months?|years?)\b)", re.I)
DATE_PART = re.compile(r"\b(year|quarter|month|weekday|week|day\s+of\s+(?:the\s+)?week|day)(?:s|ly)?\b"
                       r"|\b(daily|annual(?:ly)?)\b", re.I)


SMART_QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})
QUOTED = re.compile(r"\"[^\"]*\"|(?<!\w)'[^']*'(?!\w)")  # the (?<!\w) keeps "haven't" from opening a quote
CASE = re.compile(r"\b(?:upper|lower|title|proper|sentence)[\s-]*case[sd]?\b"
                  r"|\b(?:uppercase|lowercase|capitali[sz]e[sd]?|all\s+caps|in\s+caps)\b", re.I)
TRIM = re.compile(r"\btrim(?:med)?\b(?:\s+(?:the\s+)?(?:extra\s+)?(?:white\s*)?spaces?)?"
                  r"|\b(?:strip|remove|clean(?:\s+up)?|fix|delete)\s+(?:all\s+)?(?:the\s+)?"
                  r"(?:(?:extra|leading|trailing|double|unnecessary|additional)\s+(?:and\s+)?)*(?:white\s*)?spaces?\b", re.I)
CONVERT = re.compile(r"^\s*(?:please\s+)?(?:convert|change|make|set|treat|format|turn|cast)\s+(?:the\s+)?(?:columns?\s+)?"
                     r"(?P<cols>.+?)\s+(?:(?:to|as|into)\s+)?(?:an?\s+)?(?:proper\s+|real\s+)?"
                     r"(?P<to>numbers?|numeric|integers?|decimals?|dates?|text|strings?)(?:\s+(?:format|type|values?))?\s*$", re.I)
BLANK_WORDS = {"", "blank", "blanks", "empty", "empties", "empty cells", "empty values", "blank cells",
               "blank values", "nothing", "null", "nulls", "missing", "missing values"}
DELIMITERS = {"comma": ",", "commas": ",", "space": " ", "spaces": " ", "dash": "-", "hyphen": "-", "slash": "/",
              "forward slash": "/", "backslash": "\\", "pipe": "|", "underscore": "_", "colon": ":",
              "semicolon": ";", "dot": ".", "period": ".", "full stop": ".", "tab": "\t",
              "nothing": "", "no space": ""}
DATEDIFF = re.compile(
    r"^(?:the\s+)?(?:number\s+of\s+|no\.?\s+of\s+)?(?P<unit>day|week|month|year)s?\s+"
    r"(?:(?:since|from|after)\s+(?P<a>.+?)(?:\s+(?:to|until|till)\s+(?P<b>.+?))?"
    r"|between\s+(?P<a2>.+?)\s+and\s+(?P<b2>.+?)|(?:until|till|to|before)\s+(?P<b3>.+?))\s*$"
    r"|^age\s+(?:from|of|using|based\s+on)\s+(?P<dob>.+?)\s*$", re.I)
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


class ParseError(Exception):
    """Raised with a user-facing message when a command can't be understood."""


def _key(s) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _singular(k: str) -> str:
    if k.endswith(("ches", "shes", "xes", "sses", "zes")) and len(k) > 4:
        return k[:-2]  # branches -> branch, taxes -> tax
    return k[:-1] if k.endswith("s") and not k.endswith("ss") and len(k) > 3 else k


def _col_words(col) -> list[str]:
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(col))
    return [w for w in re.split(r"[^a-z0-9]+", spaced.lower()) if w]


def _is_date_col(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
        return False
    sample = s.dropna().astype(str).head(200)
    if sample.empty or sample.str.fullmatch(r"\s*\d+(\.\d+)?\s*").all():
        return False
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        parsed = pd.to_datetime(sample, errors="coerce", format="mixed", dayfirst=True)
    return parsed.notna().mean() > 0.8


def parse_number(text: str) -> float | None:
    t = text.lower().strip()
    t = re.sub(r"[₹$€£]|\b(?:rs\.?|inr|rupees?|usd|dollars?)(?=\s|\d|$)", "", t).replace(",", "").strip()
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*(k|thousand|l|lakhs?|lacs?|cr|crores?|m|mn|million|b|bn|billion)?", t)
    if not m:
        return None
    mult = {"k": 1e3, "thousand": 1e3, "l": 1e5, "lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5,
            "cr": 1e7, "crore": 1e7, "crores": 1e7, "m": 1e6, "mn": 1e6, "million": 1e6,
            "b": 1e9, "bn": 1e9, "billion": 1e9}.get(m.group(2) or "", 1)
    return float(m.group(1)) * mult


def parse_date(text: str) -> str | None:
    t = text.strip().strip("'\"")
    if not re.search(r"\d", t):
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            # ISO (yyyy-mm-dd) must not be parsed day-first; everything else is dd/mm/yyyy.
            iso = re.match(r"\d{4}-\d{1,2}-\d{1,2}", t)
            return pd.to_datetime(t, dayfirst=not iso).date().isoformat()
    except (ValueError, OverflowError):
        return None


def _fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


@dataclass
class Mention:
    start: int
    end: int
    column: str


class Parser:
    def __init__(self, sheets: Sheets):
        frames = list(sheets.values())
        self.df = frames[0] if len(frames) == 1 else pd.concat(frames, ignore_index=True)
        self.columns = [str(c) for c in self.df.columns]
        self.col_keys = {c: _key(c) for c in self.columns}
        self.word_cols: dict[str, list[str]] = {}
        for c in self.columns:
            for w in _col_words(c):
                self.word_cols.setdefault(_singular(w), []).append(c)
        self.date_cols = [c for c in self.columns if _is_date_col(self.df[c])]
        self.numeric_cols = [c for c in self.columns
                             if pd.api.types.is_numeric_dtype(self.df[c])
                             and not pd.api.types.is_bool_dtype(self.df[c])]
        self._values: dict[str, dict[str, str]] | None = None

    # ---------- column / value lookup ----------

    def find_columns(self, text: str) -> list[Mention]:
        toks = [(m.start(), m.end(), _key(m.group())) for m in re.finditer(r"\S+", text)]
        cands = []  # (level, length, start_tok, end_tok, column)
        for i in range(len(toks)):
            for j in range(i + 1, min(i + 5, len(toks) + 1)):
                words = [t[2] for t in toks[i:j]]
                if not all(words) or all(w in STOP for w in words):
                    continue
                k = "".join(words)
                for c, ck in self.col_keys.items():
                    if k == ck or _singular(k) == _singular(ck):
                        cands.append((3, j - i, i, j, c))
                    elif len(k) >= 5 and difflib.SequenceMatcher(None, k, ck).ratio() >= 0.88:
                        cands.append((2, j - i, i, j, c))
                if j == i + 1 and len(k) >= 4 and k not in STOP:
                    # A word that is part of exactly one column name, e.g. "amount" -> "txn_amount".
                    cols = self.word_cols.get(_singular(k), [])
                    if len(cols) == 1:
                        cands.append((1, 1, i, j, cols[0]))
        used, out = set(), []
        for level, _, i, j, c in sorted(cands, key=lambda x: (-x[0], -x[1], x[2])):
            if used.isdisjoint(range(i, j)):
                used.update(range(i, j))
                out.append(Mention(toks[i][0], toks[j - 1][1], c))
        return sorted(out, key=lambda m: m.start)

    def column(self, text: str) -> str | None:
        """The single column that `text` names, or None."""
        ms = self.find_columns(text)
        rest = text
        for m in reversed(ms):
            rest = rest[:m.start] + rest[m.end:]
        leftover = [w for w in re.findall(r"[a-z0-9]+", rest.lower()) if w not in FILLER_WORDS | {"column", "columns", "field", "fields"}]
        return ms[0].column if len(ms) == 1 and not leftover else None

    def value_index(self) -> dict[str, dict[str, str]]:
        """singular key of each text value -> {column: original value}."""
        if self._values is None:
            self._values = {}
            for c in self.columns:
                s = self.df[c]
                if c in self.date_cols or pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
                    continue
                uniques = s.dropna().astype(str).unique()
                if len(uniques) > 20000:
                    continue
                for v in uniques:
                    k = _singular(_key(v))
                    if len(k) >= 2:
                        self._values.setdefault(k, {})[c] = v
        return self._values

    def resolve_value(self, col: str, raw: str) -> str:
        """Map a typed value to the actual value in `col` (case/plural/typo tolerant)."""
        s = self.df[col]
        if pd.api.types.is_numeric_dtype(s):
            n = parse_number(raw)
            if n is None:
                raise ParseError(f"'{raw}' is not a number, but '{col}' is a numeric column.")
            return _fmt(n)
        uniques = s.dropna().astype(str).unique()
        by_key = {_singular(_key(v)): v for v in uniques}
        k = _singular(_key(raw))
        if k in by_key:
            return by_key[k]
        # Typo matching only on smaller columns; difflib over 100K values would be slow.
        close = len(by_key) <= 20000 and difflib.get_close_matches(k, list(by_key), n=1, cutoff=0.85)
        if close:
            return by_key[close[0]]
        sample = ", ".join(sorted(map(str, uniques))[:15])
        raise ParseError(f"'{raw}' doesn't appear in column '{col}'. Values there include: {sample}")

    def resolve_values(self, col: str, raw: str) -> list[str]:
        """One value ("Food and Dining") if it exists as-is, otherwise a list ("food, travel")."""
        try:
            return [self.resolve_value(col, raw)]
        except ParseError:
            parts = _split_list(raw)
            if len(parts) == 1:
                raise
            return [self.resolve_value(col, v) for v in parts]

    def and_or_phrases(self) -> list[str]:
        """Column names and values that contain "and"/"or", longest first."""
        found = [c for c in self.columns if re.search(r"\s(?:and|or)\s", c, re.I)]
        found += [v for hits in self.value_index().values() for v in hits.values()
                  if re.search(r"\s(?:and|or)\s", v, re.I)]
        return sorted(set(found), key=len, reverse=True)

    def default_number_column(self) -> str:
        cands = [c for c in self.numeric_cols if not set(_col_words(c)) & ID_WORDS]
        amountish = [c for c in cands if set(_col_words(c)) & AMOUNT_WORDS]
        if len(cands) == 1:
            return cands[0]
        if len(amountish) == 1:
            return amountish[0]
        raise ParseError("Which column should the number apply to? Numeric columns: "
                         + ", ".join(cands or self.numeric_cols or ["(none)"]))

    def default_date_column(self, text: str) -> str:
        for m in self.find_columns(text):
            if m.column in self.date_cols:
                return m.column
        if len(self.date_cols) == 1:
            return self.date_cols[0]
        if not self.date_cols:
            raise ParseError("I couldn't find a date column in this file.")
        raise ParseError("Which date column do you mean? Date columns: " + ", ".join(self.date_cols))

    # ---------- clauses ----------

    def parse_clause(self, cl: str) -> list[Step]:
        low = cl.lower()
        if re.search(r"\bduplicat|\bde-?dup|\b(?:unique|distinct)\s+rows\b", low):
            return [self.parse_dedupe(cl)]
        formula = self.parse_formula_command(cl)
        if formula is not None:
            return formula
        cleaning = self.parse_cleaning(cl)
        if cleaning is not None:
            return cleaning
        if re.search(r"\b(?:split|segregate|separate|seperate|segment|divide|partition)\b"
                     r"|\bbreak\b.*\b(?:up|down|into)\b|\b(?:sheets?|tabs?|files?)\s+(?:per|for\s+each|by)\b", low):
            return self.parse_split(cl)
        if TOP_N.search(low):
            return self.parse_top_n(cl)
        if re.search(r"\brank(?:ed|ing)?\b|\b(?:running|cumulative)\b", low) or (
                PERCENT.search(low) and not self._is_group(PERCENT.sub(" ", low))):
            return self.parse_calculate(cl)
        if re.search(r"\b(?:sort|sorted|arrange)\b|\border(?:ed)?\s+(?:\w+\s+)?by\b", low):
            return [self.parse_sort(cl)]
        if PIVOT.search(low):
            return self.parse_pivot(cl)
        if self._is_group(low):
            return self.parse_group(cl)
        step = self.parse_columns(cl)
        if step:
            return [step]
        return [self.parse_filter(cl)]

    @staticmethod
    def _is_group(low: str) -> bool:
        return bool(re.search(r"\b(?:totals?|sums?|counts?|averages?|avg|mean|how\s+many|number\s+of|min|max|minimum|maximum"
                              r"|lowest|highest|smallest|largest|biggest|unique|distinct|summar\w*|group(?:ed)?)\b", low)
                    and GROUP_MARKER.search(low))

    @staticmethod
    def _funcs(low: str) -> list[str]:
        funcs = []
        for pattern, f in [(r"\b(?:totals?|sums?)\b", "sum"), (r"\b(?:averages?|avg|mean)\b", "mean"),
                           (r"\b(?:counts?|how\s+many|number\s+of)\b", "count"),
                           (r"\b(?:min|minimum|lowest|smallest)\b", "min"),
                           (r"\b(?:max|maximum|highest|largest|biggest)\b", "max"),
                           (r"\b(?:unique|distinct)\b", "nunique")]:
            if re.search(pattern, low):
                funcs.append(f)
        return funcs

    def extra_filters(self, text: str) -> tuple[str, list[FilterStep]]:
        """Row filters mentioned inside another command, e.g. "top 10 *debits* by amount *in the last 30 days*"."""
        text, conds = self.date_phrases(text)
        text, vconds = self.bare_values(text)
        conds += vconds
        return text, ([FilterStep(op="filter", conditions=conds, match="all")] if conds else [])

    def _trailing_filter(self, text: str) -> tuple[str, list[FilterStep]]:
        """In "count by year for result code 101", the part after for/where/with is a row filter."""
        m = re.search(r"\b(?:for(?!\s+(?:each|every)\b)|where|with|when|if|having)\b", text, re.I)
        if not m or not text[m.end():].strip():
            return text, []
        return text[:m.start()], [self.parse_filter(text[m.end():])]

    def _after(self, cl: str, pattern: str) -> str:
        m = re.search(pattern, cl, re.I)
        return cl[m.end():] if m else cl

    def _columns_in(self, text: str, what: str) -> list[str]:
        cols = []
        for m in self.find_columns(text):
            if m.column not in cols:
                cols.append(m.column)
        if not cols:
            raise ParseError(f"Which column should I {what}? Columns: " + ", ".join(self.columns))
        return cols

    def dims(self, text: str) -> tuple[list[DatePartStep], list[Mention]]:
        """Columns to group/split/pivot by, including date parts: "by month" -> month of the date column."""
        steps: list[DatePartStep] = []
        found: list[Mention] = []
        real = self.find_columns(text)
        for m in DATE_PART.finditer(text):
            if any(r.start < m.end() and m.start() < r.end for r in real):
                continue  # part of a real column name, e.g. "year" in "assessment year"
            word = m.group(0).lower()
            part = ("weekday" if "day" in word and "week" in word else "day" if word.startswith(("day", "daily"))
                    else "year" if word.startswith("annual") else DATE_PART.match(word).group(1))
            src = self.default_date_column(text)
            name = part if part not in self.columns else f"{src} {part}"
            if all(s.name != name for s in steps):
                steps.append(DatePartStep(op="date_part", column=src, part=part, name=name))
            found.append(Mention(m.start(), m.end(), name))
        blanked = text
        for f in found:
            blanked = blanked[:f.start] + " " * (f.end - f.start) + blanked[f.end:]
        sources = {s.column for s in steps}
        found += [m for m in self.find_columns(blanked) if m.column not in sources]  # skip "month of txn date"
        return steps, sorted(found, key=lambda m: m.start)

    def _distinct(self, name: str, steps: list[DatePartStep]) -> int:
        for s in steps:
            if s.name == name:
                return date_part(self.df[s.column], s.part).nunique(dropna=False)
        return self.df[name].nunique(dropna=False)

    def _check_width(self, cols: list[str], steps: list[DatePartStep], what: str) -> None:
        for c in cols:
            n = self._distinct(c, steps)
            if n > MAX_SPLIT_SHEETS:
                good = [f"{x} ({self.df[x].nunique(dropna=False)})" for x in self.columns
                        if 2 <= self.df[x].nunique(dropna=False) <= MAX_SPLIT_SHEETS]
                raise ParseError(f"'{c}' has {n:,} different values, so it would create {n:,} {what}. "
                                 f"Columns with fewer values ({what}): " + (", ".join(good) or "none"))

    def parse_dedupe(self, cl: str) -> DedupeStep:
        tail = self._after(cl, r"\b(?:by|on|based\s+on|using|in|of|per)\b")
        cols = [m.column for m in self.find_columns(tail)] if tail is not cl else []
        keep = "last" if re.search(r"\b(?:keep(?:ing)?\s+(?:the\s+)?(?:last|latest|newest|most\s+recent))\b", cl, re.I) else "first"
        return DedupeStep(op="dedupe", columns=cols or None, keep=keep)

    def parse_split(self, cl: str) -> list[Step]:
        tail = self._after(cl, r"\b(?:by|on|per|for\s+each|for\s+every|based\s+on|according\s+to|using)\b")
        prefix, found = self.dims(tail)
        cols = list(dict.fromkeys(m.column for m in found))
        if not cols:
            raise ParseError("Which column should I split by? Columns: " + ", ".join(self.columns))
        self._check_width(cols, prefix, "sheets")
        return prefix + [SplitByStep(op="split_by", column=c) for c in cols]

    def parse_sort(self, cl: str) -> SortStep:
        desc = bool(re.search(
            r"\b(?:desc|descending|decreasing|highest|largest|biggest|most|newest|latest|recent|reverse"
            r"|z\s*(?:-|to)\s*a|high(?:est)?\s+to\s+low(?:est)?|big(?:gest)?\s+to\s+small(?:est)?)\b", cl, re.I))
        tail = self._after(cl, r"\bby\b")
        tail = re.sub(r"\b(?:asc|ascending|desc|descending|first|order|highest|lowest|newest|oldest|latest"
                      r"|high|low|to|z|a|reverse)\b", " ", tail, flags=re.I)
        cols = [m.column for m in self.find_columns(tail)]
        if not cols and re.search(r"\b(?:newest|oldest|latest|earliest|recent|date)\b", cl, re.I):
            cols = [self.default_date_column(cl)]
        if not cols and re.search(r"\b(?:highest|lowest|largest|smallest|biggest)\b", cl, re.I):
            cols = [self.default_number_column()]
        if not cols:
            raise ParseError("Which column should I sort by? Columns: " + ", ".join(self.columns))
        return SortStep(op="sort", columns=list(dict.fromkeys(cols)), ascending=not desc)

    def parse_group(self, cl: str) -> list[Step]:
        pct = PERCENT.search(cl)
        if pct:
            cl = cl[:pct.start()] + " " + cl[pct.end():]
        cl, filters = self.extra_filters(cl)  # "how many debits per branch": debits is a row filter
        funcs = self._funcs(cl.lower()) or ["count"]
        m = GROUP_MARKER.search(cl)
        head, tail = _move_period_words(cl[:m.start()], cl[m.end():])
        tail, more = self._trailing_filter(tail)
        filters += more
        prefix, found = self.dims(tail)
        group_cols = list(dict.fromkeys(x.column for x in found))
        if not group_cols:
            raise ParseError("Which column should I group by? Columns: " + ", ".join(self.columns))
        value_cols = [x.column for x in self.find_columns(head) if x.column not in group_cols]
        aggs = []
        for f in funcs:
            if f == "count" and not value_cols:
                aggs.append(Aggregation(column=group_cols[0], func="count"))
                continue
            for c in value_cols or [self.default_number_column()]:
                aggs.append(Aggregation(column=c, func=f))
        steps: list[Step] = filters + prefix + [GroupByStep(op="group_by", columns=group_cols, aggregations=aggs)]
        if pct:
            out = f"{aggs[0].func}_{aggs[0].column}"
            steps.append(CalculateStep(op="calculate", kind="percent_of_total", column=out, name=f"% of total {out}"))
        return steps

    def parse_pivot(self, cl: str) -> list[Step]:
        cl, filters = self.extra_filters(cl)
        funcs = self._funcs(cl.lower())
        if len(funcs) > 1:
            raise ParseError("A pivot shows one calculation at a time. Which one: " + ", ".join(funcs) + "?")
        m = re.search(r"\b(?:by|per|for\s+each|across)\b", cl, re.I)
        if m:
            head, rest = _move_period_words(cl[:m.start()], cl[m.end():])
            marker = len(head) + 1
            text = f"{head} {m.group(0)} {rest}"
        else:
            text, marker = cl, None
        prefix, found = self.dims(text)
        across = re.search(r"\bacross\s+(?:the\s+top\s+)?(?:by\s+)?", text, re.I)
        rows, cols, head_cols = [], [], []
        for d in found:
            after = text[d.end:]
            if re.match(r"\s*(?:(?:as|in|on)\s+(?:the\s+)?columns?\b|across\s+the\s+top)", after, re.I) or (
                    across and d.start >= across.end()):
                cols.append(d.column)
            elif re.match(r"\s*(?:(?:as|in|on)\s+(?:the\s+)?rows?\b|down\s+the\s+side)", after, re.I):
                rows.append(d.column)
            elif marker is None or d.end <= marker:
                head_cols.append(d.column)  # before "by": the column to summarise
            else:
                rows.append(d.column)
        if not cols and len(rows) >= 2:
            cols = [rows.pop()]  # "pivot amount by category and txn type": last one goes across the top
        rows, cols = list(dict.fromkeys(rows)), list(dict.fromkeys(cols))
        values = [c for c in dict.fromkeys(head_cols) if c not in rows + cols]
        if len(values) > 1:
            raise ParseError("A pivot summarises one column at a time. Which one: " + ", ".join(values) + "?")
        if not rows:
            raise ParseError("Which column should go down the side of the pivot? Columns: " + ", ".join(self.columns))
        self._check_width(cols, prefix, "pivot columns")
        value = values[0] if values else None
        func = funcs[0] if funcs else ("sum" if value else "count")
        if func != "count" and value is None:
            value = self.default_number_column()
        return filters + prefix + [PivotStep(op="pivot", rows=rows, columns=cols, values=value, func=func)]

    def parse_top_n(self, cl: str) -> list[Step]:
        m = TOP_N.search(cl)
        word, n = m.group(1).lower(), int(m.group(2))
        rest = cl[:m.start()] + " " + cl[m.end():]
        rest, filters = self.extra_filters(rest)
        per = None
        pm = re.search(r"\b(?:per|within|for\s+each|in\s+each|each)\b", rest, re.I)
        if pm:
            ptail = rest[pm.end():]
            bm = re.search(r"\bby\b", ptail, re.I)
            per = self._columns_in(ptail[:bm.start()] if bm else ptail, "group by")
            rest = rest[:pm.start()] + (ptail[bm.start():] if bm else "")
        by = re.search(r"\bby\b", rest, re.I)
        cols = [x.column for x in self.find_columns(rest[by.end():] if by else rest) if x.column not in (per or [])]
        if len(set(cols)) > 1:
            raise ParseError("Which column should decide the top rows: " + ", ".join(dict.fromkeys(cols)) + "?")
        col = cols[0] if cols else None
        dateish = re.search(r"\b(?:latest|newest|oldest|earliest|recent)\b", cl, re.I)
        if col is None and word in ("first", "last") and not dateish:
            return filters + [TopNStep(op="top_n", n=n, column=None, largest=word == "first")]
        if col is None:
            col = self.default_date_column(cl) if dateish else self.default_number_column()
        lowest = re.search(r"\b(?:bottom|lowest|smallest|least|oldest|earliest)\b", cl, re.I) or word == "first"
        largest = word == "last" or not lowest
        return filters + [TopNStep(op="top_n", n=n, column=col, largest=largest, per=per)]

    def parse_calculate(self, cl: str) -> list[Step]:
        steps: list[Step] = []
        sm = re.search(r"\b(?:sorted|ordered|sort|order)\s+by\b.*$", cl, re.I)
        if sm:  # "cumulative sum of amount sorted by date": sort first, then calculate
            steps.append(self.parse_sort(sm.group(0)))
            cl = cl[:sm.start()]
        low = cl.lower()
        kind = ("rank" if re.search(r"\brank", low) else
                "running_total" if re.search(r"\b(?:running|cumulative)\b", low) else "percent_of_total")
        if kind == "percent_of_total" and re.search(r"\bby\b", low) and not re.search(r"\b(?:within|per|each)\b", low):
            # "percentage share of amount by category": each category's share of the total.
            return steps + self.parse_group("total " + cl)
        cl, filters = self.extra_filters(cl)
        low = cl.lower()
        if kind == "rank":
            by = re.search(r"\bby\b", cl, re.I)
            entity = [x.column for x in self.find_columns(cl[:by.start()])] if by else []
            if entity:
                funcs = self._funcs(cl[by.end():].lower())
                value = self.column(re.sub(r"\b(?:total|sum|average|avg|mean|count|min|max|highest|lowest)\b", " ",
                                           cl[by.end():], flags=re.I)) if funcs else None
                if not funcs or not value:
                    raise ParseError(f"Rank each row, or rank each {entity[0]} by a total? Try "
                                     f"'rank {entity[0]} by total amount' or 'rank by amount'.")
                # "rank branches by total amount": total per branch, then rank the totals.
                out = f"{funcs[0]}_{value}"
                return filters + steps + [
                    GroupByStep(op="group_by", columns=entity, aggregations=[Aggregation(column=value, func=funcs[0])]),
                    CalculateStep(op="calculate", kind="rank", column=out, name=f"rank by {out}"),
                    SortStep(op="sort", columns=[out], ascending=False)]
        per_marker = r"\b(?:within|per|for\s+each|in\s+each|each)\b" if kind == "rank" else r"\b(?:within|per|for\s+each|in\s+each|each|by)\b"
        pm = re.search(per_marker, cl, re.I)
        head, tail = (cl[:pm.start()], cl[pm.end():]) if pm else (cl, "")
        per = self._columns_in(tail, "calculate within") if pm else None
        if kind == "rank":
            head = self._after(head, r"\bby\b")
        cols = [x.column for x in self.find_columns(head) if x.column not in (per or [])]
        col = cols[0] if cols else self.default_number_column()
        descending = not re.search(r"\b(?:lowest|smallest|least|asc|ascending|oldest|earliest)\b", low)
        name = {"rank": f"rank by {col}", "running_total": f"running total {col}",
                "percent_of_total": f"% of total {col}"}[kind]
        return filters + steps + [CalculateStep(op="calculate", kind=kind, column=col, per=per, descending=descending, name=name)]

    def parse_columns(self, cl: str) -> SelectColumnsStep | DropColumnsStep | None:
        low = cl.lower()
        drop = re.match(r"^\s*(?:please\s+)?(?:drop|remove|delete|hide|exclude|get\s+rid\s+of)\b", low)
        keep = re.match(r"^\s*(?:please\s+)?(?:keep|select|show|include|just|only|retain|pick|want|give\s+me)\b", low)
        if not (drop or keep):
            return None
        has_word = re.search(r"\b(?:columns?|fields?|cols?)\b", low)
        body = re.sub(r"^\s*(?:please\s+)?(?:drop|remove|delete|hide|exclude|get\s+rid\s+of|keep|select|show"
                      r"|include|just|only|retain|pick|want|give\s+me)\b", "", cl, flags=re.I)
        body = re.sub(r"\b(?:only|just|the|columns?|fields?|cols?)\b", " ", body, flags=re.I)
        items = [i.strip() for i in re.split(r",|\band\b|&|\+|/", body, flags=re.I) if i.strip()]
        if not items:
            return None
        cols = [self.column(i) for i in items]
        if None in cols:
            if not has_word:
                return None  # probably a row filter like "keep only debits"
            bad = items[cols.index(None)]
            raise ParseError(f"I couldn't find a column matching '{bad}'. Columns: " + ", ".join(self.columns))
        cols = list(dict.fromkeys(cols))
        if drop:
            return DropColumnsStep(op="drop_columns", columns=cols)
        return SelectColumnsStep(op="select_columns", columns=cols)

    # ---------- calculated columns ----------

    def parse_formula_command(self, cl: str) -> list[Step] | None:
        """'add column gst = amount * 0.18', 'size = high if amount > 50000 else low',
        'round amount to 2 decimals', 'add days since txn date', 'label amount over 1 lakh as large'.
        None if `cl` isn't one."""
        text = cl.strip().rstrip(".")
        m = re.match(r"^\s*(?:please\s+)?round(?:\s+off)?\s+(?:the\s+)?(?:column\s+)?(?P<x>.+?)(?:\s+to\s+(?P<n>\d+|one|two|three|four)"
                     r"\s+(?:decimals?|decimal\s+places?|places?|digits?))?\s*$", text, re.I)
        if m:
            col = self.column(m.group("x"))
            if col is None:
                raise ParseError(f"Which column should I round? Columns: " + ", ".join(self.numeric_cols))
            n = int(NUMBER_WORDS.get((m.group("n") or "0").lower(), m.group("n") or 0))
            return [ComputeStep(op="compute", name=col, expr=f"round([{col}], {n})", replace=True)]

        m = re.match(r"^\s*(?:please\s+)?(?P<verb>label|tag|flag|mark)\s+(?:the\s+)?(?:rows?\s+|transactions?\s+|records?\s+)?"
                     r"(?:where\s+|with\s+|that\s+have\s+|if\s+)?(?P<c>.+?)(?:\s+as\s+(?P<v>\"[^\"]*\"|'[^']*'|[^,]+?))?"
                     r"(?:\s*,?\s*\b(?:else|otherwise)\b[\s,:]*(?P<d>.+))?\s*$", text, re.I)
        if m:
            name = "flag" if m.group("verb").lower() in ("flag", "mark") else "label"
            return [self._label(name, [(m.group("v") or "Yes", m.group("c"))], m.group("d"), replace=False)]

        m = re.match(r"^\s*(?:please\s+)?(?:add|calculate|compute|show|create)\s+(?:a\s+column\s+(?:for|with)\s+)?(?:the\s+)?"
                     r"(?P<rhs>(?:number\s+of\s+)?(?:days?|weeks?|months?|years?)\s+(?:since|from|after|between|until|till|before)\b.+"
                     r"|age\s+(?:from|of|using|based\s+on)\s+.+)$", text, re.I)
        if m:
            rhs = m.group("rhs")
            name = "age" if rhs.lower().startswith("age") else re.sub(r"^number\s+of\s+", "", rhs, flags=re.I)
            return [self._compute(name, rhs, explicit=True, verb=None)]

        verb = r"(?:add|create|make|insert|calculate|compute|new|set|update)"
        m = re.match(rf"^\s*(?:please\s+)?(?P<verb>{verb})\s+(?:an?\s+)?(?:new\s+)?(?:columns?|fields?|col)\s+(?:called\s+|named\s+)?"
                     rf"(?P<name>\"[^\"]*\"|'[^']*'|.+?)\s*(?:=|:|\bas\b|\bequal\s+to\b|\bequals\b|\bwhich\s+is\b|\bthat\s+is\b|\bwith\b)"
                     rf"\s*(?P<rhs>.+)$", text, re.I) \
            or re.match(rf"^\s*(?:please\s+)?(?P<verb>add|calculate|compute|create)\s+(?P<name>.+?)\s+as\s+(?P<rhs>.+)$", text, re.I)
        if m:
            return [self._compute(m.group("name"), m.group("rhs"), explicit=True, verb=m.group("verb").lower())]
        m = re.match(rf"^\s*(?:please\s+)?(?:(?P<verb>{verb})\s+)?(?P<name>[^=:<>!]+?)\s*[=:]\s*(?P<rhs>[^=].*)$", text, re.I)
        if m and len(m.group("name").split()) <= 4:
            verb_word = (m.group("verb") or "").lower()
            if self.column(m.group("name")) and verb_word not in ("set", "update"):
                return None  # "txn_type = DEBIT" is a filter on an existing column
            return [self._compute(m.group("name"), m.group("rhs"), explicit=False, verb=verb_word)]
        return None

    def _compute(self, name: str, rhs: str, explicit: bool, verb: str | None) -> Step:
        name = re.sub(r"^(?:the\s+)|\s+column$", "", _unquote(name).strip(), flags=re.I).strip()
        existing = next((c for c in self.columns if _key(c) == _key(name)), None) or (None if explicit else self.column(name))
        replace = bool(existing) and verb in ("set", "update")
        if existing and not replace:
            raise ParseError(f"There is already a column called {existing}. Say 'set {existing} = ...' to overwrite it, "
                             "or pick a new name.")
        name = existing if replace else name
        if re.search(r"\bif\b|\b(?:else|otherwise)\b", rhs, re.I):
            return self._label_rhs(name, rhs, replace)
        try:
            return ComputeStep(op="compute", name=name, expr=self.parse_expression(rhs), replace=replace)
        except ParseError:
            # "flag = amount > 100000": a condition on its own becomes a Yes/No column.
            if re.search(r"[<>]|\b(?:is|are|over|under|above|below|more|less|greater|contains?|between|empty)\b", rhs, re.I):
                return self._label(name, [("Yes", rhs)], "No", replace)
            raise

    def _label_rhs(self, name: str, rhs: str, replace: bool) -> LabelStep:
        rhs = rhs.strip()
        m = re.match(r"^if\s+(?P<c>.+?)\s+then\s+(?P<v>.+?)\s*,?\s+(?:else|otherwise)\s+(?P<d>.+)$", rhs, re.I)
        if m:
            return self._label(name, [(m.group("v"), m.group("c"))], m.group("d"), replace)
        dm = re.search(r"\s*,?\s*\b(?:else|otherwise|or\s+else)\b[\s,:]*(?P<d>.+)$", rhs, re.I)
        body = rhs[:dm.start()] if dm else rhs
        cases = []
        for part in re.split(r",\s*(?=(?:\"[^\"]*\"|'[^']*'|[^,]+?)\s+if\b)", body):
            pm = re.match(r"^\s*(?P<v>\"[^\"]*\"|'[^']*'|.+?)\s+(?:if|when|where)\s+(?P<c>.+?)\s*$", part, re.I)
            if not pm:
                raise ParseError("Try: add column size = high if amount > 50000 else low")
            cases.append((pm.group("v"), pm.group("c")))
        return self._label(name, cases, dm.group("d") if dm else None, replace)

    def _label(self, name: str, cases: list[tuple[str, str]], default: str | None, replace: bool) -> LabelStep:
        if name in self.columns and not replace:
            raise ParseError(f"There is already a column called {name}. Say 'set {name} = ...' to overwrite it.")
        default = _unquote(default) if default else None
        if default is not None and default.lower() in BLANK_WORDS:
            default = None
        return LabelStep(op="label", name=name, default=default, replace=replace,
                         cases=[LabelCase(when=self.parse_filter(c), value=_unquote(v)) for v, c in cases])

    def parse_expression(self, text: str) -> str:
        """Plain-English arithmetic -> the engine's restricted formula, e.g. '18% of amount' -> '0.18 * [amount]'."""
        t = text.strip().rstrip(".")
        dd = DATEDIFF.match(t)
        if dd:
            if dd.group("dob"):
                unit, a, b = "year", dd.group("dob"), "today"
            else:
                unit = dd.group("unit").lower()
                a = dd.group("a") or dd.group("a2") or "today"
                b = dd.group("b") or dd.group("b2") or dd.group("b3") or "today"
            return f"{unit}s({self._date_operand(a)}, {self._date_operand(b)})"
        rm = re.match(r"^round(?:ed)?\s*(?:off\s+)?\(?\s*(?P<x>.+?)\s*(?:,\s*|\s+to\s+)(?P<n>\d+)\s*(?:decimals?|(?:decimal\s+)?places?)?\s*\)?$", t, re.I)
        if rm:
            return f"round({self.parse_expression(rm.group('x'))}, {rm.group('n')})"
        # "amount + 18%" means "amount increased by 18%", as people mean it, not amount + 0.18.
        pm = re.match(r"^(?P<base>.+?)\s*(?P<op>[+-]|\bplus\b|\bminus\b)\s*(?P<p>\d+(?:\.\d+)?)\s*%$", t, re.I)
        if pm:
            sign = 1 if pm.group("op").lower() in ("+", "plus") else -1
            return f"({self.parse_expression(pm.group('base'))}) * {_fmt(1 + sign * float(pm.group('p')) / 100)}"
        # [bracketed] and "quoted" column names are set aside so "Amount (INR)" isn't split at its brackets.
        held: list[str] = []
        t = re.sub(r"\[[^\]]+\]|\"[^\"]*\"|'[^']*'", lambda m: held.append(m.group()[1:-1]) or f"__H{len(held) - 1}__", t)
        t = re.sub(r"\bmultiplied\s+by\b|\btimes\b|×|(?<=\s)x(?=\s)", " * ", t, flags=re.I)
        t = re.sub(r"\bdivided\s+by\b|÷", " / ", t, flags=re.I)
        t = re.sub(r"\bplus\b", " + ", t, flags=re.I)
        t = re.sub(r"\bminus\b", " - ", t, flags=re.I)
        t = re.sub(r"%\s+of\b", "% * ", t, flags=re.I)
        out = []
        for tok in re.split(r"(\*|/|\+|\(|\)|,|(?:(?<=\s)|^)-(?=[\s\d(]))", t):
            chunk = (tok or "").strip()
            if not chunk:
                continue
            if chunk in ("*", "/", "+", "-", "(", ")", ","):
                out.append(chunk)
                continue
            chunk = re.sub(r"__H(\d+)__", lambda m: held[int(m.group(1))], chunk)
            out.append(self._operand(chunk))
        if not out:
            raise ParseError("What should the new column be? e.g. add column gst = amount * 0.18")
        return " ".join(out)

    def _operand(self, chunk: str) -> str:
        if chunk.endswith("%") and parse_number(chunk[:-1]) is not None:
            return _fmt(parse_number(chunk[:-1]) / 100)
        n = parse_number(chunk)
        if n is not None:
            return _fmt(n)
        if chunk.lower() in ("abs", "round"):
            return chunk.lower()
        if chunk.lower() in ("today", "now", "today's date"):
            return "today()"
        col = self.column(chunk)
        if col:
            return f"[{col}]"
        if "-" in chunk:  # "credit-debit" without spaces
            parts = chunk.split("-")
            if all(self.column(p) or parse_number(p) is not None for p in parts):
                return " - ".join(self._operand(p) for p in parts)
        raise ParseError(f"I couldn't find a column called '{chunk}' for the formula. Columns: " + ", ".join(self.columns))

    def _date_operand(self, text: str) -> str:
        t = _unquote(text.strip())
        if t.lower() in ("today", "now", "today's date", "current date", "the current date"):
            return "today()"
        col = self.column(t)
        if col is None:
            raise ParseError(f"I couldn't find a date column called '{t}'. Date columns: " + ", ".join(self.date_cols or ["(none)"]))
        if col not in self.date_cols:
            raise ParseError(f"'{col}' doesn't look like a date column. Date columns: " + ", ".join(self.date_cols or ["(none)"]))
        return f"[{col}]"

    # ---------- cleaning ----------

    def parse_cleaning(self, cl: str) -> list[Step] | None:
        """Cleaning commands, or None if `cl` isn't one."""
        low = cl.lower()
        if re.match(r"^\s*(?:please\s+)?rename\b", low):
            return [self.parse_rename(cl)]
        if (re.match(r"^\s*(?:please\s+)?(?:replace|substitute)\b", low)
                or re.match(r"^\s*(?:please\s+)?(?:remove|delete|strip|erase|get\s+rid\s+of|take\s+out)\s+(?:the\s+)?(?:text\s+)?[\"']", cl)):
            return [self.parse_replace(cl)]
        step = self.parse_text_split(cl)
        if step:
            return [step]
        if re.match(r"^\s*(?:please\s+)?(?:merge|combine|concatenate|concat|join)\b", low):
            return [self.parse_merge(cl)]
        if re.match(r"^\s*(?:please\s+)?(?:remove|delete|drop|exclude)\b", low):
            if re.search(r"\b(?:blank|empty)\s+(?:rows|lines)\b", low):
                return [DropBlankRowsStep(op="drop_blank_rows", how="all")]
            if re.search(r"\brows?\s+(?:with|having|that\s+have|containing)\s+(?:any\s+)?(?:blank|empty|missing)"
                         r"(?:\s+(?:values?|cells?|fields?|data))?\s*$", low):
                return [DropBlankRowsStep(op="drop_blank_rows", how="any")]
        case = CASE.search(low)
        if case:
            word = case.group(0)
            action = "upper" if re.search(r"upper|caps", word) else "lower" if "lower" in word else "title"
            return [CleanTextStep(op="clean_text", columns=self._text_targets(CASE.sub(" ", cl)), action=action)]
        if TRIM.search(low):
            return [CleanTextStep(op="clean_text", columns=self._text_targets(TRIM.sub(" ", cl)), action="trim")]
        if re.match(r"^\s*(?:please\s+)?fill\b", low):
            return [self.parse_fill(cl)]
        m = CONVERT.search(cl)
        if m:
            target = m.group("to").lower()
            to = "date" if target.startswith("date") else "text" if target.startswith(("text", "string")) else "number"
            cols = self._column_list(m.group("cols"), "convert")
            return [ConvertStep(op="convert", columns=cols, to=to)]
        return None

    def _column_list(self, text: str, what: str) -> list[str]:
        """'a, b and c' -> exact columns; anything that isn't a column is an error, not ignored."""
        text = re.sub(r"\b(?:the|columns?|fields?|cols?)\b", " ", text, flags=re.I)
        items = [i.strip() for i in re.split(r",|\band\b|&", text, flags=re.I) if i.strip()]
        cols = []
        for item in items:
            c = self.column(item)
            if c is None:
                raise ParseError(f"Which column should I {what}? I couldn't find '{item}'. Columns: " + ", ".join(self.columns))
            cols.append(c)
        if not cols:
            raise ParseError(f"Which column should I {what}? Columns: " + ", ".join(self.columns))
        return list(dict.fromkeys(cols))

    def _text_targets(self, text: str) -> list[str] | None:
        """Columns named in a trim/case command; None means every text column."""
        cols = list(dict.fromkeys(m.column for m in self.find_columns(text)))
        numeric = [c for c in cols if c in self.numeric_cols]
        if numeric:
            raise ParseError(f"{', '.join(numeric)} holds numbers, not text.")
        return cols or None

    def parse_rename(self, cl: str) -> RenameStep:
        body = re.sub(r"^\s*(?:please\s+)?rename\s+(?:the\s+)?(?:columns?\s+)?", "", cl, flags=re.I)
        item = r"(?:\"[^\"]*\"|'[^']*'|.+?)"
        pairs = re.finditer(rf"(?:^|\s*(?:,|\band\b)\s*)(?P<old>{item})\s+(?:to|as|into|->)\s+(?P<new>{item})"
                            rf"(?=\s*(?:,|\band\b)\s*{item}\s+(?:to|as|into|->)\s+|\s*$)", body, re.I)
        mapping = {}
        for p in pairs:
            old = self.column(_unquote(p.group("old")))
            if old is None:
                raise ParseError(f"I couldn't find a column called '{_unquote(p.group('old'))}'. Columns: " + ", ".join(self.columns))
            mapping[old] = _unquote(p.group("new"))
        if not mapping:
            raise ParseError("Try: rename amt to amount")
        return RenameStep(op="rename", mapping=mapping)

    def parse_replace(self, cl: str) -> Step:
        q = r"\"[^\"]*\"|'[^']*'"
        cols_part = r"(?:the\s+)?(?:columns?\s+)?(?P<cols>.+?)"
        m = (re.match(rf"^\s*(?:please\s+)?(?:replace|substitute)\s+(?:all\s+)?(?P<find>{q}|.+?)\s+(?:in|within)\s+{cols_part}"
                      rf"\s+(?:with|by|->)\s+(?P<rep>{q}|.+?)\s*$", cl, re.I)
             or re.match(rf"^\s*(?:please\s+)?(?:replace|substitute)\s+(?:all\s+)?(?P<find>{q}|.+?)\s+(?:with|by|->|to)\s+"
                         rf"(?P<rep>{q}|.+?)(?:\s+(?:in|on|for|within)\s+{cols_part})?\s*$", cl, re.I)
             or re.match(rf"^\s*(?:please\s+)?(?:remove|delete|strip|erase|get\s+rid\s+of|take\s+out)\s+(?:the\s+)?(?:text\s+)?(?P<find>{q})"
                         rf"(?:\s+(?:from|in)\s+{cols_part})?\s*$", cl, re.I))
        if not m:
            raise ParseError('Try: replace "UPI/" with "" in description')
        find = _unquote(m.group("find"))
        rep = _unquote(m.groupdict().get("rep") or "")
        if rep.lower() in BLANK_WORDS:
            rep = ""
        cols_text = m.group("cols")
        cols = None if not cols_text or re.fullmatch(r"\s*(?:all(?:\s+columns)?|everywhere|every\s*where|all\s+text)\s*", cols_text, re.I) \
            else self._column_list(cols_text, "replace in")
        if find.lower() in BLANK_WORDS:
            # "replace blanks with Unknown" means fill the empty cells.
            return FillBlanksStep(op="fill_blanks", columns=cols, method="value", value=rep)
        if not find:
            raise ParseError("What text should I replace?")
        return ReplaceStep(op="replace", columns=cols, find=find, replace=rep)

    def parse_fill(self, cl: str) -> FillBlanksStep:
        low = cl.lower()
        method = ("down" if re.search(r"\bdown(?:wards?)?\b|\bforward\b|\babove\b|\bprevious\b", low) else
                  "up" if re.search(r"\bup(?:wards?)?\b|\bbackwards?\b|\bbelow\b|\bnext\b", low) else "value")
        value = None
        vm = re.search(r"\b(?:with|as|using|to)\s+(?P<v>\"[^\"]*\"|'[^']*'|.+?)(?=\s+(?:in|for|on)\s+|\s*$)", cl, re.I)
        if method == "value":
            if not vm:
                raise ParseError("Fill the blanks with what? e.g. fill blank branch with Unknown, or fill down branch")
            value = _unquote(vm.group("v"))
            cl = cl[:vm.start()] + " " + cl[vm.end():]
        cols = list(dict.fromkeys(m.column for m in self.find_columns(cl))) or None
        return FillBlanksStep(op="fill_blanks", columns=cols, method=method, value=value)

    def parse_text_split(self, cl: str) -> SplitColumnStep | None:
        m = re.match(r"^\s*(?:please\s+)?(?:split|separate|break)\s+(?:up\s+)?(?:the\s+)?(?:column\s+)?(?P<col>.+?)\s+"
                     r"(?P<rest>(?:into|by|on|at|using|with)\b.*)$", cl, re.I)
        if not m or re.match(r"(?:by|per|on|for|according|based|into|each)\b", m.group("col"), re.I) \
                or re.search(r"\b(?:sheets?|tabs?|files?|workbooks?)\b", m.group("rest"), re.I):
            return None  # "split by category": one sheet per value, not text-to-columns
        col = self.column(m.group("col"))
        if col is None:
            return None
        rest = m.group("rest")
        dm = re.search(r"\b(?:by|on|at|using|with)\s+(?:an?\s+|the\s+)?(?P<d>\"[^\"]*\"|'[^']*'|forward\s+slash|full\s+stop|\S+)", rest, re.I)
        delimiter = " "
        if dm:
            d = _unquote(dm.group("d"))
            delimiter = DELIMITERS.get(d.lower(), d)
            rest = rest[:dm.start()] + " " + rest[dm.end():]
        names: list[str] = []
        nm = re.search(r"\binto\s+(?P<n>.+?)\s*$", rest, re.I)
        count = None
        if nm:
            cm = re.fullmatch(r"(\d+|two|three|four|five|six)\s+(?:new\s+)?(?:columns?|parts?|pieces?|fields?)", nm.group("n").strip(), re.I)
            if cm:
                count = int(NUMBER_WORDS.get(cm.group(1).lower(), cm.group(1)))
            else:
                names = [_unquote(n) for n in re.split(r",|\band\b|&", nm.group("n"), flags=re.I) if n.strip()]
                if len(names) < 2:
                    raise ParseError("Split into which new columns? e.g. split name into first and last")
        if not names:
            if count is None:
                count = int(self.df[col].dropna().astype(str).str.count(re.escape(delimiter)).max() + 1)
                count = max(2, min(count, 10))
            names = [f"{col} {i}" for i in range(1, count + 1)]
        return SplitColumnStep(op="split_column", column=col, delimiter=delimiter, names=names)

    def parse_merge(self, cl: str) -> MergeColumnsStep:
        body = re.sub(r"^\s*(?:please\s+)?(?:merge|combine|concatenate|concat|join)\s+(?:the\s+)?(?:columns?\s+)?", "", cl, flags=re.I)
        separator = " "
        sm = re.search(r"\s+(?:with|using|separated\s+by|by)\s+(?:an?\s+|the\s+)?(?P<s>\"[^\"]*\"|'[^']*'|no\s+space|forward\s+slash|\S+)"
                       r"(?:\s+(?:separator|in\s+between|between))?", body, re.I)
        if sm and (sm.group("s")[0] in "\"'" or sm.group("s").lower() in DELIMITERS):
            s = _unquote(sm.group("s"))
            separator = DELIMITERS.get(s.lower(), s)
            body = body[:sm.start()] + " " + body[sm.end():]
        name = None
        nm = re.search(r"\s+(?:into|as|to)\s+(?:an?\s+)?(?:new\s+)?(?:column\s+)?(?:called\s+|named\s+)?(?P<n>.+?)\s*$", body, re.I)
        if nm:
            name = _unquote(nm.group("n"))
            body = body[:nm.start()]
        cols = self._column_list(body, "merge")
        if len(cols) < 2:
            raise ParseError("Merge which columns? e.g. merge first and last into full name")
        return MergeColumnsStep(op="merge_columns", columns=cols, separator=separator, name=name or " ".join(cols))

    # ---------- row filters ----------

    def parse_filter(self, cl: str) -> FilterStep:
        everything_except = re.search(r"\b(?:everything|all(?:\s+\w+)?)\s+(?:except|but|other\s+than|excluding)\b", cl, re.I)
        negate = bool(everything_except or re.match(r"^\s*(?:please\s+)?(?:remove|exclude|delete|drop|hide|filter\s+out"
                                                    r"|get\s+rid\s+of|take\s+out|leave\s+out|without|except|excluding)\b", cl, re.I))
        if everything_except:  # negate once for the clause, not again next to the value
            cl = cl[:everything_except.start()] + cl[everything_except.end():]
        body = cl
        for phrase in self.and_or_phrases():  # e.g. the value "Food and Dining" is one value
            body = re.sub(re.escape(phrase), lambda m: re.sub(
                r"\s+(and|or)\s+", lambda x: f" __{x.group(1).upper()}__ ", m.group(), flags=re.I), body, flags=re.I)
        body = re.sub(r"\b(between|from)\s+(\S+(?:\s+\S+){0,3}?)\s+and\s+", r"\1 \2 __AND__ ", body, flags=re.I)
        parts = re.split(r"\s*\b(and|or)\b\s*", body, flags=re.I)
        frags, connectors = parts[0::2], [p.lower() for p in parts[1::2]]
        if "and" in connectors and "or" in connectors:
            raise ParseError("Mixing 'and' with 'or' in one filter is ambiguous. Please split it into two commands.")
        match = "any" if "or" in connectors else "all"
        conds: list[Condition] = []
        for frag in frags:
            frag = frag.replace("__AND__", "and").replace("__OR__", "or")
            got = self.parse_fragment(frag, conds[-1] if conds else None)
            if not got:
                raise ParseError(f"I couldn't understand '{frag.strip()}'.\n\nTry commands like:\n- "
                                 + "\n- ".join(EXAMPLES))
            conds.extend(got)
        conds, match = _merge_same_column(conds, match)
        if negate:
            conds = [_negate(c) for c in conds]
            if len(conds) > 1:
                match = "any" if match == "all" else "all"
        return FilterStep(op="filter", conditions=conds, match=match)

    def parse_fragment(self, frag: str, prev: Condition | None) -> list[Condition]:
        prev_col = prev.column if prev else None
        conds: list[Condition] = []
        frag, dconds = self.date_phrases(frag)
        conds += dconds

        # "<column> <operator> <value>" for each column mentioned.
        mentions = self.find_columns(frag)
        residue = frag
        for i, m in enumerate(mentions):
            seg_end = mentions[i + 1].start if i + 1 < len(mentions) else len(frag)
            got, used = self.parse_op(m.column, frag[m.end:seg_end])
            if not got and re.search(r"\b(?:no|missing|empty|blank)\s+(?:an?\s+)?$", frag[:m.start], re.I):
                got, used = [Condition(column=m.column, operator="is_empty")], 0  # "rows with no branch"
            if got:
                conds += got
                residue = residue[:m.start] + " " * (m.end + used - m.start) + residue[m.end + used:]
                prev_col = m.column

        # Bare values that exist in the data, e.g. "debits" -> txn_type = DEBIT.
        residue, vconds = self.bare_values(residue)
        conds += vconds

        # Operator without a column, e.g. "over 5000" or "and under 500".
        rest = " ".join(residue.split())
        if rest and re.search(r"\d", rest):
            looks_like_date = re.search(r"\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}"
                                        r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", rest, re.I)
            if looks_like_date:
                col = prev_col if prev_col in self.date_cols else self.default_date_column(frag)
            else:
                col = prev_col if prev_col in self.numeric_cols else self.default_number_column()
            # The operator may come after other words: "transactions after 01/03/2025".
            for w in re.finditer(r"\S+", rest):
                got, _ = self.parse_op(col, rest[w.start():], require_op=True)
                if got:
                    conds += got
                    break

        # A lone value after "and"/"or" continues the previous condition:
        # "description contains zomato or swiggy".
        value = _clean_value(frag)
        if not conds and prev and prev.operator in ("contains", "not_contains") and 0 < len(value.split()) <= 3:
            conds.append(prev.model_copy(update={"value": value}))
        return conds

    def date_phrases(self, frag: str) -> tuple[str, list[Condition]]:
        conds = []
        low = frag.lower()
        unit = r"(day|week|month|year)s?"
        patterns = [
            (rf"\b(?:older\s+than|more\s+than|over|at\s+least)\s+(\d+)\s*{unit}(?:\s+(?:ago|old))?", "older"),
            (rf"\b(\d+)\s*{unit}\s+ago\s+or\s+(?:more|older|earlier)", "older"),
            (rf"\b(?:in|within|during|over|for|from)?\s*(?:the\s+)?(?:last|past|previous|recent)\s+(\d+)?\s*{unit}", "recent"),
            (rf"\b(?:in|within|for)\s+(\d+)\s*{unit}", "recent"),
        ]
        for pattern, kind in patterns:
            m = re.search(pattern, low)
            if not m:
                continue
            days = int(m.group(1) or 1) * DATE_UNITS[m.group(2)]
            before = low[:m.start()]
            negated = re.search(r"\b(?:not|no|never|without|inactive|hasnt|havent|didnt|isnt|wasnt|dont|doesnt)\b|n't\b", before)
            col = self.default_date_column(frag)
            op = "older_than_days" if (kind == "older") != bool(negated) else "within_last_days"
            conds.append(Condition(column=col, operator=op, value=str(days)))
            frag = frag[:m.start()] + " " + frag[m.end():]
            return self._strip_col(frag, col), conds

        today = date.today()
        m = re.search(r"\b(?:this|current)\s+(month|year)\b|\btoday\b", low)
        if m:
            start = today if m.group(0) == "today" else (
                today.replace(day=1) if m.group(1) == "month" else today.replace(month=1, day=1))
            col = self.default_date_column(frag)
            conds.append(Condition(column=col, operator="gte", value=start.isoformat()))
            return self._strip_col(frag[:m.start()] + " " + frag[m.end():], col), conds

        m = re.search(r"\b(?:in|during|for|of)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(\d{4})\b", low) \
            or re.search(r"\b(?:in|during|for)\s+(?:the\s+year\s+)?()(\d{4})\b", low)
        if m and self.date_cols:
            year = int(m.group(2))
            if m.group(1):
                month = MONTHS[m.group(1)[:3]]
                start = date(year, month, 1)
                end = date(year + (month == 12), month % 12 + 1, 1)
            else:
                start, end = date(year, 1, 1), date(year + 1, 1, 1)
            col = self.default_date_column(frag)
            conds += [Condition(column=col, operator="gte", value=start.isoformat()),
                      Condition(column=col, operator="lt", value=end.isoformat())]
            return self._strip_col(frag[:m.start()] + " " + frag[m.end():], col), conds
        return frag, conds

    def _strip_col(self, frag: str, col: str) -> str:
        """Blank out mentions of `col` so it isn't parsed again as a separate condition."""
        for m in reversed(self.find_columns(frag)):
            if m.column == col:
                frag = frag[:m.start] + " " * (m.end - m.start) + frag[m.end:]
        return frag

    def bare_values(self, text: str) -> tuple[str, list[Condition]]:
        index = self.value_index()
        toks = list(re.finditer(r"\S+", text))
        conds, used = [], set()
        for n in range(min(5, len(toks)), 0, -1):
            for i in range(len(toks) - n + 1):
                if used & set(range(i, i + n)):
                    continue
                words = [_key(t.group()) for t in toks[i:i + n]]
                if n == 1 and (words[0] in FILLER_WORDS or len(words[0]) < 2 or words[0].isdigit()):
                    continue
                hits = index.get(_singular("".join(words)))
                if not hits:
                    continue
                if len(hits) > 1:
                    raise ParseError(f"'{' '.join(t.group() for t in toks[i:i + n])}' appears in several columns ("
                                     + ", ".join(hits) + "). Please say which column, e.g. \"<column> is <value>\".")
                (col, value), = hits.items()
                before = text[:toks[i].start()].lower()
                neg = re.search(r"\b(?:not|non|except|excluding|other\s+than|no)\s*-?\s*$", before)
                conds.append(Condition(column=col, operator="not_equals" if neg else "equals", value=value))
                used.update(range(i, i + n))
        for i in sorted(used, reverse=True):
            t = toks[i]
            text = text[:t.start()] + " " * (t.end() - t.start()) + text[t.end():]
        return text, conds

    # Each operator: (regex matched at the start of the text after the column, operator name).
    OPS = [
        (r"(?:is\s+|are\s+)?(?:between|from)\s+(.+?)\s+(?:and|to|till|until|-)\s+(.+)", "between"),
        (r"(?:is\s+|are\s+)?not\s+(?:empty|blank|missing|null)|(?:is\s+)?(?:filled|present)|has\s+(?:a\s+)?value", "not_empty"),
        (r"(?:is\s+|are\s+)?(?:empty|blank|missing|null)", "is_empty"),
        (r"(?:is\s+|are\s+)?(?:>=|=>|at\s+least|greater\s+than\s+or\s+equal\s+to|not\s+less\s+than|min(?:imum)?|since|on\s+or\s+after)\s*(.+)", "gte"),
        (r"(?:is\s+|are\s+)?(?:<=|=<|at\s+most|less\s+than\s+or\s+equal\s+to|not\s+more\s+than|up\s+to|max(?:imum)?|until|till|on\s+or\s+before)\s*(.+)", "lte"),
        (r"(?:is\s+|are\s+)?(?:>|greater\s+than|more\s+than|higher\s+than|larger\s+than|bigger\s+than|above|over|exceeds?|exceeding|after|later\s+than)\s*(.+)", "gt"),
        (r"(?:is\s+|are\s+)?(?:<|less\s+than|lower\s+than|smaller\s+than|below|under|before|earlier\s+than)\s*(.+)", "lt"),
        (r"(?:does\s*n[o']?t|doesnt|do\s*n[o']?t)\s+(?:contain|include|have|mention)\s+(.+)", "not_contains"),
        (r"(?:contains?|includes?|has|having|mentions?|with|like)\s+(.+)", "contains"),
        (r"(?:is\s+|are\s+)?not\s+(?:in|one\s+of|any\s+of)\s+(.+)", "not_in"),
        (r"(?:is\s+|are\s+)?(?:in|one\s+of|any\s+of)\s+(.+)", "in"),
        (r"(?:is\s+not|are\s+not|isn'?t|aren'?t|!=|<>|not\s+equals?(?:\s+to)?|not|except|other\s+than)\s+(.+)", "not_equals"),
        (r"(?:(?:is\s+equal\s+to|equals?(?:\s+to)?|is|are|of|as)\b|==|=|:)\s*(.+)", "equals"),
        (r"(.+)", "equals_implicit"),
    ]

    def parse_op(self, col: str, seg: str, require_op: bool = False) -> tuple[list[Condition], int]:
        """Parse '<operator> <value>' right after a column. Returns (conditions, chars consumed)."""
        s = re.sub(r"^(?:(?:where|whose|value|column|field)\s+)+", "", seg.lstrip(" ,:"), flags=re.I)
        lead = len(seg) - len(s)
        s = s.rstrip(" ,:")
        if not s:
            return [], 0
        numeric = col in self.numeric_cols
        is_date = col in self.date_cols
        for pattern, op in self.OPS:
            if require_op and op in ("equals", "equals_implicit"):
                continue
            m = re.match(pattern, s, re.I)
            if not m:
                continue
            if op in ("is_empty", "not_empty"):
                return [Condition(column=col, operator=op)], lead + m.end()
            if op == "between":
                lo, lo_used = self._scalar(col, m.group(1))
                hi, hi_used = self._scalar(col, m.group(2))
                if lo is None or hi is None:
                    continue
                used = m.start(2) + hi_used
                return [Condition(column=col, operator="gte", value=lo),
                        Condition(column=col, operator="lte", value=hi)], lead + used
            if op in ("gt", "gte", "lt", "lte"):
                if not (numeric or is_date):
                    continue
                v, v_used = self._scalar(col, m.group(1))
                if v is None:
                    continue
                return [Condition(column=col, operator=op, value=v)], lead + m.start(1) + v_used
            if is_date and op in ("equals", "equals_implicit"):
                # "date is 01/03/2024" means that whole day.
                v, v_used = self._scalar(col, m.group(1))
                if v is None:
                    continue
                nxt = (date.fromisoformat(v) + timedelta(days=1)).isoformat()
                return [Condition(column=col, operator="gte", value=v),
                        Condition(column=col, operator="lt", value=nxt)], lead + m.start(1) + v_used
            raw = _clean_value(m.group(1))
            if not raw or _key(raw) in FILLER_WORDS:
                continue
            if op in ("contains", "not_contains"):
                return [Condition(column=col, operator=op, value=raw)], len(seg)
            if op in ("in", "not_in"):
                vals = self.resolve_values(col, raw)
                return [Condition(column=col, operator=op, values=vals)], len(seg)
            if op == "equals_implicit":
                # No "is"/"=": accept only if it's clearly a value of this column.
                try:
                    vals = self.resolve_values(col, raw)
                except ParseError:
                    return [], 0
            else:
                vals = self.resolve_values(col, raw)
            neg = op == "not_equals"
            if len(vals) > 1:
                return [Condition(column=col, operator="not_in" if neg else "in", values=vals)], len(seg)
            return [Condition(column=col, operator="not_equals" if neg else "equals", value=vals[0])], len(seg)
        return [], 0

    def _scalar(self, col: str, text: str) -> tuple[str | None, int]:
        """Leading number or date in `text` (as the engine expects it) and chars consumed."""
        if col in self.date_cols:
            m = re.match(r"\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}"
                         r"|\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|[a-z]{3,9}\s+\d{4})", text, re.I)
            v = parse_date(m.group(1)) if m else None
            return (v, m.end()) if v else (None, 0)
        m = re.match(r"\s*([₹$€£]?\s*(?:rs\.?\s*|inr\s*)?-?[\d,]*\.?\d+\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr|mn|m|million|bn|b|billion)?)(?![a-z])",
                     text, re.I)
        n = parse_number(m.group(1)) if m else None
        return (_fmt(n), m.end()) if n is not None else (None, 0)


def _move_period_words(head: str, tail: str) -> tuple[str, str]:
    """In "monthly total amount by category" the period word joins the group-by columns."""
    words = re.findall(r"\b(?:daily|weekly|monthly|quarterly|yearly|annual(?:ly)?)\b", head, re.I)
    if not words:
        return head, tail
    head = re.sub(r"\b(?:daily|weekly|monthly|quarterly|yearly|annual(?:ly)?)\b", " ", head, flags=re.I)
    return head, " ".join(words) + " " + tail


def _unquote(v: str) -> str:
    v = v.strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v


def _clean_value(v: str) -> str:
    v = v.strip().strip(".,")
    v = re.sub(r"\s+(?:only|rows?|records?|entries|transactions?|ones)$", "", v, flags=re.I)
    return v.strip().strip("'\"")


def _split_list(raw: str) -> list[str]:
    return [p.strip().strip("'\"") for p in re.split(r"\s*,\s*|\s+or\s+|\s+and\s+|\s*/\s*", raw) if p.strip()]


NEGATIONS = {"equals": "not_equals", "contains": "not_contains", "in": "not_in", "is_empty": "not_empty",
             "gt": "lte", "gte": "lt", "within_last_days": "older_than_days"}
NEGATIONS |= {v: k for k, v in NEGATIONS.items()}


def _negate(c: Condition) -> Condition:
    return c.model_copy(update={"operator": NEGATIONS[c.operator]})


def _merge_same_column(conds: list[Condition], match: str) -> tuple[list[Condition], str]:
    """'category is food and travel' can never match with AND; the user means either one."""
    if match != "all":
        return conds, match
    groups: dict[str, list[Condition]] = {}
    for c in conds:
        if c.operator in ("equals", "in"):
            groups.setdefault(c.column, []).append(c)
    out, done = [], set()
    for c in conds:
        g = groups.get(c.column, [])
        if c.operator in ("equals", "in") and len(g) > 1:
            if c.column not in done:
                vals = [v for x in g for v in (x.values or [x.value])]
                out.append(Condition(column=c.column, operator="in", values=list(dict.fromkeys(vals))))
                done.add(c.column)
        else:
            out.append(c)
    return out, match


OP_TEXT = {"equals": "is", "not_equals": "is not", "contains": "contains", "not_contains": "does not contain",
           "in": "is one of", "not_in": "is not one of", "is_empty": "is empty", "not_empty": "is not empty",
           "gt": ">", "gte": "≥", "lt": "<", "lte": "≤",
           "within_last_days": "is within the last", "older_than_days": "is older than"}


def describe(step: Step) -> str:
    match step.op:
        case "filter":
            parts = []
            for c in step.conditions:
                v = ", ".join(c.values) if c.values else (c.value or "")
                if c.operator in ("within_last_days", "older_than_days"):
                    v += " days"
                parts.append(f"{c.column} {OP_TEXT[c.operator]} {v}".strip())
            return "Keep rows where " + (" and " if step.match == "all" else " or ").join(parts)
        case "select_columns":
            return "Keep only columns " + ", ".join(step.columns)
        case "drop_columns":
            return "Remove columns " + ", ".join(step.columns)
        case "sort":
            return f"Sort by {', '.join(step.columns)} ({'ascending' if step.ascending else 'descending'})"
        case "dedupe":
            by = f" by {', '.join(step.columns)}" if step.columns else " (whole row)"
            return f"Remove duplicate rows{by}, keeping the {step.keep}"
        case "group_by":
            aggs = ", ".join(f"{a.func} of {a.column}" for a in step.aggregations)
            return f"Group by {', '.join(step.columns)} with {aggs}"
        case "split_by":
            return f"Split into one sheet per {step.column}"
        case "pivot":
            what = f"{step.func} of {step.values}" if step.values else "count of rows"
            across = f", {', '.join(step.columns)} across the top" if step.columns else ""
            return f"Pivot: {what} with {', '.join(step.rows)} down the side{across}" + (", with totals" if step.totals else "")
        case "top_n":
            if step.column is None:
                return f"Keep the {'first' if step.largest else 'last'} {step.n} rows"
            per = f" within each {', '.join(step.per)}" if step.per else ""
            return f"Keep the {step.n} {'highest' if step.largest else 'lowest'} by {step.column}{per}"
        case "date_part":
            return f"Add column '{step.name}' = {step.part} of {step.column}"
        case "calculate":
            per = f" within each {', '.join(step.per)}" if step.per else ""
            what = {"percent_of_total": f"{step.column} as % of total",
                    "running_total": f"running total of {step.column}",
                    "rank": f"rank by {step.column} ({'highest' if step.descending else 'lowest'} = 1)"}[step.kind]
            return f"Add column '{step.name}' = {what}{per}"
        case "clean_text":
            where = ", ".join(step.columns) if step.columns else "all text columns"
            what = {"trim": "Trim extra spaces", "upper": "Make UPPERCASE", "lower": "Make lowercase",
                    "title": "Make Title Case"}[step.action]
            return f"{what} in {where}"
        case "fill_blanks":
            where = ", ".join(step.columns) if step.columns else "all columns"
            how = {"value": f"with '{step.value}'", "down": "with the value above", "up": "with the value below"}[step.method]
            return f"Fill blank cells in {where} {how}"
        case "drop_blank_rows":
            return "Remove completely empty rows" if step.how == "all" else "Remove rows that have any empty cell"
        case "replace":
            where = ", ".join(step.columns) if step.columns else "all text columns"
            to = f"'{step.replace}'" if step.replace else "nothing (remove it)"
            return f"Replace '{step.find}' with {to} in {where}"
        case "split_column":
            d = {" ": "space", "\t": "tab"}.get(step.delimiter, f"'{step.delimiter}'")
            return f"Split {step.column} at each {d} into new columns {', '.join(step.names)} (original kept)"
        case "merge_columns":
            sep = {" ": "a space", "": "nothing"}.get(step.separator, f"'{step.separator}'")
            return f"Combine {', '.join(step.columns)} into new column '{step.name}', separated by {sep}"
        case "rename":
            return "Rename " + ", ".join(f"{a} → {b}" for a, b in step.mapping.items())
        case "convert":
            return f"Convert {', '.join(step.columns)} to {step.to}"
        case "compute":
            formula = re.sub(r"\[([^\]]+)\]", r"\1", step.expr)
            return f"{'Replace' if step.replace else 'Add'} column '{step.name}' = {formula}"
        case "label":
            rules = "; ".join(f"'{c.value}' if " + describe(c.when).removeprefix("Keep rows where ") for c in step.cases)
            other = (f"; otherwise '{step.default}'" if step.default is not None
                     else "; otherwise keep the current value" if step.replace else "; otherwise blank")
            return f"{'Replace' if step.replace else 'Add'} column '{step.name}': {rules}{other}"
    return step.op


def split_clauses(request: str) -> list[str]:
    text = request.strip().translate(SMART_QUOTES)
    # Quoted text ('"Rs. "', '", "') is set aside so the splitting below can't break it up.
    quoted: list[str] = []
    text = QUOTED.sub(lambda m: quoted.append(m.group()) or f"__Q{len(quoted) - 1}__", text)
    text = re.sub(r",(?=[^\s\d])", ", ", text)  # "date,amount" -> "date, amount"; not "5,000"
    clauses = []
    for clause in CLAUSE_SPLIT.split(text):
        if not clause or not clause.strip(" ,."):
            continue
        clause = re.sub(r"^(?:(?:and|also|then|now|please|actually|next|finally)\b[\s,]*)+", "", clause.strip(" ,."), flags=re.I)
        clauses.append(re.sub(r"__Q(\d+)__", lambda m: quoted[int(m.group(1))], clause))
    return clauses


def make_plan(sheets: Sheets, request: str) -> Plan:
    try:
        clauses = split_clauses(request)
        if not clauses:
            raise ParseError("Tell me what you'd like to do with the data.")
        steps: list[Step] = []
        for i, clause in enumerate(clauses):
            new = Parser(sheets).parse_clause(clause)
            steps += new
            if i < len(clauses) - 1:
                # Later parts see the result so far: "add column gst = ... and sort by gst".
                sheets = apply_plan(sheets, Plan(summary="", steps=new))
        return Plan(summary="; ".join(describe(s) for s in steps) + ".", steps=steps)
    except ParseError as e:
        return Plan(clarification_question=str(e), summary="", steps=[])
    except PlanError as e:
        return Plan(clarification_question=f"That can't run on this data: {e}", summary="", steps=[])
