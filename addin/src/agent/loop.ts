/**
 * The agent loop: the model looks at the tables, runs plans, checks the results, asks when it must, and finishes
 * with a short answer. It works through tools (tools.ts); the engine does every calculation.
 */
import { AiError, Content, GeminiClient } from "../ai/gemini";
import { STEP_REFERENCE } from "../ai/schema";
import { ROLES } from "./workspace";
import { StepView, TOOLS, ToolContext, runTool } from "./tools";

export const MAX_ROUNDS = 16;
/** Earlier requests kept as context for follow-ups ("now by state"). */
const KEEP_REQUESTS = 4;

const RULES = `
You are an expert Excel analyst working for a fintech lending company. People give you their files (new customers, old customers, loans, repayments, policy data and others) and ask for analysis and reports. You do the work with tools; a separate engine runs every calculation on all rows and writes the results as sheets of an Excel workbook.

How you work:
1. Understand the request and look at the tables you need (describe_table, value_counts). Do not guess column meanings when you can look.
2. Build the answer with run_plan. Prefer one clear summary sheet per question (a pivot or grouped table), named so a manager understands it. For a "report", make several sheets: an overview first, then the breakdowns asked for, then any charts.
3. To combine tables, use lookup (bring columns by a key such as customer_id or loan_id) or append (stack similar tables, e.g. old + new customers, after adding a label column to each saying which one it is). Check the engine notes: they say how many rows matched.
4. Read the checks and the result. If something looks wrong (no rows, blanks, impossible percentages, few matches on a join), fix the plan and run it again.
5. Finish with final_answer: 2-6 short lines with the key findings, quoting only numbers that appear in tool results, and the sheets in order.

Rules:
- Never invent numbers. Every figure you mention must come from a tool result. If a result's rows were withheld, describe what the sheet contains instead of quoting numbers.
- Percentages across groups (repayment %, collection %, approval %) are a ratio of totals: "calculated": {"Repayment %": "[paid]*100/[due]"} in a group_by or pivot. Never average row percentages.
- If a business word needs a definition that is not in the notes (old vs new customer, on time, NPA, DPD bucket, active, policy cohort) and the data allows more than one sensible meaning, ask_user once with 2-4 options that name the columns and values. If the data makes it clear, state your assumption in the final answer instead of asking.
- Use the notes: they are definitions the team already confirmed. When the person confirms a new definition, it is saved automatically; use remember for other lasting facts.
- Use exact table and column names. Result sheet names: short, readable, at most 31 characters.
- Keep tool calls purposeful: at most ${MAX_ROUNDS} rounds per request.
`.trim();

export interface AgentEvents {
  step(view: StepView): void;
  status(text: string): void;
}

export interface AgentAnswer { message: string; sheets: string[] }

function overview(ctx: ToolContext): string {
  const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r;
  const lines: string[] = ["Tables in the workspace:"];
  for (const s of ctx.ws.sources()) {
    const cols = s.headers.length > 300 ? `${s.headers.slice(0, 300).join(", ")}, ... (${s.headers.length} in all)` : s.headers.join(", ");
    lines.push(`- "${s.name}" (source; role: ${roleLabel(s.role)}; file ${s.file}; ${s.approx ? "about " : ""}${s.rows.toLocaleString("en-IN")} rows; ${s.headers.length} columns): ${cols}`);
  }
  for (const r of ctx.ws.results()) {
    lines.push(`- "${r.name}" (result made from "${r.from}": ${r.purpose || "no description"}; ${r.table.nrows} rows): ${r.table.columns.map((c) => c.name).join(", ")}`);
  }
  if (!ctx.ws.tables.size) lines.push("(none: ask the person to add files)");
  lines.push("", "Notes (definitions the team confirmed):", ...(ctx.notes.length ? ctx.notes.map((n) => `- ${n}`) : ["(none yet)"]));
  return lines.join("\n");
}

export class Agent {
  /** Each finished request's turns, for follow-up questions. */
  private past: Content[][] = [];

  constructor(private readonly client: GeminiClient, private readonly ctx: ToolContext, private readonly events: AgentEvents) {}

  reset(): void {
    this.past = [];
  }

  async run(request: string, signal?: AbortSignal): Promise<AgentAnswer> {
    const turns: Content[] = [{ role: "user", parts: [{ text: request }] }];
    const made: string[] = [];
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
        this.events.status(round === 0 ? "Reading your request…" : "Working…");
        const system = `${RULES}\n\n${STEP_REFERENCE}\n\n${overview(this.ctx)}`;
        const reply = await this.client.chat(system, [...this.past.flat(), ...turns], TOOLS, signal);
        turns.push(reply);
        const calls = reply.parts.filter((p) => p.functionCall);
        if (!calls.length) {
          const text = reply.parts.map((p) => p.text ?? "").join("").trim();
          return this.done(turns, { message: text || "Done.", sheets: made });
        }
        const responses: Content = { role: "user", parts: [] };
        let final: AgentAnswer | undefined;
        for (const p of calls) {
          const { name, args } = p.functionCall!;
          this.events.status(name === "run_plan" ? "Calculating…" : name === "ask_user" ? "Waiting for your answer…" : "Looking at your data…");
          const result = await runTool(name, args ?? {}, this.ctx);
          if (result.view.sheet) made.push(result.view.sheet);
          if (name !== "final_answer") this.events.step(result.view);
          if (result.final) final = { message: result.final.message, sheets: result.final.sheets.length ? result.final.sheets : made };
          responses.parts.push({ functionResponse: { name, response: result.response } });
        }
        turns.push(responses);
        if (final) return this.done(turns, final);
      }
      return this.done(turns, { message: `I stopped after ${MAX_ROUNDS} rounds without finishing. The sheets made so far are kept; try a narrower request.`, sheets: made });
    } finally {
      this.events.status("");
    }
  }

  private done(turns: Content[], answer: AgentAnswer): AgentAnswer {
    // A request that ended on the model's own turn is complete; one that ended on our tool responses gets a closing turn.
    if (turns[turns.length - 1].role === "user") turns.push({ role: "model", parts: [{ text: answer.message }] });
    this.past.push(turns);
    if (this.past.length > KEEP_REQUESTS) this.past.shift();
    return { message: answer.message, sheets: [...new Set(answer.sheets)] };
  }
}

export { AiError };
