"""Live operational data: staff, tickets, events, SLA policies, configuration versions."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.timeutil import utcnow
from app.database.session import Base
from app.models.common import JsonDict, JsonList, new_id


class Resource(Base):
    __tablename__ = "resources"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    stage: Mapped[str] = mapped_column(ForeignKey("departments.id"), index=True)
    skills: Mapped[list] = mapped_column(JsonList, default=list)
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)
    availability_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    shift_start: Mapped[str] = mapped_column(String(5), default="08:00")
    shift_end: Mapped[str] = mapped_column(String(5), default="16:00")
    is_reserve: Mapped[bool] = mapped_column(Boolean, default=False)
    # A reserve only works after an approved change activates it.
    reserve_active: Mapped[bool] = mapped_column(Boolean, default=False)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Ticket(Base):
    __tablename__ = "tickets"
    __table_args__ = (
        CheckConstraint("stage in ('intake','triage','support','verification')", name="ck_ticket_stage"),
        CheckConstraint("status in ('open','in_progress','on_hold','resolved','closed','cancelled')", name="ck_ticket_status"),
        CheckConstraint("priority in ('P1','P2','P3','P4')", name="ck_ticket_priority"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    number: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(32), index=True)
    priority: Mapped[str] = mapped_column(String(2), index=True)
    stage: Mapped[str] = mapped_column(ForeignKey("departments.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    requester_name: Mapped[str] = mapped_column(String(120))
    requester_email: Mapped[str] = mapped_column(String(254))
    source: Mapped[str] = mapped_column(String(16), default="staff")  # web_form | staff | seed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    service_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sla_deadline: Mapped[datetime] = mapped_column(DateTime, index=True)
    assigned_resource_id: Mapped[str | None] = mapped_column(ForeignKey("resources.id"), nullable=True, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    rework_count: Mapped[int] = mapped_column(Integer, default=0)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)

    assigned_resource: Mapped[Resource | None] = relationship(lazy="joined")

    @property
    def reference(self) -> str:
        return f"TCK-{self.number:06d}"


class TicketStatusHistory(Base):
    __tablename__ = "ticket_status_history"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    from_stage: Mapped[str | None] = mapped_column(String(16), nullable=True)
    to_stage: Mapped[str] = mapped_column(String(16))
    from_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    to_status: Mapped[str] = mapped_column(String(16))
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    changed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class OperationalEvent(Base):
    """Real events only. Simulated events live in simulated_events."""

    __tablename__ = "operational_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), nullable=True, index=True)
    stage: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    resource_id: Mapped[str | None] = mapped_column(ForeignKey("resources.id"), nullable=True)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    from_value: Mapped[str | None] = mapped_column(String(120), nullable=True)
    to_value: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str] = mapped_column(String(300))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    ticket: Mapped[Ticket | None] = relationship(lazy="joined")
    resource: Mapped[Resource | None] = relationship(lazy="joined")


class SlaPolicy(Base):
    __tablename__ = "sla_policies"
    priority: Mapped[str] = mapped_column(String(2), primary_key=True)
    response_minutes: Mapped[int] = mapped_column(Integer)
    resolution_minutes: Mapped[int] = mapped_column(Integer)


class ConfigVersion(Base):
    """Immutable history of the operational configuration (SLA, routing, staffing allocation)."""

    __tablename__ = "config_versions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    number: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    source: Mapped[str] = mapped_column(String(20))  # seed | manual | approved_change
    summary: Mapped[str] = mapped_column(String(300))
    change_request_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    config: Mapped[dict] = mapped_column(JsonDict)

    @property
    def label(self) -> str:
        return f"cfg-{self.number}"


class Sequence(Base):
    """Monotonic counters (ticket numbers)."""

    __tablename__ = "sequences"
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
