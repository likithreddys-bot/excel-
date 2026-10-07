/** Summaries: group totals, pivots, top N, percent of total / running total / rank. */
import { PlanError, SortKey, col, compareKeys, keyLabel, need, numberOf, sortKeys, sortRows } from "./core";
import type { Aggregation, CalculateStep, GroupByStep, PivotStep, TopNStep } from "./plan";
import { evaluate } from "./evaluate";
import { Cell, Column, Table, isBlankCell, makeColumn, pick } from "./table";

type Func = Aggregation["func"];

const isBlank = (v: Cell) => isBlankCell(v);

/** Row numbers grouped by the values of `keys`, groups in sorted order (blank last), like a pandas groupby. */
function groupRows(t: Table, keys: Column[]): number[][] {
  if (!keys.length) return [Array.from({ length: t.nrows }, (_, i) => i)];
  const groups = new Map<string, number[]>();
  for (let i = 0; i < t.nrows; i++) {
    const k = JSON.stringify(keys.map((c) => c.values[i]));
    const g = groups.get(k);
    if (g) g.push(i); else groups.set(k, [i]);
  }
  const sk = keys.map(sortKeys);
  return [...groups.values()].sort((a, b) => {
    for (const k of sk) {
      const x = k[a[0]], y = k[b[0]];
      if (x === null || y === null) {
        if (x === y) continue;
        return x === null ? 1 : -1;
      }
      const d = compareKeys(x, y);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/** One summary number for the rows `idx` of column `c`. */
function summarise(c: Column, idx: number[], func: Func): Cell {
  switch (func) {
    case "count": return idx.reduce((n, i) => n + (isBlank(c.values[i]) ? 0 : 1), 0);
    case "nunique": return new Set(idx.filter((i) => !isBlank(c.values[i])).map((i) => JSON.stringify(c.values[i]))).size;
    case "sum": {
      let s = 0;
      for (const i of idx) { const n = numberOf(c.values[i]); if (!Number.isNaN(n)) s += n; }
      return s;
    }
    case "mean": {
      let s = 0, n = 0;
      for (const i of idx) { const v = numberOf(c.values[i]); if (!Number.isNaN(v)) { s += v; n++; } }
      return n ? s / n : null;
    }
    case "min": case "max": {
      const keys = sortKeys(c);
      let best: number | null = null;
      for (const i of idx) {
        if (keys[i] === null) continue;
        if (best === null || (func === "min" ? compareKeys(keys[i], keys[best]) < 0 : compareKeys(keys[i], keys[best]) > 0)) best = i;
      }
      return best === null ? null : c.values[best];
    }
  }
}

/** Group totals worked out from sums, so a formula like [a]*100/[b] uses total a and total b (an Excel calculated field). */
export function calculatedTotals(t: Table, groups: number[][], calculated: Record<string, string>): Cell[][] {
  const refs = [...new Set(Object.values(calculated).flatMap((e) => [...e.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])))].sort();
  need(t, refs);
  const sums = refs.map((r) => {
    const c = col(t, r);
    return makeColumn(r, groups.map((g) => {
      let s = 0, any = false;
      for (const i of g) { const n = numberOf(c.values[i]); if (!Number.isNaN(n)) { s += n; any = true; } }
      return any ? s : null;
    }));
  });
  const table: Table = { columns: sums, nrows: groups.length };
  return Object.values(calculated).map((expr) => evaluate(table, expr));
}

const withBlankLabel = (c: Column): Column => {
  if (!c.values.some(isBlank)) return c;
  // Missing group keys become "(blank)" so they stay in the pivot instead of being dropped.
  return makeColumn(c.name, c.values.map((v, i) => keyLabel(c, v, i)));
};

const firstCells = (c: Column, groups: number[][]): Cell[] => groups.map((g) => c.values[g[0]]);

// ---------- group_by ----------

export function groupBy(t: Table, step: GroupByStep): Table {
  need(t, [...step.columns, ...step.aggregations.map((a) => a.column)]);
  const keys = step.columns.map((n) => col(t, n));
  const groups = groupRows(t, keys);
  const out: Column[] = keys.map((k) => makeColumn(k.name, firstCells(k, groups), k.format));
  for (const a of step.aggregations) {
    const c = col(t, a.column);
    // Counting a group column counts rows (a blank group would otherwise count as 0).
    const rowsOnly = a.func === "count" && step.columns.includes(a.column);
    out.push(makeColumn(`${a.func}_${a.column}`, groups.map((g) => (rowsOnly ? g.length : summarise(c, g, a.func)))));
  }
  const calc = calculatedTotals(t, groups, step.calculated);
  Object.keys(step.calculated).forEach((name, i) => out.push(makeColumn(name, calc[i])));
  return { columns: out, nrows: groups.length };
}

// ---------- pivot ----------

export function pivot(t: Table, step: PivotStep): Table {
  need(t, [...step.rows, ...step.columns, ...(step.values ? [step.values] : [])]);
  const rowDims = step.rows.map((n) => withBlankLabel(col(t, n)));
  const colDims = step.columns.map((n) => withBlankLabel(col(t, n)));
  const labelOf = (dims: Column[], i: number) => dims.map((d) => keyLabel(d, d.values[i], i)).join(" / ");
  const rowGroups = groupRows(t, rowDims);
  const colGroups = colDims.length ? groupRows(t, colDims) : [];
  const total = (c: Column | null, idx: number[]) => (c ? summarise(c, idx, step.func) : idx.length);
  const value = step.values ? col(t, step.values) : null;
  const exact = step.func === "count" || step.func === "nunique" || value === null;
  const fill: Cell = step.func === "sum" || exact ? 0 : null;

  const keyCols: Column[] = rowDims.map((d) => makeColumn(d.name, firstCells(d, rowGroups), d.format));
  const labelRow = (isTotal: boolean) => step.rows.map((_, j) => (isTotal ? (j === 0 ? "Total" : "") : null));

  // Calculated (side-by-side totals) pivots: one column per value, no columns across the top.
  if (Object.keys(step.calculated).length) {
    const names = Object.keys(step.calculated);
    const body = calculatedTotals(t, rowGroups, step.calculated);
    const all = calculatedTotals(t, [Array.from({ length: t.nrows }, (_, i) => i)], step.calculated);
    const cols = [
      ...keyCols.map((k, j) => makeColumn(k.name, step.totals ? [...k.values, labelRow(true)[j]] : k.values, k.format)),
      ...names.map((n, i) => makeColumn(n, step.totals ? [...body[i], all[i][0]] : body[i])),
    ];
    return { columns: cols, nrows: rowGroups.length + (step.totals ? 1 : 0) };
  }

  const cell = (idx: number[]): Cell => (idx.length ? total(value, idx) : fill);
  const outCols: { name: string; values: Cell[] }[] = [];
  if (colDims.length) {
    const rowKeyOf = new Map<number, number>();
    rowGroups.forEach((g, r) => g.forEach((i) => rowKeyOf.set(i, r)));
    for (const cg of colGroups) {
      const byRow = new Map<number, number[]>();
      for (const i of cg) { const r = rowKeyOf.get(i)!; (byRow.get(r) ?? byRow.set(r, []).get(r)!).push(i); }
      const values: Cell[] = rowGroups.map((_, r) => cell(byRow.get(r) ?? []));
      if (step.totals) values.push(cell(cg));
      outCols.push({ name: labelOf(colDims, cg[0]), values });
    }
    if (step.totals) {
      const values: Cell[] = rowGroups.map((g) => cell(g));
      values.push(cell(Array.from({ length: t.nrows }, (_, i) => i)));
      outCols.push({ name: "Total", values });
    }
  } else {
    const values: Cell[] = rowGroups.map((g) => cell(g));
    if (step.totals) values.push(cell(Array.from({ length: t.nrows }, (_, i) => i)));
    outCols.push({ name: value === null ? step.func : `${step.func}_${step.values}`, values });
  }
  const columns = [
    ...keyCols.map((k, j) => makeColumn(k.name, step.totals ? [...k.values, labelRow(true)[j]] : k.values, k.format)),
    ...outCols.map((c) => makeColumn(c.name, c.values)),
  ];
  return { columns, nrows: rowGroups.length + (step.totals ? 1 : 0) };
}

// ---------- top N ----------

export function topN(t: Table, step: TopNStep): Table {
  need(t, [...(step.column ? [step.column] : []), ...(step.per ?? [])]);
  const all = Array.from({ length: t.nrows }, (_, i) => i);
  if (step.column === null) return pick(t, step.largest ? all.slice(0, step.n) : all.slice(Math.max(0, t.nrows - step.n)));
  const ranked = sortRows(t, [step.column], !step.largest);
  if (!step.per) return pick(t, ranked.slice(0, step.n));
  const per = step.per.map((n) => col(t, n));
  const seen = new Map<string, number>();
  const keep: number[] = [];
  for (const i of ranked) {
    const k = JSON.stringify(per.map((c) => c.values[i]));
    const n = seen.get(k) ?? 0;
    if (n < step.n) keep.push(i);
    seen.set(k, n + 1);
  }
  return pick(t, keep);
}

// ---------- percent of total, running total, rank ----------

/** Round half to even, like numpy.rint. */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const round2 = (x: number) => rint(x * 100) / 100;

export function calculate(t: Table, step: CalculateStep): Table {
  need(t, [step.column, ...(step.per ?? [])]);
  const c = col(t, step.column);
  const groups = groupRows(t, (step.per ?? []).map((n) => col(t, n)));
  const out: Cell[] = new Array(t.nrows).fill(null);
  if (step.kind === "rank") {
    const keys = sortKeys(c) as SortKey[];
    for (const g of groups) {
      const present = g.filter((i) => keys[i] !== null)
        .sort((i, j) => (step.descending ? -1 : 1) * compareKeys(keys[i]!, keys[j]!));
      present.forEach((i, pos) => {
        // Ties share the lowest rank: a row ties with the one before it when their keys are equal.
        const tied = pos > 0 && compareKeys(keys[present[pos - 1]]!, keys[i]!) === 0;
        out[i] = tied ? (out[present[pos - 1]] as number) : pos + 1;
      });
    }
  } else {
    const nums = c.values.map(numberOf);
    for (const g of groups) {
      if (step.kind === "percent_of_total") {
        let total = 0;
        for (const i of g) if (!Number.isNaN(nums[i])) total += nums[i];
        for (const i of g) {
          const v = round2((nums[i] / total) * 100);
          out[i] = Number.isNaN(nums[i]) || !Number.isFinite(v) ? null : v;
        }
      } else {
        let run = 0;
        for (const i of g) {
          if (Number.isNaN(nums[i])) continue; // a blank gets no running total but doesn't stop the count
          run += nums[i];
          out[i] = run;
        }
      }
    }
  }
  const made = makeColumn(step.name, out);
  return { nrows: t.nrows, columns: t.columns.filter((x) => x.name !== step.name).concat(made) };
}
