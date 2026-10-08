/** A small SVG chart for the website (the Excel add-in uses Excel's own charts). Two columns in: labels, values. */
import type { ChartStep } from "../engine/plan";
import type { Table } from "../engine/table";

const NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#2a7de1", "#e8743b", "#19a979", "#945ecf", "#d6453d", "#13a4b4", "#c9a227", "#6f7c8a"];
const MAX_POINTS = 40;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text = ""): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

const fmt = (n: number): string => (Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(1)}Cr` : Math.abs(n) >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n * 100) / 100));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function drawChart(data: Table, step: ChartStep): SVGSVGElement {
  const labels = data.columns[0].values.slice(0, MAX_POINTS).map((v) => String(v ?? ""));
  const values = data.columns[1].values.slice(0, MAX_POINTS).map((v) => (typeof v === "number" ? v : 0));
  const W = 560, H = step.kind === "bar" ? Math.max(180, 26 * labels.length + 50) : 280;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": step.title });
  root.style.maxWidth = "640px";
  root.style.color = "var(--fg)";
  root.append(svg("text", { x: W / 2, y: 18, "text-anchor": "middle", "font-size": 13, "font-weight": 600, fill: "currentColor" }, step.title));
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  const span = max - min || 1;

  if (step.kind === "pie") {
    const total = values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
    let angle = -Math.PI / 2;
    const cx = 150, cy = 150, r = 100;
    values.forEach((v, i) => {
      const share = Math.max(0, v) / total;
      const a2 = angle + share * 2 * Math.PI;
      const large = share > 0.5 ? 1 : 0;
      const d = share >= 0.9999
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`
        : `M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a2)} ${cy + r * Math.sin(a2)} Z`;
      root.append(svg("path", { d, fill: PALETTE[i % PALETTE.length], stroke: "var(--bg)", "stroke-width": 1 }));
      angle = a2;
      const ly = 40 + i * 18;
      if (ly < H - 10) {
        root.append(svg("rect", { x: 290, y: ly - 10, width: 12, height: 12, fill: PALETTE[i % PALETTE.length], rx: 2 }));
        root.append(svg("text", { x: 308, y: ly, "font-size": 11, fill: "currentColor" }, `${clip(labels[i], 22)}: ${fmt(v)} (${Math.round(share * 100)}%)`));
      }
    });
    return root;
  }

  if (step.kind === "bar") {
    const left = 120, right = 60, top = 30, rowH = 26;
    labels.forEach((l, i) => {
      const w = ((values[i] - Math.min(0, min)) / span) * (W - left - right);
      root.append(svg("text", { x: left - 6, y: top + i * rowH + 15, "text-anchor": "end", "font-size": 11, fill: "currentColor" }, clip(l, 18)));
      root.append(svg("rect", { x: left, y: top + i * rowH + 3, width: Math.max(1, w), height: rowH - 8, fill: PALETTE[0], rx: 2 }));
      root.append(svg("text", { x: left + Math.max(1, w) + 4, y: top + i * rowH + 15, "font-size": 11, fill: "currentColor" }, fmt(values[i])));
    });
    return root;
  }

  // column and line share axes
  const left = 46, right = 12, top = 30, bottom = 54;
  const plotW = W - left - right, plotH = H - top - bottom;
  const y = (v: number) => top + plotH - ((v - min) / span) * plotH;
  for (let g = 0; g <= 4; g++) {
    const v = min + (span * g) / 4;
    root.append(svg("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), stroke: "currentColor", "stroke-opacity": 0.15 }));
    root.append(svg("text", { x: left - 5, y: y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "currentColor" }, fmt(v)));
  }
  const step_ = plotW / Math.max(1, labels.length);
  const every = Math.ceil(labels.length / 14);
  labels.forEach((l, i) => {
    const cx = left + step_ * (i + 0.5);
    if (i % every === 0) {
      const t = svg("text", { x: cx, y: H - bottom + 14, "font-size": 10, fill: "currentColor", "text-anchor": "end", transform: `rotate(-35 ${cx} ${H - bottom + 14})` }, clip(l, 14));
      root.append(t);
    }
    if (step.kind === "column") {
      const base = y(Math.max(0, min));
      root.append(svg("rect", { x: cx - step_ * 0.35, y: Math.min(y(values[i]), base), width: step_ * 0.7, height: Math.max(1, Math.abs(base - y(values[i]))), fill: PALETTE[0], rx: 2 }));
    }
  });
  if (step.kind === "line") {
    root.append(svg("polyline", { points: values.map((v, i) => `${left + step_ * (i + 0.5)},${y(v)}`).join(" "), fill: "none", stroke: PALETTE[0], "stroke-width": 2 }));
    values.forEach((v, i) => root.append(svg("circle", { cx: left + step_ * (i + 0.5), cy: y(v), r: 3, fill: PALETTE[0] })));
  }
  return root;
}
