/**
 * Planners turn a question into a Plan. The rule parser is one; a language model can be another (see
 * docs/EXCEL_GPT_PLAN.md, sections 5 and 11). Whatever makes a plan, it goes through `validatePlan` before anything runs,
 * and a model only ever sees the schema, never a data row.
 */
import { Dictionary } from "./engine/dictionary";
import type { Plan, Step } from "./engine/plan";
import { Table } from "./engine/table";

export interface SchemaColumn { name: string; kind: "number" | "date" | "text"; distinct?: number; min?: number; max?: number }
export interface Schema { rows: number; columns: SchemaColumn[] }

/** Names, types and safe statistics only: no cell values. */
export function schemaOf(t: Table): Schema {
  return {
    rows: t.nrows,
    columns: t.columns.map((c) => {
      const col: SchemaColumn = { name: c.name, kind: c.kind };
      if (c.kind === "number") {
        let min = Infinity, max = -Infinity;
        for (const v of c.values) if (typeof v === "number") { if (v < min) min = v; if (v > max) max = v; }
        if (min <= max) { col.min = min; col.max = max; }
      }
      return col;
    }),
  };
}

export interface PlannerContext { schema: Schema; dictionary: Dictionary }
export type PlannerResult =
  | { kind: "plan"; plan: Plan; /** the assumptions behind it, in plain words */ reading?: string[] }
  | { kind: "question"; question: string; options?: string[] };

export interface Planner {
  readonly name: string;
  plan(question: string, ctx: PlannerContext): Promise<PlannerResult>;
}

/** What each step reads, and the columns it adds. Steps this does not know are not judged. */
function reads(step: Step): string[] {
  switch (step.op) {
    case "filter": return step.conditions.map((c) => c.column);
    case "select_columns": case "drop_columns": case "split_by": return "columns" in step ? step.columns : [step.column];
    case "sort": return step.columns;
    case "dedupe": return step.columns ?? [];
    case "group_by": return [...step.columns, ...step.aggregations.map((a) => a.column), ...Object.values(step.calculated).flatMap(refs)];
    case "pivot": return [...step.rows, ...step.columns, ...(step.values ? [step.values] : []), ...Object.values(step.calculated).flatMap(refs)];
    case "rate": return [...step.columns, ...(step.when ? step.when.conditions.map((c) => c.column) : [])];
    case "top_n": return [...(step.column ? [step.column] : []), ...(step.per ?? [])];
    case "date_part": return [step.column];
    case "label": return step.cases.flatMap((c) => c.when.conditions.map((x) => x.column));
    case "compute": case "formula": return refs("expr" in step ? step.expr : step.formula);
    case "filter_formula": return refs(step.formula);
    case "lookup": return [step.left_on];
    case "compare": return step.left_on ? [step.left_on] : [];
    default: return [];
  }
}
const refs = (expr: string): string[] => [...expr.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);

function adds(step: Step, available: Set<string>, others: (name: string) => string[]): Set<string> {
  const next = new Set(available);
  switch (step.op) {
    case "lookup": for (const c of step.columns) next.add(available.has(c) ? `${c} (${step.file})` : c); break;
    case "append": for (const c of others(step.file)) next.add(c); break;
    case "label": case "compute": case "formula": case "date_part": next.add(step.name); break;
    case "group_by": return new Set([...step.columns, ...step.aggregations.map((a) => `${a.func}_${a.column}`), ...Object.keys(step.calculated)]);
    case "pivot": return new Set([...step.rows, ...Object.keys(step.calculated), ...(step.values ? [step.values] : [])]);
    case "rate": return new Set([...step.columns, "rows", "matching rows", "% matching"]);
    case "select_columns": return new Set(step.columns);
    default: break;
  }
  return next;
}

/** Problems with a plan, in plain words. Empty means it is safe to run. */
export function validatePlan(plan: Plan, t: Table, others: (name: string) => string[] = () => []): string[] {
  const problems: string[] = [];
  if (!plan.steps.length) problems.push("The plan has no steps.");
  let available = new Set(t.columns.map((c) => c.name));
  plan.steps.forEach((step, i) => {
    for (const c of reads(step)) {
      if (!available.has(c)) problems.push(`Step ${i + 1} (${step.op}) uses the column “${c}”, which does not exist here.`);
    }
    available = adds(step, available, others);
  });
  return problems;
}

/** The prompt a model planner would receive. It contains the question, the schema and the dictionary: no rows. */
export function buildPrompt(question: string, ctx: PlannerContext): { system: string; user: string } {
  const system = [
    "You turn a spreadsheet question into a JSON plan of steps. You never compute numbers and you never see the data.",
    "Use only the columns listed. If the question has more than one sensible meaning, or uses a word that is not in the dictionary (for example “old user”), ask ONE short question with options instead of guessing.",
    "Reply with JSON: {\"plan\": {\"steps\": [...]}} or {\"question\": \"...\", \"options\": [\"...\"]}.",
    "Step kinds: filter, sort, group_by, pivot, rate, top_n, label, compute, formula, date_part, lookup, select_columns, dedupe, chart.",
  ].join("\n");
  const columns = ctx.schema.columns.map((c) => `- ${c.name} (${c.kind}${c.min !== undefined ? `, ${c.min} to ${c.max}` : ""})`).join("\n");
  const dict = Object.entries(ctx.dictionary.segments).map(([k, v]) => `- ${k}: ${v.oldLabel} = ${v.column} ${v.operator} ${v.value}; ${v.newLabel} = otherwise`).join("\n") || "(none yet)";
  const user = `Rows: ${ctx.schema.rows}\nColumns:\n${columns}\n\nDictionary:\n${dict}\n\nQuestion: ${question}`;
  return { system, user };
}

/** A planner for tests: returns what it was told to. */
export class MockPlanner implements Planner {
  readonly name = "mock";
  constructor(private readonly answer: PlannerResult | ((q: string) => PlannerResult)) {}
  async plan(question: string): Promise<PlannerResult> {
    return typeof this.answer === "function" ? this.answer(question) : this.answer;
  }
}

/**
 * Ask a planner, check the result, and let it repair a bad plan (at most twice) before giving the person a question.
 * `repair` receives the problems so a real model can be re-prompted with them.
 */
export async function planWithRepair(planner: Planner, question: string, ctx: PlannerContext, t: Table, repair?: (problems: string[]) => Promise<PlannerResult>): Promise<PlannerResult> {
  let result = await planner.plan(question, ctx);
  for (let attempt = 0; attempt < 2 && result.kind === "plan"; attempt++) {
    const problems = validatePlan(result.plan, t);
    if (!problems.length) return result;
    if (!repair) break;
    result = await repair(problems);
  }
  if (result.kind === "plan" && validatePlan(result.plan, t).length) {
    return { kind: "question", question: `I couldn't build a safe plan for that: ${validatePlan(result.plan, t)[0]} Could you say which column you mean?` };
  }
  return result;
}
