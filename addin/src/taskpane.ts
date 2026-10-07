import { describe as describeStep } from "./engine/describe";
import { applyPlan, PlanError, rowCounts } from "./engine/engine";
import { FormatStep, chartTable, highlightMask, isFormatStep, liveFormats } from "./engine/format";
import { Parser, makePlan, replyColumns } from "./engine/parser";
import { LiveColumn, PivotSpec, liveColumns, livePivot } from "./engine/live";
import { profile } from "./engine/profile";
import type { Plan } from "./engine/plan";
import { Cell, Sheets, Table, combine } from "./engine/table";
import { isoDay, key, singular } from "./engine/util";
import { DemoHost } from "./excel/demo";
import { ExcelHost } from "./excel/io";
import { Host, HostError, SourceRef } from "./host";
import { Field, TEMPLATES, Template, Values, build, columnChoices, visibleFields } from "./builder";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (n: number) => n.toLocaleString("en-IN");

interface Pending {
  text: string; plan: Plan; result: Sheets; before: number; using: string; notes: string[]; formats: FormatStep[];
  /** Set when "keep results live" is on and the plan can be written that way. */
  pivot: PivotSpec | null; liveCols: LiveColumn[] | null; source: SourceRef;
}

const state = {
  host: null as Host | null,
  ref: undefined as SourceRef | undefined,
  /** What the last read looked like, e.g. "Sheet1!A1:D7", so each preview can say what it worked on. */
  label: "",
  /** The "which column?" question waiting for an answer. */
  asked: null as string | null,
  /** The table last read, for the menu builder's column lists. */
  table: null as Table | null,
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

function miniTable(t: Table, limit = 5, paint?: (row: number, col: number) => string | null): HTMLElement {
  const wrap = el("div", "mini");
  const table = el("table");
  const head = el("tr");
  for (const c of t.columns) head.append(el("th", "", c.name));
  table.append(head);
  for (let i = 0; i < Math.min(limit, t.nrows); i++) {
    const tr = el("tr");
    t.columns.forEach((_, j) => {
      const td = el("td", "", cellText(t, j, i));
      const colour = paint?.(i, j);
      if (colour) { td.style.background = "#" + colour; td.style.color = "#1f2328"; }
      tr.append(td);
    });
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
  const mixed = t.columns.filter((c) => c.mixedDates).map((c) => c.name);
  $("source-warning").textContent = mixed.length
    ? `Heads up: in ${mixed.join(", ")}, some dates are real Excel dates and some are plain text. I read both, but check them: Excel may have swapped day and month when they were typed or pasted.`
    : "";
  $("source-warning").classList.toggle("hidden", mixed.length === 0);
  showFindings(t);
  showExamples(t);
}

/** Beginner mode: tell the user what looks wrong with their table, with a one-click way to start each fix. */
function showFindings(t: Table): void {
  const box = $("findings");
  const found = t.nrows <= 300_000 ? profile(t) : [];
  box.replaceChildren();
  if (t.nrows > 300_000) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  if (!found.length) {
    box.append(el("div", "muted", "Your table looks tidy: no repeats, stray spaces or odd blanks."));
    return;
  }
  box.append(el("div", "label", `I noticed ${found.length === 1 ? "something" : `${found.length} things`} you may want to fix:`));
  const ul = el("ul");
  for (const f of found) {
    const li = el("li");
    const fix = el("button", "", "Fix…");
    fix.type = "button";
    fix.title = `Preview: ${f.command}`;
    fix.addEventListener("click", () => { if (!state.busy) void guarded(() => preview(f.command)); });
    li.append(el("span", "", f.message), fix);
    ul.append(li);
  }
  box.append(ul);
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
  state.label = src.label;
  state.table = src.table;
  showSource(src.label, src.table);
  return src.table;
}

// ---------- commands ----------

/** Other sheets the command talks about ("bring email from Customers on PAN"): read only those. */
async function sheetsMentioned(text: string, problems: string[]): Promise<Record<string, Table>> {
  const here = state.ref?.sheet;
  const others = (await state.host!.listSheets()).filter((n) => n !== here);
  const k = key(text);
  let named = others.filter((n) => key(n).length > 1 && (k.includes(key(n)) || k.includes(singular(key(n)))));
  // "the other sheet" only makes sense when there is exactly one other sheet.
  if (!named.length && others.length === 1 && /\b(?:other|second|lookup|new|that|another)\s+(?:file|sheet|list|table|data)\b|\bboth\s+(?:files|sheets)\b/i.test(text)) named = others;
  const out: Record<string, Table> = {};
  for (const n of named) {
    try { out[n] = await state.host!.readSheet(n); } catch (e) {
      problems.push(e instanceof HostError ? e.message : `I couldn't read the sheet “${n}”.`); // said out loud if the command then fails
    }
  }
  return out;
}

/** What "keep results live" can do for this plan (nothing at all in the browser demo). */
function liveOptions(plan: Plan, source: Table, result: Sheets): { pivot: PivotSpec | null; liveCols: LiveColumn[] | null } {
  if (!isLive() || state.host?.kind !== "excel") return { pivot: null, liveCols: null };
  const first = result.values().next().value as Table | undefined;
  return { pivot: livePivot(plan, source), liveCols: result.size === 1 && first ? liveColumns(plan, first) : null };
}

const isLive = (): boolean => $<HTMLInputElement>("live").checked;

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
  const problems: string[] = [];
  const files = await sheetsMentioned(reply ? state.asked! : text, problems);
  const plan = reply ? makePlan(sheets, state.asked!, reply[0], {}, files) : makePlan(sheets, text, [], {}, files);
  if (plan.clarification_question) {
    state.pending = null;
    state.asked = plan.awaits_columns ? (reply ? state.asked : text) : null;
    const card = post("bot", problems.length ? problems.join("\n") : plan.clarification_question);
    if (!plan.awaits_columns) {
      const actions = el("div", "actions");
      const b = el("button", "", "Build it with menus instead");
      b.type = "button";
      b.addEventListener("click", () => void guarded(() => openBuilder()));
      actions.append(b);
      card.append(actions);
    }
    return;
  }
  state.asked = null;

  let result: Sheets;
  const notes: string[] = [];
  try {
    result = applyPlan(sheets, plan, files, notes);
  } catch (e) {
    state.pending = null;
    if (e instanceof PlanError) { post("err", `This can't run on your data: ${e.message}`); return; }
    throw e;
  }
  state.pending = { text, plan, result, before: table.nrows, using: state.label, notes: [...new Set(notes)], formats: plan.steps.filter(isFormatStep),
    ...liveOptions(plan, table, result), source: state.ref! };
  renderPreview(state.pending);
}

function renderPreview(p: Pending): void {
  const card = post("bot", "Here's what I'll do:");
  card.append(el("div", "muted", `On: ${p.using}`));
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
  for (const note of p.notes) card.append(el("div", "note", note));
  if (p.pivot) card.append(el("div", "note", "Live: this will be a PivotTable on your data. Right-click it and choose Refresh after your data changes."));
  else if (p.liveCols) card.append(el("div", "note", `Live: ${p.liveCols.map((c) => `“${c.name}”`).join(", ")} will be formulas that update by themselves.`));
  const first = p.result.get(names[0])!;
  const paint = highlightPainter(first, liveFormats(p.formats, p.result));
  if (first.nrows) card.append(miniTable(first, 5, paint), el("div", "muted", names.length > 1 ? `First rows of “${names[0]}”` : "First rows of the result"));
  else card.append(el("div", "note", "No rows match. Nothing would be written."));
  for (const f of liveFormats(p.formats, p.result)) {
    if (f.op !== "chart") continue;
    const data = chartTable(combine(p.result), f);
    card.append(el("div", "muted", `The chart “${f.title}” will draw these ${data.nrows} values:`), miniTable(data, 8));
  }
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

/** Colours for the preview rows, so the user sees what a highlight will mark. */
function highlightPainter(t: Table, formats: FormatStep[]): ((row: number, col: number) => string | null) | undefined {
  const marks = formats.flatMap((f) => (f.op === "highlight" ? [{ mask: highlightMask(t, f), col: f.column ? t.columns.findIndex((c) => c.name === f.column) : -1, color: f.color }] : []));
  if (!marks.length) return undefined;
  return (row, col) => {
    let out: string | null = null;
    for (const m of marks) if (m.mask[row] && (m.col < 0 || m.col === col)) out = m.color;
    return out;
  };
}

async function execute(p: Pending): Promise<void> {
  if (state.pending !== p) return;
  const extra: string[] = [];
  let made: { name: string; rows: number }[] | null = null;
  if (p.pivot) {
    try {
      made = [await state.host!.writePivot(p.source, p.pivot)];
    } catch (e) {
      extra.push(`I couldn't build a PivotTable here (${e instanceof HostError ? e.message : (e as Error).message}), so I wrote the result as plain values instead.`);
    }
  }
  if (!made) {
    const outcome = await state.host!.writeResult(p.result, p.formats, p.liveCols);
    made = outcome.created;
    extra.push(...outcome.notes);
  }
  state.pending = null;
  const card = post("bot");
  card.classList.add("ok");
  card.textContent = made.length === 1
    ? made[0].rows < 0 ? `Done. I made the PivotTable on the sheet “${made[0].name}”.` : `Done. I made the sheet “${made[0].name}” with ${num(made[0].rows)} rows.`
    : `Done. I made ${made.length} sheets: ${made.slice(0, 6).map((m) => `${m.name} (${num(m.rows)})`).join(", ")}${made.length > 6 ? "…" : ""}.`;
  for (const note of extra) card.append(el("div", "muted", note));
  card.append(el("div", "muted", `Your table (${p.using}) is unchanged. The next command also works on that table.`));
  const actions = el("div", "actions");
  const undo = el("button", "", "Undo (remove the new sheets)");
  undo.type = "button";
  undo.addEventListener("click", () => guarded(async () => {
    undo.disabled = true;
    await state.host!.removeSheets(made!.map((m) => m.name));
    if (state.ref && made!.some((m) => m.name === state.ref!.sheet)) state.ref = undefined;
    post("bot", "Undone. The new sheets are removed.");
  }));
  actions.append(undo);
  if (made.length === 1 && made[0].rows >= 0) {
    const carry = el("button", "", "Continue from this result");
    carry.type = "button";
    carry.addEventListener("click", () => guarded(async () => {
      carry.disabled = true;
      state.ref = await state.host!.refOf(made![0].name);
      await readSource(state.ref);
      post("bot", `OK. The next commands work on “${made![0].name}”. Press “Use my table” to go back to your own table.`);
    }));
    actions.append(carry);
  }
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


// ---------- the menu builder ----------

async function openBuilder(): Promise<void> {
  const table = state.table ?? (await readSource(state.ref));
  const sheets = (await state.host!.listSheets()).filter((n) => n !== state.ref?.sheet);
  const card = post("bot", "Build it with menus. Choose what you want to do:");
  const picker = el("select");
  picker.setAttribute("aria-label", "What do you want to do?");
  for (const t of TEMPLATES) picker.append(new Option(t.title, t.id));
  const hint = el("div", "muted");
  const form = el("div", "builder");
  const values: Values = {};
  const actions = el("div", "actions");
  const go = el("button", "primary", "Preview");
  const cancel = el("button", "", "Close");
  go.type = cancel.type = "button";
  actions.append(go, cancel);
  card.append(picker, hint, form, actions);

  const current = (): Template => TEMPLATES.find((t) => t.id === picker.value)!;

  const control = (f: Field): HTMLElement => {
    const id = `b-${f.id}`;
    const wrap = el("div", "field");
    const label = el("label", "", f.label);
    label.htmlFor = id;
    let input: HTMLElement;
    const set = (v: string | string[]) => { values[f.id] = v; };
    if (f.type === "text") {
      const i = el("input"); i.type = "text"; i.placeholder = f.placeholder ?? ""; i.value = String(values[f.id] ?? "");
      i.addEventListener("input", () => { set(i.value); });
      i.addEventListener("change", render);
      input = i;
    } else {
      const sel = el("select");
      if (f.type === "columns") { sel.multiple = true; sel.size = Math.min(5, Math.max(3, table.columns.length)); }
      const options = f.type === "choice" ? f.choices ?? [] : f.type === "sheet" ? sheets : columnChoices(table, f).length ? columnChoices(table, f) : table.columns.map((c) => c.name);
      if (f.type !== "columns" && (f.optional || f.type !== "choice")) sel.append(new Option(f.optional ? "(none)" : "Choose…", ""));
      for (const o of options) sel.append(new Option(o, o));
      const have = values[f.id];
      for (const o of Array.from(sel.options)) o.selected = Array.isArray(have) ? have.includes(o.value) : o.value === have;
      if (f.type === "choice" && !f.optional && !have && options.length) { sel.value = options[0]; set(options[0]); }
      sel.addEventListener("change", () => { set(f.type === "columns" ? Array.from(sel.selectedOptions).map((o) => o.value) : sel.value); render(); });
      input = sel;
    }
    input.id = id;
    wrap.append(label, input);
    return wrap;
  };

  function render(): void {
    const t = current();
    hint.textContent = t.hint;
    form.replaceChildren(...visibleFields(t, values).map(control));
  }
  picker.addEventListener("change", () => { for (const k of Object.keys(values)) delete values[k]; render(); });
  cancel.addEventListener("click", () => card.remove());
  go.addEventListener("click", () => {
    const made = build(current(), values);
    if ("missing" in made) { post("err", `Please fill in: ${made.missing}`); return; }
    void guarded(() => preview(made.sentence));
  });
  render();
}

// ---------- start up ----------

function wire(): void {
  const live = $<HTMLInputElement>("live");
  try { live.checked = localStorage.getItem("sheet-assistant-live") === "1"; } catch { /* storage can be blocked: the default is fine */ }
  live.addEventListener("change", () => { try { localStorage.setItem("sheet-assistant-live", live.checked ? "1" : "0"); } catch { /* ignore */ } });
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
  $("open-builder").addEventListener("click", () => { if (!state.busy && state.host) void guarded(() => openBuilder()); });
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
