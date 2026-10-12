/** The Excel Agent: workspace, tools (with privacy), the agent loop with a scripted Gemini, and the report. */
import { describe, expect, it } from "vitest";
import { Content, Fetch, GeminiClient, defaultSettings } from "../src/ai/gemini";
import { normalisePlan } from "../src/ai/schema";
import { Agent } from "../src/agent/loop";
import { reportSheets } from "../src/agent/report";
import { sampleFiles } from "../src/agent/sample";
import { ToolContext, columnsUsed, runTool } from "../src/agent/tools";
import { Workspace, guessRole } from "../src/agent/workspace";
import { buildXlsx } from "../src/web/xlsx-write";
import { openXlsx, readSheet } from "../src/web/xlsx-read";

const settings = { ...defaultSettings(), enabled: true, apiKey: "test-key" };

async function sampleWorkspace(): Promise<Workspace> {
  const ws = new Workspace();
  const { added, problems } = await ws.addFiles(sampleFiles());
  expect(problems).toEqual([]);
  expect(added).toEqual(["new_customers", "old_customers", "repayments", "loan_policy"]);
  return ws;
}

function context(ws: Workspace, answers: string[] = []): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return { ws, settings, notes: [], saveNotes: () => {}, asked, ask: async (q) => { asked.push(q); return answers.shift() ?? "no answer"; } };
}

/** Independent numbers for the sample: repayment % of old vs new customers, straight from the CSV text. */
function expectedOldNew(files: File[]): Promise<Record<string, number>> {
  const text = (name: string) => files.find((f) => f.name === name)!.text();
  return (async () => {
    const rows = (s: string) => s.trim().split("\n").slice(1).map((l) => l.split(","));
    const old = new Set(rows(await text("old_customers.csv")).map((r) => r[0]));
    const sums: Record<string, [number, number]> = { Old: [0, 0], New: [0, 0] };
    for (const r of rows(await text("repayments.csv"))) {
      const k = old.has(r[1]) ? "Old" : "New";
      sums[k][0] += Number(r[3]);
      sums[k][1] += Number(r[4]);
    }
    const pct = (k: string) => (sums[k][1] * 100) / sums[k][0];
    return { Old: pct("Old"), New: pct("New"), Total: ((sums.Old[1] + sums.New[1]) * 100) / (sums.Old[0] + sums.New[0]) };
  })();
}

const ALL_CUSTOMERS = JSON.stringify({ steps: [
  { op: "formula", name: "customer_type", formula: "\"New\"" },
  { op: "append", file: "old_customers" },
  { op: "fill_blanks", columns: ["customer_type"], method: "value", value: "Old" },
] });
const OLD_NEW_PIVOT = JSON.stringify({ steps: [
  { op: "lookup", file: "All customers", left_on: "customer_id", right_on: "customer_id", columns: ["customer_type"] },
  { op: "pivot", rows: ["customer_type"], values: null, calculated: { Due: "[due_amt]", Repaid: "[paid_amt]", "Repayment %": "[paid_amt]*100/[due_amt]" } },
] });

describe("workspace", () => {
  it("opens several files, guesses what each one is, and reads columns only when needed", async () => {
    const ws = await sampleWorkspace();
    expect(ws.sources().map((s) => s.role)).toEqual(["new_customers", "old_customers", "repayments", "policy"]);
    const rep = ws.get("repayments")!;
    expect(rep.kind === "source" && rep.loaded).toBeNull();
    const t = await ws.ensure("Repayments", ["due_amt"]); // names are matched without case
    expect(t.columns.length).toBeGreaterThan(0);
    expect(ws.headersOf("repayments")).toContain("paid_date");
  });
  it("guesses roles from names", () => {
    expect(guessRole("New_Cxs_Repayment_Data.xlsx", [])).toBe("repayments");
    expect(guessRole("old customers.xlsx", [])).toBe("old_customers");
    expect(guessRole("data.csv", ["loan_id", "due_date", "dpd"])).toBe("repayments");
  });
  it("finds the columns a plan mentions", () => {
    expect(columnsUsed({ steps: [{ op: "compute", expr: "[Paid_Amt]*2" }, { op: "sort", columns: ["state"] }] }, ["paid_amt", "state", "other"]).sort()).toEqual(["paid_amt", "state"]);
  });
});

