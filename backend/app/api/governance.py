"""Recommendations, change requests (approval workflow), audit trail, reports, prediction monitor."""
from __future__ import annotations

import csv
import io
from datetime import datetime, time

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import readable_snapshot, readable_stress_test, visible_stages_for
from app.core.errors import bad_request, not_found
from app.core.timeutil import iso, utcnow
from app.database.session import get_db
from app.models import (
    AuditLog,
    ChangeRequest,
    Recommendation,
    RecommendationEvaluation,
    SimulationMetric,
    SimulationRun,
    StressTest,
    User,
)
from app.recommendations.constraints import Constraints
from app.services import audit, changes, prediction
from app.services.authz import Principal, require
from app.services.simulation_runs import run_out
from app.services.snapshots import snapshot_out
from app.services.stress_tests import evaluate, evaluation_out, recommendation_out, stress_test_out

router = APIRouter(tags=["governance"])


# ------------------------------------------------------------------ recommendations
class EvaluateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stress_test_id: str
    constraints: Constraints = Field(default_factory=Constraints)


@router.post("/recommendations/evaluate", status_code=201)
def evaluate_recommendations(body: EvaluateIn, principal: Principal = Depends(require("recommendations.read")),
                             db: Session = Depends(get_db)):
    st = readable_stress_test(db, principal, body.stress_test_id)
    ev = evaluate(db, st=st, constraints=body.constraints, actor_id=principal.id)
    db.commit()
    return evaluation_out(db, ev)


@router.get("/recommendations")
def list_recommendations(stress_test_id: str = "", principal: Principal = Depends(require("recommendations.read")),
                         db: Session = Depends(get_db)):
    q = db.query(RecommendationEvaluation)
    if stress_test_id:
        readable_stress_test(db, principal, stress_test_id)
        q = q.filter(RecommendationEvaluation.stress_test_id == stress_test_id)
    out = []
    for ev in q.order_by(RecommendationEvaluation.created_at.desc()).limit(50).all():
        try:
            readable_stress_test(db, principal, ev.stress_test_id)
        except Exception:  # noqa: BLE001 - out of scope: skip silently
            continue
        out.append(evaluation_out(db, ev))
    return out


def _readable_recommendation(db: Session, principal: Principal, rec_id: str) -> Recommendation:
    rec = db.get(Recommendation, rec_id)
    if rec is None:
        raise not_found("That recommendation")
    readable_stress_test(db, principal, rec.stress_test_id)
    return rec


@router.get("/recommendations/{recommendation_id}")
def get_recommendation(recommendation_id: str, principal: Principal = Depends(require("recommendations.read")),
                       db: Session = Depends(get_db)):
    return recommendation_out(db, _readable_recommendation(db, principal, recommendation_id))


