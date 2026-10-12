/**
 * The agent's workspace: every file the person opened (each sheet is a table) plus the result sheets the agent made.
 * Source tables are read lazily, column by column as plans need them, so a 1 lakh x 300 file costs only the columns
 * that are used. Everything stays in this browser tab.
 */
import type { FormatStep } from "../engine/format";
import type { Plan } from "../engine/plan";
import type { Table } from "../engine/table";
import { MAX_CELLS } from "../host";
import { csvHead, readCsv } from "../web/csv";
import { XlsxBook, openXlsx, readSheet, sheetHead } from "../web/xlsx-read";

export type Role = "new_customers" | "old_customers" | "customers" | "loans" | "repayments" | "policy" | "other";
export const ROLES: { value: Role; label: string }[] = [
  { value: "new_customers", label: "New customers" },
  { value: "old_customers", label: "Old customers" },
  { value: "customers", label: "Customers (all)" },
  { value: "loans", label: "Loans / disbursals" },
  { value: "repayments", label: "Repayments" },
  { value: "policy", label: "Policy" },
  { value: "other", label: "Other" },
];

export interface SourceTable {
  kind: "source";
  name: string;
  file: string;
  sheet: string;
  headers: string[];
  /** Data rows; for a CSV this is estimated until it is read. */
  rows: number;
  approx: boolean;
  role: Role;
  /** The columns read so far (null until the first read). */
  loaded: Table | null;
  blob: Blob;
  book?: XlsxBook;
}

export interface ResultTable {
  kind: "result";
  name: string;
  table: Table;
  formats: FormatStep[];
  /** Which table it was made from, the plan, why, and what the engine noticed. */
  from: string;
  plan: Plan;
  purpose: string;
  notes: string[];
}

export type Entry = SourceTable | ResultTable;

const num = (n: number) => n.toLocaleString("en-IN");

/** A name Excel accepts for a sheet: no []:*?/\, at most 31 characters. */
export function sheetSafe(name: string): string {
  const s = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31).replace(/^'+|'+$/g, "");
  return s || "Sheet";
}

export function guessRole(name: string, headers: string[]): Role {
  const n = name.toLowerCase();
  const h = headers.join(" ").toLowerCase();
  if (/polic/.test(n)) return "policy";
  if (/repay|collection|emi|recover/.test(n)) return "repayments";
  if (/\bnew\b|new[_\s-]?c|fresh/.test(n) && /cust|cx|user|borrow|client/.test(n)) return "new_customers";
  if (/\bold\b|old[_\s-]?c|existing|repeat/.test(n) && /cust|cx|user|borrow|client/.test(n)) return "old_customers";
  if (/cust|cx|user|borrow|client/.test(n)) return "customers";
  if (/loan|disburs/.test(n)) return "loans";
  if (/paid|repaid|due_?date|dpd/.test(h)) return "repayments";
  if (/polic/.test(h)) return "policy";
  return "other";
}

const stem = (file: string): string => file.replace(/\.[^.]+$/, "") || file;

export class Workspace {
  readonly tables = new Map<string, Entry>();
  progress: (message: string) => void = () => {};

