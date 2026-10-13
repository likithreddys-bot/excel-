/** The Excel Agent page: files on the left, the conversation in the middle, the sheets on the right. */
import { isReady, makeClient } from "../ai/client";
import { AiError, AiSettings, DEFAULT_MODEL, ModelClient } from "../ai/gemini";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, OllamaClient } from "../ai/ollama";
import { loadAiSettings, saveAiSettings } from "../ai/ui";
import { chartTable } from "../engine/format";
import type { ChartStep } from "../engine/plan";
import { Cell, Table } from "../engine/table";
import { isoDay } from "../engine/util";
import { drawChart } from "../web/chart";
import { buildXlsx } from "../web/xlsx-write";
import { PrivacyBlock, blockedValues, checkOutgoing } from "./guard";
import { Agent } from "./loop";
import { reportBlob } from "./report";
import { sampleFiles } from "./sample";
import { StepView, howLines } from "./tools";
import { startBrowserDuck } from "./duck";
import { ROLES, Role, Workspace } from "./workspace";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (n: number) => n.toLocaleString("en-IN");
const NOTES_KEY = "excel-agent-notes";
const GRID_ROWS = 300;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function loadNotes(): string[] {
  try { const raw = localStorage.getItem(NOTES_KEY); if (raw) return (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string"); } catch { /* ignore */ }
  return [];
}

const ws = new Workspace(startBrowserDuck);
const state = {
  settings: loadAiSettings(),
  notes: loadNotes(),
  busy: false,
  abort: null as AbortController | null,
  selected: null as string | null,
  /** The question waiting for an answer from the person, if any. */
  answer: null as ((text: string) => void) | null,
  /** Every request sent to the AI in this tab (kept in memory only), newest last. */
  sent: [] as { at: Date; body: Record<string, unknown> }[],
};

const SENT_VIEW = "\u0000sent";

const saveNotes = (): void => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes.slice(-50))); } catch { /* ignore */ } };
const ready = (): boolean => isReady(state.settings);

const ctx = {
  ws,
  get settings() { return state.settings; },
  get notes() { return state.notes; },
  saveNotes,
  ask: (question: string, options: string[]) => askPerson(question, options),
  status: (text: string) => setStatus(text),
};
/** The chosen AI's client, which remembers it when it had to switch to another model (a retired or missing one). */
function client(s: AiSettings): ModelClient {
  const c = makeClient(s);
  c.onModelChange = (model) => {
    if (s === state.settings) saveAiSettings(state.settings);
    const box = document.getElementById(s.provider === "ollama" ? "s-ollama-model" : "s-model") as HTMLInputElement | null;
    if (box) box.value = model;
  };
  // Guardrail: every request is checked for personal data and file values before it leaves; blocked ones are never sent.
  c.guard = (body) => checkOutgoing(body, blockedValues(ws));
  c.onSend = (body) => { state.sent.push({ at: new Date(), body }); if (state.sent.length > 40) state.sent.shift(); if (state.selected === SENT_VIEW) void renderViewer(); };
  c.onStatus = (message) => {
    setStatus(message);
    const dialog = document.getElementById("settings") as HTMLDialogElement | null;
    if (dialog?.open) $("s-status").textContent = message;
  };
  return c;
}
let agent = new Agent(client(state.settings), ctx, { step: showStep, status: setStatus });

// ---------- chat ----------

function post(kind: "user" | "agent" | "err", text = ""): HTMLDivElement {
  const m = el("div", `msg ${kind}`);
  if (text) m.append(el("p", "", text));
  $("thread").append(m);
  m.scrollIntoView({ block: "end", behavior: "smooth" });
  return m;
}

