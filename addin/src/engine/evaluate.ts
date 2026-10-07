/** Restricted formulas: numbers, [column], + - * / ( ), round, abs, days/weeks/months/years, today. Never uses eval. */
import { PlanError, col, numberOf } from "./core";
import { Cell, Column, Table, isBlankCell, timesOf } from "./table";
import { DAY_MS, todayMs } from "./util";

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|\[([^\]]+)\]|([a-z_]+)(?=\s*\()|([-+*/(),]))/y;
const FUNCS = new Set(["round", "abs", "days", "weeks", "months", "years", "today"]);

type Tok = { kind: "num" | "col" | "fn" | "op"; v: string };
type NumSeries = (number | null)[];
/** A number, a numeric series, a date series, a column (not yet read as number or date), or today. */
type Val = number | NumSeries | { dates: NumSeries } | { column: Column } | { today: number };

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  let pos = 0;
  while (expr.slice(pos).trim()) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(expr);
    if (!m) throw new PlanError(`Can't read the formula near '${expr.slice(pos).trim()}'`);
    if (m[1] !== undefined) toks.push({ kind: "num", v: m[1] });
    else if (m[2] !== undefined) toks.push({ kind: "col", v: m[2] });
    else if (m[3] !== undefined) toks.push({ kind: "fn", v: m[3] });
    else toks.push({ kind: "op", v: m[4] });
    pos = TOKEN.lastIndex;
  }
  return toks;
}

/** Round half to even, like numpy. */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** A value as numbers. Text that isn't a number stops the calculation instead of silently becoming blank. */
function asNumbers(v: Val): number | NumSeries {
  if (typeof v === "number" || Array.isArray(v)) return v;
  if ("column" in v) {
    const c = v.column;
    if (c.kind === "date") throw new PlanError(`${c.name} is a date, so it can't be used in arithmetic. Try days(...) or "days since ${c.name}".`);
    return c.values.map((x) => {
      if (isBlankCell(x)) return null;
      const n = numberOf(x);
      if (Number.isNaN(n)) {
        throw new PlanError(`${c.name} has text like ${JSON.stringify(String(x)).replace(/"/g, "'")}, so it can't be used in a calculation. `
          + `Convert it first: convert ${c.name} to number`);
      }
      return n;
    });
  }
  throw new PlanError("A date can't be used in arithmetic here.");
}

function combine(a: Val, b: Val, f: (x: number, y: number) => number): Val {
  const x = asNumbers(a), y = asNumbers(b);
  if (typeof x === "number" && typeof y === "number") return f(x, y);
  const n = Array.isArray(x) ? x.length : (y as NumSeries).length;
  return Array.from({ length: n }, (_, i) => {
    const p = typeof x === "number" ? x : x[i], q = typeof y === "number" ? y : y[i];
    return p === null || q === null ? null : f(p, q);
  });
}

function datesOf(v: Val, n: number): NumSeries {
  if (typeof v === "object" && !Array.isArray(v)) {
    if ("today" in v) return new Array(n).fill(v.today);
    if ("dates" in v) return v.dates;
    if ("column" in v) return timesOf(v.column);
  }
  throw new PlanError("Date functions need date columns or today().");
}

function call(fn: string, args: Val[], n: number): Val {
  if (fn === "today") return { today: todayMs() };
  if (fn === "round") {
    const x = asNumbers(args[0]), digits = args.length > 1 ? Number(asNumbers(args[1])) : 0;
    const k = 10 ** digits, r = (y: number) => rint(y * k) / k;
    return typeof x === "number" ? r(x) : x.map((y) => (y === null ? null : r(y)));
  }
  if (fn === "abs") {
    const x = asNumbers(args[0]);
    return typeof x === "number" ? Math.abs(x) : x.map((y) => (y === null ? null : Math.abs(y)));
  }
  if (args.length !== 2) throw new PlanError(`${fn}() needs a start and an end date`);
  const start = datesOf(args[0], n), end = datesOf(args[1], n);
  return start.map((s, i) => {
    const e = end[i];
    if (s === null || e === null) return null;
    const days = Math.floor((e - s) / DAY_MS);
    if (fn === "days") return days;
    if (fn === "weeks") return Math.floor(days / 7);
    const a = new Date(s), b = new Date(e);
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
    return fn === "months" ? months : Math.floor(months / 12);
  });
}

class Evaluator {
  i = 0;
  constructor(private t: Table, private toks: Tok[]) {}

  private peek(): Tok | null { return this.i < this.toks.length ? this.toks[this.i] : null; }
  private take(value?: string): Tok {
    const tok = this.peek();
    if (!tok || (value !== undefined && tok.v !== value)) throw new PlanError(`Formula expected '${value ?? "a value"}'`);
    this.i++;
    return tok;
  }

  expr(): Val {
    let left = this.term();
    while (this.peek() && (this.peek()!.v === "+" || this.peek()!.v === "-")) {
      const op = this.take().v;
      const right = this.term();
      left = combine(left, right, op === "+" ? (a, b) => a + b : (a, b) => a - b);
    }
    return left;
  }

  private term(): Val {
    let left = this.factor();
    while (this.peek() && (this.peek()!.v === "*" || this.peek()!.v === "/")) {
      const op = this.take().v;
      const right = this.factor();
      left = combine(left, right, op === "*" ? (a, b) => a * b : (a, b) => a / b);
    }
    return left;
  }

  private factor(): Val {
    const tok = this.take();
    if (tok.kind === "num") return parseFloat(tok.v);
    if (tok.kind === "col") return { column: col(this.t, tok.v) };
    if (tok.v === "-") return combine(0, this.factor(), (a, b) => a - b);
    if (tok.v === "(") {
      const out = this.expr();
      this.take(")");
      return out;
    }
    if (tok.kind === "fn" && FUNCS.has(tok.v)) {
      this.take("(");
      const args: Val[] = [];
      while (this.peek() && this.peek()!.v !== ")") {
        args.push(this.expr());
        if (this.peek()?.v === ",") this.take(",");
      }
      this.take(")");
      return call(tok.v, args, this.t.nrows);
    }
    throw new PlanError(`Unexpected '${tok.v}' in formula`);
  }
}

/** The formula's value for every row. Division by zero gives a blank. */
export function evaluate(t: Table, expr: string): Cell[] {
  const toks = tokenize(expr);
  const ev = new Evaluator(t, toks);
  const out = ev.expr();
  if (ev.i !== toks.length) throw new PlanError(`Can't read the formula near '${toks[ev.i].v}'`);
  const clean = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(10)));
  const nums = typeof out === "object" && !Array.isArray(out) && "column" in out ? asNumbers(out) : out; // a bare [column]
  if (typeof nums === "number") return new Array(t.nrows).fill(clean(nums));
  if (Array.isArray(nums)) return nums.map(clean);
  throw new PlanError("That formula doesn't give a number.");
}
