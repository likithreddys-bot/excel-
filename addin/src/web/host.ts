/**
 * The website's "workbook": files the user opened (.xlsx or .csv) plus the result sheets made so far, all in
 * memory in this browser tab. Nothing is uploaded anywhere.
 */
import type { FormatStep } from "../engine/format";
import { Sheets, Table } from "../engine/table";
import { Created, Host, HostError, MAX_CELLS, Source, SourceRef, TooWideError, WriteOutcome } from "../host";
import { readCsv, csvHead } from "./csv";
import { buildXlsx, sheetNames } from "./xlsx-write";
import { XlsxBook, openXlsx, readSheet as readXlsxSheet, sheetHead } from "./xlsx-read";

interface FileSheet { kind: "file"; file: string; sheet: string; headers?: string[]; rows?: number }
interface ResultSheet { kind: "result"; table: Table; formats: FormatStep[] }
type Entry = FileSheet | ResultSheet;

interface Opened { name: string; blob: Blob; book?: XlsxBook }

const num = (n: number) => n.toLocaleString("en-IN");

export class WebHost implements Host {
  kind = "web" as const;
  private files = new Map<string, Opened>();
  private sheets = new Map<string, Entry>();
  /** The sheet the user is working on (the table commands run on). */
  current: string | null = null;
  private cache: { key: string; source: Source } | null = null;
  progress: (message: string) => void = () => {};

  /** Open files (.xlsx or .csv). Returns what was added, and the first problem per file that could not be read. */
  async addFiles(list: File[]): Promise<{ added: string[]; problems: string[] }> {
    const added: string[] = [];
    const problems: string[] = [];
    for (const f of list) {
      const lower = f.name.toLowerCase();
      try {
        if (/\.xlsx$|\.xlsm$/.test(lower)) {
          const book = await openXlsx(f);
          this.files.set(f.name, { name: f.name, blob: f, book });
          for (const s of book.sheets) added.push(this.register(this.sheets.has(s.name) ? `${stem(f.name)} - ${s.name}` : s.name, f.name, s.name));
        } else if (/\.(csv|tsv|txt)$/.test(lower)) {
          await csvHead(f); // fails early on an empty file
          this.files.set(f.name, { name: f.name, blob: f });
          added.push(this.register(stem(f.name), f.name, stem(f.name)));
        } else if (/\.xls$/.test(lower)) {
          problems.push(`“${f.name}” is an old .xls file. In Excel, choose File → Save As → Excel Workbook (.xlsx), then open that.`);
        } else if (/\.xlsb$/.test(lower)) {
          problems.push(`“${f.name}” is an .xlsb file. In Excel, choose File → Save As → Excel Workbook (.xlsx), then open that.`);
        } else {
          problems.push(`“${f.name}” isn't an Excel (.xlsx) or CSV file.`);
        }
      } catch (e) {
        problems.push(`I couldn't open “${f.name}”: ${(e as Error).message}`);
      }
    }
    if (!this.current || !this.sheets.has(this.current)) this.current = added[0] ?? this.current;
    return { added, problems };
  }

  private register(wanted: string, file: string, sheet: string): string {
    const name = sheetNames([wanted])[0];
    let unique = name, n = 2;
    while (this.sheets.has(unique)) unique = `${name.slice(0, 27)} (${n++})`;
    this.sheets.set(unique, { kind: "file", file, sheet });
    return unique;
  }

  /** Sheets that came from files, then result sheets: for the sheet picker. */
  sheetList(): { name: string; result: boolean }[] {
    return [...this.sheets].map(([name, e]) => ({ name, result: e.kind === "result" }));
  }

  private entry(name: string): Entry {
    const e = this.sheets.get(name);
    if (!e) throw new HostError(`There's no sheet called “${name}”.`);
    return e;
  }

  private async head(name: string, e: FileSheet): Promise<{ headers: string[]; rows: number }> {
    if (!e.headers) {
      const f = this.files.get(e.file)!;
      const h = f.book ? await sheetHead(f.book, e.sheet) : await csvHead(f.blob);
      e.headers = h.headers;
      e.rows = h.rows;
    }
    return { headers: e.headers, rows: e.rows ?? -1 };
  }

  async listSheets(): Promise<string[]> {
    return [...this.sheets.keys()];
  }