class ReasonIn(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/recommendations/{recommendation_id}/approve")
def approve_recommendation(recommendation_id: str, body: ReasonIn, principal: Principal = Depends(require("changes.approve")),
                           db: Session = Depends(get_db)):
    """Spec alias: records an approval on the open change request for this recommendation."""
    rec = _readable_recommendation(db, principal, recommendation_id)
    cr = (db.query(ChangeRequest).filter(ChangeRequest.recommendation_id == rec.id, ChangeRequest.status == "PENDING")
          .order_by(ChangeRequest.requested_at.desc()).first())
    if cr is None:
        raise not_found("A pending change request for this recommendation")
    changes.decide(db, principal, cr, "APPROVED", body.reason)
    db.commit()
    return changes.change_request_out(db, principal, cr)


# ------------------------------------------------------------------ change requests
class ChangeRequestIn(BaseModel):
    recommendation_id: str
    reason: str = Field(min_length=10, max_length=2000)


class DecisionIn(BaseModel):
    decision: str = Field(pattern="^(APPROVED|REJECTED)$")
    reason: str = Field(min_length=10, max_length=2000)


class ApplyIn(BaseModel):
    expected_config_version: str = Field(min_length=1, max_length=20)


class ApplyAliasIn(ApplyIn):
    change_request_id: str


def _visible_cr(db: Session, principal: Principal, cr_id: str) -> ChangeRequest:
    cr = db.get(ChangeRequest, cr_id)
    if cr is None or not changes.visible_to(principal, cr):
        raise not_found("That change request")
    return cr


CR_ANY = ("changes.request", "changes.approve", "changes.apply", "audit.read")


@router.get("/change-requests")
def list_change_requests(status: str = "", awaiting: str = "", requested_by: str = "", page_size: int = Query(50, ge=1, le=200),
                         principal: Principal = Depends(require(*CR_ANY, any_of=True)), db: Session = Depends(get_db)):
    rows = db.query(ChangeRequest).order_by(ChangeRequest.requested_at.desc()).limit(500).all()
    for cr in rows:
        changes.refresh_status(db, cr)
    db.commit()
    rows = [cr for cr in rows if changes.visible_to(principal, cr)]
    if status:
        rows = [cr for cr in rows if cr.status in status.split(",")]
    if requested_by == "me":
        rows = [cr for cr in rows if cr.requested_by == principal.id]
    if awaiting == "me":
        rows = [cr for cr in rows if cr.status == "PENDING" and changes.change_request_out(db, principal, cr)["can_approve"]]
    names = {u.id: u.full_name for u in db.query(User).filter(User.id.in_({cr.requested_by for cr in rows})).all()}
    return {"items": [changes.summary_out(cr, names.get(cr.requested_by, "Unknown")) for cr in rows[:page_size]], "total": len(rows)}


@router.post("/change-requests", status_code=201)
def create_change_request(body: ChangeRequestIn, principal: Principal = Depends(require("changes.request")),
                          db: Session = Depends(get_db)):
    rec = _readable_recommendation(db, principal, body.recommendation_id)
    cr = changes.create_request(db, principal, rec, body.reason.strip())
    db.commit()
    return changes.change_request_out(db, principal, cr)


@router.get("/change-requests/{cr_id}")
def get_change_request(cr_id: str, principal: Principal = Depends(require(*CR_ANY, any_of=True)), db: Session = Depends(get_db)):
    cr = _visible_cr(db, principal, cr_id)
    changes.refresh_status(db, cr)
    db.commit()
    return changes.change_request_out(db, principal, cr)


@router.post("/change-requests/{cr_id}/decisions")
def decide(cr_id: str, body: DecisionIn, principal: Principal = Depends(require("changes.approve")), db: Session = Depends(get_db)):
    cr = _visible_cr(db, principal, cr_id)
    changes.decide(db, principal, cr, body.decision, body.reason.strip())
    db.commit()
    return changes.change_request_out(db, principal, cr)


def _apply(db: Session, principal: Principal, cr_id: str, expected: str, key: str | None) -> dict:
    cr = _visible_cr(db, principal, cr_id)
    changes.apply(db, principal, cr, expected, key or "")
    db.commit()
    db.refresh(cr)
    return changes.change_request_out(db, principal, cr)


@router.post("/change-requests/{cr_id}/apply")
def apply_change(cr_id: str, body: ApplyIn, idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
                 principal: Principal = Depends(require("changes.apply")), db: Session = Depends(get_db)):
    return _apply(db, principal, cr_id, body.expected_config_version, idempotency_key)


@router.post("/changes/apply")
def apply_change_alias(body: ApplyAliasIn, idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
                       principal: Principal = Depends(require("changes.apply")), db: Session = Depends(get_db)):
    return _apply(db, principal, body.change_request_id, body.expected_config_version, idempotency_key)


# ------------------------------------------------------------------ audit
def _day(value: str, end: bool) -> datetime:
    d = datetime.fromisoformat(value)
    return datetime.combine(d.date(), time.max if end else time.min) if len(value) <= 10 else d


@router.get("/audit-log")
def audit_log(actor: str = "", action: str = "", target_type: str = "", target_id: str = "", outcome: str = "",
              department_id: str = "", occurred_from: str = "", occurred_to: str = "", cursor: str = "",
              page_size: int = Query(50, ge=1, le=200), principal: Principal = Depends(require("audit.read")),
              db: Session = Depends(get_db)):
    q = db.query(AuditLog)
    scope = principal.scope("audit.read")
    if scope is not None:
        q = q.filter(AuditLog.department_id.in_(scope))
    if actor.strip():
        like = f"%{actor.strip()}%"
        ids = [u.id for u in db.query(User).filter(or_(User.full_name.ilike(like), User.email.ilike(like), User.id == actor.strip())).all()]
        q = q.filter(AuditLog.actor_id.in_(ids or ["-"]))
    for col, val in ((AuditLog.action, action), (AuditLog.target_type, target_type), (AuditLog.target_id, target_id),
                     (AuditLog.outcome, outcome), (AuditLog.department_id, department_id)):
        if val:
            q = q.filter(col == val)
    try:
        if occurred_from:
            q = q.filter(AuditLog.occurred_at >= _day(occurred_from, False))
        if occurred_to:
            q = q.filter(AuditLog.occurred_at <= _day(occurred_to, True))
    except ValueError:
        raise bad_request("Dates must look like 2026-10-09.")
    if cursor:
        if not cursor.isdigit():
            raise bad_request("Invalid cursor.")
        q = q.filter(AuditLog.id < int(cursor))
    rows = q.order_by(AuditLog.id.desc()).limit(page_size + 1).all()
    more = len(rows) > page_size
    rows = rows[:page_size]
    names = {"intake": "Request intake", "triage": "Triage", "support": "Technical support", "verification": "Verification and closure"}
    return {
        "items": [{
            "id": str(a.id), "occurred_at": iso(a.occurred_at),
            "actor": {"id": a.actor_id, "full_name": a.actor.full_name} if a.actor else None,
            "action": a.action, "target_type": a.target_type, "target_id": a.target_id, "outcome": a.outcome,
            "department_id": a.department_id, "department_name": names.get(a.department_id) if a.department_id else None,
            "correlation_id": a.correlation_id, "before": a.before, "after": a.after, "details": a.details,
        } for a in rows],
        "next_cursor": str(rows[-1].id) if more else None,
    }


# ------------------------------------------------------------------ reports
def _run_for_report(db: Session, principal: Principal, run_id: str) -> SimulationRun:
    run = db.get(SimulationRun, run_id)
    if run is None:
        raise not_found("That simulation")
    readable_snapshot(db, principal, run.snapshot_id)
    return run


@router.get("/reports/{simulation_id}/export")
def export_report(simulation_id: str, format: str = Query("json", pattern="^(json|csv)$"),
                  principal: Principal = Depends(require("reports.export")), db: Session = Depends(get_db)):
    run = _run_for_report(db, principal, simulation_id)
    audit.record(db, actor_id=principal.id, action="report.exported", target_type="simulation_run", target_id=run.id,
                 details={"format": format})
    db.commit()
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["# OpsTwin Live simulation report", run.label])
        w.writerow(["# data_origin", "simulated"])
        w.writerow(["# snapshot", run.snapshot_id, "config_version", run.snapshot.config_version])
        w.writerow(["# replications", run.replications, "seed", run.seed])
        w.writerow(["metric", "unit", "mean", "std", "ci_low", "ci_high", "min", "max"])
        for m in db.query(SimulationMetric).filter(SimulationMetric.run_id == run.id).order_by(SimulationMetric.id).all():
            w.writerow([m.name, m.unit, m.mean, m.std, m.ci_low, m.ci_high, m.min, m.max])
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="opstwin-simulation-{run.id[:8]}.csv"'})
    stages = visible_stages_for(run.snapshot)
    snap = snapshot_out(run.snapshot, stages, include_records=False)
    return {
        "report_type": "simulation",
        "generated_at": iso(utcnow()),
        "data_origin": "simulated",
        "run": run_out(run, include_metrics=True, visible_stages=stages),
        "snapshot": {k: snap[k] for k in ("id", "created_at", "config_version", "coverage", "sla_resolution_minutes")},
        "assumptions": snap["assumptions"],
        "limitations": snap["limitations"],
    }


