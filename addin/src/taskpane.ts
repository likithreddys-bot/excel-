import { describe as describeStep } from "./engine/describe";
import { applyPlan, PlanError, rowCounts } from "./engine/engine";
import { FormatStep, chartTable, highlightMask, isFormatStep, liveFormats } from "./engine/format";
import { Parser, makePlan, replyColumns } from "./engine/parser";
import { LiveColumn, PivotSpec, liveColumns, livePivot } from "./engine/live";
import { profile } from "./engine/profile";
import type { Plan } from "./engine/plan";
import { Cell, Sheets, Table, combine } from "./engine/table";
import { sheetNameFor } from "./engine/naming";
import { isoDay, key, singular } from "./engine/util";
import { DemoHost } from "./excel/demo";
import { ExcelHost, progress } from "./excel/io";
import { Cancelled, Host, HostError, MAX_CELLS, Notice, SourceRef, TooWideError } from "./host";
import { autoColumns } from "./columns";
import { suggestPercentages } from "./suggest";
import type { WebHooks } from "./web/ui";
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
  /** Commands typed so far, for the up/down arrows. */
  history: [] as string[],
  /** Wide tables: the columns being read (undefined = all of them), and every header in the file. */
  columns: undefined as string[] | undefined,
  headers: [] as string[],
  /** The user's own table (as opposed to a result sheet they continued from): where the picked columns apply. */
  sourceRef: undefined as SourceRef | undefined,
  /** A table too big to read whole: its headers and size. Columns are then read as each sentence needs them. */
  wide: null as { headers: string[]; rows: number; approx: boolean } | null,
  /** Set on the website: file picking, downloads and charts on the page. */
  web: null as WebHooks | null,
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

function setStatus(text: string): void {
  const box = $("status");
  box.textContent = text;
  box.classList.toggle("hidden", !text);
  state.web?.status(text);
}

