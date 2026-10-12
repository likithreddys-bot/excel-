/**
 * What the assistant knows about a sheet: for every column its type, a guess at its role, how empty it is, and
 * (only where it is safe) the values it holds. This is the only thing about the data a model ever receives.
 *
 * Values are sent only for columns with few distinct values (a state, a status, a 0/1 flag), and never for
 * columns that look personal (phone, PAN, e-mail, account number, ...) or that have many distinct values (ids, names).
 */
import { Cell, Column, Table, isBlankCell } from "../engine/table";

export type Role = "flag" | "id" | "amount" | "count" | "percent" | "date" | "category" | "text" | "number";

export interface ColumnProfile {
  name: string;
  kind: Column["kind"];
  role: Role;
  /** Share of empty cells, 0..1. */
  empty: number;
  /** Distinct non-empty values (capped; `capped` is true when there were more). */
  distinct: number;
  capped: boolean;
  min?: number | string;
  max?: number | string;
  mean?: number;
  /** The most common values with their share of rows. Present only when safe to show. */
  values?: { value: string; share: number }[];
  /** Why no values are listed ("personal data", "many different values"), shown in the panel. */
  withheld?: string;
}

const DISTINCT_CAP = 2000;
const CATEGORY_MAX = 50;
const VALUES_SHOWN = 12;
const PERSONAL = /phone|mobile|msisdn|\bpan\b|(^|_)pan(_|$)|aadhaar|aadhar|e-?mail|address|account|acct|ifsc|card|passport|ssn|dob|birth/i;
const FLAGGY = new Set(["0", "1", "y", "n", "yes", "no", "true", "false", "t", "f"]);

const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const roundTo = (n: number): number => Math.round(n * 100) / 100;

function roleOf(c: Column, distinct: number, capped: boolean, values: string[]): Role {
  const n = c.name;
  if (c.kind === "date") return "date";
  if (distinct <= 2 && distinct > 0 && values.every((v) => FLAGGY.has(v.toLowerCase()))) return "flag";
  if (/(^|_)(id|uuid|ref|no|number|num|code)$|^id(_|$)/i.test(n) && (capped || distinct > CATEGORY_MAX)) return "id";
  if (c.kind === "number") {
    if (/pct|percent|%|ratio|rate/i.test(n)) return "percent";
    if (/amt|amount|bal|principal|due|paid|emi|fee|price|value|total|sum|outstanding|interest|charge/i.test(n)) return "amount";
    if (/cnt|count|nbr|(^|_)num(_|$)|qty|quantity|days|tenure/i.test(n)) return "count";
    return "number";
  }
  if (!capped && distinct <= CATEGORY_MAX) return "category";
  if (/(^|_)(id|uuid|ref)(_|$)/i.test(n)) return "id";
  return "text";
}

export function profileColumn(c: Column, nrows: number, opts: { values: boolean }): ColumnProfile {
  const counts = new Map<string, number>();
  let capped = false, empty = 0, sum = 0, nums = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nrows; i++) {
    const v: Cell = c.values[i];
    if (isBlankCell(v)) { empty++; continue; }
    if (c.kind === "date") {
      const t = c.time?.[i];
      if (typeof t === "number") { if (t < lo) lo = t; if (t > hi) hi = t; }
    } else if (typeof v === "number") {
      sum += v; nums++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const key = typeof v === "string" ? v.trim() : String(v);
    const seen = counts.get(key);
    if (seen !== undefined) counts.set(key, seen + 1);
    else if (counts.size < DISTINCT_CAP) counts.set(key, 1);
    else capped = true;
  }
  const distinct = counts.size;
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, VALUES_SHOWN);
  const p: ColumnProfile = { name: c.name, kind: c.kind, role: "text", empty: nrows ? roundTo(empty / nrows) : 0, distinct, capped };
  p.role = roleOf(c, distinct, capped, top.map(([v]) => v));
  if (c.kind === "date" && lo <= hi) { p.min = dayText(lo); p.max = dayText(hi); }
  else if (c.kind === "number" && nums) { p.min = lo; p.max = hi; p.mean = roundTo(sum / nums); }

  if (!opts.values) p.withheld = "values not shared";
  else if (PERSONAL.test(c.name)) p.withheld = "looks like personal data";
  else if (p.role === "id") p.withheld = "an identifier";
  else if (c.kind === "date") { /* the range above is enough */ }
  else if (c.kind === "number" && p.role !== "flag" && distinct > 8) { /* the range above is enough */ }
  else if (capped || distinct > CATEGORY_MAX) p.withheld = "many different values";
  else p.values = top.map(([value, n]) => ({ value, share: roundTo(n / Math.max(1, nrows - empty)) }));
  return p;
}

export function profileTable(t: Table, opts: { values: boolean } = { values: true }): ColumnProfile[] {
  return t.columns.map((c) => profileColumn(c, t.nrows, opts));
}

/** One line per column, as given to the model and shown in the "what I understood" panel. */
export function describeColumn(p: ColumnProfile): string {
  const bits: string[] = [`${p.name} (${p.role}${p.kind === "text" && p.role === "category" ? "" : p.kind !== "text" ? ", " + p.kind : ""})`];
  if (p.min !== undefined) bits.push(`${p.min} to ${p.max}${p.mean !== undefined ? `, average ${p.mean}` : ""}`);
  bits.push(p.capped ? `${p.distinct}+ different` : `${p.distinct} different`);
  if (p.empty > 0) bits.push(`${Math.round(p.empty * 100)}% empty`);
  if (p.values) bits.push("values: " + p.values.map((v) => `${v.value} ${Math.round(v.share * 100)}%`).join(", "));
  else if (p.withheld) bits.push(`(${p.withheld})`);
  return bits.join("; ");
}
