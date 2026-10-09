"""Test fixtures: an isolated SQLite database with reference data, demo staff and accounts."""
from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["OPSTWIN_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["OPSTWIN_ENV"] = "development"
os.environ["OPSTWIN_DEMO_PASSWORD"] = "DemoPassw0rd!x"
os.environ.setdefault("OPSTWIN_LOG_LEVEL", "WARNING")
os.environ["OPSTWIN_MONITOR_THREAD"] = "off"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.ratelimit import limiter  # noqa: E402
from app.database.session import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import init_reference_data, seed_demo  # noqa: E402

PASSWORD = "DemoPassw0rd!x"
USERS = {
    "admin": "superadmin@opstwin.demo",
    "ops": "ops.manager@opstwin.demo",
    "support_mgr": "support.manager@opstwin.demo",
    "triage_mgr": "triage.manager@opstwin.demo",
    "tech": "technician@opstwin.demo",
    "analyst": "analyst@opstwin.demo",
    "auditor": "auditor@opstwin.demo",
}


@pytest.fixture
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = SessionLocal()
    init_reference_data(db)
    seed_demo(db, hours=48, seed=7)
    db.close()
    limiter.reset()
    yield


class Api:
    """TestClient wrapper that handles the CSRF double-submit token."""

    def __init__(self, client: TestClient):
        self.c = client
        self.token = None

    def _csrf(self) -> dict:
        self.token = self.c.get("/api/auth/csrf").json()["csrf_token"]
        return {"X-CSRF-Token": self.token}

    def get(self, url, **kw):
        return self.c.get(url, **kw)

    def _send(self, method, url, headers=None, **kw):
        return self.c.request(method, url, headers={**self._csrf(), **(headers or {})}, **kw)

    def post(self, url, **kw):
        return self._send("POST", url, **kw)

    def patch(self, url, **kw):
        return self._send("PATCH", url, **kw)

    def put(self, url, **kw):
        return self._send("PUT", url, **kw)

    def delete(self, url, **kw):
        return self._send("DELETE", url, **kw)

    def login(self, who: str) -> "Api":
        r = self.post("/api/auth/login", json={"email": USERS[who], "password": PASSWORD})
        assert r.status_code == 204, r.text
        return self


@pytest.fixture
def make_client(fresh_db):
    clients = []

    def factory(who: str | None = None) -> Api:
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        api = Api(c)
        return api.login(who) if who else api

    yield factory
    for c in clients:
        c.__exit__(None, None, None)