function setBusy(busy: boolean): void {
  if (!busy) setStatus("");
  state.busy = busy;
  $<HTMLButtonElement>("send").disabled = busy || !state.host;
  $<HTMLButtonElement>("send").textContent = busy ? "Working…" : "Preview";
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
  const note = document.getElementById("columns-note");
  if (note) {
    const partial = state.headers.length > t.columns.length;
    note.classList.toggle("hidden", !partial);
    if (partial) $("columns-note-text").textContent = `Read ${t.columns.length} of ${state.headers.length} columns so far. Ask about another column and I'll read it too.`;
  }
  const mixed = t.columns.filter((c) => c.mixedDates).map((c) => c.name);
  $("source-warning").textContent = mixed.length
    ? `Heads up: in ${mixed.join(", ")}, some dates are real Excel dates and some are plain text. I read both, but check them: Excel may have swapped day and month when they were typed or pasted.`
    : "";
  $("source-warning").classList.toggle("hidden", mixed.length === 0);
  showFindings(t);
  showExamples(t);
  state.web?.sourceShown(t);
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

/** Is `ref` a result sheet the user continued from, rather than their own table? */
const isResultRef = (ref?: SourceRef): boolean => !!ref && !!state.sourceRef && ref.sheet !== state.sourceRef.sheet;

async function readSource(ref?: SourceRef, fresh = false, hint?: string): Promise<Table> {
  const result = isResultRef(ref);
  let columns = result ? undefined : state.columns;
  // A wide table: read the columns this sentence needs (plus those already loaded) instead of asking the user to pick.
  if (!result && state.wide && hint !== undefined) columns = state.columns = autoColumns(state.wide.headers, state.wide.rows, hint, state.columns ?? []);
  let src;
  try {
    src = await state.host!.readSource(ref, fresh, columns);
  } catch (e) {
    if (!(e instanceof TooWideError)) throw e;
    state.wide = { headers: e.headers, rows: e.rows, approx: e.approx };
    state.headers = e.headers;
    state.ref = state.sourceRef = e.ref ?? ref;
    showWide();
    const cols = hint ? autoColumns(e.headers, e.rows, hint, state.columns ?? []) : [];
    if (!cols.length) {
      throw new Notice(`This file has ${e.approx ? "about " : ""}${num(e.rows)} rows and ${e.headers.length} columns, too many to load all at once. `
        + (hint ? "I couldn't tell which columns you mean: name them (click a column name above to add it to your sentence)." : "Just type your question and I'll read the columns it needs."));
    }
    state.columns = cols;
    src = await state.host!.readSource(state.ref, true, cols);
  }
  if (!result && !columns) state.wide = null; // it was read whole after all
  state.ref = src.ref;
  state.label = src.label;
  state.table = src.table;
  state.headers = src.headers;
  if (!result) state.sourceRef = src.ref; // remembered, so Undo / "go back" returns to the same table and the same columns
  showSource(src.label, src.table);
  return src.table;
}

/** What the source card says about a table that has not been loaded (yet): its size and its column names. */
function showWide(): void {
  const w = state.wide!;
  $("source-text").textContent = `${state.sourceRef?.sheet ?? "Your table"} · ${w.approx ? "about " : ""}${num(w.rows)} rows · ${w.headers.length} columns. I read the columns each question needs.`;
  $("source-text").classList.remove("muted");
  $("columns").replaceChildren(...w.headers.map((h) => el("span", "chip", h)));
  $("columns-box").classList.remove("hidden");
  $("source-warning").classList.add("hidden");
  $("findings").classList.add("hidden");
  $("examples-box").classList.add("hidden");
  state.web?.sourceShown(null);
}

const spaced = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

const SKIP_WORDS = new Set(["show", "me", "the", "wise", "of", "on", "in", "by", "per", "for", "each", "and", "or", "all", "get", "give", "what", "is", "are", "to", "a", "an", "with", "where", "rows", "row", "percentage", "percent", "total", "how", "many"]);

/** When only some columns were read: file columns that share a word with the sentence, best matches first. */
function unreadColumnsFor(text: string): string[] {
  if (!state.table || state.headers.length <= state.table.columns.length) return [];
  const have = new Set(state.table.columns.map((c) => c.name.toLowerCase()));
  const words = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !SKIP_WORDS.has(w)))];
  return state.headers
    .filter((h) => !have.has(h.toLowerCase()))
    .map((h) => ({ h, score: words.filter((w) => h.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.h);
}

/** A card with a searchable list of the file's columns; resolves with the ones the user ticks. */
function pickColumns(headers: string[], rows: number, message: string, chosen: string[] = [], approx = false): Promise<string[]> {
  return new Promise((resolve) => {
    const card = post("bot", message);
    card.append(el("div", "muted", "Tick every column you might need: a column added later means reading the file again."));
    const search = el("input");
    search.type = "search";
    search.placeholder = "Search the columns…";
    search.setAttribute("aria-label", "Search the columns");
    const list = el("div", "picker");
    const count = el("div", "muted");
    const go = el("button", "primary", "Read these columns");
    go.type = "button";
    const have = new Set(chosen.map((c) => c.toLowerCase()));
    const rowsText = rows >= 0 ? (approx ? "about " : "") + num(rows) : "many";
    const boxes = headers.map((h) => {
      const row = el("label", "pick");
      const input = el("input");
      input.type = "checkbox";
      input.checked = have.has(h.toLowerCase());
      row.append(input, document.createTextNode(" " + h));
      list.append(row);
      return { row, input, name: h };
    });
    const update = () => {
      const n = boxes.filter((b) => b.input.checked).length;
      const tooMany = rows > 0 && n * rows > MAX_CELLS;
      count.textContent = `${n} column${n === 1 ? "" : "s"} picked × ${rowsText} rows` + (tooMany ? ". That is too many cells: pick fewer columns." : "");
      go.disabled = n === 0 || tooMany;
    };
    for (const b of boxes) b.input.addEventListener("change", update);
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const b of boxes) b.row.classList.toggle("hidden", !!q && !b.name.toLowerCase().includes(q));
    });
    go.addEventListener("click", () => {
      const names = boxes.filter((b) => b.input.checked).map((b) => b.name);
      go.disabled = true;
      search.disabled = true;
      list.classList.add("hidden");
      count.textContent = `Reading: ${names.join(", ")}`;
      resolve(names);
    });
    const actions = el("div", "actions");
    actions.append(go);
    card.append(search, list, count, actions);
    update();
  });
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

const isLive = (): boolean => document.getElementById("live") instanceof HTMLInputElement && $<HTMLInputElement>("live").checked;

