"""Login, per-user data, and automatic clearing of uploaded data."""
import io
import json
import time

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app
import auth
import users
from conftest import PASSWORD, login


def upload(c: TestClient) -> str:
    buf = io.BytesIO()
    pd.DataFrame({"pan": ["A", "B"], "amount": [1, 2]}).to_excel(buf, index=False)
    r = c.post("/api/upload", files={"file": ("data.xlsx", buf.getvalue())})
    assert r.status_code == 200, r.text
    return r.json()["session_id"]


# ---------- login ----------

def test_everything_needs_login():
    c = TestClient(app.app)
    assert c.post("/api/plan", json={"session_id": "x", "message": "sort by amount"}).status_code == 401
    assert c.get("/api/download/x").status_code == 401
    assert c.post("/api/upload", files={"file": ("a.csv", b"a\n1")}).status_code == 401
    r = c.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/login"
    assert c.get("/login").status_code == 200


def test_login_and_logout():
    c = login()
    assert c.get("/api/me").json()["user"] == "tester"
    assert c.get("/login", follow_redirects=False).headers["location"] == "/"
    c.post("/api/logout")
    assert c.get("/api/me").status_code == 401


def test_cookie_is_http_only_and_strict():
    c = TestClient(app.app)
    r = c.post("/api/login", json={"username": "tester", "password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie


def test_wrong_password_and_unknown_user_look_the_same():
    c = TestClient(app.app)
    a = c.post("/api/login", json={"username": "tester", "password": "wrong password"})
    b = c.post("/api/login", json={"username": "nobody", "password": "wrong password"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


def test_lockout_after_five_failures():
    c = TestClient(app.app)
    for _ in range(5):
        c.post("/api/login", json={"username": "tester", "password": "wrong password"})
    r = c.post("/api/login", json={"username": "tester", "password": PASSWORD})  # even the right one
    assert r.status_code == 401 and "Too many" in r.json()["detail"]
    assert c.post("/api/login", json={"username": "other", "password": PASSWORD}).status_code == 200


def test_usernames_are_case_insensitive():
    c = TestClient(app.app)
    assert c.post("/api/login", json={"username": " Tester ", "password": PASSWORD}).status_code == 200


def test_login_expires(monkeypatch):
    c = login()
    monkeypatch.setattr(time, "time", lambda: 10**12)  # far in the future
    assert c.get("/api/me").status_code == 401


def test_passwords_are_stored_hashed():
    stored = auth.USERS_FILE.read_text()
    assert PASSWORD not in stored
    record = json.loads(stored)["tester"]
    assert set(record) == {"salt", "iterations", "hash"}


def test_short_password_rejected():
    with pytest.raises(ValueError, match="at least"):
        auth.add_user("x", "short")


def test_removed_user_is_logged_out():
    c = login()
    assert auth.remove_user("tester")
    assert c.get("/api/me").status_code == 401


def test_users_cli(monkeypatch, capsys):
    passwords = iter(["a long password", "a long password"])
    monkeypatch.setattr("getpass.getpass", lambda prompt: next(passwords))
    assert users.main(["add", "Priya"]) == 0
    assert "priya" in auth.list_users()
    assert users.main(["list"]) == 0 and "priya" in capsys.readouterr().out
    assert users.main(["remove", "priya"]) == 0 and "priya" not in auth.list_users()


# ---------- each person sees only their own data ----------

def test_other_users_cannot_open_my_data():
    me, them = login("tester"), login("other")
    sid = upload(me)
    for r in (them.post("/api/plan", json={"session_id": sid, "message": "sort by amount"}),
              them.get(f"/api/download/{sid}"),
              them.post("/api/undo", json={"session_id": sid})):
        assert r.status_code == 404  # looks exactly like data that doesn't exist
    assert me.post("/api/plan", json={"session_id": sid, "message": "sort by amount"}).status_code == 200


# ---------- automatic clearing ----------

def test_logout_deletes_my_data_but_not_others():
    me, them = login("tester"), login("other")
    mine, theirs = upload(me), upload(them)
    me.post("/api/logout")
    assert mine not in app.sessions and theirs in app.sessions


def test_idle_data_is_cleared(monkeypatch):
    c = login()
    sid = upload(c)
    app.clear_idle()
    assert sid in app.sessions  # still fresh
    later = time.time() + app.IDLE_MINUTES * 60 + 1
    monkeypatch.setattr(time, "time", lambda: later)
    app.clear_idle()
    assert sid not in app.sessions


def test_activity_keeps_data_alive(monkeypatch):
    c = login()
    sid = upload(c)
    start = time.time()
    monkeypatch.setattr(time, "time", lambda: start + app.IDLE_MINUTES * 60 - 5)
    c.post("/api/plan", json={"session_id": sid, "message": "sort by amount"})  # touches the session
    monkeypatch.setattr(time, "time", lambda: start + app.IDLE_MINUTES * 60 + 30)
    app.clear_idle()
    assert sid in app.sessions


def test_cleared_data_gives_a_clear_message(monkeypatch):
    c = login()
    sid = upload(c)
    del app.sessions[sid]
    r = c.post("/api/plan", json={"session_id": sid, "message": "sort by amount"})
    assert r.status_code == 404 and "upload the file again" in r.json()["detail"]


def test_background_sweep_runs_on_startup(monkeypatch):
    calls = []
    monkeypatch.setattr(app, "clear_idle", lambda: calls.append(1))

    async def fast_sleep(_):
        await original_sleep(0)

    import asyncio
    original_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", fast_sleep)
    with TestClient(app.app):  # runs the lifespan (startup/shutdown)
        deadline = time.monotonic() + 2
        while not calls and time.monotonic() < deadline:
            time.sleep(0.01)
    assert calls, "the idle sweep never ran"
