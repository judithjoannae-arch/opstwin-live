"""Live website: public intake, operational state, tickets, staff, events, settings."""
from __future__ import annotations

from datetime import datetime, time
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.context import client_ip_var
from app.core.errors import ApiError, bad_request, conflict, forbidden, not_found
from app.core.ratelimit import limiter
from app.core.timeutil import iso, parse_iso, utcnow
from app.database.session import get_db
from app.models import ConfigVersion, OperationalEvent, Resource, SlaPolicy, Ticket, User
from app.models.common import STAGES
from app.ai import service as ai_service
from app.services import audit, config_service
from app.services.authz import Principal, require
from app.services.operations_state import compute_state, event_out
from app.services.tickets import (
    add_event,
    apply_update,
    can_update,
    create_ticket,
    parse_reference,
    sla_state,
    ticket_detail_out,
    ticket_out,
)

router = APIRouter(tags=["operations"])

Stage = Literal["intake", "triage", "support", "verification"]
Category = Literal["account", "network", "software", "hardware", "critical_infrastructure"]
Priority = Literal["P1", "P2", "P3", "P4"]
Status = Literal["open", "in_progress", "on_hold", "resolved", "closed", "cancelled"]


def _email(v: str) -> str:
    v = v.strip().lower()
    if "@" not in v or "." not in v.split("@")[-1] or len(v) > 254:
        raise ValueError("Enter a valid email address")
    return v


class PublicRequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requester_name: str = Field(min_length=2, max_length=120)
    requester_email: str
    category: Category
    title: str = Field(min_length=5, max_length=160)
    description: str = Field(min_length=10, max_length=5000)
    affects_many_users: bool = False

    @field_validator("requester_email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        return _email(v)


class TrackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reference: str = Field(min_length=1, max_length=20)
    email: str = Field(min_length=3, max_length=254)


# Plain-language progress for requesters. No staff names, notes or internal detail.
PUBLIC_PROGRESS = {
    ("intake", "open"): "Received. It's waiting to be reviewed.",
    ("triage", "open"): "The service desk is reviewing it and deciding who should handle it.",
    ("support", "open"): "It's in the queue for a technician.",
    ("support", "in_progress"): "A technician is working on it.",
    ("support", "on_hold"): "On hold while the technician waits for something, such as information or parts.",
    ("verification", "resolved"): "A fix has been made and is being checked before the request is closed.",
    ("verification", "closed"): "Done. The request is closed.",
    ("triage", "cancelled"): "This request was cancelled. Contact the service desk if it still needs attention.",
}
PUBLIC_STEPS = ["intake", "triage", "support", "verification", "closed"]


class TicketCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=5, max_length=160)
    description: str = Field(min_length=10, max_length=5000)
    category: Category
    # A fact about the problem, not a priority: priority is calculated from impact and urgency.
    affects_many_users: bool = False
    requester_name: str = Field(min_length=2, max_length=120)
    requester_email: str

    @field_validator("requester_email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        return _email(v)


class TicketUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    category: Category | None = None
    stage: Stage | None = None
    status: Status | None = None
    priority: Priority | None = None
    assigned_resource_id: str | None = None
    note: str | None = Field(None, max_length=5000)


class NoteIn(BaseModel):
    body: str = Field(min_length=3, max_length=5000)


HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class ResourceCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=120)
    stage: Stage
    skills: list[Category] = Field(min_length=1)
    shift_start: str = Field(pattern=HHMM)
    shift_end: str = Field(pattern=HHMM)
    is_reserve: bool = False


class ResourceUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    name: str | None = Field(None, min_length=2, max_length=120)
    stage: Stage | None = None
    skills: list[Category] | None = Field(None, min_length=1)
    shift_start: str | None = Field(None, pattern=HHMM)
    shift_end: str | None = Field(None, pattern=HHMM)
    is_reserve: bool | None = None
    is_available: bool | None = None
    availability_reason: str | None = Field(None, max_length=200)


