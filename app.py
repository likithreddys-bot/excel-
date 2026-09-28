"""FastAPI server: upload -> plan (dry run) -> confirm -> execute, with undo/redo and download.

Everyone logs in (accounts: `python users.py add <name>`), sees only their own uploads, and uploaded
data is deleted after SHEET_ASSISTANT_IDLE_MINUTES without activity (default 60) or on logout.

Run:  uvicorn app:app
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

import auth
import engine
from engine import PlanError, Sheets
from plan import FORMAT_OPS, Plan
from planner import describe, examples, make_plan, reply_columns

PREVIEW_ROWS = 100
IDLE_MINUTES = float(os.environ.get("SHEET_ASSISTANT_IDLE_MINUTES", 60))
HTTPS = os.environ.get("SHEET_ASSISTANT_HTTPS") == "1"  # set when served over HTTPS: cookie is then Secure
COOKIE = "sheet_assistant_login"
STATIC = Path(__file__).parent / "static"


@dataclass
class Session:
    filename: str
    original: Sheets
    owner: str
    kept: Sheets = field(default_factory=dict)  # other workbook sheets, passed through to the download
    files: dict[str, pd.DataFrame] = field(default_factory=dict)  # extra files for lookup/append/compare
    applied: list[tuple[str, Plan]] = field(default_factory=list)  # (request, plan)
    pointer: int = 0  # applied[:pointer] are active; the rest can be redone
    pending: tuple[str, Plan] | None = None
    asked: str | None = None  # a request waiting for the user to reply with column names
    last_used: float = field(default_factory=time.time)
    current: Sheets = field(init=False)

    def __post_init__(self):
        self.current = self.original

    def formats(self) -> list:
        """Active formatting steps (highlights, number formats, charts), applied in the Excel download."""
        return [st for _, p in self.applied[: self.pointer] for st in p.steps if st.op in FORMAT_OPS]

    def computed(self) -> dict[str, str]:
        """Formulas behind columns made by earlier commands ("B0% = ..."), for calculated-field totals."""
        return {st.name: st.expr for _, p in self.applied[: self.pointer] for st in p.steps if st.op == "compute"}

    def recompute(self):
        sheets = self.original
        for _, plan in self.applied[: self.pointer]:
            sheets = engine.apply_plan(sheets, plan, files=self.files)
        self.current = sheets


sessions: dict[str, Session] = {}


def clear_idle() -> None:
    """Delete uploaded data nobody has touched for IDLE_MINUTES, and expired logins."""
    cutoff = time.time() - IDLE_MINUTES * 60
    for sid in [sid for sid, s in sessions.items() if s.last_used < cutoff]:
        del sessions[sid]
    auth.drop_expired_tokens()


@asynccontextmanager
async def lifespan(_: FastAPI):
    async def sweep():
        while True:  # runs even when nobody is using the app
            await asyncio.sleep(60)
            clear_idle()

    task = asyncio.create_task(sweep())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def require_login(request: Request, call_next):
    request.state.user = auth.user_for(request.cookies.get(COOKIE))
    if request.state.user or request.url.path in ("/login", "/api/login"):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "Please log in again."}, status_code=401)
    return RedirectResponse("/login")


def get_session(sid: str, request: Request) -> Session:
    s = sessions.get(sid)
    if s is None or s.owner != request.state.user:  # other people's sessions look the same as missing ones
        raise HTTPException(404, f"Your data was cleared (after {IDLE_MINUTES:g} minutes without activity, "
                                 "or when you logged out). Please upload the file again.")
    s.last_used = time.time()
    return s


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


# ---------- login ----------

@app.get("/login")
def login_page(request: Request):
    if request.state.user:
        return RedirectResponse("/")
    return FileResponse(STATIC / "login.html")


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(req: LoginRequest):
    try:
        token = auth.login(req.username, req.password)
    except auth.LoginError as e:
        raise HTTPException(401, str(e))
    response = JSONResponse({"user": req.username.strip().lower()})
    response.set_cookie(COOKIE, token, max_age=int(auth.LOGIN_HOURS * 3600), httponly=True,
                        samesite="strict", secure=HTTPS)
    return response


@app.post("/api/logout")
def logout(request: Request):
    """Log out and delete this person's uploaded data straight away."""
    for sid in [sid for sid, s in sessions.items() if s.owner == request.state.user]:
        del sessions[sid]
    auth.logout(request.cookies.get(COOKIE))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


@app.get("/api/me")
def me(request: Request):
    return {"user": request.state.user, "idle_minutes": IDLE_MINUTES}


# ---------- the app ----------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/upload")
async def upload(request: Request, file: UploadFile):
    try:
        sheets = engine.load_file(file.filename, await file.read())
    except PlanError as e:
        raise HTTPException(400, str(e))
    # Commands work on the main data sheet (most rows); summary/other sheets are kept as-is.
    main = max(sheets, key=lambda n: len(sheets[n]))
    kept = {n: df for n, df in sheets.items() if n != main}
    sid = uuid.uuid4().hex
    sessions[sid] = Session(filename=file.filename, original={main: sheets[main]}, owner=request.state.user, kept=kept)
    return {"session_id": sid, **state(sessions[sid]), "examples": examples(sessions[sid].current)}


@app.post("/api/files")
async def add_file(request: Request, session_id: str = Form(...), file: UploadFile = File(...)):
    """An extra file to look up from, append or compare with. It's referred to by its name, e.g. "customers"."""
    s = get_session(session_id, request)
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
def plan(req: PlanRequest, request: Request):
    s = get_session(req.session_id, request)
    # A reply that is only column names answers the question asked just before ("Which column ...?").
    reply = reply_columns(s.current, req.message) if s.asked else None
    if reply and reply[1]:
        return {"clarification_question": "I couldn't find " + ", ".join(reply[1]) + ". Reply again with the column names."}
    if reply:
        request_text = f"{s.asked} → {req.message}"
        p = make_plan(s.current, s.asked, s.files, s.computed(), answer=reply[0])
    else:
        request_text = req.message
        p = make_plan(s.current, req.message, s.files, s.computed())
    if p.clarification_question:
        s.pending = None
        s.asked = (s.asked if reply else req.message) if p.awaits_columns else None
        return {"clarification_question": p.clarification_question}
    s.asked = None

    # Dry run: execute on the real data so the preview shows exact numbers.
    notes: list[str] = []
    try:
        result = engine.apply_plan(s.current, p, files=s.files, notes=notes)
    except (PlanError, KeyError, ValueError, TypeError) as e:
        s.pending = None
        return {"error": f"This plan can't run on your data: {e}", "plan": p.model_dump()}

    s.pending = (request_text, p)
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
def execute(req: SessionRequest, request: Request):
    s = get_session(req.session_id, request)
    if not s.pending:
        raise HTTPException(400, "Nothing to execute")
    del s.applied[s.pointer :]  # a new command discards the redo stack
    s.applied.append(s.pending)
    s.pointer += 1
    s.pending = None
    s.recompute()
    return state(s)


@app.post("/api/undo")
def undo(req: SessionRequest, request: Request):
    s = get_session(req.session_id, request)
    if s.pointer > 0:
        s.pointer -= 1
        s.recompute()
    return state(s)


@app.post("/api/redo")
def redo(req: SessionRequest, request: Request):
    s = get_session(req.session_id, request)
    if s.pointer < len(s.applied):
        s.pointer += 1
        s.recompute()
    return state(s)


@app.get("/api/download/{sid}")
def download(sid: str, request: Request, fmt: str = "xlsx"):
    s = get_session(sid, request)
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
