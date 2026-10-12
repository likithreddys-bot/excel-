/** The Excel Agent page: files on the left, the conversation in the middle, the sheets on the right. */
import { AiError, AiSettings, DEFAULT_MODEL, GeminiClient } from "../ai/gemini";
import { loadAiSettings, saveAiSettings } from "../ai/ui";
import { chartTable } from "../engine/format";
import type { ChartStep } from "../engine/plan";
import { Cell, Table } from "../engine/table";
import { isoDay } from "../engine/util";
import { drawChart } from "../web/chart";
import { buildXlsx } from "../web/xlsx-write";
import { Agent } from "./loop";
import { reportBlob } from "./report";
import { sampleFiles } from "./sample";
import { StepView, planLines } from "./tools";
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

const ws = new Workspace();
const state = {
  settings: loadAiSettings(),
  notes: loadNotes(),
  busy: false,
  abort: null as AbortController | null,
  selected: null as string | null,
  /** The question waiting for an answer from the person, if any. */
  answer: null as ((text: string) => void) | null,
};

const saveNotes = (): void => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes.slice(-50))); } catch { /* ignore */ } };
const ready = (): boolean => state.settings.apiKey.trim() !== "";

const ctx = {
  ws,
  get settings() { return state.settings; },
  get notes() { return state.notes; },
  saveNotes,
  ask: (question: string, options: string[]) => askPerson(question, options),
};
/** A Gemini client that remembers it when it had to switch to another model (a retired one, for example). */
function client(s: AiSettings): GeminiClient {
  const c = new GeminiClient(s);
  c.onModelChange = (model) => {
    if (s === state.settings) saveAiSettings(state.settings);
    const box = document.getElementById("s-model") as HTMLInputElement | null;
    if (box) box.value = model;
  };
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
  if (!ready()) { post("err", "Add your Gemini API key in AI settings first."); openSettings(); return; }
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
  setStatus("Opening your files…");
  try {
    const { added, problems } = await ws.addFiles(list);
    for (const p of problems) post("err", p);
    if (added.length) {
      const card = post("agent", `Added ${added.length === 1 ? "“" + added[0] + "”" : added.length + " tables: " + added.join(", ")}. Check the type of each file on the left (I guessed it from the name), then ask away.`);
      card.classList.add("muted");
      select(added[0]);
    }
  } finally {
    setStatus("");
    renderTables();
  }
}

function renderTables(): void {
  const list = $("table-list");
  list.replaceChildren();
  for (const e of ws.tables.values()) {
    const li = el("li", `table ${e.kind}${state.selected === e.name ? " selected" : ""}`);
    const open = el("button", "table-name", e.name);
    open.type = "button";
    open.addEventListener("click", () => select(e.name));
    const meta = el("div", "muted small", e.kind === "source"
      ? `${e.approx ? "about " : ""}${num(e.rows)} rows · ${e.headers.length} columns`
      : `result · ${num(e.table.nrows)} rows · ${e.table.columns.length} columns`);
    li.append(open, meta);
    if (e.kind === "source") {
      const role = el("select", "role");
      role.setAttribute("aria-label", `What is in ${e.name}`);
      for (const r of ROLES) { const o = el("option", "", r.label); o.value = r.value; o.selected = r.value === e.role; role.append(o); }
      role.addEventListener("change", () => { e.role = role.value as Role; });
      li.append(role);
    } else {
      const del = el("button", "ghost small", "Remove");
      del.type = "button";
      del.addEventListener("click", () => { ws.remove(e.name); if (state.selected === e.name) state.selected = null; renderTables(); renderViewer(); });
      li.append(del);
    }
    list.append(li);
  }
  $("drop").classList.toggle("compact", ws.tables.size > 0);
  $<HTMLButtonElement>("download-report").disabled = state.busy || ws.results().length === 0;
  renderSuggestions();
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
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
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

async function renderViewer(): Promise<void> {
  const body = $("viewer-body");
  const e = state.selected ? ws.get(state.selected) : undefined;
  $("download-sheet").classList.toggle("hidden", !e || e.kind !== "result");
  if (!e) { $("viewer-title").textContent = "Sheets"; body.replaceChildren(el("p", "muted", "Results appear here as sheets.")); return; }
  $("viewer-title").textContent = e.name;
  body.replaceChildren();
  if (e.kind === "result") {
    if (e.purpose) body.append(el("p", "purpose", e.purpose));
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
    for (const l of planLines(e.plan)) ol.append(el("li", "", l));
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

function openSettings(): void {
  const s = state.settings;
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
}

// ---------- start ----------

function wire(): void {
  const input = $<HTMLInputElement>("file-input");
  $("add-files").addEventListener("click", (ev) => { ev.stopPropagation(); input.click(); });
  $("drop").addEventListener("click", () => input.click());
  $("drop").addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") input.click(); });
  input.addEventListener("change", () => { const files = [...(input.files ?? [])]; input.value = ""; void addFiles(files); });
  $("try-sample").addEventListener("click", (ev) => { ev.stopPropagation(); void addFiles(sampleFiles()); });
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
  $("forget-notes").addEventListener("click", () => {
    state.notes.splice(0, state.notes.length);
    saveNotes();
    post("agent", "Forgot the saved definitions. I'll ask again when one is needed.").classList.add("muted");
  });

  $("open-settings").addEventListener("click", openSettings);
  $("setup-open").addEventListener("click", openSettings);
  $("s-save").addEventListener("click", () => {
    const s = formSettings();
    if (!s.apiKey) { $("s-status").textContent = "Paste your Gemini API key first."; return; }
    applySettings(s);
    $<HTMLDialogElement>("settings").close();
  });
  $("s-test").addEventListener("click", async () => {
    $("s-status").textContent = "Testing…";
    try {
      const s = formSettings();
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

wire();
applySettings(state.settings);
renderTables();

