"""Approval workflow for operational changes (spec §4, §22.G):
recommendation → change request → approve/reject → apply (transaction, version-checked, idempotent)."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ApiError, conflict, forbidden
from app.core.timeutil import iso, utcnow
from app.models import (
    AppliedChange,
    ApprovalDecision,
    ChangeRequest,
    IdempotencyRecord,
    PredictionRecord,
    Recommendation,
    Resource,
    SimulationRun,
    User,
)
from app.services import audit, config_service
from app.services.authz import Principal, resolve_grants
from app.services.tickets import add_event

STAGE_NAMES = {"intake": "Request intake", "triage": "Triage", "support": "Technical support", "verification": "Verification and closure"}
OPEN_STATES = ("PENDING", "APPROVED")


def refresh_status(db: Session, cr: ChangeRequest) -> None:
    if cr.status not in OPEN_STATES:
        return
    if cr.expires_at and utcnow() > cr.expires_at:
        cr.status = "EXPIRED"
        audit.record(db, actor_id=None, action="change.expired", target_type="change_request", target_id=cr.id)
    elif config_service.current_label(db) != cr.source_config_version:
        cr.status = "STALE"
        audit.record(db, actor_id=None, action="change.stale", target_type="change_request", target_id=cr.id,
                     details={"source": cr.source_config_version, "current": config_service.current_label(db)})


def create_request(db: Session, principal: Principal, rec: Recommendation, reason: str) -> ChangeRequest:
    if rec.is_no_action or not rec.feasible:
        raise conflict("not_feasible", "Only feasible recommendations can become change requests.")
    if config_service.current_label(db) != rec.source_config_version:
        raise conflict("stale", "The live configuration changed after this simulation. Run a new stress test.")
    depts = [d["id"] for d in rec.card["affected_departments"]]
    if not principal.covers_all("changes.request", depts):
        raise forbidden("You can't request changes for every department this change affects.")
    existing = db.query(ChangeRequest).filter(ChangeRequest.recommendation_id == rec.id, ChangeRequest.status.in_(OPEN_STATES)).first()
    if existing:
        raise conflict("duplicate", "There is already an open change request for this recommendation.")
    cr = ChangeRequest(
        title=f"Apply strategy {rec.strategy_key}: {rec.title}"[:160], status="PENDING", recommendation_id=rec.id,
        source_simulation_id=rec.run_id, source_config_version=rec.source_config_version, requested_by=principal.id,
        reason=reason, expected_benefits=list(rec.card.get("benefits", [])), risks=list(rec.card.get("drawbacks", [])),
        config_diff=list(rec.card.get("config_diff", [])), change_spec=dict(rec.change_spec), affected_departments=depts,
        requires_separation_of_duties=True, expires_at=utcnow() + timedelta(hours=settings.change_request_ttl_hours),
    )
    db.add(cr)
    db.flush()
    audit.record(db, actor_id=principal.id, action="change.requested", target_type="change_request", target_id=cr.id,
                 department_id=depts[0] if len(depts) == 1 else None,
                 details={"recommendation_id": rec.id, "departments": depts, "diff": cr.config_diff})
    return cr


def _approved_departments(cr: ChangeRequest) -> set[str]:
    return {d for dec in cr.decisions if dec.decision == "APPROVED" for d in dec.department_ids}


def decide(db: Session, principal: Principal, cr: ChangeRequest, decision: str, reason: str) -> ChangeRequest:
    refresh_status(db, cr)
    if cr.status == "STALE":
        raise conflict("stale", "The live configuration changed after this request was made. It can't be approved.")
    if cr.status != "PENDING":
        raise conflict("not_pending", f"This request is {cr.status.lower()} and can't be decided.")
    covered = [d for d in cr.affected_departments if principal.covers("changes.approve", d)]
    if not covered:
        raise forbidden("You can't approve changes for the departments this request affects.")
    if cr.requires_separation_of_duties and cr.requested_by == principal.id:
        audit.record_standalone(actor_id=principal.id, action="change.self_approval_blocked", target_type="change_request",
                                target_id=cr.id, outcome="DENIED")
        raise ApiError(403, "separation_of_duties", "You submitted this request, so a different approver has to decide on it.")
    if any(d.approver_id == principal.id for d in cr.decisions):
        raise conflict("already_decided", "You've already recorded a decision on this request.")
    dec = ApprovalDecision(change_request_id=cr.id, approver_id=principal.id, decision=decision, reason=reason,
                           department_ids=covered, config_version_at_decision=config_service.current_label(db))
    db.add(dec)
    cr.decisions.append(dec)
    if decision == "REJECTED":
        cr.status = "REJECTED"
    elif _approved_departments(cr) >= set(cr.affected_departments):
        cr.status = "APPROVED"
    cr.version += 1
    audit.record(db, actor_id=principal.id, action=f"change.{decision.lower()}", target_type="change_request", target_id=cr.id,
                 details={"departments": covered, "reason": reason, "status_after": cr.status})
    return cr


def _still_can_approve(approver: User | None, departments: list[str]) -> bool:
    if approver is None or not approver.is_active:
        return False
    g = resolve_grants(approver).get("changes.approve")
    return g is not None and (g.is_global or all(d in g.departments for d in departments))


def _validate_spec(db: Session, cr: ChangeRequest) -> list[str]:
    problems = []
    for r in cr.change_spec.get("reallocations", []):
        res = db.get(Resource, r["resource_id"])
        if res is None or res.stage != r["from_stage"] or not res.is_available:
            problems.append(f"{res.name if res else 'A staff member'} is no longer available in {STAGE_NAMES.get(r['from_stage'])}")
    for rid in cr.change_spec.get("activate_reserves", []):
        res = db.get(Resource, rid)
        if res is None or not res.is_reserve or res.reserve_active or not res.is_available:
            problems.append(f"Reserve {res.name if res else rid} can no longer be activated")
    return problems


def apply(db: Session, principal: Principal, cr: ChangeRequest, expected_config_version: str, idempotency_key: str) -> dict:
    if not idempotency_key or len(idempotency_key) > 80:
        raise ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (up to 80 characters).")
    prior = db.get(IdempotencyRecord, idempotency_key)
    if prior is not None:
        if prior.scope != f"apply:{cr.id}":
            raise conflict("idempotency_key_reused", "This idempotency key was already used for a different request.")
        return prior.response  # same key, same result: nothing applied twice

    if not principal.covers_all("changes.apply", cr.affected_departments):
        raise forbidden("You can't apply changes for every department this request affects.")
    refresh_status(db, cr)
    if cr.status == "APPLIED":
        raise conflict("already_applied", "This change was already applied.")
    if cr.status in ("STALE", "EXPIRED", "REJECTED"):
        raise conflict("stale" if cr.status == "STALE" else cr.status.lower(), f"This request is {cr.status.lower()} and can't be applied.")
    if cr.status != "APPROVED":
        raise conflict("not_approved", "This request still needs approval.")
    current = config_service.current(db)
    if expected_config_version != cr.source_config_version or current.label != cr.source_config_version:
        cr.status = "STALE"
        audit.record(db, actor_id=principal.id, action="change.apply_rejected_stale", target_type="change_request",
                     target_id=cr.id, outcome="DENIED", details={"expected": expected_config_version, "current": current.label})
        db.commit()
        raise conflict("stale", "The live configuration changed after this simulation. Nothing was applied.")
    for dec in cr.decisions:
        approver = db.get(User, dec.approver_id)
        if dec.decision == "APPROVED" and not _still_can_approve(approver, dec.department_ids):
            raise conflict("approval_invalid", "An approver no longer holds approval rights. Request a new approval.")
    problems = _validate_spec(db, cr)
    if problems:
        cr.status = "STALE"
        db.commit()
        raise conflict("stale", "; ".join(problems) + ". Nothing was applied.")

    now = utcnow()
    # Transaction-safe state transition: only one caller can move APPROVED -> APPLIED.
    result = db.execute(
        update(ChangeRequest)
        .where(ChangeRequest.id == cr.id, ChangeRequest.status == "APPROVED")
        .values(status="APPLIED", applied_at=now, applied_by=principal.id, idempotency_key=idempotency_key,
                version=ChangeRequest.version + 1)
    )
    if result.rowcount != 1:
        raise conflict("already_applied", "This change was already applied.")

    spec = cr.change_spec
    touched_ids = [r["resource_id"] for r in spec.get("reallocations", [])] + list(spec.get("activate_reserves", []))
    touched = {r.id: r for r in db.query(Resource).filter(Resource.id.in_(touched_ids)).all()} if touched_ids else {}
    before = {
        "config_version": current.label,
        "routing": dict(current.config.get("routing", {})),
        "resources": {rid: {"name": r.name, "stage": r.stage, "reserve_active": r.reserve_active} for rid, r in touched.items()},
    }
    new_config = {**current.config}
    if "routing" in spec:
        new_config["routing"] = {**current.config.get("routing", {}), **spec["routing"]}
    staffing = dict(new_config.get("staffing", {}))
    for r in spec.get("reallocations", []):
        res = touched[r["resource_id"]]
        res.stage = r["to_stage"]
        res.version += 1
        staffing.setdefault("reallocations", [])
        staffing["reallocations"] = [*staffing["reallocations"], {**r, "change_request_id": cr.id}]
    for rid in spec.get("activate_reserves", []):
        res = touched[rid]
        res.reserve_active = True
        res.version += 1
        staffing["active_reserves"] = sorted({*staffing.get("active_reserves", []), rid})
    new_config["staffing"] = staffing
    summary = "; ".join(f"{row['path']}: {row['before']} → {row['after']}" for row in cr.config_diff) or "Approved change"
    new_cv = config_service.create_version(db, config=new_config, source="approved_change", summary=summary,
                                           created_by=principal.id, change_request_id=cr.id)
    after = {
        "config_version": new_cv.label,
        "routing": dict(new_config.get("routing", {})),
        "resources": {rid: {"name": r.name, "stage": r.stage, "reserve_active": r.reserve_active} for rid, r in touched.items()},
    }
    applied = AppliedChange(change_request_id=cr.id, applied_by=principal.id, applied_at=now, from_config_version=current.label,
                            to_config_version=new_cv.label, before=before, after=after)
    db.add(applied)
    run = db.get(SimulationRun, cr.source_simulation_id)
    hours = run.parameters["duration_hours"]
    sc = run.metrics["scalars"]
    db.add(PredictionRecord(
        change_request_id=cr.id, run_id=run.id, strategy_key=run.strategy_key or "custom", effective_at=now, horizon_hours=hours,
        predicted={
            "arrivals_per_hour": round((sc["arrivals"]["mean"] or 0) / hours, 3),
            "throughput_per_hour": sc["throughput_per_hour"]["mean"],
            "sla_compliance_pct": sc["sla_compliance_pct"]["mean"],
            "ending_backlog": sc["ending_backlog"]["mean"],
            "throughput_ci": [sc["throughput_per_hour"]["ci_low"], sc["throughput_per_hour"]["ci_high"]],
        },
        assumption_notes=[f"Predicted under {run.parameters['demand_multiplier']}x demand from snapshot {run.snapshot_id}"],
    ))
    add_event(db, event_type="config.change_applied", summary=f"Approved change applied: {summary}"[:300], actor_id=principal.id,
              stage="support" if "support" in cr.affected_departments else cr.affected_departments[0], is_demo=False,
              from_value=current.label, to_value=new_cv.label)
    audit.record(db, actor_id=principal.id, action="change.applied", target_type="change_request", target_id=cr.id,
                 before=before, after=after, details={"departments": cr.affected_departments, "idempotency_key": idempotency_key})
    response = {"change_request_id": cr.id, "status": "APPLIED", "from_config_version": current.label,
                "to_config_version": new_cv.label, "applied_at": iso(now)}
    db.add(IdempotencyRecord(key=idempotency_key, scope=f"apply:{cr.id}", response=response))
    return response


def visible_to(principal: Principal, cr: ChangeRequest) -> bool:
    if cr.requested_by == principal.id:
        return True
    return any(principal.covers(code, d) for code in ("changes.approve", "changes.apply", "changes.request", "audit.read")
               for d in cr.affected_departments)


def change_request_out(db: Session, principal: Principal, cr: ChangeRequest) -> dict:
    current = config_service.current_label(db)
    approved = _approved_departments(cr)
    covered = [d for d in cr.affected_departments if principal.covers("changes.approve", d)]
    is_own = cr.requested_by == principal.id
    already = any(d.approver_id == principal.id for d in cr.decisions)
    blocked = None
    can_approve = cr.status == "PENDING" and bool(covered) and not (cr.requires_separation_of_duties and is_own) and not already
    if cr.status == "PENDING" and covered and not can_approve:
        blocked = "You already decided on this request." if already else "You submitted this request, so a different approver has to decide on it."
    can_apply = cr.status == "APPROVED" and principal.covers_all("changes.apply", cr.affected_departments) and current == cr.source_config_version
    if cr.status == "APPROVED" and current != cr.source_config_version:
        blocked = "The live configuration changed after this simulation, so it can't be applied."
    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({cr.requested_by, cr.applied_by} - {None})).all()}
    return {
        "id": cr.id,
        "title": cr.title,
        "status": cr.status,
        "requested_by": {"id": cr.requested_by, "full_name": names.get(cr.requested_by, "Unknown")},
        "requested_at": iso(cr.requested_at),
        "affected_departments": [{"id": d, "name": STAGE_NAMES.get(d, d)} for d in cr.affected_departments],
        "reason": cr.reason,
        "recommendation_id": cr.recommendation_id,
        "source_simulation_id": cr.source_simulation_id,
        "source_config_version": cr.source_config_version,
        "current_config_version": current,
        "expected_benefits": cr.expected_benefits,
        "risks": cr.risks,
        "config_diff": cr.config_diff,
        "requires_separation_of_duties": cr.requires_separation_of_duties,
        "required_approvals": [{"department_id": d, "department_name": STAGE_NAMES.get(d, d), "satisfied": d in approved}
                               for d in cr.affected_departments],
        "decisions": [
            {"id": d.id, "approver": {"id": d.approver_id, "full_name": d.approver.full_name}, "decision": d.decision,
             "reason": d.reason, "decided_at": iso(d.decided_at), "department_id": d.department_ids[0] if len(d.department_ids) == 1 else None}
            for d in cr.decisions
        ],
        "expires_at": iso(cr.expires_at),
        "applied_at": iso(cr.applied_at),
        "applied_by": {"id": cr.applied_by, "full_name": names.get(cr.applied_by, "Unknown")} if cr.applied_by else None,
        "can_approve": can_approve,
        "can_apply": can_apply,
        "blocked_reason": blocked,
    }


def summary_out(cr: ChangeRequest, requester_name: str) -> dict:
    return {
        "id": cr.id, "title": cr.title, "status": cr.status,
        "requested_by": {"id": cr.requested_by, "full_name": requester_name}, "requested_at": iso(cr.requested_at),
        "affected_departments": [{"id": d, "name": STAGE_NAMES.get(d, d)} for d in cr.affected_departments],
    }
