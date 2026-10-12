/** The prompts. They contain the question, column names and the profile (see profile.ts), and never a data row. */
import { Dictionary, describeSegment } from "../engine/dictionary";
import { ColumnProfile, describeColumn } from "./profile";
import { STEP_REFERENCE } from "./schema";

export interface PlanPromptInput {
  question: string;
  rows: number;
  columns: ColumnProfile[];
  /** Total columns in the file when only some were read. */
  totalColumns?: number;
  dictionary: Dictionary;
  /** Things the person confirmed earlier ("old user: cx_repeat_flag is 1"). */
  notes: string[];
  /** Answers to questions asked while working on this request. */
  clarifications: string[];
  /** On a retry: what was wrong with the last plan. */
  feedback?: string;
}

const RULES = `
You are the planning brain of a spreadsheet assistant for people who work with banking and lending data. You turn a request into a plan of steps. A separate engine runs the plan on every row and writes the result to a sheet. You never see the rows and you never calculate numbers yourself.

How to plan:
- Use only the columns listed, with their exact names. Never invent a column.
- The result should be the table the person would want to look at: normally a small summary (a pivot or grouped table), not the raw rows, unless they asked to filter or clean rows.
- "pivot table" or "pivot" means a pivot step. "chart/graph/plot" adds a chart step last.
- A percentage across groups (repayment %, collection %, approval %) is total of one column over total of another, as a "calculated" formula like [paid]*100/[due]. Never average row-level percentages.
- Rate of rows that meet a rule ("% of loans paid on time by state") is a rate step.
- If a word in the request needs a definition that is not in the notes (for example "old user", "NPA", "on time", "active") and the columns allow more than one reasonable meaning, ask ONE short question with 2 to 4 options written in plain words that mention the column and value. If the meaning is clear from the columns and values, do not ask: state your assumption in "reading".
- Use the notes. They are definitions the person already confirmed.
- Keep names of new columns short and readable (Old, New, Due, Repaid, Repayment %).
- Dates in the data are real dates; compare them with date columns or functions, not text.

Reply with ONE JSON object and nothing else:
  {"reading":["short plain-words line per assumption, e.g. Old user = cx_repeat_flag is 1","Repayment % = total repaid / total due"],"plan":{"steps":[...]}}
or, only when you truly must ask:
  {"question":"What counts as an old user?","options":["cx_repeat_flag is 1","loan_order_cnt is more than 1"]}
`.trim();

export function planPrompt(i: PlanPromptInput): { system: string; user: string } {
  const system = `${RULES}\n\n${STEP_REFERENCE}`;
  const dict = Object.values(i.dictionary.segments).map((d) => describeSegment(d));
  const notes = [...dict, ...i.notes];
  const lines = [
    `The sheet has ${i.rows.toLocaleString("en-IN")} rows${i.totalColumns && i.totalColumns > i.columns.length ? ` and ${i.totalColumns} columns (the ${i.columns.length} below are loaded)` : ` and ${i.columns.length} columns`}.`,
    "Columns (name (role, type); range; distinct values; empty share; common values):",
    ...i.columns.map((c) => `- ${describeColumn(c)}`),
    "",
    "Notes from the person (definitions already confirmed):",
    ...(notes.length ? notes.map((n) => `- ${n}`) : ["(none yet)"]),
    "",
    `Request: ${i.question}`,
  ];
  if (i.clarifications.length) lines.push("", "Answers the person gave while clarifying this request:", ...i.clarifications.map((c) => `- ${c}`));
  if (i.feedback) lines.push("", i.feedback);
  return { system, user: lines.join("\n") };
}

/** For a file with hundreds of columns: first decide which columns the request needs. */
export function columnsPrompt(question: string, headers: string[], notes: string[]): { system: string; user: string } {
  const system = [
    "You help a spreadsheet assistant decide which columns of a very wide file are needed to answer a request, so only those are loaded.",
    "Choose every column the request could need: the ones to group by, the amounts or dates to measure, and the ones that would define words like 'old user' or 'on time'. Prefer a few extra over missing one; at most 25.",
    "Use exact names from the list. Reply with ONE JSON object: {\"columns\":[\"name\", ...]}",
  ].join("\n");
  const user = `Columns (${headers.length}):\n${headers.join(", ")}\n\nNotes from the person:\n${notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(none)"}\n\nRequest: ${question}`;
  return { system, user };
}
