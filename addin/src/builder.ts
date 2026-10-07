/**
 * The guided builder: pick from menus instead of typing. Every template turns the choices into one plain sentence,
 * which then goes through exactly the same parser and preview as anything the user types. So the builder can't do
 * anything a typed command can't, and what it produces is always visible.
 */
import type { Table } from "./engine/table";
import { parseNumber } from "./engine/util";

export type Values = Record<string, string | string[]>;

export interface Field {
  id: string;
  label: string;
  type: "column" | "columns" | "choice" | "text" | "sheet";
  choices?: string[];
  optional?: boolean;
  /** Offer only these columns (by what they hold). */
  columnKind?: "number" | "date" | "text";
  placeholder?: string;
  /** Show this field only when another choice makes it relevant. */
  showIf?: (v: Values) => boolean;
}

export interface Template {
  id: string;
  title: string;
  hint: string;
  fields: Field[];
  sentence(v: Values): string;
}

const one = (v: Values, id: string): string => {
  const x = v[id];
  return (Array.isArray(x) ? x[0] : x) ?? "";
};
const many = (v: Values, id: string): string[] => {
  const x = v[id];
  return Array.isArray(x) ? x : x ? [x] : [];
};
const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A value typed by the user as it should appear in a sentence: numbers as they are, text in quotes. */
const lit = (s: string): string => (parseNumber(s.trim()) !== null ? s.trim() : `"${s.trim().replace(/"/g, "'")}"`);

const OPERATORS: Record<string, { word: string; needsValue: boolean }> = {
  "is": { word: "is", needsValue: true },
  "is not": { word: "is not", needsValue: true },
  "contains": { word: "contains", needsValue: true },
  "does not contain": { word: "does not contain", needsValue: true },
  "is more than": { word: ">", needsValue: true },
  "is at least": { word: ">=", needsValue: true },
  "is less than": { word: "<", needsValue: true },
  "is at most": { word: "<=", needsValue: true },
  "is empty": { word: "is empty", needsValue: false },
  "is not empty": { word: "is not empty", needsValue: false },
};
const OPERATOR_NAMES = Object.keys(OPERATORS);

function condition(v: Values, n: string): string {
  const col = one(v, `col${n}`), op = OPERATORS[one(v, `op${n}`) || "is"];
  if (!col) return "";
  return op.needsValue ? `${col} ${op.word} ${lit(one(v, `value${n}`))}` : `${col} ${op.word}`;
}

const conditionFields = (n: string, optional: boolean): Field[] => [
  { id: `col${n}`, label: n === "2" ? "…and this column" : n === "W" ? "Only for rows where this column (optional)" : "Column", type: "column", optional },
  { id: `op${n}`, label: "is it…", type: "choice", choices: OPERATOR_NAMES, optional },
  { id: `value${n}`, label: "Value", type: "text", optional: true, placeholder: "e.g. 5000 or Pune", showIf: (v) => OPERATORS[one(v, `op${n}`) || "is"]?.needsValue !== false },
];

const FUNCS: Record<string, string> = { "total": "total", "average": "average", "count": "count", "smallest": "minimum", "largest": "maximum" };