class SlaPolicyIn(BaseModel):
    priority: Priority
    response_minutes: int = Field(ge=1, le=60 * 24 * 30)
    resolution_minutes: int = Field(ge=1, le=60 * 24 * 30)


class SlaUpdateIn(BaseModel):
    expected_config_version: str
    policies: list[SlaPolicyIn] = Field(min_length=4, max_length=4)
    reason: str = Field(min_length=10, max_length=1000)


def resource_out(r: Resource, active: int = 0) -> dict:
    return {"id": r.id, "name": r.name, "stage": r.stage, "skills": list(r.skills or []), "is_available": r.is_available,
            "availability_reason": r.availability_reason, "shift_start": r.shift_start, "shift_end": r.shift_end,
            "is_reserve": r.is_reserve, "reserve_active": r.reserve_active, "active_ticket_count": active,
            "is_demo": r.is_demo, "version": r.version}


def _active_counts(db: Session) -> dict[str, int]:
    from sqlalchemy import func

    rows = (db.query(Ticket.assigned_resource_id, func.count()).filter(
        Ticket.assigned_resource_id.isnot(None), Ticket.status.in_(("open", "in_progress", "on_hold", "resolved")))
        .group_by(Ticket.assigned_resource_id).all())
    return dict(rows)


# ------------------------------------------------------------------ public
@router.post("/public/requests", status_code=201)
def public_request(body: PublicRequestIn, db: Session = Depends(get_db)):
    retry = limiter.hit(f"public:{client_ip_var.get() or 'unknown'}", 10, 600)
    if retry:
        raise ApiError(429, "rate_limited", "Too many requests from this connection. Try again later.", {"Retry-After": str(retry)})
    t = create_ticket(db, title=body.title.strip(), description=body.description.strip(), category=body.category,
                      requester_name=body.requester_name.strip(), requester_email=body.requester_email, source="web_form",
                      actor_id=None, affects_many_users=body.affects_many_users)
    audit.record(db, actor_id=None, action="ticket.created", target_type="ticket", target_id=t.id, department_id="intake",
                 details={"source": "web_form", "reference": t.reference})
    db.commit()  # the ticket is saved before the AI runs, so the AI can never lose it
    ai_service.on_new_ticket(db, t)
    db.commit()
    return {"reference": t.reference, "created_at": iso(t.created_at), "sla_deadline": iso(t.sla_deadline)}


@router.post("/public/requests/lookup")
def track_request(body: TrackIn, db: Session = Depends(get_db)):
    """Requester status lookup. Needs the reference and the email used on the request,
    so guessing reference numbers reveals nothing; both mistakes give the same answer."""
    retry = limiter.hit(f"track:{client_ip_var.get() or 'unknown'}", 30, 600)
    if retry:
        raise ApiError(429, "rate_limited", "Too many lookups from this connection. Try again later.", {"Retry-After": str(retry)})
    num = parse_reference(body.reference)
    t = db.query(Ticket).filter(Ticket.number == num).one_or_none() if num is not None else None
    if t is None or t.requester_email.strip().lower() != body.email.strip().lower():
        raise ApiError(404, "not_found", "We couldn't find a request with that reference and email. Check both and try again.")
    step = "closed" if t.status in ("closed", "cancelled") else t.stage
    return {
        "reference": t.reference,
        "title": t.title,
        "category": t.category,
        "status": t.status,
        "progress": PUBLIC_PROGRESS.get((t.stage, t.status), "In progress with the service desk."),
        "step": PUBLIC_STEPS.index(step),
        "steps": len(PUBLIC_STEPS),
        "cancelled": t.status == "cancelled",
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
        "target_at": iso(t.sla_deadline),
        "closed_at": iso(t.closed_at),
    }


# ------------------------------------------------------------------ state & events
@router.get("/operations/state")
def operations_state(window_hours: int = Query(24, ge=1, le=24 * 31),
                     principal: Principal = Depends(require("dashboard.global.read", "tickets.read", "simulations.read", "resources.read",
                                                            any_of=True)),
                     db: Session = Depends(get_db)):
    if principal.is_global("dashboard.global.read"):
        stages = list(STAGES)
    else:
        stages = principal.visible_stages("tickets.read", "resources.read", "simulations.read")
    return compute_state(db, stages, window_hours)


