/**
 * DuckDB in the browser (WebAssembly, in a background worker). Loaded only when a big file or a SQL query needs it.
 * Files are read straight from disk through the browser's file reader, so a multi-GB CSV never has to fit in memory.
 * Extension downloads are switched off: nothing is fetched from the internet.
 */
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { SqlDb, SqlResult } from "./sql";

export async function startBrowserDuck(): Promise<SqlDb> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } });
  const conn = await db.connect();
  for (const s of ["SET autoinstall_known_extensions = false", "SET autoload_known_extensions = false"]) {
    try { await conn.query(s); } catch { /* older builds don't know the setting; the page's security rule blocks downloads anyway */ }
  }
  return {
    async registerBlob(name, blob) {
      await db.registerFileHandle(name, blob, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    },
    async registerText(name, text) {
      await db.registerFileText(name, text);
    },
    async query(sql): Promise<SqlResult> {
      const r = await conn.query(sql);
      const columns = r.schema.fields.map((f) => ({ name: f.name, type: String(f.type) }));
      const rows: unknown[][] = [];
      const cols = r.schema.fields.map((_, j) => r.getChildAt(j));
      for (let i = 0; i < r.numRows; i++) rows.push(cols.map((c) => c?.get(i) ?? null));
      return { columns, rows };
    },
  };
}
