/** Reads and writes real Excel worksheets through Office.js. */
import { FormatStep, liveFormats } from "../engine/format";
import { Cell, Sheets, Table, headerNames, makeTable } from "../engine/table";
import { addCharts, formatSheet } from "./format";
import type { LiveColumn, PivotSpec } from "../engine/live";
import { Created, Host, HostError, MAX_CELLS, Source, SourceRef, TooWideError, WriteOutcome } from "../host";

const READ_CELLS_PER_CHUNK = 100_000;
const WRITE_CELLS_PER_CHUNK = 50_000;
/** Excel's own request limit is about 5 MB; stay well under it when a chunk holds long text. */
const WRITE_BYTES_PER_CHUNK = 1_500_000;

/** The pane sets this to show progress ("Reading 300,000 of 1,000,000 rows…") during long reads and writes. */
export const progress: { report: (message: string) => void } = { report: () => {} };
const num = (n: number) => n.toLocaleString("en-IN");

/** Excel refused a request because it was too big: worth retrying in smaller pieces. */
const isTooBig = (e: unknown) => /payload|too large|size limit|RequestPayload|ResponsePayload|exceeds/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? ""}`);

async function locate(ctx: Excel.RequestContext, ref?: SourceRef): Promise<{ range: Excel.Range; region: boolean }> {
  if (ref) {
    const range = ctx.workbook.worksheets.getItem(ref.sheet).getRange(ref.address);
    return { range: ref.region ? range.getCell(0, 0).getSurroundingRegion() : range, region: !!ref.region };
  }
  const sel = ctx.workbook.getSelectedRange();
  sel.load("rowCount,columnCount");
  await ctx.sync();
  if (sel.rowCount === 1 && sel.columnCount === 1) {
    return { range: sel.getSurroundingRegion(), region: true }; // one cell inside a table: take the whole table around it
  }
  const used = sel.getUsedRangeOrNullObject(true); // a bigger selection (even a whole column): just the part with data
  used.load("isNullObject");
  await ctx.sync();
  if (used.isNullObject) throw new HostError("I can't see any data there. Click a cell inside your table first.");
  return { range: used, region: false };
}

/** Read a range (first row = headers) into a table, in chunks so big sheets stay under Excel's request size limit. */
async function readTable(ctx: Excel.RequestContext, range: Excel.Range, wanted?: string[]): Promise<{ table: Table; headers: string[] }> {
  range.load("rowCount,columnCount");
  await ctx.sync();
  const { rowCount, columnCount } = range;
  if (rowCount < 2) throw new HostError("I need a header row and at least one row of data. Click a cell inside your table first.");

  // The header row, and the first data row's number formats (they tell dates from plain numbers).
  const firstData = range.getRow(1);
  firstData.load("numberFormat");
  const header = range.getRow(0);
  header.load("values");
  await ctx.sync();
  const headers = headerNames(header.values[0]);
  const allFormats = firstData.numberFormat[0].map((f) => String(f));

  const wantedKeys = wanted ? new Set(wanted.map((w) => w.toLowerCase())) : null;
  const picked = headers.map((h, j) => j).filter((j) => !wantedKeys || wantedKeys.has(headers[j].toLowerCase()));
  if (!picked.length) throw new HostError("None of the columns you picked are in this table any more. Pick the columns again.");
  if ((rowCount - 1) * picked.length > MAX_CELLS) {
    if (!wanted) {
      throw new TooWideError(`This table has ${num(rowCount - 1)} rows and ${columnCount} columns (${num(rowCount * columnCount)} cells), which is more than I can hold at once. `
        + "Pick the columns you need and I'll read only those.", headers, rowCount - 1);
    }
    throw new HostError(`Even those ${picked.length} columns are too much: ${num(rowCount - 1)} rows × ${picked.length} columns is more than I can hold at once (about ${num(MAX_CELLS)} cells). Pick fewer columns, or filter the data in Excel first.`);
  }

  // Neighbouring picked columns are read together, so a few big requests instead of one per column.
  const runs: [number, number][] = [];
  for (const j of picked) {
    const last = runs[runs.length - 1];
    if (last && last[1] === j - 1) last[1] = j;
    else runs.push([j, j]);
  }
  const rows: Cell[][] = Array.from({ length: rowCount - 1 }, () => []);
  const width = picked.length;
  let doneCells = 0;
  const totalCells = (rowCount - 1) * width;
  for (const [from, to] of runs) {
    const w = to - from + 1;
    let step = Math.max(1, Math.floor(READ_CELLS_PER_CHUNK / w));
    for (let r = 1; r < rowCount;) {
      const h = Math.min(step, rowCount - r);
      try {
        const part = range.getCell(r, from).getResizedRange(h - 1, w - 1);
        part.load("values");
        await ctx.sync();
        for (let i = 0; i < h; i++) for (const v of part.values[i]) rows[r - 1 + i].push(v as Cell);
        r += h;
        doneCells += h * w;
        if (totalCells > 200_000) progress.report(`Reading your table: ${num(Math.min(Math.round(doneCells / width), rowCount - 1))} of ${num(rowCount - 1)} rows…`);
      } catch (e) {
        if (!isTooBig(e) || step <= 50) throw e;
        step = Math.max(50, Math.floor(step / 2)); // Excel said that was too much at once: try half
      }
    }
  }
  return { table: makeTable(picked.map((j) => headers[j]), rows, picked.map((j) => allFormats[j])), headers };
}

export class ExcelHost implements Host {
  kind = "excel" as const;

  /** A big table is read once and kept until Excel says something on that sheet changed (reading 1,000,000 rows takes a while). */
  private cache: { key: string; source: Source; dirty: boolean } | null = null;
  private watching = new Set<string>();

  async readSource(ref?: SourceRef, fresh = false, columns?: string[]): Promise<Source> {
    return Excel.run(async (ctx) => {
      const { range, region } = await locate(ctx, ref);
      range.load("address");
      range.worksheet.load("name");
      await ctx.sync();
      const sheet = range.worksheet.name;
      const address = range.address.split("!").pop()!;
      const where = `${sheet}!${address}`;
      const key = `${where}|${columns ? [...columns].sort().join("\u0001") : ""}`;
      if (!fresh && this.cache && this.cache.key === key && !this.cache.dirty) return { ...this.cache.source, ref: { sheet, address, region } };
      const { table, headers } = await readTable(ctx, range, columns);
      const source: Source = { ref: { sheet, address, region }, label: where, table, headers };
      if (table.nrows > 20_000) {
        this.cache = { key, source, dirty: false };
        if (!this.watching.has(sheet)) {
          this.watching.add(sheet);
          ctx.workbook.worksheets.getItem(sheet).onChanged.add(async () => { if (this.cache) this.cache.dirty = true; });
          await ctx.sync();
        }
      } else if (this.cache?.key === key) this.cache = null;
      return source;
    }).catch(rethrow);
  }

  async listSheets(): Promise<string[]> {
    return Excel.run(async (ctx) => {
      const sheets = ctx.workbook.worksheets;
      sheets.load("items/name,items/visibility");
      await ctx.sync();
      return sheets.items.filter((w) => w.visibility === "Visible").map((w) => w.name);
    }).catch(rethrow);
  }

  async readSheet(name: string): Promise<Table> {
    return Excel.run(async (ctx) => {
      const used = ctx.workbook.worksheets.getItem(name).getUsedRangeOrNullObject(true);
      used.load("isNullObject");
      await ctx.sync();
      if (used.isNullObject) throw new HostError(`The sheet “${name}” is empty. Put a header row and your data on it first.`);
      used.load("rowCount");
      await ctx.sync();
      if (used.rowCount < 2) throw new HostError(`The sheet “${name}” has a header row but no data rows yet. Add the rows you want to look up, then try again.`);
      return (await readTable(ctx, used)).table;
    }).catch(rethrow);
  }

  async writeResult(sheets: Sheets, formats: FormatStep[] = [], liveCols: LiveColumn[] | null = null): Promise<WriteOutcome> {
    return Excel.run(async (ctx) => {
      const existing = ctx.workbook.worksheets;
      existing.load("items/name");
      ctx.workbook.tables.load("items/name");
      await ctx.sync();
      const taken = new Set(existing.items.map((w) => w.name.toLowerCase()));
      const tableNames = new Set(ctx.workbook.tables.items.map((t) => t.name.toLowerCase()));
      const created: Created[] = [];
      const notes: string[] = [];
      let first: Excel.Worksheet | null = null;

      const live = liveFormats(formats, sheets);
      for (const [wanted, table] of sheets) {
        const name = freeName(wanted, taken);
        const ws = ctx.workbook.worksheets.add(name);
        first ??= ws;
        const tableName = await writeTable(ctx, ws, table, tableNames);
        if (liveCols?.length && tableName) notes.push(...(await applyLiveColumns(ctx, ws, table, tableName, liveCols)));
        ws.load("name");
        formatSheet(ws, table, live);
        await ctx.sync();
        created.push({ name, rows: table.nrows });
      }
      created.push(...(await addCharts(ctx, sheets, live, taken)));
      await ctx.sync();
      first?.activate();
      await ctx.sync();
      return { created, notes };
    }).catch(rethrow);
  }

  async writePivot(source: SourceRef, spec: PivotSpec): Promise<Created> {
    return Excel.run(async (ctx) => {
      const { range } = await locate(ctx, source);
      const sheets = ctx.workbook.worksheets;
      sheets.load("items/name");
      ctx.workbook.pivotTables.load("items/name");
      await ctx.sync();
      const taken = new Set(sheets.items.map((w) => w.name.toLowerCase()));
      const name = freeName("Pivot", taken);
      const ws = sheets.add(name);
      const pt = ws.pivotTables.add(freeName("Pivot_" + name.replace(/\W+/g, "_"), new Set(ctx.workbook.pivotTables.items.map((p) => p.name.toLowerCase()))), range, ws.getRange("A3"));
      for (const r of spec.rows) pt.rowHierarchies.add(pt.hierarchies.getItem(r));
      for (const c of spec.columns) pt.columnHierarchies.add(pt.hierarchies.getItem(c));
      for (const d of spec.data) {
        const dh = pt.dataHierarchies.add(pt.hierarchies.getItem(d.column));
        dh.summarizeBy = d.func as Excel.AggregationFunction;
        dh.name = d.name;
      }
      ws.activate();
      await ctx.sync();
      return { name, rows: -1 };
    }).catch(rethrow);
  }

  async removeSheets(names: string[]): Promise<void> {
    await Excel.run(async (ctx) => {
      for (const n of names) ctx.workbook.worksheets.getItemOrNullObject(n).delete();
      await ctx.sync();
    }).catch(rethrow);
  }

  async refOf(sheetName: string): Promise<SourceRef> {
    return Excel.run(async (ctx) => {
      const used = ctx.workbook.worksheets.getItem(sheetName).getUsedRange(true);
      used.load("address");
      await ctx.sync();
      return { sheet: sheetName, address: used.address.split("!").pop()! };
    }).catch(rethrow);
  }
}

function freeName(wanted: string, taken: Set<string>): string {
  const base = wanted.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31) || "Result";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

async function writeTable(ctx: Excel.RequestContext, ws: Excel.Worksheet, t: Table, tableNames: Set<string>): Promise<string | null> {
  const cols = t.columns.length;
  if (!cols) return null;
  ws.getRangeByIndexes(0, 0, 1, cols).values = [t.columns.map((c) => c.name)];
  // Chunks hold at most WRITE_CELLS_PER_CHUNK cells and about WRITE_BYTES_PER_CHUNK of text, whichever comes first.
  for (let r = 0; r < t.nrows;) {
    let h = 0, cells = 0, bytes = 0;
    while (r + h < t.nrows && cells < WRITE_CELLS_PER_CHUNK && bytes < WRITE_BYTES_PER_CHUNK) {
      for (const c of t.columns) { const v = c.values[r + h]; bytes += typeof v === "string" ? v.length + 2 : 8; }
      cells += cols;
      h++;
    }
    const values = Array.from({ length: h }, (_, i) => t.columns.map((c) => c.values[r + i] ?? ""));
    let size = h;
    for (;;) {
      try {
        ws.getRangeByIndexes(1 + r, 0, size, cols).values = values.slice(0, size);
        await ctx.sync();
        break;
      } catch (e) {
        if (!isTooBig(e) || size <= 20) throw e;
        size = Math.max(20, Math.floor(size / 2)); // too big for Excel: send it in halves
      }
    }
    r += size;
    if (t.nrows > 20_000) progress.report(`Writing the result: ${num(Math.min(r, t.nrows))} of ${num(t.nrows)} rows…`);
  }
  t.columns.forEach((c, j) => {
    if (c.format && t.nrows) (ws.getRangeByIndexes(1, j, t.nrows, 1) as { numberFormat: unknown }).numberFormat = c.format;
  });
  const used = ws.getRangeByIndexes(0, 0, t.nrows + 1, cols);
  let tableName: string | null = null;
  try {
    // A real Excel Table: filter buttons, banded rows, and pivots/formulas can refer to it by name.
    const table = ws.tables.add(used, true);
    tableName = freeName("Table_" + ws.name.replace(/\W+/g, "_"), tableNames);
    table.name = tableName;
    table.style = "TableStyleMedium2";
    await ctx.sync();
  } catch {
    used.getRow(0).format.font.bold = true; // header cells that can't form a table (rare): at least make them stand out
    await ctx.sync();
  }
  ws.freezePanes.freezeRows(1);
  // Fit the column widths to the first rows only: measuring a million rows would take minutes.
  ws.getRangeByIndexes(0, 0, Math.min(t.nrows + 1, 500), cols).format.autofitColumns();
  await ctx.sync();
  return tableName;
}

/** Cells as Excel gives them back vs what the add-in worked out: the same, within rounding? */
function sameCell(expected: Cell, actual: unknown): boolean {
  if (expected === null) return actual === "" || actual === null;
  if (typeof expected === "number") return typeof actual === "number" && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  return actual === expected;
}

/**
 * Turn finished value columns into real formulas, then check Excel agrees with the numbers in the preview.
 * A column where it doesn't goes back to plain values, and the user is told.
 */
async function applyLiveColumns(ctx: Excel.RequestContext, ws: Excel.Worksheet, t: Table, tableName: string, live: LiveColumn[]): Promise<string[]> {
  const notes: string[] = [];
  const made: string[] = [];
  for (const lc of live) {
    const j = t.columns.findIndex((c) => c.name === lc.name);
    if (j < 0 || !t.nrows) continue;
    const col = t.columns[j];
    const range = ws.getRangeByIndexes(1, j, t.nrows, 1);
    let ok = false;
    try {
      (range as { formulas: unknown }).formulas = lc.build(tableName);
      await ctx.sync();
      const step = Math.max(1, Math.floor(READ_CELLS_PER_CHUNK));
      let bad = 0;
      for (let r = 0; r < t.nrows && bad === 0; r += step) {
        const part = ws.getRangeByIndexes(1 + r, j, Math.min(step, t.nrows - r), 1);
        part.load("values");
        await ctx.sync();
        part.values.forEach((row, i) => { if (!sameCell(col.values[r + i], row[0])) bad++; });
      }
      ok = bad === 0;
    } catch {
      ok = false;
    }
    if (ok) made.push(lc.name);
    else {
      notes.push(`“${lc.name}” is plain values: Excel's own calculation didn't match the preview exactly, so I kept the preview's numbers.`);
      for (let r = 0; r < t.nrows; r += WRITE_CELLS_PER_CHUNK) {
        const h = Math.min(WRITE_CELLS_PER_CHUNK, t.nrows - r);
        ws.getRangeByIndexes(1 + r, j, h, 1).values = col.values.slice(r, r + h).map((v) => [v ?? ""]);
      }
      await ctx.sync();
    }
  }
  if (made.length) notes.unshift(`Live formulas: ${made.map((n) => `“${n}”`).join(", ")} update by themselves when you change the data in this table.`);
  return notes;
}

function rethrow(e: unknown): never {
  if (e instanceof HostError) throw e;
  const err = e as { message?: string; code?: string };
  throw new HostError(`Excel said: ${err.message ?? String(e)}`);
}
