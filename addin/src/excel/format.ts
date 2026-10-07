/** Applies highlights, number formats and charts to sheets already written with Office.js. */
import { chartTable, excelNumberFormat, FormatStep, highlightMask, liveFormats } from "../engine/format";
import type { ChartStep } from "../engine/plan";
import { Sheets, Table, combine } from "../engine/table";

const MAX_FILL_RUNS = 20_000;
const CHART_TYPES: Record<ChartStep["kind"], string> = { column: "ColumnClustered", bar: "BarClustered", line: "LineMarkers", pie: "Pie" };

/** Runs of consecutive true values: [start, length]. Fewer, longer ranges mean fewer Excel calls. */
function runs(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) { out.push([start, i - start]); start = -1; }
  });
  if (start >= 0) out.push([start, flags.length - start]);
  return out;
}

/** Number formats and highlights for one written sheet (header is row 0, data starts at row 1). */
export function formatSheet(ws: Excel.Worksheet, t: Table, formats: FormatStep[]): string[] {
  const notes: string[] = [];
  const index = (name: string) => t.columns.findIndex((c) => c.name === name);
  for (const step of formats) {
    if (step.op === "number_format" && t.nrows) {
      const names = step.columns ?? t.columns.filter((c) => c.kind === "number").map((c) => c.name);
      for (const n of names) {
        const j = index(n);
        if (j >= 0) (ws.getRangeByIndexes(1, j, t.nrows, 1) as { numberFormat: unknown }).numberFormat = excelNumberFormat(step);
      }
    }
    if (step.op === "highlight" && t.nrows) {
      const mask = highlightMask(t, step);
      const spans = runs(mask);
      if (spans.length > MAX_FILL_RUNS) { notes.push(`Too many separate rows to colour on “${ws.name}”; the highlight was skipped.`); continue; }
      const j = step.column ? index(step.column) : -1;
      for (const [start, len] of spans) {
        const range = j >= 0 ? ws.getRangeByIndexes(1 + start, j, len, 1) : ws.getRangeByIndexes(1 + start, 0, len, t.columns.length);
        range.format.fill.color = "#" + step.color;
      }
    }
  }
  return notes;
}

/** One new "Chart N" sheet per chart step: a small summary table plus the chart. Returns the sheets made. */
export async function addCharts(ctx: Excel.RequestContext, result: Sheets, formats: FormatStep[], taken: Set<string>): Promise<{ name: string; rows: number }[]> {
  const all = [...result.values()];
  const combined = all.length === 1 ? all[0] : combine(result);
  const made: { name: string; rows: number }[] = [];
  let n = 0;
  for (const step of formats) {
    if (step.op !== "chart") continue;
    const data = chartTable(combined, step);
    let name = `Chart ${++n}`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `Chart ${n} (${k})`;
    taken.add(name.toLowerCase());
    const ws = ctx.workbook.worksheets.add(name);
    const cols = data.columns.length;
    (ws.getRangeByIndexes(1, 0, Math.max(1, data.nrows), 1) as { numberFormat: unknown }).numberFormat = "@"; // labels like 2025 stay text, so they're categories
    ws.getRangeByIndexes(0, 0, 1, cols).values = [data.columns.map((c) => c.name)];
    ws.getRangeByIndexes(1, 0, data.nrows, cols).values = Array.from({ length: data.nrows }, (_, i) =>
      data.columns.map((c, j) => (j === 0 ? String(c.values[i] ?? "") : c.values[i] ?? "")));
    ws.getRangeByIndexes(0, 0, 1, cols).format.font.bold = true;
    ws.getRangeByIndexes(0, 0, data.nrows + 1, cols).format.autofitColumns();
    const chart = ws.charts.add(CHART_TYPES[step.kind] as Excel.ChartType, ws.getRangeByIndexes(0, 0, data.nrows + 1, cols), "Columns");
    chart.title.text = step.title;
    chart.legend.visible = step.kind === "pie";
    if (step.kind === "pie") chart.dataLabels.showValue = true;
    chart.setPosition("D2", "N22");
    made.push({ name, rows: data.nrows });
  }
  return made;
}

export { liveFormats };
