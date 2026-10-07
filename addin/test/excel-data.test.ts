/** How data arrives from Excel: dates are serial numbers, blanks are "", sheet names are limited. */
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { Sheets, makeTable } from "../src/engine/table";
import { msToSerial, utcDay } from "../src/engine/util";

const serial = (y: number, m: number, d: number) => msToSerial(utcDay(y, m, d)!);

function sheet(): Sheets {
  const rows = [
    [1, serial(2024, 1, 15), "Travel", 1200, "DEBIT"],
    [2, serial(2024, 2, 20), "Rent", 30000, "DEBIT"],
    [3, serial(2025, 3, 5), "Travel", 800, "CREDIT"],
    [4, serial(2025, 3, 25), "Cash/ATM", "", "DEBIT"],
    [5, "", "Travel", 50, "DEBIT"],
  ];
  return new Map([["Result", makeTable(["id", "when", "category", "amount", "type"], rows, ["0", "dd/mm/yyyy", "General", "#,##0", "General"])]]);
}

const run = (cmd: string) => {
  const plan = makePlan(sheet(), cmd);
  expect(plan.clarification_question).toBeNull();
  return applyPlan(sheet(), plan);
};

describe("data read from Excel", () => {
  it("recognises date columns by their number format", () => {
    const t = sheet().get("Result")!;
    expect(t.columns.map((c) => c.kind)).toEqual(["number", "date", "text", "number", "text"]);
  });

  it("filters serial-number dates by year and month", () => {
    expect(run("in 2025").get("Result")!.nrows).toBe(2);
    expect(run("in march 2025").get("Result")!.nrows).toBe(2);
    expect(run("after 01/02/2024").get("Result")!.nrows).toBe(3);
  });

  it("treats blank cells as empty and keeps them last when sorting", () => {
    expect(run("amount is empty").get("Result")!.nrows).toBe(1);
    const out = run("sort by amount descending").get("Result")!;
    expect(out.columns[3].values).toEqual([30000, 1200, 800, 50, null]);
  });

  it("sorts and splits dates chronologically, blank dates last", () => {
    const out = run("sort by when").get("Result")!;
    expect(out.columns[0].values).toEqual([1, 2, 3, 4, 5]);
    const months = run("split by month");
    expect([...months.keys()]).toEqual(["2024-01", "2024-02", "2025-03", "(blank)"]);
  });

  it("makes legal, unique sheet names", () => {
    const out = run("split by category");
    expect([...out.keys()]).toEqual(["Cash_ATM", "Rent", "Travel"]);
  });

  it("weekday sheets come out Monday to Sunday", () => {
    const out = run("split by weekday");
    expect([...out.keys()]).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "(blank)"].filter((k) => out.has(k)));
  });

  it("keeps the original cell values (including serial dates) in the result", () => {
    const out = run("only category is travel").get("Result")!;
    expect(out.columns[1].values).toEqual([serial(2024, 1, 15), serial(2025, 3, 5), null]);
    expect(out.columns[1].format).toBe("dd/mm/yyyy");
  });

  it("reads a date column that mixes real dates and text dates (as after pasting)", () => {
    const rows = [[serial(2025, 10, 3), 5], ["20/03/2025", 6], ["25/03/2025", 7]];
    const t = makeTable(["date", "n"], rows, ["dd/mm/yyyy", "0"]);
    expect(t.columns[0].kind).toBe("date");
    expect(t.columns[0].mixedDates).toBe(true);
    const plan = makePlan(new Map([["Result", t]]), "in march 2025");
    expect(plan.clarification_question).toBeNull();
    expect(applyPlan(new Map([["Result", t]]), plan).get("Result")!.nrows).toBe(2);
  });
});
