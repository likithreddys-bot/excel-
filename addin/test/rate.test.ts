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

describe("amounts as a percent of each other, and two-column rules", () => {
  const loans = (): Sheets => new Map([["Result", makeTable(
    ["statename", "b0_amt", "alloc_amt", "due_date", "repaid_date"],
    [
      ["MAHARASHTRA", 1000, 1000, 45300, 45300], ["MAHARASHTRA", 0, 1000, 45300, 45310], ["MAHARASHTRA", 500, 1000, 45300, 45299],
      ["KARNATAKA", 0, 2000, 45300, null], ["KARNATAKA", 2000, 2000, 45300, 45299],
      ["DELHI", 0, 500, 45300, 45320],
    ],
    [undefined, undefined, undefined, "dd/mm/yyyy", "dd/mm/yyyy"],
  )]]);
  const go = (cmd: string) => {
    const plan = makePlan(loans(), cmd);
    expect(plan.clarification_question, cmd).toBeNull();
    return [...applyPlan(loans(), plan).values()][0];
  };
  const by = (t: ReturnType<typeof go>, state: string, col: string) => t.columns.find((c) => c.name === col)!.values[t.columns[0].values.indexOf(state)];

  it("'A as percentage of B by state' totals each, then divides (not a share of the grand total)", () => {
    for (const cmd of ["b0_amt as percentage of alloc_amt by statename", "statename wise percentage of b0_amt to alloc_amt"]) {
      const t = go(cmd);
      expect(t.columns.map((c) => c.name)).toEqual(["statename", "b0_amt % of alloc_amt"]);
      expect(by(t, "MAHARASHTRA", "b0_amt % of alloc_amt")).toBe(50); // 1500 / 3000
      expect(by(t, "KARNATAKA", "b0_amt % of alloc_amt")).toBe(50);   // 2000 / 4000
      expect(by(t, "DELHI", "b0_amt % of alloc_amt")).toBe(0);
    }
  });

  it("a rule comparing two columns (paid on or before the due date); a blank paid date never counts", () => {
    for (const cmd of ["percentage of rows where repaid_date <= due_date by statename", "statename wise percentage of rows where repaid_date is on or before due_date"]) {
      const t = go(cmd);
      expect(by(t, "MAHARASHTRA", "% matching")).toBe(66.67); // 2 of 3
      expect(by(t, "KARNATAKA", "% matching")).toBe(50);      // the blank one is not "on time"
      expect(by(t, "DELHI", "% matching")).toBe(0);
    }
  });

  it("'add column ..., then total ...' runs as two steps and totals the ratio the calculated-field way", () => {
    const t = go("add column b0_paid_pct = b0_amt / alloc_amt * 100, then total b0_paid_pct by statename");
    expect(by(t, "KARNATAKA", "b0_paid_pct")).toBe(50);
    expect(by(t, "MAHARASHTRA", "b0_paid_pct")).toBe(50);
  });
});

