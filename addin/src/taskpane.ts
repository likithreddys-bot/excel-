import { describe as describeStep } from "./engine/describe";
import { applyPlan, PlanError, rowCounts } from "./engine/engine";
import { Parser, makePlan, replyColumns } from "./engine/parser";
import type { Plan } from "./engine/plan";
import type { Cell, Sheets, Table } from "./engine/table";
import { isoDay } from "./engine/util";
import { DemoHost } from "./excel/demo";
import { ExcelHost } from "./excel/io";
import { Host, HostError, SourceRef } from "./host";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (n: number) => n.toLocaleString("en-IN");

interface Pending { text: string; plan: Plan; result: Sheets; before: number }

const state = {
  host: null as Host | null,
  ref: undefined as SourceRef | undefined,
  /** The "which column?" question waiting for an answer. */
  asked: null as string | null,
  pending: null as Pending | null,
  busy: false,
};

// ---------- small DOM helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function post(kind: "user" | "bot" | "err", text = ""): HTMLDivElement {
  const m = el("div", `msg ${kind === "user" ? "user" : kind === "err" ? "bot err" : "bot"}`, text);
  $("thread").append(m);
  m.scrollIntoView({ block: "end", behavior: "smooth" });
  return m;
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  $<HTMLButtonElement>("send").disabled = busy || !state.host;
  $<HTMLTextAreaElement>("input").disabled = busy || !state.host;
}

function cellText(t: Table, j: number, i: number): string {
  const c = t.columns[j];
  const v: Cell = c.values[i];
  if (v === null || v === "") return "";
  if (c.kind === "date" && c.time?.[i] != null && typeof v === "number") return isoDay(c.time[i]!);
  return typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
}

