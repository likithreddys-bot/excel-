/** Runs a Plan on tables. Pure functions: the only code that touches the data. */
import type { ComputeStep, Condition, DatePart, DatePartStep, FilterStep, LabelStep, Plan, Step } from "./plan";
import { calculate, groupBy, pivot, topN } from "./aggregate";
import { cleanText, convertColumns, dropBlankRows, fillBlanks, mergeColumns, renameColumns, replaceText, splitColumn } from "./clean";
import { evaluate } from "./evaluate";
import { append, compare as compareSheets, lookup } from "./files";
import { checkFormat } from "./format";
import { PlanError, SortKey, col, compareKeys, keyLabel, need, numberOf, sortKeys, sortRows } from "./core";
import { Cell, Column, Sheets, Table, getColumn, makeColumn, pick, timesOf } from "./table";
import { DAY_MS, isoDay, parseDateText, todayMs } from "./util";

export { PlanError };

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ---------- filtering ----------

const textOf = (v: Cell): string => (v === null ? "" : String(v).trim().toLowerCase());

function compare(c: Column, op: "gt" | "gte" | "lt" | "lte", value: string): boolean[] {
  const cmp = (a: number, b: number) =>
    op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b; // NaN compares false, like a blank
  if (c.kind !== "date" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    const v = Number(value);
    return c.values.map((x) => cmp(numberOf(x), v));
  }
  const v = parseDateText(value);
  if (v === null) throw new PlanError(`'${value}' is not a number or a date`);
  return timesOf(c).map((t) => (t === null ? false : cmp(t, v)));
}

function mask(t: Table, c: Condition): boolean[] {
  const column = col(t, c.column);
  const val = (c.value ?? "").trim().toLowerCase();
  const vals = (c.values ?? []).map((v) => v.trim().toLowerCase());
  const numeric = column.kind === "number";
  if ((c.operator === "equals" || c.operator === "not_equals") && numeric) {
    const target = Number(c.value);
    return column.values.map((x) => (numberOf(x) === target) === (c.operator === "equals"));
  }
  if ((c.operator === "in" || c.operator === "not_in") && numeric) {
    const targets = new Set((c.values ?? []).map(Number));
    return column.values.map((x) => targets.has(numberOf(x)) === (c.operator === "in"));
  }
  const text = column.values.map(textOf);
  switch (c.operator) {
    case "equals": return text.map((x) => x === val);
    case "not_equals": return text.map((x) => x !== val);
    case "contains": return text.map((x) => x.includes(val));
    case "not_contains": return text.map((x) => !x.includes(val));
    case "in": return text.map((x) => vals.includes(x));
    case "not_in": return text.map((x) => !vals.includes(x));
    case "is_empty": return text.map((x) => x === "");
    case "not_empty": return text.map((x) => x !== "");
    case "gt": case "gte": case "lt": case "lte": return compare(column, c.operator, c.value ?? "");
    case "within_last_days": {
      const cutoff = todayMs() - Number(c.value) * DAY_MS;
      return timesOf(column).map((x) => x !== null && x >= cutoff);
    }
    case "older_than_days": {
      const cutoff = todayMs() - Number(c.value) * DAY_MS;
      return timesOf(column).map((x) => x !== null && x < cutoff);
    }
  }
  throw new PlanError(`Unknown operator ${c.operator}`);
}

export function filterMask(t: Table, step: FilterStep): boolean[] {
  const masks = step.conditions.map((c) => mask(t, c));
  return Array.from({ length: t.nrows }, (_, i) =>
    step.match === "all" ? masks.every((m) => m[i]) : masks.some((m) => m[i]));
}

const where = (flags: boolean[]): number[] => flags.flatMap((f, i) => (f ? [i] : []));

// ---------- dates ----------

function isoWeek(ms: number): { year: number; week: number } {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const thursday = d.getTime();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const firstThursday = Date.UTC(year, 0, 1 + ((4 - jan1.getUTCDay() + 7) % 7));
  return { year, week: 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS)) };
}

