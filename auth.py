"""Accounts and logins. Standard library only.

Accounts live in users.json (never committed) as salted PBKDF2 hashes; logins are random tokens held
in memory. Manage accounts from the command line:

    python users.py add <username>      # prompts for a password
    python users.py remove <username>
    python users.py list
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

USERS_FILE = Path(os.environ.get("SHEET_ASSISTANT_USERS", Path(__file__).parent / "users.json"))
LOGIN_HOURS = float(os.environ.get("SHEET_ASSISTANT_LOGIN_HOURS", 8))
MAX_FAILURES = 5
LOCKOUT_SECONDS = 5 * 60
ITERATIONS = 600_000
MIN_PASSWORD_LENGTH = 8

_tokens: dict[str, tuple[str, float]] = {}        # token -> (username, expires at)
_failures: dict[str, tuple[int, float]] = {}      # username -> (failed attempts, locked until)


def _load() -> dict:
    return json.loads(USERS_FILE.read_text(encoding="utf-8")) if USERS_FILE.exists() else {}


def _hash(password: str, salt: str, iterations: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations).hex()


def add_user(username: str, password: str) -> None:
    username = username.strip().lower()
    if not username or not username.replace(".", "").replace("_", "").replace("-", "").isalnum():
        raise ValueError("Usernames may contain letters, numbers, dots, dashes and underscores.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.")
    users = _load()
    salt = secrets.token_hex(16)
    users[username] = {"salt": salt, "iterations": ITERATIONS, "hash": _hash(password, salt, ITERATIONS)}
    USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")


def remove_user(username: str) -> bool:
    username = username.strip().lower()
    users = _load()
    if users.pop(username, None) is None:
        return False
    USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")
    for token, (user, _) in list(_tokens.items()):
        if user == username:
            del _tokens[token]
    return True


def list_users() -> list[str]:
    return sorted(_load())


class LoginError(Exception):
    pass


def login(username: str, password: str) -> str:
    """A new login token, or LoginError. Same message for unknown user and wrong password."""
    username = username.strip().lower()
    count, locked_until = _failures.get(username, (0, 0.0))
    if locked_until > time.time():
        raise LoginError(f"Too many failed attempts. Try again in {int(locked_until - time.time()) // 60 + 1} minute(s).")
    record = _load().get(username)
    ok = record is not None and hmac.compare_digest(
        _hash(password, record["salt"], record["iterations"]), record["hash"])
    if not ok:
        count += 1
        _failures[username] = (0, time.time() + LOCKOUT_SECONDS) if count >= MAX_FAILURES else (count, 0.0)
        raise LoginError("Wrong username or password.")
    _failures.pop(username, None)
    token = secrets.token_urlsafe(32)
    _tokens[token] = (username, time.time() + LOGIN_HOURS * 3600)
    return token


def user_for(token: str | None) -> str | None:
    if not token or token not in _tokens:
        return None
    username, expires = _tokens[token]
    if expires < time.time():
        del _tokens[token]
        return None
    return username


def logout(token: str | None) -> None:
    _tokens.pop(token or "", None)


def drop_expired_tokens() -> None:
    now = time.time()
    for token, (_, expires) in list(_tokens.items()):
        if expires < now:
            del _tokens[token]