def _day(value: str, end: bool) -> datetime:
    d = datetime.fromisoformat(value)
    return datetime.combine(d.date(), time.max if end else time.min) if len(value) <= 10 else d


@router.get("/events")
def list_events(event_type: str = "", stage: str = "", ticket: str = "", occurred_from: str = "", occurred_to: str = "",
                cursor: str = "", page_size: int = Query(50, ge=1, le=200),
                principal: Principal = Depends(require("tickets.read", "resources.read", "audit.read", any_of=True)),
                db: Session = Depends(get_db)):
    q = db.query(OperationalEvent)
    if not principal.is_global("audit.read"):
        visible = principal.visible_stages("tickets.read", "resources.read", "audit.read")
        q = q.filter(OperationalEvent.stage.in_(visible))
    if event_type:
        q = q.filter(OperationalEvent.event_type == event_type)
    if stage:
        q = q.filter(OperationalEvent.stage == stage)
    if ticket:
        num = parse_reference(ticket)
        q = q.join(Ticket, Ticket.id == OperationalEvent.ticket_id).filter(Ticket.number == (num or -1))
    try:
        if occurred_from:
            q = q.filter(OperationalEvent.occurred_at >= _day(occurred_from, False))
        if occurred_to:
            q = q.filter(OperationalEvent.occurred_at <= _day(occurred_to, True))
    except ValueError:
        raise bad_request("Dates must look like 2026-10-09.")
    if cursor:  # "<occurred_at ISO>|<id>": newest first, stable across equal timestamps
        try:
            ts_raw, id_raw = cursor.split("|")
            ts, last_id = parse_iso(ts_raw), int(id_raw)
        except ValueError:
            raise bad_request("Invalid cursor.")
        q = q.filter(or_(OperationalEvent.occurred_at < ts,
                         (OperationalEvent.occurred_at == ts) & (OperationalEvent.id < last_id)))
    rows = q.order_by(OperationalEvent.occurred_at.desc(), OperationalEvent.id.desc()).limit(page_size + 1).all()
    more = len(rows) > page_size
    rows = rows[:page_size]
    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({e.actor_user_id for e in rows if e.actor_user_id})).all()}
    nxt = f"{iso(rows[-1].occurred_at)}|{rows[-1].id}" if more else None
    return {"items": [event_out(e, names) for e in rows], "next_cursor": nxt}


# ------------------------------------------------------------------ tickets
def _ticket_in_scope(db: Session, principal: Principal, ticket_id: str) -> Ticket:
    t = db.get(Ticket, ticket_id)
    if t is None or not principal.covers("tickets.read", t.stage, allow_assigned=True):
        raise not_found("That ticket")  # no IDOR: identical response for missing and out-of-scope
    return t


@router.get("/tickets")
def list_tickets(q: str = "", stage: str = "", status: str = "", priority: str = "", category: str = "", sla_state_filter: str = Query("", alias="sla_state"),
                 assigned: str = "", sort: Literal["created_desc", "deadline_asc"] = "created_desc",
                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                 principal: Principal = Depends(require("tickets.read")), db: Session = Depends(get_db)):
    query = db.query(Ticket).filter(Ticket.stage.in_(principal.visible_stages("tickets.read")))
    if q.strip():
        term = q.strip()
        num = parse_reference(term)
        like = f"%{term}%"
        conds = [Ticket.title.ilike(like), Ticket.requester_name.ilike(like), Ticket.requester_email.ilike(like)]
        if num is not None:
            conds.append(Ticket.number == num)
        query = query.filter(or_(*conds))
    for col, raw in ((Ticket.stage, stage), (Ticket.status, status), (Ticket.priority, priority), (Ticket.category, category)):
        values = [v for v in raw.split(",") if v]
        if values:
            query = query.filter(col.in_(values))
    if assigned == "unassigned":
        query = query.filter(Ticket.assigned_resource_id.is_(None))
    elif assigned == "me":
        mine = [r.id for r in db.query(Resource).filter(Resource.user_id == principal.id).all()]
        query = query.filter(Ticket.assigned_resource_id.in_(mine or ["-"]))
    query = query.order_by(Ticket.sla_deadline.asc() if sort == "deadline_asc" else Ticket.created_at.desc())
    now = utcnow()
    if sla_state_filter:
        wanted = set(sla_state_filter.split(","))
        rows = [t for t in query.all() if sla_state(t, now) in wanted]
        total = len(rows)
        rows = rows[(page - 1) * page_size: page * page_size]
    else:
        total = query.count()
        rows = query.offset((page - 1) * page_size).limit(page_size).all()
    return {"items": [ticket_out(t, now) for t in rows], "total": total}


