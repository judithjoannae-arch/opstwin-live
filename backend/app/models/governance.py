"""Change requests, approvals, applied changes, audit log, prediction monitoring."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.timeutil import utcnow
from app.database.session import Base
from app.models.auth import User
from app.models.common import JsonDict, JsonList, new_id


class ChangeRequest(Base):
    __tablename__ = "change_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    recommendation_id: Mapped[str] = mapped_column(ForeignKey("recommendations.id"), index=True)
    source_simulation_id: Mapped[str] = mapped_column(ForeignKey("simulation_runs.id"))
    source_config_version: Mapped[str] = mapped_column(String(20))
    requested_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    reason: Mapped[str] = mapped_column(Text)
    expected_benefits: Mapped[list] = mapped_column(JsonList, default=list)
    risks: Mapped[list] = mapped_column(JsonList, default=list)
    config_diff: Mapped[list] = mapped_column(JsonList, default=list)
    change_spec: Mapped[dict] = mapped_column(JsonDict, default=dict)
    affected_departments: Mapped[list] = mapped_column(JsonList, default=list)
    requires_separation_of_duties: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    applied_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)
    version: Mapped[int] = mapped_column(Integer, default=1)

    requester: Mapped[User] = relationship(foreign_keys=[requested_by], lazy="joined")
    applier: Mapped[User | None] = relationship(foreign_keys=[applied_by], lazy="joined")
    decisions: Mapped[list["ApprovalDecision"]] = relationship(
        back_populates="change_request", lazy="selectin", order_by="ApprovalDecision.decided_at"
    )


class ApprovalDecision(Base):
    __tablename__ = "approval_decisions"
    __table_args__ = (UniqueConstraint("change_request_id", "approver_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    change_request_id: Mapped[str] = mapped_column(ForeignKey("change_requests.id"), index=True)
    approver_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(16))  # APPROVED | REJECTED
    reason: Mapped[str] = mapped_column(Text)
    decided_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    # Departments this decision covers (the approver's scope within the affected set).
    department_ids: Mapped[list] = mapped_column(JsonList, default=list)
    config_version_at_decision: Mapped[str] = mapped_column(String(20))

    change_request: Mapped[ChangeRequest] = relationship(back_populates="decisions")
    approver: Mapped[User] = relationship(lazy="joined")


class AppliedChange(Base):
    __tablename__ = "applied_changes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    change_request_id: Mapped[str] = mapped_column(ForeignKey("change_requests.id"), unique=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    applied_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    from_config_version: Mapped[str] = mapped_column(String(20))
    to_config_version: Mapped[str] = mapped_column(String(20))
    before: Mapped[dict] = mapped_column(JsonDict)
    after: Mapped[dict] = mapped_column(JsonDict)


class PredictionRecord(Base):
    """What the twin predicted for an applied change; compared with observed outcomes later."""

    __tablename__ = "prediction_records"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    change_request_id: Mapped[str] = mapped_column(ForeignKey("change_requests.id"), unique=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("simulation_runs.id"))
    strategy_key: Mapped[str] = mapped_column(String(8))
    effective_at: Mapped[datetime] = mapped_column(DateTime)
    horizon_hours: Mapped[float] = mapped_column()
    predicted: Mapped[dict] = mapped_column(JsonDict)
    assumption_notes: Mapped[list] = mapped_column(JsonList, default=list)


class AuditLog(Base):
    """Append-only. The ORM refuses updates and deletes (see listeners below)."""

    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(40), index=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    outcome: Mapped[str] = mapped_column(String(10))  # SUCCESS | DENIED | FAILURE
    department_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    correlation_id: Mapped[str] = mapped_column(String(64))
    before: Mapped[dict | None] = mapped_column(JsonDict, nullable=True)
    after: Mapped[dict | None] = mapped_column(JsonDict, nullable=True)
    details: Mapped[dict | None] = mapped_column(JsonDict, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)

    actor: Mapped[User | None] = relationship(lazy="joined")


class AuditLogImmutableError(RuntimeError):
    pass


@event.listens_for(AuditLog, "before_update")
def _no_audit_update(*_args) -> None:
    raise AuditLogImmutableError("Audit records are append-only.")


@event.listens_for(AuditLog, "before_delete")
def _no_audit_delete(*_args) -> None:
    raise AuditLogImmutableError("Audit records are append-only.")


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    scope: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    response: Mapped[dict] = mapped_column(JsonDict)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
