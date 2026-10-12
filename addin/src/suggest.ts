/**
 * "show me the statename wise paid b0 percentage" can mean several things. Rather than guess one, offer the
 * likely readings (as ready-to-run sentences) built from the columns that are loaded.
 */
import { matchScore, sentenceWords } from "./columns";
import type { Table } from "./engine/table";

const ID_LIKE = /(^|_)(id|pin|code|num|number|schedule|age)(_|$)/i;
const DENOMINATORS = [/alloc/i, /due/i, /emi/i, /tot(al)?_?amt/i, /principal/i, /outstanding/i];

export function suggestPercentages(t: Table, text: string): string[] {
  const words = sentenceWords(text);
  const best = (pred: (c: Table["columns"][number]) => boolean): string | undefined =>
    t.columns.filter(pred).map((c) => ({ c: c.name, s: matchScore(c.name, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.c.length - b.c.length)[0]?.c;

  const group = best((c) => c.kind === "text");
  const by = group ? ` by ${group}` : "";
  const numeric = t.columns.filter((c) => c.kind === "number" && !ID_LIKE.test(c.name));
  // Best match first; on a tie the plainer name wins (b0_amt before before_b0_amt).
  const plain = (n: string) => n.split(/[^a-z0-9]+/i).length * 1000 + n.length;
  const nums = numeric.map((c) => ({ c: c.name, s: matchScore(c.name, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || plain(a.c) - plain(b.c)).map((x) => x.c);

  const out: string[] = [];
  const a = nums[0];
  if (a) {
    const denom = DENOMINATORS.map((re) => numeric.find((c) => re.test(c.name) && c.name !== a)?.name).find(Boolean);
    if (denom) out.push(`${a} as percentage of ${denom}${by}`);
  }
  const dates = t.columns.filter((c) => c.kind === "date");
  const due = dates.find((c) => /due/i.test(c.name));
  const paid = dates.find((c) => /paid|pay|repaid/i.test(c.name) && c !== due);
  if (due && paid) out.push(`percentage of rows where ${paid.name} <= ${due.name}${by}`);
  const bucket = t.columns.find((c) => c.kind === "text" && /bucket|status/i.test(c.name));
  if (bucket) {
    const seen = [...new Set(bucket.values.filter((x): x is string => typeof x === "string" && x !== ""))].slice(0, 30);
    const v = seen.find((x) => /^(?:b?0|current|on[ _-]?time|paid)$/i.test(x)) ?? seen[0];
    if (v) out.push(`percentage of rows where ${bucket.name} is ${v}${by}`);
  }
  if (a) out.push(`percentage of rows where ${a} > 0${by}`);
  return [...new Set(out)].slice(0, 3);
}
