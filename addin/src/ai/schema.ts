/**
 * The plan language a model may write, and the checks that stand between its answer and the engine.
 * A model returns loose JSON; `normalisePlan` fills in defaults and rejects anything that is not a known step
 * with the right kind of fields, so nothing the engine does not understand ever runs.
 */
import { describe as describeStep } from "../engine/describe";
import type { Plan, Step } from "../engine/plan";

/** What the model is told about the steps (kept short: it is part of every request). */
export const STEP_REFERENCE = `
A plan is {"steps":[...]}. Steps run in order; each one works on the result of the one before. Column names are exact, case-sensitive, and a step may use columns made by an earlier step.
Formulas and expressions refer to columns as [column name]. Use + - * / ( ) and Excel functions such as IF, IFS, IFERROR, AND, OR, NOT, ROUND, ABS, MIN, MAX, LEFT, RIGHT, MID, LEN, UPPER, LOWER, TRIM, SUBSTITUTE, TEXT, CONCAT, YEAR, MONTH, DAY, TODAY, EOMONTH, DATEDIF, COUNTIF, SUMIF. Day differences: [date1]-[date2].

Steps (omit optional fields):
- {"op":"filter","match":"all"|"any","conditions":[{"column":C,"operator":OP,"value":V}]}  OP is one of equals, not_equals, contains, not_contains, in, not_in (use "values":[...]), is_empty, not_empty, gt, gte, lt, lte, within_last_days, older_than_days. Values are written as text, e.g. "5000".
- {"op":"filter_formula","formula":"[a]<=[b]","keep":true}
- {"op":"select_columns","columns":[...]}   {"op":"drop_columns","columns":[...]}
- {"op":"sort","columns":[...],"ascending":false}
- {"op":"dedupe","columns":[...]|null,"keep":"first"|"last"}
- {"op":"group_by","columns":[...],"aggregations":[{"column":C,"func":"count"|"sum"|"mean"|"min"|"max"|"nunique"}],"calculated":{"Name":"[a]*100/[b]"}}
    "calculated" formulas use column SUMS per group: [a]*100/[b] is total a over total b (a ratio of sums, the correct way to get a percentage across groups). Use aggregations:[] when only calculated columns are wanted.
- {"op":"pivot","rows":[...],"columns":[...],"values":C|null,"func":"sum","totals":true,"calculated":{"Due":"[due_amt]","Repaid":"[paid_amt]","Repayment %":"[paid_amt]*100/[due_amt]"}}
    A pivot with "calculated" and values:null shows those calculated columns for each row group (and a Total row). Without "calculated", it shows func of "values" by rows x columns.
- {"op":"rate","columns":[...],"when":{"op":"filter","match":"all","conditions":[...]}|null,"formula":"[paid_date]<=[due_date]"|null}  percent of rows meeting a rule, per group.
- {"op":"top_n","n":10,"column":C,"largest":true,"per":[...]|null}
- {"op":"label","name":"user_type","ordered":true,"default":"New","cases":[{"value":"Old","when":{"op":"filter","match":"all","conditions":[{"column":"cx_repeat_flag","operator":"equals","value":"1"}]}}]}  a new column from rules; first matching case wins.
- {"op":"compute","name":"gst","expr":"[amount]*0.18","replace":false}   {"op":"formula","name":"grade","formula":"IF([amount]>50000,\\"High\\",\\"Low\\")","replace":false}
- {"op":"date_part","column":C,"part":"year"|"quarter"|"month"|"week"|"weekday"|"day","name":"due_month"}
- {"op":"calculate","kind":"percent_of_total"|"running_total"|"rank","column":C,"per":[...]|null,"descending":true,"name":"rank"}
- {"op":"clean_text","columns":[...]|null,"action":"trim"|"upper"|"lower"|"title"}   {"op":"fill_blanks","columns":[...]|null,"method":"value"|"down"|"up","value":"Unknown"}   {"op":"drop_blank_rows","how":"all"|"any"}
- {"op":"replace","columns":[...]|null,"find":"a","replace":"b"}   {"op":"split_column","column":C,"delimiter":" ","names":["first","last"]}   {"op":"merge_columns","columns":[...],"separator":" ","name":"full"}   {"op":"rename","mapping":{"old":"new"}}   {"op":"convert","columns":[...],"to":"number"|"date"|"text"}
- {"op":"highlight","when":{"op":"filter","match":"all","conditions":[...]},"color":"red"}   {"op":"number_format","columns":[...]|null,"style":"rupees"|"commas"|"percent"|"decimals"|"date","decimals":2}
- {"op":"lookup","file":"<other table name>","left_on":C,"right_on":C2,"columns":[...]}  brings columns from another table by a key (like XLOOKUP; the first match is used).
- {"op":"append","file":"<other table name>"}  stacks the rows of another table under this one (columns matched by name).
- {"op":"compare","file":"<other table name>","left_on":C,"right_on":C2,"keep":"only_here"|"only_there"|"both"}  rows whose key is only in this table, only in the other, or in both.
- {"op":"chart","kind":"column"|"bar"|"line"|"pie","x":C,"y":C|null,"func":"sum"|"mean"|"count"|"min"|"max","title":"..."}  (a chart is the LAST step, after the table it draws)
`.trim();

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const OPERATORS = new Set(["equals", "not_equals", "contains", "not_contains", "in", "not_in", "is_empty", "not_empty", "gt", "gte", "lt", "lte", "within_last_days", "older_than_days"]);
const FUNCS = new Set(["count", "sum", "mean", "min", "max", "nunique"]);

