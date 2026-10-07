/** The structured plan the parser produces and the engine executes (mirrors plan.py). */

export type Operator =
  | "equals" | "not_equals" | "contains" | "not_contains" | "in" | "not_in"
  | "is_empty" | "not_empty" | "gt" | "gte" | "lt" | "lte"
  | "within_last_days" | "older_than_days";

export interface Condition {
  column: string;
  operator: Operator;
  value?: string | null;
  values?: string[] | null;
}

export interface FilterStep { op: "filter"; conditions: Condition[]; match: "all" | "any" }
export interface SelectColumnsStep { op: "select_columns"; columns: string[] }
export interface DropColumnsStep { op: "drop_columns"; columns: string[] }
export interface SortStep { op: "sort"; columns: string[]; ascending: boolean }
export interface DedupeStep { op: "dedupe"; columns: string[] | null; keep: "first" | "last" }
export interface Aggregation { column: string; func: "count" | "sum" | "mean" | "min" | "max" | "nunique" }
export interface GroupByStep { op: "group_by"; columns: string[]; aggregations: Aggregation[]; calculated: Record<string, string> }
export interface SplitByStep { op: "split_by"; column: string }
export interface PivotStep {
  op: "pivot"; rows: string[]; columns: string[]; values: string | null;
  func: Aggregation["func"]; totals: boolean; calculated: Record<string, string>;
}
export interface TopNStep { op: "top_n"; n: number; column: string | null; largest: boolean; per: string[] | null }
export type DatePart = "year" | "quarter" | "month" | "week" | "weekday" | "day";
export interface DatePartStep { op: "date_part"; column: string; part: DatePart; name: string }
export interface CalculateStep {
  op: "calculate"; kind: "percent_of_total" | "running_total" | "rank";
  column: string; per: string[] | null; descending: boolean; name: string;
}
export interface CleanTextStep { op: "clean_text"; columns: string[] | null; action: "trim" | "upper" | "lower" | "title" }
export interface FillBlanksStep { op: "fill_blanks"; columns: string[] | null; method: "value" | "down" | "up"; value: string | null }
export interface DropBlankRowsStep { op: "drop_blank_rows"; how: "all" | "any" }
export interface ReplaceStep { op: "replace"; columns: string[] | null; find: string; replace: string }
export interface SplitColumnStep { op: "split_column"; column: string; delimiter: string; names: string[] }
export interface MergeColumnsStep { op: "merge_columns"; columns: string[]; separator: string; name: string }
export interface RenameStep { op: "rename"; mapping: Record<string, string> }
export interface ConvertStep { op: "convert"; columns: string[]; to: "number" | "date" | "text" }
export interface ComputeStep { op: "compute"; name: string; expr: string; replace: boolean }
export interface LabelCase { when: FilterStep; value: string }
export interface LabelStep { op: "label"; name: string; cases: LabelCase[]; default: string | null; replace: boolean }
export interface LookupStep { op: "lookup"; file: string; left_on: string; right_on: string; columns: string[] }
export interface AppendStep { op: "append"; file: string }
export interface CompareStep { op: "compare"; file: string; left_on: string | null; right_on: string | null; keep: "only_here" | "only_there" | "both" }
export interface HighlightStep {
  op: "highlight"; when: FilterStep | null; duplicates_in: string | null; column: string | null; color: string;
}
export interface NumberFormatStep {
  op: "number_format"; columns: string[] | null;
  style: "rupees" | "commas" | "percent" | "decimals" | "date"; decimals: number; date_pattern: string;
}
export interface ChartStep {
  op: "chart"; kind: "column" | "bar" | "line" | "pie"; x: string; x_part: DatePart | null;
  y: string | null; func: "sum" | "mean" | "count" | "min" | "max"; title: string; when: FilterStep | null;
}

export type Step =
  | FilterStep | SelectColumnsStep | DropColumnsStep | SortStep | DedupeStep | GroupByStep
  | SplitByStep | PivotStep | TopNStep | DatePartStep | CalculateStep
  | CleanTextStep | FillBlanksStep | DropBlankRowsStep | ReplaceStep | SplitColumnStep
  | MergeColumnsStep | RenameStep | ConvertStep | ComputeStep | LabelStep
  | LookupStep | AppendStep | CompareStep | HighlightStep | NumberFormatStep | ChartStep;

export interface Plan {
  clarification_question: string | null;
  summary: string;
  steps: Step[];
  /** The question can be answered by replying with column names. */
  awaits_columns: boolean;
}
