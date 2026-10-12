/** Old / new users: ask once, remember, then a pivot of the repayment percentage (the brief's own example). */
import { describe, expect, it } from "vitest";
import { Dictionary, fingerprint, segmentWords, suggestSegmentDefs } from "../src/engine/dictionary";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { Sheets, makeTable } from "../src/engine/table";

const NAMES = ["statename", "cx_repeat_flag", "loan_order_cnt", "alloc_amt", "b0_amt", "tot_amt"];
const ROWS = [
  ["MH", 1, 3, 1000, 1000, 1000], ["MH", 1, 2, 1000, 0, 1000], ["MH", 0, 1, 2000, 2000, 2000],
  ["KA", 0, 1, 2000, 0, 0], ["KA", 1, 4, 1000, 1000, 1000], ["KA", 0, 1, 1000, 0, 500],
];
const sheet = (): Sheets => new Map([["Result", makeTable(NAMES, ROWS)]]);
const byFlag: Dictionary = { segments: { user_type: { column: "cx_repeat_flag", operator: "equals", value: "1", oldLabel: "Old", newLabel: "New" } } };

describe("segment words", () => {
  it.each([
    ["repayment percentage of old users and new users", true, true],
    ["old vs new customers", true, true],
    ["new and existing customers repayment", true, true],
    ["only new users", false, true],
    ["repeat borrowers", true, false],
    ["total amount by branch", false, false],
    ["the old amount and the new amount", false, false],
  ])("%s", (text, old, nw) => expect(segmentWords(text)).toEqual({ old, new: nw }));
});

describe("definitions are offered from the file's columns, never applied unasked", () => {
  it("a 0/1 repeat flag and a loan-order count", () => {
    const options = suggestSegmentDefs(sheet().get("Result")!);
    expect(options.map((o) => o.label)).toEqual([
      "Old = cx_repeat_flag is 1  ·  New = otherwise",
      "Old = loan_order_cnt is more than 1 (a repeat loan)  ·  New = otherwise",
    ]);
  });
  it("no candidate column: asks the user to say it", () => {
    const t = makeTable(["a", "b"], [[1, 2]]);
    const plan = makePlan(new Map([["Result", t]]), "repayment percentage of old users and new users");
    expect(plan.clarification_question).toMatch(/Tell me/);
    expect(plan.needs_definition?.options).toEqual([]);
  });
  it("the layout fingerprint ignores the file name and is stable", () => {
    expect(fingerprint(NAMES)).toBe(fingerprint([...NAMES]));
    expect(fingerprint(NAMES)).not.toBe(fingerprint(NAMES.slice(1)));
  });
});

describe("the example: repayment percentage of old users and new users, as a pivot table", () => {
  const ask = (cmd: string, dict?: Dictionary) => makePlan(sheet(), cmd, [], {}, {}, dict);
  const run = (cmd: string, dict?: Dictionary) => {
    const plan = ask(cmd, dict);
    expect(plan.clarification_question, cmd).toBeNull();
    return [...applyPlan(sheet(), plan).values()][0];
  };
  const cell = (t: ReturnType<typeof run>, row: string, col: string) => t.columns.find((c) => c.name === col)!.values[t.columns[0].values.indexOf(row)];

  it("without a definition it asks, with options, and runs nothing", () => {
    const plan = ask("repayment percentage of old users and new users as pivot table");
    expect(plan.steps).toEqual([]);
    expect(plan.needs_definition?.term).toBe("user_type");
    expect(plan.needs_definition?.options).toHaveLength(2);
  });

  it("with the saved definition it is a pivot with Due, Repaid, Repayment % and a Total row", () => {
    const t = run("repayment percentage of old users and new users as pivot table", byFlag);
    expect(t.columns.map((c) => c.name)).toEqual(["user_type", "Due", "Repaid", "Repayment %"]);
    expect(cell(t, "Old", "Due")).toBe(3000);
    expect(cell(t, "Old", "Repaid")).toBe(3000);
    expect(cell(t, "Old", "Repayment %")).toBe(100);
    expect(cell(t, "New", "Due")).toBe(5000);
    expect(cell(t, "New", "Repaid")).toBe(2500);
    expect(cell(t, "New", "Repayment %")).toBe(50);
    expect(cell(t, "Total", "Repayment %")).toBe(68.75); // 5500 of 8000: totals are ratios of sums, not averages of percentages
  });

  it("a different definition changes the answer (count of loans instead of the flag)", () => {
    const byCount: Dictionary = { segments: { user_type: { column: "loan_order_cnt", operator: "gt", value: "1", oldLabel: "Old", newLabel: "New" } } };
    const t = run("repayment percentage of old users and new users as pivot table", byCount);
    expect(cell(t, "Old", "Repayment %")).toBe(100);
    expect(cell(t, "New", "Repayment %")).toBe(50);
  });

  it("rows read Old, then New, then Total (not alphabetically)", () => {
    const t = run("repayment percentage of old users and new users as pivot table", byFlag);
    expect(t.columns[0].values).toEqual(["Old", "New", "Total"]);
  });

  it("without the word pivot: a plain two-row table", () => {
    const t = run("repayment percentage of old users and new users", byFlag);
    expect(t.columns.map((c) => c.name)).toEqual(["user_type", "tot_amt % of alloc_amt"]);
  });

  it("split by state as well", () => {
    const t = run("repayment percentage of old users and new users state wise as pivot", byFlag);
    expect(t.columns.map((c) => c.name)).toEqual(["user_type", "statename", "Due", "Repaid", "Repayment %"]);
    expect(t.nrows).toBe(5); // 2 states x 2 types + Total
  });

  it("one side only: new users, on time", () => {
    const t = run("on time repayment percentage of new users", byFlag);
    expect(t.nrows).toBe(1);
    expect(t.columns[0].values[0]).toBe("New");
    expect(t.columns[1].values[0]).toBe(40); // b0 1000 of 5000... per the b0 column
  });

  it("a saved definition naming a column that is not loaded says so", () => {
    const t = makeTable(["statename", "alloc_amt", "tot_amt"], [["MH", 1, 1]]);
    const plan = makePlan(new Map([["Result", t]]), "repayment percentage of old users and new users", [], {}, {}, byFlag);
    expect(plan.clarification_question).toMatch(/needs the column cx_repeat_flag/);
  });
});
