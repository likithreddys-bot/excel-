/**
 * Rule-based parser: turns a plain-English command into a typed Plan. No AI/ML.
 * A line-by-line port of planner.py (the Python reference), covering filter, sort, split, dedupe and
 * column choice. Commands the add-in can't run yet are recognised and answered honestly instead of guessed at.
 */
import { COLORS, describe } from "./describe";
import { applyPlan, PlanError } from "./engine";
import { FORMULA_FUNCTIONS, FormulaSyntaxError, columnResolver, compileFormula } from "./formula";
import type { Aggregation, Condition, DatePartStep, FilterStep, GroupByStep, PivotStep, Plan, SortStep, Step, TopNStep } from "./plan";
import { Cell, Column, Sheets, Table, combine, isBlankCell } from "./table";
import {
  MONTHS, DAY_MS, closeMatch, colWords, fmt, isoDay, key, parseDate, parseNumber, similarity, singular, utcDay,
} from "./util";

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const STOP = set(`a an the and or by of in on to for with where is are all any only just keep show rows row records data
  sheet sheets file last first next past days day month months year years week weeks that this than more less
  over under each every into from not no be it them`);
const FILLER_WORDS = new Set([...STOP, ...set(`filter remove exclude delete drop hide out get rid give me
  find list select include entries lines items ones which whose having if when please everything except excluding
  without take leave who have has been was were also then now`)]);

const MAX_SPLIT_SHEETS = 50;
const DATE_UNITS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const AMOUNT_WORDS = set("amount amt value price total revenue sales cost");
const ID_WORDS = set("id no num number code pin zip phone mobile account acct");

const VERB = String.raw`(?:sort|order|arrange|split|segregate|separate|keep|remove|drop|delete|exclude|filter` +
  String.raw`|show|dedupe|group|select|get|give|calculate|compute|find|hide|add|rank|pivot|top|bottom` +
  String.raw`|rename|replace|trim|fill|merge|combine|convert|change|make|capitali[sz]e` +
  String.raw`|create|insert|set|update|round|label|tag|flag|mark` +
  String.raw`|bring|look\s*up|lookup|vlookup|xlookup|fetch|pull|append|compare|match` +
  String.raw`|highlight|colou?r|shade|format|display|draw|plot|do)`;
const CLAUSE_SPLIT = new RegExp(
  String.raw`\s*(?:[;\n]+|(?<![Rr][Ss])\.\s+|\.$|,?\s*\b(?:and\s+then|and\s+also|and\s+now|then|also|now|and)\s+(?=${VERB}\b)` +
  String.raw`|,\s*(?=${VERB}\b))\s*`, "i");
const NEXT_ASSIGNMENT = /(?:\s*,\s*|\s+)(?:and\s+)?(?=[A-Za-z_][\w%.]*\s*=(?!=))/gi;

const GROUP_MARKER = /\b(?:grouped\s+by|group\s+by|by|per|for\s+each|for\s+every|across|each|wrt|with\s+respect\s+to)\b/i;
const PIVOT = /\bpivot\w*|\bcross[\s-]?tab\w*|\bmatrix\b|\b(?:as|in)\s+(?:the\s+)?columns\b|\bacross\b/i;
const PERCENT = /(?:,?\s*\b(?:with|and|plus|including)\s+(?:a\s+|the\s+)?)?(?:(?<!\w)%|\bpercent(?:age)?s?\b|\bshare\b)(?:\s+of\s+(?:the\s+)?(?:grand\s+)?total)?/i;
const TOP_N = /\b(top|bottom|first|last|highest|lowest|largest|smallest|biggest|latest|newest|oldest|earliest)\s+(\d+)\b(?!\s*(?:days?|weeks?|months?|years?)\b)/i;
const DATE_PART_SRC = String.raw`\b(year|quarter|month|weekday|week|day\s+of\s+(?:the\s+)?week|day)(?:s|ly)?\b|\b(daily|annual(?:ly)?)\b`;
const PREFIXED_DATE_PART = /(?<![A-Za-z0-9_])(?<pre>[A-Za-z0-9]+)[_ ](?<part>year|quarter|month|weekday|week|day)(?![A-Za-z0-9_])/gi;

const SMART_QUOTES: Record<string, string> = { "“": '"', "”": '"', "‘": "'", "’": "'" };
const QUOTED = /"[^"]*"|(?<!\w)'[^']*'(?!\w)/g;
const CASE = /\b(?:upper|lower|title|proper|sentence)[\s-]*case[sd]?\b|\b(?:uppercase|lowercase|capitali[sz]e[sd]?|all\s+caps|in\s+caps)\b/i;
const TRIM = new RegExp(
  String.raw`\btrim(?:med)?\b(?:\s+(?:the\s+)?(?:extra\s+)?(?:white\s*)?spaces?)?` +
  String.raw`|\b(?:strip|remove|clean(?:\s+up)?|fix|delete)\s+(?:all\s+)?(?:the\s+)?` +
  String.raw`(?:(?:extra|leading|trailing|double|unnecessary|additional)\s+(?:and\s+)?)*(?:white\s*)?spaces?\b`, "i");
const CONVERT = new RegExp(
  String.raw`^\s*(?:please\s+)?(?:convert|change|make|set|treat|format|turn|cast)\s+(?:the\s+)?(?:columns?\s+)?` +
  String.raw`(?<cols>.+?)\s+(?:(?:to|as|into)\s+)?(?:an?\s+)?(?:proper\s+|real\s+)?` +
  String.raw`(?<to>numbers?|numeric|integers?|decimals?|dates?|text|strings?)(?:\s+(?:format|type|values?))?\s*$`, "i");
const NUMBER_FORMAT = new RegExp(
  String.raw`^\s*(?:please\s+)?(?:format|show|display|make|set|put)\s+(?:the\s+)?(?<cols>.+?)\s+(?:as|in|with|to|using)\s+(?:an?\s+)?` +
  String.raw`(?<style>rupees?|inr|₹|indian\s+(?:rupees?|format|currency)|currency|money|commas?|comma\s+separators?` +
  String.raw`|thousands?\s+separators?|percent(?:age)?s?|%|(?<dec>\d+|no|zero|one|two|three)\s+decimals?(?:\s+places?)?` +
  String.raw`|whole\s+numbers?|integers?|(?<date>(?:dd|d|mm|mmm|yyyy|yy)[/\-. ](?:dd|d|mm|mmm|yyyy|yy)[/\-. ](?:dd|d|mm|mmm|yyyy|yy)))` +
  String.raw`(?:\s+format)?\s*$`, "i");

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const BLANK_WORDS = new Set(["", "blank", "blanks", "empty", "empties", "empty cells", "empty values", "blank cells",
  "blank values", "nothing", "null", "nulls", "missing", "missing values"]);
const DATEDIFF = new RegExp(
  String.raw`^(?:the\s+)?(?:number\s+of\s+|no\.?\s+of\s+)?(?<unit>day|week|month|year)s?\s+` +
  String.raw`(?:(?:since|from|after)\s+(?<a>.+?)(?:\s+(?:to|until|till)\s+(?<b>.+?))?` +
  String.raw`|between\s+(?<a2>.+?)\s+and\s+(?<b2>.+?)|(?:until|till|to|before)\s+(?<b3>.+?))\s*$` +
  String.raw`|^age\s+(?:from|of|using|based\s+on)\s+(?<dob>.+?)\s*$`, "i");

const DELIMITERS: Record<string, string> = {
  comma: ",", commas: ",", space: " ", spaces: " ", dash: "-", hyphen: "-", slash: "/", "forward slash": "/",
  backslash: "\\", pipe: "|", underscore: "_", colon: ":", semicolon: ";", dot: ".", period: ".", "full stop": ".",
  tab: "\t", nothing: "", "no space": "",
};

const IDENTIFIER_WORDS = set(`id pan email account acct ref key uid gstin aadhaar mobile phone customer client employee emp`);
const FILE_VERBS = new RegExp(
  String.raw`\b(?:look\s*up|lookup|v\s*lookup|x\s*lookup|match(?:ing|ed)?|bring|fetch|pull|get|add|map|join|merge|enrich|append|stack|compare` +
  String.raw`|not\s+in|missing|only\s+in|in\s+both|common|also\s+in|present\s+in|found\s+in|difference|diff|not\s+here|but\s+not)\b`, "i");

const WHAT_IT_CAN_DO = "Right now the add-in can filter rows, sort, split into sheets, remove duplicates and choose columns.";

export class ParseError extends Error {
  constructor(message: string, public awaitsColumns = false) {
    super(message);
  }
}

const soon = (what: string): never => {
  throw new ParseError(`${what} is coming to the add-in in the next update. ${WHAT_IT_CAN_DO}`);
};

interface Mention { start: number; end: number; column: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const strip = (s: string, chars: string): string => {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Most values read as amounts once ₹, Rs. and commas are ignored ("₹1,200", "Rs. 90"). */
function looksLikeAmounts(c: Column): boolean {
  const strings = c.values.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, 200);
  return strings.length > 0 && strings.filter((s) => parseNumber(s.replace(/\s+/g, " ")) !== null).length / strings.length >= 0.8;
}
const sortedText = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const unquote = (v: string): string => {
  v = v.trim();
  return v.length >= 2 && v[0] === v[v.length - 1] && `"'`.includes(v[0]) ? v.slice(1, -1) : v;
};

const cleanValue = (v: string): string => {
  v = strip(v.trim(), ".,");
  v = v.replace(/\s+(?:only|rows?|records?|entries|transactions?|ones)$/i, "");
  return strip(v.trim(), `'"`);
};

const splitList = (raw: string): string[] =>
  raw.split(/\s*,\s*|\s+or\s+|\s+and\s+|\s*\/\s*/i).map((p) => strip(p.trim(), `'"`)).filter((p) => p.trim());

const NEGATIONS: Record<string, Condition["operator"]> = {
  equals: "not_equals", contains: "not_contains", in: "not_in", is_empty: "not_empty",
  gt: "lte", gte: "lt", within_last_days: "older_than_days",
};
for (const [k, v] of Object.entries({ ...NEGATIONS })) NEGATIONS[v] = k as Condition["operator"];

const negate = (c: Condition): Condition => ({ ...c, operator: NEGATIONS[c.operator] });

function mergeSameColumn(conds: Condition[], match: "all" | "any"): [Condition[], "all" | "any"] {
  if (match !== "all") return [conds, match];
  const groups = new Map<string, Condition[]>();
  for (const c of conds) if (c.operator === "equals" || c.operator === "in") groups.set(c.column, [...(groups.get(c.column) ?? []), c]);
  const out: Condition[] = [];
  const done = new Set<string>();
  for (const c of conds) {
    const g = groups.get(c.column) ?? [];
    if ((c.operator === "equals" || c.operator === "in") && g.length > 1) {
      if (!done.has(c.column)) {
        const vals = g.flatMap((x) => x.values ?? [x.value as string]);
        out.push({ column: c.column, operator: "in", values: unique(vals) });
        done.add(c.column);
      }
    } else out.push(c);
  }
  return [out, match];
}

const distinct = (values: Cell[]): number => new Set(values.filter((v) => !isBlankCell(v)).map((v) => JSON.stringify(v))).size;

const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** In "monthly total amount by category" the period word joins the group-by columns. */
function movePeriodWords(head: string, tail: string): [string, string] {
  const re = /\b(?:daily|weekly|monthly|quarterly|yearly|annual(?:ly)?)\b/gi;
  const words = head.match(re);
  if (!words) return [head, tail];
  return [head.replace(re, " "), words.join(" ") + " " + tail];
}

export class Parser {
  readonly table: Table;
  readonly columns: string[];
  readonly colKeys: Map<string, string>;
  readonly wordCols = new Map<string, string[]>();
  readonly dateCols: string[];
  readonly numericCols: string[];
  private values: Map<string, Map<string, string>> | null = null;

  /** `answer`: columns the user gave in reply to a "which column?" question. */
  constructor(sheets: Sheets | Table, private answer: string[] = [], private computed: Record<string, string> = {}, private files: Record<string, Table> = {}) {
    this.table = sheets instanceof Map ? combine(sheets) : sheets;
    this.columns = this.table.columns.map((c) => String(c.name));
    this.colKeys = new Map(this.columns.map((c) => [c, key(c)]));
    for (const c of this.columns) {
      for (const w of colWords(c)) {
        const k = singular(w);
        this.wordCols.set(k, [...(this.wordCols.get(k) ?? []), c]);
      }
    }
    this.dateCols = this.table.columns.filter((c) => c.kind === "date").map((c) => c.name);
    this.numericCols = this.table.columns.filter((c) => c.kind === "number").map((c) => c.name);
  }

  private col(name: string) {
    return this.table.columns.find((c) => c.name === name)!;
  }

  // ---------- column / value lookup ----------