export function datePartValues(c: Column, part: DatePart): Cell[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return timesOf(c).map((ms) => {
    if (ms === null) return null;
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    switch (part) {
      case "year": return y;
      case "quarter": return `${y}-Q${Math.ceil(m / 3)}`;
      case "month": return `${y}-${pad(m)}`;
      case "week": { const w = isoWeek(ms); return `${w.year}-W${pad(w.week)}`; }
      case "weekday": return WEEKDAYS[(d.getUTCDay() + 6) % 7];
      case "day": return isoDay(ms);
    }
  });
}

export function addDatePart(t: Table, step: DatePartStep): Table {
  const source = col(t, step.column);
  const made = makeColumn(step.name, datePartValues(source, step.part));
  if (step.part === "weekday") made.order = WEEKDAYS;
  const columns = t.columns.filter((c) => c.name !== step.name).concat(made);
  return { columns, nrows: t.nrows };
}

// ---------- the steps ----------

function dedupe(t: Table, cols: string[] | null, keep: "first" | "last"): Table {
  const use = cols?.length ? cols.map((n) => col(t, n)) : t.columns;
  const keyOf = (i: number) => JSON.stringify(use.map((c) => c.values[i]));
  const seen = new Map<string, number>();
  for (let i = 0; i < t.nrows; i++) {
    const k = keyOf(i);
    if (keep === "last" || !seen.has(k)) seen.set(k, i);
  }
  return pick(t, [...seen.values()].sort((a, b) => a - b));
}

function sheetName(parent: string, key: string, totalParents: number): string {
  let name = totalParents === 1 ? key : `${parent}-${key}`;
  name = name.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "");
  return name.slice(0, 31) || "blank";
}

function splitBy(t: Table, name: string): [string, Table][] {
  const c = col(t, name);
  const keys = sortKeys(c);
  const groups = new Map<string, number[]>();
  const sortOf = new Map<string, SortKey>();
  for (let i = 0; i < t.nrows; i++) {
    const label = keyLabel(c, c.values[i], i);
    if (!groups.has(label)) { groups.set(label, []); sortOf.set(label, keys[i]); }
    groups.get(label)!.push(i);
  }
  const labels = [...groups.keys()].sort((a, b) => {
    const ka = sortOf.get(a)!, kb = sortOf.get(b)!;
    if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
    return compareKeys(ka, kb);
  });
  return labels.map((l) => [l, pick(t, groups.get(l)!)]);
}

export type Files = Record<string, Table>;

function otherSheet(files: Files, name: string): Table {
  const t = files[name];
  if (!t) throw new PlanError(`The sheet '${name}' isn't available.`);
  return t;
}

function checkNew(t: Table, name: string, replace: boolean): void {
  if (getColumn(t, name) && !replace) throw new PlanError(`There is already a column called ${name}. Use 'set ${name} = ...' to overwrite it.`);
}

/** Add `made` as a new last column, or replace the column of the same name where it stands. */
function putColumn(t: Table, made: Column): Table {
  const at = t.columns.findIndex((c) => c.name === made.name);
  const columns = at < 0 ? [...t.columns, made] : t.columns.map((c, i) => (i === at ? made : c));
  return { columns, nrows: t.nrows };
}

function compute(t: Table, step: ComputeStep): Table {
  checkNew(t, step.name, step.replace);
  const old = getColumn(t, step.name);
  return putColumn(t, makeColumn(step.name, evaluate(t, step.expr), old?.format));
}

