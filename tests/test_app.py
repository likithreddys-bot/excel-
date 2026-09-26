"""End-to-end through the HTTP API, including multi-sheet workbooks."""
import io

import pandas as pd
from fastapi.testclient import TestClient

import app

client = TestClient(app.app)


def upload_two_sheet_workbook():
    """A data sheet plus a summary sheet that shares some column names, like an API-output export."""
    output = pd.DataFrame({
        "pan": [f"PAN{i:05d}" for i in range(200)],
        "result_code": [101.0 if i % 4 == 0 else 109.0 for i in range(200)],
        "response": [f"{{'id': {i}}}" for i in range(200)],
    })
    summary = pd.DataFrame({"result_code": [101.0, 109.0], "Count": [50, 150]})
    buf = io.BytesIO()
    with pd.ExcelWriter(buf) as w:
        summary.to_excel(w, sheet_name="Summary", index=False)  # not first, but smaller
        output.to_excel(w, sheet_name="Output", index=False)
    r = client.post("/api/upload", files={"file": ("export.xlsx", buf.getvalue())}).json()
    return r


def run(sid, message):
    r = client.post("/api/plan", json={"session_id": sid, "message": message}).json()
    assert "error" not in r and "clarification_question" not in r, r
    return client.post("/api/execute", json={"session_id": sid}).json()


def test_works_on_main_sheet_and_keeps_the_rest():
    r = upload_two_sheet_workbook()
    assert [s["name"] for s in r["sheets"]] == ["Output"]
    assert r["kept_sheets"] == ["Summary"]

    state = run(r["session_id"], "result code 101")  # Summary has result_code but must not be filtered
    assert state["sheets"][0]["rows"] == 50

    state = run(r["session_id"], "keep columns pan, response")  # Summary has neither column
    assert state["sheets"][0]["columns"] == ["pan", "response"]


def test_split_then_download_includes_kept_sheet():
    r = upload_two_sheet_workbook()
    state = run(r["session_id"], "split by result code")
    assert [(s["name"], s["rows"]) for s in state["sheets"]] == [("101", 50), ("109", 150)]

    xlsx = client.get(f"/api/download/{r['session_id']}?fmt=xlsx").content
    book = pd.read_excel(io.BytesIO(xlsx), sheet_name=None)
    assert {n: len(df) for n, df in book.items()} == {"101": 50, "109": 150, "Summary": 2}