@router.get("/reports/stress-tests/{stress_test_id}/export")
def export_stress_report(stress_test_id: str, principal: Principal = Depends(require("reports.export")), db: Session = Depends(get_db)):
    st: StressTest = readable_stress_test(db, principal, stress_test_id)
    runs = db.query(SimulationRun).filter(SimulationRun.stress_test_id == st.id).order_by(SimulationRun.strategy_key).all()
    evals = db.query(RecommendationEvaluation).filter(RecommendationEvaluation.stress_test_id == st.id).all()
    snap = runs[0].snapshot if runs else readable_snapshot(db, principal, st.snapshot_id)
    stages = visible_stages_for(snap)
    snap_out = snapshot_out(snap, stages, include_records=False)
    audit.record(db, actor_id=principal.id, action="report.exported", target_type="stress_test", target_id=st.id)
    db.commit()
    return {
        "report_type": "stress_test", "generated_at": iso(utcnow()), "data_origin": "simulated",
        "stress_test": stress_test_out(db, st),
        "runs": [run_out(r, include_metrics=True, visible_stages=stages) for r in runs],
        "evaluations": [evaluation_out(db, e) for e in evals],
        "snapshot": {k: snap_out[k] for k in ("id", "created_at", "config_version", "coverage")},
        "assumptions": snap_out["assumptions"], "limitations": snap_out["limitations"],
    }


# ------------------------------------------------------------------ prediction monitor
@router.get("/prediction-monitor")
def prediction_monitor(principal: Principal = Depends(require("simulations.read", "audit.read", "changes.apply", "changes.approve",
                                                              any_of=True)), db: Session = Depends(get_db)):
    return prediction.monitor(db)
