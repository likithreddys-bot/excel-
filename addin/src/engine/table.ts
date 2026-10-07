/** An in-memory table, column by column. Cells keep the values Excel gave us. */
import { parseDateText, serialToMs } from "./util";

export type Cell = string | number | boolean | null;
export type Kind = "number" | "date" | "text";

export interface Column {
  name: string;
  kind: Kind;
  values: Cell[];
  /** Date columns: each row as UTC milliseconds (null where empty/unreadable). */
  time?: (number | null)[];
  /** Excel number format to put back when the column is written out. */
  format?: string;
  /** Fixed display order for text values (weekday names). */
  order?: string[];
  /** A date column where some cells are real Excel dates and others are text (typical after pasting). */
  mixedDates?: boolean;
}

export interface Table {
  columns: Column[];
  nrows: number;
}

/** Sheets keep their order; names are unique. */
export type Sheets = Map<string, Table>;

export const isBlankCell = (v: Cell): boolean => v === null || v === "" || (typeof v === "string" && v.trim() === "");

export function colIndex(t: Table, name: string): number {
  return t.columns.findIndex((c) => c.name === name);
}

export function getColumn(t: Table, name: string): Column | undefined {
  return t.columns.find((c) => c.name === name);
}

export function pick(t: Table, rows: number[]): Table {
  return {
    nrows: rows.length,
    columns: t.columns.map((c) => ({
      ...c,
      values: rows.map((i) => c.values[i]),
      time: c.time ? rows.map((i) => c.time![i]) : undefined,
    })),
  };
}

/** Does an Excel number format display a date or time? */
export function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt) return false;
  const stripped = fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "").toLowerCase();
  return /[dmyhs]/.test(stripped);
}

/** Work out a column's kind from its values (and, if known, the Excel format of its cells). */
export function makeColumn(name: string, values: Cell[], format?: string): Column {
  const filled = values.filter((v) => !isBlankCell(v));
  if (filled.length && filled.every((v) => typeof v === "number")) {
    if (isDateFormat(format)) {
      return { name, kind: "date", values, format, time: values.map((v) => (typeof v === "number" ? serialToMs(v) : null)) };
    }
    return { name, kind: "number", values, format };
  }
  const strings = filled.filter((v): v is string => typeof v === "string");
  const numbers = filled.filter((v): v is number => typeof v === "number");
  if (strings.length && numbers.length && numbers.length + strings.length === filled.length
    && numbers.every((n) => n >= 20000 && n <= 80000) // plausible Excel serial dates (1954-2119)
    && strings.filter((s) => parseDateText(s) !== null).length / strings.length > 0.8) {
    const time = values.map((v) => (typeof v === "number" ? serialToMs(v) : typeof v === "string" ? parseDateText(v) : null));
    return { name, kind: "date", values, format, time, mixedDates: true };
  }
  if (strings.length && strings.length === filled.length) {
    const sample = strings.slice(0, 200);
    const allDigits = sample.every((s) => /^\s*\d+(\.\d+)?\s*$/.test(s));
    const parsed = sample.filter((s) => parseDateText(s) !== null).length / sample.length;
    if (!allDigits && parsed > 0.8) {
      return { name, kind: "date", values, format, time: values.map((v) => (typeof v === "string" ? parseDateText(v) : null)) };
    }
  }
  return { name, kind: "text", values, format };
}

export function makeTable(names: string[], rows: Cell[][], formats?: (string | undefined)[]): Table {
  const columns = names.map((n, j) => makeColumn(n, rows.map((r) => (r[j] === undefined || r[j] === "" ? null : r[j])), formats?.[j]));
  return { columns, nrows: rows.length };
}

/** Each row's date as UTC ms, for any column (text columns holding dates are read day-first). */
export function timesOf(c: Column): (number | null)[] {
  if (c.time) return c.time;
  return c.values.map((v) => (typeof v === "string" ? parseDateText(v) : null));
}

/** All sheets as one table (columns lined up by name), for the parser to look at. */
export function combine(sheets: Sheets): Table {
  const tables = [...sheets.values()];
  if (tables.length === 1) return tables[0];
  const names: string[] = [];
  for (const t of tables) for (const c of t.columns) if (!names.includes(c.name)) names.push(c.name);
  const columns = names.map((n) => {
    const values: Cell[] = [];
    let format: string | undefined;
    for (const t of tables) {
      const c = getColumn(t, n);
      format ??= c?.format;
      for (let i = 0; i < t.nrows; i++) values.push(c ? c.values[i] : null);
    }
    return makeColumn(n, values, format);
  });
  return { columns, nrows: tables.reduce((a, t) => a + t.nrows, 0) };
}
