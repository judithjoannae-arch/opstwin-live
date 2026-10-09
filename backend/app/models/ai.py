"""AI automation records. New tables only; nothing existing changes."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timeutil import utcnow
from app.database.session import Base
from app.models.common import JsonDict, JsonList, new_id


class AiSettings(Base):
    """Singleton row (id = 1). Both automations are off until someone turns them on."""

    __tablename__ = "ai_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    auto_intake: Mapped[bool] = mapped_column(Boolean, default=False)
    category_threshold: Mapped[float] = mapped_column(Float, default=0.75)
    priority_threshold: Mapped[float] = mapped_column(Float, default=0.6)
    monitor_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    monitor_interval_minutes: Mapped[int] = mapped_column(Integer, default=10)
    surge_threshold: Mapped[float] = mapped_column(Float, default=1.5)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class AiModelVersion(Base):
    __tablename__ = "ai_model_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trained_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    starter_examples: Mapped[int] = mapped_column(Integer)
    history_examples: Mapped[int] = mapped_column(Integer)
    category_cv_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    priority_cv_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    trigger: Mapped[str] = mapped_column(String(20))  # startup | manual | monitor


class AiPrediction(Base):
    __tablename__ = "ai_predictions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    model_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    submitted_category: Mapped[str] = mapped_column(String(32))
    predicted_category: Mapped[str] = mapped_column(String(32))
    category_confidence: Mapped[float] = mapped_column(Float)
    predicted_priority: Mapped[str] = mapped_column(String(2))
    priority_confidence: Mapped[float] = mapped_column(Float)
    evidence: Mapped[dict] = mapped_column(JsonDict, default=dict)
    action: Mapped[str] = mapped_column(String(24), default="suggested")  # suggested | auto_applied | left_for_human


class TicketAssessment(Base):
    """How a ticket's priority was set: impact x urgency, with the reasons. Nobody picks priority by hand."""

    __tablename__ = "ticket_assessments"
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True)
    impact: Mapped[str] = mapped_column(String(8))
    urgency: Mapped[str] = mapped_column(String(8))
    priority: Mapped[str] = mapped_column(String(2))
    affects_many_users: Mapped[bool] = mapped_column(Boolean, default=False)
    reasons: Mapped[list] = mapped_column(JsonList, default=list)
    assessed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class MonitorRun(Base):
    __tablename__ = "monitor_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    trigger: Mapped[str] = mapped_column(String(16))  # scheduled | manual
    outcome: Mapped[str] = mapped_column(String(24))  # healthy | risk_recommended | risk_no_safe_option | risk_resolves | skipped | error
    summary: Mapped[str] = mapped_column(Text)
    findings: Mapped[dict] = mapped_column(JsonDict, default=dict)
    snapshot_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stress_test_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evaluation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    change_request_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
