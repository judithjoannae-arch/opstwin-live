"""AI triage assistant: trains locally on ticket history to predict the category, suggests a
technician, and (only when switched on) performs intake automatically.

Priority is never predicted by the model or chosen by a person: it is calculated from impact
and urgency (app/ai/priority.py), so the same situation always gets the same priority."""
from __future__ import annotations

import logging
import threading
from datetime import timedelta

from sqlalchemy.orm import Session

from app.ai.classifier import NaiveBayes, cross_validate, tokenize
from app.ai.corpus import STARTER
from app.ai.priority import assess
from app.core.timeutil import iso, utcnow
from app.models import AiModelVersion, AiPrediction, AiSettings, Resource, Ticket, TicketAssessment, TicketStatusHistory
from app.services import audit
from app.services.operations_state import is_working, on_shift_now
from app.services.tickets import CATEGORY_TEXT, STAGE_LABELS, add_event, reassess_priority

log = logging.getLogger("opstwin.ai")

REVIEWED_STAGES = ("support", "verification")
PRIORITY_NAMES = {"P1": "P1 Critical", "P2": "P2 High", "P3": "P3 Medium", "P4": "P4 Low"}


class _Model:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.category: NaiveBayes | None = None
        self.version: AiModelVersion | None = None


_model = _Model()


def settings(db: Session) -> AiSettings:
    s = db.get(AiSettings, 1)
    if s is None:
        s = AiSettings(id=1)
        db.add(s)
        db.flush()
    return s


def ticket_text(t: Ticket) -> str:
    return f"{t.title} {t.description}"


def _reviewed(db: Session) -> list[Ticket]:
    """Tickets whose category and priority a person has confirmed (they've passed triage)."""
    return (db.query(Ticket)
            .filter((Ticket.stage.in_(REVIEWED_STAGES)) | (Ticket.status == "closed"))
            .order_by(Ticket.created_at.desc()).limit(3000).all())


def train(db: Session, trigger: str) -> AiModelVersion:
    history = _reviewed(db)
    cat_docs = [(tokenize(t), c) for t, c, _ in STARTER] + [(tokenize(ticket_text(t)), t.category) for t in history]
    cat_model = NaiveBayes().fit(cat_docs)
    version = AiModelVersion(trained_at=utcnow(), starter_examples=len(STARTER), history_examples=len(history),
                             category_cv_accuracy=cross_validate(cat_docs), priority_cv_accuracy=None, trigger=trigger)
    db.add(version)
    db.flush()
    with _model.lock:
        _model.category, _model.version = cat_model, version
    log.info("AI triage model v%s trained on %s starter + %s reviewed tickets", version.id, len(STARTER), len(history))
    return version


def ensure_model(db: Session) -> AiModelVersion:
    with _model.lock:
        current = _model.version
    if current is None:
        return train(db, "startup")
    return current


def classify(db: Session, title: str, description: str, affects_many_users: bool = False) -> dict:
    version = ensure_model(db)
    tokens = tokenize(f"{title} {description}")
    with _model.lock:
        cat = _model.category.predict(tokens)
    return {
        "model_version": version.id,
        "category": {"label": cat.label, "confidence": round(cat.confidence, 3), "evidence": cat.evidence,
                     "ranking": [{"label": c, "confidence": round(p, 3)} for c, p in cat.ranking[:3]]},
        # What the priority would be for this text in the predicted category (calculated, not predicted).
        "priority": assess(title, description, cat.label, affects_many_users),
    }


def suggest_technician(db: Session, category: str) -> dict | None:
    """Available, on shift, has the skill, lightest current workload."""
    now = utcnow()
    candidates = [r for r in db.query(Resource).filter(Resource.stage == "support").all()
                  if is_working(r) and on_shift_now(r, now) and category in (r.skills or [])]
    if not candidates:
        return None
    load = {r.id: db.query(Ticket).filter(Ticket.assigned_resource_id == r.id,
                                          Ticket.status.in_(("open", "in_progress", "on_hold"))).count() for r in candidates}
    best = min(candidates, key=lambda r: (load[r.id], r.name))
    return {"id": best.id, "name": best.name, "active_tickets": load[best.id],
            "reason": f"On shift now, handles {CATEGORY_TEXT.get(category, category).lower()}, lightest workload ({load[best.id]} active)"}


def record_prediction(db: Session, t: Ticket, result: dict, action: str = "suggested",
                      submitted_category: str | None = None) -> AiPrediction:
    p = AiPrediction(ticket_id=t.id, model_version=result["model_version"], submitted_category=submitted_category or t.category,
                     predicted_category=result["category"]["label"], category_confidence=result["category"]["confidence"],
                     predicted_priority=t.priority, priority_confidence=1.0,  # calculated by the matrix, not predicted
                     evidence={"category": result["category"]["evidence"], "priority": result["priority"]["reasons"]}, action=action)
    db.add(p)
    db.flush()
    return p


