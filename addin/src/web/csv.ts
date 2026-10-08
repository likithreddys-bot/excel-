/** Streaming CSV reader: only the columns asked for are kept, so a wide file doesn't have to fit in memory. */
import { Cell, Table, headerNames, makeTable } from "../engine/table";

export interface CsvHead {
  headers: string[];
  /** Estimated data rows (file size / average line length of the first lines). */
  rows: number;
  delimiter: string;
}

const NEWLINE = (c: number) => c === 10 || c === 13;

/**
 * Parse one record starting at `i`. Fields at columns in `wanted` (all, if null) are stored in `out`.
 * Returns the index after the record, or -1 when the buffer ends before the record does (and `final` is false).
 */
function record(buf: string, i: number, delim: number, wanted: Set<number> | null, out: Map<number, string>, final: boolean): number {
  out.clear();
  let col = 0;
  const n = buf.length;
  for (;;) {
    let value: string | null = null;
    if (i < n && buf.charCodeAt(i) === 34) {
      let j = i + 1;
      for (;;) {
        j = buf.indexOf('"', j);
        if (j < 0) return -1;
        if (j + 1 >= n && !final) return -1; // can't tell "" from the closing quote yet
        if (buf.charCodeAt(j + 1) === 34) { j += 2; continue; }
        break;
      }
      if (!wanted || wanted.has(col)) value = buf.slice(i + 1, j).replace(/""/g, '"');
      i = j + 1;
      // anything between the closing quote and the delimiter is ignored
      while (i < n && buf.charCodeAt(i) !== delim && !NEWLINE(buf.charCodeAt(i))) i++;
    } else {
      const start = i;
      while (i < n) {
        const c = buf.charCodeAt(i);
        if (c === delim || c === 10 || c === 13) break;
        i++;
      }
      if (!wanted || wanted.has(col)) value = buf.slice(start, i);
    }
    if (value !== null) out.set(col, value);
    if (i >= n) return final ? n : -1;
    const c = buf.charCodeAt(i);
    if (c === delim) { i++; col++; continue; }
    // end of record
    if (c === 13) {
      if (i + 1 >= n && !final) return -1;
      return buf.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
    return i + 1;
  }
}

async function chunks(file: Blob, onText: (text: string, final: boolean) => boolean | void): Promise<void> {
  const reader = file.stream().getReader();
  const dec = new TextDecoder("utf-8");
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    let text = done ? dec.decode() : dec.decode(value, { stream: true });
    if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text) first = false;
    if (onText(text, done) === false) { await reader.cancel(); return; }
    if (done) return;
  }
}

function detectDelimiter(firstLine: string): string {
  let best = ",", bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let count = 0, quoted = false;
    for (const ch of firstLine) { if (ch === '"') quoted = !quoted; else if (ch === d && !quoted) count++; }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

function toCell(s: string): Cell {
  if (s === "") return null;
  if (s.length <= 15 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s); // IDs with leading zeros stay text
  return s;
}

export async function csvHead(file: Blob): Promise<CsvHead> {
  let buf = "";
  let headers: string[] | null = null;
  let delimiter = ",";
  let lens = 0, seen = 0;
  const out = new Map<number, string>();
  await chunks(file, (text, final) => {
    buf += text;
    if (!headers) {
      const nl = buf.search(/[\r\n]/);
      if (nl < 0 && !final) return true;
      delimiter = detectDelimiter(nl < 0 ? buf : buf.slice(0, nl));
    }
    let at = 0;
    for (;;) {
      const next = record(buf, at, delimiter.charCodeAt(0), null, out, final);
      if (next < 0) break;
      if (!headers) {
        const last = Math.max(-1, ...out.keys());
        const raw: unknown[] = [];
        for (let j = 0; j <= last; j++) raw.push(out.get(j) ?? "");
        if (raw.every((r) => r === "")) { at = next; continue; }
        headers = headerNames(raw);
      } else {
        lens += next - at; seen++;
        if (seen >= 200) return false;
      }
      at = next;
      if (next >= buf.length) break;
    }
    buf = buf.slice(at);
    return !(headers && seen >= 200);
  });
  if (!headers) throw new Error("This file is empty. It needs a header row and data.");
  const avg = seen ? lens / seen : 0; // characters, close enough to bytes for an estimate
  return { headers, rows: avg ? Math.max(0, Math.round(file.size / avg) - 1) : seen, delimiter };
}

export async function readCsv(file: Blob, columns?: string[], progress?: (message: string) => void): Promise<{ table: Table; headers: string[] }> {
  const head = await csvHead(file);
  const keys = columns ? new Set(columns.map((c) => c.toLowerCase())) : null;
  const picked = head.headers.map((h, j) => j).filter((j) => !keys || keys.has(head.headers[j].toLowerCase()));
  if (!picked.length) throw new Error("None of the columns you picked are in this file. Pick the columns again.");
  const wanted = new Set(picked);
  const cols: Cell[][] = picked.map(() => []);
  const slot = new Map(picked.map((j, k) => [j, k]));
  const delim = head.delimiter.charCodeAt(0);
  const out = new Map<number, string>();
  let buf = "";
  let headerDone = false;
  let bytes = 0;
  await chunks(file, (text, final) => {
    buf += text;
    bytes += text.length;
    let at = 0;
    for (;;) {
      if (at >= buf.length) break;
      const next = record(buf, at, delim, headerDone ? wanted : null, out, final);
      if (next < 0) break;
      if (!headerDone) {
        // skip blank lines above the header, then the header itself
        if ([...out.values()].some((v) => v !== "")) headerDone = true;
      } else {
        const values: Cell[] = new Array(picked.length).fill(null);
        let any = false;
        for (const [j, v] of out) { const k = slot.get(j); if (k !== undefined) { values[k] = toCell(v); if (v !== "") any = true; } }
        if (any || out.size) for (let k = 0; k < cols.length; k++) cols[k].push(values[k]);
      }
      at = next;
    }
    buf = buf.slice(at);
    if (!final) progress?.(`Reading your file: ${Math.min(99, Math.round((bytes / Math.max(1, file.size)) * 100))}%${head.rows > 0 ? ` of about ${head.rows.toLocaleString("en-IN")} rows` : ""}…`);
  });
  // blank lines at the end are not rows
  let n = cols[0].length;
  while (n > 0 && cols.every((c) => c[n - 1] === null)) n--;
  if (n < 1) throw new Error("I need a header row and at least one row of data in this file.");
  const rows: Cell[][] = Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
  return { table: makeTable(picked.map((j) => head.headers[j]), rows), headers: head.headers };
}
