/** The report workbook: every result sheet, plus a "How calculated" sheet that explains each one. */
import type { FormatStep } from "../engine/format";
import { Cell, Sheets, makeTable } from "../engine/table";
import { buildXlsx } from "../web/xlsx-write";
import { howLines } from "./tools";
import { Workspace } from "./workspace";

/** Result sheets (all of them, or just `names`) plus a "How calculated" sheet for them. */
export function reportSheets(workspace: Workspace, names?: string[]): { sheets: Sheets; formats: FormatStep[] } {
  const sheets: Sheets = new Map();
  const how: Cell[][] = [];
  const formats: FormatStep[] = [];
  for (const r of workspace.results().filter((x) => !names || names.includes(x.name))) {
    sheets.set(r.name, r.table);
    formats.push(...r.formats);
    how.push([r.name, r.from, r.purpose, howLines(r).join("\n"), r.notes.join("\n")]);
  }
  sheets.set("How calculated", makeTable(["Sheet", "Made from", "What it shows", "Steps (run on every row)", "Notes"], how));
  return { sheets, formats };
}

export async function reportBlob(workspace: Workspace, names?: string[]): Promise<Blob> {
  const { sheets, formats } = reportSheets(workspace, names);
  return buildXlsx(sheets, formats);
}
