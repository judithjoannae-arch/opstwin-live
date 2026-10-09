"""Ticket lifecycle on the live website. The backend is the authority on transitions."""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.errors import ApiError, bad_request, conflict, forbidden
from app.core.timeutil import iso, utcnow
from app.models import OperationalEvent, Resource, Ticket, TicketStatusHistory
from app.services import audit
from app.services.authz import Principal
from app.services.config_service import sla_minutes
from app.services.sequences import next_value

STAGE_LABELS = {"intake": "Request intake", "triage": "Triage", "support": "Technical support", "verification": "Verification and closure"}
STATUS_LABELS = {"open": "Open", "in_progress": "In progress", "on_hold": "On hold", "resolved": "Resolved", "closed": "Closed", "cancelled": "Cancelled"}
ACTIVE = ("open", "in_progress", "on_hold", "resolved")


# (stage, status) -> {(to_stage, to_status): requirements}
TRANSITIONS: dict[tuple[str, str], dict[tuple[str, str], dict]] = {
    ("intake", "open"): {("triage", "open"): {}},
    ("triage", "open"): {("support", "open"): {}, ("triage", "cancelled"): {"note": True}},
    ("support", "open"): {("support", "in_progress"): {"assignee": True}},
    ("support", "in_progress"): {
        ("verification", "resolved"): {"note": True, "assignee": True},
        ("support", "on_hold"): {"note": True},
    },
    ("support", "on_hold"): {("support", "in_progress"): {"assignee": True}},
    ("verification", "resolved"): {("verification", "closed"): {}, ("support", "open"): {"note": True}},
}


def reference(number: int) -> str:
    return f"TCK-{number:06d}"


def parse_reference(text: str) -> int | None:
    t = text.strip().upper()
    if t.startswith("TCK-"):
        t = t[4:]
    return int(t) if t.isdigit() else None


def sla_state(t: Ticket, now: datetime) -> str:
    if t.status in ("resolved", "closed"):
        ref = t.resolved_at or t.closed_at or now
        return "met" if ref <= t.sla_deadline else "missed"
    if t.status == "cancelled":
        return "met"
    if now > t.sla_deadline:
        return "breached"
    window = (t.sla_deadline - t.created_at).total_seconds()
    remaining = (t.sla_deadline - now).total_seconds()
    return "at_risk" if window > 0 and remaining < 0.25 * window else "on_track"


def is_overdue(t: Ticket, now: datetime) -> bool:
    return t.status in ("open", "in_progress", "on_hold") and now > t.sla_deadline


def ticket_out(t: Ticket, now: datetime | None = None) -> dict:
    now = now or utcnow()
    return {
        "id": t.id,
        "reference": t.reference,
        "title": t.title,
        "category": t.category,
        "priority": t.priority,
        "stage": t.stage,
        "status": t.status,
        "requester_name": t.requester_name,
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
        "sla_deadline": iso(t.sla_deadline),
        "sla_state": sla_state(t, now),
        "assigned_resource": {"id": t.assigned_resource.id, "name": t.assigned_resource.name} if t.assigned_resource else None,
        "is_demo": t.is_demo,
        "resolved_at": iso(t.resolved_at),
        "closed_at": iso(t.closed_at),
        "version": t.version,
    }


def ticket_detail_out(db: Session, t: Ticket) -> dict:
    events = (
        db.query(OperationalEvent).filter(OperationalEvent.ticket_id == t.id).order_by(OperationalEvent.id.asc()).all()
    )
    from app.models import User

    actors = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({e.actor_user_id for e in events if e.actor_user_id})).all()}
    return {
        **ticket_out(t),
        "description": t.description,
        "requester_email": t.requester_email,
        "history": [
            {
                "id": str(e.id),
                "event_type": e.event_type,
                "occurred_at": iso(e.occurred_at),
                "actor": {"id": e.actor_user_id, "full_name": actors.get(e.actor_user_id, "Unknown")} if e.actor_user_id else None,
                "from_value": e.from_value,
                "to_value": e.to_value,
                "note": e.note,
            }
            for e in events
        ],
    }


def add_event(db: Session, *, event_type: str, summary: str, ticket: Ticket | None = None, stage: str | None = None,
              resource_id: str | None = None, actor_id: str | None = None, from_value: str | None = None,
              to_value: str | None = None, note: str | None = None, at: datetime | None = None,
              is_demo: bool | None = None) -> OperationalEvent:
    e = OperationalEvent(
        occurred_at=at or utcnow(), event_type=event_type, ticket_id=ticket.id if ticket else None,
        stage=stage or (ticket.stage if ticket else None), resource_id=resource_id, actor_user_id=actor_id,
        from_value=from_value, to_value=to_value, note=note, summary=summary[:300],
        is_demo=is_demo if is_demo is not None else (ticket.is_demo if ticket else False),
    )
    db.add(e)
    return e


