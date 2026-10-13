/** The Excel Agent: workspace, tools (with privacy), the agent loop with a scripted Gemini, and the report. */
import { describe, expect, it } from "vitest";
import { Content, Fetch, GeminiClient, defaultSettings, pickModel } from "../src/ai/gemini";
import { normalisePlan } from "../src/ai/schema";
import { OllamaClient, pickLocalModel } from "../src/ai/ollama";
import { isReady, makeClient } from "../src/ai/client";
import { PrivacyBlock, blockedValues, checkOutgoing, personalData } from "../src/agent/guard";
import { Agent } from "../src/agent/loop";
import { reportSheets } from "../src/agent/report";
import { sampleFiles } from "../src/agent/sample";
import { ToolContext, columnsUsed, runTool } from "../src/agent/tools";
import { Workspace, guessRole } from "../src/agent/workspace";
import { buildXlsx } from "../src/web/xlsx-write";
import { openXlsx, readSheet } from "../src/web/xlsx-read";

/** "Standard" privacy (values and small results shared); strict mode is tested on its own below. */
const settings = { ...defaultSettings(), enabled: true, apiKey: "test-key", shareValues: true, readResults: true };

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
    bodies.push(init.body ?? "");
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

describe("model choice", () => {
  const gen = ["generateContent"];
  it("picks the newest stable Flash model, skipping special ones", () => {
    expect(pickModel([
      { name: "models/gemini-2.0-flash", supportedGenerationMethods: gen },
      { name: "models/gemini-3.0-flash", supportedGenerationMethods: gen },
      { name: "models/gemini-3.0-flash-lite", supportedGenerationMethods: gen },
      { name: "models/gemini-3.5-flash-preview-09", supportedGenerationMethods: gen },
      { name: "models/gemini-3.0-flash-image", supportedGenerationMethods: gen },
      { name: "models/gemini-3.0-pro", supportedGenerationMethods: gen },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ])).toBe("gemini-3.0-flash");
    expect(pickModel([{ name: "models/gemini-flash-latest", supportedGenerationMethods: gen }, { name: "models/gemini-3.0-flash", supportedGenerationMethods: gen }])).toBe("gemini-flash-latest");
    expect(pickModel([])).toBeNull();
  });

  it("switches to an available model when the chosen one was retired, and says so", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url) => {
      urls.push(url);
      if (url.includes("gemini-2.5-flash:")) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: "models/gemini-2.5-flash is not found" } }) };
      if (url.includes("?pageSize")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: "models/gemini-3.0-flash", supportedGenerationMethods: ["generateContent"] }] }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "{\"ok\":true}" }] } }] }) };
    };
    const s = { ...settings, model: "gemini-2.5-flash" };
    const c = new GeminiClient(s, fetch);
    let changed = "";
    c.onModelChange = (m) => { changed = m; };
    expect(await c.ask("sys", "ping")).toEqual({ ok: true });
    expect(changed).toBe("gemini-3.0-flash");
    expect(s.model).toBe("gemini-3.0-flash");
    expect(urls.map((u) => u.replace(/^.*models/, ""))).toEqual(["/gemini-2.5-flash:generateContent", "?pageSize=1000", "/gemini-3.0-flash:generateContent"]);
  });

  it("explains when no model can be found", async () => {
    const fetch: Fetch = async (url) => (url.includes("?pageSize")
      ? { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) }
      : { ok: false, status: 404, text: async () => "{}" });
    await expect(new GeminiClient({ ...settings, model: "old" }, fetch).ask("s", "u")).rejects.toThrow(/couldn't find another one/);
  });
});