export const TEMPLATES: Template[] = [
  {
    id: "filter", title: "Keep only some rows", hint: "Rows where a column is, contains, or is more or less than something.",
    fields: [...conditionFields("", false), { id: "join", label: "Add a second condition?", type: "choice", choices: ["", "and", "or"], optional: true }, ...conditionFields("2", true).map((f) => ({ ...f, showIf: (v: Values) => !!one(v, "join") && (f.showIf?.(v) ?? true) }))],
    sentence: (v) => `only rows where ${condition(v, "")}${one(v, "join") && one(v, "col2") ? ` ${one(v, "join")} ${condition(v, "2")}` : ""}`,
  },
  {
    id: "remove", title: "Remove some rows", hint: "Take out the rows that match.",
    fields: conditionFields("", false),
    sentence: (v) => `remove rows where ${condition(v, "")}`,
  },
  {
    id: "sort", title: "Sort", hint: "Order the rows by a column.",
    fields: [
      { id: "col", label: "Sort by", type: "column" },
      { id: "dir", label: "Order", type: "choice", choices: ["ascending (A to Z, small to big, oldest first)", "descending (Z to A, big to small, newest first)"] },
      { id: "col2", label: "Then by", type: "column", optional: true },
    ],
    sentence: (v) => `sort by ${one(v, "col")}${one(v, "col2") ? ` and ${one(v, "col2")}` : ""} ${one(v, "dir").startsWith("desc") ? "descending" : "ascending"}`,
  },
  {
    id: "split", title: "Split into one sheet per value", hint: "For example one sheet per branch.",
    fields: [{ id: "col", label: "Split by", type: "column" }],
    sentence: (v) => `split by ${one(v, "col")}`,
  },
  {
    id: "total", title: "Totals, averages or counts by group", hint: "For example total amount for each branch.",
    fields: [
      { id: "func", label: "Work out the", type: "choice", choices: Object.keys(FUNCS) },
      { id: "value", label: "of this column", type: "column", columnKind: "number", showIf: (v) => one(v, "func") !== "count" },
      { id: "by", label: "for each…", type: "columns" },
      ...conditionFields("W", true),
      { id: "pct", label: "Show % of total too?", type: "choice", choices: ["no", "yes"], optional: true },
    ],
    sentence: (v) => {
      const f = FUNCS[one(v, "func") || "total"];
      const value = one(v, "func") === "count" ? "" : one(v, "value");
      const only = one(v, "colW") ? `only rows where ${condition(v, "W")}, then show ` : "";
      return `${only}${f} ${value} by ${joinAnd(many(v, "by"))}${one(v, "pct") === "yes" ? " with % of total" : ""}`.replace(/\s+/g, " ");
    },
  },
  {
    id: "pivot", title: "Pivot table", hint: "Rows down the side, another column across the top.",
    fields: [
      { id: "func", label: "Work out the", type: "choice", choices: Object.keys(FUNCS) },
      { id: "value", label: "of this column", type: "column", columnKind: "number", showIf: (v) => one(v, "func") !== "count" },
      { id: "rows", label: "Down the side", type: "columns" },
      { id: "cols", label: "Across the top", type: "column", optional: true },
    ],
    sentence: (v) => {
      const f = FUNCS[one(v, "func") || "total"];
      const value = one(v, "func") === "count" ? "" : one(v, "value");
      return `pivot ${f} ${value} with ${joinAnd(many(v, "rows"))} in rows${one(v, "cols") ? ` and ${one(v, "cols")} in columns` : ""}`.replace(/\s+/g, " ");
    },
  },
  {
    id: "top", title: "Top or bottom rows", hint: "The biggest or smallest few.",
    fields: [
      { id: "dir", label: "Show the", type: "choice", choices: ["top", "bottom"] },
      { id: "n", label: "How many", type: "text", placeholder: "10" },
      { id: "col", label: "by this column", type: "column" },
      { id: "per", label: "within each… (optional)", type: "column", optional: true },
    ],
    sentence: (v) => `${one(v, "dir") || "top"} ${parseInt(one(v, "n"), 10) || 10} by ${one(v, "col")}${one(v, "per") ? ` per ${one(v, "per")}` : ""}`,
  },
  {
    id: "dedupe", title: "Remove repeated rows", hint: "Whole rows, or by one or more columns.",
    fields: [{ id: "cols", label: "Repeated means the same… (leave empty for the whole row)", type: "columns", optional: true }],
    sentence: (v) => (many(v, "cols").length ? `remove duplicates by ${joinAnd(many(v, "cols"))}` : "remove duplicate rows"),
  },
  {
    id: "columns", title: "Keep or drop columns", hint: "Choose which columns stay.",
    fields: [
      { id: "mode", label: "I want to", type: "choice", choices: ["keep", "drop"] },
      { id: "cols", label: "These columns", type: "columns" },
    ],
    sentence: (v) => `${one(v, "mode") === "drop" ? "drop" : "keep"} columns ${many(v, "cols").join(", ")}`,
  },
  {
    id: "calc", title: "New column from a calculation", hint: "For example amount × 0.18, or credit − debit.",
    fields: [
      { id: "name", label: "Name of the new column", type: "text", placeholder: "gst" },
      { id: "a", label: "Start with", type: "column", columnKind: "number" },
      { id: "op", label: "then", type: "choice", choices: ["+", "-", "*", "/"] },
      { id: "b", label: "this column, or a number", type: "text", placeholder: "0.18 or another column's name" },
    ],
    sentence: (v) => {
      const b = one(v, "b").trim();
      return `add column ${one(v, "name")} = [${one(v, "a")}] ${one(v, "op") || "+"} ${parseNumber(b) !== null ? b : `[${b}]`}`;
    },
  },
  {
    id: "ifelse", title: "New column with if / else", hint: "For example High if amount is over 50000, otherwise Low.",
    fields: [
      { id: "name", label: "Name of the new column", type: "text", placeholder: "size" },
      { id: "col", label: "If this column", type: "column" },
      { id: "op", label: "is…", type: "choice", choices: OPERATOR_NAMES },
      { id: "value", label: "Value", type: "text", optional: true, showIf: (v) => OPERATORS[one(v, "op") || "is"]?.needsValue !== false },
      { id: "then", label: "write", type: "text", placeholder: "High" },
      { id: "else", label: "otherwise write", type: "text", placeholder: "Low", optional: true },
    ],
    sentence: (v) => `add column ${one(v, "name")} = ${lit(one(v, "then"))} if ${condition({ ...v, col: one(v, "col"), op: one(v, "op"), value: one(v, "value") }, "")}${one(v, "else") ? ` else ${lit(one(v, "else"))}` : ""}`,
  },
  {
    id: "formula", title: "New column from an Excel formula", hint: "Type it like in Excel. Write column names in [brackets].",
    fields: [
      { id: "name", label: "Name of the new column", type: "text", placeholder: "grade" },
      { id: "formula", label: "Formula", type: "text", placeholder: '=IF([amount]>50000,"High","Low")' },
    ],
    sentence: (v) => `add column ${one(v, "name")} = ${one(v, "formula").replace(/^=/, "")}`,
  },
  {
    id: "clean", title: "Tidy up the data", hint: "Spaces, capitals, blanks.",
    fields: [
      { id: "what", label: "I want to", type: "choice", choices: ["trim extra spaces", "make UPPERCASE", "make lowercase", "make Title Case", "fill blank cells with…", "fill blank cells with the value above", "remove empty rows"] },
      { id: "cols", label: "In these columns (leave empty for all)", type: "columns", optional: true },
      { id: "fill", label: "Fill with", type: "text", optional: true, placeholder: "Unknown", showIf: (v) => one(v, "what").startsWith("fill blank cells with…") },
    ],
    sentence: (v) => {
      const cols = many(v, "cols");
      const where = cols.length ? ` ${joinAnd(cols)}` : "";
      switch (one(v, "what")) {
        case "make UPPERCASE": return cols.length ? `make${where} uppercase` : "make everything uppercase";
        case "make lowercase": return cols.length ? `make${where} lowercase` : "make everything lowercase";
        case "make Title Case": return cols.length ? `make${where} title case` : "make everything title case";
        case "fill blank cells with…": return `fill blank${where || " cells"} with ${lit(one(v, "fill") || "Unknown")}`;
        case "fill blank cells with the value above": return `fill down${where}`;
        case "remove empty rows": return "remove blank rows";
        default: return cols.length ? `trim${where}` : "trim spaces";
      }
    },
  },
  {
    id: "lookup", title: "Bring columns from another sheet", hint: "Like VLOOKUP: match on one column.",
    fields: [
      { id: "sheet", label: "From the sheet", type: "sheet" },
      { id: "get", label: "Bring these columns (their names there)", type: "text", placeholder: "manager, region" },
      { id: "key", label: "Match using this column here", type: "column" },
    ],
    sentence: (v) => `bring ${one(v, "get")} from ${one(v, "sheet")} on ${one(v, "key")}`,
  },
  {
    id: "chart", title: "Chart", hint: "Bars, lines or a pie of totals or counts.",
    fields: [
      { id: "kind", label: "Type", type: "choice", choices: ["bar", "line", "pie"] },
      { id: "func", label: "Show the", type: "choice", choices: Object.keys(FUNCS) },
      { id: "value", label: "of this column", type: "column", columnKind: "number", showIf: (v) => one(v, "func") !== "count" },
      { id: "by", label: "for each…", type: "column" },
    ],
    sentence: (v) => `${one(v, "kind") || "bar"} chart of ${FUNCS[one(v, "func") || "total"]} ${one(v, "func") === "count" ? "" : one(v, "value")} by ${one(v, "by")}`.replace(/\s+/g, " "),
  },
  {
    id: "highlight", title: "Highlight rows", hint: "Colour the rows that match.",
    fields: [
      ...conditionFields("", false),
      { id: "color", label: "Colour", type: "choice", choices: ["yellow", "red", "green", "blue", "orange", "purple", "pink", "grey"] },
    ],
    sentence: (v) => `highlight rows where ${condition(v, "")} in ${one(v, "color") || "yellow"}`,
  },
];

/** Which fields are showing, given the choices made so far. */
export const visibleFields = (t: Template, v: Values): Field[] => t.fields.filter((f) => !f.showIf || f.showIf(v));

/** The sentence for the choices, or the first thing still missing. */
export function build(t: Template, v: Values): { sentence: string } | { missing: string } {
  for (const f of visibleFields(t, v)) {
    if (f.optional) continue;
    const x = v[f.id];
    if (!x || (Array.isArray(x) ? x.length === 0 : x.trim() === "")) return { missing: f.label };
  }
  return { sentence: t.sentence(v).replace(/\s+/g, " ").trim() };
}

/** Columns of `table` that suit a field. */
export function columnChoices(table: Table, f: Field): string[] {
  return table.columns
    .filter((c) => !f.columnKind || (f.columnKind === "text" ? c.kind === "text" : c.kind === f.columnKind))
    .map((c) => c.name);
}
