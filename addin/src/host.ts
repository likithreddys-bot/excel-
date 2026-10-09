/** What the task pane needs from the spreadsheet it runs in. Excel implements it; a demo implements it for browsers. */
import type { FormatStep } from "./engine/format";
import type { LiveColumn, PivotSpec } from "./engine/live";
import type { Sheets, Table } from "./engine/table";

export interface SourceRef {
  sheet: string;
  address: string;
  /** Found by clicking inside a table: re-read it from its top-left cell so rows added later are included. */
  region?: boolean;
}

export interface Source {
  ref: SourceRef;
  /** "Sheet1!A1:H2001" for display. */
  label: string;
  table: Table;
  /** Every column header of the table in the file, even when only some columns were read. */
  headers: string[];
}

export interface Created {
  name: string;
  rows: number;
}

export interface WriteOutcome {
  created: Created[];
  /** Things worth telling the user, e.g. a formula that gave a different answer in Excel and was written as values. */
  notes: string[];
}

export interface Host {
  kind: "excel" | "demo" | "web";
  /**
   * Read the user's table: from `ref` if given, else from their current selection. With `columns`, only those
   * columns are read (wide tables are too big to hold whole); a table that is too big to read whole without
   * them raises a TooWideError.
   */
  readSource(ref?: SourceRef, fresh?: boolean, columns?: string[]): Promise<Source>;
  /** Names of the workbook's visible sheets (other sheets can be looked up, appended or compared). */
  listSheets(): Promise<string[]>;
  /** The whole used range of a sheet, first row as headers. */
  readSheet(name: string): Promise<Table>;
  /** Write each sheet as a new worksheet (never over existing ones). */
  writeResult(sheets: Sheets, formats?: FormatStep[], live?: LiveColumn[] | null): Promise<WriteOutcome>;
  /** A native PivotTable on a new sheet, built from the table at `source`. */
  writePivot(source: SourceRef, spec: PivotSpec): Promise<Created>;
  removeSheets(names: string[]): Promise<void>;
  /** Where to read next if the user wants to carry on from the new sheet. */
  refOf(sheetName: string): Promise<SourceRef>;
}

export class HostError extends Error {}

/** The user pressed Cancel during a long read. */
export class Cancelled extends HostError {
  constructor() {
    super("Cancelled. Nothing was changed.");
  }
}

/** The table is too big to read in full: the user must pick the columns they need. */
export class TooWideError extends HostError {
  constructor(message: string, readonly headers: string[], readonly rows: number) {
    super(message);
  }
}

/** Most cells the add-in will hold in memory at once (rows x columns read). */
export const MAX_CELLS = 8_000_000;