describe("a busy Gemini", () => {
  const ok = { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "{\"ok\":true}" }] } }] }) };
  const busy = { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }) };
  const list = { ok: true, status: 200, text: async () => JSON.stringify({ models: ["gemini-flash-latest", "gemini-3.0-flash", "gemini-2.0-flash"].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) }) };

  it("waits and tries again", async () => {
    let calls = 0;
    const c = new GeminiClient({ ...settings, model: "gemini-flash-latest" }, async () => (++calls < 3 ? busy : ok));
    const waits: number[] = [];
    const status: string[] = [];
    c.wait = async (ms) => { waits.push(ms); };
    c.onStatus = (m) => status.push(m);
    expect(await c.ask("s", "u")).toEqual({ ok: true });
    expect(waits).toEqual([2000, 5000]);
    expect(status[0]).toMatch(/busy/);
  });

  it("then tries another Flash model for this request, without changing the saved one", async () => {
    const tried: string[] = [];
    const s = { ...settings, model: "gemini-flash-latest" };
    const c = new GeminiClient(s, async (url) => {
      if (url.includes("?pageSize")) return list;
      const m = /models\/([^:]+):/.exec(url)![1];
      tried.push(m);
      return m === "gemini-2.0-flash" ? ok : busy;
    });
    c.wait = async () => {};
    expect(await c.ask("s", "u")).toEqual({ ok: true });
    expect(tried).toEqual(["gemini-flash-latest", "gemini-flash-latest", "gemini-flash-latest", "gemini-3.0-flash", "gemini-2.0-flash"]);
    expect(s.model).toBe("gemini-flash-latest");
  });

  it("says plainly when Google stays busy", async () => {
    const c = new GeminiClient({ ...settings }, async (url) => (url.includes("?pageSize") ? list : busy));
    c.wait = async () => {};
    await expect(c.ask("s", "u")).rejects.toThrow(/overloaded right now/);
  });

  it("stops waiting when the person presses Stop", async () => {
    const c = new GeminiClient({ ...settings }, async () => busy);
    const stop = new AbortController();
    const asking = c.ask("s", "u", stop.signal);
    setTimeout(() => stop.abort(), 10);
    await expect(asking).rejects.toThrow(/Stopped/);
  });
});

describe("guardrails", () => {
  it("are strict by default: no values and no result rows leave", async () => {
    const strict = { ...defaultSettings(), enabled: true, apiKey: "k" };
    expect(strict.shareValues).toBe(false);
    expect(strict.readResults).toBe(false);
    const ws = await sampleWorkspace();
    const ctx = { ...context(ws), settings: strict };
    const states = await runTool("value_counts", { table: "new_customers", column: "state" }, ctx);
    expect(JSON.stringify(states.response)).not.toMatch(/Maharashtra/);
    const run = await runTool("run_plan", { table: "repayments", plan: JSON.stringify({ steps: [{ op: "group_by", columns: ["dpd"], aggregations: [{ column: "due_amt", func: "sum" }] }] }), result_name: "x", purpose: "" }, ctx);
    expect(run.response.data).toBeUndefined();
    expect(run.response.rows_withheld).toMatch(/switched off/);
  });

  it("recognise personal data", () => {
    expect(personalData("pan ABCDE1234F please")).toEqual(["a PAN number"]);
    expect(personalData("call 9876543210")).toEqual(["a phone number"]);
    expect(personalData("aadhaar 1234 5678 9012")).toContain("an Aadhaar number");
    expect(personalData("mail asha@example.com")).toEqual(["an e-mail address"]);
    expect(personalData("repayment % of old vs new customers by state")).toEqual([]);
  });

  it("stop a request carrying personal data or a value from a name or id column, before it is sent", async () => {
    const ws = new Workspace();
    const csv = "customer_id,customer_name,phone,state,due_amt\n" + Array.from({ length: 80 }, (_, i) => `C${1000 + i},Person${i} Kumar,98765${String(10000 + i)},${["MH", "KA"][i % 2]},${1000 + i}`).join("\n");
    await ws.addFiles([new File([csv], "cx.csv")]);
    await ws.ensure("cx", "all");
    const blocked = blockedValues(ws);
    const req = (text: string) => ({ contents: [{ role: "user", parts: [{ text }] }] });
    expect(() => checkOutgoing(req("repayment % by state and due_amt for MH"), blocked)).not.toThrow(); // column names and states are fine
    expect(() => checkOutgoing(req("what did Person7 pay?"), blocked)).toThrow(PrivacyBlock);
    expect(() => checkOutgoing(req("loans of C1005"), blocked)).toThrow(/value from your file/);
    expect(() => checkOutgoing(req("call 9876510003"), blocked)).toThrow(/phone number/);
    // a tool result that somehow carried a name is stopped too
    expect(() => checkOutgoing({ contents: [{ role: "user", parts: [{ functionResponse: { name: "x", response: { data: [["Person3 Kumar", 5]] } } }] }] }, blocked)).toThrow(PrivacyBlock);
  });

  it("the client never sends a blocked request", async () => {
    let sent = 0;
    const c = new GeminiClient(settings, async () => { sent++; return { ok: true, status: 200, text: async () => "{}" }; });
    c.guard = (body) => checkOutgoing(body, { values: new Set(), words: new Set() });
    await expect(c.ask("system", "my PAN is ABCDE1234F")).rejects.toThrow(PrivacyBlock);
    expect(sent).toBe(0);
  });

  it("the whole agent run sends no personal data, in standard mode too", async () => {
    const ws = await sampleWorkspace();
    await ws.ensure("new_customers", "all");
    const { fetch, bodies } = scripted([
      [{ functionCall: { name: "describe_table", args: { table: "new_customers" } } }],
      [{ functionCall: { name: "value_counts", args: { table: "new_customers", column: "customer_id" } } }],
      [{ functionCall: { name: "final_answer", args: { message: "ok" } } }],
    ]);
    const c = new GeminiClient(settings, fetch);
    c.guard = (body) => checkOutgoing(body, blockedValues(ws));
    const agent = new Agent(c, context(ws), { step: () => {}, status: () => {} });
    await agent.run("describe the new customers");
    expect(bodies).toHaveLength(3);
    expect(bodies.join("")).not.toMatch(/C0\d{4}/);
  });
});