describe("tools", () => {
  it("builds an old vs new customers repayment pivot across files, with the right numbers", async () => {
    const files = sampleFiles();
    const ws = new Workspace();
    await ws.addFiles(files);
    const ctx = context(ws);
    const a = await runTool("run_plan", { table: "new_customers", plan: ALL_CUSTOMERS, result_name: "All customers", purpose: "Old and new customers together" }, ctx);
    expect(a.response.error).toBeUndefined();
    expect(a.response.rows_withheld).toMatch(/rows/); // 1,800 customer rows are never sent to the model
    expect(a.response.data).toBeUndefined();
    const b = await runTool("run_plan", { table: "repayments", plan: OLD_NEW_PIVOT, result_name: "Repayment old vs new", purpose: "Repayment % by customer type" }, ctx);
    expect(b.response.error, JSON.stringify(b.response)).toBeUndefined();
    const data = b.response.data as (string | number)[][];
    const got = Object.fromEntries(data.map((r) => [r[0], r[3] as number]));
    const want = await expectedOldNew(files);
    for (const k of ["Old", "New", "Total"]) expect(got[k]).toBeCloseTo(want[k], 3);
    expect(got.Old).toBeGreaterThan(got.New);
    expect((b.response.engine_notes as string[]).join(" ")).toMatch(/match/);
  });

  it("rejects a plan with a made-up column and says why, so the agent can fix it", async () => {
    const ws = await sampleWorkspace();
    const r = await runTool("run_plan", { table: "repayments", plan: JSON.stringify({ steps: [{ op: "group_by", columns: ["region"], aggregations: [{ column: "due_amt", func: "sum" }] }] }), result_name: "x", purpose: "" }, context(ws));
    expect(r.response.error).toBeTruthy();
    expect(JSON.stringify(r.response.problems)).toMatch(/region/);
    expect(ws.results()).toEqual([]);
  });

  it("never shares ids or personal columns", async () => {
    const ws = await sampleWorkspace();
    const ctx = context(ws);
    const ids = await runTool("value_counts", { table: "repayments", column: "loan_id" }, ctx);
    expect(ids.response.withheld).toBeTruthy();
    expect(JSON.stringify(ids.response)).not.toMatch(/L0000/);
    const states = await runTool("value_counts", { table: "new_customers", column: "state" }, ctx);
    expect(JSON.stringify(states.response)).toMatch(/Maharashtra/);
    const d = await runTool("describe_table", { table: "repayments" }, ctx);
    expect(JSON.stringify(d.response)).not.toMatch(/L0000|C0000/);
    expect(JSON.stringify(d.response.profile)).toMatch(/due_amt/);
  });

  it("asks the person and remembers the answer", async () => {
    const ws = await sampleWorkspace();
    const ctx = context(ws, ["Old = in the old customers file"]);
    const r = await runTool("ask_user", { question: "What is an old customer?", options: ["Old = in the old customers file", "Old = loans_taken > 1"] }, ctx);
    expect(r.response.answer).toBe("Old = in the old customers file");
    expect(ctx.notes).toEqual(["What is an old customer? → Old = in the old customers file"]);
  });
});

describe("the plan language", () => {
  it("accepts lookup, append and compare steps", () => {
    const { plan, problems } = normalisePlan({ steps: [
      { op: "lookup", file: "b", left_on: "id", right_on: "id", columns: ["x"] },
      { op: "append", file: "c" },
      { op: "compare", file: "d", left_on: "id", right_on: "id", keep: "both" },
    ] });
    expect(problems).toEqual([]);
    expect(plan!.steps.map((s) => s.op)).toEqual(["lookup", "append", "compare"]);
  });
  it("rejects unknown steps", () => {
    expect(normalisePlan({ steps: [{ op: "drop_table" }] }).problems[0]).toMatch(/not a step/);
  });
});

/** A fake Gemini that plays back the given model turns and records every request. */
function scripted(turns: Content["parts"][]): { fetch: Fetch; bodies: string[] } {
  const bodies: string[] = [];
  let i = 0;
  const fetch: Fetch = async (_url, init) => {
    bodies.push(init.body);
    const parts = turns[Math.min(i++, turns.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { role: "model", parts } }] }) };
  };
  return { fetch, bodies };
}