function miniTable(t: Table, limit = 5): HTMLElement {
  const wrap = el("div", "mini");
  const table = el("table");
  const head = el("tr");
  for (const c of t.columns) head.append(el("th", "", c.name));
  table.append(head);
  for (let i = 0; i < Math.min(limit, t.nrows); i++) {
    const tr = el("tr");
    t.columns.forEach((_, j) => tr.append(el("td", "", cellText(t, j, i))));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

// ---------- the data ----------

function showSource(label: string, t: Table): void {
  $("source-text").textContent = `${label} · ${num(t.nrows)} rows · ${t.columns.length} columns`;
  $("source-text").classList.remove("muted");
  const box = $("columns");
  box.replaceChildren(...t.columns.map((c) => el("span", "chip", c.name)));
  $("columns-box").classList.remove("hidden");
  showExamples(t);
}

function showExamples(t: Table): void {
  const sheets: Sheets = new Map([["Result", t]]);
  const usable = new Parser(t).examples().filter((e) => {
    try { return makePlan(sheets, e).clarification_question === null; } catch { return false; }
  });
  const box = $("examples");
  box.replaceChildren(...usable.map((e) => {
    const b = el("button", "chip", e);
    b.type = "button";
    b.addEventListener("click", () => { $<HTMLTextAreaElement>("input").value = e; $("input").focus(); });
    return b;
  }));
  $("examples-box").classList.toggle("hidden", usable.length === 0);
}

async function readSource(ref?: SourceRef): Promise<Table> {
  const src = await state.host!.readSource(ref);
  state.ref = src.ref;
  showSource(src.label, src.table);
  return src.table;
}

// ---------- commands ----------

async function preview(text: string): Promise<void> {
  post("user", text);
  const table = await readSource(state.ref);
  const sheets: Sheets = new Map([["Result", table]]);

  // A reply that is only column names answers the "which column?" question asked just before.
  const reply = state.asked ? replyColumns(sheets, text) : null;
  if (reply && reply[1].length) {
    post("bot", "I couldn't find " + reply[1].join(", ") + ". Reply again with the column names.");
    return;
  }
  const plan = reply ? makePlan(sheets, state.asked!, reply[0]) : makePlan(sheets, text);
  if (plan.clarification_question) {
    state.pending = null;
    state.asked = plan.awaits_columns ? (reply ? state.asked : text) : null;
    post("bot", plan.clarification_question);
    return;
  }
  state.asked = null;

  let result: Sheets;
  try {
    result = applyPlan(sheets, plan);
  } catch (e) {
    state.pending = null;
    if (e instanceof PlanError) { post("err", `This can't run on your data: ${e.message}`); return; }
    throw e;
  }
  state.pending = { text, plan, result, before: table.nrows };
  renderPreview(state.pending);
}

function renderPreview(p: Pending): void {
  const card = post("bot", "Here's what I'll do:");
  const list = el("ul", "steps");
  for (const s of p.plan.steps) list.append(el("li", "", describeStep(s)));
  card.append(list);

  const counts = rowCounts(p.result);
  const names = Object.keys(counts);
  const out = el("div", "outcome");
  if (names.length === 1) {
    out.append(`${num(p.before)} rows → `, el("strong", "", `${num(counts[names[0]])} rows`));
  } else {
    out.append(`${num(p.before)} rows → `, el("strong", "", `${names.length} sheets`));
    const ul = el("ul", "steps");
    for (const n of names.slice(0, 8)) ul.append(el("li", "", `${n}: ${num(counts[n])} rows`));
    if (names.length > 8) ul.append(el("li", "muted", `…and ${names.length - 8} more`));
    out.append(ul);
  }
  card.append(out);
  const first = p.result.get(names[0])!;
  if (first.nrows) card.append(miniTable(first), el("div", "muted", names.length > 1 ? `First rows of “${names[0]}”` : "First rows of the result"));
  else card.append(el("div", "note", "No rows match. Nothing would be written."));
  card.append(el("div", "note", "Your original data is never changed. The result goes onto new sheet(s)."));

  const actions = el("div", "actions");
  const run = el("button", "primary", "Run it");
  const cancel = el("button", "", "Cancel");
  run.type = cancel.type = "button";
  run.disabled = first.nrows === 0;
  actions.append(run, cancel);
  card.append(actions);
  const lock = () => { run.disabled = true; cancel.disabled = true; };
  cancel.addEventListener("click", () => { lock(); state.pending = null; post("bot", "Cancelled. Nothing was changed."); });
  run.addEventListener("click", () => { lock(); void guarded(() => execute(p)); });
}

async function execute(p: Pending): Promise<void> {
  if (state.pending !== p) return;
  const made = await state.host!.writeResult(p.result);
  state.pending = null;
  const card = post("bot");
  card.classList.add("ok");
  card.textContent = made.length === 1
    ? `Done. I made the sheet “${made[0].name}” with ${num(made[0].rows)} rows.`
    : `Done. I made ${made.length} sheets: ${made.slice(0, 6).map((m) => `${m.name} (${num(m.rows)})`).join(", ")}${made.length > 6 ? "…" : ""}.`;
  if (made.length === 1) {
    state.ref = await state.host!.refOf(made[0].name);
    card.append(el("div", "muted", "Your next command will carry on from this new sheet. Press “Use my table” to start from a different table."));
  }
  const actions = el("div", "actions");
  const undo = el("button", "", "Undo (remove the new sheets)");
  undo.type = "button";
  undo.addEventListener("click", () => guarded(async () => {
    undo.disabled = true;
    await state.host!.removeSheets(made.map((m) => m.name));
    if (made.length === 1 && state.ref?.sheet === made[0].name) state.ref = undefined;
    post("bot", "Undone. The new sheets are removed.");
  }));
  actions.append(undo);
  card.append(actions);
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    post("err", e instanceof HostError ? e.message : `Something went wrong: ${(e as Error).message ?? e}`);
  } finally {
    setBusy(false);
  }
}

// ---------- start up ----------

function wire(): void {
  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const box = $<HTMLTextAreaElement>("input");
    const text = box.value.trim();
    if (!text || state.busy) return;
    box.value = "";
    void guarded(() => preview(text));
  });
  $("input").addEventListener("keydown", (ev) => {
    const k = ev as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); $<HTMLFormElement>("ask").requestSubmit(); }
  });
  $("use-selection").addEventListener("click", () => void guarded(async () => {
    state.ref = undefined;
    state.asked = null;
    await readSource(undefined);
  }));
}

async function start(): Promise<void> {
  wire();
  // New messages scroll into view above the input area, not behind it.
  new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${$("dock").offsetHeight}px`)).observe($("dock"));
  let inExcel = false;
  if (typeof Office !== "undefined") {
    const info = await Office.onReady();
    inExcel = info.host === Office.HostType.Excel;
  }
  state.host = inExcel ? new ExcelHost() : new DemoHost();
  setBusy(false);
  if (!inExcel) {
    post("bot", "You're not inside Excel, so this is a demo with made-up bank transactions. Try the examples below.");
    await guarded(async () => { await readSource(undefined); });
  } else {
    post("bot", "Hi! Click any cell inside your table, press “Use my table”, then tell me what you want. For example: only debits over 5000, split by category.");
  }
}

void start();
