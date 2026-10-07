/** Excel-style formulas typed into a command, and plain-English text/date commands. */
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { makePlan } from "../src/engine/parser";
import { Cell, Sheets, makeTable } from "../src/engine/table";
import { msToSerial, utcDay } from "../src/engine/util";

const day = (y: number, m: number, d: number) => msToSerial(utcDay(y, m, d)!);

function sample(): Sheets {
  const rows: Cell[][] = [
    ["Asha Rao", "asha@x.com", 120000, 2, "DEBIT", day(2025, 1, 31), "ABC123"],
    ["vikram SINGH", "vik@y.in", 45000, 0, "CREDIT", day(2025, 3, 15), "ABD999"],
    ["Meera Iyer", null, 800, 4, "DEBIT", day(2024, 12, 5), "ABC555"],
    ["Ravi Kumar Das", "ravi@x.com", 45000, 5, "DEBIT", day(2025, 2, 28), "XYZ001"],
  ];
  return new Map([["Result", makeTable(["name", "email", "amount", "qty", "type", "date", "code"], rows, ["General", "General", "#,##0", "0", "General", "dd/mm/yyyy", "General"])]]);
}

function run(cmd: string) {
  const sheets = sample();
  const plan = makePlan(sheets, cmd);
  expect(plan.clarification_question, cmd).toBeNull();
  const notes: string[] = [];
  const out = applyPlan(sheets, plan, {}, notes).get("Result")!;
  const last = out.columns[out.columns.length - 1];
  return { out, plan, notes, values: last.values, last };
}

describe("IF and friends, typed the way Excel people write them", () => {
  it("two-way IF", () => {
    const { values } = run('add column grade = IF(amount>50000,"High","Low")');
    expect(values).toEqual(["High", "Low", "Low", "Low"]);
  });
  it("nested IF", () => {
    const { values } = run('add column band = IF(amount>100000,"High",IF(amount>10000,"Medium","Low"))');
    expect(values).toEqual(["High", "Medium", "Low", "Medium"]);
  });
  it("AND / OR", () => {
    expect(run('add column flag = IF(AND(type="DEBIT",amount>=1000),"check","ok")').values).toEqual(["check", "ok", "ok", "check"]);
    expect(run('add column flag = IF(OR(qty=0,amount<1000),"odd","fine")').values).toEqual(["fine", "odd", "odd", "fine"]);
  });
  it("IFS", () => {
    expect(run('add column band = IFS(amount>100000,"A",amount>10000,"B",TRUE,"C")').values).toEqual(["A", "B", "C", "B"]);
  });
  it("IFERROR catches division by zero; a bare division leaves it blank and says so", () => {
    expect(run("add column each = IFERROR(amount/qty, 0)").values).toEqual([60000, 0, 200, 9000]);
    const r = run("add column each = amount / qty");
    expect(r.values[1]).toBeNull();
  });
  it("an IF branch that isn't taken can't cause an error", () => {
    expect(run("add column each = IF(qty=0, 0, amount/qty)").values).toEqual([60000, 0, 200, 9000]);
  });
  it("a leading = and bracketed names with spaces", () => {
    const sheets: Sheets = new Map([["Result", makeTable(["Amount (INR)", "qty"], [[100, 2], [50, 5]])]]);
    const plan = makePlan(sheets, "add column x = =[Amount (INR)] * [qty]");
    expect(plan.clarification_question).toBeNull();
    expect(applyPlan(sheets, plan).get("Result")!.columns[2].values).toEqual([200, 250]);
  });
});

describe("text functions", () => {
  it("LEFT / RIGHT / MID / LEN / UPPER / PROPER", () => {
    expect(run("add column c = LEFT(code, 3)").values).toEqual(["ABC", "ABD", "ABC", "XYZ"]);
    expect(run("add column c = RIGHT(code, 2)").values).toEqual(["23", "99", "55", "01"]);
    expect(run("add column c = MID(code, 2, 2)").values).toEqual(["BC", "BD", "BC", "YZ"]);
    expect(run("add column c = LEN(name)").values).toEqual([8, 12, 10, 14]);
    expect(run("add column c = UPPER(name)").values[1]).toBe("VIKRAM SINGH");
    expect(run("add column c = PROPER(name)").values[1]).toBe("Vikram Singh");
  });
  it("& joins text and numbers", () => {
    expect(run('add column c = name & " - " & type').values[0]).toBe("Asha Rao - DEBIT");
  });
  it("SUBSTITUTE, FIND, TEXT, VALUE", () => {
    expect(run('add column c = SUBSTITUTE(email, "@", " at ")').values[0]).toBe("asha at x.com");
    expect(run('add column c = IFERROR(LEFT(email, FIND("@", email) - 1), "none")').values).toEqual(["asha", "vik", "none", "ravi"]);
    expect(run('add column c = TEXT(amount, "#,##0")').values[0]).toBe("120,000");
    expect(run('add column c = VALUE("₹1,200") + 1').values[0]).toBe(1201);
  });
  it("blank cells count as empty text", () => {
    expect(run("add column c = IF(ISBLANK(email), \"missing\", email)").values).toEqual(["asha@x.com", "vik@y.in", "missing", "ravi@x.com"]);
  });
});