  private unique(wanted: string): string {
    const base = sheetSafe(wanted);
    let name = base, n = 2;
    while ([...this.tables.keys()].some((k) => k.toLowerCase() === name.toLowerCase())) {
      const suffix = ` (${n++})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    return name;
  }

  /** Open files: every sheet of an .xlsx, or a .csv, becomes a table. */
  async addFiles(list: File[]): Promise<{ added: string[]; problems: string[] }> {
    const added: string[] = [];
    const problems: string[] = [];
    for (const f of list) {
      const lower = f.name.toLowerCase();
      try {
        if (/\.(xlsx|xlsm)$/.test(lower)) {
          const book = await openXlsx(f);
          const many = book.sheets.length > 1;
          for (const s of book.sheets) {
            let head;
            try { head = await sheetHead(book, s.name); } catch { continue; } // an empty sheet is skipped
            const name = this.unique(many ? `${stem(f.name)} - ${s.name}` : stem(f.name));
            this.tables.set(name, { kind: "source", name, file: f.name, sheet: s.name, headers: head.headers, rows: head.rows, approx: head.rows < 0, role: guessRole(`${f.name} ${s.name}`, head.headers), loaded: null, blob: f, book });
            added.push(name);
          }
          if (!added.length) problems.push(`“${f.name}” has no sheet with a header row.`);
        } else if (/\.(csv|tsv|txt)$/.test(lower)) {
          const head = await csvHead(f);
          const name = this.unique(stem(f.name));
          this.tables.set(name, { kind: "source", name, file: f.name, sheet: name, headers: head.headers, rows: head.rows, approx: true, role: guessRole(f.name, head.headers), loaded: null, blob: f });
          added.push(name);
        } else if (/\.(xls|xlsb)$/.test(lower)) {
          problems.push(`“${f.name}” is an old Excel format. In Excel choose File → Save As → Excel Workbook (.xlsx), then add that.`);
        } else {
          problems.push(`“${f.name}” isn't an Excel (.xlsx) or CSV file.`);
        }
      } catch (e) {
        problems.push(`I couldn't open “${f.name}”: ${(e as Error).message}`);
      }
    }
    return { added, problems };
  }

  get(name: string): Entry | undefined {
    const exact = this.tables.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase().trim();
    return [...this.tables.values()].find((t) => t.name.toLowerCase() === lower);
  }

  /** Column names of a table (all of them for a source, even the ones not read yet). */
  headersOf(name: string): string[] {
    const e = this.get(name);
    if (!e) return [];
    return e.kind === "source" ? e.headers : e.table.columns.map((c) => c.name);
  }

  rowsOf(e: Entry): number {
    return e.kind === "source" ? (e.loaded?.nrows ?? e.rows) : e.table.nrows;
  }

  /**
   * The table with at least `columns` read ("all" = every column). Unknown names are ignored here: the plan
   * checker reports them. A source that fits in memory is read whole the first time.
   */
  async ensure(name: string, columns: string[] | "all"): Promise<Table> {
    const e = this.get(name);
    if (!e) throw new Error(`There's no table called “${name}”. Tables: ${[...this.tables.keys()].join(", ")}`);
    if (e.kind === "result") return e.table;
    const have = new Set(e.loaded?.columns.map((c) => c.name) ?? []);
    const fitsWhole = e.rows >= 0 && e.rows * e.headers.length <= MAX_CELLS;
    const lowerHeaders = new Map(e.headers.map((h) => [h.toLowerCase(), h]));
    const wanted = columns === "all" || fitsWhole ? e.headers : columns.map((c) => lowerHeaders.get(c.toLowerCase())).filter((c): c is string => !!c);
    const missing = wanted.filter((c) => !have.has(c));
    if (e.loaded && !missing.length) return e.loaded;
    const all = [...new Set([...have, ...wanted])];
    if (!all.length) return e.loaded ?? { columns: [], nrows: 0 };
    const rows = e.rows > 0 ? e.rows : 0;
    if (rows && rows * all.length > MAX_CELLS) {
      throw new Error(`“${e.name}” has ${e.approx ? "about " : ""}${num(rows)} rows; reading ${all.length} of its columns would be too much at once (limit about ${num(MAX_CELLS)} cells). Use fewer columns.`);
    }
    const whole = all.length === e.headers.length;
    // Re-read every needed column in one pass, so the rows always line up.
    const got = e.book
      ? await readSheet(e.book, e.sheet, whole ? undefined : all, this.progress)
      : await readCsv(e.blob, whole ? undefined : all, this.progress);
    e.loaded = got.table;
    e.rows = got.table.nrows;
    e.approx = false;
    return got.table;
  }

  /** Save a result sheet; returns its (unique, Excel-safe) name. Saving under an existing result's name replaces it. */
  addResult(wanted: string, table: Table, meta: Omit<ResultTable, "kind" | "name" | "table">): string {
    const safe = sheetSafe(wanted);
    const old = this.get(safe);
    const name = old && old.kind === "result" ? old.name : this.unique(safe);
    this.tables.set(name, { kind: "result", name, table, ...meta });
    return name;
  }

  remove(name: string): void {
    this.tables.delete(name);
  }

  sources(): SourceTable[] {
    return [...this.tables.values()].filter((t): t is SourceTable => t.kind === "source");
  }

  results(): ResultTable[] {
    return [...this.tables.values()].filter((t): t is ResultTable => t.kind === "result");
  }

  /** Identifies the set of source layouts, so remembered notes follow the same kind of files next month. */
  fingerprint(): string {
    return this.sources().map((s) => `${s.role}:${s.headers.length}:${s.headers.slice(0, 12).join("|")}`).sort().join("\n");
  }
}
