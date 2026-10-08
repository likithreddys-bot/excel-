/**
 * Reads an .xlsx file in the browser, streaming: the sheet XML is inflated in pieces and only the cells of the
 * columns asked for are kept, so a 100,000 x 300 sheet can be read for the 5 columns a question needs.
 */
import { Cell, Table, headerNames, makeTable } from "../engine/table";
import { readEntries, streamEntry, ZipEntry } from "./zip";

export interface XlsxBook {
  file: Blob;
  entries: Map<string, ZipEntry>;
  sheets: { name: string; path: string }[];
  shared?: string[];
  styles?: Style[];
}

interface Style {
  format: string | undefined;
}

export interface SheetHead {
  headers: string[];
  /** Data rows (not counting the header), from the sheet's own size note; -1 if the file doesn't say. */
  rows: number;
  /** The sheet row number the headers are on (leading blank rows are skipped). */
  headerRow: number;
}

const decoder = () => new TextDecoder("utf-8");

function unescapeXml(s: string): string {
  if (s.indexOf("&") < 0 && s.indexOf("_x") < 0) return s;
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e];
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

async function text(book: XlsxBook, path: string): Promise<string> {
  const e = book.entries.get(path) ?? book.entries.get(path.replace(/^\//, ""));
  if (!e) return "";
  const dec = decoder();
  let out = "";
  await streamEntry(book.file, e, (c) => { out += dec.decode(c, { stream: true }); });
  return out + dec.decode();
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};

export async function openXlsx(file: Blob): Promise<XlsxBook> {
  const entries = await readEntries(file);
  const book: XlsxBook = { file, entries, sheets: [] };
  const wb = await text(book, "xl/workbook.xml");
  if (!wb) throw new Error("This doesn't look like an Excel workbook (.xlsx).");
  const rels = await text(book, "xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target"), type = attr(m[0], "Type") ?? "";
    if (id && target && /\/worksheet$/.test(type)) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name"), rid = attr(m[0], "r:id"), state = attr(m[0], "state");
    const path = rid ? targets.get(rid) : undefined;
    if (name && path && state !== "hidden" && state !== "veryHidden") book.sheets.push({ name, path });
  }
  if (!book.sheets.length) throw new Error("I can't find any sheets with data in this workbook.");
  return book;
}

async function sharedStrings(book: XlsxBook): Promise<string[]> {
  if (book.shared) return book.shared;
  const out: string[] = [];
  const e = book.entries.get("xl/sharedStrings.xml");
  if (e) {
    const dec = decoder();
    let buf = "";
    const take = (final: boolean) => {
      for (;;) {
        const s = buf.indexOf("<si");
        if (s < 0) { buf = ""; return; }
        const next = buf.charCodeAt(s + 3);
        if (next !== 62 && next !== 32 && next !== 47) { buf = buf.slice(s + 3); continue; }
        const closeTag = buf.indexOf(">", s);
        if (closeTag < 0) { buf = buf.slice(s); return; }
        if (buf.charCodeAt(closeTag - 1) === 47) { out.push(""); buf = buf.slice(closeTag + 1); continue; } // <si/>
        const end = buf.indexOf("</si>", closeTag);
        if (end < 0) { buf = buf.slice(s); if (final) return; return; }
        const item = buf.slice(closeTag + 1, end);
        let value = "";
        const clean = item.indexOf("<rPh") >= 0 ? item.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "") : item;
        for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += m[1];
        out.push(unescapeXml(value));
        buf = buf.slice(end + 5);
      }
    };
    await streamEntry(book.file, e, (c) => { buf += dec.decode(c, { stream: true }); take(false); });
    buf += dec.decode();
    take(true);
  }
  book.shared = out;
  return out;
}

const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  14: "dd/mm/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "dd/mm/yyyy h:mm",
  27: "dd/mm/yyyy", 28: "dd/mm/yyyy", 29: "dd/mm/yyyy", 30: "dd/mm/yyyy", 31: "dd/mm/yyyy", 32: "h:mm", 33: "h:mm:ss", 34: "h:mm", 35: "h:mm:ss", 36: "dd/mm/yyyy",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 50: "dd/mm/yyyy", 51: "dd/mm/yyyy", 52: "dd/mm/yyyy", 53: "dd/mm/yyyy", 54: "dd/mm/yyyy", 55: "dd/mm/yyyy", 56: "dd/mm/yyyy", 57: "dd/mm/yyyy", 58: "dd/mm/yyyy",
};

async function styles(book: XlsxBook): Promise<Style[]> {
  if (book.styles) return book.styles;
  const xml = await text(book, "xl/styles.xml");
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = attr(m[0], "numFmtId"), code = attr(m[0], "formatCode");
    if (id && code) custom.set(Number(id), code);
  }
  const out: Style[] = [];
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (block) {
    for (const m of block[1].matchAll(/<xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], "numFmtId") ?? 0);
      out.push({ format: custom.get(id) ?? BUILTIN_FORMATS[id] });
    }
  }
  book.styles = out;
  return out;
}

