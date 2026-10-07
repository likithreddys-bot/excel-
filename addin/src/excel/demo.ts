/**
 * A stand-in host for running the task pane in an ordinary browser (no Excel): `npm run dev`, open
 * https://localhost:3000/taskpane.html. It holds a small made-up bank file in memory.
 */
import { Cell, Sheets, Table, makeTable } from "../engine/table";
import { Created, Host, Source, SourceRef } from "../host";

function demoRows(n = 400): Cell[][] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const today = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today - Math.floor(rnd() * 800) * 86_400_000);
    const date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    return [
      100000 + i, date,
      pick(["AMAZON PAY", "ATM WDL MG ROAD", "SALARY CREDIT ACME", "UPI/SWIGGY", "NEFT RENT", "UPI/ZOMATO", "IRCTC TICKET"]),
      pick(["Food and Dining", "Travel", "Rent", "Shopping", "Salary", "Cash"]),
      pick(["DEBIT", "CREDIT"]),
      10 + Math.floor(rnd() * 199990), Math.floor(rnd() * 1_000_000),
      pick(["Mumbai", "Pune", null]),
    ];
  });
}

export class DemoHost implements Host {
  kind = "demo" as const;
  private sheets = new Map<string, Table>();

  constructor() {
    const names = ["txn_id", "txn_date", "description", "category", "txn_type", "amount", "balance", "branch"];
    this.sheets.set("Transactions", makeTable(names, demoRows()));
    this.sheets.set("Branches", makeTable(["branch", "manager", "region"], [
      ["Mumbai", "A. Rao", "West"], ["Pune", "S. Iyer", "West"], ["Delhi", "R. Singh", "North"],
    ]));
  }

  async listSheets(): Promise<string[]> {
    return [...this.sheets.keys()];
  }

  async readSheet(name: string): Promise<Table> {
    return this.sheets.get(name)!;
  }

  async readSource(ref?: SourceRef): Promise<Source> {
    const sheet = ref?.sheet ?? "Transactions";
    const table = this.sheets.get(sheet)!;
    return { ref: { sheet, address: "A1" }, label: `${sheet}!A1:H${table.nrows + 1}`, table };
  }

  async writeResult(sheets: Sheets): Promise<Created[]> {
    const out: Created[] = [];
    for (const [wanted, table] of sheets) {
      let name = wanted, n = 2;
      while (this.sheets.has(name)) name = `${wanted} (${n++})`;
      this.sheets.set(name, table);
      out.push({ name, rows: table.nrows });
    }
    return out;
  }

  async removeSheets(names: string[]): Promise<void> {
    for (const n of names) this.sheets.delete(n);
  }

  async refOf(sheetName: string): Promise<SourceRef> {
    return { sheet: sheetName, address: "A1" };
  }
}
