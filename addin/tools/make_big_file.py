"""Makes a made-up bank file of any size, to try the add-in on a lot of rows.

    python3 tools/make_big_file.py 200000 bank_200k.xlsx
    python3 tools/make_big_file.py 1000000 bank_1m.xlsx      # Excel's limit is 1,048,575 data rows

The data is random and fake. The file has two sheets: "Transactions" (the big table) and "Branches" (six rows, for
trying "bring manager from Branches on branch"). A few problems are planted on purpose (stray spaces, amounts saved
as text, odd capitals, blanks, repeated rows) so beginner mode has something to find. Needs: pip install xlsxwriter
"""
import random
import sys
from datetime import date, timedelta

import xlsxwriter


def main() -> None:
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    out = sys.argv[2] if len(sys.argv) > 2 else f"bank_{rows}.xlsx"
    if rows > 1_048_575:
        raise SystemExit("Excel sheets hold at most 1,048,575 data rows.")
    rnd = random.Random(7)
    cats = ["Food and Dining", "Travel", "Rent", "Shopping", "Salary", "Cash", "Fuel", "Insurance"]
    branches = ["Mumbai", "Pune", "Delhi", "Chennai", "Kolkata", "Hyderabad"]
    words = ["AMAZON PAY", "UPI/SWIGGY", "UPI/ZOMATO", "NEFT RENT", "ATM WDL", "IRCTC TICKET", "SALARY CREDIT", "EMI HDFC"]
    start = date(2023, 1, 1)

    wb = xlsxwriter.Workbook(out, {"constant_memory": True, "strings_to_numbers": False})
    ws = wb.add_worksheet("Transactions")
    head = wb.add_format({"bold": True})
    money = wb.add_format({"num_format": "#,##0"})
    day = wb.add_format({"num_format": "dd/mm/yyyy"})
    ws.write_row(0, 0, ["txn_id", "txn_date", "description", "category", "txn_type", "amount", "balance", "branch", "pan", "email"], head)
    ws.freeze_panes(1, 0)
    last = None
    for i in range(rows):
        if last is not None and i % 5000 == 4999:  # an exact repeat now and then
            row = last
        else:
            amount = rnd.randrange(10, 400000)
            category = rnd.choice(cats)
            row = [
                100000 + i, start + timedelta(days=rnd.randrange(0, 1000)), rnd.choice(words), category,
                rnd.choice(["DEBIT", "DEBIT", "CREDIT"]), amount, rnd.randrange(0, 2_000_000),
                rnd.choice(branches + [None]), f"ABCDE{rnd.randrange(0, 120000):05d}F", f"user{rnd.randrange(0, 90000)}@mail.com",
            ]
            if i % 997 == 0:
                row[3] = category.lower()                    # odd capitals
            if i % 1499 == 0:
                row[7] = f" {row[7]} " if row[7] else row[7]   # stray spaces
            if i % 1999 == 0:
                row[5] = f"Rs. {amount:,}"                   # an amount saved as text
        last = row
        r = i + 1
        ws.write_number(r, 0, row[0])
        ws.write_datetime(r, 1, __import__("datetime").datetime.combine(row[1], __import__("datetime").time()), day)
        for j in (2, 3, 4):
            ws.write_string(r, j, row[j])
        if isinstance(row[5], str):
            ws.write_string(r, 5, row[5])
        else:
            ws.write_number(r, 5, row[5], money)
        ws.write_number(r, 6, row[6], money)
        if row[7] is not None:
            ws.write_string(r, 7, row[7])
        ws.write_string(r, 8, row[8])
        ws.write_string(r, 9, row[9])
    ws.set_column(0, 9, 16)

    b = wb.add_worksheet("Branches")
    b.write_row(0, 0, ["branch", "manager", "region"], head)
    for i, (name, mgr, reg) in enumerate(zip(branches, ["A. Rao", "S. Iyer", "R. Singh", "K. Nair", "M. Das", "P. Reddy"],
                                              ["West", "West", "North", "South", "East", "South"]), start=1):
        b.write_row(i, 0, [name, mgr, reg])
    wb.close()
    print(f"wrote {out}: {rows:,} rows")


if __name__ == "__main__":
    main()
