/**
 * The data dictionary: what words like "old user" mean in a given file. Definitions are chosen once by a person
 * (never guessed silently), saved with the file's layout, and reused. The planner reads them; the engine runs them.
 */
import type { Table } from "./table";

export interface SegmentDef {
  /** The column that decides. */
  column: string;
  operator: "equals" | "gt";
  value: string;
  /** Rows meeting the condition get oldLabel, all others newLabel. */
  oldLabel: string;
  newLabel: string;
}

export interface Dictionary {
  segments: { user_type?: SegmentDef };
}

export interface DefinitionOption { label: string; def: SegmentDef }

/** The question the app puts to the user when a word has no definition yet. */
export interface DefinitionRequest {
  term: "user_type";
  question: string;
  options: DefinitionOption[];
}

export const emptyDictionary = (): Dictionary => ({ segments: {} });

const WHO = String.raw`(?:users?|customers?|borrowers?|clients?|cx|accounts?)`;
const OLD = String.raw`(?:old|existing|returning|repeat(?:ed)?|repeaters?)`;
const NEW = String.raw`(?:new|first[\s-]?time|fresh)`;

/** Which sides of "old vs new users" a sentence mentions. */
export function segmentWords(text: string): { old: boolean; new: boolean } {
  const t = text.toLowerCase();
  const pair = new RegExp(String.raw`\b(${OLD}|${NEW})\s*(?:and|vs\.?|versus|&|,|or)\s*(${OLD}|${NEW})\s+${WHO}\b`);
  const m = pair.exec(t);
  if (m) {
    const kinds = [m[1], m[2]].map((w) => (new RegExp(`^${OLD}$`).test(w) ? "old" : "new"));
    return { old: kinds.includes("old"), new: kinds.includes("new") };
  }
  return { old: new RegExp(String.raw`\b${OLD}\s+${WHO}\b`).test(t), new: new RegExp(String.raw`\b${NEW}\s+${WHO}\b`).test(t) };
}

export const mentionsSegment = (text: string): boolean => {
  const s = segmentWords(text);
  return s.old || s.new;
};

const FLAG_NAME = /repeat|returning|existing|old_?(?:user|cx|customer)|first_?time|is_?new|new_?(?:user|cx|customer)/i;
const COUNT_NAME = /order_?(?:cnt|count|no|num)|loan_?(?:cnt|count|number|seq|no)|nth_?loan|total_?loans/i;

/** Ways "old user" could be defined, from the columns that exist (never applied until a person picks one). */
export function suggestSegmentDefs(t: Table): DefinitionOption[] {
  const out: DefinitionOption[] = [];
  for (const c of t.columns) {
    const distinct = new Set(c.values.filter((v) => v !== null && v !== "").map(String));
    if (c.kind === "number" && FLAG_NAME.test(c.name) && distinct.size > 0 && distinct.size <= 2 && [...distinct].every((v) => v === "0" || v === "1")) {
      const newIsOne = /is_?new|new_/i.test(c.name);
      const value = newIsOne ? "0" : "1";
      out.push({ label: `Old = ${c.name} is ${value}  ·  New = otherwise`, def: { column: c.name, operator: "equals", value, oldLabel: "Old", newLabel: "New" } });
    } else if (c.kind === "number" && COUNT_NAME.test(c.name)) {
      out.push({ label: `Old = ${c.name} is more than 1 (a repeat loan)  ·  New = otherwise`, def: { column: c.name, operator: "gt", value: "1", oldLabel: "Old", newLabel: "New" } });
    } else if (c.kind === "text" && FLAG_NAME.test(c.name) && distinct.size > 0 && distinct.size <= 3) {
      const first = [...distinct].find((v) => /^(?:y|yes|true|repeat|existing|old|returning)$/i.test(v));
      if (first) out.push({ label: `Old = ${c.name} is ${first}  ·  New = otherwise`, def: { column: c.name, operator: "equals", value: first, oldLabel: "Old", newLabel: "New" } });
    }
  }
  // A 0/1 repeat flag is the clearest definition, so it comes before loan counts
  const rank = (o: DefinitionOption) => (o.def.operator === "equals" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/** A short stable id for a file's layout, so definitions follow the columns, not the file name. */
export function fingerprint(headers: string[]): string {
  let h = 5381;
  for (const s of headers) for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${headers.length}-${h.toString(36)}`;
}

export const describeSegment = (d: SegmentDef): string =>
  `${d.oldLabel} = ${d.column} ${d.operator === "gt" ? "is more than" : "is"} ${d.value}; ${d.newLabel} = everyone else`;
