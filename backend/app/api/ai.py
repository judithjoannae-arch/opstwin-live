"""AI automation API: triage assistant and autonomous twin monitor."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.ai import monitor, service
from app.core.errors import not_found
from app.core.timeutil import iso, utcnow
from app.database.session import get_db
from app.ai.priority import assess
from app.models import AiPrediction, ChangeRequest, MonitorRun, Ticket, TicketAssessment
from app.services import audit
from app.services.authz import Principal, require

router = APIRouter(prefix="/ai", tags=["ai automation"])


class ClassifyIn(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str = Field("", max_length=5000)
    affects_many_users: bool = False


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_intake: bool
    category_threshold: float = Field(ge=0.4, le=0.99)
    priority_threshold: float = Field(ge=0.3, le=0.99)
    monitor_enabled: bool
    monitor_interval_minutes: int = Field(ge=1, le=240)
    surge_threshold: float = Field(ge=1.1, le=5)


def settings_out(s) -> dict:
    return {"auto_intake": s.auto_intake, "category_threshold": s.category_threshold, "priority_threshold": s.priority_threshold,
            "monitor_enabled": s.monitor_enabled, "monitor_interval_minutes": s.monitor_interval_minutes,
            "surge_threshold": s.surge_threshold, "updated_at": iso(s.updated_at)}


def run_out(r: MonitorRun) -> dict:
    return {"id": r.id, "started_at": iso(r.started_at), "finished_at": iso(r.finished_at), "trigger": r.trigger,
            "outcome": r.outcome, "summary": r.summary, "findings": r.findings, "snapshot_id": r.snapshot_id,
            "stress_test_id": r.stress_test_id, "evaluation_id": r.evaluation_id, "change_request_id": r.change_request_id}


@router.post("/classify")
def classify(body: ClassifyIn, principal: Principal = Depends(require("tickets.create", "tickets.read", any_of=True)),
             db: Session = Depends(get_db)):
    out = service.classify(db, body.title, body.description, body.affects_many_users)
    db.commit()
    return {**out, "data_origin": "derived"}


@router.get("/triage/{ticket_id}")
def triage(ticket_id: str, principal: Principal = Depends(require("tickets.read")), db: Session = Depends(get_db)):
    t = db.get(Ticket, ticket_id)
    if t is None or not principal.covers("tickets.read", t.stage, allow_assigned=True):
        raise not_found("That ticket")
    result = service.classify(db, t.title, t.description)
    first = (db.query(AiPrediction).filter(AiPrediction.ticket_id == t.id).order_by(AiPrediction.id.asc()).first())
    row = db.get(TicketAssessment, t.id)
    priority = ({"priority": row.priority, "impact": row.impact, "urgency": row.urgency, "reasons": row.reasons,
                 "affects_many_users": row.affects_many_users, "method": "Impact × urgency matrix", "recorded": True}
                if row else {**assess(t.title, t.description, t.category, False), "recorded": False})
    suggestion = service.suggest_technician(db, t.category) if t.stage == "support" and t.status == "open" else None
    db.commit()
    return {
        **result,
        "current_category": t.category,
        "category_mismatch": result["category"]["label"] != t.category,
        "submitted_category": first.submitted_category if first else t.category,
        "automatic_action": first.action if first else None,
        "suggested_technician": suggestion,
        "priority_assessment": priority,
        "data_origin": "derived",
    }


@router.get("/model")
def model(principal: Principal = Depends(require("tickets.read", "simulations.read", "policies.manage", any_of=True)),
          db: Session = Depends(get_db)):
    card = service.model_card(db)
    db.commit()
    return card


@router.post("/model/retrain")
def retrain(principal: Principal = Depends(require("policies.manage", global_only=True)), db: Session = Depends(get_db)):
    v = service.train(db, "manual")
    audit.record(db, actor_id=principal.id, action="ai.model.retrained", target_type="ai_model", target_id=str(v.id),
                 details={"history_examples": v.history_examples})
    db.commit()
    return service.model_card(db)


@router.get("/settings")
def get_settings(principal: Principal = Depends(require("tickets.read", "simulations.read", "policies.manage", any_of=True)),
                 db: Session = Depends(get_db)):
    s = service.settings(db)
    db.commit()
    return settings_out(s)


@router.put("/settings")
def put_settings(body: SettingsIn, principal: Principal = Depends(require("policies.manage", global_only=True)),
                 db: Session = Depends(get_db)):
    s = service.settings(db)
    before = settings_out(s)
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    s.updated_at, s.updated_by = utcnow(), principal.id
    audit.record(db, actor_id=principal.id, action="ai.settings.changed", target_type="ai_settings", target_id="1",
                 before=before, after=settings_out(s))
    db.commit()
    return settings_out(s)


@router.get("/predictions")
def predictions(limit: int = Query(30, ge=1, le=200), principal: Principal = Depends(require("tickets.read")),
                db: Session = Depends(get_db)):
    visible = principal.visible_stages("tickets.read")
    rows = (db.query(AiPrediction, Ticket).join(Ticket, Ticket.id == AiPrediction.ticket_id)
            .filter(Ticket.stage.in_(visible)).order_by(AiPrediction.id.desc()).limit(limit).all())
    return [{"id": p.id, "created_at": iso(p.created_at), "ticket_id": t.id, "ticket_reference": t.reference, "title": t.title,
             "submitted_category": p.submitted_category, "predicted_category": p.predicted_category,
             "category_confidence": p.category_confidence, "predicted_priority": p.predicted_priority,
             "priority_confidence": p.priority_confidence, "action": p.action, "evidence": p.evidence,
             "current_category": t.category, "current_priority": t.priority,
             "reviewed": t.stage in service.REVIEWED_STAGES or t.status == "closed"} for p, t in rows]


@router.get("/monitor/runs")
def monitor_runs(limit: int = Query(20, ge=1, le=100),
                 principal: Principal = Depends(require("simulations.read", "simulations.run", "changes.approve", any_of=True)),
                 db: Session = Depends(get_db)):
    rows = db.query(MonitorRun).order_by(MonitorRun.started_at.desc()).limit(limit).all()
    return [run_out(r) for r in rows]


@router.post("/monitor/check")
def monitor_check(principal: Principal = Depends(require("simulations.run")), db: Session = Depends(get_db)):
    run = monitor.run_check("manual", actor_id=principal.id)
    cr = db.get(ChangeRequest, run.change_request_id) if run.change_request_id else None
    return {**run_out(run), "change_request_status": cr.status if cr else None}
