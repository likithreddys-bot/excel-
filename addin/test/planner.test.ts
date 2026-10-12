/** Planner groundwork: plans are validated before they run, and a model prompt never contains data. */
import { describe, expect, it } from "vitest";
import { emptyDictionary } from "../src/engine/dictionary";
import { makePlan } from "../src/engine/parser";
import type { Plan } from "../src/engine/plan";
import { Sheets, makeTable } from "../src/engine/table";
import { MockPlanner, buildPrompt, planWithRepair, schemaOf, validatePlan } from "../src/planner";

const SECRET = "ABCDE1234F-SECRET-PAN";
const table = makeTable(["name", "pan", "statename", "amount"], [["Asha", SECRET, "MH", 1200], ["Ravi", "ZZZZZ9999Z", "KA", 800]]);
const sheets: Sheets = new Map([["Result", table]]);
const plan = (steps: Plan["steps"]): Plan => ({ clarification_question: null, summary: "", steps, awaits_columns: false });

describe("validatePlan", () => {
  it("accepts what the rule parser makes", () => {
    for (const q of ["total amount by statename", "only rows where amount > 1000", "add column gst = amount * 0.18", "top 5 by amount"]) {
      const p = makePlan(sheets, q);
      expect(p.clarification_question, q).toBeNull();
      expect(validatePlan(p, table), q).toEqual([]);
    }
  });
  it("knows about columns that earlier steps create", () => {
    const p = plan([
      { op: "label", name: "size", replace: false, default: "small", cases: [{ value: "big", when: { op: "filter", match: "all", conditions: [{ column: "amount", operator: "gt", value: "1000" }] } }] },
      { op: "group_by", columns: ["size"], aggregations: [{ column: "amount", func: "sum" }], calculated: {} },
      { op: "sort", columns: ["sum_amount"], ascending: false },
    ]);
    expect(validatePlan(p, table)).toEqual([]);
  });
  it("rejects a column that does not exist, and says which step", () => {
    const p = plan([{ op: "filter", match: "all", conditions: [{ column: "salary", operator: "gt", value: "5" }] }]);
    expect(validatePlan(p, table)).toEqual(["Step 1 (filter) uses the column “salary”, which does not exist here."]);
  });
  it("rejects a step that uses a column an earlier step dropped", () => {
    const p = plan([
      { op: "select_columns", columns: ["name"] },
      { op: "sort", columns: ["amount"], ascending: true },
    ]);
    expect(validatePlan(p, table)[0]).toMatch(/Step 2 \(sort\).*“amount”/);
  });
  it("an empty plan is not a plan", () => expect(validatePlan(plan([]), table)).toHaveLength(1));
});

describe("the prompt a model would get", () => {
  it("has the question, the column names and the dictionary, and no data values", () => {
    const { system, user } = buildPrompt("repayment by state", { schema: schemaOf(table), dictionary: emptyDictionary() });
    const all = `${system}\n${user}`;
    expect(user).toContain("statename (text)");
    expect(user).toContain("amount (number, 800 to 1200)");
    expect(user).toContain("Question: repayment by state");
    for (const value of [SECRET, "Asha", "Ravi", "ZZZZZ9999Z"]) expect(all).not.toContain(value);
  });
});

describe("planWithRepair", () => {
  const ctx = { schema: schemaOf(table), dictionary: emptyDictionary() };
  const bad = plan([{ op: "sort", columns: ["nope"], ascending: true }]);
  const good = plan([{ op: "sort", columns: ["amount"], ascending: true }]);

  it("a good plan passes straight through", async () => {
    expect(await planWithRepair(new MockPlanner({ kind: "plan", plan: good }), "q", ctx, table)).toEqual({ kind: "plan", plan: good });
  });
  it("a bad plan is sent back with the problems, then accepted", async () => {
    let seen: string[] = [];
    const out = await planWithRepair(new MockPlanner({ kind: "plan", plan: bad }), "q", ctx, table, async (p) => { seen = p; return { kind: "plan", plan: good }; });
    expect(out).toEqual({ kind: "plan", plan: good });
    expect(seen[0]).toMatch(/“nope”/);
  });
  it("a plan that stays bad becomes a question for the person, not an action", async () => {
    const out = await planWithRepair(new MockPlanner({ kind: "plan", plan: bad }), "q", ctx, table);
    expect(out.kind).toBe("question");
  });
  it("a question from the planner passes through", async () => {
    const q = { kind: "question" as const, question: "Which amount?", options: ["amount"] };
    expect(await planWithRepair(new MockPlanner(q), "q", ctx, table)).toEqual(q);
  });
});
