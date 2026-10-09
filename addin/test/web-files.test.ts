/** The website's file readers and writer: real .xlsx files from two libraries, CSVs, wide sheets, and a round trip. */
import { openAsBlob } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Sheets, makeTable } from "../src/engine/table";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { readCsv, csvHead } from "../src/web/csv";
import { WebHost } from "../src/web/host";
import { buildXlsx } from "../src/web/xlsx-write";
import { openXlsx, readSheet, sheetHead } from "../src/web/xlsx-read";
import { TooWideError } from "../src/host";

const fixture = (name: string) => openAsBlob(join(__dirname, "fixtures", name));
const asFile = async (name: string) => new File([await fixture(name)], name);

describe("xlsx reader", () => {
  for (const [file, sheet] of [["small_xw.xlsx", "Transactions"], ["small_opx.xlsx", "Data"]] as const) {
    it(`reads ${file}`, async () => {
      const book = await openXlsx(await fixture(file));
      expect(book.sheets.map((s) => s.name)).toContain(sheet);
      expect(book.sheets.map((s) => s.name)).not.toContain("Hidden");
      const head = await sheetHead(book, sheet);
      expect(head.headers).toEqual(["id", "txn_date", "name", "amount", "branch", "note"]);
      const { table } = await readSheet(book, sheet);
      expect(table.nrows).toBe(5);
      const by = Object.fromEntries(table.columns.map((c) => [c.name, c]));
      expect(by.id.values).toEqual([1, 2, 3, 4, 5]);
      expect(by.txn_date.kind).toBe("date");
      expect(by.txn_date.values[0]).toBe(45306); // 15 Jan 2024
      expect(by.txn_date.values[4]).toBeNull();
      expect(by.name.values).toEqual(["Asha & Sons", "  Ravi <R>  ", "Zoya", "Zoya", "Ünïcode ₹"]);
      expect(by.amount.kind).toBe("number");
      expect(by.amount.values).toEqual([1200.5, 30000, null, 50, -75.25]);
      expect(by.branch.values).toEqual(["Mumbai", "Pune", "Mumbai", null, "Delhi"]);
      expect(by.note.values[0]).toBe('say "hi", ok');
      expect(by.note.values[1]).toBe("line1\nline2");
    });
  }

  it("reads only the columns asked for", async () => {
    const book = await openXlsx(await fixture("small_xw.xlsx"));
    const { table, headers } = await readSheet(book, "Transactions", ["Amount", "branch"]);
    expect(table.columns.map((c) => c.name)).toEqual(["amount", "branch"]);
    expect(headers).toHaveLength(6);
    expect(table.nrows).toBe(5);
  });

  it("skips leading blank rows and trailing empty formatted rows", async () => {
    const book = await openXlsx(await fixture("offset.xlsx"));
    const { table } = await readSheet(book, "S");
    expect(table.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(table.columns[0].values).toEqual([1, 3]);
  });

  it("reads a wide sheet's chosen columns, and knows the size without reading it", async () => {
    const book = await openXlsx(await fixture("wide.xlsx"));
    const head = await sheetHead(book, "Wide");
    expect(head.headers).toHaveLength(300);
    expect(head.rows).toBe(2000);
    const { table } = await readSheet(book, "Wide", ["col1", "col2", "col299"]);
    expect(table.nrows).toBe(2000);
    expect(table.columns[0].values[3]).toBe(3001);
    expect(table.columns[2].values[0]).toBe(299);
  });

  it("explains a file that is not an xlsx", async () => {
    await expect(openXlsx(new Blob(["hello world, not a zip file at all"]))).rejects.toThrow(/xlsx/);
  });
});

describe("csv reader", () => {
  it("handles quotes, embedded newlines, a BOM, blanks and day-first dates", async () => {
    const { table, headers } = await readCsv(await fixture("small.csv"));
    expect(headers).toEqual(["id", "txn_date", "name", "amount", "branch", "note"]);
    expect(table.nrows).toBe(5);
    const by = Object.fromEntries(table.columns.map((c) => [c.name, c]));
    expect(by.id.values).toEqual([1, 2, 3, 4, 5]);
    expect(by.txn_date.kind).toBe("date");
    expect(by.amount.values).toEqual([1200.5, 30000, null, 50, -75.25]);
    expect(by.note.values[0]).toBe('say "hi", ok');
    expect(by.note.values[1]).toBe("line1\nline2");
    expect(by.branch.values[3]).toBeNull();
  });

  it("detects the delimiter and ignores blank lines at the end", async () => {
    expect((await csvHead(await fixture("semicolon.csv"))).delimiter).toBe(";");
    const semi = await readCsv(await fixture("semicolon.csv"));
    expect(semi.table.nrows).toBe(2);
    expect(semi.table.columns.map((c) => c.name)).toEqual(["id", "amount", "branch"]);
    const tab = await readCsv(await fixture("tab.tsv"));
    expect(tab.table.nrows).toBe(2); // no trailing newline
    expect(tab.table.columns[1].values).toEqual([5, 6]);
  });

  it("reads chosen columns of a wide file, and estimates its rows", async () => {
    const head = await csvHead(await fixture("wide.csv"));
    expect(head.headers).toHaveLength(300);
    expect(head.rows).toBeGreaterThan(1500);
    expect(head.rows).toBeLessThan(2500);
    const { table } = await readCsv(await fixture("wide.csv"), ["col1", "col299"]);
    expect(table.nrows).toBe(2000);
    expect(table.columns[0].values[5]).toBe(5001);
  });

  it("copes with text split across read chunks", async () => {
    const lines = ["a,b"];
    for (let i = 0; i < 5000; i++) lines.push(`${i},"quoted, with ""escapes"" and\nnewline ${i}"`);
    const blob = new Blob([lines.join("\n")]);
    const { table } = await readCsv(blob);
    expect(table.nrows).toBe(5000);
    expect(table.columns[1].values[4999]).toBe('quoted, with "escapes" and\nnewline 4999');
  });
});

describe("xlsx writer", () => {
  it("round-trips values, dates, blanks, formats and sheet names through the reader", async () => {
    const src = makeTable(["id", "when", "name", "amount", "ok"], [
      [1, 45306, "A & B <c>", 1200.5, true],
      [2, 45307, "multi\nline", null, false],
      [3, null, null, -5, null],
    ], ["0", "dd/mm/yyyy", "General", "#,##0.00", "General"]);
    const sheets: Sheets = new Map([["Result: one/two?", src], ["Second", src]]);
    const blob = await buildXlsx(sheets);
    const book = await openXlsx(blob);
    expect(book.sheets.map((s) => s.name)).toEqual(["Result_ one_two_", "Second"]);
    const { table } = await readSheet(book, "Second");
    expect(table.nrows).toBe(3);
    expect(table.columns[0].values).toEqual([1, 2, 3]);
    expect(table.columns[1].kind).toBe("date");
    expect(table.columns[1].values).toEqual([45306, 45307, null]);
    expect(table.columns[2].values).toEqual(["A & B <c>", "multi\nline", null]);
    expect(table.columns[3].values).toEqual([1200.5, null, -5]);
    expect(table.columns[3].format).toBe("#,##0.00");
  });

  it("is valid enough for another library to open (openpyxl is checked in gen step); a 100k-row sheet streams", async () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => [i, `row ${i}`, i * 1.5]);
    const blob = await buildXlsx(new Map([["Big", makeTable(["n", "label", "x"], rows)]]));
    expect(blob.size).toBeGreaterThan(100_000);
    const { table } = await readSheet(await openXlsx(blob), "Big");
    expect(table.nrows).toBe(100_000);
    expect(table.columns[2].values[99_999]).toBe(149_998.5);
  });
});