  findColumns(text: string): Mention[] {
    const toks = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, k: key(m[0]) }));
    const cands: { level: number; len: number; i: number; j: number; column: string }[] = [];
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, toks.length + 1); j++) {
        const words = toks.slice(i, j).map((t) => t.k);
        if (!words.every(Boolean) || words.every((w) => STOP.has(w))) continue;
        const k = words.join("");
        for (const [c, ck] of this.colKeys) {
          if (k === ck || singular(k) === singular(ck)) cands.push({ level: 3, len: j - i, i, j, column: c });
          else if (k.length >= 5 && similarity(k, ck) >= 0.88) cands.push({ level: 2, len: j - i, i, j, column: c });
        }
        if (j === i + 1 && k.length >= 4 && !STOP.has(k)) {
          const cols = this.wordCols.get(singular(k)) ?? [];
          if (cols.length === 1) cands.push({ level: 1, len: 1, i, j, column: cols[0] });
        }
      }
    }
    cands.sort((a, b) => b.level - a.level || b.len - a.len || a.i - b.i);
    const used = new Set<number>();
    const out: Mention[] = [];
    for (const c of cands) {
      let free = true;
      for (let t = c.i; t < c.j; t++) if (used.has(t)) free = false;
      if (!free) continue;
      for (let t = c.i; t < c.j; t++) used.add(t);
      out.push({ start: toks[c.i].start, end: toks[c.j - 1].end, column: c.column });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** The single column that `text` names, or null. */
  column(text: string): string | null {
    const ms = this.findColumns(text);
    let rest = text;
    for (const m of [...ms].reverse()) rest = rest.slice(0, m.start) + rest.slice(m.end);
    const ignore = new Set([...FILLER_WORDS, "column", "columns", "field", "fields"]);
    const leftover = (rest.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !ignore.has(w));
    return ms.length === 1 && !leftover.length ? ms[0].column : null;
  }

  /** Example commands that use this file's own columns and values. */
  examples(): string[] {
    const ids = new Set(this.numericCols.filter((c) => colWords(c).some((w) => ID_WORDS.has(w) || w === "num")));
    let nums = this.numericCols.filter((c) => !ids.has(c));
    if (!nums.length) nums = [...this.numericCols];
    nums.sort((a, b) => Number(!colWords(a).some((w) => AMOUNT_WORDS.has(w))) - Number(!colWords(b).some((w) => AMOUNT_WORDS.has(w))));
    const nun = (c: string) => distinct(this.col(c).values);
    let cats = this.columns.filter((c) => !this.numericCols.includes(c) && !this.dateCols.includes(c) && nun(c) >= 2 && nun(c) <= 50);
    if (!cats.length) cats = this.numericCols.filter((c) => nun(c) >= 2 && nun(c) <= 50);
    cats.sort((a, b) => nun(a) - nun(b));
    const num = nums[0], cat = cats[0];
    const out: string[] = [];
    if (num && cat) out.push(`total ${num} by ${cat}`);
    if (num && this.dateCols.length) {
      const words = colWords(this.dateCols[0]).filter((w) => !["date", "dt", "on", "at"].includes(w));
      out.push(words.length ? `pivot ${num} by ${words[0]}_month` : `total ${num} by month`);
    }
    if (num) {
      const xs = this.col(num).values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      const median = xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : NaN;
      const threshold = Number.isFinite(median) && median ? fmt(Number(median.toPrecision(2))) : "0";
      out.push(`only rows where ${num} > ${threshold}`, `sort by ${num} descending`, `top 10 by ${num}`);
    }
    if (cat) {
      const counts = new Map<string, { v: Cell; n: number }>();
      for (const v of this.col(cat).values) if (!isBlankCell(v)) {
        const k = JSON.stringify(v);
        counts.set(k, { v, n: (counts.get(k)?.n ?? 0) + 1 });
      }
      const best = [...counts.values()].sort((a, b) => b.n - a.n || (a.v! < b.v! ? -1 : 1))[0];
      out.push(`only rows where ${cat} is ${typeof best.v === "number" ? fmt(best.v) : String(best.v)}`, `split by ${cat}`);
    }
    if (nums.length >= 2) out.push(`add column ratio = ${nums[1]} * 100 / ${nums[0]}`);
    if (num) out.push(`add column size = IF(${num} > 1000, "High", "Low")`);
    out.push("keep columns " + this.columns.slice(0, 3).join(", "));
    return out.slice(0, 8);
  }

  /** singular key of each text value -> {column: original value}. */
  valueIndex(): Map<string, Map<string, string>> {
    if (this.values) return this.values;
    const index = new Map<string, Map<string, string>>();
    for (const c of this.table.columns) {
      if (c.kind !== "text") continue;
      const uniques = unique(c.values.filter((v) => v !== null).map(String));
      if (uniques.length > 20000) continue;
      for (const v of uniques) {
        const k = singular(key(v));
        if (k.length < 2) continue;
        if (!index.has(k)) index.set(k, new Map());
        index.get(k)!.set(c.name, v);
      }
    }
    return (this.values = index);
  }

  /** Map a typed value to the actual value in `col` (case/plural/typo tolerant). */
  resolveValue(col: string, raw: string): string {
    const c = this.col(col);
    if (c.kind === "number") {
      const n = parseNumber(raw);
      if (n === null) throw new ParseError(`'${raw}' is not a number, but '${col}' is a numeric column.`);
      return fmt(n);
    }
    const uniques = unique(c.values.filter((v) => v !== null).map(String));
    const byKey = new Map(uniques.map((v) => [singular(key(v)), v]));
    const k = singular(key(raw));
    const hit = byKey.get(k);
    if (hit !== undefined) return hit;
    const close = byKey.size <= 20000 ? closeMatch(k, [...byKey.keys()], 0.85) : null;
    if (close !== null) return byKey.get(close)!;
    throw new ParseError(`'${raw}' doesn't appear in column '${col}'. Values there include: ${sortedText(uniques).slice(0, 15).join(", ")}`);
  }

  /** One value ("Food and Dining") if it exists as-is, otherwise a list ("food, travel"). */
  resolveValues(col: string, raw: string): string[] {
    try {
      return [this.resolveValue(col, raw)];
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const parts = splitList(raw);
      if (parts.length === 1) throw e;
      return parts.map((v) => this.resolveValue(col, v));
    }
  }

  andOrPhrases(): string[] {
    const found = this.columns.filter((c) => /\s(?:and|or)\s/i.test(c));
    for (const hits of this.valueIndex().values()) for (const v of hits.values()) if (/\s(?:and|or)\s/i.test(v)) found.push(v);
    return unique(found).sort((a, b) => b.length - a.length);
  }

  defaultNumberColumn(): string {
    const answered = this.answer.filter((c) => this.numericCols.includes(c));
    if (answered.length) return answered[0];
    const cands = this.numericCols.filter((c) => !colWords(c).some((w) => ID_WORDS.has(w)));
    const amountish = cands.filter((c) => colWords(c).some((w) => AMOUNT_WORDS.has(w)));
    if (cands.length === 1) return cands[0];
    if (amountish.length === 1) return amountish[0];
    if (!this.numericCols.length) {
      // No real numbers at all: say so, and point at columns that look like amounts saved as text.
      const textual = this.table.columns.filter((c) => c.kind === "text" && looksLikeAmounts(c)).map((c) => c.name);
      if (textual.length) {
        throw new ParseError(`No column holds numbers yet. ${textual.map((c) => `'${c}'`).join(" and ")} looks like amounts saved as text, so it can't be added up. `
          + `Try: convert ${textual[0]} to number`);
      }
    }
    throw new ParseError("Which column should the number apply to? Reply with the column name(s). Numeric columns: "
      + (cands.length ? cands : this.numericCols.length ? this.numericCols : ["(none)"]).join(", "), true);
  }

  defaultDateColumn(text: string): string {
    for (const m of this.findColumns(text)) if (this.dateCols.includes(m.column)) return m.column;
    if (this.dateCols.length === 1) return this.dateCols[0];
    if (!this.dateCols.length) throw new ParseError("I couldn't find a date column in this file.");
    throw new ParseError("Which date column do you mean? Date columns: " + this.dateCols.join(", "));
  }

  // ---------- clauses ----------

  parseClause(cl: string): Step[] {
    const low = cl.toLowerCase();
    if (Object.keys(this.files).length && FILE_VERBS.test(cl)) {
      const fm = this.findFile(cl);
      if (fm) return this.parseFileCommand(cl, fm);
    }
    // Formatting first: "highlight duplicates in pan" must colour rows, never remove them.
    const ff = /^\s*(?:please\s+)?(keep|show|only|select|filter|remove|delete|drop|exclude|hide)(?:\s+(?:only\s+)?(?:the\s+)?rows?)?\s+(?:where|if|when|with|for)\s*=\s*(.+)$/i.exec(cl);
    if (ff) return [this.formulaFilter(ff[2], !/^(?:remove|delete|drop|exclude|hide)$/i.test(ff[1]))];
    const formatting = this.formatCommand(cl);
    if (formatting !== null) return formatting;
    if (/\bduplicat|\bde-?dup|\b(?:unique|distinct)\s+rows\b/.test(low)) return [this.parseDedupe(cl)];
    const formula = this.formulaCommand(cl);
    if (formula !== null) return formula;
    const cleaning = this.cleaningCommand(cl);
    if (cleaning !== null) return cleaning;
    if (/\b(?:split|segregate|separate|seperate|segment|divide|partition)\b|\bbreak\b.*\b(?:up|down|into)\b|\b(?:sheets?|tabs?|files?)\s+(?:per|for\s+each|by)\b/.test(low)) {
      return this.parseSplit(cl);
    }
    if (TOP_N.test(low)) return this.parseTopN(cl);
    if (/\brank(?:ed|ing)?\b|\b(?:running|cumulative)\b/.test(low) || (PERCENT.test(low) && !this.isGroup(low.replace(new RegExp(PERCENT.source, "gi"), " ")))) {
      return this.parseCalculate(cl);
    }
    if (/\b(?:sort|sorted|arrange)\b|\border(?:ed)?\s+(?:\w+\s+)?by\b/.test(low)) return [this.parseSort(cl)];
    if (PIVOT.test(low)) return this.parsePivot(cl);
    if (this.isGroup(low)) return this.parseGroup(cl);
    const step = this.parseColumns(cl);
    if (step) return [step];
    return [this.parseFilter(cl)];
  }

  private isGroup(low: string): boolean {
    return /\b(?:totals?|sums?|counts?|averages?|avg|mean|how\s+many|number\s+of|min|max|minimum|maximum|lowest|highest|smallest|largest|biggest|unique|distinct|summar\w*|group(?:ed)?)\b/i.test(low)
      && GROUP_MARKER.test(low);
  }

  /** Commands that make a new column. Returns null if `cl` isn't one. */
  private formulaCommand(cl: string): Step[] | null {
    const text = cl.trim().replace(/\.+$/, "");
    if (/^=/.test(text)) throw new ParseError("Give the new column a name, e.g. add column grade = IF([amount] > 50000, \"High\", \"Low\")");
    let m = /^\s*(?:please\s+)?round(?:\s+off)?\s+(?:the\s+)?(?:column\s+)?(?<x>.+?)(?:\s+to\s+(?<n>\d+|one|two|three|four)\s+(?:decimals?|decimal\s+places?|places?|digits?))?\s*$/i.exec(text);
    if (m) {
      const c = this.column(m.groups!.x);
      if (c === null) throw new ParseError("Which column should I round? Columns: " + this.numericCols.join(", "));
      const n = NUMBER_WORDS[(m.groups!.n ?? "0").toLowerCase()] ?? parseInt(m.groups!.n ?? "0", 10);
      return [{ op: "compute", name: c, expr: `round([${c}], ${n})`, replace: true }];
    }
    m = /^\s*(?:please\s+)?(?<verb>label|tag|flag|mark)\s+(?:the\s+)?(?:rows?\s+|transactions?\s+|records?\s+)?(?:where\s+|with\s+|that\s+have\s+|if\s+)?(?<c>.+?)(?:\s+as\s+(?<v>"[^"]*"|'[^']*'|[^,]+?))?(?:\s*,?\s*\b(?:else|otherwise)\b[\s,:]*(?<d>.+))?\s*$/i.exec(text);
    if (m) {
      const name = ["flag", "mark"].includes(m.groups!.verb.toLowerCase()) ? "flag" : "label";
      return [this.label(name, [[m.groups!.v ?? "Yes", m.groups!.c]], m.groups!.d ?? null, false)];
    }
    m = /^\s*(?:please\s+)?(?:add|calculate|compute|show|create)\s+(?:a\s+column\s+(?:for|with)\s+)?(?:the\s+)?(?<rhs>(?:number\s+of\s+)?(?:days?|weeks?|months?|years?)\s+(?:since|from|after|between|until|till|before)\b.+|age\s+(?:from|of|using|based\s+on)\s+.+)$/i.exec(text);
    if (m) {
      const rhs = m.groups!.rhs;
      const name = rhs.toLowerCase().startsWith("age") ? "age" : rhs.replace(/^number\s+of\s+/i, "");
      return [this.compute(name, rhs, true, null)];
    }
    const verb = String.raw`(?:add|create|make|insert|calculate|compute|new|set|update)`;
    m = new RegExp(String.raw`^\s*(?:please\s+)?(?<verb>${verb})\s+(?:an?\s+)?(?:new\s+)?(?:columns?|fields?|col)\s+(?:called\s+|named\s+)?(?<name>"[^"]*"|'[^']*'|.+?)\s*(?:=|:|\bas\b|\bequal\s+to\b|\bequals\b|\bwhich\s+is\b|\bthat\s+is\b|\bwith\b)\s*(?<rhs>.+)$`, "i").exec(text)
      ?? /^\s*(?:please\s+)?(?<verb>add|calculate|compute|create)\s+(?<name>.+?)\s+as\s+(?<rhs>.+)$/i.exec(text);
    if (m) return [this.compute(m.groups!.name, m.groups!.rhs, true, m.groups!.verb.toLowerCase())];
    m = new RegExp(String.raw`^\s*(?:please\s+)?(?:(?<verb>${verb})\s+)?(?<name>[^=:<>!]+?)\s*[=:]\s*(?<rhs>[^=].*)$`, "i").exec(text);
    if (m && m.groups!.name.split(/\s+/).filter(Boolean).length <= 4) {
      const verbWord = (m.groups!.verb ?? "").toLowerCase();
      if (this.column(m.groups!.name) && verbWord !== "set" && verbWord !== "update") return null; // "txn_type = DEBIT" is a filter
      return [this.compute(m.groups!.name, m.groups!.rhs, false, verbWord)];
    }
    m = /^\s*(?:please\s+)?(?:add|create|insert|make)\s+(?:an?\s+)?(?:new\s+)?(?:columns?|fields?)?\s*(?:for\s+|called\s+|named\s+)?(?<x>[^=:]+?)\s*$/i.exec(text);
    if (m) {
      const [prefix, found] = this.dims(m.groups!.x); // "add column due_month" -> month of due_date
      if (prefix.length && found.length === 1) return prefix;
    }
    return null;
  }

  private compute(name: string, rhs: string, explicit: boolean, verb: string | null): Step {
    name = unquote(name).trim().replace(/^the\s+|\s+column$/gi, "").trim();
    const existing = this.columns.find((c) => key(c) === key(name)) ?? (explicit ? null : this.column(name));
    const replace = !!existing && (verb === "set" || verb === "update");
    if (existing && !replace) {
      throw new ParseError(`There is already a column called ${existing}. Say 'set ${existing} = ...' to overwrite it, or pick a new name.`);
    }
    if (replace) name = existing!;
    const typed = this.formulaText(rhs);
    if (typed !== null) return this.formulaStep(name, typed, replace);
    if (/\bif\b|\b(?:else|otherwise)\b/i.test(rhs)) return this.labelRhs(name, rhs, replace);
    try {
      const expr = this.parseExpression(rhs);
      // Arithmetic on a date column ("date + 30") is formula territory: dates are day numbers there, as in Excel.
      const usesDate = [...expr.matchAll(/\[([^\]]+)\]/g)].some((m) => this.dateCols.includes(m[1]));
      if (usesDate && !/\b(?:days|weeks|months|years|today)\(/.test(expr)) return this.formulaStep(name, expr, replace);
      return { op: "compute", name, expr, replace };
    } catch (e) {
      // "flag = amount > 100000": a condition on its own becomes a Yes/No column.
      if (e instanceof ParseError && /[<>]|\b(?:is|are|over|under|above|below|more|less|greater|contains?|between|empty)\b/i.test(rhs)) {
        return this.label(name, [["Yes", rhs]], "No", replace);
      }
      throw e;
    }
  }

  private labelRhs(name: string, rhs: string, replace: boolean): Step {
    rhs = rhs.trim();
    const m = /^if\s+(?<c>.+?)\s+then\s+(?<v>.+?)\s*,?\s+(?:else|otherwise)\s+(?<d>.+)$/i.exec(rhs);
    if (m) return this.label(name, [[m.groups!.v, m.groups!.c]], m.groups!.d, replace);
    const dm = /\s*,?\s*\b(?:else|otherwise|or\s+else)\b[\s,:]*(?<d>.+)$/i.exec(rhs);
    const body = dm ? rhs.slice(0, dm.index) : rhs;
    const cases: [string, string][] = [];
    for (const part of body.split(/,\s*(?=(?:"[^"]*"|'[^']*'|[^,]+?)\s+if\b)/i)) {
      const pm = /^\s*(?<v>"[^"]*"|'[^']*'|.+?)\s+(?:if|when|where)\s+(?<c>.+?)\s*$/i.exec(part);
      if (!pm) throw new ParseError("Try: add column size = high if amount > 50000 else low");
      cases.push([pm.groups!.v, pm.groups!.c]);
    }
    return this.label(name, cases, dm ? dm.groups!.d : null, replace);
  }

  private label(name: string, cases: [string, string][], dflt: string | null, replace: boolean): Step {
    if (this.columns.includes(name) && !replace) {
      throw new ParseError(`There is already a column called ${name}. Say 'set ${name} = ...' to overwrite it.`);
    }
    let d = dflt ? unquote(dflt) : null;
    if (d !== null && BLANK_WORDS.has(d.toLowerCase())) d = null;
    return { op: "label", name, default: d, replace, cases: cases.map(([v, c]) => ({ when: this.parseFilter(c), value: unquote(v) })) };
  }

  /** Plain-English arithmetic -> the engine's restricted formula, e.g. '18% of amount' -> '0.18 * [amount]'. */
  private parseExpression(text: string): string {
    const t0 = text.trim().replace(/\.+$/, "");
    const dd = DATEDIFF.exec(t0);
    if (dd) {
      const g = dd.groups!;
      let unit: string, a: string, b: string;
      if (g.dob) { unit = "year"; a = g.dob; b = "today"; }
      else {
        unit = g.unit.toLowerCase();
        a = g.a ?? g.a2 ?? "today";
        b = g.b ?? g.b2 ?? g.b3 ?? "today";
      }
      return `${unit}s(${this.dateOperand(a)}, ${this.dateOperand(b)})`;
    }
    const rm = /^round(?:ed)?\s*(?:off\s+)?\(?\s*(?<x>.+?)\s*(?:,\s*|\s+to\s+)(?<n>\d+)\s*(?:decimals?|(?:decimal\s+)?places?)?\s*\)?$/i.exec(t0);
    if (rm) return `round(${this.parseExpression(rm.groups!.x)}, ${rm.groups!.n})`;
    // "amount + 18%" means "amount increased by 18%", as people mean it, not amount + 0.18.
    const pm = /^(?<base>.+?)\s*(?<op>[+-]|\bplus\b|\bminus\b)\s*(?<p>\d+(?:\.\d+)?)\s*%$/i.exec(t0);
    if (pm) {
      const sign = ["+", "plus"].includes(pm.groups!.op.toLowerCase()) ? 1 : -1;
      return `(${this.parseExpression(pm.groups!.base)}) * ${fmt(1 + (sign * parseFloat(pm.groups!.p)) / 100)}`;
    }
    // [bracketed] and "quoted" column names are set aside so "Amount (INR)" isn't split at its brackets.
    const held: string[] = [];
    let t = t0.replace(/\[[^\]]+\]|"[^"]*"|'[^']*'/g, (m) => { held.push(m.slice(1, -1)); return `__H${held.length - 1}__`; });
    t = t.replace(/\bmultiplied\s+by\b|\btimes\b|×|(?<=\s)x(?=\s)/gi, " * ")
      .replace(/\bdivided\s+by\b|÷/gi, " / ")
      .replace(/\bplus\b/gi, " + ")
      .replace(/\bminus\b/gi, " - ")
      .replace(/%\s+of\b/gi, "% * ");
    const out: string[] = [];
    for (const tok of t.split(/(\*|\/|\+|\(|\)|,|(?:(?<=\s)|^)-(?=[\s\d(]))/)) {
      const chunk = (tok ?? "").trim();
      if (!chunk) continue;
      if (["*", "/", "+", "-", "(", ")", ","].includes(chunk)) { out.push(chunk); continue; }
      out.push(this.operand(chunk.replace(/__H(\d+)__/g, (_, n: string) => held[+n])));
    }
    if (!out.length) throw new ParseError("What should the new column be? e.g. add column gst = amount * 0.18");
    return out.join(" ");
  }

  private operand(chunk: string): string {
    if (chunk.endsWith("%") && parseNumber(chunk.slice(0, -1)) !== null) return fmt(parseNumber(chunk.slice(0, -1))! / 100);
    const n = parseNumber(chunk);
    if (n !== null) return fmt(n);
    if (["abs", "round"].includes(chunk.toLowerCase())) return chunk.toLowerCase();
    if (["today", "now", "today's date"].includes(chunk.toLowerCase())) return "today()";
    const c = this.column(chunk);
    if (c) return `[${c}]`;
    if (chunk.includes("-")) { // "credit-debit" without spaces
      const parts = chunk.split("-");
      if (parts.every((p) => this.column(p) || parseNumber(p) !== null)) return parts.map((p) => this.operand(p)).join(" - ");
    }
    throw new ParseError(`I couldn't find a column called '${chunk}' for the formula. Columns: ` + this.columns.join(", "));
  }

  private dateOperand(text: string): string {
    const t = unquote(text.trim());
    if (["today", "now", "today's date", "current date", "the current date"].includes(t.toLowerCase())) return "today()";
    const c = this.column(t);
    if (c === null) throw new ParseError(`I couldn't find a date column called '${t}'. Date columns: ` + (this.dateCols.join(", ") || "(none)"));
    if (!this.dateCols.includes(c)) throw new ParseError(`'${c}' doesn't look like a date column. Date columns: ` + (this.dateCols.join(", ") || "(none)"));
    return `[${c}]`;
  }

  /** Cleaning commands, or null if `cl` isn't one. */
  private cleaningCommand(cl: string): Step[] | null {
    const low = cl.toLowerCase();
    if (/^\s*(?:please\s+)?rename\b/.test(low)) return [this.parseRename(cl)];
    if (/^\s*(?:please\s+)?(?:replace|substitute)\b/.test(low)
      || /^\s*(?:please\s+)?(?:remove|delete|strip|erase|get\s+rid\s+of|take\s+out)\s+(?:the\s+)?(?:text\s+)?["']/.test(cl)) return [this.parseReplace(cl)];
    const split = this.parseTextSplit(cl);
    if (split) return [split];
    if (/^\s*(?:please\s+)?(?:merge|combine|concatenate|concat|join)\b/.test(low)) return [this.parseMerge(cl)];
    if (/^\s*(?:please\s+)?(?:remove|delete|drop|exclude)\b/.test(low)) {
      if (/\b(?:blank|empty)\s+(?:rows|lines)\b/.test(low)) return [{ op: "drop_blank_rows", how: "all" }];
      if (/\brows?\s+(?:with|having|that\s+have|containing)\s+(?:any\s+)?(?:blank|empty|missing)(?:\s+(?:values?|cells?|fields?|data))?\s*$/.test(low)) {
        return [{ op: "drop_blank_rows", how: "any" }];
      }
    }
    const kase = CASE.exec(low);
    if (kase) {
      const word = kase[0];
      const action = /upper|caps/.test(word) ? "upper" : word.includes("lower") ? "lower" : "title";
      return [{ op: "clean_text", columns: this.textTargets(cl.replace(new RegExp(CASE.source, "gi"), " ")), action }];
    }
    if (TRIM.test(low)) return [{ op: "clean_text", columns: this.textTargets(cl.replace(new RegExp(TRIM.source, "gi"), " ")), action: "trim" }];
    if (/^\s*(?:please\s+)?fill\b/.test(low)) return [this.parseFill(cl)];
    const cv = CONVERT.exec(cl);
    if (cv) {
      const target = cv.groups!.to.toLowerCase();
      const to = target.startsWith("date") ? "date" : target.startsWith("text") || target.startsWith("string") ? "text" : "number";
      return [{ op: "convert", columns: this.columnList(cv.groups!.cols, "convert"), to }];
    }
    return null;
  }

  /** Columns named in a trim/case command; null means every text column. */
  private textTargets(text: string): string[] | null {
    const cols = unique(this.findColumns(text).map((m) => m.column));
    const numeric = cols.filter((c) => this.numericCols.includes(c));
    if (numeric.length) throw new ParseError(`${numeric.join(", ")} holds numbers, not text.`);
    return cols.length ? cols : null;
  }

  private parseRename(cl: string): Step {
    const body = cl.replace(/^\s*(?:please\s+)?rename\s+(?:the\s+)?(?:columns?\s+)?/i, "");
    const item = String.raw`(?:"[^"]*"|'[^']*'|.+?)`;
    const re = new RegExp(String.raw`(?:^|\s*(?:,|\band\b)\s*)(?<old>${item})\s+(?:to|as|into|->)\s+(?<new>${item})(?=\s*(?:,|\band\b)\s*${item}\s+(?:to|as|into|->)\s+|\s*$)`, "gi");
    const mapping: Record<string, string> = {};
    for (const p of body.matchAll(re)) {
      const old = this.column(unquote(p.groups!.old));
      if (old === null) throw new ParseError(`I couldn't find a column called '${unquote(p.groups!.old)}'. Columns: ` + this.columns.join(", "));
      mapping[old] = unquote(p.groups!.new);
    }
    if (!Object.keys(mapping).length) throw new ParseError("Try: rename amt to amount");
    return { op: "rename", mapping };
  }

  private parseReplace(cl: string): Step {
    const q = String.raw`"[^"]*"|'[^']*'`;
    const colsPart = String.raw`(?:the\s+)?(?:columns?\s+)?(?<cols>.+?)`;
    const m = new RegExp(String.raw`^\s*(?:please\s+)?(?:replace|substitute)\s+(?:all\s+)?(?<find>${q}|.+?)\s+(?:in|within)\s+${colsPart}\s+(?:with|by|->)\s+(?<rep>${q}|.+?)\s*$`, "i").exec(cl)
      ?? new RegExp(String.raw`^\s*(?:please\s+)?(?:replace|substitute)\s+(?:all\s+)?(?<find>${q}|.+?)\s+(?:with|by|->|to)\s+(?<rep>${q}|.+?)(?:\s+(?:in|on|for|within)\s+${colsPart})?\s*$`, "i").exec(cl)
      ?? new RegExp(String.raw`^\s*(?:please\s+)?(?:remove|delete|strip|erase|get\s+rid\s+of|take\s+out)\s+(?:the\s+)?(?:text\s+)?(?<find>${q})(?:\s+(?:from|in)\s+${colsPart})?\s*$`, "i").exec(cl);
    if (!m) throw new ParseError('Try: replace "UPI/" with "" in description');
    const find = unquote(m.groups!.find);
    let rep = unquote(m.groups!.rep ?? "");
    if (BLANK_WORDS.has(rep.toLowerCase())) rep = "";
    const colsText = m.groups!.cols;
    const cols = !colsText || /^\s*(?:all(?:\s+columns)?|everywhere|every\s*where|all\s+text)\s*$/i.test(colsText) ? null : this.columnList(colsText, "replace in");
    if (BLANK_WORDS.has(find.toLowerCase())) { // "replace blanks with Unknown" means fill the empty cells
      return { op: "fill_blanks", columns: cols, method: "value", value: rep };
    }
    if (!find) throw new ParseError("What text should I replace?");
    return { op: "replace", columns: cols, find, replace: rep };
  }

  private parseFill(cl: string): Step {
    const low = cl.toLowerCase();
    const method = /\bdown(?:wards?)?\b|\bforward\b|\babove\b|\bprevious\b/.test(low) ? "down"
      : /\bup(?:wards?)?\b|\bbackwards?\b|\bbelow\b|\bnext\b/.test(low) ? "up" : "value";
    let value: string | null = null;
    const vm = /\b(?:with|as|using|to)\s+(?<v>"[^"]*"|'[^']*'|.+?)(?=\s+(?:in|for|on)\s+|\s*$)/i.exec(cl);
    if (method === "value") {
      if (!vm) throw new ParseError("Fill the blanks with what? e.g. fill blank branch with Unknown, or fill down branch");
      value = unquote(vm.groups!.v);
      cl = cl.slice(0, vm.index) + " " + cl.slice(vm.index + vm[0].length);
    }
    const cols = unique(this.findColumns(cl).map((m) => m.column));
    return { op: "fill_blanks", columns: cols.length ? cols : null, method, value };
  }

  private parseTextSplit(cl: string): Step | null {
    const m = /^\s*(?:please\s+)?(?:split|separate|break)\s+(?:up\s+)?(?:the\s+)?(?:column\s+)?(?<col>.+?)\s+(?<rest>(?:into|by|on|at|using|with)\b.*)$/i.exec(cl);
    if (!m || /^(?:by|per|on|for|according|based|into|each)\b/i.test(m.groups!.col)
      || /\b(?:sheets?|tabs?|files?|workbooks?)\b/i.test(m.groups!.rest)) return null; // "split by category": one sheet per value
    const c = this.column(m.groups!.col);
    if (c === null) return null;
    let rest = m.groups!.rest;
    const dm = /\b(?:by|on|at|using|with)\s+(?:an?\s+|the\s+)?(?<d>"[^"]*"|'[^']*'|forward\s+slash|full\s+stop|\S+)/i.exec(rest);
    let delimiter = " ";
    if (dm) {
      const d = unquote(dm.groups!.d);
      delimiter = DELIMITERS[d.toLowerCase()] ?? d;
      rest = rest.slice(0, dm.index) + " " + rest.slice(dm.index + dm[0].length);
    }
    let names: string[] = [];
    const nm = /\binto\s+(?<n>.+?)\s*$/i.exec(rest);
    let count: number | null = null;
    if (nm) {
      const cm = /^(\d+|two|three|four|five|six)\s+(?:new\s+)?(?:columns?|parts?|pieces?|fields?)$/i.exec(nm.groups!.n.trim());
      if (cm) count = NUMBER_WORDS[cm[1].toLowerCase()] ?? parseInt(cm[1], 10);
      else {
        names = nm.groups!.n.split(/,|\band\b|&/i).filter((n) => n.trim()).map(unquote);
        if (names.length < 2) throw new ParseError("Split into which new columns? e.g. split name into first and last");
      }
    }
    if (!names.length) {
      if (count === null) {
        let most = 0;
        for (const v of this.col(c).values) {
          if (v === null) continue;
          most = Math.max(most, delimiter ? String(v).split(delimiter).length - 1 : 0);
        }
        count = Math.max(2, Math.min(most + 1, 10));
      }
      names = Array.from({ length: count }, (_, i) => `${c} ${i + 1}`);
    }
    return { op: "split_column", column: c, delimiter, names };
  }

  private parseMerge(cl: string): Step {
    let body = cl.replace(/^\s*(?:please\s+)?(?:merge|combine|concatenate|concat|join)\s+(?:the\s+)?(?:columns?\s+)?/i, "");
    let separator = " ";
    const sm = /\s+(?:with|using|separated\s+by|by)\s+(?:an?\s+|the\s+)?(?<s>"[^"]*"|'[^']*'|no\s+space|forward\s+slash|\S+)(?:\s+(?:separator|in\s+between|between))?/i.exec(body);
    if (sm && (`"'`.includes(sm.groups!.s[0]) || sm.groups!.s.toLowerCase() in DELIMITERS)) {
      const sep = unquote(sm.groups!.s);
      separator = DELIMITERS[sep.toLowerCase()] ?? sep;
      body = body.slice(0, sm.index) + " " + body.slice(sm.index + sm[0].length);
    }
    let name: string | null = null;
    const nm = /\s+(?:into|as|to)\s+(?:an?\s+)?(?:new\s+)?(?:column\s+)?(?:called\s+|named\s+)?(?<n>.+?)\s*$/i.exec(body);
    if (nm) {
      name = unquote(nm.groups!.n);
      body = body.slice(0, nm.index);
    }
    const cols = this.columnList(body, "merge");
    if (cols.length < 2) throw new ParseError("Merge which columns? e.g. merge first and last into full name");
    return { op: "merge_columns", columns: cols, separator, name: name || cols.join(" ") };
  }

  // ---------- Excel-style formulas ----------

  /** The formula behind `rhs`: typed in Excel syntax (IF(...), =LEFT(...)) or said in plain words. Null if it's neither. */
  private formulaText(rhs: string): string | null {
    const t = rhs.trim().replace(/\.+$/, "");
    // These stay on the older plain-English path (round(...), abs(...), days(a, b) ...); any other NAME( is a formula,
    // even a misspelt one, so the user gets "did you mean IF?" rather than a vague "couldn't understand".
    const older = new Set(["round", "abs", "days", "weeks", "months", "years", "today", "now"]);
    const call = [...t.replace(/"[^"]*"|\[[^\]]*\]/g, "").matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].some((m) => !older.has(m[1].toLowerCase()));
    if (t.startsWith("=") || call || /&/.test(t.replace(/"[^"]*"/g, ""))) return t.replace(/^=/, "");
    return this.plainFormula(t);
  }

  private formulaStep(name: string, formula: string, replace: boolean): Step {
    try {
      compileFormula(formula, columnResolver(this.columns));
    } catch (e) {
      if (e instanceof FormulaSyntaxError) throw new ParseError(e.message);
      throw e;
    }
    return { op: "formula", name, formula, replace };
  }

  private formulaFilter(formula: string, keep: boolean): Step {
    try {
      compileFormula(formula, columnResolver(this.columns));
    } catch (e) {
      if (e instanceof FormulaSyntaxError) throw new ParseError(e.message);
      throw e;
    }
    return { op: "filter_formula", formula: formula.trim(), keep };
  }

  /** Everyday phrasing for common text and date jobs, turned into the formula Excel people would write. */
  private plainFormula(t: string): string | null {
    const col = (x: string): string | null => { const c = this.column(x.trim()); return c === null ? null : `[${c}]`; };
    const lit = (x: string) => `"${unquote(x).replace(/"/g, '""')}"`;
    let m: RegExpExecArray | null;
    if ((m = /^(?:the\s+)?first\s+(\d+)\s+(?:characters?|chars?|letters?|digits?)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[2]); return c && `LEFT(${c}, ${m[1]})`; }
    if ((m = /^(?:the\s+)?last\s+(\d+)\s+(?:characters?|chars?|letters?|digits?)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[2]); return c && `RIGHT(${c}, ${m[1]})`; }
    if ((m = /^(?:the\s+)?(?:characters?|chars?|letters?)\s+(\d+)\s+(?:to|through|-)\s+(\d+)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[3]); return c && `MID(${c}, ${m[1]}, ${+m[2] - +m[1] + 1})`; }
    if ((m = /^(?:the\s+)?(?:length|number\s+of\s+characters|character\s+count)\s+of\s+(.+)$/i.exec(t))) { const c = col(m[1]); return c && `LEN(${c})`; }
    if ((m = /^(?:the\s+)?text\s+(before|after)\s+(?:the\s+)?("[^"]*"|'[^']*'|\S+)\s+(?:in|of|from)\s+(.+)$/i.exec(t))) {
      const c = col(m[3]); if (!c) return null;
      const d = lit(m[2]);
      return m[1].toLowerCase() === "before" ? `IFERROR(LEFT(${c}, FIND(${d}, ${c}) - 1), "")` : `IFERROR(MID(${c}, FIND(${d}, ${c}) + LEN(${d}), LEN(${c})), "")`;
    }
    if ((m = /^(?:the\s+)?(?:name\s+of\s+the\s+month|month\s+name)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[1]); return c && `TEXT(${c}, "mmmm")`; }
    if ((m = /^(?:the\s+)?(?:day\s+name|weekday\s+name|name\s+of\s+the\s+(?:day|weekday)|day\s+of\s+the\s+week)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[1]); return c && `TEXT(${c}, "dddd")`; }
    if ((m = /^(?:the\s+)?(year|month|day)\s+(?:of|from)\s+(.+)$/i.exec(t))) { const c = col(m[2]); return c && `${m[1].toUpperCase()}(${c})`; }
    if ((m = /^(?:the\s+)?(?:end|last\s+day)\s+of\s+(?:the\s+)?month\s+(?:of|for)\s+(.+)$/i.exec(t))) { const c = col(m[1]); return c && `EOMONTH(${c}, 0)`; }
    if ((m = /^(.+?)\s+(?:plus|\+|add)\s+(\d+)\s+(months?|years?|days?)$/i.exec(t))) {
      const c = this.column(m[1].trim());
      if (!c || !this.dateCols.includes(c)) return null;
      const n = +m[2], unit = m[3].toLowerCase();
      return unit.startsWith("month") ? `EDATE([${c}], ${n})` : unit.startsWith("year") ? `EDATE([${c}], ${12 * n})` : `[${c}] + ${n}`;
    }
    if ((m = /^(?:the\s+)?(upper|lower|proper|title)\s*case\s+(?:of\s+)?(.+)$/i.exec(t)) || (m = /^(.+?)\s+in\s+(upper|lower|proper|title)\s*case$/i.exec(t))) {
      const kind = (/^(?:upper|lower|proper|title)$/i.test(m[1]) ? m[1] : m[2]).toLowerCase();
      const c = col(/^(?:upper|lower|proper|title)$/i.test(m[1]) ? m[2] : m[1]);
      return c && `${kind === "title" ? "PROPER" : kind.toUpperCase()}(${c})`;
    }
    if ((m = /^(.+?)\s+as\s+(?:a\s+)?number$/i.exec(t))) { const c = col(m[1]); return c && `VALUE(${c})`; }
    // "amount / qty, or 0 if error": wrap the sum in IFERROR (only for plain arithmetic).
    if ((m = /^(.+?)\s*,?\s*(?:or|otherwise)\s+(.+?)\s+(?:if|when|in\s+case\s+of)\s+(?:error|invalid|missing|blank|zero\s+division|dividing\s+by\s+zero)$/i.exec(t))) {
      try {
        const expr = this.parseExpression(m[1]);
        if (/\b(?:days|weeks|months|years|round)\(/.test(expr)) return null;
        const alt = parseNumber(m[2]);
        return `IFERROR(${expr}, ${alt !== null ? fmt(alt) : lit(m[2])})`;
      } catch { return null; }
    }
    return null;
  }

  // ---------- formatting: highlight, number formats, charts ----------

  /** Commands that only change how the result looks. Null if `cl` isn't one. */
  private formatCommand(cl: string): Step[] | null {
    const low = cl.toLowerCase();
    if (/^\s*(?:please\s+)?(?:highlight|colou?r|shade)\b/.test(low)) return [this.parseHighlight(cl)];
    if (/\b(?:chart|graph|plot)\b/.test(low)) return [this.parseChart(cl)];
    const m = NUMBER_FORMAT.exec(cl);
    return m ? this.parseNumberFormat(m) : null;
  }

  private parseHighlight(cl: string): Step {
    let color = COLORS.yellow;
    const cm = /\s*\b(?:in|with|as|using)?\s*(?<shade>light|pale|dark|bright)?\s*(?<c>yellow|red|green|blue|orange|purple|pink|gr[ae]y)\b(?:\s+colou?r)?/i.exec(cl);
    if (cm) {
      const base = cm.groups!.c.toLowerCase().replace("gray", "grey");
      color = COLORS[(["dark", "bright"].includes((cm.groups!.shade ?? "").toLowerCase()) ? "dark " : "") + base];
      cl = cl.slice(0, cm.index) + " " + cl.slice(cm.index! + cm[0].length);
    }
    let body = cl.replace(/^\s*(?:please\s+)?(?:highlight|colou?r|shade)\s+(?:all\s+)?(?:the\s+)?/i, "").trim();
    const rows = /^(?:rows?|records?|transactions?|entries|lines)\b/i.test(body);
    body = body.replace(/^(?:rows?|records?|transactions?|entries|lines)\s+(?:where|with|that\s+have|having|which\s+have|whose|if|for)?\s*/i, "");
    let m = /^(?:the\s+)?(?:duplicates?|duplicate\s+values?|repeated\s+values?|repeats?)\s+(?:in|of|on)\s+(?<c>.+)$/i.exec(body)
      ?? /^(?:duplicate|repeated)\s+(?<c>.+)$/i.exec(body);
    if (m) {
      const c = this.column(m.groups!.c);
      if (c === null) throw new ParseError(`Which column should I check for duplicates? Columns: ${this.columns.join(", ")}`);
      return { op: "highlight", when: null, duplicates_in: c, column: rows ? null : c, color };
    }
    m = /^(?:the\s+)?(?:blanks?|empty(?:\s+cells?)?|missing(?:\s+values?)?)\s+(?:in|of)\s+(?<c>.+)$/i.exec(body)
      ?? /^(?:blank|empty|missing)\s+(?<c>.+)$/i.exec(body);
    if (m) {
      const c = this.column(m.groups!.c);
      if (c === null) throw new ParseError(`Which column should I check for blanks? Columns: ${this.columns.join(", ")}`);
      return { op: "highlight", when: { op: "filter", conditions: [{ column: c, operator: "is_empty" }], match: "all" }, duplicates_in: null, column: rows ? null : c, color };
    }
    const when = this.parseFilter(body);
    // "highlight amount above 50000" colours those cells; "highlight debits" (no column named) colours rows.
    const startsWithColumn = this.findColumns(body).some((x) => x.start === 0);
    const column = rows || !startsWithColumn ? null : when.conditions[0].column;
    return { op: "highlight", when, duplicates_in: null, column, color };
  }

  private parseNumberFormat(m: RegExpExecArray): Step[] {
    const g = m.groups!;
    const styleText = g.style.toLowerCase();
    let style: "rupees" | "commas" | "percent" | "decimals" | "date";
    let decimals = 2;
    let pattern: string | null = null;
    if (g.date) { style = "date"; pattern = g.date.toUpperCase(); }
    else if (/^(?:rupee|inr|₹|indian|currency|money)/.test(styleText)) style = "rupees";
    else if (/^(?:comma|thousand)/.test(styleText)) style = "commas";
    else if (/^(?:percent|%)/.test(styleText)) style = "percent";
    else {
      style = "decimals";
      const d = g.dec;
      decimals = !d || ["no", "zero"].includes(d.toLowerCase()) ? 0 : NUMBER_WORDS[d.toLowerCase()] ?? parseInt(d, 10);
    }
    const cols = /^\s*(?:all\s+)?(?:the\s+)?(?:numbers?|number\s+columns?|numeric\s+columns?|values?|everything)\s*$/i.test(g.cols)
      ? null : this.columnList(g.cols, "format");
    const steps: Step[] = [];
    if (style === "date") {
      // "15/11/2024" stored as text can't take a date format; convert it first (shown in the preview).
      const textDates = (cols ?? []).filter((c) => this.dateCols.includes(c) && this.col(c).values.some((v) => typeof v === "string"));
      if (textDates.length) steps.push({ op: "convert", columns: textDates, to: "date" });
    }
    steps.push({ op: "number_format", columns: cols, style, decimals, date_pattern: pattern ?? "DD/MM/YYYY" });
    return steps;
  }

  private parseChart(cl: string): Step {
    const low = cl.toLowerCase();
    const kind = low.includes("pie") ? "pie" : /\b(?:line|trend)\b/.test(low) ? "line" : low.includes("horizontal") ? "bar" : "column";
    let body = cl.replace(/\b(?:(?:make|create|add|draw|show|give\s+me|insert|plot)\s+)?(?:(?:as|in)\s+)?(?:an?\s+)?(?:(?:horizontal|vertical)\s+)?(?:bar|column|line|pie|trend)?\s*(?:chart|graph|plot)\b\s*(?:of|for|showing|with)?/gi, " ");
    let filters: FilterStep[];
    [body, filters] = this.extraFilters(body);
    const m = GROUP_MARKER.exec(body);
    if (!m) throw new ParseError("Chart by what? e.g. 'bar chart of total amount by category' or 'line chart of amount by month'");
    const [head, tail] = movePeriodWords(body.slice(0, m.index), body.slice(m.index + m[0].length));
    const funcs = Parser.funcsIn(head.toLowerCase());
    let values = this.findColumns(head).map((x) => x.column);
    if (values.length > 1) throw new ParseError("A chart shows one column at a time. Which one: " + values.join(", ") + "?");
    if (!values.length && /\b(?:it|that|this|them|those|the\s+result|the\s+totals?)\b/i.test(head)) values = [this.defaultNumberColumn()];
    const [prefix, found] = this.dims(tail);
    const xs = unique(found.map((x) => x.column));
    if (xs.length !== 1) throw new ParseError("Chart by which one column? e.g. '... by category' or '... by month'\nColumns here: " + this.columns.join(", "));
    let func = (funcs[0] ?? (values.length ? "sum" : "count")) as string;
    if (func === "nunique") func = "count";
    let y: string | null = func === "count" && !values.length ? null : (values[0] ?? this.defaultNumberColumn());
    if (func === "count") y = null;
    let x = xs[0], xPart: DatePartStep["part"] | null = null;
    if (prefix.length) { x = prefix[0].column; xPart = prefix[0].part; } // "by month": chart by the month of the date column
    this.checkWidth([xs[0]], prefix, "chart bars");
    let title = ({ sum: "Total", mean: "Average", count: "Count", min: "Minimum", max: "Maximum" } as Record<string, string>)[func];
    title += y ? ` ${y}` : "";
    title += ` by ${xPart ?? x}`;
    return { op: "chart", kind, x, x_part: xPart, y, func: func as "sum", title: title[0].toUpperCase() + title.slice(1), when: filters[0] ?? null };
  }

  // ---------- another sheet: lookup, append, compare ----------

  private fileParserCache = new Map<string, Parser>();

  private fileParser(name: string): Parser {
    if (!this.fileParserCache.has(name)) this.fileParserCache.set(name, new Parser(this.files[name]));
    return this.fileParserCache.get(name)!;
  }

  /** Where `text` names another sheet. A name that is also a column here only counts when it's clearly a sheet:
   * "from customers", "customers.xlsx", "customers sheet". */
  findFile(text: string): Mention | null {
    const toks = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
    const ext = /\.(?:xlsx|xlsm|xls|csv)\W*$/i;
    for (let i = 0; i < toks.length; i++) {
      for (let j = Math.min(i + 4, toks.length); j > i; j--) {
        const phrase = text.slice(toks[i].start, toks[j - 1].end);
        const hasExt = ext.test(phrase);
        const k = key(phrase.replace(ext, ""));
        for (const name of Object.keys(this.files)) {
          const fk = key(name);
          if (!(k === fk || singular(k) === singular(fk) || (j === i + 1 && k.length >= 5 && similarity(k, fk) >= 0.88))) continue;
          const nxt = j < toks.length ? strip(toks[j].text.toLowerCase(), ".,") : "";
          const prev = toks.slice(Math.max(0, i - 2), i).map((t) => t.text.toLowerCase()).filter((w) => w !== "the" && w !== "my");
          const sheetWord = ["file", "sheet", "list", "table", "data", "workbook"].includes(nxt);
          const fileish = hasExt || sheetWord
            || (prev.length > 0 && ["from", "with", "against", "in", "into", "to", "onto", "and", "vs", "versus"].includes(prev[prev.length - 1]));
          if (fileish || this.column(phrase) === null) {
            return { start: toks[i].start, end: sheetWord ? toks[j].end : toks[j - 1].end, column: name };
          }
        }
      }
    }
    const m = /\b(?:the\s+)?(?:other|second|lookup|new|that|another)\s+(?:file|sheet|list|table|data)\b|\bboth\s+(?:files|sheets)\b/i.exec(text);
    const names = Object.keys(this.files);
    if (m && names.length === 1) return { start: m.index!, end: m.index! + m[0].length, column: names[0] };
    return null;
  }

  private parseFileCommand(cl: string, fm: Mention): Step[] {
    const name = fm.column;
    const low = (cl.slice(0, fm.start) + " __FILE__ " + cl.slice(fm.end)).toLowerCase();
    let rest = cl.slice(0, fm.start) + " " + cl.slice(fm.end);
    if (/\bappend|\bstack\b|\badd\s+(?:the\s+|all\s+)?(?:rows|records|data)\b|\b(?:below|underneath|at\s+the\s+(?:end|bottom))\b/.test(low)) {
      return [{ op: "append", file: name }];
    }
    let keep: "only_here" | "only_there" | "both" | null = null;
    if (/(?:in|from)\s+(?:the\s+)?__file__.*\bnot\s+(?:in\s+)?(?:here|this|mine|ours|main|current|my)\b|\bonly\s+in\s+(?:the\s+)?__file__|\bmissing\s+(?:from|in)\s+(?:here|this|mine|my|the\s+main|current)\b|__file__\s+(?:rows\s+|records\s+)?(?:that\s+are\s+|which\s+are\s+)?not\s+(?:in\s+)?(?:here|this|mine|my)\b/.test(low)) {
      keep = "only_there";
    } else if (/\bnot\s+(?:in|present\s+in|found\s+in|matching)\s+(?:the\s+)?__file__|\bmissing\s+(?:from|in)\s+(?:the\s+)?__file__|\bonly\s+(?:in\s+)?(?:here|this|mine|my\s+data)\b|\bnot\s+matched\b/.test(low)) {
      keep = "only_here";
    } else if (/\bin\s+both\b|\bcommon\b|\balso\s+in\s+(?:the\s+)?__file__|\b(?:present|found|exist\w*)\s+in\s+(?:the\s+)?__file__|\b(?:that\s+are|which\s+are)\s+in\s+(?:the\s+)?__file__/.test(low)
      || /\bboth\s+(?:files|sheets)\b/i.test(cl)) {
      keep = "both";
    } else if (/\bcompare|\bdifference|\bdiff\b/.test(low)) {
      throw new ParseError(`What should the comparison show: rows not in ${name}, rows of ${name} that are not here, or rows in both? e.g. 'rows not in ${name} on pan'`);
    }

    const km = /\b(?:on|using|based\s+on|matching(?:\s+on)?|match(?:ing)?\s+by|by|via)\s+(?:the\s+)?(?:column\s+)?(?<k>.+?)(?=\s+(?:and\s+)?(?:bring|get|fetch|pull|return|add|from|in|to\s+get)\b|\s*$)/i.exec(rest);
    // "pan with pan number" names both keys; a trailing "with" (sheet already removed) doesn't.
    const keyText = km ? km.groups!.k.replace(/\s+(?:with|and)\s*$/, "") : null;
    const pair = this.fileKey(keyText, name, keep === null);
    if (km) rest = rest.slice(0, km.index) + " " + rest.slice(km.index! + km[0].length);
    if (keep) {
      const [left, right] = pair ?? [null, null];
      return [{ op: "compare", file: name, left_on: left, right_on: right, keep }];
    }
    const fp = this.fileParser(name);
    const wanted = rest.replace(/\b(?:look\s*up|lookup|v\s*lookup|x\s*lookup|match(?:ing)?|bring|fetch|pull|get|add|map|join|merge|enrich|with|from|and|the|their|its|columns?|details?|info|information|data|also)\b/gi, " ");
    let cols = fp.findColumns(wanted).map((m) => m.column).filter((c) => c !== pair![1]);
    if (!cols.length || /\b(?:all|every(?:thing)?)\b/i.test(rest)) cols = fp.columns.filter((c) => c !== pair![1]);
    return [{ op: "lookup", file: name, left_on: pair![0], right_on: pair![1], columns: unique(cols) }];
  }

  /** (column here, column in the other sheet) to match rows on. */
  private fileKey(text: string | null, name: string, required: boolean): [string, string] | null {
    const fp = this.fileParser(name);
    if (text) {
      const parts = text.trim().split(/\s*(?:==|=|<->)\s*|\s+(?:with|to|and)\s+/i);
      const [leftT, rightT] = parts.length >= 2 ? [parts[0], parts.slice(1).join(" ")] : [parts[0], parts[0]];
      const left = this.column(leftT) ?? this.columns.find((c) => key(c) === key(fp.column(leftT) ?? "")) ?? null;
      const right = fp.column(rightT) ?? fp.columns.find((c) => key(c) === key(left ?? "")) ?? null;
      if (left && right) return [left, right];
      const missing = !left ? `'${leftT}' here` : `'${rightT}' in ${name}`;
      throw new ParseError(`I couldn't find ${missing}. Columns here: ${this.columns.join(", ")}. Columns in ${name}: ${fp.columns.join(", ")}`);
    }
    const common = this.columns.flatMap((c) => fp.columns.filter((fc) => key(c) === key(fc)).map((fc): [string, string] => [c, fc]));
    // Real identifiers first (pan, id, email...), then codes/numbers.
    const ids = common.filter((p) => colWords(p[0]).some((w) => IDENTIFIER_WORDS.has(w)));
    const codes = common.filter((p) => colWords(p[0]).some((w) => ["code", "no", "num", "number"].includes(w)));
    if (ids.length === 1) return ids[0];
    if (!required) return null; // compare whole rows rather than guess a weak key
    for (const group of [codes, common]) if (group.length === 1) return group[0];
    const options = (ids.length ? ids : codes.length ? codes : common).map((p) => p[0]).join(", ") || "(no columns in common)";
    throw new ParseError(`Which column should I match on? Try: '... on pan'. Columns in both: ${options}`);
  }

  // ---------- totals, pivots, top N, running totals ----------

  private static funcsIn(low: string): Aggregation["func"][] {
    const found: Aggregation["func"][] = [];
    const table: [RegExp, Aggregation["func"]][] = [
      [/\b(?:totals?|sums?)\b/, "sum"], [/\b(?:averages?|avg|mean)\b/, "mean"],
      [/\b(?:counts?|how\s+many|number\s+of)\b/, "count"], [/\b(?:min|minimum|lowest|smallest)\b/, "min"],
      [/\b(?:max|maximum|highest|largest|biggest)\b/, "max"], [/\b(?:unique|distinct)\b/, "nunique"],
    ];
    for (const [re, f] of table) if (re.test(low)) found.push(f);
    return found;
  }

  /** Row filters mentioned inside another command, e.g. "top 10 *debits* by amount *in the last 30 days*". */
  private extraFilters(text: string): [string, FilterStep[]] {
    let conds: Condition[];
    [text, conds] = this.datePhrases(text);
    const [rest, vconds] = this.bareValues(text);
    conds = conds.concat(vconds);
    return [rest, conds.length ? [{ op: "filter", conditions: conds, match: "all" }] : []];
  }

  /** In "count by year for result code 101", the part after for/where/with is a row filter. */
  private trailingFilter(text: string): [string, FilterStep[]] {
    const m = /\b(?:for(?!\s+(?:each|every)\b)|where|with|when|if|having)\b/i.exec(text);
    if (!m || !text.slice(m.index + m[0].length).trim()) return [text, []];
    return [text.slice(0, m.index), [this.parseFilter(text.slice(m.index + m[0].length))]];
  }

  private columnsIn(text: string, what: string): string[] {
    const cols = unique(this.findColumns(text).map((m) => m.column));
    return cols.length ? cols : this.answered(`I ${what}`);
  }

  /** The columns given in reply to this question, or the question itself. */
  private answered(what: string): string[] {
    if (this.answer.length) return [...this.answer];
    throw new ParseError(`Which column should ${what}? Reply with the column name(s). Columns: ` + this.columns.join(", "), true);
  }

  /** Values worked out from each group's totals, like an Excel pivot calculated field: columns made by a formula
   * ("B0% = b0_amt*100/alloc_amt" -> total b0_amt*100/total alloc_amt), and several columns totalled side by side.
   * {} means the ordinary one-column summary. */
  private calculated(values: string[], funcs: string[]): Record<string, string> {
    if (funcs.length && funcs[0] !== "sum") return {}; // "average B0% by month" really means the average of the row values
    const formula = (c: string, depth = 0): string => {
      const expr = this.computed[c];
      if (expr === undefined || /[a-z_]+\s*\(/i.test(expr) || depth > 5) return `[${c}]`; // no functions: round(), days()...
      return expr.replace(/\[([^\]]+)\]/g, (m, n: string) => (n in this.computed ? `(${formula(n, depth + 1)})` : m));
    };
    if (values.length < 2 && !values.some((v) => formula(v) !== `[${v}]`)) return {};
    return Object.fromEntries(values.map((v) => [v, formula(v)]));
  }

  private checkPivotWidth(cols: string[], steps: DatePartStep[], what: string): void {
    this.checkWidth(cols, steps, what);
  }

  private parseGroup(cl: string): Step[] {
    const pct = new RegExp(PERCENT.source, "i").exec(cl);
    if (pct) cl = cl.slice(0, pct.index) + " " + cl.slice(pct.index + pct[0].length);
    let filters: FilterStep[];
    [cl, filters] = this.extraFilters(cl); // "how many debits per branch": debits is a row filter
    const explicit = Parser.funcsIn(cl.toLowerCase());
    const funcs = explicit.length ? explicit : (["count"] as Aggregation["func"][]);
    const m = GROUP_MARKER.exec(cl)!;
    let head: string, tail: string;
    [head, tail] = movePeriodWords(cl.slice(0, m.index), cl.slice(m.index + m[0].length));
    let more: FilterStep[];
    [tail, more] = this.trailingFilter(tail);
    filters = filters.concat(more);
    const [prefix, found] = this.dims(tail);
    const groupCols = unique(found.map((x) => x.column));
    if (!groupCols.length) groupCols.push(...this.answered("I group by"));
    let valueCols = this.findColumns(head).map((x) => x.column).filter((c) => !groupCols.includes(c));
    if (!valueCols.length && !(funcs.length === 1 && funcs[0] === "count")) {
      valueCols = this.answer.filter((c) => this.numericCols.includes(c) && !groupCols.includes(c));
    }
    // Formula columns (B0% = ...) are totalled the calculated-field way, not by adding row percentages.
    const formulas = valueCols.filter((c) => c in this.computed);
    const calculated = formulas.length ? this.calculated(formulas, explicit) : {};
    const aggs: Aggregation[] = [];
    for (const f of funcs) {
      if (f === "count" && !valueCols.length) { aggs.push({ column: groupCols[0], func: "count" }); continue; }
      const cols = unique(valueCols).filter((c) => !(c in calculated));
      for (const c of cols.length ? cols : Object.keys(calculated).length ? [] : [this.defaultNumberColumn()]) aggs.push({ column: c, func: f });
    }
    const steps: Step[] = [...filters, ...prefix, { op: "group_by", columns: groupCols, aggregations: aggs, calculated } as GroupByStep];
    if (pct) {
      const out = aggs.length ? `${aggs[0].func}_${aggs[0].column}` : Object.keys(calculated)[0];
      steps.push({ op: "calculate", kind: "percent_of_total", column: out, per: null, descending: true, name: `% of total ${out}` });
    }
    return steps;
  }

  private parsePivot(cl: string): Step[] {
    let filters: FilterStep[];
    [cl, filters] = this.extraFilters(cl);
    const funcs = Parser.funcsIn(cl.toLowerCase());
    if (funcs.length > 1) throw new ParseError("A pivot shows one calculation at a time. Which one: " + funcs.join(", ") + "?");
    const m = /\b(?:by|per|for\s+each|across|on|wrt|with\s+respect\s+to|against)\b/i.exec(cl);
    let text: string, marker: number | null;
    if (m) {
      const [head, rest] = movePeriodWords(cl.slice(0, m.index), cl.slice(m.index + m[0].length));
      marker = head.length + 1;
      text = `${head} ${m[0]} ${rest}`;
    } else { text = cl; marker = null; }
    // "... with (these) columns B0% and overall_repay%": the values to show.
    let shown: string[] = [];
    const vm = /\b(?:with|showing|show|using)\s+(?:the\s+|these\s+|those\s+)?((?:columns?|values?|fields?|measures?|metrics?)\s+)?(.+)$/i.exec(text);
    if (vm && !/\b(?:in|as|on)\s+(?:the\s+)?(?:rows?|columns?)\b|\bacross\b/i.test(vm[2])) {
      try {
        shown = this.columnList(vm[2], "show in the pivot");
        text = text.slice(0, vm.index);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        if (vm[1]) throw e; // they said "with columns ..." but named something that isn't a column
      }
    }
    const [prefix, found] = this.dims(text);
    const across = /\bacross\s+(?:the\s+top\s+)?(?:by\s+)?/i.exec(text);
    let rows: string[] = [], cols: string[] = [];
    const headCols: string[] = [];
    for (const d of found) {
      const after = text.slice(d.end);
      if (/^\s*(?:(?:as|in|on)\s+(?:the\s+)?columns?\b|across\s+the\s+top)/i.test(after) || (across && d.start >= across.index! + across[0].length)) cols.push(d.column);
      else if (/^\s*(?:(?:as|in|on)\s+(?:the\s+)?rows?\b|down\s+the\s+side)/i.test(after)) rows.push(d.column);
      else if (marker === null || d.end <= marker) headCols.push(d.column); // before "by": the column to summarise
      else rows.push(d.column);
    }
    if (!cols.length && rows.length >= 2) cols = [rows.pop()!]; // "pivot amount by category and txn type": last one goes across the top
    rows = unique(rows); cols = unique(cols);
    const values = unique([...headCols, ...shown]).filter((c) => ![...rows, ...cols].includes(c));
    if (!rows.length) rows = this.answered("go down the side of the pivot");
    this.checkPivotWidth(cols, prefix, "pivot columns");
    const calculated = this.calculated(values, funcs);
    if (Object.keys(calculated).length) {
      if (cols.length) {
        throw new ParseError("Columns like " + Object.keys(calculated).join(", ") + " can't have another column across the top yet. "
          + `Try: pivot by ${rows.join(", ")} with columns ${Object.keys(calculated).join(", ")}`);
      }
      return [...filters, ...prefix, { op: "pivot", rows, columns: [], values: null, func: "sum", totals: true, calculated } as PivotStep];
    }
    if (values.length > 1) {
      throw new ParseError("Several columns in one pivot can only be shown as totals (e.g. 'pivot total "
        + values.join(" and ") + " by ...'). For " + funcs[0] + ", pivot one column at a time: which one?");
    }
    let value: string | null = values[0] ?? null;
    const func = funcs[0] ?? (value ? "sum" : "count");
    if (func !== "count" && value === null) value = this.defaultNumberColumn();
    return [...filters, ...prefix, { op: "pivot", rows, columns: cols, values: value, func, totals: true, calculated: {} } as PivotStep];
  }

  /** 'a, b and c' -> exact columns; anything that isn't a column is an error, not ignored. */
  private columnList(text: string, what: string): string[] {
    text = text.replace(/\b(?:the|columns?|fields?|cols?)\b/gi, " ");
    const items = text.split(/,|\band\b|&/i).map((i) => i.trim()).filter(Boolean);
    const cols: string[] = [];
    for (const item of items) {
      const c = this.column(item);
      if (c === null) throw new ParseError(`Which column should I ${what}? I couldn't find '${item}'. Columns: ` + this.columns.join(", "));
      cols.push(c);
    }
    if (!cols.length) throw new ParseError(`Which column should I ${what}? Columns: ` + this.columns.join(", "));
    return unique(cols);
  }

  private parseTopN(cl: string): Step[] {
    const m = TOP_N.exec(cl)!;
    const word = m[1].toLowerCase(), n = parseInt(m[2], 10);
    let rest = cl.slice(0, m.index) + " " + cl.slice(m.index + m[0].length);
    let filters: FilterStep[];
    [rest, filters] = this.extraFilters(rest);
    let per: string[] | null = null;
    const pm = /\b(?:per|within|for\s+each|in\s+each|each)\b/i.exec(rest);
    if (pm) {
      const ptail = rest.slice(pm.index + pm[0].length);
      const bm = /\bby\b/i.exec(ptail);
      per = this.columnsIn(bm ? ptail.slice(0, bm.index) : ptail, "group by");
      rest = rest.slice(0, pm.index) + (bm ? ptail.slice(bm.index) : "");
    }
    const by = /\bby\b/i.exec(rest);
    const cols = this.findColumns(by ? rest.slice(by.index + by[0].length) : rest).map((x) => x.column).filter((c) => !(per ?? []).includes(c));
    if (new Set(cols).size > 1) throw new ParseError("Which column should decide the top rows: " + unique(cols).join(", ") + "?");
    let column: string | null = cols[0] ?? null;
    const dateish = /\b(?:latest|newest|oldest|earliest|recent)\b/i.test(cl);
    if (column === null && (word === "first" || word === "last") && !dateish) {
      return [...filters, { op: "top_n", n, column: null, largest: word === "first", per: null } as TopNStep];
    }
    if (column === null) column = dateish ? this.defaultDateColumn(cl) : this.defaultNumberColumn();
    const lowest = /\b(?:bottom|lowest|smallest|least|oldest|earliest)\b/i.test(cl) || word === "first";
    const largest = word === "last" || !lowest;
    return [...filters, { op: "top_n", n, column, largest, per } as TopNStep];
  }

  private parseCalculate(cl: string): Step[] {
    const steps: Step[] = [];
    const sm = /\b(?:sorted|ordered|sort|order)\s+by\b.*$/i.exec(cl);
    if (sm) { // "cumulative sum of amount sorted by date": sort first, then calculate
      steps.push(this.parseSort(sm[0]));
      cl = cl.slice(0, sm.index);
    }
    let low = cl.toLowerCase();
    const kind = /\brank/.test(low) ? "rank" : /\b(?:running|cumulative)\b/.test(low) ? "running_total" : "percent_of_total";
    if (kind === "percent_of_total" && /\bby\b/.test(low) && !/\b(?:within|per|each)\b/.test(low)) {
      return steps.concat(this.parseGroup("total " + cl)); // "percentage share of amount by category"
    }
    let filters: FilterStep[];
    [cl, filters] = this.extraFilters(cl);
    low = cl.toLowerCase();
    if (kind === "rank") {
      const by = /\bby\b/i.exec(cl);
      const entity = by ? this.findColumns(cl.slice(0, by.index)).map((x) => x.column) : [];
      if (by && entity.length) {
        const after = cl.slice(by.index + by[0].length);
        const funcs = Parser.funcsIn(after.toLowerCase());
        const value = funcs.length ? this.column(after.replace(/\b(?:total|sum|average|avg|mean|count|min|max|highest|lowest)\b/gi, " ")) : null;
        if (!funcs.length || !value) {
          throw new ParseError(`Rank each row, or rank each ${entity[0]} by a total? Try 'rank ${entity[0]} by total amount' or 'rank by amount'.`);
        }
        // "rank branches by total amount": total per branch, then rank the totals.
        const out = `${funcs[0]}_${value}`;
        return [...filters, ...steps,
          { op: "group_by", columns: entity, aggregations: [{ column: value, func: funcs[0] }], calculated: {} },
          { op: "calculate", kind: "rank", column: out, per: null, descending: true, name: `rank by ${out}` },
          { op: "sort", columns: [out], ascending: false }];
      }
    }
    const perMarker = kind === "rank" ? /\b(?:within|per|for\s+each|in\s+each|each)\b/i : /\b(?:within|per|for\s+each|in\s+each|each|by)\b/i;
    const pm = perMarker.exec(cl);
    let head = pm ? cl.slice(0, pm.index) : cl;
    const tail = pm ? cl.slice(pm.index + pm[0].length) : "";
    const per = pm ? this.columnsIn(tail, "calculate within") : null;
    if (kind === "rank") head = this.afterPattern(head, String.raw`\bby\b`);
    const cols = this.findColumns(head).map((x) => x.column).filter((c) => !(per ?? []).includes(c));
    const column = cols[0] ?? this.defaultNumberColumn();
    const descending = !/\b(?:lowest|smallest|least|asc|ascending|oldest|earliest)\b/.test(low);
    const name = { rank: `rank by ${column}`, running_total: `running total ${column}`, percent_of_total: `% of total ${column}` }[kind];
    return [...filters, ...steps, { op: "calculate", kind, column, per, descending, name }];
  }

  private afterPattern(cl: string, pattern: string): string {
    const m = new RegExp(pattern, "i").exec(cl);
    return m ? cl.slice(m.index + m[0].length) : cl;
  }

  private dims(text: string): [DatePartStep[], Mention[]] {
    const steps: DatePartStep[] = [];
    let found: Mention[] = [];
    const real = this.findColumns(text);
    const overlaps = (s: number, e: number, list: Mention[]) => list.some((r) => r.start < e && s < r.end);
    for (const m of text.matchAll(new RegExp(PREFIXED_DATE_PART.source, "gi"))) {
      const start = m.index!, end = start + m[0].length;
      if (overlaps(start, end, real)) continue;
      const pre = singular(key(m.groups!.pre));
      const srcs = this.dateCols.filter((c) => colWords(c).map(singular).includes(pre));
      if (srcs.length !== 1) continue;
      const part = m.groups!.part.toLowerCase() as DatePartStep["part"];
      const name = !this.columns.includes(m[0]) ? m[0] : `${srcs[0]} ${part}`;
      if (steps.every((s) => s.name !== name)) steps.push({ op: "date_part", column: srcs[0], part, name });
      found.push({ start, end, column: name });
    }
    for (const m of text.matchAll(new RegExp(DATE_PART_SRC, "gi"))) {
      const start = m.index!, end = start + m[0].length;
      if (overlaps(start, end, [...real, ...found])) continue; // part of a real column name, e.g. "year" in "assessment year"
      const word = m[0].toLowerCase();
      const part = (word.includes("day") && word.includes("week") ? "weekday"
        : word.startsWith("day") || word.startsWith("daily") ? "day"
        : word.startsWith("annual") ? "year"
        : new RegExp(`^(?:${DATE_PART_SRC})`, "i").exec(word)![1]) as DatePartStep["part"];
      const src = this.defaultDateColumn(text);
      const name = !this.columns.includes(part) ? part : `${src} ${part}`;
      if (steps.every((s) => s.name !== name)) steps.push({ op: "date_part", column: src, part, name });
      found.push({ start, end, column: name });
    }
    let blanked = text;
    for (const f of found) blanked = blanked.slice(0, f.start) + " ".repeat(f.end - f.start) + blanked.slice(f.end);
    const sources = new Set(steps.map((s) => s.column));
    found = found.concat(this.findColumns(blanked).filter((m) => !sources.has(m.column))); // skip "month of txn date"
    return [steps, found.sort((a, b) => a.start - b.start)];
  }

  private distinctCount(name: string, steps: DatePartStep[]): number {
    const s = steps.find((x) => x.name === name);
    if (s) {
      // Count the distinct parts without building the column twice.
      return distinct(this.datePartCells(s));
    }
    return distinct(this.col(name).values);
  }

  private datePartCells(s: DatePartStep): Cell[] {
    const t = applyPlan(new Map([["x", this.table]]), { clarification_question: null, summary: "", awaits_columns: false, steps: [s] });
    return t.get("x")!.columns.find((c) => c.name === s.name)!.values;
  }

  private checkWidth(cols: string[], steps: DatePartStep[], what: string): void {
    for (const c of cols) {
      const n = this.distinctCount(c, steps);
      if (n > MAX_SPLIT_SHEETS) {
        const good = this.columns.filter((x) => { const k = distinct(this.col(x).values); return k >= 2 && k <= MAX_SPLIT_SHEETS; })
          .map((x) => `${x} (${distinct(this.col(x).values)})`);
        throw new ParseError(`'${c}' has ${n.toLocaleString("en-US")} different values, so it would create ${n.toLocaleString("en-US")} ${what}. `
          + `Columns with fewer values (${what}): ` + (good.join(", ") || "none"));
      }
    }
  }

  private parseDedupe(cl: string): Step {
    const tail = this.afterPattern(cl, String.raw`\b(?:by|on|based\s+on|using|in|of|per)\b`);
    const cols = tail !== cl ? this.findColumns(tail).map((m) => m.column) : [];
    const keep = /\b(?:keep(?:ing)?\s+(?:the\s+)?(?:last|latest|newest|most\s+recent))\b/i.test(cl) ? "last" : "first";
    return { op: "dedupe", columns: cols.length ? cols : null, keep };
  }

  private parseSplit(cl: string): Step[] {
    const tail = this.afterPattern(cl, String.raw`\b(?:by|on|per|for\s+each|for\s+every|based\s+on|according\s+to|using)\b`);
    const [prefix, found] = this.dims(tail);
    const cols = unique(found.map((m) => m.column));
    if (!cols.length) throw new ParseError("Which column should I split by? Columns: " + this.columns.join(", "));
    this.checkWidth(cols, prefix, "sheets");
    return [...prefix, ...cols.map((c): Step => ({ op: "split_by", column: c }))];
  }

  private parseSort(cl: string): SortStep {
    const desc = /\b(?:desc|descending|decreasing|highest|largest|biggest|most|newest|latest|recent|reverse|z\s*(?:-|to)\s*a|high(?:est)?\s+to\s+low(?:est)?|big(?:gest)?\s+to\s+small(?:est)?)\b/i.test(cl);
    let tail = this.afterPattern(cl, String.raw`\bby\b`);
    tail = tail.replace(/\b(?:asc|ascending|desc|descending|first|order|highest|lowest|newest|oldest|latest|high|low|to|z|a|reverse)\b/gi, " ");
    let cols = this.findColumns(tail).map((m) => m.column);
    if (!cols.length && /\b(?:newest|oldest|latest|earliest|recent|date)\b/i.test(cl)) cols = [this.defaultDateColumn(cl)];
    if (!cols.length && /\b(?:highest|lowest|largest|smallest|biggest)\b/i.test(cl)) cols = [this.defaultNumberColumn()];
    if (!cols.length) throw new ParseError("Which column should I sort by? Columns: " + this.columns.join(", "));
    return { op: "sort", columns: unique(cols), ascending: !desc };
  }

  private parseColumns(cl: string): Step | null {
    const low = cl.toLowerCase();
    const lead = String.raw`^\s*(?:please\s+)?`;
    const dropRe = String.raw`(?:drop|remove|delete|hide|exclude|get\s+rid\s+of)`;
    const keepRe = String.raw`(?:keep|select|show|include|just|only|retain|pick|want|give\s+me)`;
    const drop = new RegExp(`${lead}${dropRe}\\b`).test(low);
    const keep = new RegExp(`${lead}${keepRe}\\b`).test(low);
    if (!(drop || keep)) return null;
    const hasWord = /\b(?:columns?|fields?|cols?)\b/.test(low);
    let body = cl.replace(new RegExp(`${lead}(?:${dropRe}|${keepRe})\\b`, "i"), "");
    body = body.replace(/\b(?:only|just|the|columns?|fields?|cols?)\b/gi, " ");
    const items = body.split(/,|\band\b|&|\+|\//i).map((i) => i.trim()).filter(Boolean);
    if (!items.length) return null;
    const cols = items.map((i) => this.column(i));
    if (cols.includes(null)) {
      if (!hasWord) return null; // probably a row filter like "keep only debits"
      throw new ParseError(`I couldn't find a column matching '${items[cols.indexOf(null)]}'. Columns: ` + this.columns.join(", "));
    }
    const names = unique(cols as string[]);
    return drop ? { op: "drop_columns", columns: names } : { op: "select_columns", columns: names };
  }

  // ---------- row filters ----------

  parseFilter(cl: string): FilterStep {
    const everythingExcept = /\b(?:everything|all(?:\s+\w+)?)\s+(?:except|but|other\s+than|excluding)\b/i.exec(cl);
    const neg = !!everythingExcept || /^\s*(?:please\s+)?(?:remove|exclude|delete|drop|hide|filter\s+out|get\s+rid\s+of|take\s+out|leave\s+out|without|except|excluding)\b/i.test(cl);
    if (everythingExcept) cl = cl.slice(0, everythingExcept.index) + cl.slice(everythingExcept.index! + everythingExcept[0].length);
    let body = cl;
    for (const phrase of this.andOrPhrases()) { // e.g. the value "Food and Dining" is one value
      body = body.replace(new RegExp(escapeRe(phrase), "gi"),
        (m) => m.replace(/\s+(and|or)\s+/gi, (_, w: string) => ` __${w.toUpperCase()}__ `));
    }
    body = body.replace(/\b(between|from)\s+(\S+(?:\s+\S+){0,3}?)\s+and\s+/gi, "$1 $2 __AND__ ");
    const parts = body.split(/\s*\b(and|or)\b\s*/i);
    const frags = parts.filter((_, i) => i % 2 === 0);
    const connectors = parts.filter((_, i) => i % 2 === 1).map((p) => p.toLowerCase());
    if (connectors.includes("and") && connectors.includes("or")) {
      throw new ParseError("Mixing 'and' with 'or' in one filter is ambiguous. Please split it into two commands.");
    }
    let match: "all" | "any" = connectors.includes("or") ? "any" : "all";
    let conds: Condition[] = [];
    for (let frag of frags) {
      frag = frag.replace(/__AND__/g, "and").replace(/__OR__/g, "or");
      const got = this.parseFragment(frag, conds.length ? conds[conds.length - 1] : null);
      if (!got.length) {
        throw new ParseError(`I couldn't understand '${frag.trim()}'.\n\nTry commands like:\n- ` + this.examples().join("\n- "));
      }
      conds.push(...got);
    }
    [conds, match] = mergeSameColumn(conds, match);
    if (neg) {
      conds = conds.map(negate);
      if (conds.length > 1) match = match === "all" ? "any" : "all";
    }
    return { op: "filter", conditions: conds, match };
  }

  private parseFragment(frag: string, prev: Condition | null): Condition[] {
    let prevCol = prev ? prev.column : null;
    let conds: Condition[] = [];
    let dconds: Condition[];
    [frag, dconds] = this.datePhrases(frag);
    conds.push(...dconds);

    // "<column> <operator> <value>" for each column mentioned.
    const mentions = this.findColumns(frag);
    let residue = frag;
    mentions.forEach((m, i) => {
      const segEnd = i + 1 < mentions.length ? mentions[i + 1].start : frag.length;
      let [got, used] = this.parseOp(m.column, frag.slice(m.end, segEnd));
      if (!got.length && /\b(?:no|missing|empty|blank)\s+(?:an?\s+)?$/i.test(frag.slice(0, m.start))) {
        got = [{ column: m.column, operator: "is_empty" }];
        used = 0; // "rows with no branch"
      }
      if (got.length) {
        conds.push(...got);
        residue = residue.slice(0, m.start) + " ".repeat(m.end + used - m.start) + residue.slice(m.end + used);
        prevCol = m.column;
      }
    });

    // Bare values that exist in the data, e.g. "debits" -> txn_type = DEBIT.
    let vconds: Condition[];
    [residue, vconds] = this.bareValues(residue);
    conds.push(...vconds);

    // Operator without a column, e.g. "over 5000" or "and under 500".
    const rest = residue.split(/\s+/).filter(Boolean).join(" ");
    if (rest && /\d/.test(rest)) {
      const looksLikeDate = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(rest);
      const col = looksLikeDate
        ? (prevCol !== null && this.dateCols.includes(prevCol) ? prevCol : this.defaultDateColumn(frag))
        : (prevCol !== null && this.numericCols.includes(prevCol) ? prevCol : this.defaultNumberColumn());
      // The operator may come after other words: "transactions after 01/03/2025".
      for (const w of rest.matchAll(/\S+/g)) {
        const [got] = this.parseOp(col, rest.slice(w.index!), true);
        if (got.length) { conds.push(...got); break; }
      }
    }

    // A lone value after "and"/"or" continues the previous condition: "description contains zomato or swiggy".
    const value = cleanValue(frag);
    if (!conds.length && prev && (prev.operator === "contains" || prev.operator === "not_contains")
      && value.split(/\s+/).filter(Boolean).length > 0 && value.split(/\s+/).filter(Boolean).length <= 3) {
      conds.push({ ...prev, value });
    }
    return conds;
  }

  private datePhrases(frag: string): [string, Condition[]] {
    const conds: Condition[] = [];
    const low = frag.toLowerCase();
    const unit = String.raw`(day|week|month|year)s?`;
    const patterns: [string, "older" | "recent"][] = [
      [String.raw`\b(?:older\s+than|more\s+than|over|at\s+least)\s+(\d+)\s*${unit}(?:\s+(?:ago|old))?`, "older"],
      [String.raw`\b(\d+)\s*${unit}\s+ago\s+or\s+(?:more|older|earlier)`, "older"],
      [String.raw`\b(?:in|within|during|over|for|from)?\s*(?:the\s+)?(?:last|past|previous|recent)\s+(\d+)?\s*${unit}`, "recent"],
      [String.raw`\b(?:in|within|for)\s+(\d+)\s*${unit}`, "recent"],
    ];
    for (const [pattern, kind] of patterns) {
      const m = new RegExp(pattern).exec(low);
      if (!m) continue;
      const days = parseInt(m[1] ?? "1", 10) * DATE_UNITS[m[2]];
      const before = low.slice(0, m.index);
      const negated = /\b(?:not|no|never|without|inactive|hasnt|havent|didnt|isnt|wasnt|dont|doesnt)\b|n't\b/.test(before);
      const col = this.defaultDateColumn(frag);
      const op = (kind === "older") !== negated ? "older_than_days" : "within_last_days";
      conds.push({ column: col, operator: op, value: String(days) });
      frag = frag.slice(0, m.index) + " " + frag.slice(m.index! + m[0].length);
      return [this.stripCol(frag, col), conds];
    }

    const now = new Date();
    let m = /\b(?:this|current)\s+(month|year)\b|\btoday\b/.exec(low);
    if (m) {
      const start = m[0] === "today" ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : m[1] === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), 0, 1);
      const col = this.defaultDateColumn(frag);
      conds.push({ column: col, operator: "gte", value: localIso(start) });
      return [this.stripCol(frag.slice(0, m.index) + " " + frag.slice(m.index! + m[0].length), col), conds];
    }

    m = /\b(?:in|during|for|of)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(\d{4})\b/.exec(low)
      ?? /\b(?:in|during|for)\s+(?:the\s+year\s+)?()(\d{4})\b/.exec(low);
    if (m && this.dateCols.length) {
      const year = parseInt(m[2], 10);
      let start: number, end: number;
      if (m[1]) {
        const month = MONTHS[m[1].slice(0, 3)];
        start = utcDay(year, month, 1)!;
        end = utcDay(year + (month === 12 ? 1 : 0), (month % 12) + 1, 1)!;
      } else {
        start = utcDay(year, 1, 1)!;
        end = utcDay(year + 1, 1, 1)!;
      }
      const col = this.defaultDateColumn(frag);
      conds.push({ column: col, operator: "gte", value: isoDay(start) }, { column: col, operator: "lt", value: isoDay(end) });
      return [this.stripCol(frag.slice(0, m.index) + " " + frag.slice(m.index! + m[0].length), col), conds];
    }
    return [frag, conds];
  }

  /** Blank out mentions of `col` so it isn't parsed again as a separate condition. */
  private stripCol(frag: string, col: string): string {
    for (const m of [...this.findColumns(frag)].reverse()) {
      if (m.column === col) frag = frag.slice(0, m.start) + " ".repeat(m.end - m.start) + frag.slice(m.end);
    }
    return frag;
  }

  private bareValues(text: string): [string, Condition[]] {
    const index = this.valueIndex();
    const toks = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
    const conds: Condition[] = [];
    const used = new Set<number>();
    for (let n = Math.min(5, toks.length); n >= 1; n--) {
      for (let i = 0; i + n <= toks.length; i++) {
        let clash = false;
        for (let t = i; t < i + n; t++) if (used.has(t)) clash = true;
        if (clash) continue;
        const words = toks.slice(i, i + n).map((t) => key(t.text));
        if (n === 1 && (FILLER_WORDS.has(words[0]) || words[0].length < 2 || /^\d+$/.test(words[0]))) continue;
        const hits = index.get(singular(words.join("")));
        if (!hits) continue;
        if (hits.size > 1) {
          throw new ParseError(`'${toks.slice(i, i + n).map((t) => t.text).join(" ")}' appears in several columns (`
            + [...hits.keys()].join(", ") + `). Please say which column, e.g. "<column> is <value>".`);
        }
        const [[col, value]] = [...hits];
        const before = text.slice(0, toks[i].start).toLowerCase();
        const negated = /\b(?:not|non|except|excluding|other\s+than|no)\s*-?\s*$/.test(before);
        conds.push({ column: col, operator: negated ? "not_equals" : "equals", value });
        for (let t = i; t < i + n; t++) used.add(t);
      }
    }
    for (const i of [...used].sort((a, b) => b - a)) {
      const t = toks[i];
      text = text.slice(0, t.start) + " ".repeat(t.end - t.start) + text.slice(t.end);
    }
    return [text, conds];
  }

  // Each operator: (regex matched at the start of the text after the column, operator name).
  private static readonly OPS: [RegExp, string][] = ([
    [String.raw`(?:is\s+|are\s+)?(?:between|from)\s+(.+?)\s+(?:and|to|till|until|-)\s+(.+)`, "between"],
    [String.raw`(?:is\s+|are\s+)?not\s+(?:empty|blank|missing|null)|(?:is\s+)?(?:filled|present)|has\s+(?:a\s+)?value`, "not_empty"],
    [String.raw`(?:is\s+|are\s+)?(?:empty|blank|missing|null)`, "is_empty"],
    [String.raw`(?:is\s+|are\s+)?(?:>=|=>|at\s+least|greater\s+than\s+or\s+equal\s+to|not\s+less\s+than|min(?:imum)?|since|on\s+or\s+after)\s*(.+)`, "gte"],
    [String.raw`(?:is\s+|are\s+)?(?:<=|=<|at\s+most|less\s+than\s+or\s+equal\s+to|not\s+more\s+than|up\s+to|max(?:imum)?|until|till|on\s+or\s+before)\s*(.+)`, "lte"],
    [String.raw`(?:is\s+|are\s+)?(?:>|greater\s+than|more\s+than|higher\s+than|larger\s+than|bigger\s+than|above|over|exceeds?|exceeding|after|later\s+than)\s*(.+)`, "gt"],
    [String.raw`(?:is\s+|are\s+)?(?:<|less\s+than|lower\s+than|smaller\s+than|below|under|before|earlier\s+than)\s*(.+)`, "lt"],
    [String.raw`(?:does\s*n[o']?t|doesnt|do\s*n[o']?t)\s+(?:contain|include|have|mention)\s+(.+)`, "not_contains"],
    [String.raw`(?:contains?|includes?|has|having|mentions?|with|like)\s+(.+)`, "contains"],
    [String.raw`(?:is\s+|are\s+)?not\s+(?:in|one\s+of|any\s+of)\s+(.+)`, "not_in"],
    [String.raw`(?:is\s+|are\s+)?(?:in|one\s+of|any\s+of)\s+(.+)`, "in"],
    [String.raw`(?:is\s+not|are\s+not|isn'?t|aren'?t|!=|<>|not\s+equals?(?:\s+to)?|not|except|other\s+than)\s+(.+)`, "not_equals"],
    [String.raw`(?:(?:is\s+equal\s+to|equals?(?:\s+to)?|is|are|of|as)\b|==|=|:)\s*(.+)`, "equals"],
    [String.raw`(.+)`, "equals_implicit"],
  ] as [string, string][]).map(([p, op]) => [new RegExp(`^(?:${p})`, "i"), op]);

  /** Parse '<operator> <value>' right after a column. Returns (conditions, chars consumed). */
  private parseOp(col: string, seg: string, requireOp = false): [Condition[], number] {
    let s = seg.replace(/^[ ,:]+/, "").replace(/^(?:(?:where|whose|value|column|field)\s+)+/i, "");
    const lead = seg.length - s.length;
    s = s.replace(/[ ,:]+$/, "");
    if (!s) return [[], 0];
    const numeric = this.numericCols.includes(col);
    const isDate = this.dateCols.includes(col);
    // Start of the last capture group (every pattern that needs it ends with its group).
    const lastStart = (m: RegExpExecArray, g: number) => m[0].length - m[g].length;
    for (const [re, op] of Parser.OPS) {
      if (requireOp && (op === "equals" || op === "equals_implicit")) continue;
      const m = re.exec(s);
      if (!m) continue;
      if (op === "is_empty" || op === "not_empty") return [[{ column: col, operator: op }], lead + m[0].length];
      if (op === "between") {
        const [lo] = this.scalar(col, m[1]);
        const [hi, hiUsed] = this.scalar(col, m[2]);
        if (lo === null || hi === null) continue;
        return [[{ column: col, operator: "gte", value: lo }, { column: col, operator: "lte", value: hi }], lead + lastStart(m, 2) + hiUsed];
      }
      if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (!(numeric || isDate)) continue;
        const [v, used] = this.scalar(col, m[1]);
        if (v === null) continue;
        return [[{ column: col, operator: op, value: v }], lead + lastStart(m, 1) + used];
      }
      if (isDate && (op === "equals" || op === "equals_implicit")) { // "date is 01/03/2024" means that whole day
        const [v, used] = this.scalar(col, m[1]);
        if (v === null) continue;
        const next = isoDay(Date.parse(v) + DAY_MS);
        return [[{ column: col, operator: "gte", value: v }, { column: col, operator: "lt", value: next }], lead + lastStart(m, 1) + used];
      }
      const raw = cleanValue(m[1]);
      if (!raw || FILLER_WORDS.has(key(raw))) continue;
      if (op === "contains" || op === "not_contains") return [[{ column: col, operator: op, value: raw }], seg.length];
      if (op === "in" || op === "not_in") return [[{ column: col, operator: op, values: this.resolveValues(col, raw) }], seg.length];
      let vals: string[];
      if (op === "equals_implicit") { // No "is"/"=": accept only if it's clearly a value of this column.
        try { vals = this.resolveValues(col, raw); } catch (e) { if (e instanceof ParseError) return [[], 0]; throw e; }
      } else vals = this.resolveValues(col, raw);
      const negated = op === "not_equals";
      if (vals.length > 1) return [[{ column: col, operator: negated ? "not_in" : "in", values: vals }], seg.length];
      return [[{ column: col, operator: negated ? "not_equals" : "equals", value: vals[0] }], seg.length];
    }
    return [[], 0];
  }

  /** Leading number or date in `text` (as the engine expects it) and chars consumed. */
  private scalar(col: string, text: string): [string | null, number] {
    if (this.dateCols.includes(col)) {
      const m = /^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|[a-z]{3,9}\s+\d{4})/i.exec(text);
      const v = m ? parseDate(m[1]) : null;
      return v ? [v, m![0].length] : [null, 0];
    }
    const m = /^\s*([₹$€£]?\s*(?:rs\.?\s*|inr\s*)?-?[\d,]*\.?\d+\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr|mn|m|million|bn|b|billion)?)(?![a-z])/i.exec(text);
    const n = m ? parseNumber(m[1]) : null;
    return n !== null ? [fmt(n), m![0].length] : [null, 0];
  }
}

// ---------- whole commands ----------

export function splitClauses(request: string): string[] {
  let text = request.trim().replace(/[“”‘’]/g, (c) => SMART_QUOTES[c]);
  text = text.replace(/\bw\s*\.\s*r\s*\.\s*t\b\.?/gi, "wrt"); // "w.r.t." must not end a sentence
  // Quoted text ('"Rs. "', '", "') is set aside so the splitting below can't break it up.
  const quoted: string[] = [];
  text = text.replace(QUOTED, (m) => { quoted.push(m); return `__Q${quoted.length - 1}__`; });
  // [Column names] and (bracketed parts, function arguments) are set aside too: a comma or "and" inside a formula
  // such as IF(a>1,"x",TRIM(b)) must not start a new command.
  text = text.replace(/\[[^\]]*\]/g, (m) => { quoted.push(m); return `__Q${quoted.length - 1}__`; });
  text = protectParentheses(text, quoted);
  text = text.replace(/,(?=[^\s\d])/g, ", "); // "date,amount" -> "date, amount"; not "5,000"
  const clauses: string[] = [];
  for (const part of text.split(CLAUSE_SPLIT)) {
    for (const clause of splitAssignments(part ?? "")) {
      if (!strip(clause, " ,.")) continue;
      const cleaned = strip(clause, " ,.").replace(/^(?:(?:and|also|then|now|please|actually|next|finally|do)\b[\s,]*)+/i, "");
      let restored = cleaned;
      for (let pass = 0; pass < 5 && /__Q\d+__/.test(restored); pass++) restored = restored.replace(/__Q(\d+)__/g, (_, n: string) => quoted[+n]);
      clauses.push(restored);
    }
  }
  return clauses;
}

/** Replace each outermost (...) group with a placeholder (unbalanced text is left alone). */
function protectParentheses(text: string, store: string[]): string {
  let depth = 0, start = -1, out = "", last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") { if (depth === 0) start = i; depth++; }
    else if (text[i] === ")" && depth > 0) {
      depth--;
      if (depth === 0) {
        out += text.slice(last, start);
        store.push(text.slice(start, i + 1));
        out += `__Q${store.length - 1}__`;
        last = i + 1;
      }
    }
  }
  return depth === 0 ? out + text.slice(last) : text;
}

function splitAssignments(clause: string): string[] {
  const first = /(?<![<>!=])=(?!=)/.exec(clause);
  if (!first) return [clause];
  const parts: string[] = [];
  let start = 0;
  const re = new RegExp(NEXT_ASSIGNMENT.source, "gi");
  re.lastIndex = first.index + 1;
  for (let m = re.exec(clause); m; m = re.exec(clause)) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (/\bor\s*$/i.test(clause.slice(0, m.index))) continue; // "type = DEBIT or type = CREDIT" is one filter
    parts.push(clause.slice(start, m.index));
    start = m.index + m[0].length;
  }
  return [...parts, clause.slice(start)];
}

export function replyColumns(sheets: Sheets | Table, text: string): [string[], string[]] | null {
  const parser = new Parser(sheets);
  const first = text.trim() ? (splitClauses(text)[0] ?? "") : "";
  const items = first.split(/,|\band\b|&|\s{2,}/i).map((i) => i.trim()).filter(Boolean);
  if (!items.length || items.length > 20 || items.some((i) => i.split(/\s+/).length > 3)) return null;
  const lookAlike = (s: string) => s.replace(/o/g, "0").replace(/i/g, "1").replace(/l/g, "1");
  const found: string[] = [], unknown: string[] = [];
  for (const item of items) {
    const col = parser.column(item);
    const own = new Set(colWords(col ?? "").map(singular));
    const extra = new Set((item.toLowerCase().replace(/_/g, " ").match(/[a-z0-9]+/g) ?? []).map(singular));
    if (col && [...extra].every((w) => own.has(w))) { found.push(col); continue; } // nothing but the column's own words
    if (/\s/.test(item) || col) return null; // a phrase like "rank by amount" is a command, not a mistyped column
    let guess = parser.columns.find((c) => lookAlike(key(c)) === lookAlike(key(item))) ?? null;
    if (guess === null) {
      const close = closeMatch(key(item), parser.columns.map(key), 0.75);
      guess = close !== null ? parser.columns.find((c) => key(c) === close) ?? null : null;
    }
    if (guess === null) return null; // not a column list after all
    unknown.push(`'${item}' (did you mean ${guess}?)`);
  }
  return [unique(found), unknown];
}

export const examples = (sheets: Sheets | Table): string[] => new Parser(sheets).examples();

export function makePlan(sheets: Sheets, request: string, answer: string[] = [], computed: Record<string, string> = {}, files: Record<string, Table> = {}): Plan {
  computed = { ...computed };
  const empty = (q: string, awaits = false): Plan => ({ clarification_question: q, summary: "", steps: [], awaits_columns: awaits });
  try {
    const clauses = splitClauses(request);
    if (!clauses.length) throw new ParseError("Tell me what you'd like to do with the data.");
    const justColumns = answer.length ? null : replyColumns(sheets, request);
    if (justColumns) {
      const [cols, unknown] = justColumns;
      if (unknown.length) throw new ParseError("I couldn't find " + unknown.join(", ") + ".");
      const c = cols[0];
      throw new ParseError(`What should I do with ${cols.join(", ")}? For example:\n- total ${c} by <column>\n`
        + `- sort by ${c} descending\n- keep columns ${cols.join(", ")}\n- top 10 by ${c}`);
    }
    if (Object.keys(files).length) {
      // "match with customers on pan and bring email": a bring/fetch part that names no sheet continues the lookup before it.
      const finder = new Parser(sheets, [], {}, files);
      const merged: string[] = [];
      for (const c of clauses) {
        if (merged.length && /^(?:bring|fetch|pull|return|get)\b/i.test(c) && !finder.findFile(c)) merged[merged.length - 1] += " and " + c;
        else merged.push(c);
      }
      clauses.splice(0, clauses.length, ...merged);
    }
    const steps: Step[] = [];
    let current = sheets;
    clauses.forEach((clause, i) => {
      const made = new Parser(current, answer, computed, files).parseClause(clause);
      steps.push(...made);
      for (const st of made) if (st.op === "compute") computed[st.name] = st.expr;
      // Later parts see the result so far: "add column gst = ... and sort by gst".
      if (i < clauses.length - 1) current = applyPlan(current, { clarification_question: null, summary: "", awaits_columns: false, steps: made }, files);
    });
    return { clarification_question: null, summary: steps.map(describe).join("; ") + ".", steps, awaits_columns: false };
  } catch (e) {
    if (e instanceof ParseError) return empty(e.message, e.awaitsColumns);
    if (e instanceof PlanError) return empty(`That can't run on this data: ${e.message}`);
    throw e;
  }
}
