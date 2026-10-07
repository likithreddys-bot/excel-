/** The TypeScript parser + engine must agree with the Python reference (tools/gen_golden.py). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { Sheets, makeTable } from "../src/engine/table";

interface Golden {
  data: Record<string, (string | number | null)[]>;
  cases: {
    command: string; question: string | null; plan: unknown[]; summary: string; runnable: boolean;
    result?: Record<string, { rows: number; ids: number[] | null; columns: string[]; order?: unknown[][] }>;
  }[];
}

const golden: Golden = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8"));
const names = Object.keys(golden.data);
const n = golden.data[names[0]].length;
const rows = Array.from({ length: n }, (_, i) => names.map((c) => golden.data[c][i]));
const sheets: Sheets = new Map([["Sheet1", makeTable(names, rows)]]);

/** Drop null/undefined keys so {value: null} and a missing value compare equal. */
const clean = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(clean)
    : o && typeof o === "object"
      ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v)]))
      : o;

const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

describe("matches the Python reference parser", () => {
  for (const c of golden.cases) {
    it(JSON.stringify(c.command), () => {
      const plan = makePlan(sheets, c.command);
      if (c.question !== null) {
        expect(plan.clarification_question, "should ask a question").not.toBeNull();
        expect(plan.steps).toEqual([]);
        // The wording of a question may differ in small ways, but its opening must match.
        expect(plan.clarification_question!.split("\n")[0].slice(0, 40)).toBe(c.question.split("\n")[0].slice(0, 40));
        return;
      }
      if (!c.runnable) {
        // Valid in Python but not built yet: must say so, never guess.
        expect(plan.steps).toEqual([]);
        expect(plan.clarification_question).toMatch(/coming to the add-in/);
        return;
      }
      expect(plan.clarification_question).toBeNull();
      expect(clean(plan.steps)).toEqual(c.plan);
      expect(plan.summary).toBe(c.summary);

      const out = applyPlan(sheets, plan);
      expect(sameSet([...out.keys()], Object.keys(c.result!))).toBe(true);
      for (const [name, expected] of Object.entries(c.result!)) {
        const t = out.get(name)!;
        expect(t.nrows, `rows in ${name}`).toBe(expected.rows);
        expect(t.columns.map((x) => x.name)).toEqual(expected.columns);
        if (expected.ids) {
          const ids = t.columns.find((x) => x.name === "txn_id")!.values as number[];
          expect([...ids].sort((a, b) => a - b)).toEqual(expected.ids);
        }
        if (expected.order) {
          const sortStep = plan.steps.filter((s) => s.op === "sort").pop() as { columns: string[] };
          const cols = sortStep.columns.map((cn) => t.columns.find((x) => x.name === cn)!);
          const got = Array.from({ length: t.nrows }, (_, i) => cols.map((x) => x.values[i]));
          expect(got).toEqual(expected.order);
        }
      }
    });
  }
});