const colIndex = (letters: string): number => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

type Row = { n: number; cells: Map<number, { v: Cell; style: number }> };

/** Walk the sheet XML row by row. `onRow` returns false to stop. `wanted` limits which columns are decoded. */
async function walkRows(
  book: XlsxBook, path: string, wanted: Set<number> | null, shared: string[],
  onRow: (row: Row) => boolean | void, onSize?: (rows: number) => void, onBytes?: (done: number, total: number) => void,
): Promise<void> {
  const entry = book.entries.get(path);
  if (!entry) throw new Error("A sheet in this workbook is missing from the file.");
  const dec = decoder();
  let buf = "";
  let pos = 0;
  let sawSize = false;
  let stopped = false;
  let consumed = 0;
  let lastRow = 0;

  const wantedFlags: boolean[] | null = wanted ? [] : null;
  if (wanted && wantedFlags) for (const j of wanted) wantedFlags[j] = true;

  /** The cells of the row whose tag is buf[rowStart..tagEnd) and whose body ends at rowEnd. Scans in place: unwanted cells cost no allocation. */
  const parseRow = (rowStart: number, tagEnd: number, rowEnd: number): Row => {
    const ra = buf.indexOf(' r="', rowStart);
    const row: Row = { n: ra >= 0 && ra < tagEnd ? parseInt(buf.slice(ra + 4, ra + 14), 10) : lastRow + 1, cells: new Map() };
    lastRow = row.n;
    let i = tagEnd + 1, prev = -1;
    while (i < rowEnd) {
      const s = buf.indexOf("<c", i);
      if (s < 0 || s >= rowEnd) break;
      const ch = buf.charCodeAt(s + 2);
      if (ch !== 32 && ch !== 62 && ch !== 47) { i = s + 2; continue; } // <col…, <cols…: not a cell
      const gt = buf.indexOf(">", s);
      if (gt < 0 || gt >= rowEnd) break;
      // column from r="B5": the letters before the digits
      let col = prev + 1;
      const r = buf.indexOf(' r="', s);
      if (r >= 0 && r < gt) {
        let k = r + 4, n = 0;
        for (let c = buf.charCodeAt(k); c >= 65 && c <= 90; c = buf.charCodeAt(++k)) n = n * 26 + (c - 64);
        if (k > r + 4) col = n - 1;
      }
      prev = col;
      if (buf.charCodeAt(gt - 1) === 47) { i = gt + 1; continue; } // empty cell, self-closing
      const close = buf.indexOf("</c>", gt);
      if (close < 0 || close >= rowEnd) break;
      i = close + 4;
      if (wantedFlags && !wantedFlags[col]) continue;
      const tag = buf.slice(s, gt);
      const ta = tag.indexOf(' t="');
      const t = ta >= 0 ? tag.slice(ta + 4, tag.indexOf('"', ta + 4)) : "";
      const sa = tag.indexOf(' s="');
      const style = sa >= 0 ? parseInt(tag.slice(sa + 4, sa + 14), 10) : 0;
      let v: Cell = null;
      if (t === "inlineStr") {
        let str = "";
        for (const m of buf.slice(gt + 1, close).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) str += m[1];
        v = unescapeXml(str);
      } else {
        const vs = buf.indexOf("<v", gt);
        if (vs >= 0 && vs < close) {
          const vOpen = buf.indexOf(">", vs);
          const vEnd = buf.indexOf("</v>", vOpen);
          const raw = vEnd < 0 || vEnd > close ? "" : buf.slice(vOpen + 1, vEnd);
          if (t === "s") v = shared[Number(raw)] ?? null;
          else if (t === "str") v = unescapeXml(raw);
          else if (t === "b") v = raw === "1";
          else if (t === "e") v = null;
          else if (t === "d") v = raw;
          else if (raw !== "") { const num = Number(raw); v = Number.isNaN(num) ? raw : num; }
        }
      }
      if (v !== null && v !== "") row.cells.set(col, { v, style });
    }
    return row;
  };

  const take = () => {
    for (;;) {
      if (!sawSize) {
        const d = buf.indexOf("<dimension", pos);
        const firstRow = buf.indexOf("<row", pos);
        if (d >= 0 && (firstRow < 0 || d < firstRow)) {
          const e = buf.indexOf(">", d);
          if (e < 0) return;
          const ref = attr(buf.slice(d, e), "ref");
          const m = ref ? /(?:[A-Z]+)?(\d+)?(?::[A-Z]+(\d+))?$/.exec(ref) : null;
          onSize?.(m && m[2] ? Number(m[2]) - (Number(m[1] ?? 1)) : -1);
          sawSize = true;
        } else if (firstRow >= 0) { onSize?.(-1); sawSize = true; } else return;
      }
      const s = buf.indexOf("<row", pos);
      if (s < 0) { pos = Math.max(pos, buf.length - 4); return; }
      const nextCh = buf.charCodeAt(s + 4);
      if (nextCh !== 32 && nextCh !== 62 && nextCh !== 47) { pos = s + 4; continue; }
      const gt = buf.indexOf(">", s);
      if (gt < 0) { pos = s; return; }
      if (buf.charCodeAt(gt - 1) === 47) { // empty row, self-closing
        pos = gt + 1;
        if (onRow(parseRow(s, gt, gt)) === false) { stopped = true; return; }
        continue;
      }
      const end = buf.indexOf("</row>", gt);
      if (end < 0) { pos = s; return; }
      pos = end + 6;
      if (onRow(parseRow(s, gt, end)) === false) { stopped = true; return; }
    }
  };

  await streamEntry(book.file, entry, (chunk) => {
    consumed += chunk.length;
    buf += dec.decode(chunk, { stream: true });
    take();
    if (pos > 0) { buf = buf.slice(pos); pos = 0; }
    onBytes?.(consumed, entry.size);
    return !stopped;
  });
  if (!stopped) { buf += dec.decode(); take(); }
}

