/** The SQL tier with the real DuckDB (its Node build): big files, joins with in-memory tables, privacy, safety. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/ai/gemini";
import { blockedValues, checkOutgoing, PrivacyBlock } from "../src/agent/guard";
import { sampleFiles } from "../src/agent/sample";
import { SqlDb, SqlResult, checkSql, tablesIn } from "../src/agent/sql";
import { ToolContext, runTool } from "../src/agent/tools";
import { Workspace } from "../src/agent/workspace";

const require = createRequire(import.meta.url);
const duck = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const dist = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm").replace(/duckdb-eh\.wasm$/, "");

let shared: Promise<SqlDb> | null = null;
/** One DuckDB for the whole file (it takes a second to start). */
function nodeDb(): Promise<SqlDb> {
  shared ??= (async () => {
    const db = await duck.createDuckDB({ mvp: { mainModule: dist + "duckdb-mvp.wasm", mainWorker: dist + "duckdb-node-mvp.worker.cjs" }, eh: { mainModule: dist + "duckdb-eh.wasm", mainWorker: dist + "duckdb-node-eh.worker.cjs" } }, new duck.VoidLogger(), duck.NODE_RUNTIME);
    await db.instantiate();
    db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } });
    const conn = db.connect();
    return {
      async registerBlob(name: string, blob: Blob) { db.registerFileBuffer(name, new Uint8Array(await blob.arrayBuffer())); },
      async registerText(name: string, text: string) { db.registerFileBuffer(name, new TextEncoder().encode(text)); },
      async query(sql: string): Promise<SqlResult> {
        const r = conn.query(sql);
        const cols = r.schema.fields.map((_: unknown, j: number) => r.getChildAt(j));
        const rows: unknown[][] = [];
        for (let i = 0; i < r.numRows; i++) rows.push(cols.map((c: { get(i: number): unknown } | null) => c?.get(i) ?? null));
        return { columns: r.schema.fields.map((f: { name: string; type: unknown }) => ({ name: f.name, type: String(f.type) })), rows };
      },
    };
  })();
  return shared;
}

const settings = { ...defaultSettings(), enabled: true, apiKey: "k", shareValues: true, readResults: true };
const ctx = (ws: Workspace): ToolContext => ({ ws, settings, notes: [], saveNotes: () => {}, ask: async () => "" });

/** repayments (the biggest sample file) goes to DuckDB; the customer files stay in memory. */
async function workspace(): Promise<Workspace> {
  const files = sampleFiles();
  const sizes = files.map((f) => f.size).sort((a, b) => b - a);
  const ws = new Workspace(nodeDb, sizes[0] - 1);
  await ws.addFiles(files);
  return ws;
}

async function expected(): Promise<Record<string, number>> {
  const files = sampleFiles();
  const rows = async (n: string) => (await files.find((f) => f.name === n)!.text()).trim().split("\n").slice(1).map((l) => l.split(","));
  const old = new Set((await rows("old_customers.csv")).map((r) => r[0]));
  const s: Record<string, [number, number]> = { Old: [0, 0], New: [0, 0] };
  for (const r of await rows("repayments.csv")) { const k = old.has(r[1]) ? "Old" : "New"; s[k][0] += Number(r[3]); s[k][1] += Number(r[4]); }
  return { Old: (s.Old[1] * 100) / s.Old[0], New: (s.New[1] * 100) / s.New[0] };
}

describe("SQL safety", () => {
  it("allows one read-only query", () => {
    expect(checkSql('SELECT "state", count(*) FROM "repayments" GROUP BY 1')).toBeNull();
    expect(checkSql("WITH a AS (SELECT 1 x) SELECT * FROM a;")).toBeNull();
    expect(checkSql(`SELECT replace("name", 'a', 'b') FROM t`)).toBeNull();
    expect(checkSql('SELECT "set", "update" FROM t')).toBeNull(); // quoted column names are fine
  });
  it("refuses anything that writes, loads or reaches outside", () => {
    for (const q of ["DROP VIEW x", "SELECT 1; DROP VIEW x", "COPY t TO 'out.csv'", "ATTACH 'x.db'", "INSTALL httpfs", "SELECT * FROM read_csv('f1.csv')", "SELECT * FROM 'https://example.com/a.csv'", "PRAGMA version", "SET threads=1", "CREATE TABLE a AS SELECT 1"]) {
      expect(checkSql(q), q).not.toBeNull();
    }
  });
  it("finds the tables a query names", () => {
    expect(tablesIn('SELECT * FROM "Repayment by state" JOIN repayments USING (x)', ["repayments", "Repayment by state", "loan_policy"])).toEqual(["repayments", "Repayment by state"]);
  });
});

