"""Digital twin snapshots (spec §4): a consistent, immutable read of the live
database plus model parameters, each labelled Observed / Derived / Assumed."""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.errors import bad_request
from app.core.timeutil import iso, local_offset, parse_iso, utcnow
from app.models import OperationalEvent, Resource, Ticket, TwinSnapshot
from app.models.common import CATEGORIES, PRIORITIES, STAGES
from app.services import config_service
from app.simulation.parameters import ScenarioParameters
from app.simulation.workflow import (
    SMART_TRIAGE_TIME_FACTOR,
    SMART_TRIAGE_TRANSFER_FACTOR,
    TRANSFER_PARTIAL_FRACTION,
    ResourceSpec,
    ServiceDist,
    TicketSpec,
    WorkflowModel,
    parse_hhmm,
)

# ---- explicit defaults, used (and labelled "assumed") when data is insufficient
DEFAULT_PROFILE = [0.4, 0.3, 0.3, 0.3, 0.3, 0.5, 1.0, 2.0, 5.0, 8.0, 9.0, 8.0, 6.0, 7.0, 8.0, 7.0, 5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.8, 0.5]
DEFAULT_CATEGORY_MIX = {"account": 0.25, "network": 0.30, "software": 0.20, "hardware": 0.15, "critical_infrastructure": 0.10}
DEFAULT_PRIORITY_MIX = {
    "account": {"P2": 0.15, "P3": 0.65, "P4": 0.20},
    "network": {"P1": 0.05, "P2": 0.30, "P3": 0.55, "P4": 0.10},
    "software": {"P2": 0.10, "P3": 0.40, "P4": 0.50},
    "hardware": {"P2": 0.15, "P3": 0.60, "P4": 0.25},
    "critical_infrastructure": {"P1": 0.70, "P2": 0.30},
}
DEFAULT_SERVICE = {
    "intake": {c: (4.0, 0.5) for c in CATEGORIES},
    "triage": {c: (8.0, 0.6) for c in CATEGORIES},
    "support": {"account": (18.0, 0.7), "network": (35.0, 0.8), "software": (30.0, 0.8), "hardware": (45.0, 0.8),
                "critical_infrastructure": (60.0, 0.9)},
    "verification": {c: (6.0, 0.5) for c in CATEGORIES},
}
DEFAULT_REWORK = 0.08
DEFAULT_TRANSFER = 0.15
DEFAULT_HOLD_MIN = 90.0
ESCALATION_FRACTION = 0.75
MIN_TICKETS_FOR_PROFILE = 60
MIN_DAYS_FOR_PROFILE = 1.5
MIN_SERVICE_SAMPLES = 8
LOOKBACK_DAYS = 14


def _assumption(key, label, value, unit, origin, n=None, note=None):
    return {"key": key, "label": label, "value": value, "unit": unit, "origin": origin, "sample_size": n, "note": note}


def _estimate_service_samples(db: Session, since: datetime) -> dict[str, dict[str, list[float]]]:
    """Service time = from the moment someone picked the ticket up in a stage to the moment it left that stage.
    Support uses start-of-work to resolution and skips tickets that went on hold in between."""
    samples: dict[str, dict[str, list[float]]] = {s: defaultdict(list) for s in STAGES}
    events = (
        db.query(OperationalEvent)
        .filter(OperationalEvent.ticket_id.isnot(None), OperationalEvent.occurred_at >= since)
        .order_by(OperationalEvent.ticket_id, OperationalEvent.occurred_at, OperationalEvent.id)
        .all()
    )
    by_ticket: dict[str, list[OperationalEvent]] = defaultdict(list)
    for e in events:
        by_ticket[e.ticket_id].append(e)
    categories = dict(db.query(Ticket.id, Ticket.category).filter(Ticket.id.in_(by_ticket.keys())).all()) if by_ticket else {}
    for tid, evs in by_ticket.items():
        cat = categories.get(tid)
        if cat is None:
            continue
        started: dict[str, datetime] = {}
        held = False
        for e in evs:
            if e.event_type == "ticket.assigned" and e.resource_id and e.stage in ("intake", "triage", "verification"):
                started[e.stage] = e.occurred_at
            elif e.event_type == "ticket.status_changed" and e.to_value == "In progress":
                started["support"] = e.occurred_at
                held = False
            elif e.event_type == "ticket.status_changed" and e.to_value == "On hold":
                held = True
            elif e.event_type in ("ticket.stage_changed", "ticket.status_changed"):
                leaving = None
                if e.event_type == "ticket.stage_changed":
                    leaving = next((s for s in STAGES if _label(s) == e.from_value), None)
                elif e.to_value == "Closed":
                    leaving = "verification"
                if leaving and leaving in started:
                    minutes = (e.occurred_at - started.pop(leaving)).total_seconds() / 60
                    if 0.2 <= minutes <= 24 * 60 and not (leaving == "support" and held):
                        samples[leaving][cat].append(minutes)
    return samples


