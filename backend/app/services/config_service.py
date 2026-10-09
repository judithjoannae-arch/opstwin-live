"""Operational configuration: SLA policies, routing policy and staffing allocation.
Every change creates a new immutable ConfigVersion."""
from __future__ import annotations

import copy

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import ConfigVersion, Resource, SlaPolicy

DEFAULT_SLA = {
    "P1": {"response_minutes": 15, "resolution_minutes": 240},
    "P2": {"response_minutes": 30, "resolution_minutes": 480},
    "P3": {"response_minutes": 120, "resolution_minutes": 1440},
    "P4": {"response_minutes": 480, "resolution_minutes": 4320},
}

DEFAULT_CONFIG = {
    "sla": DEFAULT_SLA,
    "routing": {"policy": "fifo", "skill_aware": False},
    "staffing": {"active_reserves": [], "reallocations": []},
}

ROUTING_POLICIES = ("fifo", "priority", "smart_triage")


def current(db: Session) -> ConfigVersion:
    cv = db.query(ConfigVersion).order_by(ConfigVersion.number.desc()).first()
    if cv is None:
        raise RuntimeError("No configuration version exists. Run the database initialisation first.")
    return cv


def current_label(db: Session) -> str:
    return current(db).label


def create_version(db: Session, *, config: dict, source: str, summary: str, created_by: str | None,
                   change_request_id: str | None = None) -> ConfigVersion:
    last = db.query(func.max(ConfigVersion.number)).scalar() or 0
    cv = ConfigVersion(number=last + 1, source=source, summary=summary[:300], created_by=created_by,
                       change_request_id=change_request_id, config=copy.deepcopy(config))
    db.add(cv)
    db.flush()
    return cv


def sla_minutes(db: Session) -> dict[str, int]:
    return {p.priority: p.resolution_minutes for p in db.query(SlaPolicy).all()} or {
        k: v["resolution_minutes"] for k, v in DEFAULT_SLA.items()
    }


def staffing_state(db: Session) -> dict:
    resources = db.query(Resource).order_by(Resource.name).all()
    return {
        "allocation": {r.id: r.stage for r in resources},
        "active_reserves": sorted(r.id for r in resources if r.is_reserve and r.reserve_active),
    }
