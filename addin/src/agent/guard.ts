/**
 * The last check before anything leaves this computer. Every request to the AI is scanned, and it is blocked when it
 * contains personal data (PAN, Aadhaar, phone, e-mail, card or account numbers) or a value copied from the person's
 * files that the privacy setting does not allow (a customer name, an id, an address...). This is a second, independent
 * layer: the tools are already written not to send such things, and this makes sure of it.
 */
import { profileColumn } from "../ai/profile";
import type { Workspace } from "./workspace";

export class PrivacyBlock extends Error {
  constructor(readonly found: string[]) {
    super(`I stopped this request before it left your computer: it would have sent ${found.join(", ")}. Nothing was sent. Remove personal details from your question, or turn off the setting that shares values.`);
  }
}

const PATTERNS: [string, RegExp][] = [
  ["a PAN number", /\b[A-Z]{5}\d{4}[A-Z]\b/],
  ["an Aadhaar number", /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/],
  ["a phone number", /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/],
  ["an e-mail address", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
  ["a card or account number", /\b\d{11,19}\b/],
];

/** Personal data found in text, as plain names ("a PAN number"). */
export function personalData(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}@._-]+/u).filter(Boolean);

export interface Blocked { values: Set<string>; words: Set<string> }

/** Per column: its secret values (computed once per loaded table). */
const cache = new WeakMap<object, Blocked>();

/**
 * Words and values from the person's files that must not leave: the cells of personal, id and free-text columns
 * (names, addresses, ids, phone numbers...), except words that are also column or table names. The values of small
 * category columns (state, status, a 0/1 flag) are not secret; whether they are sent at all is the "share values" setting.
 */
export function blockedValues(ws: Workspace): Blocked {
  const allowed = new Set<string>();
  for (const name of ws.tables.keys()) for (const t of [name, ...tokens(name)]) allowed.add(t.toLowerCase());
  for (const e of ws.tables.values()) for (const h of ws.headersOf(e.name)) for (const t of [h, ...tokens(h)]) allowed.add(t.toLowerCase());
  const values = new Set<string>();
  const words = new Set<string>();
  for (const s of ws.sources()) {
    const t = s.loaded;
    if (!t) continue;
    let mine = cache.get(t);
    if (!mine) { mine = secretsOf(t); cache.set(t, mine); }
    for (const v of mine.values) values.add(v);
    for (const w of mine.words) words.add(w);
  }
  for (const a of allowed) { values.delete(a); words.delete(a); }
  return { values, words };
}

function secretsOf(t: import("../engine/table").Table): Blocked {
  const values = new Set<string>();
  const words = new Set<string>();
  {
    for (const c of t.columns) {
      const p = profileColumn(c, t.nrows, { values: true });
      if (p.values) continue; // a small category column (state, status, flag): not secret
      const personal = p.withheld === "looks like personal data";
      if (c.kind === "date" && !personal) continue; // dates are shared as a range; a birth date is personal and stays secret
      // Numbers are secret only in id or personal columns (an amount's range is fine to share; a phone number is not).
      const numbersSecret = p.role === "id" || personal;
      for (const v of c.values) {
        if (typeof v === "string") {
          const s2 = v.trim().toLowerCase();
          if (s2.length < 3) continue;
          values.add(s2);
          for (const w of tokens(s2)) if (w.length >= 4) words.add(w);
        } else if (numbersSecret && typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 1000) {
          words.add(String(v)); // ids, phone and account numbers stored as numbers
        }
      }
    }
  }
  return { values, words };
}

/** The text in a request that came from this app (system text, tool results), not what the person typed. */
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** Throws PrivacyBlock when the request would send personal data or a value from the files that is not allowed. */
export function checkOutgoing(body: Record<string, unknown>, blocked: Blocked): void {
  const all = strings(body, []);
  const found = new Set(personalData(all.join("\n")));
  if (!found.size && (blocked.values.size || blocked.words.size)) {
    outer: for (const s of all) {
      const low = s.toLowerCase();
      if (blocked.values.has(low.trim())) { found.add("a value from your file"); break; }
      for (const w of tokens(low)) {
        if (blocked.words.has(w) || blocked.values.has(w)) { found.add("a value from your file"); break outer; }
      }
    }
  }
  if (found.size) throw new PrivacyBlock([...found]);
}
