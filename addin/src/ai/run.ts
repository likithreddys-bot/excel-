/**
 * Ask the model for a plan and make sure it is good before the person sees it: the reply must be a known kind of
 * plan, must use columns that exist, and must actually run on the data. Problems go back to the model (twice at most).
 */
import type { Plan } from "../engine/plan";
import { Table } from "../engine/table";
import { validatePlan } from "../planner";
import { GeminiClient } from "./gemini";
import { PlanPromptInput, columnsPrompt, planPrompt } from "./prompt";
import { normalisePlan } from "./schema";

export type AiOutcome<R> =
  | { kind: "plan"; plan: Plan; reading: string[]; ran: R }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "failed"; reason: string };

export type TryRun<R> = (plan: Plan) => { ok: R } | { error: string };

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

export async function aiPlan<R>(client: GeminiClient, input: PlanPromptInput, table: Table, tryRun: TryRun<R>, signal?: AbortSignal): Promise<AiOutcome<R>> {
  let feedback = input.feedback;
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { system, user } = planPrompt({ ...input, feedback });
    const reply = await client.ask(system, user, signal);
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) { last = "The reply was not a JSON object."; feedback = `Your last reply was rejected: ${last} Reply with one JSON object.`; continue; }
    const r = reply as Record<string, unknown>;
    if (typeof r.question === "string" && r.question.trim()) {
      const options = lines(r.options).slice(0, 5);
      return { kind: "question", question: r.question.trim(), options };
    }
    const { plan, problems } = normalisePlan(r.plan, lines(r.reading));
    const issues = plan ? validatePlan(plan, table) : problems;
    if (plan && !issues.length) {
      const run = tryRun(plan);
      if ("ok" in run) return { kind: "plan", plan, reading: lines(r.reading), ran: run.ok };
      issues.push(`When run on the data: ${run.error}`);
    }
    last = issues.slice(0, 3).join(" ");
    feedback = `Your last plan was rejected. ${last}\nYour last plan was: ${JSON.stringify(r.plan)}\nFix these problems and reply with one JSON object again. If a needed column is not in the list, ask a question instead.`;
  }
  return { kind: "failed", reason: last || "The model did not give a usable plan." };
}

/** For a very wide file: which of its columns does this request need? Names that don't exist are dropped. */
export async function aiColumns(client: GeminiClient, question: string, headers: string[], notes: string[], signal?: AbortSignal): Promise<string[]> {
  const { system, user } = columnsPrompt(question, headers, notes);
  const reply = (await client.ask(system, user, signal)) as { columns?: unknown };
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const chosen = lines(reply?.columns).map((c) => lower.get(c.toLowerCase())).filter((c): c is string => !!c);
  return [...new Set(chosen)].slice(0, 30);
}