export async function sheetHead(book: XlsxBook, sheet: string): Promise<SheetHead> {
  const info = book.sheets.find((s) => s.name === sheet);
  if (!info) throw new Error(`There's no sheet called “${sheet}”.`);
  const shared = await sharedStrings(book);
  let rows = -1;
  let headers: string[] = [];
  let headerRow = 1;
  await walkRows(book, info.path, null, shared, (row) => {
    if (!row.cells.size) return true; // leading blank rows
    headerRow = row.n;
    const last = Math.max(...row.cells.keys());
    const raw: unknown[] = [];
    for (let j = 0; j <= last; j++) raw.push(row.cells.get(j)?.v ?? "");
    headers = headerNames(raw);
    return false;
  }, (n) => { rows = n; });
  if (!headers.length) throw new Error(`The sheet “${sheet}” is empty. Put a header row and your data on it first.`);
  return { headers, rows, headerRow };
}

/** Read a sheet's table (first row = headers). `columns` limits it to those columns, by header name. */
export async function readSheet(
  book: XlsxBook, sheet: string, columns?: string[], progress?: (message: string) => void,
): Promise<{ table: Table; headers: string[] }> {
  const info = book.sheets.find((s) => s.name === sheet);
  if (!info) throw new Error(`There's no sheet called “${sheet}”.`);
  const shared = await sharedStrings(book);
  const st = await styles(book);
  const head = await sheetHead(book, sheet);
  const keys = columns ? new Set(columns.map((c) => c.toLowerCase())) : null;
  const picked = head.headers.map((h, j) => j).filter((j) => !keys || keys.has(head.headers[j].toLowerCase()));
  if (!picked.length) throw new Error("None of the columns you picked are in this sheet. Pick the columns again.");
  const wanted = new Set(picked);
  const cols: Cell[][] = picked.map(() => []);
  const formats: (string | undefined)[] = picked.map(() => undefined);
  const slot = new Map(picked.map((j, k) => [j, k]));
  let have = 0; // data rows stored so far
  let lastFilled = 0; // data rows up to the last one with any value (trailing formatted-but-empty rows are dropped)
  const report = (done: number, total: number) => progress?.(`Reading your file: ${Math.min(99, Math.round((done / Math.max(1, total)) * 100))}%${head.rows > 0 ? ` of about ${head.rows.toLocaleString("en-IN")} rows` : ""}…`);

  await walkRows(book, info.path, wanted, shared, (row) => {
    if (row.n <= head.headerRow) return true;
    const index = row.n - head.headerRow - 1;
    while (have < index) { for (const c of cols) c.push(null); have++; }
    const values: Cell[] = new Array(picked.length).fill(null);
    for (const [j, cell] of row.cells) {
      const k = slot.get(j)!;
      values[k] = cell.v;
      if (formats[k] === undefined && typeof cell.v === "number") formats[k] = st[cell.style]?.format;
    }
    for (let k = 0; k < cols.length; k++) cols[k].push(values[k]);
    have++;
    if (row.cells.size) lastFilled = have;
    return true;
  }, undefined, report);

  const n = lastFilled;
  if (n < 1) throw new Error("I need a header row and at least one row of data in this sheet.");
  const rows: Cell[][] = Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
  return { table: makeTable(picked.map((j) => head.headers[j]), rows, formats), headers: head.headers };
}
