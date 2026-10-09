"""Append-only security and operations audit trail (spec §22.I).
Never pass passwords, tokens or ticket descriptions into these records."""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.core.context import client_ip_var, request_id_var
from app.database.session import SessionLocal
from app.models import AuditLog

log = logging.getLogger("opstwin.audit")


def record(
    db: Session,
    *,
    actor_id: str | None,
    action: str,
    target_type: str,
    target_id: str | None = None,
    outcome: str = "SUCCESS",
    department_id: str | None = None,
    before: dict | None = None,
    after: dict | None = None,
    details: dict | None = None,
) -> AuditLog:
    entry = AuditLog(
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        outcome=outcome,
        department_id=department_id,
        correlation_id=request_id_var.get(),
        before=before,
        after=after,
        details=details,
        ip_address=client_ip_var.get(),
    )
    db.add(entry)
    log.info("audit action=%s outcome=%s actor=%s target=%s:%s", action, outcome, actor_id, target_type, target_id)
    return entry


def record_standalone(**kwargs) -> None:
    """Write in its own transaction (used for denials and failed logins, where the request rolls back)."""
    db = SessionLocal()
    try:
        record(db, **kwargs)
        db.commit()
    finally:
        db.close()


def record_denied(principal, what: str, target_type: str = "endpoint", target_id: str | None = None) -> None:
    record_standalone(
        actor_id=principal.user.id, action="access.denied", target_type=target_type, target_id=target_id,
        outcome="DENIED", details={"required": what},
    )