/** Fix small, harmless differences (a number where text is expected, a missing "match"). Returns a problem or the filter. */
function filterOf(v: unknown, where: string, problems: string[]): Raw | null {
  if (!isObj(v) || !Array.isArray(v.conditions) || !v.conditions.length) { problems.push(`${where}: a filter needs a list of conditions.`); return null; }
  const conditions = v.conditions.map((c) => {
    if (!isObj(c) || typeof c.column !== "string" || typeof c.operator !== "string" || !OPERATORS.has(c.operator)) {
      problems.push(`${where}: each condition needs a column and an operator (${[...OPERATORS].join(", ")}).`);
      return null;
    }
    const out: Raw = { column: c.column, operator: c.operator };
    if (c.value !== undefined && c.value !== null) out.value = String(c.value);
    if (Array.isArray(c.values)) out.values = c.values.map(String);
    return out;
  });
  if (conditions.some((c) => !c)) return null;
  return { op: "filter", match: v.match === "any" ? "any" : "all", conditions };
}

function calculated(v: unknown, where: string, problems: string[]): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v) || !Object.values(v).every((x) => typeof x === "string")) { problems.push(`${where}: "calculated" must map a name to a formula text.`); return {}; }
  return v as Record<string, string>;
}

function one(raw: unknown, i: number, problems: string[]): Step | null {
  const where = `Step ${i + 1}`;
  if (!isObj(raw) || typeof raw.op !== "string") { problems.push(`${where} is not a step with an "op".`); return null; }
  const s = raw;
  const need = (ok: boolean, what: string): boolean => { if (!ok) problems.push(`${where} (${s.op}): ${what}`); return ok; };
  switch (s.op) {
    case "filter": { const f = filterOf(s, `${where} (filter)`, problems); return f as unknown as Step | null; }
    case "filter_formula":
      return need(typeof s.formula === "string", "needs a formula.") ? { op: "filter_formula", formula: s.formula as string, keep: s.keep !== false } : null;
    case "select_columns": case "drop_columns":
      return need(strs(s.columns) && (s.columns as string[]).length > 0, "needs a list of columns.") ? ({ op: s.op, columns: s.columns } as Step) : null;
    case "sort":
      return need(strs(s.columns) && (s.columns as string[]).length > 0, "needs a list of columns.") ? { op: "sort", columns: s.columns as string[], ascending: s.ascending !== false } : null;
    case "dedupe":
      return { op: "dedupe", columns: strs(s.columns) && (s.columns as string[]).length ? (s.columns as string[]) : null, keep: s.keep === "last" ? "last" : "first" };
    case "group_by": {
      if (!need(strs(s.columns), "needs a list of columns to group by.")) return null;
      const aggs = Array.isArray(s.aggregations) ? s.aggregations : [];
      const ok = aggs.every((a) => isObj(a) && typeof a.column === "string" && typeof a.func === "string" && FUNCS.has(a.func));
      if (!need(ok, `aggregations need a column and a func (${[...FUNCS].join(", ")}).`)) return null;
      const calc = calculated(s.calculated, where, problems);
      if (!need(aggs.length > 0 || Object.keys(calc).length > 0, "needs aggregations or calculated columns.")) return null;
      return { op: "group_by", columns: s.columns as string[], aggregations: aggs.map((a) => ({ column: (a as Raw).column as string, func: (a as Raw).func as never })), calculated: calc };
    }
    case "pivot": {
      if (!need(strs(s.rows) && (s.rows as string[]).length > 0, "needs a list of row columns.")) return null;
      const calc = calculated(s.calculated, where, problems);
      const values = typeof s.values === "string" ? s.values : null;
      if (!need(values !== null || Object.keys(calc).length > 0, "needs a values column or calculated columns.")) return null;
      const func = typeof s.func === "string" && FUNCS.has(s.func) ? s.func : "sum";
      return { op: "pivot", rows: s.rows as string[], columns: strs(s.columns) ? (s.columns as string[]) : [], values, func: func as never, totals: s.totals !== false, calculated: calc };
    }
    case "rate": {
      if (!need(strs(s.columns), "needs a list of columns to group by.")) return null;
      const when = s.when ? filterOf(s.when, `${where} (rate)`, problems) : null;
      const formula = typeof s.formula === "string" ? s.formula : null;
      if (!need(!!when || !!formula, "needs a rule: \"when\" or \"formula\".")) return null;
      return { op: "rate", columns: s.columns as string[], when: when as never, formula: when ? null : formula };
    }
    case "top_n":
      return need(typeof s.n === "number" && s.n > 0, "needs a number n.")
        ? { op: "top_n", n: Math.floor(s.n as number), column: typeof s.column === "string" ? s.column : null, largest: s.largest !== false, per: strs(s.per) && (s.per as string[]).length ? (s.per as string[]) : null }
        : null;
    case "label": {
      if (!need(typeof s.name === "string" && Array.isArray(s.cases) && s.cases.length > 0, "needs a name and cases.")) return null;
      const cases = (s.cases as unknown[]).map((c) => {
        const f = isObj(c) ? filterOf(c.when, `${where} (label)`, problems) : null;
        return f && isObj(c) && c.value !== undefined ? { value: String(c.value), when: f } : null;
      });
      if (cases.some((c) => !c)) { problems.push(`${where} (label): each case needs "value" and "when".`); return null; }
      return { op: "label", name: s.name as string, cases: cases as never, default: s.default === undefined || s.default === null ? null : String(s.default), replace: s.replace === true, ordered: s.ordered !== false };
    }
    case "compute":
      return need(typeof s.name === "string" && typeof s.expr === "string", "needs a name and expr.") ? { op: "compute", name: s.name as string, expr: s.expr as string, replace: s.replace === true } : null;
    case "formula":
      return need(typeof s.name === "string" && typeof s.formula === "string", "needs a name and formula.") ? { op: "formula", name: s.name as string, formula: s.formula as string, replace: s.replace === true } : null;
    case "date_part":
      return need(typeof s.column === "string" && typeof s.name === "string" && ["year", "quarter", "month", "week", "weekday", "day"].includes(String(s.part)), "needs column, part and name.")
        ? { op: "date_part", column: s.column as string, part: s.part as never, name: s.name as string } : null;
    case "calculate":
      return need(typeof s.column === "string" && ["percent_of_total", "running_total", "rank"].includes(String(s.kind)), "needs column and kind.")
        ? { op: "calculate", kind: s.kind as never, column: s.column as string, per: strs(s.per) && (s.per as string[]).length ? (s.per as string[]) : null, descending: s.descending !== false, name: typeof s.name === "string" ? s.name : String(s.kind) } : null;
    case "clean_text":
      return need(["trim", "upper", "lower", "title"].includes(String(s.action)), "needs an action.") ? { op: "clean_text", columns: strs(s.columns) ? (s.columns as string[]) : null, action: s.action as never } : null;
    case "fill_blanks":
      return need(["value", "down", "up"].includes(String(s.method)), "needs a method.") ? { op: "fill_blanks", columns: strs(s.columns) ? (s.columns as string[]) : null, method: s.method as never, value: s.value === undefined || s.value === null ? null : String(s.value) } : null;
    case "drop_blank_rows":
      return { op: "drop_blank_rows", how: s.how === "any" ? "any" : "all" };
    case "replace":
      return need(typeof s.find === "string" && typeof s.replace === "string", "needs find and replace.") ? { op: "replace", columns: strs(s.columns) ? (s.columns as string[]) : null, find: s.find as string, replace: s.replace as string } : null;
    case "split_column":
      return need(typeof s.column === "string" && typeof s.delimiter === "string" && strs(s.names), "needs column, delimiter and names.") ? { op: "split_column", column: s.column as string, delimiter: s.delimiter as string, names: s.names as string[] } : null;
    case "merge_columns":
      return need(strs(s.columns) && typeof s.name === "string", "needs columns and a name.") ? { op: "merge_columns", columns: s.columns as string[], separator: typeof s.separator === "string" ? s.separator : " ", name: s.name as string } : null;
    case "rename":
      return need(isObj(s.mapping) && Object.values(s.mapping).every((x) => typeof x === "string"), "needs a mapping.") ? { op: "rename", mapping: s.mapping as Record<string, string> } : null;
    case "convert":
      return need(strs(s.columns) && ["number", "date", "text"].includes(String(s.to)), "needs columns and a target type.") ? { op: "convert", columns: s.columns as string[], to: s.to as never } : null;
    case "highlight": {
      const when = s.when ? filterOf(s.when, `${where} (highlight)`, problems) : null;
      return need(!!when, "needs a \"when\" rule.") ? { op: "highlight", when: when as never, duplicates_in: null, column: typeof s.column === "string" ? s.column : null, color: typeof s.color === "string" ? s.color : "yellow" } : null;
    }
    case "number_format":
      return need(["rupees", "commas", "percent", "decimals", "date"].includes(String(s.style)), "needs a style.") ? { op: "number_format", columns: strs(s.columns) ? (s.columns as string[]) : null, style: s.style as never, decimals: typeof s.decimals === "number" ? s.decimals : 2, date_pattern: typeof s.date_pattern === "string" ? s.date_pattern : "dd-mmm-yyyy" } : null;
    case "lookup":
      return need(typeof s.file === "string" && typeof s.left_on === "string" && typeof s.right_on === "string" && strs(s.columns) && (s.columns as string[]).length > 0, "needs file, left_on, right_on and columns.")
        ? { op: "lookup", file: s.file as string, left_on: s.left_on as string, right_on: s.right_on as string, columns: s.columns as string[] } : null;
    case "append":
      return need(typeof s.file === "string", "needs the other table's name in \"file\".") ? { op: "append", file: s.file as string } : null;
    case "compare":
      return need(typeof s.file === "string", "needs the other table's name in \"file\".")
        ? { op: "compare", file: s.file as string, left_on: typeof s.left_on === "string" ? s.left_on : null, right_on: typeof s.right_on === "string" ? s.right_on : null, keep: s.keep === "only_there" ? "only_there" : s.keep === "both" ? "both" : "only_here" } : null;
    case "chart":
      return need(["column", "bar", "line", "pie"].includes(String(s.kind)) && typeof s.x === "string", "needs kind and x.")
        ? { op: "chart", kind: s.kind as never, x: s.x as string, x_part: null, y: typeof s.y === "string" ? s.y : null, func: ["sum", "mean", "count", "min", "max"].includes(String(s.func)) ? (s.func as never) : "sum", title: typeof s.title === "string" ? s.title : "Chart", when: null } : null;
    default:
      problems.push(`${where}: “${String(s.op)}” is not a step I can run.`);
      return null;
  }
}

export interface Normalised { plan: Plan | null; problems: string[] }

/** Turn the model's loose steps into a typed plan, or say what is wrong with them. */
export function normalisePlan(raw: unknown, reading: string[] = []): Normalised {
  const problems: string[] = [];
  const stepsRaw = isObj(raw) ? raw.steps : Array.isArray(raw) ? raw : null;
  if (!Array.isArray(stepsRaw) || !stepsRaw.length) return { plan: null, problems: ["The plan needs a non-empty list of steps."] };
  const steps = stepsRaw.map((s, i) => one(s, i, problems));
  if (problems.length || steps.some((s) => !s)) return { plan: null, problems };
  const typed = steps as Step[];
  const summary = (() => { try { return typed.map(describeStep).join("; ") + "."; } catch { return reading.join(" "); } })();
  return { plan: { clarification_question: null, summary, steps: typed, awaits_columns: false }, problems: [] };
}
