/** Small text/number helpers shared by the parser and engine (ports of the helpers in planner.py). */

/** Lower-case letters and digits only: "Txn Date" and "txn_date" share a key. */
export const key = (s: unknown): string => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export function singular(k: string): string {
  if (/(ches|shes|xes|sses|zes)$/.test(k) && k.length > 4) return k.slice(0, -2);
  return k.endsWith("s") && !k.endsWith("ss") && k.length > 3 ? k.slice(0, -1) : k;
}

export function colWords(col: unknown): string[] {
  const spaced = String(col).replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Python-style number to string: 5000 -> "5000", 0.5 -> "0.5". */
export const fmt = (v: number): string => String(v);

const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

/** "5k", "1 lakh", "Rs. 5,000", "2 crore" -> number, or null. */
export function parseNumber(text: string): number | null {
  let t = text.toLowerCase().trim();
  t = t.replace(/[₹$€£]|\b(?:rs\.?|inr|rupees?|usd|dollars?)(?=\s|\d|$)/g, "").replace(/,/g, "").trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*(k|thousand|l|lakhs?|lacs?|cr|crores?|m|mn|million|b|bn|billion)?$/.exec(t);
  if (!m) return null;
  return parseFloat(m[1]) * (MULT[m[2] ?? ""] ?? 1);
}

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
export const MONTHS = MONTH_NUM;

const DAY_MS = 86_400_000;

/** UTC midnight of y-m-d in ms, or null if it isn't a real calendar date. */
export function utcDay(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : null;
}

/**
 * A date written as text, read day-first (dd/mm/yyyy) unless it is ISO (yyyy-mm-dd).
 * Returns UTC ms at midnight, or null.
 */
export function parseDateText(text: string): number | null {
  const t = text.trim().replace(/^['"]|['"]$/g, "");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return utcDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[T ,].*)?$/.exec(t);
  if (m) return utcDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(t);
  if (m && MONTH_NUM[m[2].slice(0, 3).toLowerCase()]) return utcDay(+m[3], MONTH_NUM[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(t);
  if (m && MONTH_NUM[m[1].slice(0, 3).toLowerCase()]) return utcDay(+m[3], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^([a-z]{3,9})\.?\s+(\d{4})$/i.exec(t);
  if (m && MONTH_NUM[m[1].slice(0, 3).toLowerCase()]) return utcDay(+m[2], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], 1);
  return null;
}

/** Same as parseDateText but returns "yyyy-mm-dd" (what plans store), or null. */
export function parseDate(text: string): string | null {
  if (!/\d/.test(text)) return null;
  const ms = parseDateText(text);
  return ms === null ? null : isoDay(ms);
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Excel serial date -> UTC ms (valid for dates after 1 Mar 1900). */
export function serialToMs(serial: number): number {
  return Math.floor(serial - 25569) * DAY_MS;
}
export function msToSerial(ms: number): number {
  return ms / DAY_MS + 25569;
}

export function todayMs(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}
export { DAY_MS };

/** Ratcliff/Obershelp similarity, as Python's difflib.SequenceMatcher(None, a, b).ratio(). */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  return (2 * matching(a, 0, a.length, b, 0, b.length)) / (a.length + b.length);
}

function matching(a: string, alo: number, ahi: number, b: string, blo: number, bhi: number): number {
  // Longest common substring of a[alo:ahi] and b[blo:bhi] (earliest in a, then in b), then recurse either side.
  let best = 0, bi = alo, bj = blo;
  let prev = new Array<number>(bhi - blo + 1).fill(0);
  for (let i = alo; i < ahi; i++) {
    const cur = new Array<number>(bhi - blo + 1).fill(0);
    for (let j = blo; j < bhi; j++) {
      if (a[i] === b[j]) {
        const k = prev[j - blo] + 1;
        cur[j - blo + 1] = k;
        if (k > best) { best = k; bi = i - k + 1; bj = j - k + 1; }
      }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + (bi > alo && bj > blo ? matching(a, alo, bi, b, blo, bj) : 0)
    + (bi + best < ahi && bj + best < bhi ? matching(a, bi + best, ahi, b, bj + best, bhi) : 0);
}

/** difflib.get_close_matches(word, options, n=1, cutoff) -> best match or null. */
export function closeMatch(word: string, options: string[], cutoff: number): string | null {
  let best: string | null = null, bestScore = -1;
  for (const o of options) {
    const s = similarity(word, o);
    if (s < cutoff) continue;
    if (s > bestScore || (s === bestScore && best !== null && o > best)) { best = o; bestScore = s; }
  }
  return best;
}

/** Codepoint comparison, like Python's string ordering. */
export const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
