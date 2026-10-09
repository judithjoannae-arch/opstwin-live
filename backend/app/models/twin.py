"""Digital twin records. Kept separate from live operational tables."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.timeutil import utcnow
from app.database.session import Base
from app.models.common import JsonDict, JsonList, new_id


class TwinSnapshot(Base):
    __tablename__ = "twin_snapshots"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    config_version: Mapped[str] = mapped_column(String(20))
    # None = all departments; else the department ids the creator could see.
    scope: Mapped[list | None] = mapped_column(JsonList, nullable=True)
    payload: Mapped[dict] = mapped_column(JsonDict)
    ticket_count: Mapped[int] = mapped_column(Integer, default=0)
    resource_count: Mapped[int] = mapped_column(Integer, default=0)


class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("twin_snapshots.id"), index=True)
    parameters: Mapped[dict] = mapped_column(JsonDict)
    kind: Mapped[str] = mapped_column(String(16), default="custom")  # custom | stress
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    version: Mapped[int] = mapped_column(Integer, default=1)

    snapshot: Mapped[TwinSnapshot] = relationship(lazy="joined")


class StressTest(Base):
    __tablename__ = "stress_tests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("twin_snapshots.id"))
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    settings: Mapped[dict] = mapped_column(JsonDict)
    comparison: Mapped[dict] = mapped_column(JsonDict, default=dict)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("twin_snapshots.id"), index=True)
    scenario_id: Mapped[str | None] = mapped_column(ForeignKey("scenarios.id"), nullable=True)
    stress_test_id: Mapped[str | None] = mapped_column(ForeignKey("stress_tests.id"), nullable=True, index=True)
    strategy_key: Mapped[str | None] = mapped_column(String(8), nullable=True)
    label: Mapped[str] = mapped_column(String(160))
    parameters: Mapped[dict] = mapped_column(JsonDict)
    seed: Mapped[int] = mapped_column(Integer)
    replications: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="completed")
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[dict] = mapped_column(JsonDict, default=dict)
    metrics: Mapped[dict] = mapped_column(JsonDict, default=dict)

    snapshot: Mapped[TwinSnapshot] = relationship(lazy="joined")


class SimulatedEvent(Base):
    """Events from replication 0 of a run. Never mixed with operational_events."""

    __tablename__ = "simulated_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("simulation_runs.id", ondelete="CASCADE"), index=True)
    scenario_key: Mapped[str] = mapped_column(String(40))
    replication: Mapped[int] = mapped_column(Integer, default=0)
    sim_minute: Mapped[float] = mapped_column(Float)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    event_type: Mapped[str] = mapped_column(String(32), index=True)
    ticket_ref: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stage: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    resource_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    detail: Mapped[str | None] = mapped_column(String(200), nullable=True)


class SimulationMetric(Base):
    __tablename__ = "simulation_metrics"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("simulation_runs.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    unit: Mapped[str] = mapped_column(String(24))
    mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    std: Mapped[float | None] = mapped_column(Float, nullable=True)
    ci_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    ci_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    min: Mapped[float | None] = mapped_column(Float, nullable=True)
    max: Mapped[float | None] = mapped_column(Float, nullable=True)


class RecommendationEvaluation(Base):
    __tablename__ = "recommendation_evaluations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    stress_test_id: Mapped[str] = mapped_column(ForeignKey("stress_tests.id"), index=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    constraints: Mapped[dict] = mapped_column(JsonDict)
    outcome: Mapped[str] = mapped_column(Text)
    selected_recommendation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Recommendation(Base):
    __tablename__ = "recommendations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    evaluation_id: Mapped[str] = mapped_column(ForeignKey("recommendation_evaluations.id"), index=True)
    stress_test_id: Mapped[str] = mapped_column(ForeignKey("stress_tests.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("simulation_runs.id"), nullable=True)
    strategy_key: Mapped[str] = mapped_column(String(8))
    title: Mapped[str] = mapped_column(String(160))
    feasible: Mapped[bool] = mapped_column(Boolean)
    pareto_efficient: Mapped[bool] = mapped_column(Boolean, default=False)
    selected: Mapped[bool] = mapped_column(Boolean, default=False)
    is_no_action: Mapped[bool] = mapped_column(Boolean, default=False)
    source_config_version: Mapped[str] = mapped_column(String(20))
    card: Mapped[dict] = mapped_column(JsonDict)
    change_spec: Mapped[dict] = mapped_column(JsonDict, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