def _label(stage: str) -> str:
    from app.services.tickets import STAGE_LABELS

    return STAGE_LABELS[stage]


def estimate_model(db: Session, now: datetime, offset_min: int) -> tuple[dict, list[dict], dict]:
    since = now - timedelta(days=LOOKBACK_DAYS)
    tickets = db.query(Ticket).filter(Ticket.created_at >= since).all()
    assumptions: list[dict] = []
    model: dict = {}

    # Demand profile by local hour of day.
    first = min((t.created_at for t in tickets), default=None)
    days = (now - first).total_seconds() / 86400 if first else 0.0
    if len(tickets) >= MIN_TICKETS_FOR_PROFILE and days >= MIN_DAYS_FOR_PROFILE:
        counts = Counter(int(((t.created_at.hour * 60 + t.created_at.minute + offset_min) % 1440) // 60) for t in tickets)
        occurrences = Counter()
        h = first.replace(minute=0, second=0)
        while h < now:
            occurrences[int(((h.hour * 60 + offset_min) % 1440) // 60)] += 1
            h += timedelta(hours=1)
        profile = [round(counts[i] / occurrences[i], 3) if occurrences[i] else 0.0 for i in range(24)]
        origin, note = "observed", f"Tickets created per local hour, averaged over {days:.1f} days"
    else:
        profile, origin = list(DEFAULT_PROFILE), "assumed"
        note = f"Only {len(tickets)} tickets over {days:.1f} days; using a campus business-hours default"
    model["arrival_profile"] = {"values": profile, "origin": origin, "sample_size": len(tickets), "note": note}
    assumptions.append(_assumption("arrival_rate", "Average demand", round(sum(profile) / 24, 2), "tickets/h", origin, len(tickets), note))

    # Category mix.
    cat_counts = Counter(t.category for t in tickets)
    if sum(cat_counts.values()) >= 30:
        total = sum(cat_counts.values())
        mix = {c: round(cat_counts[c] / total, 4) for c in CATEGORIES}
        origin = "observed"
    else:
        mix, origin = dict(DEFAULT_CATEGORY_MIX), "assumed"
    model["category_mix"] = {"values": mix, "origin": origin, "sample_size": sum(cat_counts.values())}
    assumptions.append(_assumption("category_mix", "Ticket category mix", mix, "share", origin, sum(cat_counts.values())))

    # Priority mix per category.
    pmix: dict[str, dict[str, float]] = {}
    origins = set()
    for c in CATEGORIES:
        pc = Counter(t.priority for t in tickets if t.category == c)
        if sum(pc.values()) >= 10:
            tot = sum(pc.values())
            pmix[c] = {p: round(pc[p] / tot, 4) for p in PRIORITIES if pc[p]}
            origins.add("observed")
        else:
            pmix[c] = dict(DEFAULT_PRIORITY_MIX[c])
            origins.add("assumed")
    origin = "observed" if origins == {"observed"} else ("assumed" if origins == {"assumed"} else "derived")
    model["priority_mix"] = {"values": pmix, "origin": origin}
    assumptions.append(_assumption("priority_mix", "Priority mix by category", pmix, "share", origin,
                                   note="Derived means some categories use defaults" if origin == "derived" else None))

    # Service times.
    samples = _estimate_service_samples(db, since)
    service: dict[str, dict[str, dict]] = {}
    for stage in STAGES:
        service[stage] = {}
        pooled = [x for c in CATEGORIES for x in samples[stage].get(c, [])]
        for c in CATEGORIES:
            xs = samples[stage].get(c, [])
            if len(xs) >= MIN_SERVICE_SAMPLES:
                mean, origin, n = statistics.fmean(xs), "observed", len(xs)
                cv = statistics.stdev(xs) / mean if len(xs) > 1 and mean > 0 else 0.5
            elif stage != "support" and len(pooled) >= MIN_SERVICE_SAMPLES:
                mean, origin, n = statistics.fmean(pooled), "derived", len(pooled)
                cv = statistics.stdev(pooled) / mean if mean > 0 else 0.5
            else:
                (mean, cv), origin, n = DEFAULT_SERVICE[stage][c], "assumed", len(xs)
            service[stage][c] = {"mean": round(mean, 2), "cv": round(min(2.0, max(0.2, cv)), 3), "n": n, "origin": origin}
            assumptions.append(_assumption(f"service.{stage}.{c}", f"Service time: {_label(stage)}, {c.replace('_', ' ')}",
                                           round(mean, 1), "min", origin, n,
                                           "Lognormal; CV " + str(service[stage][c]["cv"])))
    model["service_times"] = service

    # Rework rate.
    verified = db.query(OperationalEvent).filter(OperationalEvent.occurred_at >= since, (
        (OperationalEvent.event_type == "ticket.status_changed") & (OperationalEvent.to_value == "Closed"))).count()
    reworked = db.query(OperationalEvent).filter(OperationalEvent.occurred_at >= since,
                                                 OperationalEvent.event_type == "ticket.stage_changed",
                                                 OperationalEvent.from_value == _label("verification")).count()
    if verified + reworked >= 20:
        rework, origin = round(reworked / (verified + reworked), 4), "observed"
    else:
        rework, origin = DEFAULT_REWORK, "assumed"
    model["rework_rate"] = {"value": rework, "origin": origin, "sample_size": verified + reworked}
    assumptions.append(_assumption("rework_rate", "Rework rate after verification", rework, "share", origin, verified + reworked))

    model["transfer_rate"] = {"value": DEFAULT_TRANSFER, "origin": "assumed",
                              "note": "Misrouting isn't recorded by the live website yet"}
    assumptions.append(_assumption("transfer_rate", "Share of tickets misrouted at triage", DEFAULT_TRANSFER, "share", "assumed",
                                   note=f"A misrouted ticket costs {int(TRANSFER_PARTIAL_FRACTION * 100)} % of a service before transfer"))
    model["hold_mean_min"] = {"value": DEFAULT_HOLD_MIN, "origin": "assumed"}
    assumptions.append(_assumption("hold_mean_min", "Mean time on hold", DEFAULT_HOLD_MIN, "min", "assumed",
                                   note="Exponential; on-hold tickets return to the support queue"))
    model["escalation_fraction"] = {"value": ESCALATION_FRACTION, "origin": "assumed"}
    assumptions.append(_assumption("escalation", "Priority escalation point", ESCALATION_FRACTION, "share of SLA window",
                                   "assumed", note="Unfinished tickets move up one priority level once"))
    model["smart_triage"] = {"time_factor": SMART_TRIAGE_TIME_FACTOR, "transfer_factor": SMART_TRIAGE_TRANSFER_FACTOR, "origin": "assumed"}
    assumptions.append(_assumption("smart_triage", "Smart triage effect", {"triage_time_x": SMART_TRIAGE_TIME_FACTOR,
                                   "misrouting_x": SMART_TRIAGE_TRANSFER_FACTOR}, "factor", "assumed",
                                   note="Slower, more careful triage in exchange for fewer misrouted tickets"))
    coverage = {"first_ticket_at": iso(first), "days_covered": round(days, 2), "tickets_in_lookback": len(tickets),
                "service_samples": {s: sum(len(v) for v in samples[s].values()) for s in STAGES}}
    return model, assumptions, coverage


LIMITATIONS = [
    "The twin models the four-stage service desk only; requester behaviour, phone/walk-in demand and outages are outside it.",
    "Demand follows a Poisson process shaped by the observed hourly pattern; real demand can be burstier.",
    "Service times are lognormal fits to recorded pick-up-to-exit times, which include interruptions the website doesn't log.",
    "Misrouting (transfer) rates and smart-triage effects are assumptions, not measurements.",
    "Staff work one ticket at a time; parallel work and breaks are not modelled.",
    "Predictions describe the simulated window only and are not proof that a change caused later outcomes.",
]


def create_snapshot(db: Session, *, created_by: str | None, scope: list[str] | None) -> TwinSnapshot:
    """One read transaction: everything in the snapshot reflects the same database state."""
    now = utcnow()
    offset_min = int(local_offset().total_seconds() // 60)
    cfg = config_service.current(db)
    tickets = db.query(Ticket).filter(Ticket.status.in_(("open", "in_progress", "on_hold", "resolved"))).all()
    resources = db.query(Resource).order_by(Resource.stage, Resource.name).all()
    model, assumptions, coverage = estimate_model(db, now, offset_min)
    payload = {
        "created_at": iso(now),
        "config_version": cfg.label,
        "config": cfg.config,
        "local_utc_offset_min": offset_min,
        "sla_resolution_minutes": config_service.sla_minutes(db),
        "tickets": [
            {
                "id": t.id, "reference": t.reference, "category": t.category, "priority": t.priority, "stage": t.stage,
                "status": t.status, "created_at": iso(t.created_at), "sla_deadline": iso(t.sla_deadline),
                "stage_entered_at": iso(t.stage_entered_at), "service_started_at": iso(t.service_started_at),
                "assigned_resource_id": t.assigned_resource_id, "is_demo": t.is_demo,
            }
            for t in tickets
        ],
        "resources": [
            {
                "id": r.id, "name": r.name, "stage": r.stage, "skills": list(r.skills or []), "is_available": r.is_available,
                "shift_start": r.shift_start, "shift_end": r.shift_end, "is_reserve": r.is_reserve,
                "reserve_active": r.reserve_active, "is_demo": r.is_demo,
            }
            for r in resources
        ],
        "model": model,
        "assumptions": assumptions,
        "coverage": {**coverage, "active_tickets": len(tickets), "real_active_tickets": sum(1 for t in tickets if not t.is_demo),
                     "demo_active_tickets": sum(1 for t in tickets if t.is_demo)},
        "limitations": LIMITATIONS,
    }
    snap = TwinSnapshot(created_at=now, created_by=created_by, config_version=cfg.label, scope=scope, payload=payload,
                        ticket_count=len(tickets), resource_count=len(resources))
    db.add(snap)
    db.flush()
    return snap


def snapshot_resource_ids(snapshot: TwinSnapshot) -> dict[str, dict]:
    return {r["id"]: r for r in snapshot.payload["resources"]}


def build_model(snapshot: TwinSnapshot, params: ScenarioParameters) -> WorkflowModel:
    p = snapshot.payload
    start = parse_iso(p["created_at"])
    model = p["model"]
    res_by_id = snapshot_resource_ids(snapshot)
    for rid in [*params.removed_resource_ids, *params.activate_reserve_ids,
                *[r.resource_id for r in params.reallocations], *[u.resource_id for u in params.resource_unavailability]]:
        if rid not in res_by_id:
            raise bad_request(f"Resource {rid} isn't in this snapshot.", "unknown_resource")
    for rid in params.activate_reserve_ids:
        if not res_by_id[rid]["is_reserve"]:
            raise bad_request(f"{res_by_id[rid]['name']} isn't configured as reserve capacity.", "not_a_reserve")

    realloc = {r.resource_id: r.to_stage for r in params.reallocations}
    resources: list[ResourceSpec] = []
    for r in p["resources"]:
        reserve_on = r["reserve_active"] or r["id"] in params.activate_reserve_ids
        if not r["is_available"] or (r["is_reserve"] and not reserve_on):
            continue
        resources.append(ResourceSpec(
            id=r["id"], name=r["name"], stage=realloc.get(r["id"], r["stage"]), skills=frozenset(r["skills"]),
            shift_start=parse_hhmm(r["shift_start"]), shift_end=parse_hhmm(r["shift_end"]),
        ))
    for stage, n in params.extra_staff.items():
        for i in range(n):
            resources.append(ResourceSpec(id=f"HYP-{stage}-{i + 1}", name=f"Hypothetical {stage} staff {i + 1}", stage=stage,
                                          skills=frozenset(CATEGORIES), shift_start=0, shift_end=0, hypothetical=True))

    def rel(ts: str | None) -> float | None:
        return None if ts is None else (parse_iso(ts) - start).total_seconds() / 60

    sla = {**p["sla_resolution_minutes"], **params.sla_resolution_minutes}
    tickets = []
    for t in p["tickets"]:
        created = rel(t["created_at"])
        deadline = rel(t["sla_deadline"])
        if t["priority"] in params.sla_resolution_minutes:
            deadline = created + sla[t["priority"]]
        tickets.append(TicketSpec(
            id=t["id"], ref=t["reference"], category=t["category"], priority=t["priority"], stage=t["stage"],
            status="open" if t["status"] == "resolved" else t["status"], created_min=created, deadline_min=deadline,
            stage_enter_min=rel(t["stage_entered_at"]), service_start_min=rel(t["service_started_at"]),
            assigned_resource_id=t["assigned_resource_id"],
        ))

    profile = list(model["arrival_profile"]["values"])
    if params.base_arrival_rate_per_hour is not None:
        mean = sum(profile) / 24 or 1.0
        profile = [x * params.base_arrival_rate_per_hour / mean for x in profile]
    profile = [x * params.demand_multiplier for x in profile]
    routing = p["config"].get("routing", {})
    policy = params.routing_policy or routing.get("policy", "fifo")
    skill_aware = params.skill_aware_routing if params.skill_aware_routing is not None else (
        policy == "smart_triage" or bool(routing.get("skill_aware", False)))
    return WorkflowModel(
        start=start,
        local_offset_min=p["local_utc_offset_min"],
        horizon_min=params.duration_hours * 60,
        arrival_profile=profile,
        category_mix=dict(params.category_mix or model["category_mix"]["values"]),
        priority_mix=model["priority_mix"]["values"],
        sla_resolution=sla,
        service={s: {c: ServiceDist(v["mean"], v["cv"]) for c, v in cats.items()} for s, cats in model["service_times"].items()},
        service_multipliers=dict(params.service_time_multipliers),
        resources=resources,
        tickets=tickets,
        routing_policy=policy,
        skill_aware=skill_aware,
        transfer_rate=params.transfer_rate if params.transfer_rate is not None else model["transfer_rate"]["value"],
        rework_rate=params.rework_rate if params.rework_rate is not None else model["rework_rate"]["value"],
        hold_mean_min=model["hold_mean_min"]["value"],
        escalation_fraction=model["escalation_fraction"]["value"],
        removed=set(params.removed_resource_ids),
        unavailability=[(u.resource_id, u.from_minute, u.to_minute) for u in params.resource_unavailability],
        respect_shifts=params.respect_shifts,
    )


def snapshot_out(s: TwinSnapshot, visible_stages: list[str] | None = None, include_records: bool = True) -> dict:
    p = s.payload
    tickets = p["tickets"] if visible_stages is None else [t for t in p["tickets"] if t["stage"] in visible_stages]
    resources = p["resources"] if visible_stages is None else [r for r in p["resources"] if r["stage"] in visible_stages]
    out = {
        "id": s.id,
        "created_at": iso(s.created_at),
        "config_version": s.config_version,
        "scope": s.scope,
        "ticket_count": s.ticket_count,
        "resource_count": s.resource_count,
        "coverage": p["coverage"],
        "config": p["config"],
        "sla_resolution_minutes": p["sla_resolution_minutes"],
        "model": p["model"],
        "assumptions": p["assumptions"],
        "limitations": p["limitations"],
        "stage_counts": {
            st: {
                "active": sum(1 for t in p["tickets"] if t["stage"] == st),
                "staff_available": sum(1 for r in p["resources"] if r["stage"] == st and r["is_available"]
                                       and (not r["is_reserve"] or r["reserve_active"])),
            }
            for st in STAGES
        },
    }
    if include_records:
        out["tickets"] = tickets
        out["resources"] = resources
    return out