describe("large files with DuckDB", () => {
  it("routes the big file to SQL and keeps run_plan away from it", async () => {
    const ws = await workspace();
    expect(ws.sources().map((s) => [s.name, s.engine])).toEqual([["new_customers", "memory"], ["old_customers", "memory"], ["repayments", "sql"], ["loan_policy", "memory"]]);
    const r = await runTool("run_plan", { table: "repayments", plan: '{"steps":[{"op":"sort","columns":["dpd"]}]}', result_name: "x", purpose: "" }, ctx(ws));
    expect(String(r.response.error)).toMatch(/use run_sql/);
  });

  it("describes a big file from a sample, with exact row counts, and never shares ids", async () => {
    const ws = await workspace();
    const d = await runTool("describe_table", { table: "repayments" }, ctx(ws));
    expect(d.response.rows).toBe(3656);
    expect(String(d.response.engine)).toMatch(/run_sql/);
    expect(JSON.stringify(d.response)).not.toMatch(/L0000\d|C0000\d/);
    const ids = await runTool("value_counts", { table: "repayments", column: "loan_id" }, ctx(ws));
    expect(ids.response.withheld).toMatch(/id/);
    const dpd = await runTool("value_counts", { table: "repayments", column: "dpd" }, ctx(ws));
    expect((dpd.response.values as unknown[]).length).toBeGreaterThan(0);
  });

  it("joins the big file with in-memory tables in SQL and gets the exact old vs new repayment %", async () => {
    const ws = await workspace();
    const sql = `
      WITH cust AS (SELECT "customer_id", 'New' AS "type" FROM "new_customers" UNION ALL SELECT "customer_id", 'Old' FROM "old_customers")
      SELECT c."type" AS "customer_type", sum(r."due_amt") AS "Due", sum(r."paid_amt") AS "Repaid", sum(r."paid_amt") * 100.0 / sum(r."due_amt") AS "Repayment %"
      FROM "repayments" r JOIN cust c USING ("customer_id") GROUP BY 1 ORDER BY 1`;
    const r = await runTool("run_sql", { sql, result_name: "Repayment old vs new", purpose: "Repayment % by customer type" }, ctx(ws));
    expect(r.response.error, JSON.stringify(r.response)).toBeUndefined();
    const data = r.response.data as (string | number)[][];
    const want = await expected();
    expect(data.map((x) => x[0])).toEqual(["New", "Old"]);
    expect(data[0][3] as number).toBeCloseTo(want.New, 3);
    expect(data[1][3] as number).toBeCloseTo(want.Old, 3);
    const saved = ws.get("Repayment old vs new");
    expect(saved?.kind === "result" && saved.sql).toContain("UNION ALL");
    // a SQL result can feed a later run_plan in the fast engine
    const sorted = await runTool("run_plan", { table: "Repayment old vs new", plan: '{"steps":[{"op":"sort","columns":["Repayment %"],"ascending":false}]}', result_name: "Sorted", purpose: "" }, ctx(ws));
    expect((sorted.response.data as unknown[][])[0][0]).toBe("Old");
  });

  it("refuses unsafe or oversized queries with a reason the agent can act on", async () => {
    const ws = await workspace();
    const drop = await runTool("run_sql", { sql: 'DROP VIEW "repayments"', result_name: "x", purpose: "" }, ctx(ws));
    expect(String(drop.response.error)).toMatch(/SELECT/);
    const bad = await runTool("run_sql", { sql: 'SELECT "nope" FROM "repayments"', result_name: "x", purpose: "" }, ctx(ws));
    expect(String(bad.response.error)).toMatch(/nope/i);
    const raw = await runTool("run_sql", { sql: 'SELECT * FROM "repayments"', result_name: "Raw", purpose: "" }, ctx(ws));
    expect(raw.response.data).toBeUndefined(); // 3,656 rows with ids: kept on the sheet, not shown to the model
    expect(String(raw.response.rows_withheld)).toMatch(/rows|id/);
  });

  it("the privacy guard learns a big file's ids from its samples", async () => {
    const ws = await workspace();
    await runTool("describe_table", { table: "repayments" }, ctx(ws));
    const blocked = blockedValues(ws);
    const one = (ws.get("repayments") as { samples?: { columns: { name: string; values: unknown[] }[] }[] }).samples![0].columns.find((c) => c.name === "loan_id")!.values[0] as string;
    expect(() => checkOutgoing({ contents: [{ parts: [{ text: `details of ${one}` }] }] }, blocked)).toThrow(PrivacyBlock);
  });
});
