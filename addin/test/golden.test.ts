/** The TypeScript parser + engine must agree with the Python reference (tools/gen_golden.py). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { chartTable } from "../src/engine/format";
import type { ChartStep } from "../src/engine/plan";
import { makePlan } from "../src/engine/parser";
import { Sheets, combine, makeTable } from "../src/engine/table";
import { isoDay } from "../src/engine/util";

type Data = Record<string, (string | number | null)[]>;
interface Suite {
  data: Data;
  files?: Record<string, Data>;
  cases: {
    command: string; question: string | null; plan: unknown[]; summary: string; runnable: boolean; run_error?: string; notes?: string[]; charts?: { columns: string[]; cells: unknown[][] }[];
    result?: Record<string, { rows: number; ids: number[] | null; columns: string[]; order?: unknown[][]; cells?: unknown[][] | null }>;
  }[];
}

const golden: { suites: Record<string, Suite> } = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8"));

function tableOf(data: Data) {
  const names = Object.keys(data);
  const n = data[names[0]].length;
  return makeTable(names, Array.from({ length: n }, (_, i) => names.map((c) => data[c][i])));
}
const sheetsOf = (suite: Suite): Sheets => new Map([["Sheet1", tableOf(suite.data)]]);
const filesOf = (suite: Suite) => Object.fromEntries(Object.entries(suite.files ?? {}).map(([k, d]) => [k, tableOf(d)]));

/** Drop null/undefined keys so {value: null} and a missing value compare equal. */
const clean = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(clean)
    : o && typeof o === "object"
      ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v)]))
      : o;

const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

for (const [suiteName, suite] of Object.entries(golden.suites)) describe(`matches the Python reference: ${suiteName}`, () => {
  const sheets = sheetsOf(suite);
  const files = filesOf(suite);
  for (const c of suite.cases) {
    it(JSON.stringify(c.command), () => {
      const plan = makePlan(sheets, c.command, [], {}, files);
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
      expect(plan.summary).toBe(c.summary.replace(/ \(Excel download\)/g, "")); // the add-in writes to the sheet, not a download

      if (c.run_error) {
        expect(() => applyPlan(sheets, plan, files)).toThrow(c.run_error.slice(0, 50));
        return;
      }
      const notes: string[] = [];
      const out = applyPlan(sheets, plan, files, notes);
      const wording = (list: string[]) => list.filter((x) => !x.startsWith("Formatting and charts"));
      if (c.notes) expect(wording(notes)).toEqual(wording(c.notes));
      const chartSteps = plan.steps.filter((x) => x.op === "chart") as ChartStep[];
      (c.charts ?? []).forEach((expectedChart, i) => {
        const data = chartTable(combine(out), chartSteps[i]);
        expect(data.columns.map((x) => x.name)).toEqual(expectedChart.columns);
        const got = Array.from({ length: data.nrows }, (_, r) => data.columns.map((x) => (typeof x.values[r] === "number" ? Math.round((x.values[r] as number) * 1e6) / 1e6 : x.values[r] ?? null)));
        expect(got).toEqual(expectedChart.cells.map((row) => row.map((v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v ?? null))));
      });
      expect(sameSet([...out.keys()], Object.keys(c.result!))).toBe(true);
      for (const [name, expected] of Object.entries(c.result!)) {
        const t = out.get(name)!;
        expect(t.nrows, `rows in ${name}`).toBe(expected.rows);
        expect(t.columns.map((x) => x.name)).toEqual(expected.columns);
        if (expected.ids) {
          const ids = t.columns.find((x) => x.name === "txn_id")!.values as number[];
          expect([...ids].sort((a, b) => a - b)).toEqual(expected.ids);
        }
        if (expected.cells) {
          // Summaries are compared cell by cell (numbers to 6 decimals; Python NaN is a blank here).
          const norm = (v: unknown) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v === "" ? null : v ?? null);
          // Real Excel dates (serial numbers) compare as ISO days; text dates stay as written.
          const shown = (x: (typeof t.columns)[number], i: number) =>
            x.kind === "date" && typeof x.values[i] === "number" && x.time?.[i] != null ? isoDay(x.time[i]!) : x.values[i];
          const got = Array.from({ length: t.nrows }, (_, i) => t.columns.map((x) => norm(shown(x, i))));
          expect(got).toEqual(expected.cells.map((r) => r.map(norm)));
        }
        if (expected.order) {
          const tops = plan.steps.filter((s) => s.op === "top_n" && s.column) as { per: string[] | null; column: string }[];
          const names = tops.length
            ? [...(tops[tops.length - 1].per ?? []), tops[tops.length - 1].column]
            : (plan.steps.filter((s) => s.op === "sort").pop() as { columns: string[] }).columns;
          const cols = names.map((cn) => t.columns.find((x) => x.name === cn)!);
          const got = Array.from({ length: t.nrows }, (_, i) => cols.map((x) => x.values[i]));
          // Within one value, tied rows of different groups may swap places (pandas' sort isn't stable).
          const byKey = (rows: unknown[][]) => (tops.some((x) => x.per) ? [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) : rows);
          expect(byKey(got)).toEqual(byKey(expected.order));
        }
      }
    });
  }
});
