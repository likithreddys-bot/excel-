/** Cleaning steps: trim / case, blanks, find and replace, text to columns, merge, rename, change type. */
import { PlanError, col, need } from "./core";
import type { ConvertStep, FillBlanksStep, MergeColumnsStep, RenameStep, ReplaceStep, SplitColumnStep, CleanTextStep, DropBlankRowsStep } from "./plan";
import { Cell, Column, Table, isBlankCell, makeColumn, pick, timesOf } from "./table";
import { isoDay, msToSerial, parseDateText } from "./util";

/** Columns that hold text (including dates written as text). */
export function textColumns(t: Table): string[] {
  return t.columns.filter((c) => c.values.some((v) => typeof v === "string")).map((c) => c.name);
}

/** Replace the columns named in `changed`, leaving the rest where they are. */
function withColumns(t: Table, changed: Map<string, Column>): Table {
  return { nrows: t.nrows, columns: t.columns.map((c) => changed.get(c.name) ?? c) };
}

const remake = (c: Column, values: Cell[]): Column => makeColumn(c.name, values, c.format);

/** Python's str.title(): capitalise the first letter of every run of letters. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1));
}

export function cleanText(t: Table, step: CleanTextStep): Table {
  const names = step.columns ?? textColumns(t);
  need(t, names);
  const fn = (s: string): string | null => {
    switch (step.action) {
      case "trim": { const r = s.trim().replace(/\s+/g, " "); return r === "" ? null : r; } // a cell of only spaces is blank
      case "upper": return s.toUpperCase();
      case "lower": return s.toLowerCase();
      case "title": return titleCase(s);
    }
  };
  const changed = new Map(names.map((n) => {
    const c = col(t, n);
    return [n, remake(c, c.values.map((v) => (typeof v === "string" ? fn(v) : v)))] as const;
  }));
  return withColumns(t, changed);
}

export function fillBlanks(t: Table, step: FillBlanksStep): Table {
  const names = step.columns ?? t.columns.map((c) => c.name);
  need(t, names);
  const changed = new Map(names.map((n) => {
    const c = col(t, n);
    const values: Cell[] = c.values.map((v) => (isBlankCell(v) ? null : v));
    if (step.method === "down") {
      let last: Cell = null;
      values.forEach((v, i) => { if (v === null) values[i] = last; else last = v; });
    } else if (step.method === "up") {
      let next: Cell = null;
      for (let i = values.length - 1; i >= 0; i--) { if (values[i] === null) values[i] = next; else next = values[i]; }
    } else {
      const raw = step.value ?? "";
      const num = c.kind === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : null;
      values.forEach((v, i) => { if (v === null) values[i] = num !== null ? num : raw; });
    }
    return [n, remake(c, values)] as const;
  }));
  return withColumns(t, changed);
}

export function dropBlankRows(t: Table, step: DropBlankRowsStep): Table {
  const keep: number[] = [];
  for (let i = 0; i < t.nrows; i++) {
    const blanks = t.columns.map((c) => isBlankCell(c.values[i]));
    const drop = step.how === "all" ? blanks.every(Boolean) : blanks.some(Boolean);
    if (!drop) keep.push(i);
  }
  return pick(t, keep);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function replaceText(t: Table, step: ReplaceStep): Table {
  const names = step.columns ?? textColumns(t);
  need(t, names);
  const re = new RegExp(escapeRe(step.find), "gi");
  const changed = new Map(names.map((n) => {
    const c = col(t, n);
    if (c.kind === "number") {
      // Numbers match as whole values: "replace 0 with blank" must not turn 10 into 1.
      const target = step.find.trim() === "" ? NaN : Number(step.find);
      if (Number.isNaN(target)) return [n, c] as const;
      const repl = step.replace;
      const next: Cell = repl.trim() === "" ? null : !Number.isNaN(Number(repl)) ? Number(repl) : repl;
      return [n, remake(c, c.values.map((v) => (v === target ? next : v)))] as const;
    }
    return [n, remake(c, c.values.map((v) => {
      if (typeof v !== "string") return v;
      const r = v.replace(re, () => step.replace);
      return r.trim() === "" ? null : r; // a cell that became empty is blank
    }))] as const;
  }));
  return withColumns(t, changed);
}

function insertAfter(t: Table, after: string, added: Column[]): Table {
  const clash = added.filter((a) => t.columns.some((c) => c.name === a.name)).map((a) => a.name);
  if (clash.length) throw new PlanError(`There is already a column called ${clash.join(", ")}`);
  const pos = t.columns.findIndex((c) => c.name === after) + 1;
  return { nrows: t.nrows, columns: [...t.columns.slice(0, pos), ...added, ...t.columns.slice(pos)] };
}

const asText = (v: Cell): string | null => (v === null ? null : String(v));

export function splitColumn(t: Table, step: SplitColumnStep): Table {
  const c = col(t, step.column);
  const parts: (string | null)[][] = step.names.map(() => new Array(t.nrows).fill(null));
  c.values.forEach((v, i) => {
    const s = asText(v);
    if (s === null) return;
    const pieces: string[] = [];
    let rest = s;
    while (pieces.length < step.names.length - 1) { // at most names-1 splits: the last piece keeps the remaining text
      const at = step.delimiter === "" ? -1 : rest.indexOf(step.delimiter);
      if (at < 0) break;
      pieces.push(rest.slice(0, at));
      rest = rest.slice(at + step.delimiter.length);
    }
    pieces.push(rest);
    pieces.forEach((p, j) => { const x = p.trim(); parts[j][i] = x === "" ? null : x; });
  });
  return insertAfter(t, step.column, step.names.map((n, j) => makeColumn(n, parts[j])));
}

export function mergeColumns(t: Table, step: MergeColumnsStep): Table {
  need(t, step.columns);
  const cols = step.columns.map((n) => col(t, n));
  const merged: Cell[] = Array.from({ length: t.nrows }, (_, i) => {
    const bits = cols.map((c) => asText(c.values[i])).map((s) => (s === null ? null : s.trim())).filter((s): s is string => !!s);
    return bits.length ? bits.join(step.separator) : null;
  });
  return insertAfter(t, step.columns[step.columns.length - 1], [makeColumn(step.name, merged)]);
}

export function renameColumns(t: Table, step: RenameStep): Table {
  need(t, Object.keys(step.mapping));
  const clash = Object.values(step.mapping).filter((n) => t.columns.some((c) => c.name === n) && !(n in step.mapping));
  if (clash.length) throw new PlanError(`There is already a column called ${clash.join(", ")}`);
  return { nrows: t.nrows, columns: t.columns.map((c) => (c.name in step.mapping ? { ...c, name: step.mapping[c.name] } : c)) };
}

export function convertColumns(t: Table, step: ConvertStep): Table {
  need(t, step.columns);
  const changed = new Map(step.columns.map((n) => [n, convertOne(col(t, n), n, step.to)] as const));
  return withColumns(t, changed);
}

function convertOne(c: Column, name: string, to: ConvertStep["to"]): Column {
  if (to === "text") {
    return makeColumn(c.name, c.values.map((v, i) => (v === null ? null : c.kind === "date" && c.time?.[i] != null && typeof v === "number" ? isoDay(c.time[i]!) : String(v))));
  }
  const bad: Cell[] = [];
  let out: Cell[];
  let format = c.format;
  if (to === "number") {
    out = c.values.map((v) => {
      if (isBlankCell(v)) return null;
      if (typeof v === "number") return v;
      // "Rs." must go together with its dot, or "Rs. 90" would become ".90".
      const cleaned = String(v).replace(/(?<![a-z])(?:rs|inr)\.?|[₹$€£,\s]/gi, "");
      const n = cleaned === "" ? NaN : Number(cleaned);
      if (Number.isNaN(n)) { bad.push(v); return null; }
      return n;
    });
  } else {
    const times = timesOf(c);
    out = c.values.map((v, i) => {
      if (isBlankCell(v)) return null;
      if (typeof v === "number" && c.kind === "date") return v; // already a real date
      const ms = typeof v === "string" ? parseDateText(v) : times[i];
      if (ms === null || ms === undefined) { bad.push(v); return null; }
      return msToSerial(ms);
    });
    if (!isDateLike(format)) format = "dd/mm/yyyy";
  }
  if (bad.length) {
    const uniq = [...new Set(bad.map(String))].slice(0, 3).map((v) => `'${v}'`);
    throw new PlanError(`${bad.length.toLocaleString("en-US")} value(s) in '${name}' can't be read as a ${to}, e.g. ${uniq.join(", ")}. `
      + `Fix or remove those first (e.g. replace ${uniq[0]} with blank).`);
  }
  return makeColumn(c.name, out, to === "date" ? format : c.format);
}

const isDateLike = (f: string | undefined) => !!f && /[dmyhs]/i.test(f.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