function clearChat(): void {
  $("thread").replaceChildren();
  state.pending = null;
  state.asked = null;
}

async function preview(text: string): Promise<void> {
  if (/^\s*(?:please\s+)?(?:clear|reset|clean)\s+(?:the\s+|this\s+|my\s+)?(?:chat|conversation|messages?|screen|history)\s*\.?\s*$/i.test(text)) { clearChat(); return; }
  post("user", text);
  const had = new Set(state.table?.columns.map((c) => c.name));
  const table = await readSource(state.ref, false, text);
  const added = table.columns.map((c) => c.name).filter((n) => !had.has(n));
  if (state.wide && added.length && had.size) post("bot", `I also read ${added.slice(0, 12).join(", ")}${added.length > 12 ? `, and ${added.length - 12} more` : ""}.`).classList.add("muted");
  await answer(text, table, false);
}

/** Plan `text` on `table` and show the preview. `reading` (1, 2, 3) marks one of several guesses offered for an unclear sentence. */
async function answer(text: string, table: Table, quiet: boolean, reading = 0): Promise<void> {
  const sheets: Sheets = new Map([["Result", table]]);

  // A reply that is only column names answers the "which column?" question asked just before.
  const reply = state.asked ? replyColumns(sheets, text) : null;
  if (reply && reply[1].length) {
    if (!quiet) post("bot", "I couldn't find " + reply[1].join(", ") + ". Reply again with the column names.");
    return;
  }
  const problems: string[] = [];
  const files = await sheetsMentioned(reply ? state.asked! : text, problems);
  const plan = reply ? makePlan(sheets, state.asked!, reply[0], {}, files) : makePlan(sheets, text, [], {}, files);
  if (plan.clarification_question) {
    if (quiet) return;
    state.pending = null;
    state.asked = plan.awaits_columns ? (reply ? state.asked : text) : null;
    const card = post("bot", problems.length ? problems.join("\n") : plan.clarification_question);
    const maybe = unreadColumnsFor(text);
    if (maybe.length) card.append(el("div", "note", `Columns in your file that might be what you mean (not read yet): ${maybe.join(", ")}. Press “Change columns…”, tick them, and ask again.`));
    // A percentage that could mean several things: show the likely readings, with their results, instead of only asking.
    const readings = /won't guess/.test(plan.clarification_question) ? suggestPercentages(table, text) : [];
    if (readings.length) {
      post("bot", "Here are the most likely readings, with results. Pick the one you meant:");
      for (const [i, r] of readings.entries()) await answer(r, table, true, i + 1);
    }
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
    if (result.size === 1) result = new Map([[sheetNameFor(plan), result.values().next().value as Table]]);
  } catch (e) {
    state.pending = null;
    if (e instanceof PlanError) { post("err", `This can't run on your data: ${e.message}`); return; }
    throw e;
  }
  const p: Pending = { text, plan, result, before: table.nrows, using: state.label, notes: [...new Set(notes)], formats: plan.steps.filter(isFormatStep),
    ...liveOptions(plan, table, result), source: state.ref! };
  state.pending = p;
  renderPreview(p, reading ? `Reading ${reading}: “${text}”` : undefined);
  if (!quiet && !reading) offerAlternatives(text, table, plan);
}

/** After a percentage answer: other ways the same words could be read, as links that run them. */
function offerAlternatives(text: string, table: Table, plan: Plan): void {
  if (!/%|percent|repay|repaid|paid/i.test(text)) return;
  const used = plan.steps.flatMap((s) => (s.op === "group_by" ? Object.keys(s.calculated) : s.op === "rate" ? ["rate"] : []));
  if (!used.length) return;
  const group = plan.steps.flatMap((s) => (s.op === "group_by" || s.op === "rate" ? s.columns : []))[0];
  const others = suggestPercentages(table, text, group).filter((sentence) => !used.some((u) => u !== "rate" && sentence.startsWith(u.replace(" % of ", " as percentage of "))));
  if (!others.length) return;
  const box = el("div", "alts");
  box.append(el("span", "muted", "Meant something else? "));
  for (const sentence of others.slice(0, 3)) {
    const b = el("button", "chip", sentence);
    b.type = "button";
    b.addEventListener("click", () => { if (!state.busy) void guarded(() => preview(sentence)); });
    box.append(b);
  }
  $("thread").append(box);
  box.scrollIntoView({ block: "end", behavior: "smooth" });
}

