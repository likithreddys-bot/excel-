/** Working with another sheet: lookup (VLOOKUP), append, compare. `other` is the other sheet's table. */
import { PlanError, col, need } from "./core";
import type { AppendStep, CompareStep, LookupStep } from "./plan";
import { Cell, Table, getColumn, makeColumn, pick } from "./table";
import { key } from "./util";

const n = (x: number) => x.toLocaleString("en-US");

/** Values as they should match across sheets: 101 == 101.0 == " 101 ", and case is ignored. */
export function matchKey(v: Cell): string | null {
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  return s === "" ? null : s;
}

export function lookup(t: Table, step: LookupStep, other: Table, notes: string[]): Table {
  need(t, [step.left_on]);
  need(other, [step.right_on, ...step.columns]);
  const rk = col(other, step.right_on).values.map(matchKey);
  const first = new Map<string, number>();
  let dups = 0;
  rk.forEach((k, i) => {
    if (k === null) return;
    if (first.has(k)) dups++; else first.set(k, i);
  });
  if (dups) notes.push(`${step.file} has ${n(dups)} repeated ${step.right_on} value(s); the first match was used (like VLOOKUP).`);
  const lk = col(t, step.left_on).values.map(matchKey);
  const at = lk.map((k) => (k === null ? undefined : first.get(k)));
  const added: ReturnType<typeof makeColumn>[] = [];
  for (const c of step.columns) {
    const clash = getColumn(t, c) || added.some((a) => a.name === c);
    const src = col(other, c);
    added.push(makeColumn(clash ? `${c} (${step.file})` : c, at.map((i) => (i === undefined ? null : src.values[i])), src.format));
  }
  const found = at.filter((i) => i !== undefined).length;
  const missing = t.nrows - found;
  notes.push(`${n(found)} of ${n(t.nrows)} rows found a match in ${step.file}` + (missing ? `; ${n(missing)} had no match (left blank).` : "."));
  const columns = [...t.columns.filter((c) => !added.some((a) => a.name === c.name)), ...added];
  return { columns, nrows: t.nrows };
}

export function append(t: Table, step: AppendStep, other: Table, notes: string[]): Table {
  const byKey = new Map(t.columns.map((c) => [key(c.name), c.name]));
  const renamed = other.columns.map((c) => ({ ...c, name: byKey.get(key(c.name)) ?? c.name }));
  const onlyThere = renamed.filter((c) => !t.columns.some((x) => x.name === c.name)).map((c) => c.name);
  const onlyHere = t.columns.filter((c) => !renamed.some((x) => x.name === c.name)).map((c) => c.name);
  if (onlyThere.length) notes.push(`Columns only in ${step.file} (added, blank for existing rows): ${onlyThere.join(", ")}.`);
  if (onlyHere.length) notes.push(`Columns missing from ${step.file} (blank for its rows): ${onlyHere.join(", ")}.`);
  notes.push(`Added ${n(other.nrows)} rows from ${step.file}.`);
  const names = [...t.columns.map((c) => c.name), ...onlyThere];
  const columns = names.map((name) => {
    const here = getColumn(t, name), there = renamed.find((c) => c.name === name);
    const values: Cell[] = [
      ...(here ? here.values : new Array(t.nrows).fill(null)),
      ...(there ? there.values : new Array(other.nrows).fill(null)),
    ];
    return makeColumn(name, values, (here ?? there)!.format);
  });
  return { columns, nrows: t.nrows + other.nrows };
}

export function compare(t: Table, step: CompareStep, other: Table, notes: string[]): Table {
  let lk: (string | null)[], rk: (string | null)[], what: string;
  if (step.left_on) {
    need(t, [step.left_on]);
    need(other, [step.right_on!]);
    lk = col(t, step.left_on).values.map(matchKey);
    rk = col(other, step.right_on!).values.map(matchKey);
    what = step.left_on;
  } else {
    const theirs = new Map(other.columns.map((c) => [key(c.name), c.name]));
    const pairs = t.columns.filter((c) => theirs.has(key(c.name))).map((c) => [c.name, theirs.get(key(c.name))!] as const);
    if (!pairs.length) throw new PlanError(`This data and ${step.file} have no columns in common. Say which column to compare on.`);
    const rowKey = (tbl: Table, names: string[], i: number) => names.map((nm) => matchKey(col(tbl, nm).values[i]) ?? "").join("\x1f");
    lk = Array.from({ length: t.nrows }, (_, i) => rowKey(t, pairs.map((p) => p[0]), i));
    rk = Array.from({ length: other.nrows }, (_, i) => rowKey(other, pairs.map((p) => p[1]), i));
    what = `whole rows (${pairs.map((p) => p[0]).join(", ")})`;
  }
  const blank = lk.filter((k) => k === null).length;
  if (blank) notes.push(`${n(blank)} row(s) have a blank ${step.left_on} and can't match anything.`);
  if (step.keep === "only_there") {
    const mine = new Set(lk.filter((k): k is string => k !== null));
    const out = pick(other, rk.flatMap((k, i) => (k === null || !mine.has(k) ? [i] : [])));
    notes.push(`${n(out.nrows)} row(s) of ${step.file} are not in this data (compared by ${what}).`);
    return out;
  }
  const theirs = new Set(rk.filter((k): k is string => k !== null));
  const rows = lk.flatMap((k, i) => ((k !== null && theirs.has(k)) === (step.keep === "both") ? [i] : []));
  const out = pick(t, rows);
  const where = step.keep === "both" ? `also in ${step.file}` : `not in ${step.file}`;
  notes.push(`${n(out.nrows)} of ${n(t.nrows)} rows are ${where} (compared by ${what}).`);
  return out;
}
