/** Formatting that changes how the result looks in Excel, not the data: highlights, number formats, charts. */
import { PlanError, col, need } from "./core";
import { filterMask } from "./engine";
import { groupBy } from "./aggregate";
import { addDatePart } from "./engine";
import { matchKey } from "./files";
import type { ChartStep, HighlightStep, NumberFormatStep, Step } from "./plan";
import { Sheets, Table, combine, pick } from "./table";

export type FormatStep = HighlightStep | NumberFormatStep | ChartStep;
export const isFormatStep = (s: Step): s is FormatStep => s.op === "highlight" || s.op === "number_format" || s.op === "chart";

/** Columns a formatting step refers to. */
export function formatColumns(step: FormatStep): string[] {
  switch (step.op) {
    case "highlight":
      return [...(step.when ? step.when.conditions.map((c) => c.column) : []), ...[step.duplicates_in, step.column].filter((c): c is string => !!c)];
    case "number_format": return step.columns ?? [];
    case "chart":
      return [step.x, ...(step.y ? [step.y] : []), ...(step.when ? step.when.conditions.map((c) => c.column) : [])];
  }
}

/** Which rows of `t` a highlight step colours. */
export function highlightMask(t: Table, step: HighlightStep): boolean[] {
  if (step.duplicates_in) {
    const keys = col(t, step.duplicates_in).values.map(matchKey);
    const count = new Map<string, number>();
    for (const k of keys) if (k !== null) count.set(k, (count.get(k) ?? 0) + 1);
    return keys.map((k) => k !== null && count.get(k)! > 1);
  }
  return filterMask(t, step.when!);
}

const isRealDates = (t: Table, name: string): boolean => {
  const c = col(t, name);
  return c.kind === "date" && !c.values.some((v) => typeof v === "string");
};

const n = (x: number) => x.toLocaleString("en-US");

/** Excel number format for a style (Indian digit grouping for rupees). */
export function excelNumberFormat(step: NumberFormatStep): string {
  switch (step.style) {
    case "date": return step.date_pattern;
    case "decimals": return "#,##0" + (step.decimals ? "." + "0".repeat(step.decimals) : "");
    case "rupees": return '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00';
    case "commas": return "#,##0.00";
    case "percent": return '0.00"%"'; // values like 15.79 are already percentages
  }
}

/** Check a formatting step against the data it will be applied to; adds what the user should know to `notes`. */
export function checkFormat(t: Table, step: FormatStep, notes: string[]): void {
  need(t, formatColumns(step));
  if (step.op === "highlight") {
    notes.push(`${n(highlightMask(t, step).filter(Boolean).length)} of ${n(t.nrows)} rows will be highlighted.`);
  }
  if (step.op === "number_format" && step.style === "date") {
    const text = (step.columns ?? []).filter((c) => !isRealDates(t, c));
    if (text.length) throw new PlanError(`${text.join(", ")} isn't stored as dates. Convert it first: convert ${text[0]} to date`);
  }
  if (step.op === "number_format" && step.style !== "date") {
    const text = (step.columns ?? []).filter((c) => col(t, c).kind !== "number");
    if (text.length) throw new PlanError(`${text.join(", ")} holds text, so a number format won't show. Convert it first: convert ${text[0]} to number`);
  }
  if (step.op === "chart") {
    const rows = chartTable(t, step).nrows;
    if (rows > 50) throw new PlanError(`That chart would have ${n(rows)} bars/points. Chart by a column with fewer values.`);
  }
  notes.push("Formatting and charts are applied to the new sheet(s).");
}

/** The small summary table a chart is drawn from: one row per bar / point. */
export function chartTable(t: Table, step: ChartStep): Table {
  let data = step.when ? pick(t, filterMask(t, step.when).flatMap((f, i) => (f ? [i] : []))) : t;
  const label = step.x_part ?? step.x;
  if (step.x_part) data = addDatePart(data, { op: "date_part", column: step.x, part: step.x_part, name: label });
  const xs = col(data, label).values; // rows with no value to chart by are left out, like Excel's own chart
  data = pick(data, xs.flatMap((v, i) => (v === null || (typeof v === "string" && v.trim() === "") ? [] : [i])));
  const grouped = groupBy(data, {
    op: "group_by", columns: [label], calculated: {},
    aggregations: [step.y === null ? { column: label, func: "count" } : { column: step.y, func: step.func === "count" ? "count" : step.func }],
  });
  const value = grouped.columns[1];
  value.name = step.y === null ? "count" : `${step.func} of ${step.y}`;
  return grouped;
}

/** Format steps that still make sense on the final sheets (a column dropped later is skipped). */
export function liveFormats(formats: FormatStep[], sheets: Sheets): FormatStep[] {
  const all = new Set([...sheets.values()].flatMap((t) => t.columns.map((c) => c.name)));
  return formats.filter((f) => formatColumns(f).every((c) => all.has(c)));
}

export const allRows = (sheets: Sheets): Table => combine(sheets);