describe("dates", () => {
  it("YEAR / MONTH / DAY / TEXT", () => {
    expect(run("add column y = YEAR(date)").values).toEqual([2025, 2025, 2024, 2025]);
    expect(run("add column m = MONTH(date)").values).toEqual([1, 3, 12, 2]);
    expect(run('add column m = TEXT(date, "mmm yyyy")').values[0]).toBe("Jan 2025");
    expect(run('add column m = TEXT(date, "dddd")').values[0]).toBe("Friday");
  });
  it("EOMONTH, EDATE, DATEDIF, date arithmetic", () => {
    const eom = run("add column e = EOMONTH(date, 0)");
    expect(eom.values).toEqual([day(2025, 1, 31), day(2025, 3, 31), day(2024, 12, 31), day(2025, 2, 28)]);
    expect(eom.last.format).toBe("dd/mm/yyyy"); // a date result is shown as a date
    expect(run("add column e = EDATE(date, 1)").values[0]).toBe(day(2025, 2, 28));
    expect(run('add column age = DATEDIF(date, DATE(2026,1,15), "M")').values).toEqual([11, 10, 13, 10]);
    expect(run("add column later = date + 30").values[0]).toBe(day(2025, 3, 2));
    expect(run("add column gap = DATE(2025,3,31) - date").values[0]).toBe(59);
  });
});

describe("over a whole column", () => {
  it("COUNTIF / SUMIF / AVERAGEIF with a plain value or the row's own value", () => {
    expect(run('add column n = COUNTIF(type, "DEBIT")').values).toEqual([3, 3, 3, 3]);
    expect(run("add column n = COUNTIF(amount, amount)").values).toEqual([1, 2, 1, 2]);
    expect(run("add column s = SUMIF(type, type, amount)").values).toEqual([165800, 45000, 165800, 165800]);
    expect(run('add column n = COUNTIF(amount, ">40000")').values).toEqual([3, 3, 3, 3]);
    expect(run("add column avg = AVERAGEIF(type, type, amount)").values[0]).toBeCloseTo(55266.6667, 3);
  });
  it("SUMIFS / COUNTIFS with two tests", () => {
    expect(run('add column s = SUMIFS(amount, type, "DEBIT", qty, ">1")').values[0]).toBe(165800);
    expect(run('add column n = COUNTIFS(type, "DEBIT", qty, ">1")').values[0]).toBe(3);
  });
  it("share of the total: amount / SUM(amount)", () => {
    const v = run("add column share = ROUND(amount / SUM(amount) * 100, 1)").values;
    expect(v).toEqual([56.9, 21.3, 0.4, 21.3]);
  });
});

describe("filtering rows by a formula", () => {
  it("keeps the rows where the formula is true", () => {
    const sheets = sample();
    const plan = makePlan(sheets, 'keep rows where =AND(LEFT(code,3)="ABC", amount>1000)');
    expect(plan.clarification_question).toBeNull();
    expect(plan.steps[0].op).toBe("filter_formula");
    expect(applyPlan(sheets, plan).get("Result")!.nrows).toBe(1);
  });
  it("remove rows where a formula is true", () => {
    const sheets = sample();
    const plan = makePlan(sheets, "remove rows where =COUNTIF(amount, amount) > 1");
    expect(applyPlan(sheets, plan).get("Result")!.nrows).toBe(2);
  });
});

describe("plain-English text and date commands", () => {
  it.each([
    ["add column initials = first 2 characters of name", ["As", "vi", "Me", "Ra"]],
    ["add column tail = last 3 characters of code", ["123", "999", "555", "001"]],
    ["add column mid = characters 2 to 3 of code", ["BC", "BD", "BC", "YZ"]],
    ["add column n = length of name", [8, 12, 10, 14]],
    ["add column y = year of date", [2025, 2025, 2024, 2025]],
    ["add column month name = name of the month of date", ["January", "March", "December", "February"]],
    ["add column user = text before @ in email", ["asha", "vik", null, "ravi"]],
    ["add column domain = text after @ in email", ["x.com", "y.in", null, "x.com"]],
    ["add column loud = uppercase of type", ["DEBIT", "CREDIT", "DEBIT", "DEBIT"]],
    ["add column each = amount / qty, or 0 if error", [60000, 0, 200, 9000]],
  ])("%s", (cmd, expected) => {
    expect(run(cmd as string).values).toEqual(expected);
  });
  it("end of month and adding months to a date", () => {
    expect(run("add column e = end of month of date").values[0]).toBe(day(2025, 1, 31));
    expect(run("add column due = date plus 2 months").values[0]).toBe(day(2025, 3, 31));
  });
});

describe("mistakes are explained, not guessed", () => {
  const asks = (cmd: string, text: string) => {
    const p = makePlan(sample(), cmd);
    expect(p.steps).toEqual([]);
    expect(p.clarification_question!.toLowerCase()).toContain(text.toLowerCase());
  };
  it("unknown function", () => asks("add column x = IFF(amount>1, 1, 0)", "Did you mean IF"));
  it("unknown column", () => asks("add column x = IF(amnt>1, 1, 0)", "Did you mean amount"));
  it("wrong number of arguments", () => asks("add column x = LEFT()", "needs"));
  it("unclosed quote or bracket", () => asks('add column x = IF(amount>1, "yes, 0)', "quote"));
  it("a formula with no column name", () => asks('=IF(amount>1,"a","b")', "name"));
  it("a text cell used as a number gives a blank and a note, not a wrong number", () => {
    const r = run('add column bad = IF(TRUE, name + 1, 0)');
    expect(r.values).toEqual([null, null, null, null]);
    expect(r.notes.join(" ")).toMatch(/4 row\(s\) gave an error/);
  });
});