@router.post("/tickets", status_code=201)
def create(body: TicketCreateIn, principal: Principal = Depends(require("tickets.create")), db: Session = Depends(get_db)):
    t = create_ticket(db, title=body.title.strip(), description=body.description.strip(), category=body.category,
                      requester_name=body.requester_name.strip(), requester_email=body.requester_email,
                      source="staff", actor_id=principal.id, affects_many_users=body.affects_many_users)
    audit.record(db, actor_id=principal.id, action="ticket.created", target_type="ticket", target_id=t.id, department_id="intake",
                 details={"source": "staff", "reference": t.reference})
    db.commit()  # the ticket is saved before the AI runs, so the AI can never lose it
    ai_service.on_new_ticket(db, t)
    db.commit()
    return ticket_detail_out(db, t)


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: str, principal: Principal = Depends(require("tickets.read")), db: Session = Depends(get_db)):
    return ticket_detail_out(db, _ticket_in_scope(db, principal, ticket_id))


@router.patch("/tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdateIn,
                  principal: Principal = Depends(require("tickets.update", "tickets.assign", any_of=True)),
                  db: Session = Depends(get_db)):
    t = _ticket_in_scope(db, principal, ticket_id)
    fields = body.model_fields_set
    apply_update(db, principal, t, version=body.version, stage=body.stage, status=body.status, priority=body.priority,
                 assign="assigned_resource_id" in fields, assigned_resource_id=body.assigned_resource_id, note=body.note,
                 category=body.category)
    db.commit()
    return ticket_detail_out(db, t)


@router.post("/tickets/{ticket_id}/notes", status_code=201)
def add_note(ticket_id: str, body: NoteIn, principal: Principal = Depends(require("tickets.update")), db: Session = Depends(get_db)):
    t = _ticket_in_scope(db, principal, ticket_id)
    if not can_update(principal, t):
        raise forbidden("You can only add notes to tickets you're allowed to update.")
    add_event(db, event_type="ticket.note_added", ticket=t, actor_id=principal.id, note=body.body.strip(), summary="Note added")
    t.updated_at = utcnow()
    db.commit()
    return ticket_detail_out(db, t)


# ------------------------------------------------------------------ resources
@router.get("/resources")
def list_resources(stage: str = "", available: bool | None = None, skill: str = "",
                   principal: Principal = Depends(require("resources.read", "tickets.assign", any_of=True)),
                   db: Session = Depends(get_db)):
    visible = principal.visible_stages("resources.read", "tickets.assign")
    q = db.query(Resource).filter(Resource.stage.in_(visible))
    if stage:
        q = q.filter(Resource.stage == stage)
    if available is not None:
        q = q.filter(Resource.is_available.is_(available))
    rows = q.order_by(Resource.stage, Resource.name).all()
    if skill:
        rows = [r for r in rows if skill in (r.skills or [])]
    counts = _active_counts(db)
    return [resource_out(r, counts.get(r.id, 0)) for r in rows]


