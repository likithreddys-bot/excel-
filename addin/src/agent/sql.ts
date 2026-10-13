/**
 * The SQL tier: files too big to hold in memory (crores of rows) are queried by DuckDB straight from the file on disk.
 * Small tables (Excel sheets, earlier results) are handed to DuckDB too when a query names them, so big and small
 * tables can be joined. Only read-only SELECT queries run, and only their (small) results come back.
 */
import { Cell, Table, makeTable } from "../engine/table";
import { isoDay } from "../engine/util";

export interface SqlColumn { name: string; type: string }
export interface SqlResult { columns: SqlColumn[]; rows: unknown[][] }

/** What the app needs from a DuckDB (the browser build, or the Node build in tests). */
export interface SqlDb {
  /** Make a file readable by name, without copying it into memory. */
  registerBlob(name: string, blob: Blob): Promise<void>;
  registerText(name: string, text: string): Promise<void>;
  query(sql: string): Promise<SqlResult>;
}

/** CSV files bigger than this go to DuckDB (smaller ones are read whole into the fast in-memory engine). */
export const BIG_BYTES = 40 * 1024 * 1024;
/** A result bigger than this is refused: the agent should aggregate instead. */
export const MAX_RESULT_ROWS = 200_000;

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteText = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const FORBIDDEN = /\b(copy|attach|detach|install|load|pragma|create|insert|update|delete|drop|alter|export|import|call|set|reset|checkpoint|vacuum|use|begin|commit|rollback|truncate|grant|merge|replace\s+into)\b/i;
const FILE_FUNCS = /\b(read_csv\w*|read_parquet|read_json\w*|read_text|read_blob|parquet_scan|csv_scan|glob|sniff_csv|query_table|getenv|read_ndjson\w*|iceberg_scan|delta_scan)\s*\(/i;

/** Problems with a query, or null when it is a single read-only SELECT. */
export function checkSql(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, "");
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!s) return "The query is empty.";
  if (noStrings.includes(";")) return "Send one query at a time (no semicolons).";
  if (!/^\s*(select|with|from)\b/i.test(noStrings)) return "Only SELECT queries (or WITH ... SELECT) can run.";
  const bad = FORBIDDEN.exec(noStrings);
  if (bad) return `“${bad[1].toUpperCase()}” is not allowed: queries can only read the tables.`;
  const fn = FILE_FUNCS.exec(noStrings);
  if (fn) return `“${fn[1]}” is not allowed: query the tables by name instead.`;
  if (/(https?|s3|gs|az|hf):\/\//i.test(s)) return "Queries cannot read from the internet.";
  return null;
}

/** DuckDB's answer as an app table: dates become dates, everything else stays as it is. */
export function toTable(r: SqlResult): Table {
  const isDate = r.columns.map((c) => /date|timestamp/i.test(c.type));
  const rows: Cell[][] = r.rows.map((row) => row.map((v, j): Cell => {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return Number(v);
    if (isDate[j] && typeof v === "number") return isoDay(v);
    if (v instanceof Date) return isoDay(v.getTime());
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    return String(v);
  }));
  return makeTable(r.columns.map((c) => c.name), rows);
}

