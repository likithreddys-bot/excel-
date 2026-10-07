/** Plain-English description of each step, shown in the preview before anything runs. */
import type { Condition, FilterStep, Step } from "./plan";

const OP_TEXT: Record<Condition["operator"], string> = {
  equals: "is", not_equals: "is not", contains: "contains", not_contains: "does not contain",
  in: "is one of", not_in: "is not one of", is_empty: "is empty", not_empty: "is not empty",
  gt: ">", gte: "≥", lt: "<", lte: "≤",
  within_last_days: "is within the last", older_than_days: "is older than",
};

export const COLORS: Record<string, string> = {
  yellow: "FFF2CC", red: "F4CCCC", green: "D9EAD3", blue: "CFE2F3", orange: "FCE5CD",
  purple: "D9D2E9", pink: "F8D7E3", grey: "E7E6E6",
  "dark yellow": "FFD966", "dark red": "E06666", "dark green": "93C47D", "dark blue": "6FA8DC",
  "dark orange": "F6B26B", "dark purple": "8E7CC3", "dark pink": "E48FB0", "dark grey": "B7B7B7",
};
const COLOR_NAMES = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [v, k]));

const CALCULATED_NOTE = " (worked out from each group's totals, like an Excel calculated field, not an average of row values)";

function describeCalculated(name: string, expr: string): string {
  if (expr === `[${name}]`) return `total ${name}`;
  return `${name} = ` + expr.replace(/\[([^\]]+)\]/g, "total $1");
}

const describeFilter = (step: FilterStep): string => {
  const parts = step.conditions.map((c) => {
    let v = c.values?.length ? c.values.join(", ") : (c.value ?? "");
    if (c.operator === "within_last_days" || c.operator === "older_than_days") v += " days";
    return `${c.column} ${OP_TEXT[c.operator]} ${v}`.trim();
  });
  return "Keep rows where " + parts.join(step.match === "all" ? " and " : " or ");
};

const noPrefix = (s: string) => s.replace(/^Keep rows where /, "");

