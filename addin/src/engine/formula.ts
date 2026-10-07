/**
 * Excel-style formulas, evaluated row by row on a table: IF, IFS, IFERROR, AND/OR/NOT, text functions (LEFT, MID,
 * UPPER, SUBSTITUTE, TEXT...), date functions (YEAR, EOMONTH, DATEDIF...), math, and COUNTIF / SUMIF over a column.
 *
 * Columns are written [Like This] or, if the name has no spaces, bare. Never uses eval: the formula is parsed into a
 * small tree and run by this file's own code, so it can only do what is listed here.
 */
import { PlanError } from "./core";
import { Cell, Column, Table, timesOf } from "./table";
import { closeMatch, key, msToSerial, parseNumber, serialToMs } from "./util";

export class FormulaSyntaxError extends Error {}

// ---------- values ----------

class Err { constructor(readonly code: string) {} }
const DIV0 = new Err("#DIV/0!"), VALUE = new Err("#VALUE!"), NA = new Err("#N/A"), NUM = new Err("#NUM!");
type Value = number | string | boolean | null | Err;
/** What a formula's result is, as far as we can tell before running it (decides the result column's format). */
export type Kind = "num" | "text" | "bool" | "date" | "any";

const isErr = (v: Value): v is Err => v instanceof Err;

function toNum(v: Value): number | Err {
  if (isErr(v)) return v;
  if (typeof v === "number") return v;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = parseNumber(v.trim().replace(/\s+/g, ""));
  return n === null ? VALUE : n;
}

function toText(v: Value): string | Err {
  if (isErr(v)) return v;
  if (v === null) return "";
  if (typeof v === "number") return String(Number(v.toPrecision(15)));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}