  async readSheet(name: string): Promise<Table> {
    const e = this.entry(name);
    if (e.kind === "result") return e.table;
    const { headers, rows } = await this.head(name, e);
    if (rows >= 0 && rows * headers.length > MAX_CELLS) throw new HostError(`The sheet “${name}” is too big to look things up in (${num(rows)} rows × ${headers.length} columns).`);
    const f = this.files.get(e.file)!;
    try {
      return (f.book ? await readXlsxSheet(f.book, e.sheet, undefined, this.progress) : await readCsv(f.blob, undefined, this.progress)).table;
    } catch (err) {
      const m = (err as Error).message;
      throw new HostError(m.startsWith("I need") ? `The sheet “${name}” has a header row but no data rows yet. Add the rows you want to look up, then try again.` : m);
    }
  }

  async readSource(ref?: SourceRef, _fresh = false, columns?: string[]): Promise<Source> {
    const name = ref?.sheet ?? this.current;
    if (!name) throw new HostError("Open a file first: drop an Excel (.xlsx) or CSV file onto the page.");
    const e = this.entry(name);
    this.current = name;
    const key = `${name}|${columns ? [...columns].sort().join("\u0001") : ""}`;
    if (this.cache?.key === key) return this.cache.source;
    let source: Source;
    if (e.kind === "result") {
      source = { ref: { sheet: name, address: "A1" }, label: name, table: e.table, headers: e.table.columns.map((c) => c.name) };
    } else {
      const { headers, rows } = await this.head(name, e);
      const width = columns ? headers.filter((h) => columns.some((c) => c.toLowerCase() === h.toLowerCase())).length : headers.length;
      if (width === 0) throw new HostError("None of the columns you picked are in this sheet any more. Pick the columns again.");
      const tooBig = rows >= 0 ? rows * width > MAX_CELLS : width > 100;
      if (tooBig) {
        if (!columns) {
          throw new TooWideError(`This table has ${rows >= 0 ? num(rows) : "a lot of"} rows and ${headers.length} columns, which is more than I can hold at once. Pick the columns you need and I'll read only those.`, headers, rows);
        }
        throw new HostError(`Even those ${width} columns are too much: ${num(rows)} rows × ${width} columns is more than I can hold at once (about ${num(MAX_CELLS)} cells). Pick fewer columns.`);
      }
      const f = this.files.get(e.file)!;
      const got = f.book ? await readXlsxSheet(f.book, e.sheet, columns, this.progress) : await readCsv(f.blob, columns, this.progress);
      source = { ref: { sheet: name, address: "A1" }, label: `${name}${f.book ? "" : ` (${f.name})`}`, table: got.table, headers: got.headers };
    }
    this.cache = { key, source };
    return source;
  }

  async writeResult(sheets: Sheets, formats: FormatStep[] = []): Promise<WriteOutcome> {
    const created: Created[] = [];
    for (const [wanted, table] of sheets) {
      const base = sheetNames([wanted])[0];
      let name = base, n = 2;
      while (this.sheets.has(name)) name = `${base.slice(0, 27)} (${n++})`;
      this.sheets.set(name, { kind: "result", table, formats });
      created.push({ name, rows: table.nrows });
    }
    return { created, notes: [] };
  }

  async writePivot(): Promise<Created> {
    throw new HostError("PivotTables need the Excel add-in.");
  }

  async removeSheets(names: string[]): Promise<void> {
    for (const n of names) if (this.sheets.get(n)?.kind === "result") this.sheets.delete(n);
    if (this.current && !this.sheets.has(this.current)) this.current = this.sheets.keys().next().value ?? null;
    this.cache = null;
  }

  async refOf(sheetName: string): Promise<SourceRef> {
    return { sheet: sheetName, address: "A1" };
  }

  /** An .xlsx of the named result sheets, for download. */
  async xlsxOf(names: string[]): Promise<Blob> {
    const out: Sheets = new Map();
    const formats: FormatStep[] = [];
    for (const n of names) {
      const e = this.sheets.get(n);
      if (e?.kind === "result") { out.set(n, e.table); formats.push(...e.formats); }
    }
    return buildXlsx(out, formats, this.progress);
  }

  /** The formats a result sheet was made with (charts are drawn by the page). */
  formatsOf(name: string): FormatStep[] {
    const e = this.sheets.get(name);
    return e?.kind === "result" ? e.formats : [];
  }
}

function stem(file: string): string {
  return file.replace(/\.[^.]+$/, "") || file;
}
