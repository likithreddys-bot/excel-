/** "state wise on time paid percentage": "wise" means "by", and a percentage with a rule is a rate per group; without a rule it's a question. */
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { Sheets, makeTable } from "../src/engine/table";

const repay = (): Sheets => new Map([["Result", makeTable(
  ["statename", "b0_amt", "b0_status", "b0_paid_flag"],
  [
    ["MAHARASHTRA", 4418, "ONTIME", 1], ["MAHARASHTRA", 4409, "LATE", 0], ["MAHARASHTRA", 100, "ONTIME", 1], ["MAHARASHTRA", 50, "ONTIME", 1],
    ["KARNATAKA", 0, "LATE", 0], ["KARNATAKA", 2671, "ONTIME", 1],
    ["WEST BENGAL", 2843, "LATE", 0],
    [null, 10, "ONTIME", 1],
  ],
)]]);

const run = (cmd: string) => {
  const plan = makePlan(repay(), cmd);
  return { plan, out: plan.clarification_question ? null : [...applyPlan(repay(), plan).values()][0] };
};

describe("percentage of rows where ... by a group", () => {
  it("gives the percent of each group's rows that meet the rule", () => {
    const { plan, out } = run("percentage of rows where b0_status is ONTIME by statename");
    expect(plan.clarification_question).toBeNull();
    const t = out!;
    expect(t.columns.map((c) => c.name)).toEqual(["statename", "rows", "matching rows", "% matching"]);
    const row = (name: string | null) => t.columns.map((c) => c.values[t.columns[0].values.indexOf(name)]);
    expect(row("MAHARASHTRA")).toEqual(["MAHARASHTRA", 4, 3, 75]);
    expect(row("KARNATAKA")).toEqual(["KARNATAKA", 2, 1, 50]);
    expect(row("WEST BENGAL")).toEqual(["WEST BENGAL", 1, 0, 0]);
    expect(row(null)).toEqual([null, 1, 1, 100]); // blank state kept, shown last
    expect(t.columns[0].values[t.nrows - 1]).toBeNull();
  });

  it("understands 'state wise' as 'by state'", () => {
    for (const cmd of ["statename wise percentage of rows where b0_paid_flag = 1", "percentage of rows where b0_paid_flag is 1 statename wise"]) {
      const { plan, out } = run(cmd);
      expect(plan.clarification_question, cmd).toBeNull();
      expect(out!.columns[0].name).toBe("statename");
      expect(out!.columns[3].values[out!.columns[0].values.indexOf("MAHARASHTRA")]).toBe(75);
    }
  });

  it("works without a group (one overall percentage)", () => {
    const { out } = run("what percentage of rows where b0_status is ONTIME");
    expect(out!.nrows).toBe(1);
    expect(out!.columns.map((c) => c.name)).toEqual(["rows", "matching rows", "% matching"]);
    expect(out!.columns.map((c) => c.values[0])).toEqual([8, 5, 62.5]);
  });

  it("asks, with a worked example, instead of guessing when no rule is given", () => {
    const { plan } = run("show me state wise on time b0 paid percentage");
    expect(plan.clarification_question).toMatch(/won't guess/);
    expect(plan.clarification_question).toMatch(/percentage of rows where .* by statename/);
  });

  it("keeps the older meaning of share of total", () => {
    const { plan, out } = run("percentage share of b0_amt by statename");
    expect(plan.clarification_question).toBeNull();
    expect(out!.columns[0].name).toBe("statename");
    expect(out!.columns.length).toBe(3); // the total and each group's share
  });
});

describe("'X wise' elsewhere", () => {
  it("state wise total amount = total amount by state", () => {
    const { plan, out } = run("statename wise total b0_amt");
    expect(plan.clarification_question).toBeNull();
    expect(out!.columns.map((c) => c.name)).toEqual(["statename", "sum_b0_amt"]);
  });
  it("leaves 'otherwise' alone", () => {
    const plan = makePlan(repay(), "add column x = 1 if b0_status is ONTIME otherwise 0");
    expect(plan.clarification_question).toBeNull();
  });
});