function toBool(v: Value): boolean | Err {
  if (isErr(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  const s = v.trim().toUpperCase();
  return s === "TRUE" ? true : s === "FALSE" ? false : VALUE;
}

const blank = (v: Value) => v === null || (typeof v === "string" && v === "");

/** Excel's comparison: numbers before text before booleans; text ignores case; a blank equals 0 or "". */
function compareValues(a: Value, b: Value): number {
  const rank = (v: Value) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  let x = a, y = b;
  if (x === null) x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  if (y === null) y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  const rx = rank(x), ry = rank(y);
  if (rx !== ry) return rx - ry;
  if (typeof x === "number") return x - (y as number);
  if (typeof x === "string") { const p = x.toLowerCase(), q = (y as string).toLowerCase(); return p < q ? -1 : p > q ? 1 : 0; }
  return Number(x) - Number(y as boolean);
}

// ---------- syntax tree ----------

type Node =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "bool"; v: boolean }
  | { t: "col"; name: string }
  | { t: "neg"; a: Node } | { t: "pct"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

type Tok = { k: "num" | "str" | "id" | "col" | "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m: RegExpExecArray | null;
    const rest = src.slice(i);
    if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) { out.push({ k: "num", v: m[0] }); i += m[0].length; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError("A quote (\") isn't closed.");
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      out.push({ k: "str", v: s }); i = j + 1; continue;
    }
    if (c === "[") {
      const j = src.indexOf("]", i);
      if (j < 0) throw new FormulaSyntaxError("A bracket ([) isn't closed.");
      out.push({ k: "col", v: src.slice(i + 1, j).replace(/^\s*\[|\]\s*$/g, "").trim() }); i = j + 1; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) { out.push({ k: "id", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(?:<>|<=|>=|[-+*/^&=<>(),;%])/.exec(rest))) { out.push({ k: "op", v: m[0] === ";" ? "," : m[0] }); i += m[0].length; continue; }
    throw new FormulaSyntaxError(`I don't understand '${c}' in the formula.`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private resolve: (name: string) => string) {}

  private peek(): Tok | undefined { return this.toks[this.i]; }
  private op(v: string): boolean { const t = this.peek(); return !!t && t.k === "op" && t.v === v; }
  private take(): Tok { const t = this.toks[this.i++]; if (!t) throw new FormulaSyntaxError("The formula ends too early."); return t; }
  private expect(v: string): void {
    const t = this.peek();
    if (!t || t.k !== "op" || t.v !== v) throw new FormulaSyntaxError(`Expected '${v}' ${t ? `but found '${t.v}'` : "at the end of the formula"}.`);
    this.i++;
  }

  parse(): Node {
    const n = this.compare();
    if (this.i < this.toks.length) throw new FormulaSyntaxError(`I didn't expect '${this.toks[this.i].v}' there.`);
    return n;
  }

  private compare(): Node {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(t.v)) { this.i++; left = { t: "bin", op: t.v, a: left, b: this.concat() }; } else return left;
    }
  }
  private concat(): Node {
    let left = this.add();
    while (this.op("&")) { this.i++; left = { t: "bin", op: "&", a: left, b: this.add() }; }
    return left;
  }
  private add(): Node {
    let left = this.mul();
    for (;;) {
      if (this.op("+") || this.op("-")) { const o = this.take().v; left = { t: "bin", op: o, a: left, b: this.mul() }; } else return left;
    }
  }
  private mul(): Node {
    let left = this.pow();
    for (;;) {
      if (this.op("*") || this.op("/")) { const o = this.take().v; left = { t: "bin", op: o, a: left, b: this.pow() }; } else return left;
    }
  }
  private pow(): Node {
    let left = this.unary();
    while (this.op("^")) { this.i++; left = { t: "bin", op: "^", a: left, b: this.unary() }; }
    return left;
  }
  private unary(): Node {
    if (this.op("-")) { this.i++; return { t: "neg", a: this.unary() }; }
    if (this.op("+")) { this.i++; return this.unary(); }
    return this.postfix();
  }
  private postfix(): Node {
    let n = this.primary();
    while (this.op("%")) { this.i++; n = { t: "pct", a: n }; }
    return n;
  }

  private primary(): Node {
    const t = this.take();
    if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "col") return { t: "col", name: this.resolve(t.v) };
    if (t.k === "op" && t.v === "(") { const n = this.compare(); this.expect(")"); return n; }
    if (t.k === "id") {
      if (this.op("(")) {
        this.i++;
        const args: Node[] = [];
        if (!this.op(")")) {
          for (;;) {
            // An empty argument (IF(a,,b)) counts as blank.
            args.push(this.op(",") ? { t: "str", v: "" } : this.compare());
            if (this.op(",")) { this.i++; continue; }
            break;
          }
        }
        this.expect(")");
        const fn = t.v.toUpperCase();
        const spec = FUNCTIONS[fn];
        if (!spec) {
          const near = closeMatch(fn, Object.keys(FUNCTIONS), 0.7);
          throw new FormulaSyntaxError(`I don't know the function ${fn}.` + (near ? ` Did you mean ${near}?` : ""));
        }
        if (args.length < spec.min || args.length > spec.max) {
          throw new FormulaSyntaxError(`${fn} needs ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max === Infinity ? "many" : spec.max}`} value(s), but got ${args.length}.`);
        }
        return { t: "call", fn, args };
      }
      const up = t.v.toUpperCase();
      if (up === "TRUE") return { t: "bool", v: true };
      if (up === "FALSE") return { t: "bool", v: false };
      return { t: "col", name: this.resolve(t.v) };
    }
    throw new FormulaSyntaxError(`I didn't expect '${t.v}' there.`);
  }
}

// ---------- functions ----------

interface Spec {
  min: number; max: number; kind: Kind;
  /** Evaluate arguments one by one only when needed (IF, IFERROR...). */
  lazy?: (args: (() => Value)[], ctx: Ctx) => Value;
  strict?: (args: Value[], ctx: Ctx) => Value;
}

interface Ctx { n: number; table: Table; columnValues: (name: string) => Value[]; memo: Map<string, unknown> }

const num = (f: (x: number) => number) => (a: Value[]): Value => { const x = toNum(a[0]); return isErr(x) ? x : f(x); };
const withNums = (a: Value[], f: (n: number[]) => Value): Value => {
  const out: number[] = [];
  for (const v of a) { const x = toNum(v); if (isErr(x)) return x; out.push(x); }
  return f(out);
};

/** Excel's ROUND: halves go away from zero. */
function roundTo(x: number, digits: number, mode: "half" | "up" | "down"): number {
  const k = 10 ** digits;
  const scaled = Math.abs(x) * k;
  const eps = 1e-9 * Math.max(1, scaled);
  const r = mode === "half" ? Math.floor(scaled + 0.5 + eps) : mode === "up" ? Math.ceil(scaled - eps) : Math.floor(scaled + eps);
  return (Math.sign(x) * r) / k;
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ymd(serial: number): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(serialToMs(serial));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
const serialOf = (y: number, m: number, d: number): number => msToSerial(Date.UTC(y, m - 1, d));

function formatText(v: Value, fmt: string): Value {
  if (isErr(v)) return v;
  if (/[dmy]/i.test(fmt.replace(/"[^"]*"/g, ""))) { // a date format
    const x = toNum(v);
    if (isErr(x)) return x;
    const { y, m, d, dow } = ymd(x);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return fmt.replace(/"([^"]*)"|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/gi, (tok, lit?: string) => {
      if (lit !== undefined) return lit;
      switch (tok.toLowerCase()) {
        case "yyyy": return String(y);
        case "yy": return p2(y % 100);
        case "mmmm": return MONTHS_LONG[m - 1];
        case "mmm": return MONTHS_LONG[m - 1].slice(0, 3);
        case "mm": return p2(m);
        case "m": return String(m);
        case "dddd": return DAYS_LONG[dow];
        case "ddd": return DAYS_LONG[dow].slice(0, 3);
        case "dd": return p2(d);
        default: return String(d);
      }
    });
  }
  const x = toNum(v);
  if (isErr(x)) return x;
  const percent = fmt.includes("%");
  const body = fmt.replace(/"[^"]*"/g, "");
  const decimals = (/\.([0#]+)/.exec(body)?.[1] ?? "").length;
  const intPart = body.split(".")[0];
  const minInt = (intPart.match(/0/g) ?? []).length;
  const grouped = intPart.includes(",");
  let val = percent ? x * 100 : x;
  const neg = val < 0;
  val = Math.abs(val);
  let s = val.toFixed(decimals);
  let [ip, fp] = s.split(".");
  ip = ip.padStart(minInt, "0");
  if (ip === "0" && minInt === 0 && decimals > 0) ip = "";
  if (grouped) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  s = fp !== undefined ? `${ip}.${fp}` : ip;
  const prefix = (/^"([^"]*)"/.exec(fmt)?.[1] ?? "") + (/^[^0#]*?([$₹€£])/.exec(fmt)?.[1] ?? "");
  return (neg ? "-" : "") + prefix + s + (percent ? "%" : "");
}

/** A COUNTIF-style criterion: 5, "Pune", ">100", "<>DEBIT", "A*". */
function criterion(c: Value): (v: Value) => boolean {
  if (typeof c === "number") return (v) => typeof v === "number" && v === c;
  if (typeof c === "boolean") return (v) => v === c;
  const s = c === null || isErr(c) ? "" : c;
  const m = /^(<>|>=|<=|=|>|<)?(.*)$/s.exec(s)!;
  const op = m[1] ?? "=", rhs = m[2];
  const asNumber = rhs.trim() !== "" && !Number.isNaN(Number(rhs)) ? Number(rhs) : null;
  if (asNumber !== null) {
    return (v) => {
      const isNum = typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));
      const x = typeof v === "number" ? v : isNum ? Number(v) : null;
      switch (op) {
        case "=": return x === asNumber;
        case "<>": return x !== asNumber;
        case ">": return x !== null && x > asNumber!;
        case ">=": return x !== null && x >= asNumber!;
        case "<": return x !== null && x < asNumber!;
        default: return x !== null && x <= asNumber!;
      }
    };
  }
  const wild = /[*?]/.test(rhs) ? new RegExp("^" + rhs.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  return (v) => {
    const t = v === null || isErr(v) ? "" : String(v);
    let hit: boolean;
    if (op === "=" || op === "<>") hit = wild ? wild.test(t) : t.toLowerCase() === rhs.toLowerCase();
    else { const d = t.toLowerCase().localeCompare(rhs.toLowerCase()); hit = op === ">" ? d > 0 : op === ">=" ? d >= 0 : op === "<" ? d < 0 : d <= 0; }
    return op === "<>" ? !hit : hit;
  };
}

const plainCriterion = (c: Value): string | null => {
  if (typeof c === "number") return "n:" + c;
  if (typeof c === "string" && !/^(?:<>|>=|<=|=|>|<)/.test(c) && !/[*?]/.test(c)) {
    return Number.isNaN(Number(c)) || c.trim() === "" ? "s:" + c.toLowerCase() : "n:" + Number(c);
  }
  return null;
};
const cellKey = (v: Value): string => (typeof v === "number" ? "n:" + v : "s:" + (v === null || isErr(v) ? "" : String(v)).toLowerCase());

/** COUNTIF / SUMIF / AVERAGEIF and the plural forms. Plain "equals" criteria use hash maps so repeats are fast. */
function conditional(kind: "count" | "sum" | "average", sumRange: Value[] | null, ranges: Value[][], crits: Value[], ctx: Ctx, memoKey: string): Value {
  const plain = crits.map(plainCriterion);
  if (plain.every((p) => p !== null)) {
    const id = `grp:${memoKey}`;
    let groups = ctx.memo.get(id) as Map<string, { n: number; s: number }> | undefined;
    if (!groups) {
      groups = new Map();
      for (let i = 0; i < ctx.n; i++) {
        const k = ranges.map((r) => cellKey(r[i])).join("\u0001");
        const g = groups.get(k) ?? { n: 0, s: 0 };
        g.n++;
        const x = sumRange ? sumRange[i] : 0;
        if (typeof x === "number") g.s += x;
        groups.set(k, g);
      }
      ctx.memo.set(id, groups);
    }
    const g = groups.get(plain.join("\u0001"));
    return kind === "count" ? (g?.n ?? 0) : kind === "sum" ? (g?.s ?? 0) : g && g.n ? g.s / g.n : DIV0;
  }
  const cacheKey = `scan:${memoKey}:${crits.map((c) => String(c)).join("\u0001")}`;
  let hit = ctx.memo.get(cacheKey) as { n: number; s: number } | undefined;
  if (!hit) {
    const scans = ((ctx.memo.get("scans") as number) ?? 0) + 1;
    if (scans > 200) throw new PlanError("This formula compares every row with too many different values to run quickly. Use a plain value in the condition, or a pivot/total command instead.");
    ctx.memo.set("scans", scans);
    const tests = crits.map(criterion);
    hit = { n: 0, s: 0 };
    for (let i = 0; i < ctx.n; i++) {
      if (!tests.every((t, j) => t(ranges[j][i]))) continue;
      hit.n++;
      const x = sumRange ? sumRange[i] : 0;
      if (typeof x === "number") hit.s += x;
    }
    ctx.memo.set(cacheKey, hit);
  }
  return kind === "count" ? hit.n : kind === "sum" ? hit.s : hit.n ? hit.s / hit.n : DIV0;
}

const FUNCTIONS: Record<string, Spec> = {};
const def = (name: string, min: number, max: number, kind: Kind, strict: Spec["strict"], lazy?: Spec["lazy"]) => { FUNCTIONS[name] = { min, max, kind, strict, lazy }; };

// logic
def("IF", 2, 3, "any", undefined, ([c, a, b]) => {
  const cond = toBool(c());
  if (isErr(cond)) return cond;
  return cond ? a() : b ? b() : false;
});
def("IFS", 2, Infinity, "any", undefined, (args) => {
  for (let i = 0; i + 1 < args.length; i += 2) {
    const cond = toBool(args[i]());
    if (isErr(cond)) return cond;
    if (cond) return args[i + 1]();
  }
  return NA;
});
def("IFERROR", 2, 2, "any", undefined, ([v, alt]) => { const x = v(); return isErr(x) ? alt() : x; });
def("IFNA", 2, 2, "any", undefined, ([v, alt]) => { const x = v(); return x === NA ? alt() : x; });
def("AND", 1, Infinity, "bool", undefined, (args) => { for (const a of args) { const b = toBool(a()); if (isErr(b)) return b; if (!b) return false; } return true; });
def("OR", 1, Infinity, "bool", undefined, (args) => { for (const a of args) { const b = toBool(a()); if (isErr(b)) return b; if (b) return true; } return false; });
def("NOT", 1, 1, "bool", ([a]) => { const b = toBool(a); return isErr(b) ? b : !b; });
def("XOR", 2, Infinity, "bool", (a) => { let t = 0; for (const v of a) { const b = toBool(v); if (isErr(b)) return b; if (b) t++; } return t % 2 === 1; });
def("SWITCH", 3, Infinity, "any", undefined, (args) => {
  const v = args[0]();
  let i = 1;
  for (; i + 1 < args.length; i += 2) if (compareValues(v, args[i]()) === 0) return args[i + 1]();
  return i < args.length ? args[i]() : NA;
});
def("ISBLANK", 1, 1, "bool", ([a]) => blank(a));
def("ISNUMBER", 1, 1, "bool", ([a]) => typeof a === "number");
def("ISTEXT", 1, 1, "bool", ([a]) => typeof a === "string");
def("ISERROR", 1, 1, "bool", ([a]) => isErr(a));
def("ISNA", 1, 1, "bool", ([a]) => a === NA);

// math
def("ABS", 1, 1, "num", num(Math.abs));
def("ROUND", 1, 2, "num", (a) => withNums(a, ([x, d = 0]) => roundTo(x, d, "half")));
def("ROUNDUP", 1, 2, "num", (a) => withNums(a, ([x, d = 0]) => roundTo(x, d, "up")));
def("ROUNDDOWN", 1, 2, "num", (a) => withNums(a, ([x, d = 0]) => roundTo(x, d, "down")));
def("TRUNC", 1, 2, "num", (a) => withNums(a, ([x, d = 0]) => roundTo(x, d, "down")));
def("INT", 1, 1, "num", num(Math.floor));
def("SIGN", 1, 1, "num", num(Math.sign));
def("SQRT", 1, 1, "num", (a) => { const x = toNum(a[0]); return isErr(x) ? x : x < 0 ? NUM : Math.sqrt(x); });
def("POWER", 2, 2, "num", (a) => withNums(a, ([x, y]) => x ** y));
def("MOD", 2, 2, "num", (a) => withNums(a, ([x, y]) => (y === 0 ? DIV0 : x - y * Math.floor(x / y))));
def("CEILING", 1, 2, "num", (a) => withNums(a, ([x, s = 1]) => (s === 0 ? 0 : Math.ceil(x / s) * s)));
def("FLOOR", 1, 2, "num", (a) => withNums(a, ([x, s = 1]) => (s === 0 ? DIV0 : Math.floor(x / s) * s)));
def("MIN", 1, Infinity, "num", undefined, undefined);
def("MAX", 1, Infinity, "num", undefined, undefined);
def("SUM", 1, Infinity, "num", undefined, undefined);
def("AVERAGE", 1, Infinity, "num", undefined, undefined);
def("COUNT", 1, Infinity, "num", undefined, undefined);
def("COUNTA", 1, Infinity, "num", undefined, undefined);
def("MEDIAN", 1, Infinity, "num", undefined, undefined);

// text
const sliceText = (f: (s: string, n: number) => string) => (a: Value[]): Value => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const n = a.length > 1 ? toNum(a[1]) : 1; if (isErr(n)) return n;
  return n < 0 ? VALUE : f(s, Math.floor(n));
};
def("LEFT", 1, 2, "text", sliceText((s, n) => s.slice(0, n)));
def("RIGHT", 1, 2, "text", sliceText((s, n) => (n === 0 ? "" : s.slice(-n))));
def("MID", 3, 3, "text", (a) => {
  const s = toText(a[0]); if (isErr(s)) return s;
  const st = toNum(a[1]), n = toNum(a[2]); if (isErr(st)) return st; if (isErr(n)) return n;
  return st < 1 || n < 0 ? VALUE : s.slice(Math.floor(st) - 1, Math.floor(st) - 1 + Math.floor(n));
});
def("LEN", 1, 1, "num", ([a]) => { const s = toText(a); return isErr(s) ? s : s.length; });
def("UPPER", 1, 1, "text", ([a]) => { const s = toText(a); return isErr(s) ? s : s.toUpperCase(); });
def("LOWER", 1, 1, "text", ([a]) => { const s = toText(a); return isErr(s) ? s : s.toLowerCase(); });
def("PROPER", 1, 1, "text", ([a]) => { const s = toText(a); return isErr(s) ? s : s.toLowerCase().replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1)); });
def("TRIM", 1, 1, "text", ([a]) => { const s = toText(a); return isErr(s) ? s : s.trim().replace(/\s+/g, " "); });
def("CLEAN", 1, 1, "text", ([a]) => { const s = toText(a); return isErr(s) ? s : s.replace(/[\u0000-\u001f]/g, ""); });
const concat = (a: Value[]): Value => { let out = ""; for (const v of a) { const s = toText(v); if (isErr(s)) return s; out += s; } return out; };
def("CONCAT", 1, Infinity, "text", concat);
def("CONCATENATE", 1, Infinity, "text", concat);
def("TEXTJOIN", 3, Infinity, "text", (a) => {
  const d = toText(a[0]); if (isErr(d)) return d;
  const skip = toBool(a[1]); if (isErr(skip)) return skip;
  const parts: string[] = [];
  for (const v of a.slice(2)) { const s = toText(v); if (isErr(s)) return s; if (!(skip && s === "")) parts.push(s); }
  return parts.join(d);
});
def("SUBSTITUTE", 3, 4, "text", (a) => {
  const s = toText(a[0]), o = toText(a[1]), n = toText(a[2]);
  if (isErr(s)) return s; if (isErr(o)) return o; if (isErr(n)) return n;
  if (o === "") return s;
  if (a.length < 4) return s.split(o).join(n);
  const inst = toNum(a[3]); if (isErr(inst)) return inst;
  let at = -1;
  for (let k = 0; k < inst; k++) { at = s.indexOf(o, at + 1); if (at < 0) return s; }
  return s.slice(0, at) + n + s.slice(at + o.length);
});
def("REPLACE", 4, 4, "text", (a) => {
  const s = toText(a[0]), n = toText(a[3]); const st = toNum(a[1]), len = toNum(a[2]);
  if (isErr(s)) return s; if (isErr(n)) return n; if (isErr(st)) return st; if (isErr(len)) return len;
  return s.slice(0, st - 1) + n + s.slice(st - 1 + len);
});
const finder = (ci: boolean) => (a: Value[]): Value => {
  let f = toText(a[0]), w = toText(a[1]);
  if (isErr(f)) return f; if (isErr(w)) return w;
  const st = a.length > 2 ? toNum(a[2]) : 1; if (isErr(st)) return st;
  if (ci) { f = f.toLowerCase(); w = w.toLowerCase(); }
  const at = w.indexOf(f, Math.max(0, st - 1));
  return at < 0 ? VALUE : at + 1;
};
def("FIND", 2, 3, "num", finder(false));
def("SEARCH", 2, 3, "num", finder(true));
def("EXACT", 2, 2, "bool", ([a, b]) => { const x = toText(a), y = toText(b); return isErr(x) ? x : isErr(y) ? y : x === y; });
def("REPT", 2, 2, "text", (a) => { const s = toText(a[0]), n = toNum(a[1]); return isErr(s) ? s : isErr(n) ? n : s.repeat(Math.max(0, Math.floor(n))); });
def("VALUE", 1, 1, "num", ([a]) => toNum(a));
def("TEXT", 2, 2, "text", ([v, f]) => { const fmt = toText(f); return isErr(fmt) ? fmt : formatText(v, fmt); });

