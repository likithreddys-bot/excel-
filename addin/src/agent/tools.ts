/**
 * The agent's tools. The model calls these; they run here, in the browser. Everything a tool sends back to the model
 * goes through the same privacy rules as the profile: column facts, never source rows, and summary results only when
 * they are small and hold no personal or id columns.
 */
import { describe as describeStep } from "../engine/describe";
import { PlanError, applyPlan } from "../engine/engine";
import { isFormatStep } from "../engine/format";
import type { Plan, Step } from "../engine/plan";
import { Cell, Sheets, Table } from "../engine/table";
import { validatePlan } from "../planner";
import type { AiSettings, FunctionDeclaration } from "../ai/gemini";
import { ColumnProfile, describeColumn, profileColumn } from "../ai/profile";
import { normalisePlan } from "../ai/schema";
import { Workspace } from "./workspace";

export const PREVIEW_ROWS = 60;

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "describe_table",
    description: "Look at a table: its size, and for each column its type, role (amount, date, flag, category, id...), range, share of empty cells and, for category columns, the common values. For tables with many columns, name the columns you care about.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, exactly as listed." },
        columns: { type: "array", items: { type: "string" }, description: "Optional: only these columns (use for wide tables)." },
      },
      required: ["table"],
    },
  },
  {
    name: "value_counts",
    description: "The most common values of one column with their counts, e.g. to see which states, statuses or policy names exist. Withheld for personal or id columns.",
    parameters: {
      type: "object",
      properties: { table: { type: "string" }, column: { type: "string" }, top: { type: "integer", description: "How many values (default 20, at most 50)." } },
      required: ["table", "column"],
    },
  },
  {
    name: "run_plan",
    description: "Run a plan of steps on one table with the exact engine (all rows) and save the result as a new sheet. Returns the result's size, columns, checks and, when it is a small summary, its rows. Use the result's name as the table of a later run_plan to build on it.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "The table to start from (a source table or an earlier result)." },
        plan: { type: "string", description: "The plan as JSON text: {\"steps\":[...]} in the step language from the instructions." },
        result_name: { type: "string", description: "A short sheet name for the result, e.g. \"Repayment by state\" (max 31 characters)." },
        purpose: { type: "string", description: "One plain sentence: what this result shows." },
      },
      required: ["table", "plan", "result_name", "purpose"],
    },
  },
  {
    name: "ask_user",
    description: "Ask the person ONE short question when a definition or choice matters and the data cannot settle it (e.g. what counts as an old customer). Give 2-4 plain-words options. Their answer is remembered.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
      required: ["question", "options"],
    },
  },
  {
    name: "remember",
    description: "Save a definition or fact the person confirmed, so later requests use it (e.g. \"Old customer = cx_repeat_flag is 1\").",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  {
    name: "final_answer",
    description: "Finish: tell the person what you made and what it shows, quoting only numbers that came from tool results. List the result sheets that answer the request, in order.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" }, sheets: { type: "array", items: { type: "string" } } },
      required: ["message"],
    },
  },
];

/** What the chat shows for one tool call. */
export interface StepView {
  kind: "look" | "run" | "ask" | "note" | "error";
  title: string;
  detail: string[];
  sheet?: string;
}

export interface ToolContext {
  ws: Workspace;
  settings: AiSettings;
  notes: string[];
  saveNotes(): void;
  /** Put a question to the person and wait for the answer. */
  ask(question: string, options: string[]): Promise<string>;
}

export interface ToolResult {
  response: Record<string, unknown>;
  view: StepView;
  /** Set by final_answer. */
  final?: { message: string; sheets: string[] };
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const PERSONAL = /phone|mobile|msisdn|\bpan\b|(^|_)pan(_|$)|aadhaar|aadhar|e-?mail|address|account|acct|ifsc|card|passport|ssn|dob|birth|(^|_)name$|customer_name|full_?name/i;

/** Every column name a plan mentions (as a value or inside [brackets]) that is one of `headers`. */
export function columnsUsed(plan: unknown, headers: string[]): string[] {
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      const hit = lower.get(v.toLowerCase());
      if (hit) found.add(hit);
      for (const m of v.matchAll(/\[([^\]]+)\]/g)) { const h = lower.get(m[1].toLowerCase()); if (h) found.add(h); }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { visit(k); visit(x); } }
  };
  visit(plan);
  return [...found];
}

const cellOut = (v: Cell): Cell => (typeof v === "number" ? Math.round(v * 10000) / 10000 : v);

