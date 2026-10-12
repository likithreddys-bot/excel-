/**
 * Made-up lending data for trying the agent: new customers, old customers, repayments and the policy each loan was
 * approved under. Deterministic (the same files every time), so results can be checked.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATES = ["Maharashtra", "Karnataka", "Tamil Nadu", "Uttar Pradesh", "Gujarat", "Telangana", "West Bengal", "Rajasthan"];
const CHANNELS = ["App", "Partner", "Branch"];
const day = (base: number, plus: number): string => new Date(base + plus * 86400000).toISOString().slice(0, 10);
const csv = (rows: (string | number)[][]): string => rows.map((r) => r.join(",")).join("\n") + "\n";

export function sampleFiles(): File[] {
  const r = rng(20261012);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const start = Date.UTC(2025, 0, 1);

  const newC: (string | number)[][] = [["customer_id", "state", "signup_date", "channel", "monthly_income"]];
  const oldC: (string | number)[][] = [["customer_id", "state", "signup_date", "loans_taken", "monthly_income"]];
  const customers: { id: string; old: boolean; state: string }[] = [];
  for (let i = 1; i <= 1800; i++) {
    const old = i % 5 < 3;
    const id = `C${String(i).padStart(5, "0")}`;
    const state = pick(STATES);
    const income = Math.round((15000 + r() * 60000) / 500) * 500;
    if (old) oldC.push([id, state, day(start - 500 * 86400000, Math.floor(r() * 400)), 2 + Math.floor(r() * 7), income]);
    else newC.push([id, state, day(start, Math.floor(r() * 300)), pick(CHANNELS), income]);
    customers.push({ id, old, state });
  }

  const repay: (string | number)[][] = [["loan_id", "customer_id", "due_date", "due_amt", "paid_amt", "paid_date", "dpd"]];
  const policy: (string | number)[][] = [["loan_id", "policy", "approved_on", "interest_rate"]];
  let loan = 0;
  for (const c of customers) {
    const loans = 1 + Math.floor(r() * 3);
    for (let k = 0; k < loans; k++) {
      loan++;
      const id = `L${String(loan).padStart(6, "0")}`;
      const approved = Math.floor(r() * 330);
      const newPolicy = approved >= 180;
      policy.push([id, newPolicy ? "New policy" : "Old policy", day(start, approved), newPolicy ? 22 : 26]);
      const due = Math.round((2000 + r() * 18000) / 100) * 100;
      // Old customers and the new policy repay better.
      const good = 0.62 + (c.old ? 0.18 : 0) + (newPolicy ? 0.08 : 0);
      const roll = r();
      const paid = roll < good ? due : roll < good + 0.12 ? Math.round(due * (0.3 + r() * 0.5)) : 0;
      const dueDate = day(start, approved + 30);
      const dpd = paid === due ? (r() < 0.8 ? 0 : 1 + Math.floor(r() * 10)) : paid > 0 ? 15 + Math.floor(r() * 40) : 30 + Math.floor(r() * 90);
      const paidDate = paid > 0 ? day(start, approved + 30 + dpd) : "";
      repay.push([id, c.id, dueDate, due, paid, paidDate, dpd]);
    }
  }
  const file = (name: string, rows: (string | number)[][]) => new File([csv(rows)], name, { type: "text/csv" });
  return [file("new_customers.csv", newC), file("old_customers.csv", oldC), file("repayments.csv", repay), file("loan_policy.csv", policy)];
}