@router.post("/resources", status_code=201)
def create_resource(body: ResourceCreateIn, principal: Principal = Depends(require("resources.manage")), db: Session = Depends(get_db)):
    if not principal.covers("resources.manage", body.stage):
        raise forbidden("You can't add staff to that stage.")
    r = Resource(name=body.name.strip(), stage=body.stage, skills=sorted(set(body.skills)), shift_start=body.shift_start,
                 shift_end=body.shift_end, is_reserve=body.is_reserve)
    db.add(r)
    db.flush()
    _bump_staffing(db, principal, f"Added {r.name} to {r.stage}")
    add_event(db, event_type="resource.created", stage=r.stage, resource_id=r.id, actor_id=principal.id, summary=f"{r.name} added to {r.stage}")
    audit.record(db, actor_id=principal.id, action="resource.created", target_type="resource", target_id=r.id, department_id=r.stage,
                 after=resource_out(r))
    db.commit()
    return resource_out(r)


def _bump_staffing(db: Session, principal: Principal, summary: str) -> None:
    """Staffing allocation is configuration: changing it creates a new version (and makes older simulations stale)."""
    cfg = config_service.current(db)
    config_service.create_version(db, config=cfg.config, source="manual", summary=summary, created_by=principal.id)


@router.patch("/resources/{resource_id}")
def update_resource(resource_id: str, body: ResourceUpdateIn, principal: Principal = Depends(require("resources.manage")),
                    db: Session = Depends(get_db)):
    r = db.get(Resource, resource_id)
    if r is None or not principal.covers("resources.read", r.stage) and not principal.covers("resources.manage", r.stage):
        raise not_found("That staff member")
    if not principal.covers("resources.manage", r.stage) or (body.stage and not principal.covers("resources.manage", body.stage)):
        raise forbidden("You can't change staff in that stage.")
    if body.version != r.version:
        raise conflict("version_conflict", "This staff record changed since you loaded it.")
    before = resource_out(r)
    allocation_changed = False
    if body.name is not None:
        r.name = body.name.strip()
    if body.stage is not None and body.stage != r.stage:
        if db.query(Ticket).filter(Ticket.assigned_resource_id == r.id, Ticket.status.in_(("open", "in_progress", "resolved"))).count():
            raise conflict("has_active_work", f"{r.name} still has assigned tickets. Reassign them first.")
        r.stage = body.stage
        allocation_changed = True
    if body.skills is not None:
        r.skills = sorted(set(body.skills))
    if body.shift_start is not None:
        r.shift_start = body.shift_start
    if body.shift_end is not None:
        r.shift_end = body.shift_end
    if body.is_reserve is not None and body.is_reserve != r.is_reserve:
        r.is_reserve = body.is_reserve
        r.reserve_active = False
        allocation_changed = True
    if body.is_available is not None and body.is_available != r.is_available:
        r.is_available = body.is_available
        r.availability_reason = None if body.is_available else (body.availability_reason or "Unavailable")
        add_event(db, event_type="resource.availability_changed", stage=r.stage, resource_id=r.id, actor_id=principal.id,
                  from_value="Available" if body.is_available is False else "Unavailable",
                  to_value="Available" if body.is_available else "Unavailable",
                  summary=f"{r.name} marked {'available' if body.is_available else 'unavailable'}")
        audit.record(db, actor_id=principal.id, action="resource.availability_changed", target_type="resource", target_id=r.id,
                     department_id=r.stage, before={"is_available": not body.is_available}, after={"is_available": body.is_available})
    r.version += 1
    if allocation_changed:
        _bump_staffing(db, principal, f"Staffing changed for {r.name}")
    after = resource_out(r)
    changed = {k for k in after if before.get(k) != after.get(k)} - {"version", "is_available", "availability_reason"}
    if changed:
        add_event(db, event_type="resource.updated", stage=r.stage, resource_id=r.id, actor_id=principal.id,
                  summary=f"{r.name} updated: {', '.join(sorted(changed))}")
        audit.record(db, actor_id=principal.id, action="resource.updated", target_type="resource", target_id=r.id,
                     department_id=r.stage, before={k: before[k] for k in changed}, after={k: after[k] for k in changed})
    db.commit()
    return resource_out(r, _active_counts(db).get(r.id, 0))