/** Simple checks on a result, in plain words (shown to the person and to the model). */
export function checksOf(t: Table): string[] {
  const out: string[] = [];
  if (t.nrows === 0) out.push("The result has no rows: the filters may be too strict, or values are spelled differently.");
  for (const c of t.columns) {
    if (c.kind !== "number") continue;
    const nums = c.values.filter((v): v is number => typeof v === "number");
    const blanks = t.nrows - nums.length;
    if (/%|percent|pct|rate|ratio/i.test(c.name) && nums.some((v) => v < 0 || v > 100)) out.push(`Some values of “${c.name}” are outside 0 to 100.`);
    if (blanks && blanks === t.nrows) out.push(`“${c.name}” is empty in every row.`);
    else if (blanks && t.nrows <= PREVIEW_ROWS) out.push(`“${c.name}” is blank in ${blanks} row(s) (often a division by zero or no matching rows).`);
  }
  return out;
}

/** Can this result's rows be shown to the model? Small, and no personal or id columns. */
function shareable(t: Table, settings: AiSettings): string | null {
  if (!settings.readResults) return "reading results is switched off in the AI settings";
  if (t.nrows > PREVIEW_ROWS) return `it has ${t.nrows} rows (only summaries of up to ${PREVIEW_ROWS} rows are shared)`;
  const bad = t.columns.find((c) => PERSONAL.test(c.name) || profileColumn(c, t.nrows, { values: true }).role === "id");
  if (bad) return `it has a personal or id column (${bad.name})`;
  return null;
}

function profileOf(t: Table, names: string[] | null, settings: AiSettings): ColumnProfile[] {
  const cols = names ? t.columns.filter((c) => names.includes(c.name)) : t.columns;
  return cols.map((c) => {
    const p = profileColumn(c, t.nrows, { values: settings.shareValues });
    if (p.values && PERSONAL.test(c.name)) { delete p.values; p.withheld = "looks like personal data"; }
    return p;
  });
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "describe_table": return await describeTable(args, ctx);
      case "value_counts": return await valueCounts(args, ctx);
      case "run_plan": return await runPlan(args, ctx);
      case "ask_user": {
        const question = str(args.question).trim() || "Could you tell me more?";
        const options = strList(args.options).slice(0, 5);
        const answer = await ctx.ask(question, options);
        const note = `${question} → ${answer}`;
        ctx.notes.push(note);
        ctx.saveNotes();
        return { response: { answer }, view: { kind: "ask", title: `You answered: ${answer}`, detail: [question] } };
      }
      case "remember": {
        const note = str(args.note).trim();
        if (note && !ctx.notes.includes(note)) { ctx.notes.push(note); ctx.saveNotes(); }
        return { response: { saved: true }, view: { kind: "note", title: `Remembered: ${note}`, detail: [] } };
      }
      case "final_answer": {
        const sheets = strList(args.sheets).map((s) => ctx.ws.get(s)?.name).filter((s): s is string => !!s);
        return { response: { done: true }, view: { kind: "note", title: "Done", detail: [] }, final: { message: str(args.message), sheets } };
      }
      default:
        return { response: { error: `There is no tool called ${name}.` }, view: { kind: "error", title: `Unknown tool ${name}`, detail: [] } };
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    return { response: { error: message }, view: { kind: "error", title: message, detail: [] } };
  }
}

async function describeTable(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const e = ctx.ws.get(str(args.table));
  if (!e) throw new Error(`There's no table called “${str(args.table)}”. Tables: ${[...ctx.ws.tables.keys()].join(", ")}`);
  const headers = ctx.ws.headersOf(e.name);
  const asked = strList(args.columns);
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const unknown = asked.filter((c) => !lower.has(c.toLowerCase()));
  const wanted = asked.length ? asked.map((c) => lower.get(c.toLowerCase())).filter((c): c is string => !!c).slice(0, 60) : headers.length <= 80 ? headers : null;
  const response: Record<string, unknown> = { table: e.name, kind: e.kind, role: e.kind === "source" ? e.role : "result" };
  if (wanted === null) {
    response.rows = ctx.ws.rowsOf(e);
    response.columns = headers;
    response.note = `This table has ${headers.length} columns: call describe_table again with "columns" (up to 60) to see details of the ones you need.`;
  } else {
    const t = await ctx.ws.ensure(e.name, wanted);
    response.rows = t.nrows;
    if (headers.length > wanted.length) response.other_columns = headers.filter((h) => !wanted.includes(h));
    response.profile = profileOf(t, wanted, ctx.settings).map(describeColumn);
  }
  if (unknown.length) response.not_found = unknown;
  return { response, view: { kind: "look", title: `Looked at ${e.name}${wanted && asked.length ? ` (${wanted.length} columns)` : ""}`, detail: [] } };
}

