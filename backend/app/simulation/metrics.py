"""Metrics per replication and their aggregation across replications (spec §10, §12)."""
from __future__ import annotations

import math
import statistics
from collections import defaultdict

from app.simulation.engine import ReplicationResult
from app.simulation.workflow import STAGE_ORDER

CATEGORIES = ["account", "network", "software", "hardware", "critical_infrastructure"]
PRIORITIES = ["P1", "P2", "P3", "P4"]

UNITS = {
    "throughput_per_hour": "tickets/h",
    "completed": "tickets",
    "arrivals": "tickets",
    "mean_wait_min": "min",
    "p95_wait_min": "min",
    "max_backlog": "tickets",
    "ending_backlog": "tickets",
    "initial_backlog": "tickets",
    "sla_compliance_pct": "%",
    "sla_violations": "tickets",
    "unfinished": "tickets",
    "recovery_time_min": "min",
    "p1_mean_wait_min": "min",
    "p1_max_wait_min": "min",
    "p1_sla_compliance_pct": "%",
    "transfers": "tickets",
    "reworks": "tickets",
    "escalations": "tickets",
    "mean_resolution_min": "min",
    "breached_before_start": "tickets",
}


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    xs = sorted(values)
    k = (len(xs) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] if lo == hi else xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def _pct(num: int, den: int) -> float | None:
    return None if den == 0 else round(100.0 * num / den, 2)


def _recovery(series: list[dict]) -> float | None:
    """Minutes until the backlog falls back to its starting level after its peak.
    0 if it never rose more than 10 % above the start; None if it hasn't recovered by the horizon."""
    if not series:
        return None
    start = series[0]["backlog"]
    peak_i = max(range(len(series)), key=lambda i: series[i]["backlog"])
    if series[peak_i]["backlog"] <= start * 1.1 + 1:
        return 0.0
    for point in series[peak_i:]:
        if point["backlog"] <= start:
            return point["minute"]
    return None


def replication_metrics(res: ReplicationResult) -> dict:
    hours = res.horizon / 60.0
    tickets = res.tickets
    closed = [t for t in tickets if t.closed is not None]
    waits = [t.wait_total for t in tickets]
    # SLA outcomes only count tickets whose deadline falls after the snapshot. A ticket that had
    # already breached before the simulation starts can't be saved by any decision taken now,
    # so it would penalise every strategy equally; it is reported separately instead.
    sla_tickets = [t for t in tickets if t.deadline > 0]
    sla_closed = [t for t in sla_tickets if t.closed is not None]
    met = [t for t in sla_closed if t.closed <= t.deadline]
    late_closed = [t for t in sla_closed if t.closed > t.deadline]
    unfinished_breached = [t for t in sla_tickets if t.closed is None and t.deadline <= res.horizon]
    p1 = [t for t in tickets if t.priority == "P1"]
    p1_sla = [t for t in p1 if t.deadline > 0]
    p1_closed = [t for t in p1_sla if t.closed is not None]
    p1_met = [t for t in p1_closed if t.closed <= t.deadline]
    p1_violated = len(p1_closed) - len(p1_met) + sum(1 for t in p1_sla if t.closed is None and t.deadline <= res.horizon)
    new_closed = [t for t in closed if not t.is_existing]

    scalars: dict[str, float | None] = {
        "arrivals": res.new_arrivals,
        "completed": len(closed),
        "throughput_per_hour": round(len(closed) / hours, 3),
        "mean_wait_min": round(statistics.fmean(waits), 2) if waits else None,
        "p95_wait_min": round(percentile(waits, 0.95), 2) if waits else None,
        "max_backlog": max((p["backlog"] for p in res.series), default=res.initial_backlog),
        "ending_backlog": len(res.unfinished),
        "initial_backlog": res.initial_backlog,
        "sla_compliance_pct": _pct(len(met), len(met) + len(late_closed) + len(unfinished_breached)),
        "sla_violations": len(late_closed) + len(unfinished_breached),
        "unfinished": len(res.unfinished),
        "recovery_time_min": _recovery(res.series),
        "p1_mean_wait_min": round(statistics.fmean([t.wait_total for t in p1]), 2) if p1 else None,
        "p1_max_wait_min": round(max(t.wait_total for t in p1), 2) if p1 else None,
        "p1_sla_compliance_pct": _pct(len(p1_met), len(p1_met) + p1_violated),
        "breached_before_start": sum(1 for t in tickets if t.deadline <= 0),
        "transfers": sum(1 for t in tickets if t.transferred),
        "reworks": sum(t.rework for t in tickets),
        "escalations": sum(1 for t in tickets if t.escalated),
        "mean_resolution_min": round(statistics.fmean([t.closed - t.created for t in new_closed]), 2) if new_closed else None,
    }

    for s in STAGE_ORDER:
        w = res.stage_waits[s]
        scalars[f"stage_mean_wait_min.{s}"] = round(statistics.fmean(w), 2) if w else None
        scalars[f"stage_p95_wait_min.{s}"] = round(percentile(w, 0.95), 2) if w else None
        cap = res.capable_minutes[s]
        # Capped: staff finishing a ticket after their shift ends can push busy time past scheduled time.
        scalars[f"utilization_pct.{s}"] = round(min(100.0, 100 * res.busy_minutes[s] / cap), 2) if cap > 0 else None
        scalars[f"stage_max_queue.{s}"] = max((p["queue"][s] for p in res.series), default=0)
        scalars[f"stage_ending_queue.{s}"] = res.series[-1]["queue"][s] if res.series else 0

    by_cat_met: dict[str, int] = defaultdict(int)
    by_cat_total: dict[str, int] = defaultdict(int)
    for t in sla_tickets:
        if t.closed is not None:
            by_cat_total[t.true_category] += 1
            by_cat_met[t.true_category] += int(t.closed <= t.deadline)
        elif t.deadline <= res.horizon:
            by_cat_total[t.true_category] += 1
    for c in CATEGORIES:
        scalars[f"sla_compliance_pct.category.{c}"] = _pct(by_cat_met[c], by_cat_total[c])

    return {
        "scalars": scalars,
        "series": res.series,
        "hourly": res.hourly,
        "unfinished": res.unfinished,
    }