describe("repayment percentage, as people actually phrase it (real column names)", () => {
  // b0_amt = repaid on time (bucket B0), alloc_amt = amount due
  const loans = (): Sheets => new Map([["Result", makeTable(
    ["statename", "before_b0_amt", "b0_amt", "alloc_amt", "tot_amt", "repaid_amt", "marital_status"],
    [
      ["MAHARASHTRA", 1000, 1000, 1000, 1000, 1000, "Single"], ["MAHARASHTRA", 1000, 0, 1000, 1000, 1200, "married"],
      ["KARNATAKA", 0, 0, 2000, 0, 0, "Single"], ["KARNATAKA", 2000, 2000, 2000, 2000, 2000, "married"],
      ["DELHI", 500, 500, 500, 500, 500, "Single"],
    ],
  )]]);
  const go = (cmd: string) => {
    const plan = makePlan(loans(), cmd);
    return { plan, out: plan.clarification_question ? null : [...applyPlan(loans(), plan).values()][0] };
  };
  const pct = (t: NonNullable<ReturnType<typeof go>["out"]>, state: string) => t.columns[t.columns.length - 1].values[t.columns[0].values.indexOf(state)];

  it.each([
    "show state wise repayment percentage of b0 amount",
    "i want total statewise repaid b0 percentage",
    "show statename wise b0 repayment percentage",
  ])("%s -> b0_amt as a percent of alloc_amt per state", (cmd) => {
    const { plan, out } = go(cmd);
    expect(plan.clarification_question, cmd).toBeNull();
    expect(out!.columns.map((c) => c.name)).toEqual(["statename", "b0_amt % of alloc_amt"]);
    expect(pct(out!, "MAHARASHTRA")).toBe(50);  // 1000 of 2000
    expect(pct(out!, "KARNATAKA")).toBe(50);    // 2000 of 4000
    expect(pct(out!, "DELHI")).toBe(100);
  });

  it("'b0 amount' means the column b0_amt; 'statewise' without a space means by state", () => {
    const { plan, out } = go("statewise total b0 amount");
    expect(plan.clarification_question).toBeNull();
    expect(out!.columns.map((c) => c.name)).toEqual(["statename", "sum_b0_amt"]);
  });

  it("'state wise' means statename, not state_category", () => {
    const sheets: Sheets = new Map([["Result", makeTable(
      ["statename", "state_category", "b0_amt", "alloc_amt"],
      [["MH", "A", 100, 200], ["KA", "B", 50, 100], ["DL", "A", 0, 100]],
    )]]);
    const plan = makePlan(sheets, "show state wise repayment percentage of b0 amount");
    expect(plan.clarification_question).toBeNull();
    const t = [...applyPlan(sheets, plan).values()][0];
    expect(t.columns[0].name).toBe("statename");
    expect(t.nrows).toBe(3);
  });

  it("total repayment: tot_amt over alloc_amt", () => {
    const { out } = go("statewise repayment percentage of tot_amt");
    expect(pct(out!, "MAHARASHTRA")).toBe(100);
    expect(pct(out!, "KARNATAKA")).toBe(50);
  });

  it("'repaid percentage' alone is repaid_amt over what was due", () => {
    const { out } = go("statename wise repaid percentage");
    expect(out!.columns.map((c) => c.name)).toEqual(["statename", "repaid_amt % of alloc_amt"]); // "repaid" names the repaid column
    expect(pct(out!, "KARNATAKA")).toBe(50);
  });

  it("an on-time percentage that points at no amount is still a question", () => {
    expect(go("statename wise on time percentage").plan.clarification_question).toMatch(/won't guess/);
  });
});

describe("plain 'repayment percentage' phrasing gives just the state and its percentage", () => {
  // the real loaded columns, including state_category (a code 1-3) next to statename
  const names = ["due_date", "cur_bucket", "alloc_amt", "before_b0_amt", "b0_amt", "tot_amt", "repaid_date", "repaid_amt", "statename", "state_category"];
  const sheet = (): Sheets => new Map([["Result", makeTable(names, [
    [45993, "B0", 4418, 4418, 4418, 4418, 45993, 4525, "MAHARASHTRA", 2],
    [45993, "B1", 3921, 0, 0, 3921, 46030, 4047, "KARNATAKA", 1],
    [45993, "B5", 891, 0, 0, 0, null, null, "MAHARASHTRA", 2],
    [45993, "B0", 2671, 2671, 2671, 2671, 45995, 2671, "ANDHRA PRADESH", 2],
  ])]]);
  const run = (cmd: string) => {
    const plan = makePlan(sheet(), cmd);
    expect(plan.clarification_question, cmd).toBeNull();
    return [...applyPlan(sheet(), plan).values()][0];
  };
  const asMap = (t: ReturnType<typeof run>) => Object.fromEntries(t.columns[0].values.map((v, i) => [v, t.columns[1].values[i]]));

  it.each([
    "show me state wise repayment",
    "state wise repayment percentage",
    "statename and repayment percentage",
    "what is the repayment percentage state wise",
    "repayment percentage by state",
  ])("%s", (cmd) => {
    const t = run(cmd);
    expect(t.columns.map((c) => c.name)).toEqual(["statename", "tot_amt % of alloc_amt"]); // statename, not state_category
    expect(asMap(t)).toEqual({ "ANDHRA PRADESH": 100, KARNATAKA: 100, MAHARASHTRA: 83.22 }); // MH: 4418 repaid of 4418 + 891 due
  });

  it("'on time' means bucket B0", () => {
    const t = run("state wise on time repayment percentage");
    expect(t.columns[1].name).toBe("b0_amt % of alloc_amt");
    expect(asMap(t)).toEqual({ "ANDHRA PRADESH": 100, KARNATAKA: 0, MAHARASHTRA: 83.22 });
  });
});