function setStatus(text: string): void {
  $("status-text").textContent = text;
  $("status").classList.toggle("hidden", !text);
  // "Reading your file: 45%…" moves the bar on that file's card.
  const pct = /(\d+)%/.exec(text);
  if (ws.reading) {
    const bar = document.querySelector<HTMLElement>(`.table[data-name="${CSS.escape(ws.reading)}"] .track`);
    if (bar) { bar.classList.add("reading"); (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${pct ? Number(pct[1]) / 100 : 0.05})`; }
  } else document.querySelectorAll<HTMLElement>(".track.reading").forEach((b) => { b.classList.remove("reading"); (b.firstElementChild as HTMLElement).style.transform = ""; });
}

const ICON: Record<StepView["kind"], string> = { look: "🔎", run: "▦", ask: "?", note: "✓", error: "!" };

function showStep(v: StepView): void {
  const box = el("details", `step step-${v.kind}`);
  const sum = el("summary");
  sum.append(el("span", "step-icon", ICON[v.kind]), el("span", "", v.title));
  box.append(sum);
  if (v.detail.length) {
    const ul = el("ul");
    for (const d of v.detail) ul.append(el("li", "", d));
    box.append(ul);
  } else box.classList.add("plain");
  if (v.sheet) {
    const open = el("button", "chip", `Open “${v.sheet}”`);
    open.type = "button";
    open.addEventListener("click", (ev) => { ev.preventDefault(); select(v.sheet!); });
    box.append(open);
    renderTables();
    select(v.sheet);
  }
  $("thread").append(box);
  box.scrollIntoView({ block: "end", behavior: "smooth" });
}

function askPerson(question: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    const card = post("agent", question);
    card.classList.add("question");
    const row = el("div", "row wrap");
    const finish = (text: string): void => {
      card.querySelectorAll("button, input").forEach((x) => ((x as HTMLButtonElement).disabled = true));
      state.answer = null;
      post("user", text);
      resolve(text);
    };
    for (const o of options) {
      const b = el("button", "primary", o);
      b.type = "button";
      b.addEventListener("click", () => finish(o));
      row.append(b);
    }
    card.append(row, el("p", "muted small", "Or type your own answer below."));
    state.answer = finish;
    $("input").focus();
  });
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  $<HTMLButtonElement>("send").textContent = busy ? "Answer" : "Send";
  $("stop").classList.toggle("hidden", !busy);
  $<HTMLButtonElement>("download-report").disabled = busy || ws.results().length === 0;
}

async function send(text: string): Promise<void> {
  if (state.answer) { state.answer(text); return; } // a reply to the agent's question
  if (state.busy) return;
  if (!ready()) { post("err", "Set up the AI first: add a Gemini API key, or choose a local model, in AI settings."); openSettings(); return; }
  if (!ws.tables.size) { post("err", "Add a file first (or press “Try sample data”)."); return; }
  post("user", text);
  setBusy(true);
  state.abort = new AbortController();
  try {
    const answer = await agent.run(text, state.abort.signal);
    const card = post("agent");
    for (const para of answer.message.split(/\n+/).filter((p) => p.trim())) card.append(el("p", "", para.replace(/^[-*•]\s*/, "• ")));
    if (answer.sheets.length) {
      const row = el("div", "row wrap");
      for (const s of answer.sheets) {
        const b = el("button", "chip", s);
        b.type = "button";
        b.addEventListener("click", () => select(s));
        row.append(b);
      }
      card.append(row);
      select(answer.sheets[0]);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") post("agent", "Stopped. The sheets made so far are kept.").classList.add("muted");
    else if (e instanceof PrivacyBlock) post("err", e.message).classList.add("blocked");
    else post("err", e instanceof AiError ? e.message : `Something went wrong: ${(e as Error).message ?? e}`);
  } finally {
    state.abort = null;
    state.answer = null;
    setBusy(false);
    renderTables();
  }
}

// ---------- files and sheets ----------

async function addFiles(list: File[]): Promise<void> {
  if (!list.length) return;
  document.body.classList.add("dropped");
  setTimeout(() => document.body.classList.remove("dropped"), 700);
  setStatus("Opening your files…");
  try {
    const { added, problems } = await ws.addFiles(list);
    for (const p of problems) post("err", p);
    if (added.length) {
      const card = post("agent", `Added ${added.length === 1 ? "“" + added[0] + "”" : added.length + " tables: " + added.join(", ")}. Check the type of each file on the left (I guessed it from the name), then ask away.`);
      card.classList.add("muted");
      renderTables();
      showScan(added);
    }
  } finally {
    setStatus("");
    renderTables();
  }
}

const SHEET_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M4 9h16M4 15h16M10 3v18" stroke="currentColor" stroke-width="1.8"/></svg>';
const RESULT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
/** Cards already shown, so only new ones animate in. */
const shown = new Set<string>();

function renderTables(): void {
  const list = $("table-list");
  list.replaceChildren();
  let fresh = 0;
  for (const e of ws.tables.values()) {
    const li = el("li", `table ${e.kind}${state.selected === e.name ? " selected" : ""}`);
    li.dataset.name = e.name;
    if (!shown.has(e.name)) { li.classList.add("enter"); li.style.setProperty("--i", String(fresh++)); shown.add(e.name); }
    const top = el("div", "t-top");
    const icon = el("span", "t-icon");
    icon.innerHTML = e.kind === "source" ? SHEET_ICON : RESULT_ICON;
    const names = el("div", "t-names");
    const open = el("button", "table-name", e.name);
    open.type = "button";
    open.addEventListener("click", () => select(e.name));
    const meta = el("div", "t-meta", e.kind === "source"
      ? `${e.approx ? "~" : ""}${num(e.rows)} rows · ${e.headers.length} cols`
      : `result · ${num(e.table.nrows)} rows · ${e.table.columns.length} cols`);
    names.append(open, meta);
    top.append(icon, names);
    if (e.kind === "source" && e.engine === "sql") { const b = el("span", "badge mono", "SQL"); b.title = "Large file: analysed by DuckDB straight from disk, every row"; top.append(b); }
    li.append(top);
    if (e.kind === "source") {
      const track = el("div", "track");
      track.append(el("i"));
      const role = el("select", "role");
      role.setAttribute("aria-label", `What is in ${e.name}`);
      for (const r of ROLES) { const o = el("option", "", r.label); o.value = r.value; o.selected = r.value === e.role; role.append(o); }
      role.addEventListener("change", () => { e.role = role.value as Role; });
      li.append(track, role);
    } else {
      const del = el("button", "ghost small", "Remove");
      del.type = "button";
      del.addEventListener("click", () => { ws.remove(e.name); shown.delete(e.name); if (state.selected === e.name) state.selected = null; renderTables(); renderViewer(); });
      li.append(del);
    }
    list.append(li);
  }
  for (const n of [...shown]) if (!ws.tables.has(n)) shown.delete(n);
  document.body.classList.toggle("empty", ws.tables.size === 0);
  $("file-count").textContent = ws.tables.size ? `${ws.sources().length} files · ${ws.results().length} results` : "";
  $<HTMLButtonElement>("download-report").disabled = state.busy || ws.results().length === 0;
  renderSuggestions();
}

/** A column's likely role from its name and kind, for the coloured dot. */
function roleColour(name: string): [string, string] {
  const n = name.toLowerCase();
  if (/(^|_)(id|uuid|no|number|ref)$|^id(_|$)|phone|mobile|pan|aadha|email|account/.test(n)) return ["var(--muted)", "id / personal (never sent)"];
  if (/date|_dt$|time|month|year|day/.test(n)) return ["var(--green)", "date"];
  if (/amt|amount|due|paid|bal|principal|emi|income|fee|value|total|interest|outstanding/.test(n)) return ["var(--cyan)", "amount"];
  return ["var(--violet)", "category / count"];
}

/** After files are added: a short "understanding" animation listing each file's columns by role. */
function showScan(names: string[]): void {
  state.selected = null;
  renderTables();
  const body = $("viewer-body");
  $("viewer-title").textContent = names.length === 1 ? `Understanding ${names[0]}` : `Understanding ${names.length} files`;
  $("viewer-tag").textContent = "SCANNING";
  $("download-sheet").classList.add("hidden");
  body.classList.remove("enter"); void body.offsetWidth; body.classList.add("enter");
  const scan = el("div", "scan");
  const beam = el("div", "beam");
  const rows = el("div", "rows");
  for (let i = 0; i < 6; i++) { const r = el("i"); r.style.width = `${40 + ((i * 37) % 55)}%`; rows.append(r); }
  beam.append(rows);
  scan.append(beam);
  let k = 0;
  for (const n of names) {
    const s = ws.get(n);
    if (!s || s.kind !== "source") continue;
    const h = el("h3");
    h.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    h.append(document.createTextNode(`${n} `), el("span", "mono muted small", `${s.headers.length} columns`));
    const chips = el("div", "chips");
    for (const c of s.headers.slice(0, 80)) {
      const [colour] = roleColour(c);
      const chip = el("span", "col-chip");
      chip.style.setProperty("--c", colour);
      chip.style.setProperty("--i", String(k++ % 40));
      chip.append(el("i"), document.createTextNode(c));
      chips.append(chip);
    }
    if (s.headers.length > 80) chips.append(el("span", "mono muted small", `+${s.headers.length - 80} more`));
    scan.append(h, chips);
  }
  const legend = el("div", "legend");
  for (const [c, label] of [["var(--cyan)", "amount"], ["var(--green)", "date"], ["var(--violet)", "category / count"], ["var(--muted)", "id / personal (never sent)"]]) {
    const sp = el("span"); const d = el("i"); d.style.setProperty("--c", c); sp.append(d, document.createTextNode(label)); legend.append(sp);
  }
  scan.append(legend, el("p", "muted small", "Colours are a first guess from the column names; the AI checks each column before using it. Now ask for what you need."));
  body.replaceChildren(scan);
  setTimeout(() => { if (!state.selected) $("viewer-tag").textContent = "READY"; }, 1800);
}

function renderSuggestions(): void {
  const box = $("suggestions");
  if (!ws.sources().length || ws.results().length) { box.classList.add("hidden"); return; }
  const roles = new Set(ws.sources().map((s) => s.role));
  const ideas = ["Give me an overview of these files: what each contains and how they link"];
  if (roles.has("repayments")) ideas.push("Repayment % of old vs new customers as a pivot table", "Monthly collection report by state with a chart");
  if (roles.has("policy")) ideas.push("Compare repayment under the old and new policy");
  if (roles.has("repayments")) ideas.push("Which states have the most loans more than 30 days past due?");
  box.replaceChildren(...ideas.map((t) => {
    const b = el("button", "chip", t);
    b.type = "button";
    b.addEventListener("click", () => { $<HTMLTextAreaElement>("input").value = t; $("input").focus(); });
    return b;
  }));
  box.classList.remove("hidden");
}

function select(name: string): void {
  const e = ws.get(name);
  if (!e) return;
  state.selected = e.name;
  renderTables();
  renderViewer();
}

function cellText(t: Table, j: number, i: number): string {
  const c = t.columns[j];
  const v: Cell = c.values[i];
  if (v === null || v === "") return "";
  if (c.kind === "date" && c.time?.[i] != null) return isoDay(c.time[i]!);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
}

function grid(t: Table, limit = GRID_ROWS): HTMLElement {
  const wrap = el("div", "grid");
  const table = el("table");
  const head = el("tr");
  for (const c of t.columns) head.append(el("th", c.kind === "number" ? "num" : "", c.name));
  table.append(head);
  for (let i = 0; i < Math.min(limit, t.nrows); i++) {
    const tr = el("tr");
    t.columns.forEach((c, j) => tr.append(el("td", c.kind === "number" ? "num" : "", cellText(t, j, i))));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

/** Exactly what left this computer, request by request: the transparency log. */
function renderSent(body: HTMLElement): void {
  $("viewer-title").textContent = "What was sent to the AI";
  $("viewer-tag").textContent = `${state.sent.length} REQUESTS`;
  $("download-sheet").classList.add("hidden");
  body.replaceChildren(el("p", "small", "Every request this tab sent to Gemini, newest first. Your rows never appear here: only your questions, column facts and what the privacy settings allow. This list is kept in memory and cleared when you close the tab."));
  if (!state.sent.length) { body.append(el("p", "muted", "Nothing has been sent yet.")); return; }
  for (const { at, body: req } of [...state.sent].reverse()) {
    const box = el("details", "sent");
    box.append(el("summary", "", `${at.toLocaleTimeString()} · ${JSON.stringify(req).length.toLocaleString("en-IN")} characters`));
    const pre = el("pre", "small");
    pre.textContent = JSON.stringify(req, null, 2);
    box.append(pre);
    body.append(box);
  }
}

/** Small results with a percentage column become tiles with a meter (New 71.48%, Old 89.79%...). */
function kpis(t: Table): HTMLElement | null {
  if (t.nrows < 1 || t.nrows > 6 || t.columns.length < 2) return null;
  const label = t.columns[0];
  const pct = [...t.columns].reverse().find((c) => c.kind === "number" && /%|percent|pct|rate|ratio/i.test(c.name));
  if (!pct || label.kind === "number") return null;
  const colours = ["var(--cyan)", "var(--green)", "var(--violet)", "var(--warn)", "var(--cyan)", "var(--green)"];
  const box = el("div", "kpis");
  for (let i = 0; i < t.nrows; i++) {
    const v = pct.values[i];
    if (typeof v !== "number") continue;
    const tile = el("div", "kpi");
    tile.style.setProperty("--c", /total/i.test(String(label.values[i])) ? "var(--violet)" : colours[i]);
    tile.style.setProperty("--i", String(i));
    const val = el("div", "v", "0");
    const track = el("div", "track"); const fillBar = el("i"); fillBar.style.width = `${Math.max(0, Math.min(100, v))}%`; track.append(fillBar);
    tile.append(el("div", "k", `${String(label.values[i] ?? "")} · ${pct.name}`), val, track);
    box.append(tile);
    countUp(val, v, /%|percent|pct/i.test(pct.name) ? "%" : "");
  }
  return box.children.length ? box : null;
}

function countUp(node: HTMLElement, to: number, suffix: string): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (x: number) => `${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
  if (reduce) { node.textContent = fmt(to); return; }
  const start = performance.now();
  const tick = (now: number): void => {
    const k = Math.min(1, (now - start) / 700);
    node.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function renderViewer(): Promise<void> {
  const body = $("viewer-body");
  if (state.selected === SENT_VIEW) { renderSent(body); return; }
  const e = state.selected ? ws.get(state.selected) : undefined;
  $("download-sheet").classList.toggle("hidden", !e || e.kind !== "result");
  if (!e) { $("viewer-title").textContent = "Sheets"; $("viewer-tag").textContent = ""; body.replaceChildren(el("p", "muted", "Results appear here as sheets.")); return; }
  $("viewer-title").textContent = e.name;
  $("viewer-tag").textContent = e.kind === "result" ? `${e.plan.steps.some((x) => x.op === "pivot") ? "PIVOT" : "RESULT"} · ${num(e.table.nrows)} ROWS` : "SOURCE";
  body.replaceChildren();
  body.classList.remove("enter"); void body.offsetWidth; body.classList.add("enter");
  if (e.kind === "result") {
    if (e.purpose) body.append(el("p", "purpose", e.purpose));
    const tiles = kpis(e.table);
    if (tiles) body.append(tiles);
    for (const f of e.formats) {
      if (f.op !== "chart") continue;
      try { body.append(drawChart(chartTable(e.table, f as ChartStep), f as ChartStep)); } catch { /* a chart that doesn't fit the final table is skipped */ }
    }
    body.append(grid(e.table));
    if (e.table.nrows > GRID_ROWS) body.append(el("p", "muted small", `Showing ${GRID_ROWS} of ${num(e.table.nrows)} rows. Download to see all.`));
    const how = el("details", "how");
    how.append(el("summary", "", "How this was calculated"));
    how.append(el("p", "small", `Made from “${e.from}”, using every row:`));
    const ol = el("ol", "small");
    for (const l of howLines(e)) ol.append(el("li", "", l));
    how.append(ol);
    if (e.notes.length) { const ul = el("ul", "small muted"); for (const n of e.notes) ul.append(el("li", "", n)); how.append(ul); }
    body.append(how);
    return;
  }
  body.append(el("p", "muted small", `${e.file}${e.sheet !== e.name ? ` · sheet ${e.sheet}` : ""} · ${e.approx ? "about " : ""}${num(e.rows)} rows · ${e.headers.length} columns`));
  if (e.loaded && e.loaded.columns.length === e.headers.length) { body.append(grid(e.loaded, 100)); return; }
  const fits = e.rows >= 0 && e.rows * e.headers.length <= 8_000_000;
  if (fits) {
    const b = el("button", "", "Show the first rows");
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      setStatus("Reading the file…");
      try { await ws.ensure(e.name, "all"); renderTables(); await renderViewer(); } catch (err) { post("err", (err as Error).message); } finally { setStatus(""); }
    });
    body.append(b);
  } else body.append(el("p", "muted small", "This file is large: I read only the columns each question needs."));
  const chips = el("div", "chips");
  for (const h of e.headers.slice(0, 400)) chips.append(el("span", "chip static", h));
  body.append(el("p", "small", "Columns:"), chips);
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- settings ----------

/** Show the fields of the chosen provider. */
function showProvider(): void {
  const local = $<HTMLInputElement>("s-provider-ollama").checked;
  $("s-gemini").classList.toggle("hidden", local);
  $("s-ollama").classList.toggle("hidden", !local);
  $("s-local-note").classList.toggle("hidden", !local);
  $("s-cloud-note").classList.toggle("hidden", local);
}

function openSettings(): void {
  const s = state.settings;
  $<HTMLInputElement>(s.provider === "ollama" ? "s-provider-ollama" : "s-provider-gemini").checked = true;
  $<HTMLInputElement>("s-ollama-url").value = s.ollamaUrl ?? "";
  $<HTMLInputElement>("s-ollama-url").placeholder = DEFAULT_OLLAMA_URL;
  $<HTMLInputElement>("s-ollama-model").value = s.ollamaModel ?? "";
  $<HTMLInputElement>("s-ollama-model").placeholder = DEFAULT_OLLAMA_MODEL;
  document.querySelectorAll("#settings .origin").forEach((e) => (e.textContent = location.origin));
  showProvider();
  $<HTMLInputElement>("s-key").value = s.apiKey;
  $<HTMLInputElement>("s-model").placeholder = DEFAULT_MODEL;
  $<HTMLInputElement>("s-model").value = s.model;
  $<HTMLInputElement>("s-share").checked = s.shareValues;
  $<HTMLInputElement>("s-results").checked = s.readResults;
  $("s-status").textContent = "";
  const d = $<HTMLDialogElement>("settings");
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
}

function formSettings(): AiSettings {
  return {
    ...state.settings,
    enabled: true,
    provider: $<HTMLInputElement>("s-provider-ollama").checked ? "ollama" : "gemini",
    ollamaUrl: $<HTMLInputElement>("s-ollama-url").value.trim() || DEFAULT_OLLAMA_URL,
    ollamaModel: $<HTMLInputElement>("s-ollama-model").value.trim() || DEFAULT_OLLAMA_MODEL,
    apiKey: $<HTMLInputElement>("s-key").value.trim(),
    model: $<HTMLInputElement>("s-model").value.trim() || DEFAULT_MODEL,
    shareValues: $<HTMLInputElement>("s-share").checked,
    readResults: $<HTMLInputElement>("s-results").checked,
  };
}

function applySettings(s: AiSettings): void {
  state.settings = s;
  saveAiSettings(s);
  agent = new Agent(client(s), ctx, { step: showStep, status: setStatus });
  $("setup").classList.toggle("hidden", ready());
  $("open-settings").textContent = ready() ? "AI settings" : "AI settings (not set up)";
  $("model-status").classList.toggle("on", ready());
  $("model-label").textContent = !ready() ? "AI not set up" : s.provider === "ollama" ? `${s.ollamaModel || DEFAULT_OLLAMA_MODEL} · local` : `${s.model || DEFAULT_MODEL} · Gemini`;
}

// ---------- start ----------

function wire(): void {
  const input = $<HTMLInputElement>("file-input");
  $("add-files").addEventListener("click", (ev) => { ev.stopPropagation(); input.click(); });
  $("drop").addEventListener("click", () => input.click());
  $("drop").addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") input.click(); });
  input.addEventListener("change", () => { const files = [...(input.files ?? [])]; input.value = ""; void addFiles(files); });
  $("try-sample").addEventListener("click", (ev) => { ev.stopPropagation(); void addFiles(sampleFiles()); });
  $("hero-browse").addEventListener("click", (ev) => { ev.stopPropagation(); input.click(); });
  $("hero-sample").addEventListener("click", (ev) => { ev.stopPropagation(); void addFiles(sampleFiles()); });
  $("hero-drop").addEventListener("click", () => input.click());
  $("hero-drop").addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") input.click(); });
  $("model-status").addEventListener("click", openSettings);
  document.addEventListener("dragover", (ev) => { ev.preventDefault(); document.body.classList.add("dragging"); });
  document.addEventListener("dragleave", (ev) => { if (!(ev as DragEvent).relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", (ev) => { ev.preventDefault(); document.body.classList.remove("dragging"); void addFiles([...((ev as DragEvent).dataTransfer?.files ?? [])]); });

  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const box = $<HTMLTextAreaElement>("input");
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    void send(text);
  });
  $("input").addEventListener("keydown", (ev) => {
    const k = ev as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); $<HTMLFormElement>("ask").requestSubmit(); }
  });
  $("stop").addEventListener("click", () => state.abort?.abort());
  $("new-chat").addEventListener("click", () => {
    if (state.busy) return;
    agent.reset();
    $("thread").replaceChildren();
    post("agent", "New conversation. Your files and result sheets are still here.").classList.add("muted");
  });
  $("download-report").addEventListener("click", async () => {
    setStatus("Building the report…");
    try { download(await reportBlob(ws), "Excel Agent report.xlsx"); } finally { setStatus(""); }
  });
  $("download-sheet").addEventListener("click", async () => {
    const e = state.selected ? ws.get(state.selected) : undefined;
    if (!e || e.kind !== "result") return;
    download(await buildXlsx(new Map([[e.name, e.table]]), e.formats), `${e.name}.xlsx`);
  });
  $("show-sent").addEventListener("click", () => { state.selected = SENT_VIEW; renderTables(); void renderViewer(); });
  $("forget-notes").addEventListener("click", () => {
    state.notes.splice(0, state.notes.length);
    saveNotes();
    post("agent", "Forgot the saved definitions. I'll ask again when one is needed.").classList.add("muted");
  });

  for (const id of ["s-provider-gemini", "s-provider-ollama"]) $(id).addEventListener("change", () => {
    showProvider();
    // A local model keeps everything on this computer, so the richer (safe) sharing is turned on for better answers.
    if ($<HTMLInputElement>("s-provider-ollama").checked) { $<HTMLInputElement>("s-share").checked = true; $<HTMLInputElement>("s-results").checked = true; }
  });
  $("open-settings").addEventListener("click", openSettings);
  $("setup-open").addEventListener("click", openSettings);
  $("s-save").addEventListener("click", () => {
    const s = formSettings();
    if (s.provider !== "ollama" && !s.apiKey) { $("s-status").textContent = "Paste your Gemini API key first, or choose a local model."; return; }
    applySettings(s);
    $<HTMLDialogElement>("settings").close();
  });
  $("s-test").addEventListener("click", async () => {
    $("s-status").textContent = "Testing…";
    try {
      const s = formSettings();
      if (s.provider === "ollama") {
        const local = new OllamaClient(s);
        const installed = await local.listModels();
        const list = $("s-ollama-models");
        list.replaceChildren(...installed.map((n) => { const o = el("option"); o.value = n; return o; }));
        if (!installed.length) { $("s-status").textContent = `Ollama is running, but no model is installed. In a terminal run: ollama pull ${DEFAULT_OLLAMA_MODEL}`; return; }
        const asked = s.ollamaModel;
        const c = client(s);
        await c.ask("Reply with the JSON object {\"ok\":true}.", "ping");
        $("s-status").textContent = s.ollamaModel === asked ? `The local model works (${s.ollamaModel}). Nothing leaves this computer.` : `“${asked}” isn't installed, so I'll use ${s.ollamaModel}. Press Save to keep it.`;
        return;
      }
      const asked = s.model;
      await client(s).ask("Reply with the JSON object {\"ok\":true}.", "ping");
      $("s-status").textContent = s.model === asked ? `The key works (model ${s.model}).` : `The key works. “${asked}” isn't available, so I'll use ${s.model}. Press Save to keep it.`;
    } catch (e) {
      $("s-status").textContent = e instanceof AiError ? e.message : "The test failed.";
    }
  });
  $("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("sheet-assistant-theme", root.dataset.theme); } catch { /* ignore */ }
  });
}

ws.progress = setStatus;
wire();
applySettings(state.settings);
renderTables();