async function valueCounts(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const table = str(args.table);
  const e = ctx.ws.get(table);
  if (!e) throw new Error(`There's no table called “${table}”.`);
  const column = ctx.ws.headersOf(e.name).find((h) => h.toLowerCase() === str(args.column).toLowerCase());
  if (!column) throw new Error(`“${e.name}” has no column called “${str(args.column)}”.`);
  const t = await ctx.ws.ensure(e.name, [column]);
  const c = t.columns.find((x) => x.name === column)!;
  const p = profileColumn(c, t.nrows, { values: true });
  const top = Math.min(50, Math.max(1, Math.floor(Number(args.top) || 20)));
  const view: StepView = { kind: "look", title: `Counted the values of ${column} in ${e.name}`, detail: [] };
  if (!ctx.settings.shareValues) return { response: { column, distinct: p.distinct, withheld: "values are not shared (AI settings)" }, view };
  if (PERSONAL.test(column) || p.role === "id") return { response: { column, distinct: p.distinct, withheld: "personal or id column" }, view };
  if (p.capped || p.distinct > 200) return { response: { column, distinct: p.distinct, capped: p.capped, withheld: "too many different values; use describe_table for its range" }, view };
  const counts = new Map<string, number>();
  for (const v of c.values) { const k = v === null || v === "" ? "(blank)" : String(v).trim(); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const values = [...counts].sort((a, b) => b[1] - a[1]).slice(0, top).map(([value, count]) => ({ value, count }));
  return { response: { column, rows: t.nrows, distinct: p.distinct, values }, view };
}

async function runPlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tableName = str(args.table);
  const e = ctx.ws.get(tableName);
  if (!e) throw new Error(`There's no table called “${tableName}”. Tables: ${[...ctx.ws.tables.keys()].join(", ")}`);
  let raw: unknown = args.plan;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new Error("The plan is not valid JSON. Send {\"steps\":[...]} as JSON text."); }
  }
  const { plan, problems } = normalisePlan(raw);
  if (!plan) return { response: { error: "The plan was rejected.", problems }, view: { kind: "error", title: "A plan was rejected (the agent will fix it)", detail: problems } };

  // Read just the columns the plan uses, here and in any table it brings in.
  const t = await ctx.ws.ensure(e.name, columnsUsed(plan, ctx.ws.headersOf(e.name)));
  const files: Record<string, Table> = {};
  for (const step of plan.steps) {
    if (step.op !== "lookup" && step.op !== "append" && step.op !== "compare") continue;
    const other = ctx.ws.get(step.file);
    if (!other) throw new Error(`Step “${step.op}” names the table “${step.file}”, which does not exist. Tables: ${[...ctx.ws.tables.keys()].join(", ")}`);
    step.file = other.name;
    files[other.name] = await ctx.ws.ensure(other.name, step.op === "append" ? "all" : columnsUsed(step, ctx.ws.headersOf(other.name)));
  }
  const issues = validatePlan(plan, t, (n) => ctx.ws.headersOf(n));
  if (issues.length) return { response: { error: "The plan uses columns that do not exist.", problems: issues }, view: { kind: "error", title: "A plan was rejected (the agent will fix it)", detail: issues } };

  const notes: string[] = [];
  let out: Sheets;
  try {
    out = applyPlan(new Map([[e.name, t]]), plan, files, notes);
  } catch (err) {
    if (err instanceof PlanError) return { response: { error: err.message }, view: { kind: "error", title: `Could not run: ${err.message}`, detail: [] } };
    throw err;
  }
  const wanted = str(args.result_name) || "Result";
  const purpose = str(args.purpose);
  const formats = plan.steps.filter(isFormatStep);
  const saved: string[] = [];
  for (const [key, table] of out) {
    const name = out.size === 1 ? wanted : `${wanted} ${key}`.slice(0, 31);
    saved.push(ctx.ws.addResult(name, table, { formats, from: e.name, plan, purpose, notes: [...new Set(notes)] }));
  }
  const first = ctx.ws.get(saved[0]);
  const result = first && first.kind === "result" ? first.table : out.values().next().value as Table;
  const checks = checksOf(result);
  const response: Record<string, unknown> = {
    saved_as: saved,
    rows: result.nrows,
    columns: result.columns.map((c) => c.name),
    engine_notes: [...new Set(notes)].slice(0, 8),
    checks,
  };
  const why = shareable(result, ctx.settings);
  if (why) response.rows_withheld = why;
  else response.data = result.columns.length ? Array.from({ length: result.nrows }, (_, i) => result.columns.map((c) => cellOut(c.values[i]))) : [];
  const detail = plan.steps.map((s: Step) => { try { return describeStep(s); } catch { return s.op; } });
  return { response, view: { kind: "run", title: `Made “${saved.join("”, “")}” from ${e.name} (${result.nrows.toLocaleString("en-IN")} rows)`, detail: [...detail, ...checks.map((c) => `Check: ${c}`)], sheet: saved[0] } };
}

/** The plan behind a result, as plain lines (for the "How calculated" sheet). */
export function planLines(plan: Plan): string[] {
  return plan.steps.map((s) => { try { return describeStep(s); } catch { return s.op; } });
}
