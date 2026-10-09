"""Shared helpers for routers."""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import not_found
from app.models import StressTest, TwinSnapshot
from app.services.authz import Principal

TWIN_READ_CODES = ("simulations.read", "simulations.run", "snapshots.create")


def twin_scope(principal: Principal) -> set[str] | None:
    """Departments whose twin data the caller may read (None = all)."""
    out: set[str] = set()
    for code in TWIN_READ_CODES:
        s = principal.scope(code)
        if s is None:
            return None
        out |= s
    return out


def can_read_snapshot(principal: Principal, snap: TwinSnapshot) -> bool:
    scope = twin_scope(principal)
    if scope is None:
        return True
    if snap.scope is None:
        return False
    return bool(snap.scope) and set(snap.scope) <= scope


def readable_snapshot(db: Session, principal: Principal, snapshot_id: str) -> TwinSnapshot:
    snap = db.get(TwinSnapshot, snapshot_id)
    if snap is None or not can_read_snapshot(principal, snap):
        raise not_found("That snapshot")  # same answer for missing and out-of-scope
    return snap


def readable_stress_test(db: Session, principal: Principal, st_id: str) -> StressTest:
    st = db.get(StressTest, st_id)
    if st is None:
        raise not_found("That stress test")
    readable_snapshot(db, principal, st.snapshot_id)
    return st


def visible_stages_for(snap: TwinSnapshot) -> list[str] | None:
    return None if snap.scope is None else list(snap.scope)
