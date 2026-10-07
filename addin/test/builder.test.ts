/** Every menu choice must come out as a sentence the add-in understands. */
import { describe, expect, it } from "vitest";
import { TEMPLATES, Values, build } from "../src/builder";
import { makePlan } from "../src/engine/parser";
import { Cell, Sheets, makeTable } from "../src/engine/table";

const rows: Cell[][] = [
  ["Mumbai", "DEBIT", 7000, "01/03/2025", 2, "Food and Dining"],
  ["Pune", "CREDIT", 2500, "05/03/2025", 0, "Travel"],
  ["Mumbai", "DEBIT", 15000, "10/03/2025", 5, "Rent"],
  [null, "DEBIT", 300, "12/04/2025", 1, "Travel"],
];
const sheets: Sheets = new Map([["Result", makeTable(["branch", "type", "amount", "date", "qty", "category"], rows)]]);

const cases: [string, Values, string[]][] = [
  ["filter", { col: "type", op: "is", value: "DEBIT" }, ["filter"]],
  ["filter", { col: "amount", op: "is more than", value: "5000", join: "and", col2: "branch", op2: "is", value2: "Mumbai" }, ["filter"]],
  ["filter", { col: "category", op: "is", value: "Food and Dining" }, ["filter"]],
  ["filter", { col: "branch", op: "is empty" }, ["filter"]],
  ["filter", { col: "category", op: "contains", value: "ave" }, ["filter"]],
  ["remove", { col: "type", op: "is", value: "CREDIT" }, ["filter"]],
  ["sort", { col: "amount", dir: "descending (Z to A, big to small, newest first)" }, ["sort"]],
  ["sort", { col: "branch", dir: "ascending (A to Z, small to big, oldest first)", col2: "amount" }, ["sort"]],
  ["split", { col: "branch" }, ["split_by"]],
  ["total", { func: "total", value: "amount", by: ["branch"] }, ["group_by"]],
  ["total", { func: "count", by: ["branch", "type"] }, ["group_by"]],
  ["total", { func: "average", value: "amount", by: ["category"], colW: "type", opW: "is", valueW: "DEBIT", pct: "no" }, ["filter", "group_by"]],
  ["total", { func: "total", value: "amount", by: ["branch"], pct: "yes" }, ["group_by", "calculate"]],
  ["pivot", { func: "total", value: "amount", rows: ["branch"], cols: "type" }, ["pivot"]],
  ["pivot", { func: "count", rows: ["branch", "category"] }, ["pivot"]],
  ["top", { dir: "top", n: "2", col: "amount" }, ["top_n"]],
  ["top", { dir: "bottom", n: "1", col: "amount", per: "branch" }, ["top_n"]],
  ["dedupe", { cols: [] }, ["dedupe"]],
  ["dedupe", { cols: ["branch", "type"] }, ["dedupe"]],
  ["columns", { mode: "keep", cols: ["branch", "amount"] }, ["select_columns"]],
  ["columns", { mode: "drop", cols: ["qty"] }, ["drop_columns"]],
  ["calc", { name: "gst", a: "amount", op: "*", b: "0.18" }, ["compute"]],
  ["calc", { name: "per unit", a: "amount", op: "/", b: "qty" }, ["compute"]],
  ["ifelse", { name: "size", col: "amount", op: "is more than", value: "5000", then: "High", else: "Low" }, ["label"]],
  ["ifelse", { name: "flag", col: "branch", op: "is empty", then: "check" }, ["label"]],
  ["formula", { name: "grade", formula: '=IF([amount]>5000,"High","Low")' }, ["formula"]],
  ["clean", { what: "trim extra spaces", cols: [] }, ["clean_text"]],
  ["clean", { what: "make Title Case", cols: ["branch"] }, ["clean_text"]],
  ["clean", { what: "fill blank cells with…", cols: ["branch"], fill: "Unknown" }, ["fill_blanks"]],
  ["clean", { what: "fill blank cells with the value above", cols: ["branch"] }, ["fill_blanks"]],
  ["clean", { what: "remove empty rows" }, ["drop_blank_rows"]],
  ["chart", { kind: "bar", func: "total", value: "amount", by: "branch" }, ["chart"]],
  ["chart", { kind: "pie", func: "count", by: "type" }, ["chart"]],
  ["highlight", { col: "amount", op: "is more than", value: "5000", color: "red" }, ["highlight"]],
];

describe("guided builder sentences", () => {
  for (const [id, values, ops] of cases) {
    const template = TEMPLATES.find((t) => t.id === id)!;
    const made = build(template, values);
    it(`${id}: ${"sentence" in made ? made.sentence : made.missing}`, () => {
      expect("sentence" in made, JSON.stringify(made)).toBe(true);
      const plan = makePlan(sheets, (made as { sentence: string }).sentence);
      expect(plan.clarification_question, (made as { sentence: string }).sentence).toBeNull();
      expect(plan.steps.map((s) => s.op)).toEqual(ops);
    });
  }

  it("says what is still missing", () => {
    expect(build(TEMPLATES.find((t) => t.id === "sort")!, { dir: "ascending" })).toEqual({ missing: "Sort by" });
    expect(build(TEMPLATES.find((t) => t.id === "total")!, { func: "total", by: ["branch"] })).toEqual({ missing: "of this column" });
  });
});
