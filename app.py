"""FastAPI server: upload -> plan (dry run) -> confirm -> execute, with undo/redo and download.

Run:  uvicorn app:app --reload
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import engine
from engine import PlanError, Sheets
from plan import FORMAT_OPS, Plan
from planner import describe, make_plan

PREVIEW_ROWS = 100

app = FastAPI()


@dataclass
class Session:
    filename: str
    original: Sheets
    kept: Sheets = field(default_factory=dict)  # other workbook sheets, passed through to the download
    files: dict[str, pd.DataFrame] = field(default_factory=dict)  # extra files for lookup/append/compare
    applied: list[tuple[str, Plan]] = field(default_factory=list)  # (request, plan)
    pointer: int = 0  # applied[:pointer] are active; the rest can be redone
    pending: tuple[str, Plan] | None = None
    current: Sheets = field(init=False)

    def __post_init__(self):
        self.current = self.original

    def formats(self) -> list:
        """Active formatting steps (highlights, number formats, charts), applied in the Excel download."""
        return [st for _, p in self.applied[: self.pointer] for st in p.steps if st.op in FORMAT_OPS]

    def recompute(self):
        sheets = self.original
        for _, plan in self.applied[: self.pointer]:
            sheets = engine.apply_plan(sheets, plan, files=self.files)
        self.current = sheets


sessions: dict[str, Session] = {}


def get_session(sid: str) -> Session:
    if sid not in sessions:
        raise HTTPException(404, "Session not found; upload the file again")
    return sessions[sid]


def sheets_payload(sheets: Sheets, formats: list) -> list[dict]:
    out = []
    for name, df in sheets.items():
        head = json.loads(df.head(PREVIEW_ROWS).to_json(orient="split", index=False, date_format="iso"))
        out.append({"name": name, "rows": len(df), "columns": head["columns"], "data": head["data"],
                    "styles": engine.preview_styles(df, formats, PREVIEW_ROWS)})
    return out


def state(s: Session) -> dict:
    return {
        "filename": s.filename,
        "sheets": sheets_payload(s.current, s.formats()),
        "kept_sheets": list(s.kept),
        "files": [{"name": n, "rows": len(df), "columns": [str(c) for c in df.columns]} for n, df in s.files.items()],
        "history": [
            {"request": req, "summary": plan.summary, "active": i < s.pointer}
            for i, (req, plan) in enumerate(s.applied)
        ],
        "can_undo": s.pointer > 0,
        "can_redo": s.pointer < len(s.applied),
    }


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.post("/api/upload")
async def upload(file: UploadFile):
    try:
        sheets = engine.load_file(file.filename, await file.read())
    except PlanError as e:
        raise HTTPException(400, str(e))
    # Commands work on the main data sheet (most rows); summary/other sheets are kept as-is.
    main = max(sheets, key=lambda n: len(sheets[n]))
    kept = {n: df for n, df in sheets.items() if n != main}
    sid = uuid.uuid4().hex
    sessions[sid] = Session(filename=file.filename, original={main: sheets[main]}, kept=kept)
    return {"session_id": sid, **state(sessions[sid])}


@app.post("/api/files")
async def add_file(session_id: str = Form(...), file: UploadFile = File(...)):
    """An extra file to look up from, append or compare with. It's referred to by its name, e.g. "customers"."""
    s = get_session(session_id)
    try:
        sheets = engine.load_file(file.filename, await file.read())
    except PlanError as e:
        raise HTTPException(400, str(e))
    name = Path(file.filename).stem.strip()
    s.files[name] = max(sheets.values(), key=len)
    return state(s)


class PlanRequest(BaseModel):
    session_id: str
    message: str


@app.post("/api/plan")
def plan(req: PlanRequest):
    s = get_session(req.session_id)
    p = make_plan(s.current, req.message, s.files)
    if p.clarification_question:
        s.pending = None
        return {"clarification_question": p.clarification_question}

    # Dry run: execute on the real data so the preview shows exact numbers.
    notes: list[str] = []
    try:
        result = engine.apply_plan(s.current, p, files=s.files, notes=notes)
    except (PlanError, KeyError, ValueError, TypeError) as e:
        s.pending = None
        return {"error": f"This plan can't run on your data: {e}", "plan": p.model_dump()}

    s.pending = (req.message, p)
    return {
        "summary": p.summary,
        "steps": [describe(step) for step in p.steps],
        "plan": p.model_dump(),
        "rows_before": sum(engine.row_counts(s.current).values()),
        "rows_after": engine.row_counts(result),
        "notes": list(dict.fromkeys(notes)),
    }


class SessionRequest(BaseModel):
    session_id: str


@app.post("/api/execute")
def execute(req: SessionRequest):
    s = get_session(req.session_id)
    if not s.pending:
        raise HTTPException(400, "Nothing to execute")
    del s.applied[s.pointer :]  # a new command discards the redo stack
    s.applied.append(s.pending)
    s.pointer += 1
    s.pending = None
    s.recompute()
    return state(s)


@app.post("/api/undo")
def undo(req: SessionRequest):
    s = get_session(req.session_id)
    if s.pointer > 0:
        s.pointer -= 1
        s.recompute()
    return state(s)


@app.post("/api/redo")
def redo(req: SessionRequest):
    s = get_session(req.session_id)
    if s.pointer < len(s.applied):
        s.pointer += 1
        s.recompute()
    return state(s)


@app.get("/api/download/{sid}")
def download(sid: str, fmt: str = "xlsx"):
    s = get_session(sid)
    stem = s.filename.rsplit(".", 1)[0] + "_result"
    kept = {name if name not in s.current else f"{name} (original)"[:31]: df for name, df in s.kept.items()}
    if fmt == "csv":
        data, ext = engine.to_csv({**s.current, **kept})
        media = "text/csv" if ext == "csv" else "application/zip"
    else:
        data, ext = engine.to_xlsx(s.current, s.formats(), unformatted=kept), "xlsx"
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return Response(
        data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'},
    )
