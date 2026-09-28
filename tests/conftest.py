"""Shared fixtures: tests use a throwaway accounts file and log in like a real user."""
import pytest
from fastapi.testclient import TestClient

import app
import auth

PASSWORD = "correct horse battery"


@pytest.fixture(autouse=True)
def accounts(tmp_path, monkeypatch):
    """Every test gets its own users file, so tests never touch a real users.json."""
    monkeypatch.setattr(auth, "USERS_FILE", tmp_path / "users.json")
    monkeypatch.setattr(auth, "ITERATIONS", 1_000)  # fast hashing in tests only; the app uses 600,000
    monkeypatch.setattr(auth, "_tokens", {})
    monkeypatch.setattr(auth, "_failures", {})
    auth.add_user("tester", PASSWORD)
    auth.add_user("other", PASSWORD)


def login(username: str = "tester") -> TestClient:
    c = TestClient(app.app)
    assert c.post("/api/login", json={"username": username, "password": PASSWORD}).status_code == 200
    return c


@pytest.fixture
def client() -> TestClient:
    return login()
