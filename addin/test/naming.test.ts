import { describe, expect, it } from "vitest";
import { sheetNameFor } from "../src/engine/naming";
import { makePlan } from "../src/engine/parser";
import { Cell, Sheets, makeTable } from "../src/engine/table";

const rows: Cell[][] = [["Mumbai", "DEBIT", 7000, "01/03/2025"], ["Pune", "CREDIT", 2500, "05/03/2025"]];
const sheets: Sheets = new Map([["Result", makeTable(["branch", "type", "amount", "date"], rows)]]);
const name = (cmd: string) => sheetNameFor(makePlan(sheets, cmd));

describe("result sheet names", () => {
  it.each([
    ["total amount by branch", "Totals by branch"],
    ["pivot amount by branch and type", "Pivot by branch"],
    ["top 5 by amount", "Top 5 by amount"],
    ["only debits", "Filtered"],
    ["sort by amount descending", "Sorted by amount"],
    ["remove duplicate rows", "No duplicates"],
    ["add column gst = amount * 0.18", "With gst"],
    ["trim spaces", "Cleaned"],
    ["only debits and sort by amount", "Sorted by amount"],
    ["total amount by month", "Totals by month"],
    ["highlight debits in red", "Formatted"],
    ["bar chart of total amount by branch", "Result"],
  ])("%s -> %s", (cmd, expected) => expect(name(cmd)).toBe(expected));

  it("fits Excel's 31 character limit", () => {
    const wide: Sheets = new Map([["Result", makeTable(["a long column name here", "another long column name", "x"], [["a", "b", 1]])]]);
    expect(sheetNameFor(makePlan(wide, "total x by a long column name here and another long column name")).length).toBeLessThanOrEqual(31);
  });
});