/** A small in-memory table as CSV text, to hand to DuckDB. */
export function tableCsv(t: Table): string {
  const esc = (v: Cell, j: number, i: number): string => {
    const c = t.columns[j];
    if (v === null) return "";
    let s = c.kind === "date" && c.time?.[i] != null ? isoDay(c.time[i]!) : String(v);
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = t.columns.map((c) => esc(c.name, 0, 0)).join(",");
  const lines = [head];
  for (let i = 0; i < t.nrows; i++) lines.push(t.columns.map((c, j) => esc(c.values[i], j, i)).join(","));
  return lines.join("\n") + "\n";
}

export interface SqlSource { name: string; kind: "csv" | "parquet"; blob: Blob; delimiter?: string }

/** Keeps the views DuckDB knows about in step with the workspace. */
export class SqlCatalog {
  private views = new Map<string, string>();
  private n = 0;
  constructor(private readonly db: SqlDb) {}

  has(name: string): boolean { return this.views.has(name.toLowerCase()); }

  async addFile(src: SqlSource): Promise<void> {
    const file = `f${++this.n}.${src.kind}`;
    await this.db.registerBlob(file, src.blob);
    const read = src.kind === "parquet"
      ? `read_parquet(${quoteText(file)})`
      : `read_csv(${quoteText(file)}, header = true, sample_size = 20000${src.delimiter && src.delimiter !== "," ? `, delim = ${quoteText(src.delimiter)}` : ""})`;
    await this.db.query(`CREATE OR REPLACE VIEW ${quoteIdent(src.name)} AS SELECT * FROM ${read}`);
    this.views.set(src.name.toLowerCase(), file);
  }

  async addTable(name: string, t: Table): Promise<void> {
    const file = `t${++this.n}.csv`;
    await this.db.registerText(file, tableCsv(t));
    await this.db.query(`CREATE OR REPLACE VIEW ${quoteIdent(name)} AS SELECT * FROM read_csv(${quoteText(file)}, header = true, sample_size = -1)`);
    this.views.set(name.toLowerCase(), file);
  }

  async headers(name: string): Promise<string[]> {
    const r = await this.db.query(`DESCRIBE SELECT * FROM ${quoteIdent(name)}`);
    return r.rows.map((row) => String(row[0]));
  }

  async count(name: string): Promise<number> {
    const r = await this.db.query(`SELECT count(*) AS n FROM ${quoteIdent(name)}`);
    return Number(r.rows[0]?.[0] ?? 0);
  }

  /** A random sample of some columns, to profile them (counts and totals always use every row). */
  async sample(name: string, columns: string[], n = 20000): Promise<Table> {
    const cols = columns.length ? columns.map(quoteIdent).join(", ") : "*";
    return toTable(await this.db.query(`SELECT ${cols} FROM ${quoteIdent(name)} USING SAMPLE reservoir(${n} ROWS) REPEATABLE (7)`));
  }

  async valueCounts(name: string, column: string, top: number): Promise<{ values: { value: string; count: number }[]; distinct: number }> {
    const c = quoteIdent(column), t = quoteIdent(name);
    const r = await this.db.query(`SELECT coalesce(CAST(${c} AS VARCHAR), '(blank)') AS value, count(*) AS count FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT ${top}`);
    const d = await this.db.query(`SELECT count(DISTINCT ${c}) FROM ${t}`);
    return { values: r.rows.map((x) => ({ value: String(x[0]), count: Number(x[1]) })), distinct: Number(d.rows[0]?.[0] ?? 0) };
  }

  /** Run a checked query; refuse results too big to be a sheet. */
  async run(sql: string): Promise<Table> {
    const problem = checkSql(sql);
    if (problem) throw new Error(problem);
    const body = sql.trim().replace(/;\s*$/, "");
    const r = await this.db.query(`SELECT * FROM (${body}) AS result LIMIT ${MAX_RESULT_ROWS + 1}`);
    if (r.rows.length > MAX_RESULT_ROWS) throw new Error(`The query returns more than ${MAX_RESULT_ROWS.toLocaleString("en-IN")} rows. Summarise it (GROUP BY, or a filter) so the result fits on a sheet.`);
    return toTable(r);
  }
}

/** Table names a query mentions (quoted or bare), among the known ones. */
export function tablesIn(sql: string, names: string[]): string[] {
  const low = sql.toLowerCase();
  return names.filter((n) => {
    const l = n.toLowerCase();
    if (low.includes(`"${l.replace(/"/g, '""')}"`)) return true;
    return /^[a-z_][a-z0-9_]*$/i.test(n) && new RegExp(`(^|[^a-z0-9_"])${l}([^a-z0-9_"]|$)`, "i").test(sql);
  });
}