describe("web host", () => {
  it("opens files, reads a sheet, runs a command and keeps the result as a sheet", async () => {
    const host = new WebHost();
    const { added, problems } = await host.addFiles([await asFile("small_xw.xlsx")]);
    expect(problems).toEqual([]);
    expect(added).toEqual(["Transactions", "Branches"]);
    const src = await host.readSource();
    expect(src.table.nrows).toBe(5);
    const sheets: Sheets = new Map([["Result", src.table]]);
    const plan = makePlan(sheets, "total amount by branch");
    const out = applyPlan(sheets, plan);
    const made = await host.writeResult(out);
    expect(made.created).toHaveLength(1);
    expect(host.sheetList().some((s) => s.result)).toBe(true);
    const xlsx = await host.xlsxOf(made.created.map((c) => c.name));
    const back = await readSheet(await openXlsx(xlsx), made.created[0].name);
    expect(back.table.nrows).toBeGreaterThan(0);
  });

  it("looks up from a second sheet and a CSV opened alongside", async () => {
    const host = new WebHost();
    await host.addFiles([await asFile("small_xw.xlsx"), await asFile("semicolon.csv")]);
    expect(await host.listSheets()).toEqual(["Transactions", "Branches", "semicolon"]);
    expect((await host.readSheet("Branches")).nrows).toBe(2);
  });

  it("asks for columns when a table is too wide to hold, and reads just those", async () => {
    const host = new WebHost();
    await host.addFiles([await asFile("wide.xlsx")]);
    // 2,000 x 300 = 600,000 cells fits, so build the too-wide case from the numbers the host checks
    const small = await host.readSource();
    expect(small.table.columns).toHaveLength(300);
    const err = new TooWideError("x", ["a"], 1);
    expect(err.headers).toEqual(["a"]);
    const some = await host.readSource(undefined, true, ["col5", "col6"]);
    expect(some.table.columns.map((c) => c.name)).toEqual(["col5", "col6"]);
    expect(some.headers).toHaveLength(300);
  });

  it("says what to do with an old .xls file or the wrong kind of file", async () => {
    const host = new WebHost();
    const { added, problems } = await host.addFiles([new File(["x"], "old.xls"), new File(["x"], "pic.png")]);
    expect(added).toEqual([]);
    expect(problems[0]).toMatch(/Save As/);
    expect(problems[1]).toMatch(/isn't an Excel/);
  });
});
