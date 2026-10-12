/** Choosing columns from a sentence, with the real headers of a 298-column repayment file. */
import { describe, expect, it } from "vitest";
import { autoColumns } from "../src/columns";
import { suggestPercentages } from "../src/suggest";
import { makeTable } from "../src/engine/table";

const HEADERS = ("loan_id loan_schedule_id user_id disb_date disb_month disb_year schedule_num due_date due_month due_year cur_bucket alloc_amt before_b0_amt b0_amt b1_amt b2_amt " +
  "within_90d tot_amt repaid_date repaid_amt is_loan_due_date_passed curr_emi_dpd status_code policy_tag enach_status_tag age gender salary pin_code prof_name statename edu_name " +
  "overall_monthly_paid unsec_monthly_paid overall_last_6m_disbursed_amt total_loans hdfc_loan_count lf_score lf_grade due_year_month exception_tag").split(/\s+/);

describe("autoColumns", () => {
  it("finds statename and the b0 columns from plain words", () => {
    const cols = autoColumns(HEADERS, 106_394, "show me the statename wise paid b0 percentage");
    expect(cols).toContain("statename");
    expect(cols).toContain("b0_amt");
    expect(cols).toContain("before_b0_amt");
    expect(cols).toContain("repaid_amt");       // "paid" is inside "repaid"
    expect(cols).toContain("alloc_amt");        // a rate question also reads what is usually due
    expect(cols).toContain("due_date");
    expect(cols).not.toContain("salary");
    expect(cols.length).toBeLessThan(30);
  });

  it("'state' finds statename; a typed full name is found first", () => {
    expect(autoColumns(HEADERS, 100_000, "total salary by state")).toEqual(expect.arrayContaining(["salary", "statename"]));
    expect(autoColumns(HEADERS, 100_000, "average tot_amt")).toEqual(["tot_amt"]); // a typed name does not pull in every *_amt
  });

  it("keeps what is already loaded and adds only what is new", () => {
    const first = autoColumns(HEADERS, 100_000, "total salary by statename");
    const next = autoColumns(HEADERS, 100_000, "and also the gender split", first);
    expect(next).toEqual(expect.arrayContaining([...first, "gender"]));
    expect(autoColumns(HEADERS, 100_000, "sort descending", first)).toEqual(first); // nothing new to read
  });

  it("stays within the memory budget", () => {
    const wide = Array.from({ length: 300 }, (_, i) => `amount_${i}`);
    const cols = autoColumns(wide, 1_000_000, "total amount");
    expect(cols.length * 1_000_000).toBeLessThanOrEqual(8_000_000);
  });

  it("reads nothing when no word matches", () => {
    expect(autoColumns(HEADERS, 1000, "qwerty zzz")).toEqual([]);
  });
});

describe("autoColumns on real phrasing", () => {
  const H = HEADERS.concat(["loan_due_date", "loan_repaid_date", "marital_status", "overdue_amt", "principal_amt", "status_code"]);
  it("'state wise repayment percentage of b0 amount' reads the right columns and not unrelated ones", () => {
    const cols = autoColumns(H, 106_394, "show state wise repayment percentage of b0 amount");
    expect(cols).toEqual(expect.arrayContaining(["statename", "b0_amt", "alloc_amt", "repaid_amt"]));
    for (const unrelated of ["marital_status", "overdue_amt", "status_code", "salary"]) expect(cols).not.toContain(unrelated);
    expect(cols.length).toBeLessThan(20);
  });
});

describe("suggestPercentages", () => {
  const t = makeTable(
    ["statename", "b0_amt", "alloc_amt", "due_date", "repaid_date", "cur_bucket"],
    [["MH", 1000, 1000, 45300, 45300, "B0"], ["KA", 0, 2000, 45300, null, "B1"]],
    [undefined, undefined, undefined, "dd/mm/yyyy", "dd/mm/yyyy", undefined],
  );
  it("offers likely readings as ready-to-run sentences", () => {
    const s = suggestPercentages(t, "show me the statename wise paid b0 percentage");
    expect(s[0]).toBe("b0_amt as percentage of alloc_amt by statename");
    expect(s).toContain("percentage of rows where repaid_date <= due_date by statename");
    expect(s.length).toBeLessThanOrEqual(3);
  });

  it("prefers the plainer column name on a tie, and the bucket rule uses a B0-like value", () => {
    const t2 = makeTable(
      ["statename", "before_b0_amt", "b0_amt", "alloc_amt", "cur_bucket"],
      [["MH", 5, 1000, 1000, "B1"], ["KA", 6, 0, 2000, "B0"], ["KA", 7, 0, 2000, "B2"]],
    );
    const s = suggestPercentages(t2, "statename wise paid b0 percentage");
    expect(s[0]).toBe("b0_amt as percentage of alloc_amt by statename");
    expect(s).toContain("percentage of rows where cur_bucket is B0 by statename");
  });
});
