/** Helpers shared by the engine's steps. */
import { Cell, Column, Table, getColumn, timesOf } from "./table";
import { isoDay, cmpText } from "./util";

export class PlanError extends Error {}

export function need(t: Table, cols: string[]): void {
  const missing = cols.filter((c) => !getColumn(t, c));
  if (missing.length) throw new PlanError(`Unknown column(s): ${missing.join(", ")}`);
}

export function col(t: Table, name: string): Column {
  need(t, [name]);
  return getColumn(t, name)!;
}

/** A cell as a number: numbers as-is, numeric-looking text read like pandas to_numeric, else NaN. */
export function numberOf(v: Cell): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v.trim());
  return NaN;
}


export type SortKey = number | string | null;

export function sortKeys(c: Column): SortKey[] {
  if (c.kind === "date") return timesOf(c);
  if (c.kind === "number") return c.values.map((v) => (typeof v === "number" && !Number.isNaN(v) ? v : null));
  const rank = c.order ? new Map(c.order.map((v, i) => [v, i])) : null;
  return c.values.map((v) => (v === null ? null : rank ? (rank.get(String(v)) ?? c.order!.length) : String(v)));
}

export function compareKeys(a: SortKey, b: SortKey): number {
  return typeof a === "number" && typeof b === "number" ? a - b : cmpText(String(a), String(b));
}

export function sortRows(t: Table, cols: string[], ascending: boolean): number[] {
  const keys = cols.map((n) => sortKeys(col(t, n)));
  const idx = Array.from({ length: t.nrows }, (_, i) => i);
  return idx.sort((i, j) => {
    for (const k of keys) {
      const a = k[i], b = k[j];
      if (a === null || b === null) {
        if (a === b) continue;
        return a === null ? 1 : -1; // blanks always last
      }
      const d = compareKeys(a, b);
      if (d !== 0) return ascending ? d : -d;
    }
    return 0;
  });
}


export const keyLabel = (c: Column, v: Cell, i: number): string => {
  if (v === null || (typeof v === "string" && v.trim() === "")) return "(blank)";
  if (c.kind === "date" && c.time?.[i] != null) return isoDay(c.time[i]!);
  return typeof v === "number" ? String(v) : String(v);
};

