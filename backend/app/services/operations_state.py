"""Observed operational state for the dashboard (spec §6). Never fabricates:
metrics without supporting records are returned as null."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.timeutil import iso, local_offset, utcnow
from app.models import OperationalEvent, Resource, Ticket, TwinSnapshot
from app.models.common import STAGES
from app.services import config_service
from app.services.tickets import is_overdue, sla_state
from app.simulation.workflow import parse_hhmm


def is_working(r: Resource) -> bool:
    return r.is_available and (not r.is_reserve or r.reserve_active)


def on_shift_now(r: Resource, now: datetime) -> bool:
    """Shift times are local wall-clock times."""
    local = now + local_offset()
    minute = local.hour * 60 + local.minute
    s, e = parse_hhmm(r.shift_start), parse_hhmm(r.shift_end)
    if s == e:
        return True
    return s <= minute < e if s < e else (minute >= s or minute < e)


def in_service(t: Ticket) -> bool:
    if t.status == "in_progress":
        return True
    return t.stage != "support" and t.assigned_resource_id is not None and t.status in ("open", "resolved")


def event_out(e: OperationalEvent, actor_names: dict[str, str]) -> dict:
    return {
        "id": str(e.id),
        "occurred_at": iso(e.occurred_at),
        "event_type": e.event_type,
        "ticket_id": e.ticket_id,
        "ticket_reference": e.ticket.reference if e.ticket else None,
        "stage": e.stage,
        "resource_id": e.resource_id,
        "resource_name": e.resource.name if e.resource else None,
        "actor": {"id": e.actor_user_id, "full_name": actor_names.get(e.actor_user_id, "Unknown")} if e.actor_user_id else None,
        "summary": e.summary,
        "is_demo": e.is_demo,
    }


def _bottleneck(queue: int, available: int, breached: int, at_risk: int) -> tuple[str, str | None]:
    if queue > 0 and available == 0:
        return "bottleneck", f"{queue} waiting and no staff available"
    per = queue / available if available else 0
    if per >= 4 or breached >= 3:
        return "bottleneck", f"{queue} waiting with {available} staff available" + (f", {breached} past SLA" if breached else "")
    if per >= 2 or at_risk >= 2 or breached > 0:
        return "watch", f"{queue} waiting with {available} staff available"
    return "none", None


def compute_state(db: Session, stages: list[str], window_hours: int) -> dict:
    now = utcnow()
    since = now - timedelta(hours=window_hours)
    tickets = db.query(Ticket).filter(Ticket.stage.in_(stages)).all()
    resources = db.query(Resource).filter(Resource.stage.in_(stages)).all()
    active = [t for t in tickets if t.status in ("open", "in_progress", "on_hold", "resolved")]

    stage_rows = []
    exits = defaultdict(int)
    for stage, n in (
        db.query(OperationalEvent.from_value, func.count())
        .filter(OperationalEvent.event_type == "ticket.stage_changed", OperationalEvent.occurred_at >= since)
        .group_by(OperationalEvent.from_value)
        .all()
    ):
        exits[stage] += n
    closes = (
        db.query(func.count()).select_from(Ticket)
        .filter(Ticket.closed_at >= since, Ticket.status == "closed", Ticket.stage.in_(stages)).scalar()
    )
    any_events_in_window = db.query(OperationalEvent.id).filter(OperationalEvent.occurred_at >= since).first() is not None
    from app.services.tickets import STAGE_LABELS

    for stage in stages:
        st_active = [t for t in active if t.stage == stage]
        on_hold = sum(1 for t in st_active if t.status == "on_hold")
        serving = sum(1 for t in st_active if in_service(t))
        queue = len(st_active) - on_hold - serving
        st_res = [r for r in resources if r.stage == stage and (not r.is_reserve or r.reserve_active)]
        available = sum(1 for r in st_res if is_working(r) and on_shift_now(r, now))
        waits = [(now - t.stage_entered_at).total_seconds() / 60 for t in st_active if t.status != "on_hold" and not in_service(t)]
        at_risk = sum(1 for t in st_active if sla_state(t, now) == "at_risk")
        breached = sum(1 for t in st_active if is_overdue(t, now))
        completed_n = closes if stage == "verification" else exits.get(STAGE_LABELS[stage], 0)
        level, reason = _bottleneck(queue, available, breached, at_risk)
        stage_rows.append({
            "stage": stage,
            "queue": queue,
            "in_service": serving,
            "on_hold": on_hold,
            "available_resources": available,
            "total_resources": len(st_res),
            "completed_per_hour": round(completed_n / window_hours, 2) if any_events_in_window else None,
            # Mean time the tickets waiting right now have been waiting in this stage.
            "avg_wait_minutes": round(sum(waits) / len(waits), 1) if waits else (0.0 if st_active or st_res else None),
            "sla_at_risk": at_risk,
            "sla_breached": breached,
            # Instantaneous: share of available staff currently serving a ticket.
            "utilization_pct": round(100 * min(serving, available) / available, 1) if available else None,
            "bottleneck": level,
            "bottleneck_reason": reason,
        })

    # Hourly throughput series (observed).
    buckets: dict[datetime, dict[str, int]] = {}
    start_hour = since.replace(minute=0, second=0)
    h = start_hour
    while h <= now:
        buckets[h] = {"created": 0, "completed": 0}
        h += timedelta(hours=1)
    for t in tickets:
        if t.created_at >= start_hour:
            buckets.setdefault(t.created_at.replace(minute=0, second=0), {"created": 0, "completed": 0})["created"] += 1
        if t.closed_at and t.status == "closed" and t.closed_at >= start_hour:
            buckets.setdefault(t.closed_at.replace(minute=0, second=0), {"created": 0, "completed": 0})["completed"] += 1
    series = [{"hour": iso(k), **v} for k, v in sorted(buckets.items())]
    completed_window = sum(1 for t in tickets if t.status == "closed" and t.closed_at and t.closed_at >= since)

    finished = [t for t in tickets if t.status in ("resolved", "closed") and (t.resolved_at or t.closed_at) and (t.resolved_at or t.closed_at) >= since]
    breached_open = [t for t in active if is_overdue(t, now)]
    evaluated = len(finished) + len(breached_open)
    met = sum(1 for t in finished if sla_state(t, now) == "met")

    unresolved = [t for t in active if t.status in ("open", "in_progress", "on_hold")]
    oldest = min(unresolved, key=lambda t: t.created_at) if unresolved else None
    first_ticket = db.query(func.min(Ticket.created_at)).scalar()
    last_event = db.query(func.max(OperationalEvent.occurred_at)).scalar()
    real = sum(1 for t in tickets if not t.is_demo)
    snapshot = db.query(TwinSnapshot).order_by(TwinSnapshot.created_at.desc()).first()
    recent = (
        db.query(OperationalEvent)
        .filter((OperationalEvent.stage.in_(stages)) | (OperationalEvent.stage.is_(None)))
        .order_by(OperationalEvent.occurred_at.desc(), OperationalEvent.id.desc()).limit(8).all()
    )
    from app.models import User

    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({e.actor_user_id for e in recent if e.actor_user_id})).all()}
    working = [r for r in resources if not r.is_reserve or r.reserve_active]
    return {
        "generated_at": iso(now),
        "config_version": config_service.current_label(db),
        "latest_snapshot": (
            {"id": snapshot.id, "created_at": iso(snapshot.created_at), "config_version": snapshot.config_version} if snapshot else None
        ),
        "data_coverage": {
            "first_ticket_at": iso(first_ticket),
            "last_event_at": iso(last_event),
            "real_ticket_count": real,
            "demo_ticket_count": len(tickets) - real,
        },
        "totals": {
            "submitted": len(tickets),
            "open": sum(1 for t in tickets if t.status == "open"),
            "in_progress": sum(1 for t in tickets if t.status == "in_progress"),
            "on_hold": sum(1 for t in tickets if t.status == "on_hold"),
            "resolved": sum(1 for t in tickets if t.status == "resolved"),
            "closed": sum(1 for t in tickets if t.status == "closed"),
            "overdue": len(breached_open),
        },
        "stages": stage_rows,
        "staff": {
            # On shift now and not marked unavailable.
            "available": sum(1 for r in working if r.is_available and on_shift_now(r, now)),
            "unavailable": sum(1 for r in working if not r.is_available),
            "off_shift": sum(1 for r in working if r.is_available and not on_shift_now(r, now)),
            "total": len(working),
        },
        "throughput": {
            "window_hours": window_hours,
            "completed": completed_window,
            "per_hour": round(completed_window / window_hours, 2) if any_events_in_window else None,
            "series": series,
        },
        "sla": {"compliance_pct": round(100 * met / evaluated, 1) if evaluated else None, "evaluated": evaluated, "breached": evaluated - met},
        "oldest_unresolved": (
            {"id": oldest.id, "reference": oldest.reference, "created_at": iso(oldest.created_at), "stage": oldest.stage} if oldest else None
        ),
        "recent_events": [event_out(e, names) for e in recent],
    }

_ = STAGES