describe("agent loop", () => {
  it("looks, asks, runs two plans across files and finishes, without ever sending a row", async () => {
    const ws = await sampleWorkspace();
    const ctx = context(ws, ["Old = in the old customers file"]);
    const { fetch, bodies } = scripted([
      [{ functionCall: { name: "describe_table", args: { table: "repayments" } } }],
      [{ functionCall: { name: "ask_user", args: { question: "What counts as an old customer?", options: ["Old = in the old customers file", "Old = loans_taken > 1"] } } }],
      [{ functionCall: { name: "run_plan", args: { table: "new_customers", plan: ALL_CUSTOMERS, result_name: "All customers", purpose: "Both files with a type" } } }],
      [{ functionCall: { name: "run_plan", args: { table: "repayments", plan: OLD_NEW_PIVOT, result_name: "Repayment old vs new", purpose: "Repayment % by type" } } }],
      [{ functionCall: { name: "final_answer", args: { message: "Old customers repay better.", sheets: ["Repayment old vs new"] } } }],
    ]);
    const steps: string[] = [];
    const agent = new Agent(new GeminiClient(settings, fetch), ctx, { step: (v) => steps.push(v.kind), status: () => {} });
    const answer = await agent.run("repayment % of old vs new customers as a pivot");
    expect(answer).toEqual({ message: "Old customers repay better.", sheets: ["Repayment old vs new"] });
    expect(steps).toEqual(["look", "ask", "run", "run"]);
    expect(ctx.asked).toEqual(["What counts as an old customer?"]);
    expect(bodies).toHaveLength(5);
    const all = bodies.join("\n");
    expect(all).not.toMatch(/C0000\d|L0000\d/); // no customer or loan id ever leaves
    // the model sees the confirmed definition and the pivot it made (a 3-row summary)
    expect(bodies[4]).toContain("What counts as an old customer? → Old = in the old customers file");
    expect(bodies[4]).toMatch(/Repayment %/);
    expect(JSON.parse(bodies[0]).tools[0].functionDeclarations.map((f: { name: string }) => f.name)).toContain("run_plan");
  });

  it("stops after too many rounds and keeps what was made", async () => {
    const ws = await sampleWorkspace();
    const { fetch } = scripted([[{ functionCall: { name: "describe_table", args: { table: "repayments", columns: ["dpd"] } } }]]);
    const agent = new Agent(new GeminiClient(settings, fetch), context(ws), { step: () => {}, status: () => {} });
    const answer = await agent.run("loop forever");
    expect(answer.message).toMatch(/stopped after/);
  });

  it("a plain text reply ends the request", async () => {
    const ws = await sampleWorkspace();
    const { fetch } = scripted([[{ text: "These are four files about lending." }]]);
    const agent = new Agent(new GeminiClient(settings, fetch), context(ws), { step: () => {}, status: () => {} });
    expect((await agent.run("what are these?")).message).toBe("These are four files about lending.");
  });

  it("explains a refused key in plain words", async () => {
    const ws = await sampleWorkspace();
    const fetch: Fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }) });
    const agent = new Agent(new GeminiClient(settings, fetch), context(ws), { step: () => {}, status: () => {} });
    await expect(agent.run("hi")).rejects.toThrow(/did not accept the API key/);
  });
});

describe("report", () => {
  it("has every result sheet plus a How calculated sheet, and opens as an .xlsx", async () => {
    const ws = await sampleWorkspace();
    const ctx = context(ws);
    await runTool("run_plan", { table: "new_customers", plan: ALL_CUSTOMERS, result_name: "All customers", purpose: "Both files" }, ctx);
    await runTool("run_plan", { table: "repayments", plan: OLD_NEW_PIVOT, result_name: "Repayment old vs new", purpose: "Repayment %" }, ctx);
    const { sheets, formats } = reportSheets(ws);
    expect([...sheets.keys()]).toEqual(["All customers", "Repayment old vs new", "How calculated"]);
    const book = await openXlsx(await buildXlsx(sheets, formats));
    const how = (await readSheet(book, "How calculated")).table;
    expect(how.nrows).toBe(2);
    expect(String(how.columns[3].values[1])).toMatch(/customer_type/);
  });
});
