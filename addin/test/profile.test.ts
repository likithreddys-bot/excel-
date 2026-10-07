import { describe, expect, it } from "vitest";
import { makePlan } from "../src/engine/parser";
import { profile } from "../src/engine/profile";
import { Cell, Sheets, makeTable } from "../src/engine/table";

const sheetOf = (names: string[], rows: Cell[][]): Sheets => new Map([["Result", makeTable(names, rows)]]);

describe("beginner mode: what the add-in notices", () => {
  const rows: Cell[][] = [
    ["  Asha  Rao ", "pune", "₹1,200", "01/03/2025", 10],
    ["vikram SINGH", "Pune ", "Rs. 90", "02/03/2025", null],
    ["vikram SINGH", "Pune ", "Rs. 90", "02/03/2025", null],
    [null, null, null, null, null],
    ["Meera iyer", "PUNE", "3,400.50", "03/03/2025", 5],
  ];
  const sheets = sheetOf(["name", "city", "amt", "date", "score"], rows);
  const found = profile(sheets.get("Result")!);

  it("notices the common problems", () => {
    const text = found.map((f) => f.message).join("\n");
    expect(text).toMatch(/completely empty/);
    expect(text).toMatch(/exact repeat/);
    expect(text).toMatch(/extra spaces/);
    expect(text).toMatch(/“amt” holds amounts saved as text/);
    expect(text).toMatch(/“city” spells the same value in different ways/);
  });

  it("every suggested fix is a command the add-in understands", () => {
    for (const f of found) {
      const plan = makePlan(sheets, f.command);
      expect(plan.clarification_question, `${f.command} -> ${plan.clarification_question}`).toBeNull();
      expect(plan.steps.length).toBeGreaterThan(0);
    }
  });

  it("says nothing about a clean table", () => {
    const clean = sheetOf(["branch", "amount"], [["Mumbai", 10], ["Pune", 20], ["Delhi", 30]]);
    expect(profile(clean.get("Result")!)).toEqual([]);
  });

  it("leaves id-like digit text alone", () => {
    const ids = sheetOf(["phone", "n"], [["9876543210", 1], ["9123456780", 2], ["9000000001", 3]]);
    expect(profile(ids.get("Result")!).map((f) => f.command)).toEqual([]);
  });

  it("flags a date column that mixes real dates and text", () => {
    const serial = 45933;
    const mixed = sheetOf(["date", "n"], [[serial, 1], ["20/03/2025", 2], ["25/03/2025", 3]]);
    const t = makeTable(["date", "n"], [[serial, 1], ["20/03/2025", 2], ["25/03/2025", 3]], ["dd/mm/yyyy", "0"]);
    expect(profile(t).some((f) => f.command === "convert date to date")).toBe(true);
    expect(mixed.size).toBe(1);
  });
});
