/** A short, meaningful name for the sheet a plan produces (instead of "Result", "Result (2)", ...). */
import type { Plan, Step } from "./plan";

const MAX = 31;
const fit = (s: string) => (s.length <= MAX ? s : s.slice(0, MAX - 1).trimEnd() + "…");
const list = (xs: string[]) => xs.join(", ");

function describeOne(step: Step): string | null {
  switch (step.op) {
    case "group_by": return `Totals by ${list(step.columns)}`;
    case "pivot": return `Pivot by ${list(step.rows)}`;
    case "top_n": return step.column ? `Top ${step.n} by ${step.column}` : `${step.largest ? "First" : "Last"} ${step.n} rows`;
    case "filter": case "filter_formula": return "Filtered";
    case "sort": return `Sorted by ${list(step.columns)}`;
    case "dedupe": return "No duplicates";
    case "select_columns": case "drop_columns": return "Columns";
    case "compute": case "formula": case "label": return `With ${step.name}`;
    case "date_part": return `With ${step.name}`;
    case "calculate": return `With ${step.name}`;
    case "clean_text": case "fill_blanks": case "drop_blank_rows": case "replace": case "split_column": case "merge_columns": return "Cleaned";
    case "rename": return "Renamed";
    case "convert": return "Converted";
    case "lookup": return "With lookup";
    case "append": return "Combined";
    case "compare": return "Compared";
    case "highlight": case "number_format": return "Formatted";
    case "chart": return null;
    case "split_by": return null;
  }
}

/** Name for a single-sheet result: the last thing the plan did to the data (a date_part before a total doesn't count). */
export function sheetNameFor(plan: Plan): string {
  const named = plan.steps.map(describeOne).filter((n): n is string => n !== null);
  const last = named[named.length - 1];
  if (!last) return "Result";
  // "Filtered" + a sort reads best as just the sort; keep the most informative recent step.
  return fit(last.replace(/[[\]:*?/\\]/g, "_"));
}