def create_ticket(db: Session, *, title: str, description: str, category: str, requester_name: str, requester_email: str,
                  source: str, actor_id: str | None, affects_many_users: bool = False, created_at: datetime | None = None,
                  is_demo: bool = False) -> Ticket:
    """Priority is always calculated (impact x urgency); nobody chooses it."""
    from app.ai.priority import assess

    now = created_at or utcnow()
    assessment = assess(title, description, category, affects_many_users)
    pri = assessment["priority"]
    t = Ticket(
        number=next_value(db, "ticket"), title=title, description=description, category=category, priority=pri,
        stage="intake", status="open", requester_name=requester_name, requester_email=requester_email, source=source,
        created_at=now, updated_at=now, stage_entered_at=now,
        sla_deadline=now + timedelta(minutes=sla_minutes(db)[pri]), is_demo=is_demo,
    )
    db.add(t)
    db.flush()
    _store_assessment(db, t, assessment, now)
    origin = "the request form" if source == "web_form" else "staff"
    add_event(db, event_type="ticket.created", ticket=t, actor_id=actor_id, at=now,
              summary=f"{CATEGORY_TEXT.get(category, category)} ticket created by {origin}")
    db.add(TicketStatusHistory(ticket_id=t.id, from_stage=None, to_stage="intake", from_status=None, to_status="open",
                               changed_at=now, changed_by=actor_id))
    return t


def _store_assessment(db: Session, t: Ticket, a: dict, now: datetime) -> None:
    from app.models import TicketAssessment

    row = db.get(TicketAssessment, t.id)
    if row is None:
        row = TicketAssessment(ticket_id=t.id)
        db.add(row)
    row.impact, row.urgency, row.priority = a["impact"], a["urgency"], a["priority"]
    row.affects_many_users, row.reasons, row.assessed_at = a["affects_many_users"], a["reasons"], now
    db.flush()  # visible to later lookups in the same transaction


def reassess_priority(db: Session, t: Ticket, actor_id: str | None, why: str) -> None:
    """Recalculate priority after the category changes (the matrix depends on it)."""
    from app.ai.priority import assess
    from app.models import TicketAssessment

    row = db.get(TicketAssessment, t.id)
    a = assess(t.title, t.description, t.category, bool(row and row.affects_many_users))
    now = utcnow()
    _store_assessment(db, t, a, now)
    if a["priority"] != t.priority:
        old = t.priority
        t.priority = a["priority"]
        t.sla_deadline = t.created_at + timedelta(minutes=sla_minutes(db)[t.priority])
        add_event(db, event_type="ticket.priority_changed", ticket=t, actor_id=actor_id, from_value=old, to_value=t.priority,
                  summary=f"Priority recalculated: {old} to {t.priority}",
                  note=f"Recalculated automatically {why}: impact {a['impact']}, urgency {a['urgency']}.")


CATEGORY_TEXT = {
    "account": "Account and password", "network": "Wi-Fi and network", "software": "Software",
    "hardware": "Hardware", "critical_infrastructure": "Critical infrastructure",
}


def _owns(principal: Principal, t: Ticket) -> bool:
    return bool(t.assigned_resource and t.assigned_resource.user_id == principal.id)


def can_update(principal: Principal, t: Ticket) -> bool:
    if principal.covers("tickets.update", t.stage):
        return True
    return principal.covers("tickets.update", t.stage, allow_assigned=True) and _owns(principal, t)