describe("local model (Ollama)", () => {
  const local = { ...settings, provider: "ollama" as const, ollamaUrl: "http://localhost:11434", ollamaModel: "qwen2.5:7b", apiKey: "" };
  const reply = (message: Record<string, unknown>) => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { role: "assistant", content: "", ...message } }) });

  it("turns the agent's turns into chat messages and tool calls back into the agent's shape", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetch: Fetch = async (url, init) => {
      expect(url).toBe("http://localhost:11434/api/chat");
      seen.push(JSON.parse(init.body!));
      return reply({ tool_calls: [{ function: { name: "describe_table", arguments: { table: "repayments" } } }] });
    };
    const c = new OllamaClient(local, fetch);
    const turn = await c.chat("system text", [
      { role: "user", parts: [{ text: "repayment by state" }] },
      { role: "model", parts: [{ functionCall: { name: "value_counts", args: { table: "a", column: "b" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "value_counts", response: { values: [] } } }] },
    ], [{ name: "describe_table", description: "look", parameters: { type: "object", properties: {} } }]);
    expect(turn).toEqual({ role: "model", parts: [{ functionCall: { name: "describe_table", args: { table: "repayments" } } }] });
    const body = seen[0] as { model: string; messages: { role: string; content: string; tool_calls?: unknown[]; tool_name?: string }[]; tools: { function: { name: string } }[] };
    expect(body.model).toBe("qwen2.5:7b");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls).toHaveLength(1);
    expect(body.messages[3].tool_name).toBe("value_counts");
    expect(body.tools[0].function.name).toBe("describe_table");
  });

  it("runs the whole agent with a local model, guard and log included", async () => {
    const ws = await sampleWorkspace();
    const turns = [
      { tool_calls: [{ function: { name: "run_plan", arguments: { table: "new_customers", plan: ALL_CUSTOMERS, result_name: "All customers", purpose: "both" } } }] },
      { tool_calls: [{ function: { name: "run_plan", arguments: { table: "repayments", plan: JSON.parse(OLD_NEW_PIVOT), result_name: "Repayment old vs new", purpose: "pct" } } }] },
      { content: "Old customers repay better." },
    ];
    let i = 0;
    const c = new OllamaClient(local, async () => reply(turns[i++]));
    const sent: unknown[] = [];
    c.onSend = (b) => sent.push(b);
    c.guard = (b) => checkOutgoing(b, blockedValues(ws));
    const answer = await new Agent(c, context(ws), { step: () => {}, status: () => {} }).run("old vs new repayment pivot");
    expect(answer.message).toBe("Old customers repay better.");
    expect(answer.sheets).toEqual(["Repayment old vs new", "All customers"]); // newest first; the plan may arrive as an object from small models
    expect(sent).toHaveLength(3);
  });

  it("uses an installed model when the chosen one is missing", async () => {
    const c = new OllamaClient({ ...local, ollamaModel: "nope" }, async (url, init) => {
      if (url.endsWith("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: "nomic-embed-text" }, { name: "llama3.1:8b" }] }) };
      const model = JSON.parse(init.body!).model;
      return model === "nope" ? { ok: false, status: 404, text: async () => "{\"error\":\"model 'nope' not found\"}" } : reply({ content: "{\"ok\":true}" });
    });
    let changed = "";
    c.onModelChange = (m) => { changed = m; };
    expect(await c.ask("s", "u")).toEqual({ ok: true });
    expect(changed).toBe("llama3.1:8b");
    expect(pickLocalModel(["mistral:7b", "qwen2.5:14b"])).toBe("qwen2.5:14b");
  });

  it("explains how to fix an unreachable server", async () => {
    const c = new OllamaClient(local, async () => { throw new TypeError("Failed to fetch"); });
    await expect(c.ask("s", "u")).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it("needs no key", () => {
    expect(isReady(local)).toBe(true);
    expect(isReady({ ...settings, apiKey: "" })).toBe(false);
    expect(makeClient(local)).toBeInstanceOf(OllamaClient);
    expect(makeClient(settings)).toBeInstanceOf(GeminiClient);
  });
});
