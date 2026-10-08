/**
 * Writes tables as an .xlsx file (a zip of XML) entirely in the browser, streaming each sheet so a million rows
 * don't need a million-row string. Supports bold headers, frozen header row, filter buttons, column widths,
 * number formats and highlight colours.
 */
import { Zip, ZipDeflate, strToU8 } from "fflate";
import { FormatStep, excelNumberFormat, highlightMask } from "../engine/format";
import { Cell, Sheets, Table } from "../engine/table";
import { msToSerial } from "../engine/util";

const esc = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

export function colLetters(j: number): string {
  let s = "";
  for (let n = j + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Sheet names Excel accepts: at most 31 characters, none of []:*?/\, unique ignoring case. */
export function sheetNames(wanted: string[]): string[] {
  const taken = new Set<string>();
  return wanted.map((w) => {
    const base = w.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31) || "Sheet";
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

class Styles {
  private formats = new Map<string, number>(); // custom format code -> numFmtId
  private fills: string[] = [];
  private xfs: { fmt: number; fill: number; bold: boolean }[] = [{ fmt: 0, fill: 0, bold: false }, { fmt: 0, fill: 0, bold: true }];
  private index = new Map<string, number>([["0|0|0", 0], ["0|0|1", 1]]);

  private formatId(code: string | undefined): number {
    if (!code || code === "General") return 0;
    let id = this.formats.get(code);
    if (id === undefined) { id = 164 + this.formats.size; this.formats.set(code, id); }
    return id;
  }

  private fillId(color: string | undefined): number {
    if (!color) return 0;
    let i = this.fills.indexOf(color);
    if (i < 0) { i = this.fills.push(color) - 1; }
    return i + 2;
  }

  xf(format?: string, fill?: string): number {
    const f = this.formatId(format), g = this.fillId(fill);
    const key = `${f}|${g}|0`;
    let at = this.index.get(key);
    if (at === undefined) { at = this.xfs.push({ fmt: f, fill: g, bold: false }) - 1; this.index.set(key, at); }
    return at;
  }

  xml(): string {
    const numFmts = this.formats.size
      ? `<numFmts count="${this.formats.size}">${[...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escAttr(code)}"/>`).join("")}</numFmts>` : "";
    const fills = `<fills count="${this.fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${
      this.fills.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c.replace(/^#/, "").toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}</fills>`;
    const xfs = this.xfs.map((x) => `<xf numFmtId="${x.fmt}" fontId="${x.bold ? 1 : 0}" fillId="${x.fill}" borderId="0" xfId="0"${x.fmt ? ' applyNumberFormat="1"' : ""}${x.fill ? ' applyFill="1"' : ""}${x.bold ? ' applyFont="1"' : ""}/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}`
      + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>${fills}`
      + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${xfs}</cellXfs>`
      + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

/** The value to store for a cell: dates held as text become real Excel dates. */
function cellValue(t: Table, j: number, i: number): Cell {
  const c = t.columns[j];
  const v = c.values[i];
  if (c.kind === "date" && typeof v === "string" && c.time?.[i] != null) return msToSerial(c.time[i]!);
  return v;
}

const DEFAULT_DATE = "dd/mm/yyyy";

/** Build the .xlsx for `sheets` (already named; names are made safe and unique here). */
export async function buildXlsx(sheets: Sheets, formats: FormatStep[] = [], progress?: (message: string) => void): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => { if (err) failure = err; else parts.push(data); });
  const put = (path: string, xml: string) => {
    const f = new ZipDeflate(path, { level: 1 });
    zip.add(f);
    f.push(strToU8(xml), true);
  };

  const entries = [...sheets.entries()];
  const names = sheetNames(entries.map(([n]) => n));
  const styles = new Styles();

  // Worksheets first (the styles they use are collected as they are written); the small parts follow.
  const sheetPaths: string[] = [];
  for (let s = 0; s < entries.length; s++) {
    const t = entries[s][1];
    const path = `xl/worksheets/sheet${s + 1}.xml`;
    sheetPaths.push(path);
    const file = new ZipDeflate(path, { level: 1 });
    zip.add(file);
    const push = (xml: string, final = false) => file.push(strToU8(xml), final);

    // Per-column formats, then per-row highlight colours.
    const overrides = new Map<string, string>();
    for (const f of formats) {
      if (f.op === "number_format") for (const n of f.columns ?? t.columns.filter((c) => c.kind === "number").map((c) => c.name)) overrides.set(n, excelNumberFormat(f));
    }
    const colFormat = t.columns.map((c) => overrides.get(c.name) ?? (c.kind === "date" ? c.format ?? DEFAULT_DATE : c.format));
    const marks = formats.flatMap((f) => (f.op === "highlight" ? [{ mask: highlightMask(t, f), col: f.column ? t.columns.findIndex((c) => c.name === f.column) : -1, color: f.color }] : []));
    const plain = t.columns.map((_, j) => styles.xf(colFormat[j]));

    const widths = t.columns.map((c) => {
      let w = c.name.length;
      for (let i = 0; i < Math.min(t.nrows, 200); i++) { const v = c.values[i]; if (v !== null) w = Math.max(w, String(v).length); }
      return Math.min(60, Math.max(8, w + 2));
    });
    const ncols = Math.max(1, t.columns.length);
    const last = `${colLetters(ncols - 1)}${t.nrows + 1}`;
    push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>`);

    let buf = `<row r="1">${t.columns.map((c, j) => `<c r="${colLetters(j)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(c.name)}</t></is></c>`).join("")}</row>`;
    for (let i = 0; i < t.nrows; i++) {
      const r = i + 2;
      let row = `<row r="${r}">`;
      for (let j = 0; j < t.columns.length; j++) {
        const v = cellValue(t, j, i);
        let fill: string | undefined;
        for (const m of marks) if (m.mask[i] && (m.col < 0 || m.col === j)) fill = m.color;
        if (v === null || v === "") {
          if (fill) row += `<c r="${colLetters(j)}${r}" s="${styles.xf(colFormat[j], fill)}"/>`;
          continue;
        }
        const style = fill ? styles.xf(colFormat[j], fill) : plain[j];
        const ref = `${colLetters(j)}${r}`;
        if (typeof v === "number") row += Number.isFinite(v) ? `<c r="${ref}" s="${style}"><v>${v}</v></c>` : "";
        else if (typeof v === "boolean") row += `<c r="${ref}" s="${style}" t="b"><v>${v ? 1 : 0}</v></c>`;
        else row += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }
      buf += row + "</row>";
      if (buf.length > 1_000_000) {
        push(buf);
        buf = "";
        if (failure) throw failure;
        if (t.nrows > 20_000 && i % 20_000 === 0) {
          progress?.(`Making the Excel file: ${(i + 1).toLocaleString("en-IN")} of ${t.nrows.toLocaleString("en-IN")} rows…`);
          await new Promise((res) => setTimeout(res, 0)); // let the page breathe
        }
      }
    }
    push(buf + `</sheetData>${t.nrows ? `<autoFilter ref="A1:${last}"/>` : ""}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`, true);
  }

  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + sheetPaths.map((_, s) => `<Override PartName="/xl/worksheets/sheet${s + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><bookViews><workbookView/></bookViews><sheets>`
    + names.map((n, s) => `<sheet name="${escAttr(n)}" sheetId="${s + 1}" r:id="rId${s + 1}"/>`).join("") + `</sheets></workbook>`);
  put("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheetPaths.map((_, s) => `<Relationship Id="rId${s + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${s + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheetPaths.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  put("xl/styles.xml", styles.xml());
  zip.end();
  if (failure) throw failure;
  return new Blob(parts as BlobPart[], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
