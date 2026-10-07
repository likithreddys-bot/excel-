/** Reads and writes real Excel worksheets through Office.js. */
import { Cell, Sheets, Table, makeTable } from "../engine/table";
import { Created, Host, HostError, Source, SourceRef } from "../host";

const READ_CELLS_PER_CHUNK = 100_000;
const WRITE_CELLS_PER_CHUNK = 50_000;

/** Header text for each column: blanks become "Column N", repeats get " (2)". */
function headerNames(raw: unknown[]): string[] {
  const seen = new Set<string>();
  return raw.map((h, i) => {
    let name = String(h ?? "").trim() || `Column ${i + 1}`;
    const base = name;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    seen.add(name.toLowerCase());
    return name;
  });
}

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

export class ExcelHost implements Host {
  kind = "excel" as const;

  async readSource(ref?: SourceRef): Promise<Source> {
    return Excel.run(async (ctx) => {
      const { range, region } = await locate(ctx, ref);
      range.load("address,rowCount,columnCount");
      range.worksheet.load("name");
      await ctx.sync();
      const { rowCount, columnCount } = range;
      if (rowCount < 2) throw new HostError("I need a header row and at least one row of data. Click a cell inside your table first.");

      // The first data row's number formats tell dates from plain numbers.
      const firstData = range.getRow(1);
      firstData.load("numberFormat");
      const header = range.getRow(0);
      header.load("values");
      await ctx.sync();
      const names = headerNames(header.values[0]);
      const formats = firstData.numberFormat[0].map((f) => String(f));

      const rows: Cell[][] = [];
      const step = Math.max(1, Math.floor(READ_CELLS_PER_CHUNK / columnCount));
      for (let r = 1; r < rowCount; r += step) {
        const part = range.getCell(r, 0).getResizedRange(Math.min(step, rowCount - r) - 1, columnCount - 1);
        part.load("values");
        await ctx.sync();
        for (const row of part.values) rows.push(row as Cell[]);
      }
      const sheet = range.worksheet.name;
      const address = range.address.split("!").pop()!;
      return { ref: { sheet, address, region }, label: `${sheet}!${address}`, table: makeTable(names, rows, formats) };
    }).catch(rethrow);
  }

  async writeResult(sheets: Sheets): Promise<Created[]> {
    return Excel.run(async (ctx) => {
      const existing = ctx.workbook.worksheets;
      existing.load("items/name");
      ctx.workbook.tables.load("items/name");
      await ctx.sync();
      const taken = new Set(existing.items.map((w) => w.name.toLowerCase()));
      const tableNames = new Set(ctx.workbook.tables.items.map((t) => t.name.toLowerCase()));
      const created: Created[] = [];
      let first: Excel.Worksheet | null = null;

      for (const [wanted, table] of sheets) {
        const name = freeName(wanted, taken);
        const ws = ctx.workbook.worksheets.add(name);
        first ??= ws;
        await writeTable(ctx, ws, table, tableNames);
        created.push({ name, rows: table.nrows });
      }
      first?.activate();
      await ctx.sync();
      return created;
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

async function writeTable(ctx: Excel.RequestContext, ws: Excel.Worksheet, t: Table, tableNames: Set<string>): Promise<void> {
  const cols = t.columns.length;
  if (!cols) return;
  ws.getRangeByIndexes(0, 0, 1, cols).values = [t.columns.map((c) => c.name)];
  const step = Math.max(1, Math.floor(WRITE_CELLS_PER_CHUNK / cols));
  for (let r = 0; r < t.nrows; r += step) {
    const h = Math.min(step, t.nrows - r);
    const values = Array.from({ length: h }, (_, i) => t.columns.map((c) => c.values[r + i] ?? ""));
    ws.getRangeByIndexes(1 + r, 0, h, cols).values = values;
    await ctx.sync();
  }
  t.columns.forEach((c, j) => {
    if (c.format && t.nrows) (ws.getRangeByIndexes(1, j, t.nrows, 1) as { numberFormat: unknown }).numberFormat = c.format;
  });
  const used = ws.getRangeByIndexes(0, 0, t.nrows + 1, cols);
  try {
    // A real Excel Table: filter buttons, banded rows, and pivots/formulas can refer to it by name.
    const table = ws.tables.add(used, true);
    table.name = freeName("Table_" + ws.name.replace(/\W+/g, "_"), tableNames);
    table.style = "TableStyleMedium2";
    await ctx.sync();
  } catch {
    used.getRow(0).format.font.bold = true; // header cells that can't form a table (rare): at least make them stand out
    await ctx.sync();
  }
  ws.freezePanes.freezeRows(1);
  used.format.autofitColumns();
  await ctx.sync();
}

function rethrow(e: unknown): never {
  if (e instanceof HostError) throw e;
  const err = e as { message?: string; code?: string };
  throw new HostError(`Excel said: ${err.message ?? String(e)}`);
}