function renderPreview(p: Pending, title = "Here's what I'll do:"): void {
  const card = post("bot", title);
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
  if (first.nrows) card.append(miniTable(first, first.nrows <= 50 ? first.nrows : 10, paint), el("div", "muted", first.nrows <= 50 ? (names.length > 1 ? `“${names[0]}”` : "The result") : names.length > 1 ? `First rows of “${names[0]}”` : "First rows of the result"));
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
  cancel.addEventListener("click", () => { lock(); if (state.pending === p) state.pending = null; post("bot", "Cancelled. Nothing was changed."); });
  run.addEventListener("click", () => { lock(); state.pending = p; void guarded(() => execute(p)); });
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
    if (state.ref && made!.some((m) => m.name === state.ref!.sheet)) state.ref = state.sourceRef;
    state.web?.sheetsChanged();
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
  state.web?.afterRun(made, p, card, actions);
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    if (e instanceof Notice || e instanceof Cancelled) post("bot", e.message);
    else post("err", e instanceof HostError ? e.message : `Something went wrong: ${(e as Error).message ?? e}`);
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
  const live = document.getElementById("live") as HTMLInputElement | null;
  if (live) {
    try { live.checked = localStorage.getItem("sheet-assistant-live") === "1"; } catch { /* storage can be blocked: the default is fine */ }
    live.addEventListener("change", () => { try { localStorage.setItem("sheet-assistant-live", live.checked ? "1" : "0"); } catch { /* ignore */ } });
  }
  document.getElementById("clear-chat")?.addEventListener("click", clearChat);
  document.getElementById("change-columns")?.addEventListener("click", () => {
    if (state.busy || !state.host) return;
    void guarded(async () => {
      state.columns = await pickColumns(state.headers, state.table?.nrows ?? -1, "Choose the columns I should read:", state.columns ?? state.table?.columns.map((c) => c.name) ?? []);
      await readSource(state.ref, true);
    });
  });
  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const box = $<HTMLTextAreaElement>("input");
    const text = box.value.trim();
    if (!text || state.busy) return;
    box.value = "";
    if (state.history[state.history.length - 1] !== text) state.history.push(text);
    browsing = -1;
    void guarded(() => preview(text));
  });
  // Up/down arrows walk back through earlier commands, like a terminal.
  let browsing = -1;
  $("input").addEventListener("keydown", (ev) => {
    const k = ev as KeyboardEvent;
    const box = $<HTMLTextAreaElement>("input");
    if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); $<HTMLFormElement>("ask").requestSubmit(); return; }
    if ((k.key === "ArrowUp" || k.key === "ArrowDown") && state.history.length && (box.value === "" || browsing >= 0)) {
      k.preventDefault();
      browsing = k.key === "ArrowUp" ? (browsing < 0 ? state.history.length - 1 : Math.max(0, browsing - 1)) : browsing + 1;
      if (browsing >= state.history.length) { browsing = -1; box.value = ""; } else box.value = state.history[browsing];
    }
  });
  $("open-builder").addEventListener("click", () => { if (!state.busy && state.host) void guarded(() => openBuilder()); });
  document.getElementById("use-selection")?.addEventListener("click", () => void guarded(async () => {
    state.ref = undefined;
    state.asked = null;
    state.columns = undefined;
    state.sourceRef = undefined;
    state.wide = null;
    await readSource(undefined, true);
  }));
}

async function start(): Promise<void> {
  wire();
  progress.report = setStatus;
  // New messages scroll into view above the input area, not behind it.
  new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${$("dock").offsetHeight}px`)).observe($("dock"));
  if (document.body.dataset.mode === "web") {
    const { WebHost } = await import("./web/host");
    const { initWeb } = await import("./web/ui");
    const host = new WebHost();
    host.progress = setStatus;
    state.host = host;
    state.web = initWeb({
      host,
      post,
      guarded,
      readSource: (ref, fresh) => readSource(ref, fresh),
      reset: () => { state.ref = undefined; state.asked = null; state.columns = undefined; state.sourceRef = undefined; state.wide = null; state.pending = null; },
      miniTable,
      setStatus,
      cellText,
    });
    setBusy(false);
    return;
  }
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
