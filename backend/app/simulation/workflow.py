"""The simulation model: stages, resources, existing work, demand and service times."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

STAGE_ORDER = ["intake", "triage", "support", "verification"]
NEXT_STAGE = {"intake": "triage", "triage": "support", "support": "verification", "verification": None}
PRIORITY_RANK = {"P1": 0, "P2": 1, "P3": 2, "P4": 3}
ESCALATE = {"P4": "P3", "P3": "P2", "P2": "P1"}
# Smart triage spends a little longer classifying to cut misrouting (an explicit cost).
SMART_TRIAGE_TIME_FACTOR = 1.15
SMART_TRIAGE_TRANSFER_FACTOR = 0.3
# A technician who discovers a misrouted ticket spends this share of the service time first.
TRANSFER_PARTIAL_FRACTION = 0.25


@dataclass(frozen=True)
class ServiceDist:
    mean: float  # minutes
    cv: float

    def sample(self, z: float, multiplier: float = 1.0) -> float:
        """Lognormal with the given mean and coefficient of variation, driven by a standard normal z."""
        sigma2 = math.log(1 + self.cv**2)
        mu = math.log(self.mean * multiplier) - sigma2 / 2
        return max(0.5, math.exp(mu + math.sqrt(sigma2) * z))


@dataclass
class ResourceSpec:
    id: str
    name: str
    stage: str
    skills: frozenset[str]
    shift_start: int  # minute of local day
    shift_end: int
    hypothetical: bool = False

    def on_shift(self, local_minute_of_day: float) -> bool:
        s, e = self.shift_start, self.shift_end
        if s == e:  # 24-hour / on-call
            return True
        m = local_minute_of_day % 1440
        return s <= m < e if s < e else (m >= s or m < e)


@dataclass
class TicketSpec:
    """Existing work at the snapshot. Times are minutes relative to the simulation start (negative = past)."""

    id: str
    ref: str
    category: str
    priority: str
    stage: str
    status: str
    created_min: float
    deadline_min: float
    stage_enter_min: float
    service_start_min: float | None
    assigned_resource_id: str | None


@dataclass
class WorkflowModel:
    start: datetime
    local_offset_min: int
    horizon_min: float
    arrival_profile: list[float]  # 24 hourly rates (tickets/hour) by local hour, demand multiplier applied
    category_mix: dict[str, float]
    priority_mix: dict[str, dict[str, float]]
    sla_resolution: dict[str, int]
    service: dict[str, dict[str, ServiceDist]]  # stage -> category -> distribution
    service_multipliers: dict[str, float]
    resources: list[ResourceSpec]
    tickets: list[TicketSpec]
    routing_policy: str = "fifo"
    skill_aware: bool = False
    transfer_rate: float = 0.15
    rework_rate: float = 0.08
    hold_mean_min: float = 90.0
    escalation_fraction: float = 0.75
    removed: set[str] = field(default_factory=set)
    unavailability: list[tuple[str, float, float | None]] = field(default_factory=list)
    respect_shifts: bool = True

    def local_minute_of_day(self, minute: float) -> float:
        base = self.start.hour * 60 + self.start.minute + self.start.second / 60 + self.local_offset_min
        return (base + minute) % 1440

    def rate_at(self, minute: float) -> float:
        return self.arrival_profile[int(self.local_minute_of_day(minute) // 60) % 24]

    def effective_transfer_rate(self) -> float:
        if self.routing_policy == "smart_triage":
            return self.transfer_rate * SMART_TRIAGE_TRANSFER_FACTOR
        return self.transfer_rate

    def service_dist(self, stage: str, category: str) -> ServiceDist:
        by_cat = self.service[stage]
        return by_cat.get(category) or next(iter(by_cat.values()))

    def service_multiplier(self, stage: str) -> float:
        m = self.service_multipliers.get(stage, 1.0)
        if stage == "triage" and self.routing_policy == "smart_triage":
            m *= SMART_TRIAGE_TIME_FACTOR
        return m


def parse_hhmm(value: str) -> int:
    h, m = value.split(":")
    return int(h) * 60 + int(m)