// dates (a date is an Excel serial number, as in Excel itself)
def("TODAY", 0, 0, "date", () => msToSerial(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
def("NOW", 0, 0, "date", () => msToSerial(Date.now()));
def("DATE", 3, 3, "date", (a) => withNums(a, ([y, m, d]) => serialOf(y, 1, 1) + (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000));
def("YEAR", 1, 1, "num", num((x) => ymd(x).y));
def("MONTH", 1, 1, "num", num((x) => ymd(x).m));
def("DAY", 1, 1, "num", num((x) => ymd(x).d));
def("WEEKDAY", 1, 2, "num", (a) => withNums(a, ([x, type = 1]) => { const w = ymd(x).dow; return type === 2 ? (w === 0 ? 7 : w) : type === 3 ? (w + 6) % 7 : w + 1; }));
def("EDATE", 2, 2, "date", (a) => withNums(a, ([x, n]) => { const { y, m, d } = ymd(x); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return serialOf(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last)); }));
def("EOMONTH", 2, 2, "date", (a) => withNums(a, ([x, n]) => { const { y, m } = ymd(x); const t = new Date(Date.UTC(y, m - 1 + n + 1, 0)); return serialOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }));
def("DAYS", 2, 2, "num", (a) => withNums(a, ([end, start]) => Math.floor(end) - Math.floor(start)));
def("DATEDIF", 3, 3, "num", (a) => {
  const s = toNum(a[0]), e = toNum(a[1]), u = toText(a[2]);
  if (isErr(s)) return s; if (isErr(e)) return e; if (isErr(u)) return u;
  if (e < s) return NUM;
  const A = ymd(s), B = ymd(e);
  const months = (B.y - A.y) * 12 + (B.m - A.m) - (B.d < A.d ? 1 : 0);
  switch (u.toUpperCase()) {
    case "D": return Math.floor(e) - Math.floor(s);
    case "M": return months;
    case "Y": return Math.floor(months / 12);
    case "YM": return ((months % 12) + 12) % 12;
    case "MD": { const base = serialOf(B.m === 1 ? B.y - 1 : B.y, B.m === 1 ? 12 : B.m - 1, 1); const prevLen = ymd(base + 31).m === ymd(base).m ? 31 : new Date(Date.UTC(ymd(base).y, ymd(base).m, 0)).getUTCDate(); return B.d >= A.d ? B.d - A.d : prevLen - A.d + B.d; }
    case "YD": { let y = A.y; let anniv = serialOf(B.y, A.m, A.d); if (anniv > e) { y = B.y - 1; anniv = serialOf(y, A.m, A.d); } return Math.floor(e) - Math.floor(anniv); }
    default: return NUM;
  }
});
def("NETWORKDAYS", 2, 2, "num", (a) => withNums(a, ([s, e]) => { let n = 0; const dir = e >= s ? 1 : -1; for (let d = Math.floor(s); dir > 0 ? d <= Math.floor(e) : d >= Math.floor(e); d += dir) { const w = ymd(d).dow; if (w !== 0 && w !== 6) n += dir; } return n; }));

// over a whole column
def("COUNTIF", 2, 2, "num", undefined);
def("COUNTIFS", 2, Infinity, "num", undefined);
def("SUMIF", 2, 3, "num", undefined);
def("SUMIFS", 3, Infinity, "num", undefined);
def("AVERAGEIF", 2, 3, "num", undefined);
const AGGREGATES = new Set(["MIN", "MAX", "SUM", "AVERAGE", "COUNT", "COUNTA", "MEDIAN"]);
const CONDITIONAL = new Set(["COUNTIF", "COUNTIFS", "SUMIF", "SUMIFS", "AVERAGEIF"]);

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

// ---------- compile and run ----------

export interface Compiled {
  kind: Kind;
  /** Columns the formula reads. */
  columns: string[];
  run(table: Table): { values: Cell[]; errors: number };
}

function staticKind(n: Node): Kind {
  switch (n.t) {
    case "num": case "neg": case "pct": return "num";
    case "str": return "text";
    case "bool": return "bool";
    case "col": return "any";
    case "bin": {
      if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) return "bool";
      if (n.op === "&") return "text";
      if (n.op === "+" || n.op === "-") {
        const a = staticKind(n.a), b = staticKind(n.b);
        if (a === "date" && b === "num") return "date";
        if (a === "num" && b === "date" && n.op === "+") return "date";
        if (a === "date" && b === "date") return "num";
      }
      return "num";
    }
    case "call": {
      const spec = FUNCTIONS[n.fn];
      if (spec.kind !== "any") return spec.kind;
      const kinds = (n.fn === "IFS" ? n.args.filter((_, i) => i % 2 === 1) : n.fn === "SWITCH" ? n.args.slice(2).filter((_, i) => i % 2 === 0) : n.fn === "IF" ? n.args.slice(1) : n.args).map(staticKind);
      return kinds.length && kinds.every((k) => k === kinds[0]) ? kinds[0] : "any";
    }
  }
}

function collectColumns(n: Node, out: Set<string>): void {
  if (n.t === "col") out.add(n.name);
  else if (n.t === "neg" || n.t === "pct") collectColumns(n.a, out);
  else if (n.t === "bin") { collectColumns(n.a, out); collectColumns(n.b, out); }
  else if (n.t === "call") n.args.forEach((a) => collectColumns(a, out));
}

/** A table cell as a formula value: dates become Excel serial numbers, blanks become null. */
function columnValues(c: Column): Value[] {
  if (c.kind === "date") {
    const times = timesOf(c);
    return c.values.map((v, i) => (times[i] === null ? null : typeof v === "number" ? v : msToSerial(times[i]!)));
  }
  return c.values.map((v) => (v === null || v === "" ? null : (v as Value)));
}

/**
 * Parse a formula. `resolve` maps each column name used in it to the real column name, or throws a
 * FormulaSyntaxError ("I couldn't find a column called ...").
 */
export function compileFormula(source: string, resolve: (name: string) => string): Compiled {
  const text = source.trim().replace(/^=/, "");
  if (!text) throw new FormulaSyntaxError("The formula is empty.");
  const root = new Parser(tokenize(text), resolve).parse();
  const used = new Set<string>();
  collectColumns(root, used);

  return {
    kind: staticKind(root),
    columns: [...used],
    run(table: Table) {
      const cache = new Map<string, Value[]>();
      const colVals = (name: string): Value[] => {
        let v = cache.get(name);
        if (!v) {
          const c = table.columns.find((x) => x.name === name);
          if (!c) throw new PlanError(`Unknown column(s): ${name}`);
          v = columnValues(c);
          cache.set(name, v);
        }
        return v;
      };
      const ctx: Ctx = { n: table.nrows, table, columnValues: colVals, memo: new Map() };
      let row = 0;
      const build = (n: Node): (() => Value) => {
        switch (n.t) {
          case "num": return () => n.v;
          case "str": return () => n.v;
          case "bool": return () => n.v;
          case "col": { const v = colVals(n.name); return () => v[row]; }
          case "neg": { const a = build(n.a); return () => { const x = toNum(a()); return isErr(x) ? x : -x; }; }
          case "pct": { const a = build(n.a); return () => { const x = toNum(a()); return isErr(x) ? x : x / 100; }; }
          case "bin": return binary(n.op, build(n.a), build(n.b));
          case "call": return call(n);
        }
      };
      const binary = (op: string, a: () => Value, b: () => Value): (() => Value) => {
        if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
          return () => {
            const x = a(), y = b();
            if (isErr(x)) return x; if (isErr(y)) return y;
            const d = compareValues(x, y);
            return op === "=" ? d === 0 : op === "<>" ? d !== 0 : op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
          };
        }
        if (op === "&") return () => { const x = toText(a()), y = toText(b()); return isErr(x) ? x : isErr(y) ? y : x + y; };
        return () => {
          const x = toNum(a()), y = toNum(b());
          if (isErr(x)) return x; if (isErr(y)) return y;
          switch (op) {
            case "+": return x + y;
            case "-": return x - y;
            case "*": return x * y;
            case "/": return y === 0 ? DIV0 : x / y;
            default: { const r = x ** y; return Number.isFinite(r) ? r : NUM; }
          }
        };
      };
      const columnArg = (n: Node, fn: string): Value[] => {
        if (n.t !== "col") throw new PlanError(`${fn} needs a column here, like ${fn}([amount]...).`);
        return colVals(n.name);
      };
      const call = (n: Extract<Node, { t: "call" }>): (() => Value) => {
        const spec = FUNCTIONS[n.fn];
        if (spec.lazy) { const args = n.args.map(build); return () => spec.lazy!(args, ctx); }
        if (AGGREGATES.has(n.fn)) {
          // A column inside SUM/AVERAGE/MIN/MAX/COUNT/MEDIAN means the whole column (computed once).
          const parts: ({ col: Value[] } | { one: () => Value })[] = n.args.map((a) => (a.t === "col" ? { col: colVals(a.name) } : { one: build(a) }));
          let total: Value | undefined;
          const whole = parts.every((p) => "col" in p);
          const compute = (): Value => {
            const nums: number[] = [];
            let count = 0, countA = 0;
            for (const p of parts) {
              const vals: Value[] = "col" in p ? p.col : [p.one()];
              for (const v of vals) {
                if (isErr(v)) return v;
                if (v !== null && v !== "") countA++;
                if (typeof v === "number") { nums.push(v); count++; }
              }
            }
            switch (n.fn) {
              case "SUM": return nums.reduce((s, x) => s + x, 0);
              case "AVERAGE": return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : DIV0;
              case "MIN": return nums.length ? nums.reduce((s, x) => Math.min(s, x), Infinity) : 0;
              case "MAX": return nums.length ? nums.reduce((s, x) => Math.max(s, x), -Infinity) : 0;
              case "COUNT": return count;
              case "COUNTA": return countA;
              default: { const s = [...nums].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NUM; }
            }
          };
          const hasRowValue = parts.some((p) => "one" in p);
          return () => {
            if (whole || !hasRowValue) { if (total === undefined) total = compute(); return total; }
            return compute();
          };
        }
        if (CONDITIONAL.has(n.fn)) {
          const fn = n.fn;
          const sumFirst = fn === "SUMIFS";
          const rangeNodes: Node[] = [], critNodes: Node[] = [];
          let sumNode: Node | null = null;
          if (fn === "COUNTIF") { rangeNodes.push(n.args[0]); critNodes.push(n.args[1]); }
          else if (fn === "SUMIF" || fn === "AVERAGEIF") { rangeNodes.push(n.args[0]); critNodes.push(n.args[1]); sumNode = n.args[2] ?? n.args[0]; }
          else {
            const rest = sumFirst ? n.args.slice(1) : n.args;
            if (sumFirst) sumNode = n.args[0];
            if (rest.length % 2) throw new PlanError(`${fn} needs a column and a condition for each test.`);
            for (let k = 0; k < rest.length; k += 2) { rangeNodes.push(rest[k]); critNodes.push(rest[k + 1]); }
          }
          const ranges = rangeNodes.map((r) => columnArg(r, fn));
          const sumRange = sumNode ? columnArg(sumNode, fn) : null;
          const crits = critNodes.map(build);
          const kind = fn.startsWith("COUNT") ? "count" : fn.startsWith("AVERAGE") ? "average" : "sum";
          const memoKey = `${fn}:${rangeNodes.map((r) => (r as { name: string }).name).join(",")}:${sumNode ? (sumNode as { name: string }).name : ""}`;
          return () => conditional(kind, sumRange, ranges, crits.map((c) => c()), ctx, memoKey);
        }
        const args = n.args.map(build);
        return () => {
          const vals: Value[] = [];
          for (const a of args) { const v = a(); if (isErr(v) && !["ISERROR", "ISNA"].includes(n.fn)) return v; vals.push(v); }
          return spec.strict!(vals, ctx);
        };
      };
      const evalRow = build(root);
      const values: Cell[] = new Array(table.nrows);
      let errors = 0;
      for (row = 0; row < table.nrows; row++) {
        const v = evalRow();
        if (isErr(v)) { errors++; values[row] = null; }
        else if (typeof v === "number") values[row] = Number.isFinite(v) ? Number(v.toFixed(10)) : null;
        else values[row] = v === "" ? null : v;
      }
      return { values, errors };
    },
  };
}

