import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/engine/engine";
import { liveColumns, livePivot } from "../src/engine/live";
import { makePlan } from "../src/engine/parser";
import { Cell, Sheets, makeTable } from "../src/engine/table";

const rows: Cell[][] = [["DEBIT", 7000, "Mumbai", 2], ["CREDIT", 2500, "Pune", 0], ["DEBIT", 15000, "Mumbai", 5]];
const sheets: Sheets = new Map([["Result", makeTable(["type", "amount", "branch", "qty"], rows)]]);
const live = (cmd: string) => {
  const plan = makePlan(sheets, cmd);
  expect(plan.clarification_question, cmd).toBeNull();
  const result = applyPlan(sheets, plan).get("Result")!;
  return { plan, cols: liveColumns(plan, result) };
};

describe("live formulas", () => {
  it("a typed formula becomes an Excel table formula", () => {
    const { cols } = live('add column grade = IF(amount>10000,"High","Low")');
    expect(cols![0].build("T")).toBe('=IFERROR(IF(([@[amount]]>10000),"High","Low"),"")');
  });
  it("a plain-English formula too", () => {
    expect(live("add column gst = amount * 0.18").cols![0].build("T")).toBe('=IFERROR(([@[amount]]*0.18),"")');
  });
  it("whole-column parts name the table", () => {
    const f = live("add column share = amount / SUM(amount)").cols![0].build("Table_Result");
    expect(f).toBe('=IFERROR(([@[amount]]/SUM(Table_Result[[amount]])),"")');
    expect(live("add column n = COUNTIF(branch, branch)").cols![0].build("T")).toBe('=IFERROR(COUNTIF(T[[branch]],[@[branch]]),"")');
    expect(live('add column s = SUMIFS(amount, type, "DEBIT", branch, branch)').cols![0].build("T"))
      .toBe('=IFERROR(SUMIFS(T[[amount]],T[[type]],"DEBIT",T[[branch]],[@[branch]]),"")');
  });
  it("an if/else label becomes nested IFs", () => {
    const f = live("add column size = high if amount > 10000, medium if amount > 5000, else low").cols![0].build("T");
    expect(f).toBe('=IF([@[amount]]>10000,"high",IF([@[amount]]>5000,"medium","low"))');
    expect(live("add column x = yes if type is debit and amount > 1000 else no").cols![0].build("T"))
      .toBe('=IF(AND(TRIM([@[type]])="DEBIT",[@[amount]]>1000),"yes","no")');
    expect(live("add column x = 1 if branch contains mum else 0").cols![0].build("T")).toBe('=IF(ISNUMBER(SEARCH("mum",[@[branch]])),1,0)');
  });
  it("things that change existing columns or other rows stay as values", () => {
    expect(live("set amount = amount * 2").cols).toBeNull();
    expect(live("add column r = round(amount / 3, 1)").cols).toBeNull();
    expect(makePlan(sheets, "sort by amount")).toBeTruthy();
    const sort = makePlan(sheets, "sort by amount descending");
    expect(liveColumns(sort, applyPlan(sheets, sort).get("Result")!)).toBeNull();
  });
});

describe("native PivotTables", () => {
  const spec = (cmd: string) => livePivot(makePlan(sheets, cmd), sheets.get("Result")!);
  it("a pivot or a total on the original columns", () => {
    expect(spec("pivot amount by branch and type")).toEqual({ rows: ["branch"], columns: ["type"], data: [{ column: "amount", func: "Sum", name: "Sum of amount" }] });
    expect(spec("total amount by branch")).toEqual({ rows: ["branch"], columns: [], data: [{ column: "amount", func: "Sum", name: "Sum of amount" }] });
    expect(spec("average amount by branch")!.data[0].func).toBe("Average");
    expect(spec("count by branch")!.data[0]).toMatchObject({ column: "branch", func: "Count" });
  });
  it("not when other steps come first, or Excel can't do it", () => {
    expect(spec("only debits, total amount by branch")).toBeNull();
    expect(spec("unique type count by branch")).toBeNull(); // distinct count needs the data model
    expect(spec("total amount by month")).toBeNull();
  });
});