export function describe(step: Step): string {
  switch (step.op) {
    case "filter": return describeFilter(step);
    case "select_columns": return "Keep only columns " + step.columns.join(", ");
    case "drop_columns": return "Remove columns " + step.columns.join(", ");
    case "sort": return `Sort by ${step.columns.join(", ")} (${step.ascending ? "ascending" : "descending"})`;
    case "dedupe":
      return `Remove duplicate rows${step.columns ? ` by ${step.columns.join(", ")}` : " (whole row)"}, keeping the ${step.keep}`;
    case "group_by": {
      const parts = step.aggregations.map((a) => `${a.func} of ${a.column}`);
      parts.push(...Object.entries(step.calculated).map(([n, e]) => describeCalculated(n, e)));
      const note = Object.entries(step.calculated).some(([n, e]) => e !== `[${n}]`) ? CALCULATED_NOTE : "";
      return `Group by ${step.columns.join(", ")} with ${parts.join(", ")}${note}`;
    }
    case "split_by": return `Split into one sheet per ${step.column}`;
    case "pivot": {
      if (Object.keys(step.calculated).length) {
        const fields = Object.entries(step.calculated).map(([n, e]) => describeCalculated(n, e)).join("; ");
        const note = Object.entries(step.calculated).some(([n, e]) => e !== `[${n}]`) ? CALCULATED_NOTE : "";
        return `Pivot with ${step.rows.join(", ")} down the side: ${fields}` + (step.totals ? ", with a Total row" : "") + note;
      }
      const what = step.values ? `${step.func} of ${step.values}` : "count of rows";
      const across = step.columns.length ? `, ${step.columns.join(", ")} across the top` : "";
      return `Pivot: ${what} with ${step.rows.join(", ")} down the side${across}` + (step.totals ? ", with totals" : "");
    }
    case "top_n": {
      if (step.column === null) return `Keep the ${step.largest ? "first" : "last"} ${step.n} rows`;
      const per = step.per ? ` within each ${step.per.join(", ")}` : "";
      return `Keep the ${step.n} ${step.largest ? "highest" : "lowest"} by ${step.column}${per}`;
    }
    case "date_part": return `Add column '${step.name}' = ${step.part} of ${step.column}`;
    case "calculate": {
      const per = step.per ? ` within each ${step.per.join(", ")}` : "";
      const what = {
        percent_of_total: `${step.column} as % of total`,
        running_total: `running total of ${step.column}`,
        rank: `rank by ${step.column} (${step.descending ? "highest" : "lowest"} = 1)`,
      }[step.kind];
      return `Add column '${step.name}' = ${what}${per}`;
    }
    case "clean_text": {
      const where = step.columns ? step.columns.join(", ") : "all text columns";
      const what = { trim: "Trim extra spaces", upper: "Make UPPERCASE", lower: "Make lowercase", title: "Make Title Case" }[step.action];
      return `${what} in ${where}`;
    }
    case "fill_blanks": {
      const where = step.columns ? step.columns.join(", ") : "all columns";
      const how = { value: `with '${step.value}'`, down: "with the value above", up: "with the value below" }[step.method];
      return `Fill blank cells in ${where} ${how}`;
    }
    case "drop_blank_rows":
      return step.how === "all" ? "Remove completely empty rows" : "Remove rows that have any empty cell";
    case "replace": {
      const where = step.columns ? step.columns.join(", ") : "all text columns";
      return `Replace '${step.find}' with ${step.replace ? `'${step.replace}'` : "nothing (remove it)"} in ${where}`;
    }
    case "split_column": {
      const d = ({ " ": "space", "\t": "tab" } as Record<string, string>)[step.delimiter] ?? `'${step.delimiter}'`;
      return `Split ${step.column} at each ${d} into new columns ${step.names.join(", ")} (original kept)`;
    }
    case "merge_columns": {
      const sep = ({ " ": "a space", "": "nothing" } as Record<string, string>)[step.separator] ?? `'${step.separator}'`;
      return `Combine ${step.columns.join(", ")} into new column '${step.name}', separated by ${sep}`;
    }
    case "rename": return "Rename " + Object.entries(step.mapping).map(([a, b]) => `${a} → ${b}`).join(", ");
    case "convert": return `Convert ${step.columns.join(", ")} to ${step.to}`;
    case "compute": return `${step.replace ? "Replace" : "Add"} column '${step.name}' = ${step.expr.replace(/\[([^\]]+)\]/g, "$1")}`;
    case "label": {
      const rules = step.cases.map((c) => `'${c.value}' if ${noPrefix(describeFilter(c.when))}`).join("; ");
      const other = step.default !== null ? `; otherwise '${step.default}'`
        : step.replace ? "; otherwise keep the current value" : "; otherwise blank";
      return `${step.replace ? "Replace" : "Add"} column '${step.name}': ${rules}${other}`;
    }
    case "lookup":
      return `Look up ${step.columns.join(", ")} from ${step.file}, matching ${step.left_on} here to ${step.right_on} in ${step.file} (first match, like VLOOKUP)`;
    case "append": return `Add the rows of ${step.file} below this data (columns lined up by name)`;
    case "compare": {
      const by = step.left_on ? `matching ${step.left_on} to ${step.right_on}` : "comparing whole rows";
      return {
        only_here: `Keep rows that are not in ${step.file} (${by})`,
        only_there: `Show rows of ${step.file} that are not in this data (${by})`,
        both: `Keep rows that are also in ${step.file} (${by})`,
      }[step.keep];
    }
    case "highlight": {
      const colour = COLOR_NAMES[step.color] ?? `#${step.color}`;
      const target = step.column ? `${step.column} cells` : "rows";
      const rule = step.duplicates_in ? `with a repeated ${step.duplicates_in}` : "where " + noPrefix(describeFilter(step.when!));
      return `Highlight ${target} ${rule} in ${colour}`;
    }
    case "number_format": {
      const what = {
        rupees: "rupees (₹12,34,567.00)", commas: "numbers with commas", percent: "percent",
        decimals: `${step.decimals} decimal places`, date: step.date_pattern,
      }[step.style];
      return `Show ${step.columns ? step.columns.join(", ") : "all number columns"} as ${what}`;
    }
    case "chart": {
      const only = step.when ? " for rows where " + noPrefix(describeFilter(step.when)) : "";
      return `Add a ${step.kind} chart '${step.title}'${only} on a new sheet`;
    }
  }
}