def _agg(values: list[float | None]) -> dict:
    xs = [v for v in values if v is not None]
    n = len(xs)
    if n == 0:
        return {"mean": None, "std": None, "ci_low": None, "ci_high": None, "min": None, "max": None, "n": 0, "values": values}
    mean = statistics.fmean(xs)
    std = statistics.stdev(xs) if n > 1 else 0.0
    half = 1.96 * std / math.sqrt(n) if n > 1 else 0.0
    r = lambda v: round(v, 3)  # noqa: E731
    return {"mean": r(mean), "std": r(std), "ci_low": r(mean - half), "ci_high": r(mean + half),
            "min": r(min(xs)), "max": r(max(xs)), "n": n, "values": values}


def unit_for(name: str) -> str:
    base = name.split(".")[0]
    if base.startswith("utilization") or "compliance" in base:
        return "%"
    if "wait" in base:
        return "min"
    return UNITS.get(base, "tickets")


def aggregate(reps: list[dict]) -> dict:
    """Mean/std/95 % CI per scalar; time series averaged point by point."""
    names = list(reps[0]["scalars"].keys())
    scalars = {n: {**_agg([r["scalars"][n] for r in reps]), "unit": unit_for(n)} for n in names}

    n_points = min(len(r["series"]) for r in reps)
    series = []
    for i in range(n_points):
        pts = [r["series"][i] for r in reps]
        series.append({
            "minute": pts[0]["minute"],
            "backlog": round(statistics.fmean(p["backlog"] for p in pts), 2),
            "cum_arrivals": round(statistics.fmean(p["cum_arrivals"] for p in pts), 2),
            "cum_closed": round(statistics.fmean(p["cum_closed"] for p in pts), 2),
            "queue": {s: round(statistics.fmean(p["queue"][s] for p in pts), 2) for s in STAGE_ORDER},
            "in_service": {s: round(statistics.fmean(p["in_service"][s] for p in pts), 2) for s in STAGE_ORDER},
        })
    n_hours = min(len(r["hourly"]) for r in reps)
    hourly = [
        {
            "hour": h,
            "arrivals": round(statistics.fmean(r["hourly"][h]["arrivals"] for r in reps), 2),
            "closed": round(statistics.fmean(r["hourly"][h]["closed"] for r in reps), 2),
        }
        for h in range(n_hours)
    ]
    return {
        "replications": len(reps),
        "scalars": scalars,
        "series": series,
        "hourly": hourly,
        "unfinished_example": reps[0]["unfinished"],
        "notes": [
            "Confidence intervals use a normal approximation (mean ± 1.96·sd/√n) across replications.",
            "Waiting time counts queue time inside the simulated window; work still waiting at the horizon is included up to the horizon.",
            "SLA compliance counts tickets closed in the window plus unfinished tickets whose deadline has already passed.",
            "Tickets already past their deadline when the snapshot was taken are excluded from SLA compliance "
            "(no decision can change them) and reported as breached_before_start.",
            "Utilization is busy time over scheduled on-shift time, capped at 100% because work that runs past a shift end counts as busy.",
        ],
    }


HEADLINE = [
    "throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog",
    "sla_compliance_pct", "sla_violations", "unfinished", "recovery_time_min", "p1_sla_compliance_pct", "p1_mean_wait_min",
]


def summary(aggregated: dict) -> dict:
    return {k: aggregated["scalars"][k]["mean"] for k in HEADLINE if k in aggregated["scalars"]}