def on_new_ticket(db: Session, t: Ticket) -> None:
    """Called after a ticket is created. Never raises: a failure here must not stop ticket intake."""
    try:
        s = settings(db)
        submitted = t.category  # what the requester chose, before any correction
        result = classify(db, t.title, t.description)
        if not s.auto_intake:
            record_prediction(db, t, result, "suggested")
            return
        cat = result["category"]
        confident = cat["confidence"] >= s.category_threshold
        now = utcnow()
        if confident and cat["label"] != t.category:
            add_event(db, event_type="ticket.category_changed", ticket=t, from_value=CATEGORY_TEXT.get(t.category),
                      to_value=CATEGORY_TEXT.get(cat["label"]), summary="Category corrected by AI triage",
                      note=f"AI triage: text reads as {CATEGORY_TEXT.get(cat['label'])} ({cat['confidence']:.0%}).")
            t.category = cat["label"]
            reassess_priority(db, t, None, "by AI triage after the category was corrected")
        if confident:
            add_event(db, event_type="ticket.stage_changed", ticket=t, from_value=STAGE_LABELS["intake"], to_value=STAGE_LABELS["triage"],
                      summary="Moved from Request intake to Triage by AI triage",
                      note=f"Automated intake: classified as {CATEGORY_TEXT.get(t.category)}, {PRIORITY_NAMES[t.priority]}.")
            db.add(TicketStatusHistory(ticket_id=t.id, from_stage="intake", to_stage="triage", from_status="open",
                                       to_status="open", changed_at=now))
            t.stage, t.stage_entered_at, t.updated_at = "triage", now, now
            t.version += 1
            record_prediction(db, t, result, "auto_applied", submitted_category=submitted)
            audit.record(db, actor_id=None, action="ai.auto_intake", target_type="ticket", target_id=t.id, department_id="intake",
                         details={"reference": t.reference, "category": t.category, "priority": t.priority,
                                  "confidence": cat["confidence"], "model_version": result["model_version"]})
        else:
            add_event(db, event_type="ticket.note_added", ticket=t, summary="AI triage left this ticket for a person",
                      note=f"AI triage unsure ({cat['confidence']:.0%} for {CATEGORY_TEXT.get(cat['label'])}); left for a person to review.")
            record_prediction(db, t, result, "left_for_human", submitted_category=submitted)
    except Exception:  # noqa: BLE001 - AI must never block intake
        db.rollback()  # discards only the AI's changes; the ticket was already committed
        log.exception("AI triage failed for ticket %s", t.id)


def accuracy(db: Session) -> dict:
    """Observed accuracy: predictions compared with what people decided once the ticket passed triage."""
    rows = (db.query(AiPrediction, Ticket).join(Ticket, Ticket.id == AiPrediction.ticket_id)
            .filter((Ticket.stage.in_(REVIEWED_STAGES)) | (Ticket.status == "closed")).all())
    n = len(rows)
    cat_ok = sum(1 for p, t in rows if p.predicted_category == t.category)
    caught = sum(1 for p, t in rows if p.submitted_category != t.category and p.predicted_category == t.category)
    mislabelled = sum(1 for p, t in rows if p.submitted_category != t.category)
    return {
        "reviewed": n,
        "category_accuracy_pct": round(100 * cat_ok / n, 1) if n else None,
        "mislabelled_by_requester": mislabelled,
        "mislabels_caught_by_ai": caught,
    }


def model_card(db: Session) -> dict:
    v = ensure_model(db)
    with _model.lock:
        vocab = len(_model.category.vocab) if _model.category else 0
    return {
        "version": v.id,
        "trained_at": iso(v.trained_at),
        "trigger": v.trigger,
        "algorithm": "Multinomial Naive Bayes on words and word pairs, trained locally. No external AI service or API key.",
        "priority_method": "Calculated, never chosen: impact (how many people) × urgency (how blocked), from the request's wording, "
                           "category and the 'affects many people' answer. The same situation always gets the same priority.",
        "starter_examples": v.starter_examples,
        "history_examples": v.history_examples,
        "vocabulary": vocab,
        "cross_validated": {"category_accuracy_pct": v.category_cv_accuracy},
        "observed": accuracy(db),
        "notes": [
            "Cross-validated accuracy is measured on the training data with 5 folds.",
            "Observed accuracy compares predictions with what the triage team decided.",
            "The demo history reuses a small set of synthetic ticket titles, so accuracy measured on it is optimistic.",
            "Priority comes from a fixed impact × urgency matrix rather than the model, so it's consistent and explainable.",
        ],
    }
