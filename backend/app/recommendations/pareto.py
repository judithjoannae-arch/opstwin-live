"""Pareto efficiency over the objectives the recommendation compares."""
from __future__ import annotations

# (metric, direction): +1 higher is better, -1 lower is better
OBJECTIVES = [
    ("throughput_per_hour", 1),
    ("mean_wait_min", -1),
    ("p95_wait_min", -1),
    ("ending_backlog", -1),
    ("sla_compliance_pct", 1),
]


def _score(metrics: dict, name: str, direction: int) -> float:
    v = metrics["scalars"][name]["mean"]
    if v is None:
        return float("-inf")
    return v * direction


def dominates(a: dict, b: dict) -> bool:
    better_or_equal = all(_score(a, m, d) >= _score(b, m, d) for m, d in OBJECTIVES)
    strictly = any(_score(a, m, d) > _score(b, m, d) for m, d in OBJECTIVES)
    return better_or_equal and strictly


def pareto_front(candidates: dict[str, dict]) -> set[str]:
    return {k for k, m in candidates.items() if not any(dominates(o, m) for j, o in candidates.items() if j != k)}
