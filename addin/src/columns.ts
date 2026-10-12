/**
 * Which columns of a wide file does a sentence need? Words in the sentence are matched to the file's headers
 * ("state" finds statename, "paid" finds repaid_amt), so people never have to pick columns by hand.
 */
import { MAX_CELLS } from "./host";

const STOP = new Set(("show me the of by per each and or all get give what is are to a an with where for in on rows row percentage percent percentages " +
  "total totals sum count average avg mean number how many wise top bottom highest lowest sort sorted ascending descending than greater less more equal " +
  "equals not from pivot group grouped chart bar line pie column columns add make list i want need please this that it my data table it its was were be " +
  "then also now do does can could would should find out tell see view display result results").split(/\s+/));

/** Words that say "a rate / how much was paid", so the amounts it is probably compared with are worth reading too. */
const RATE_WORDS = /\b(?:paid|unpaid|on\s*time|ontime|late|overdue|delinquen\w*|default\w*|collect\w*|recover\w*|repay\w*|percent(?:age)?|%|ratio|rate)\b/i;
/** Words that mean the same thing in a sentence and in a header. */
const SAME: Record<string, string> = { repayment: "repaid", repayments: "repaid", repaying: "repaid", amount: "amt", amounts: "amt" };

/** Columns that usually hold "what was due / total / paid": amounts and dates about dues and repayments, and the delay bucket. */
const COMPANION_NAMES = new Set(["alloc", "due", "repaid", "principal", "emi", "outstanding"]);
function isCompanion(header: string): boolean {
  const toks = tokens(header);
  const last = toks[toks.length - 1];
  return toks[toks.length - 1] === "bucket" || (toks.length === 2 && toks[0] === "b0" && last === "amt") || (toks[0] === "tot" || toks[0] === "total") && last === "amt"
    || toks.some((t) => COMPANION_NAMES.has(t)) && (last === "amt" || last === "amount" || last === "date");
}

export const sentenceWords = (text: string): string[] =>
  [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)).map((w) => SAME[w] ?? w))];

const tokens = (header: string): string[] => header.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** How well a header matches the sentence's words (0 = not at all). */
export function matchScore(header: string, words: string[]): number {
  const toks = tokens(header);
  let score = 0;
  for (const w of words) {
    for (const t of toks) {
      if (t === `${w}name`) { score += 4; break; } // state ~ statename beats state_category
      if (w === t) { score += 3; break; }
      if (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t))) { score += 2; break; } // state ~ statename
      if (w.length >= 4 && t.includes(w)) { score += 1; break; } // paid ~ repaid
    }
  }
  return score;
}

const spaced = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `.replace(/ amounts? /g, " amt "); // "b0 amount" is typing b0_amt

/**
 * The columns to have loaded to answer `text`: the ones already loaded, plus those the sentence names or
 * (loosely) points at. Kept within the memory budget for `rows` rows. Returned in the file's column order.
 */
export function autoColumns(headers: string[], rows: number, text: string, current: string[] = [], maxCells = MAX_CELLS): string[] {
  const said = spaced(text);
  const have = new Set(current.map((c) => c.toLowerCase()));
  // Columns typed by their full name are certain; their own words must not also pull in look-alikes (tot_amt must not read every *_amt).
  const typed = headers.filter((h) => spaced(h).trim().length >= 3 && said.includes(spaced(h)));
  const typedWords = new Set(typed.flatMap(tokens));
  const words = sentenceWords(text).filter((w) => !typedWords.has(w));
  const scored = headers
    .filter((h) => !have.has(h.toLowerCase()) && !typed.includes(h))
    .map((h) => ({ h, score: matchScore(h, words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  let picked = [...typed.filter((h) => !have.has(h.toLowerCase())), ...scored.slice(0, 14).map((x) => x.h)];
  if (RATE_WORDS.test(text) && picked.length) {
    const more = headers.filter((h) => !have.has(h.toLowerCase()) && !picked.includes(h) && isCompanion(h));
    picked = picked.concat(more.slice(0, 8));
  }
  const room = Math.max(1, Math.floor(maxCells / Math.max(1, rows)) - have.size);
  const chosen = new Set([...current, ...picked.slice(0, room)].map((c) => c.toLowerCase()));
  return headers.filter((h) => chosen.has(h.toLowerCase()));
}
