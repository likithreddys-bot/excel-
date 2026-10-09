/** The website's extras around the shared pane: opening files, picking a sheet, downloading results, drawing charts. */
import { chartTable, FormatStep, liveFormats } from "../engine/format";
import { Sheets, Table, combine } from "../engine/table";
import type { SourceRef } from "../host";
import { drawChart } from "./chart";
import type { WebHost } from "./host";

export interface WebContext {
  host: WebHost;
  post(kind: "user" | "bot" | "err", text?: string): HTMLElement;
  guarded(fn: () => Promise<void>): Promise<void>;
  readSource(ref?: SourceRef, fresh?: boolean): Promise<Table>;
  /** Forget the chosen sheet/columns/question: a different table is about to be read. */
  reset(): void;
  miniTable(t: Table, limit?: number): HTMLElement;
  setStatus(text: string): void;
  cellText(t: Table, col: number, row: number): string;
}

export interface WebHooks {
  /** The pane's status line changed (reading / writing progress): drive the progress bar. */
  status(text: string): void;
  /** A table was read: show it in the data grid. */
  sourceShown(t: Table): void;
  /** Results were added or removed: refresh the sheet picker. */
  sheetsChanged(): void;
  /** A command just ran: add download / view / chart buttons to its "Done" card. */
  afterRun(made: { name: string; rows: number }[], p: { result: Sheets; formats: FormatStep[] }, card: HTMLElement, actions: HTMLElement): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (n: number) => n.toLocaleString("en-IN");

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  return b;
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function initWeb(ctx: WebContext): WebHooks {
  const { host } = ctx;
  const input = $<HTMLInputElement>("file-input");
  const picker = $<HTMLSelectElement>("sheet-picker");

  const refresh = () => {
    const sheets = host.sheetList();
    picker.replaceChildren();
    const mine = document.createElement("optgroup");
    mine.label = "Your files";
    const made = document.createElement("optgroup");
    made.label = "Results made here";
    for (const s of sheets) (s.result ? made : mine).append(new Option(s.name, s.name));
    if (mine.children.length) picker.append(mine);
    if (made.children.length) picker.append(made);
    if (host.current) picker.value = host.current;
    $("sheet-row").classList.toggle("hidden", sheets.length === 0);
  };

  const load = (files: File[]) => ctx.guarded(async () => {
    ctx.setStatus("Opening your file…");
    const { added, problems } = await host.addFiles(files);
    for (const p of problems) ctx.post("err", p);
    if (!added.length) return;
    refresh();
    showApp();
    ctx.reset();
    ctx.post("bot", added.length === 1 ? `Opened “${added[0]}”.` : `Opened ${added.length} sheets: ${added.join(", ")}. Pick which one to work on above; the others can be used for lookups (for example “bring manager from ${added[1]} on branch”).`);
    await ctx.readSource({ sheet: host.current!, address: "A1" }, true);
  });

  $("open-file").addEventListener("click", () => input.click());
  $("open-more").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) void load(files);
  });
  picker.addEventListener("change", () => void ctx.guarded(async () => {
    ctx.reset();
    await ctx.readSource({ sheet: picker.value, address: "A1" }, true);
  }));

  const showApp = () => {
    $("landing").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("open-more").classList.remove("hidden");
    $("site-foot").classList.add("hidden");
    window.scrollTo(0, 0);
  };

  // the big drop box is a button too (click or Enter/Space)
  const box = $("drop-box");
  box.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) input.click(); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  $("try-sample").addEventListener("click", () => void ctx.guarded(async () => {
    const { sampleFile } = await import("./sample");
    await load([await sampleFile()]);
  }));

  // light / dark
  $("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = (root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("sheet-assistant-theme", root.dataset.theme); } catch { /* storage can be blocked */ }
  });

  // "What can I ask?": a chip starts a sentence, with its first [placeholder] selected ready to overwrite
  $("help").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest("button.chip");
    if (!chip) return;
    const box = $<HTMLTextAreaElement>("input");
    box.value = chip.textContent ?? "";
    box.focus();
    const at = box.value.indexOf("[");
    if (at >= 0) box.setSelectionRange(at, box.value.indexOf("]", at) + 1);
  });

  // once the user starts asking, the cheat sheet gets out of the way of the conversation
  $("ask").addEventListener("submit", () => { ($("help") as HTMLDetailsElement).open = false; });
  // on a phone the grid starts folded away so the conversation is within reach
  if (matchMedia("(max-width: 860px)").matches) ($("grid-card") as HTMLDetailsElement).open = false;

  // cancel a long read
  $("cancel-read").addEventListener("click", () => host.cancel());

  // the data grid
  let shown: Table | null = null;
  const gridRows = $<HTMLSelectElement>("grid-rows");
  const KIND = { number: "123", date: "date", text: "abc" } as const;
  const MAX_COLS = 60;
  const drawGrid = () => {
    const t = shown;
    const card = $("grid-card");
    card.classList.toggle("hidden", !t);
    if (!t) return;
    const nShow = Math.min(t.nrows, Number(gridRows.value));
    const cols = t.columns.slice(0, MAX_COLS);
    $("grid-sub").textContent = `· first ${num(nShow)} of ${num(t.nrows)} rows` + (t.columns.length > MAX_COLS ? ` · first ${MAX_COLS} of ${t.columns.length} columns` : "");
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    const corner = document.createElement("th");
    corner.className = "rn";
    corner.textContent = "#";
    head.append(corner);
    for (const c of cols) {
      const th = document.createElement("th");
      th.title = `Add “${c.name}” to your sentence`;
      th.dataset.col = c.name;
      const badge = document.createElement("span");
      badge.className = `kind ${c.kind}`;
      badge.textContent = KIND[c.kind];
      th.append(badge, c.name);
      head.append(th);
    }
    const body = table.createTBody();
    for (let i = 0; i < nShow; i++) {
      const tr = body.insertRow();
      const rn = tr.insertCell();
      rn.className = "rn";
      rn.textContent = String(i + 1);
      cols.forEach((c, j) => {
        const td = tr.insertCell();
        const text = ctx.cellText(t, j, i);
        if (text === "") { td.className = "blank"; td.textContent = "–"; } else { td.textContent = text; if (c.kind === "number") td.className = "num"; }
      });
    }
    $("grid").replaceChildren(table);
  };
  gridRows.addEventListener("change", drawGrid);
  $("grid").addEventListener("click", (e) => {
    const th = (e.target as HTMLElement).closest("th[data-col]") as HTMLElement | null;
    if (!th) return;
    const box = $<HTMLTextAreaElement>("input");
    const at = box.selectionStart ?? box.value.length;
    const name = th.dataset.col!;
    box.value = box.value.slice(0, at) + (at && !/\s$/.test(box.value.slice(0, at)) ? " " : "") + name + box.value.slice(box.selectionEnd ?? at);
    box.focus();
  });

  // drag a file anywhere onto the page
  let depth = 0;
  const over = (on: boolean) => document.body.classList.toggle("dragging", on);
  document.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { depth++; over(true); } });
  document.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) over(false); });
  document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    depth = 0;
    over(false);
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    void load(Array.from(e.dataTransfer.files));
  });

  return {
    status(text) {
      const busy = $("busy"), bar = $("bar");
      busy.classList.toggle("hidden", !text);
      const pct = /(\d{1,3})%/.exec(text);
      bar.classList.toggle("wait", !pct);
      (bar.firstElementChild as HTMLElement).style.width = pct ? `${Math.min(100, Number(pct[1]))}%` : "";
      $("cancel-read").classList.toggle("hidden", !/^Reading/.test(text));
    },
    sourceShown(t) {
      shown = t;
      drawGrid();
    },
    sheetsChanged: refresh,
    afterRun(made, p, card, actions) {
      refresh();
      const names = made.filter((m) => m.rows >= 0).map((m) => m.name);
      if (!names.length) return;
      const dl = button("Download as Excel", "primary");
      dl.addEventListener("click", () => void ctx.guarded(async () => {
        const blob = await host.xlsxOf(names);
        save(blob, `${names.length === 1 ? names[0] : "results"}.xlsx`);
      }));
      actions.prepend(dl);
      const view = button("Show more rows");
      let shown: HTMLElement | null = null;
      view.addEventListener("click", () => void ctx.guarded(async () => {
        if (shown) { shown.remove(); shown = null; view.textContent = "Show more rows"; return; }
        const t = await host.readSheet(names[0]);
        shown = ctx.miniTable(t, 100);
        shown.classList.add("tall");
        card.append(shown);
        view.textContent = t.nrows > 100 ? `Hide rows (showing 100 of ${num(t.nrows)})` : "Hide rows";
      }));
      actions.append(view);
      for (const f of liveFormats(p.formats, p.result)) {
        if (f.op === "chart") card.append(drawChart(chartTable(combine(p.result), f), f));
      }
    },
  };
}