/** Bare words and [bracketed names] -> a real column, by exact name (ignoring case, spaces, underscores). */
export function columnResolver(names: string[]): (name: string) => string {
  const byKey = new Map(names.map((n) => [key(n), n]));
  return (name) => {
    const hit = byKey.get(key(name));
    if (hit !== undefined) return hit;
    const near = closeMatch(key(name), [...byKey.keys()], 0.6);
    throw new FormulaSyntaxError(`I couldn't find a column called '${name}'.` + (near ? ` Did you mean ${byKey.get(near)}?` : ` Columns: ${names.join(", ")}`));
  };
}

// ---------- to a real Excel formula ----------

/** Is argument `i` of `fn` a whole column (SUM(amount), COUNTIF(type, ...)) rather than this row's value? */
function isWholeColumnArg(fn: string, i: number): boolean {
  if (AGGREGATES.has(fn)) return true;
  switch (fn) {
    case "COUNTIF": return i === 0;
    case "COUNTIFS": return i % 2 === 0;
    case "SUMIF": case "AVERAGEIF": return i === 0 || i === 2;
    case "SUMIFS": return i === 0 || i % 2 === 1;
    default: return false;
  }
}

const xlQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const xlName = (name: string) => name.replace(/([[\]#'])/g, "'$1");

/**
 * The same formula as Excel would hold it in a Table: [@[amount]] for "this row's amount" and Table[[amount]] for a
 * whole column (inside SUM, COUNTIF and friends). Errors become blank, like they do in the add-in's own result.
 */
export function toExcelFormula(source: string, tableName: string, resolve: (name: string) => string): string {
  const root = new Parser(tokenize(source.trim().replace(/^=/, "")), resolve).parse();
  const wholeColumn = (name: string) => `${tableName}[[${xlName(name)}]]`;
  const walk = (n: Node, whole = false): string => {
    switch (n.t) {
      case "num": return String(n.v);
      case "str": return xlQuote(n.v);
      case "bool": return n.v ? "TRUE" : "FALSE";
      case "col": return whole ? wholeColumn(n.name) : `[@[${xlName(n.name)}]]`;
      case "neg": return `-(${walk(n.a)})`;
      case "pct": return `(${walk(n.a)})%`;
      case "bin": return `(${walk(n.a)}${n.op}${walk(n.b)})`;
      case "call": return `${n.fn}(${n.args.map((arg, i) => walk(arg, arg.t === "col" && isWholeColumnArg(n.fn, i))).join(",")})`;
    }
  };
  return `=IFERROR(${walk(root)},"")`;
}
