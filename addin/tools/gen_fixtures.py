"""Makes the small files the website reader tests use (xlsx written by two different libraries, and CSVs).

Everything is made-up data. Output goes to test/fixtures (not committed). Run by `npm test` automatically.
"""
import csv
import os
from datetime import date, datetime

import openpyxl
import xlsxwriter

OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")
os.makedirs(OUT, exist_ok=True)

ROWS = [
    # id, date, name, amount, branch, note
    [1, date(2024, 1, 15), "Asha & Sons", 1200.5, "Mumbai", 'say "hi", ok'],
    [2, date(2024, 2, 20), "  Ravi <R>  ", 30000, "Pune", "line1\nline2"],
    [3, date(2025, 3, 5), "Zoya", None, "Mumbai", None],
    [4, date(2025, 3, 25), "Zoya", 50, None, "plain"],
    [5, None, "Ünïcode ₹", -75.25, "Delhi", "x"],
]
HEAD = ["id", "txn_date", "name", "amount", "branch", "note"]

# 1) xlsxwriter: shared strings, date format, number format, a second sheet, a blank row in the middle
wb = xlsxwriter.Workbook(os.path.join(OUT, "small_xw.xlsx"))
ws = wb.add_worksheet("Transactions")
day = wb.add_format({"num_format": "dd/mm/yyyy"})
money = wb.add_format({"num_format": "#,##0.00"})
ws.write_row(0, 0, HEAD)
for i, r in enumerate(ROWS, start=1):
    for j, v in enumerate(r):
        if v is None:
            continue
        if isinstance(v, date):
            ws.write_datetime(i, j, datetime(v.year, v.month, v.day), day)
        elif j == 3:
            ws.write_number(i, j, v, money)
        else:
            ws.write(i, j, v)
ws2 = wb.add_worksheet("Branches")
ws2.write_row(0, 0, ["branch", "manager"])
ws2.write_row(1, 0, ["Mumbai", "A. Rao"])
ws2.write_row(2, 0, ["Pune", "S. Iyer"])
hidden = wb.add_worksheet("Hidden")
hidden.hide()
hidden.write_row(0, 0, ["x"])
wb.close()

# 2) openpyxl: its own XML flavour (inline/shared strings, dimension, styles)
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Data"
ws.append(HEAD)
for r in ROWS:
    ws.append(r)
for row in ws.iter_rows(min_row=2, min_col=2, max_col=2):
    row[0].number_format = "yyyy-mm-dd"
wb.save(os.path.join(OUT, "small_opx.xlsx"))

# 3) leading blank rows and a trailing formatted-but-empty row
wb = xlsxwriter.Workbook(os.path.join(OUT, "offset.xlsx"))
ws = wb.add_worksheet("S")
ws.write_row(2, 0, ["a", "b"])
ws.write_row(3, 0, [1, 2])
ws.write_row(4, 0, [3, 4])
ws.write_blank(5, 0, None, wb.add_format({"bold": True}))
wb.close()

# 4) a wide sheet: 2,000 rows x 300 columns
wb = xlsxwriter.Workbook(os.path.join(OUT, "wide.xlsx"), {"constant_memory": True})
ws = wb.add_worksheet("Wide")
ws.write_row(0, 0, [f"col{j}" for j in range(300)])
for i in range(2000):
    ws.write_row(i + 1, 0, [i * 1000 + j if j % 3 else f"v{i}_{j}" for j in range(300)])
wb.close()

# 5) CSVs: comma with quotes/newlines/BOM, semicolon, and tab
with open(os.path.join(OUT, "small.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(HEAD)
    for r in ROWS:
        w.writerow(["" if v is None else (v.strftime("%d/%m/%Y") if isinstance(v, date) else v) for v in r])
with open(os.path.join(OUT, "semicolon.csv"), "w", encoding="utf-8", newline="") as f:
    f.write("id;amount;branch\r\n1;10,5;Mumbai\r\n2;20;Pune\r\n\r\n")
with open(os.path.join(OUT, "tab.tsv"), "w", encoding="utf-8", newline="") as f:
    f.write("id\tamount\n1\t5\n2\t6")  # no trailing newline
with open(os.path.join(OUT, "wide.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow([f"col{j}" for j in range(300)])
    for i in range(2000):
        w.writerow([i * 1000 + j if j % 3 else f"v{i}_{j}" for j in range(300)])
print("fixtures written to", os.path.abspath(OUT))
