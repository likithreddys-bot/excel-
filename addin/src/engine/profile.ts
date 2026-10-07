/**
 * Beginner mode: look over a table and say, in plain words, what is probably wrong with it, with a command
 * that fixes each thing. Every suggested command goes through the normal preview, so nothing changes without a look.
 */
import { Cell, Column, Table, isBlankCell } from "./table";
import { parseNumber } from "./util";

export interface Finding {
  /** Plain-English description of what was noticed. */
  message: string;
  /** What to type to fix it (runs through the usual preview). */
  command: string;
}

const MAX_FINDINGS = 6;
const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

function duplicateRows(t: Table): number {
  const seen = new Set<string>();
  let dups = 0;
  for (let i = 0; i < t.nrows; i++) {
    let k = "";
    for (const c of t.columns) k += (c.values[i] ?? "\u0000") + "\u0001";
    if (seen.has(k)) dups++; else seen.add(k);
  }
  return dups;
}

function blankRows(t: Table): number {
  let n = 0;
  for (let i = 0; i < t.nrows; i++) if (t.columns.every((c) => isBlankCell(c.values[i]))) n++;
  return n;
}

/** "₹1,200", "Rs. 90", "3,400.50": text that is really a number. Plain digit codes (ids, phones) are left alone. */
function numbersSavedAsText(c: Column): boolean {
  if (c.kind !== "text") return false;
  const strings = c.values.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (strings.length < 2) return false;
  const sample = strings.slice(0, 300);
  const readable = sample.filter((s) => parseNumber(s.replace(/\s+/g, " ")) !== null).length;
  const decorated = sample.some((s) => /[₹$€£,]|^\s*(?:rs|inr)\b/i.test(s));
  return readable / sample.length >= 0.8 && decorated;
}

/** Values that differ only by letter case or spacing: "pune", "Pune ", "PUNE". Returns the spellings found. */
function inconsistentSpellings(c: Column): { examples: string[]; byCaseOnly: boolean } | null {
  if (c.kind !== "text") return null;
  const groups = new Map<string, Set<string>>();
  for (const v of c.values) {
    if (typeof v !== "string" || v.trim() === "") continue;
    const k = v.trim().replace(/\s+/g, " ").toLowerCase();
    if (!groups.has(k)) { groups.set(k, new Set()); if (groups.size > 500) return null; } // free text, not categories
    groups.get(k)!.add(v);
  }
  const varied = [...groups.values()].filter((g) => g.size > 1);
  if (!varied.length) return null;
  const examples = varied[0] ? [...varied[0]].map((s) => `“${s}”`).slice(0, 3) : [];
  const byCaseOnly = varied.every((g) => new Set([...g].map((s) => s.trim().replace(/\s+/g, " "))).size > 1);
  return { examples, byCaseOnly };
}

export function profile(t: Table): Finding[] {
  const found: Finding[] = [];
  if (t.nrows === 0) return found;

  const empty = blankRows(t);
  if (empty) found.push({ message: `${plural(empty, "row is", "rows are")} completely empty.`, command: "remove blank rows" });

  const dups = duplicateRows(t);
  if (dups) found.push({ message: `${plural(dups, "row is", "rows are")} an exact repeat of another row.`, command: "remove duplicate rows" });

  const spaced = t.columns.filter((c) => c.values.some((v) => typeof v === "string" && v !== "" && (v !== v.trim() || /\s{2,}/.test(v))));
  if (spaced.length) {
    const n = spaced.reduce((a, c) => a + c.values.filter((v) => typeof v === "string" && v !== "" && (v !== v.trim() || /\s{2,}/.test(v))).length, 0);
    found.push({ message: `${plural(n, "cell has", "cells have")} extra spaces (in ${list(spaced.map((c) => c.name))}). They break matching and totals.`, command: "trim spaces" });
  }

  for (const c of t.columns) {
    if (numbersSavedAsText(c)) {
      found.push({ message: `“${c.name}” holds amounts saved as text (like ${JSON.stringify(c.values.find((v) => typeof v === "string" && v.trim()))}), so they can't be added up.`, command: `convert ${c.name} to number` });
    }
  }

  for (const c of t.columns) {
    if (c.mixedDates) {
      found.push({ message: `“${c.name}” mixes real Excel dates with dates typed as text. Day and month may have been swapped.`, command: `convert ${c.name} to date` });
    }
  }

  for (const c of t.columns) {
    const s = inconsistentSpellings(c);
    if (s) {
      found.push({
        message: `“${c.name}” spells the same value in different ways (${s.examples.join(", ")}). Totals would split them.`,
        command: `trim ${c.name} and make ${c.name} title case`,
      });
    }
  }

  const blanks = t.columns
    .map((c) => ({ c, n: c.values.filter(isBlankCell).length }))
    .filter((x) => x.n > 0 && x.n < t.nrows)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
  for (const { c, n } of blanks) {
    found.push({
      message: `“${c.name}” is blank in ${plural(n, "row")}.`,
      command: c.kind === "number" ? `fill blank ${c.name} with 0` : `fill blank ${c.name} with Unknown`,
    });
  }

  return found.slice(0, MAX_FINDINGS);
}