function label(t: Table, step: LabelStep): Table {
  checkNew(t, step.name, step.replace);
  const masks = step.cases.map((c) => filterMask(t, c.when));
  const values = step.cases.map((c) => c.value).concat(step.default !== null ? [step.default] : []);
  const old = getColumn(t, step.name);
  // Overwriting a column with no "else": rows that match no rule keep their current value.
  const keep = step.replace && step.default === null;
  const numeric = values.every((v) => /^-?\d+(\.\d+)?$/.test(v)) && (!keep || old?.kind === "number");
  const put = (v: string): Cell => (numeric ? parseFloat(v) : v);
  const out: Cell[] = keep ? [...old!.values] : new Array(t.nrows).fill(null);
  if (step.default !== null) out.fill(put(step.default));
  for (let k = step.cases.length - 1; k >= 0; k--) { // first matching case wins
    for (let i = 0; i < t.nrows; i++) if (masks[k][i]) out[i] = put(step.cases[k].value);
  }
  return putColumn(t, makeColumn(step.name, out, old?.format));
}

function unsupported(step: Step): never {
  throw new PlanError(`The '${step.op}' step isn't available in this version of the add-in yet.`);
}

function applyStep(t: Table, step: Step, files: Files, notes: string[]): Table | [string, Table][] {
  switch (step.op) {
    case "filter": return pick(t, where(filterMask(t, step)));
    case "select_columns":
      need(t, step.columns);
      return { nrows: t.nrows, columns: step.columns.map((n) => getColumn(t, n)!) };
    case "drop_columns":
      need(t, step.columns);
      return { nrows: t.nrows, columns: t.columns.filter((c) => !step.columns.includes(c.name)) };
    case "sort": need(t, step.columns); return pick(t, sortRows(t, step.columns, step.ascending));
    case "dedupe": need(t, step.columns ?? []); return dedupe(t, step.columns, step.keep);
    case "split_by": return splitBy(t, step.column);
    case "date_part": return addDatePart(t, step);
    case "group_by": return groupBy(t, step);
    case "pivot": return pivot(t, step);
    case "top_n": return topN(t, step);
    case "calculate": return calculate(t, step);
    case "clean_text": return cleanText(t, step);
    case "fill_blanks": return fillBlanks(t, step);
    case "drop_blank_rows": return dropBlankRows(t, step);
    case "replace": return replaceText(t, step);
    case "split_column": return splitColumn(t, step);
    case "merge_columns": return mergeColumns(t, step);
    case "rename": return renameColumns(t, step);
    case "convert": return convertColumns(t, step);
    case "highlight": case "number_format": case "chart": checkFormat(t, step, notes); return t; // data unchanged
    case "lookup": return lookup(t, step, otherSheet(files, step.file), notes);
    case "append": return append(t, step, otherSheet(files, step.file), notes);
    case "compare": return compareSheets(t, step, otherSheet(files, step.file), notes);
    case "compute": return compute(t, step);
    case "label": return label(t, step);
    default: return unsupported(step);
  }
}

/** Run every step on every sheet. Splitting creates several sheets, later steps apply to each. */
export function applyPlan(sheets: Sheets, plan: Plan, files: Files = {}, notes: string[] = []): Sheets {
  let current = sheets;
  for (const step of plan.steps) {
    const next: Sheets = new Map();
    const used = new Set<string>();
    for (const [name, table] of current) {
      const mine: string[] = [];
      const out = applyStep(table, step, files, mine);
      notes.push(...mine.map((m) => (current.size > 1 ? `${name}: ${m}` : m)));
      if (Array.isArray(out)) {
        for (const [key, part] of out) {
          let n = sheetName(name, key, current.size), base = n, i = 2;
          while (used.has(n.toLowerCase())) {
            const suffix = ` (${i++})`;
            n = base.slice(0, 31 - suffix.length) + suffix;
          }
          used.add(n.toLowerCase());
          next.set(n, part);
        }
      } else {
        used.add(name.toLowerCase());
        next.set(name, out);
      }
    }
    current = next;
  }
  return current;
}

export function rowCounts(sheets: Sheets): Record<string, number> {
  return Object.fromEntries([...sheets].map(([n, t]) => [n, t.nrows]));
}