def apply_update(db: Session, principal: Principal, t: Ticket, *, version: int, stage: str | None, status: str | None,
                 priority: str | None, assign: bool, assigned_resource_id: str | None, note: str | None,
                 category: str | None = None) -> Ticket:
    if version != t.version:
        raise conflict("version_conflict", "Someone else updated this ticket. Reload it and try again.")
    now = utcnow()
    changed: list[str] = []
    note = (note or "").strip() or None
    before = {"stage": t.stage, "status": t.status, "priority": t.priority, "category": t.category,
              "assigned_resource_id": t.assigned_resource_id}

    if assign:
        if not principal.covers("tickets.assign", t.stage):
            raise forbidden("You can't assign tickets in this stage.")
        if t.status in ("closed", "cancelled"):
            raise bad_request("Finished tickets can't be reassigned.")
        new_res = None
        if assigned_resource_id:
            new_res = db.get(Resource, assigned_resource_id)
            if new_res is None or new_res.stage != t.stage:
                raise bad_request("Choose a staff member who works in this ticket's stage.", "invalid_assignee")
            if not new_res.is_available or (new_res.is_reserve and not new_res.reserve_active):
                raise bad_request(f"{new_res.name} isn't available right now.", "assignee_unavailable")
            if t.stage == "support" and t.category not in (new_res.skills or []):
                raise bad_request(f"{new_res.name} doesn't have the skills for this category.", "skill_mismatch")
        if (new_res.id if new_res else None) != t.assigned_resource_id:
            old_name = t.assigned_resource.name if t.assigned_resource else None
            t.assigned_resource_id = new_res.id if new_res else None
            t.assigned_resource = new_res
            if t.stage != "support":
                t.service_started_at = now if new_res else None
            add_event(db, event_type="ticket.assigned", ticket=t, actor_id=principal.id,
                      resource_id=new_res.id if new_res else None, from_value=old_name, to_value=new_res.name if new_res else "Unassigned",
                      summary=f"Assigned to {new_res.name}" if new_res else "Assignment removed")
            changed.append("assignment")

    if category is not None and category != t.category:
        if not principal.covers("tickets.update", t.stage):
            raise forbidden("You can't change the category of this ticket.")
        if t.stage not in ("intake", "triage") or t.status != "open":
            raise bad_request("The category can only be corrected during intake or triage.", "category_locked")
        old = t.category
        t.category = category
        add_event(db, event_type="ticket.category_changed", ticket=t, actor_id=principal.id, from_value=CATEGORY_TEXT.get(old),
                  to_value=CATEGORY_TEXT.get(category), summary=f"Category changed to {CATEGORY_TEXT.get(category)}")
        reassess_priority(db, t, principal.id, "after the category was corrected")
        changed.append("category")

    if priority is not None and priority != t.priority:
        # Consistency: the same situation always gets the same priority, so nobody sets it by hand.
        raise bad_request("Priority is set automatically from impact and urgency, so it can't be chosen by hand.",
                          "priority_automatic")

    if stage is not None or status is not None:
        to_stage, to_status = stage or t.stage, status or t.status
        if (to_stage, to_status) != (t.stage, t.status):
            if not can_update(principal, t):
                raise forbidden("You can't update this ticket.")
            allowed = TRANSITIONS.get((t.stage, t.status), {})
            req = allowed.get((to_stage, to_status))
            if req is None:
                raise conflict("invalid_transition",
                               f"A ticket that is {STATUS_LABELS[t.status].lower()} in {STAGE_LABELS[t.stage]} can't move to "
                               f"{STATUS_LABELS[to_status].lower()} in {STAGE_LABELS[to_stage]}.")
            if req.get("note") and (not note or len(note) < 5):
                raise bad_request("Add a note (at least 5 characters) for this step.", "note_required")
            if req.get("assignee") and t.assigned_resource_id is None:
                raise bad_request("Assign someone before this step.", "assignee_required")
            from_stage, from_status = t.stage, t.status
            if to_stage != from_stage:
                add_event(db, event_type="ticket.stage_changed", ticket=t, actor_id=principal.id,
                          from_value=STAGE_LABELS[from_stage], to_value=STAGE_LABELS[to_stage],
                          note=note if to_status == from_status else None,
                          summary=f"Moved from {STAGE_LABELS[from_stage]} to {STAGE_LABELS[to_stage]}")
                t.stage = to_stage
                t.stage_entered_at = now
                t.assigned_resource_id, t.assigned_resource = None, None
                t.service_started_at = None
            if to_status != from_status:
                add_event(db, event_type="ticket.status_changed", ticket=t, actor_id=principal.id, stage=to_stage,
                          from_value=STATUS_LABELS[from_status], to_value=STATUS_LABELS[to_status], note=note,
                          summary=f"Status changed from {STATUS_LABELS[from_status]} to {STATUS_LABELS[to_status]}")
                t.status = to_status
                if to_status == "in_progress" and t.service_started_at is None:
                    t.service_started_at = now
                if to_status == "resolved":
                    t.resolved_at = now
                if to_status == "closed":
                    t.closed_at = now
                if to_status == "cancelled":
                    t.closed_at = now
                if (from_stage, from_status) == ("verification", "resolved") and to_stage == "support":
                    t.rework_count += 1
                    t.resolved_at = None
            db.add(TicketStatusHistory(ticket_id=t.id, from_stage=from_stage, to_stage=t.stage, from_status=from_status,
                                       to_status=t.status, changed_at=now, changed_by=principal.id))
            changed.append("workflow")

    if not changed:
        if note:
            raise bad_request("Use the notes endpoint to add a note without other changes.")
        return t
    t.version += 1
    t.updated_at = now
    audit.record(db, actor_id=principal.id, action="ticket.updated", target_type="ticket", target_id=t.id,
                 department_id=before["stage"], before=before,
                 after={"stage": t.stage, "status": t.status, "priority": t.priority, "category": t.category,
                        "assigned_resource_id": t.assigned_resource_id},
                 details={"changed": changed, "reference": t.reference})
    return t
