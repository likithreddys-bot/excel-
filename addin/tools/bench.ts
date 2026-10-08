// How long the add-in's own work takes on a big table (Excel's reading and writing time is not included).
//   npx vite-node tools/bench.ts 1000000
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { profile } from "../src/engine/profile";
import { Cell, Sheets, makeTable } from "../src/engine/table";
import { msToSerial, utcDay } from "../src/engine/util";

const n = Number(process.argv[2] ?? 200_000);
const cats = ["Food and Dining", "Travel", "Rent", "Shopping", "Salary", "Cash"];
const branches = ["Mumbai", "Pune", "Delhi", "Chennai", "Kolkata", null];
const start = msToSerial(utcDay(2023, 1, 1)!);
const rows: Cell[][] = Array.from({ length: n }, (_, i) => [
  100000 + i, start + (i % 900), "UPI/" + cats[i % 6].toUpperCase().slice(0, 4) + (i % 97), cats[i % 6],
  i % 3 ? "DEBIT" : "CREDIT", (i * 7919) % 200000, (i * 104729) % 1000000, branches[i % 6], "PAN" + (i % 120000), `user${i % 90000}@mail.com`,
]);
const names = ["txn_id", "txn_date", "description", "category", "txn_type", "amount", "balance", "branch", "pan", "email"];
const mem = () => Math.round(process.memoryUsage().heapUsed / 1e6);

let t0 = performance.now();
const table = makeTable(names, rows, ["0", "dd/mm/yyyy", "General", "General", "General", "#,##0", "#,##0", "General", "General", "General"]);
console.log(`${n.toLocaleString()} rows x ${names.length} columns`);
console.log(`read into the add-in (kinds, dates)`.padEnd(58), `${Math.round(performance.now() - t0)} ms   heap ${mem()} MB`);
t0 = performance.now();
const found = profile(table);
console.log(`beginner-mode scan (${found.length} findings)`.padEnd(58), `${Math.round(performance.now() - t0)} ms`);

const sheets: Sheets = new Map([["Result", table]]);
const commands = [
  "only debits over 50000", "sort by amount descending", "split by category", "remove duplicates by pan",
  "total amount by branch", "pivot amount by category and txn_type", "monthly total amount by category", "top 10 by amount",
  "running total of amount per category", "rank by amount", "add column gst = amount * 0.18",
  'add column grade = IF(amount>100000,"High",IF(amount>50000,"Medium","Low"))', "add column dup = COUNTIF(pan, pan) > 1",
  'add column who = LEFT(email, FIND("@", email) - 1)', "highlight rows where amount > 150000 in red", "trim spaces",
  "bar chart of total amount by category", "keep rows where =AND(txn_type=\"DEBIT\", amount>1000)",
];
for (const cmd of commands) {
  t0 = performance.now();
  const plan = makePlan(sheets, cmd);
  const planMs = performance.now() - t0;
  if (plan.clarification_question) { console.log(cmd.padEnd(58), "-> asked:", plan.clarification_question.split("\n")[0]); continue; }
  t0 = performance.now();
  let out: Sheets;
  try { out = applyPlan(sheets, plan); } catch (e) { console.log(cmd.padEnd(58), "-> error:", (e as Error).message); continue; }
  const rowsOut = [...out.values()].reduce((a, t) => a + t.nrows, 0);
  console.log(cmd.padEnd(58), `plan ${Math.round(planMs)} ms  run ${Math.round(performance.now() - t0)} ms  -> ${rowsOut.toLocaleString()} rows  heap ${mem()} MB`);
}
