"""Scenario parameters: the editable inputs of a simulation (spec §8)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Stage = Literal["intake", "triage", "support", "verification"]
Category = Literal["account", "network", "software", "hardware", "critical_infrastructure"]
Priority = Literal["P1", "P2", "P3", "P4"]
RoutingPolicy = Literal["fifo", "priority", "smart_triage"]


class Reallocation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource_id: str
    to_stage: Stage


class Unavailability(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource_id: str
    from_minute: float = Field(0, ge=0)
    to_minute: float | None = Field(None, gt=0)


class ScenarioParameters(BaseModel):
    """Hypothetical changes only. Nothing here touches real staff or tickets."""

    model_config = ConfigDict(extra="forbid")

    duration_hours: float = Field(8, ge=1, le=72)
    demand_multiplier: float = Field(1.0, ge=0, le=5)
    base_arrival_rate_per_hour: float | None = Field(None, ge=0, le=500, description="Override the observed average arrival rate")
    category_mix: dict[Category, float] | None = None
    removed_resource_ids: list[str] = Field(default_factory=list)
    resource_unavailability: list[Unavailability] = Field(default_factory=list)
    activate_reserve_ids: list[str] = Field(default_factory=list)
    reallocations: list[Reallocation] = Field(default_factory=list)
    extra_staff: dict[Stage, int] = Field(default_factory=dict, description="Hypothetical generalists, never real hires")
    service_time_multipliers: dict[Stage, float] = Field(default_factory=dict)
    routing_policy: RoutingPolicy | None = None
    skill_aware_routing: bool | None = None
    sla_resolution_minutes: dict[Priority, int] = Field(default_factory=dict)
    rework_rate: float | None = Field(None, ge=0, le=0.9)
    transfer_rate: float | None = Field(None, ge=0, le=0.9)
    respect_shifts: bool = True
    seed: int = Field(42, ge=0, le=2**31 - 1)
    replications: int = Field(10, ge=1, le=30)

    @field_validator("category_mix")
    @classmethod
    def _mix(cls, v):
        if v is None:
            return v
        if any(x < 0 for x in v.values()) or sum(v.values()) <= 0:
            raise ValueError("category_mix needs non-negative weights with a positive total")
        return v

    @field_validator("extra_staff")
    @classmethod
    def _extra(cls, v):
        if any(n < 0 or n > 20 for n in v.values()):
            raise ValueError("extra_staff must be between 0 and 20 per stage")
        return v

    @field_validator("service_time_multipliers")
    @classmethod
    def _mult(cls, v):
        if any(x <= 0 or x > 5 for x in v.values()):
            raise ValueError("service time multipliers must be in (0, 5]")
        return v

    @field_validator("sla_resolution_minutes")
    @classmethod
    def _sla(cls, v):
        if any(x < 1 or x > 60 * 24 * 30 for x in v.values()):
            raise ValueError("SLA minutes out of range")
        return v
