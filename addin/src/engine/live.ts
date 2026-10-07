/**
 * "Keep it live": results that Excel keeps up to date itself. New columns become real formulas in the result table,
 * and a plain pivot or total becomes a native PivotTable on the original data. Anything that can't be expressed
 * exactly stays as values, so the preview is always what you get.
 */
import { FormulaSyntaxError, columnResolver, toExcelFormula } from "./formula";
import type { Condition, FilterStep, LabelStep, Plan, Step } from "./plan";
import { Column, Table } from "./table";

export interface LiveColumn {
  name: string;
  /** The Excel formula for this column, given the name of the Excel Table it sits in. */
  build: (tableName: string) => string;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const ref = (c: string) => `[@[${c.replace(/([[\]#'])/g, "'$1")}]]`;

/** One filter condition as an Excel test on this row, or null when Excel can't match the add-in's result exactly. */
function conditionToExcel(c: Condition, col: Column): string | null {
  const r = ref(c.column);
  const isNumber = col.kind === "number";
  const realDate = col.kind === "date" && !col.values.some((v) => typeof v === "string");
  const text = (v: string) => q(v.trim());
  const search = (v: string) => `ISNUMBER(SEARCH(${q(v.trim().replace(/([~*?])/g, "~$1"))},${r}))`;
  switch (c.operator) {
    case "equals": return isNumber ? `${r}=${Number(c.value)}` : col.kind === "text" ? `TRIM(${r})=${text(c.value ?? "")}` : null;
    case "not_equals": return isNumber ? `${r}<>${Number(c.value)}` : col.kind === "text" ? `TRIM(${r})<>${text(c.value ?? "")}` : null;
    case "in": return isNumber ? `OR(${(c.values ?? []).map((v) => `${r}=${Number(v)}`).join(",")})` : col.kind === "text" ? `OR(${(c.values ?? []).map((v) => `TRIM(${r})=${text(v)}`).join(",")})` : null;
    case "not_in": return isNumber ? `AND(${(c.values ?? []).map((v) => `${r}<>${Number(v)}`).join(",")})` : col.kind === "text" ? `AND(${(c.values ?? []).map((v) => `TRIM(${r})<>${text(v)}`).join(",")})` : null;
    case "contains": return col.kind === "text" ? search(c.value ?? "") : null;
    case "not_contains": return col.kind === "text" ? `NOT(${search(c.value ?? "")})` : null;
    case "is_empty": return `LEN(TRIM(${r}))=0`;
    case "not_empty": return `LEN(TRIM(${r}))>0`;
    case "gt": case "gte": case "lt": case "lte": {
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[c.operator];
      if (isNumber && !Number.isNaN(Number(c.value))) return `${r}${op}${Number(c.value)}`;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.value ?? "");
      return realDate && m ? `AND(ISNUMBER(${r}),${r}${op}DATE(${+m[1]},${+m[2]},${+m[3]}))` : null;
    }
    case "within_last_days": return realDate ? `AND(ISNUMBER(${r}),${r}>=TODAY()-${Number(c.value)})` : null;
    case "older_than_days": return realDate ? `AND(ISNUMBER(${r}),${r}<TODAY()-${Number(c.value)})` : null;
  }
}

function filterToExcel(f: FilterStep, kinds: (name: string) => Column | undefined): string | null {
  const parts: string[] = [];
  for (const c of f.conditions) {
    const col = kinds(c.column);
    const x = col ? conditionToExcel(c, col) : null;
    if (x === null) return null;
    parts.push(x);
  }
  return parts.length === 1 ? parts[0] : `${f.match === "all" ? "AND" : "OR"}(${parts.join(",")})`;
}

function labelToExcel(step: LabelStep, kinds: (name: string) => Column | undefined): string | null {
  if (step.replace) return null;
  const numeric = [...step.cases.map((c) => c.value), ...(step.default !== null ? [step.default] : [])].every((v) => /^-?\d+(\.\d+)?$/.test(v));
  const value = (v: string) => (numeric ? String(parseFloat(v)) : q(v));
  let out = step.default !== null ? value(step.default) : '""';
  for (let i = step.cases.length - 1; i >= 0; i--) {
    const cond = filterToExcel(step.cases[i].when, kinds);
    if (cond === null) return null;
    out = `IF(${cond},${value(step.cases[i].value)},${out})`;
  }
  return "=" + out;
}

/**
 * Columns of the result that can be real formulas: every step must be a calculated-column step, and each one is
 * checked on its own (a column that can't be written exactly as a formula simply stays as values).
 */
export function liveColumns(plan: Plan, result: Table): LiveColumn[] | null {
  if (!plan.steps.length || !plan.steps.every((s) => s.op === "formula" || s.op === "compute" || s.op === "label")) return null;
  const kinds = (name: string) => result.columns.find((c) => c.name === name);
  const resolve = columnResolver(result.columns.map((c) => c.name));
  const out: LiveColumn[] = [];
  for (const step of plan.steps as Step[]) {
    try {
      if (step.op === "formula" && !step.replace) {
        out.push({ name: step.name, build: (t) => toExcelFormula(step.formula, t, resolve) });
      } else if (step.op === "compute" && !step.replace && !/[a-z_]+\s*\(/i.test(step.expr)) {
        out.push({ name: step.name, build: (t) => toExcelFormula(step.expr, t, resolve) });
      } else if (step.op === "label") {
        const f = labelToExcel(step, kinds);
        if (f !== null) out.push({ name: step.name, build: () => f });
      }
    } catch (e) {
      if (!(e instanceof FormulaSyntaxError)) throw e; // a formula that doesn't translate just stays as values
    }
  }
  return out.length ? out : null;
}

// ---------- native PivotTable ----------

export type PivotFunc = "Sum" | "Count" | "Average" | "Min" | "Max";
export interface PivotSpec {
  rows: string[];
  columns: string[];
  data: { column: string; func: PivotFunc; name: string }[];
}

const FUNC_NAME: Record<string, PivotFunc | undefined> = { sum: "Sum", count: "Count", mean: "Average", min: "Min", max: "Max" };
const TITLE: Record<PivotFunc, string> = { Sum: "Sum", Count: "Count", Average: "Average", Min: "Min", Max: "Max" };

/** A native PivotTable for a plan that is just one pivot or total on the original columns, else null. */
export function livePivot(plan: Plan, source: Table): PivotSpec | null {
  if (plan.steps.length !== 1) return null;
  const step = plan.steps[0];
  const names = new Set(source.columns.map((c) => c.name));
  if (names.size !== source.columns.length) return null; // duplicate headers can't make a PivotTable
  const spec = (rows: string[], columns: string[], data: { column: string; func: PivotFunc }[]): PivotSpec | null => {
    if (![...rows, ...columns, ...data.map((d) => d.column)].every((c) => names.has(c))) return null;
    return { rows, columns, data: data.map((d) => ({ ...d, name: `${TITLE[d.func]} of ${d.column}` })) };
  };
  if (step.op === "pivot") {
    if (Object.keys(step.calculated).length) return null;
    const func = FUNC_NAME[step.func];
    if (!func) return null;
    return spec(step.rows, step.columns, [{ column: step.values ?? step.rows[0], func: step.values ? func : "Count" }]);
  }
  if (step.op === "group_by") {
    if (Object.keys(step.calculated).length || !step.aggregations.length) return null;
    const data = step.aggregations.map((a) => ({ column: a.column, func: FUNC_NAME[a.func] }));
    if (data.some((d) => !d.func)) return null;
    return spec(step.columns, [], data as { column: string; func: PivotFunc }[]);
  }
  return null;
}