# ------------------------------------------------------------------ settings
def _sla_out(db: Session) -> dict:
    cfg = config_service.current(db)
    versions = db.query(ConfigVersion).order_by(ConfigVersion.number.desc()).all()
    last_sla = next((v for v in versions if v.source == "seed" or "SLA" in v.summary), versions[-1])
    by = db.get(User, last_sla.created_by) if last_sla.created_by else None
    return {
        "config_version": cfg.label,
        "policies": [{"priority": p.priority, "response_minutes": p.response_minutes, "resolution_minutes": p.resolution_minutes}
                     for p in db.query(SlaPolicy).order_by(SlaPolicy.priority).all()],
        "updated_at": iso(last_sla.created_at),
        "updated_by": {"id": by.id, "full_name": by.full_name} if by else None,
    }


@router.get("/sla-policies")
def get_sla(principal: Principal = Depends(require("policies.manage", "audit.read", "tickets.read", any_of=True)),
            db: Session = Depends(get_db)):
    return _sla_out(db)


@router.put("/sla-policies")
def put_sla(body: SlaUpdateIn, principal: Principal = Depends(require("policies.manage", global_only=True)), db: Session = Depends(get_db)):
    cfg = config_service.current(db)
    if body.expected_config_version != cfg.label:
        raise conflict("stale", "The configuration changed while you were editing.")
    pols = {p.priority: p for p in body.policies}
    if set(pols) != {"P1", "P2", "P3", "P4"}:
        raise bad_request("Send exactly one policy for each of P1 to P4.")
    order = ["P1", "P2", "P3", "P4"]
    for i, pri in enumerate(order):
        if pols[pri].resolution_minutes < pols[pri].response_minutes:
            raise bad_request(f"{pri}: resolution can't be sooner than response.")
        if i and pols[pri].resolution_minutes < pols[order[i - 1]].resolution_minutes:
            raise bad_request(f"{pri} can't have a tighter resolution target than {order[i - 1]}.")
    before = {p.priority: {"response_minutes": p.response_minutes, "resolution_minutes": p.resolution_minutes}
              for p in db.query(SlaPolicy).all()}
    for pri, p in pols.items():
        row = db.get(SlaPolicy, pri)
        row.response_minutes, row.resolution_minutes = p.response_minutes, p.resolution_minutes
    after = {pri: {"response_minutes": p.response_minutes, "resolution_minutes": p.resolution_minutes} for pri, p in pols.items()}
    changed = [pri for pri in order if before.get(pri) != after[pri]]
    summary = "SLA targets changed for " + ", ".join(changed) if changed else "SLA targets saved (no change)"
    new_cv = config_service.create_version(db, config={**cfg.config, "sla": after}, source="manual", summary=summary,
                                           created_by=principal.id)
    add_event(db, event_type="sla.policy_changed", summary=summary, actor_id=principal.id, from_value=cfg.label, to_value=new_cv.label,
              note=body.reason, stage=None, is_demo=False)
    audit.record(db, actor_id=principal.id, action="sla.policy_changed", target_type="config", target_id=new_cv.label,
                 before=before, after=after, details={"reason": body.reason})
    db.commit()
    return _sla_out(db)


@router.get("/config/versions")
def config_versions(principal: Principal = Depends(require("policies.manage", "audit.read", "changes.request", "changes.approve",
                                                           "simulations.read", any_of=True)),
                    db: Session = Depends(get_db)):
    rows = db.query(ConfigVersion).order_by(ConfigVersion.number.desc()).limit(100).all()
    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({v.created_by for v in rows if v.created_by})).all()}
    return [{"version": v.label, "created_at": iso(v.created_at),
             "created_by": {"id": v.created_by, "full_name": names.get(v.created_by)} if v.created_by else None,
             "source": v.source, "summary": v.summary, "change_request_id": v.change_request_id, "config": v.config} for v in rows]

