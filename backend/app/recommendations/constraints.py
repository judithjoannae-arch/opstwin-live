"""Hard safety constraints (spec §10). A strategy that breaks any of them is
infeasible, however much it improves other metrics."""
from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

NON_SUPPORT_STAGES = ("intake", "triage", "verification")


class Constraints(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_p1_sla_compliance_pct: float = Field(85.0, ge=0, le=100)
    min_sla_compliance_pct: float = Field(70.0, ge=0, le=100)
    max_ending_backlog: float = Field(30, ge=0, le=10_000, description="tickets still open at the end of the window")
    min_throughput_ratio: float = Field(0.9, ge=0, le=5, description="vs the normal baseline (A)")
    max_mean_wait_min: float = Field(240.0, gt=0, le=10_000)
    max_stage_wait_increase_min: float = Field(30.0, ge=0, le=10_000,
                                               description="extra mean wait allowed in any other stage vs the failure baseline (B)")
    min_feasible_share: float = Field(0.7, ge=0, le=1, description="share of replications that must satisfy every constraint")
    cost_per_reserve_hour: float | None = Field(None, ge=0)
    cost_per_transfer_hour: float | None = Field(None, ge=0)


@dataclass
class Check:
    key: str
    label: str
    kind: str  # min | max
    limit: float
    value: float | None
    passed: bool
    pass_share: float
    unit: str

    def message(self) -> str:
        if self.value is None:
            return f"{self.label}: no data"
        cmp = "at least" if self.kind == "min" else "at most"
        verdict = "meets" if self.passed else "fails"
        # Show enough decimals that a failing value never prints the same as its limit (1.78 vs 1.80, not 1.8 vs 1.8).
        digits = 1
        while digits < 4 and f"{self.value:.{digits}f}" == f"{self.limit:.{digits}f}" and self.value != self.limit:
            digits += 1
        return f"{self.label} {self.value:.{digits}f}{self.unit} {verdict} the limit ({cmp} {self.limit:.{digits}f}{self.unit})"

    def as_dict(self) -> dict:
        return {"key": self.key, "label": self.label, "kind": self.kind, "limit": round(self.limit, 2),
                "value": None if self.value is None else round(self.value, 2), "passed": self.passed,
                "pass_share": round(self.pass_share, 2), "unit": self.unit, "message": self.message()}


def _vals(m: dict, name: str) -> list[float | None]:
    return m["scalars"][name]["values"]


def _mean(m: dict, name: str) -> float | None:
    return m["scalars"][name]["mean"]


def _ok(kind: str, v: float | None, limit: float) -> bool:
    if v is None:
        return False
    return v >= limit if kind == "min" else v <= limit


def evaluate(strategy: dict, normal: dict, failure: dict, c: Constraints) -> list[Check]:
    """strategy/normal/failure are aggregated metrics dicts; replications are paired by index (common seeds)."""
    checks: list[Check] = []
    n = len(_vals(strategy, "throughput_per_hour"))

    def add(key, label, kind, limit_fn, value_fn, unit):
        limit = limit_fn(None)
        mean_val = value_fn(None)
        per = [value_fn(i) for i in range(n)]
        per_limits = [limit_fn(i) for i in range(n)]
        share = sum(_ok(kind, v, lim) for v, lim in zip(per, per_limits)) / n if n else 0.0
        checks.append(Check(key, label, kind, limit, mean_val, _ok(kind, mean_val, limit), share, unit))

    def pick(m, name):
        return lambda i: (_mean(m, name) if i is None else _vals(m, name)[i])

    p1 = pick(strategy, "p1_sla_compliance_pct")
    # No P1 tickets in the window can't violate the P1 constraint.
    add("min_p1_sla_compliance_pct", "Critical (P1) SLA compliance", "min", lambda i: c.min_p1_sla_compliance_pct,
        lambda i: 100.0 if p1(i) is None else p1(i), "%")
    add("min_sla_compliance_pct", "Overall SLA compliance", "min", lambda i: c.min_sla_compliance_pct,
        lambda i: (pick(strategy, "sla_compliance_pct")(i) if pick(strategy, "sla_compliance_pct")(i) is not None else 100.0), "%")
    add("max_ending_backlog", "Backlog at the end of the window", "max", lambda i: c.max_ending_backlog,
        pick(strategy, "ending_backlog"), " tickets")
    add("min_throughput", "Completed tickets per hour", "min",
        lambda i: c.min_throughput_ratio * (pick(normal, "throughput_per_hour")(i) or 0),
        pick(strategy, "throughput_per_hour"), "/h")
    add("max_mean_wait_min", "Mean waiting time", "max", lambda i: c.max_mean_wait_min, pick(strategy, "mean_wait_min"), " min")

    def stage_increase(i):
        worst = 0.0
        for s in NON_SUPPORT_STAGES:
            ref = pick(failure, f"stage_mean_wait_min.{s}")(i)
            val = pick(strategy, f"stage_mean_wait_min.{s}")(i)
            if ref is None or val is None:
                continue
            worst = max(worst, val - ref)
        return worst

    add("max_stage_wait_increase_min", "Extra waiting in another stage", "max",
        lambda i: c.max_stage_wait_increase_min, stage_increase, " min")
    return checks


def worst_stage_increase(strategy: dict, failure: dict) -> tuple[str | None, float, float]:
    """(stage, extra minutes, reference minutes) for the non-support stage whose waiting rises most."""
    worst, stage, ref_at = 0.0, None, 0.0
    for s in NON_SUPPORT_STAGES:
        ref = _mean(failure, f"stage_mean_wait_min.{s}")
        val = _mean(strategy, f"stage_mean_wait_min.{s}")
        if ref is None or val is None:
            continue
        if val - ref > worst:
            worst, stage, ref_at = val - ref, s, ref
    return stage, worst, ref_at
