"""Prediction monitoring (spec §11): compares what the twin predicted for an applied
change with what the live website recorded afterwards. Rates are compared per hour
over the overlapping window, never a simulated 8 h total against a shorter real window.
This is monitoring, not proof of causation."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.timeutil import iso, utcnow
from app.models import ChangeRequest, ConfigVersion, OperationalEvent, PredictionRecord, Ticket

MIN_WINDOW_HOURS = 0.5
MIN_CLOSED = 5


def observe(db: Session, rec: PredictionRecord) -> dict:
    now = utcnow()
    elapsed_h = max(0.0, (now - rec.effective_at).total_seconds() / 3600)
    window_h = min(elapsed_h, rec.horizon_hours)
    end = rec.effective_at + timedelta(hours=window_h)
    created = db.query(Ticket).filter(Ticket.created_at >= rec.effective_at, Ticket.created_at < end).count()
    closed = db.query(Ticket).filter(Ticket.status == "closed", Ticket.closed_at >= rec.effective_at, Ticket.closed_at < end).all()
    late_open = db.query(Ticket).filter(Ticket.status.in_(("open", "in_progress", "on_hold")),
                                        Ticket.sla_deadline >= rec.effective_at, Ticket.sla_deadline < end).count()
    met = sum(1 for t in closed if (t.resolved_at or t.closed_at) <= t.sla_deadline)
    evaluated = len(closed) + late_open
    backlog = db.query(Ticket).filter(Ticket.status.in_(("open", "in_progress", "on_hold", "resolved"))).count()

    sufficient = window_h >= MIN_WINDOW_HOURS and len(closed) >= MIN_CLOSED
    observed = {
        "arrivals_per_hour": round(created / window_h, 3) if window_h > 0 else None,
        "throughput_per_hour": round(len(closed) / window_h, 3) if window_h > 0 else None,
        "sla_compliance_pct": round(100 * met / evaluated, 2) if evaluated else None,
        "ending_backlog": backlog if window_h >= rec.horizon_hours else None,
    }
    p = rec.predicted
    rows = []
    for key, label, unit, comparable in [
        ("arrivals_per_hour", "Demand (tickets per hour)", "/h", True),
        ("throughput_per_hour", "Completed per hour", "/h", True),
        ("sla_compliance_pct", "SLA compliance", "%", True),
        ("ending_backlog", "Backlog at the end of the predicted window", " tickets", window_h >= rec.horizon_hours),
    ]:
        pv, ov = p.get(key), observed.get(key)
        ok = comparable and sufficient and pv is not None and ov is not None
        rows.append({
            "metric": key, "label": label, "unit": unit, "predicted": pv, "observed": ov,
            "error": round(ov - pv, 3) if ok else None,
            "error_pct": round(100 * (ov - pv) / pv, 1) if ok and pv else None,
            "comparable": ok,
            "note": None if ok else ("Window still shorter than the prediction horizon" if key == "ending_backlog"
                                     else "Not enough observed data yet"),
        })

    notes = []
    if sufficient and p.get("arrivals_per_hour") and observed["arrivals_per_hour"] is not None:
        ratio = observed["arrivals_per_hour"] / p["arrivals_per_hour"]
        if abs(ratio - 1) > 0.25:
            notes.append(f"Observed demand was {ratio:.1f}x the simulated demand, so throughput and SLA differences are expected.")
    staff_changes = db.query(OperationalEvent).filter(OperationalEvent.event_type.in_(("resource.availability_changed", "resource.updated")),
                                                      OperationalEvent.occurred_at >= rec.effective_at, OperationalEvent.occurred_at < end).count()
    if staff_changes:
        notes.append(f"{staff_changes} staffing change(s) happened during the window, which the prediction didn't include.")
    later = db.query(ConfigVersion).filter(ConfigVersion.created_at > rec.effective_at, ConfigVersion.created_at < end).count()
    if later:
        notes.append(f"The configuration changed {later} more time(s) during the window.")
    if not sufficient:
        notes.append(f"Needs at least {MIN_WINDOW_HOURS} h and {MIN_CLOSED} closed tickets after the change before comparing.")
    return {
        "status": "compared" if sufficient else "insufficient_data",
        "observed_window_hours": round(window_h, 2),
        "metrics": rows,
        "notes": notes,
    }


def monitor(db: Session) -> list[dict]:
    out = []
    for rec in db.query(PredictionRecord).order_by(PredictionRecord.effective_at.desc()).all():
        cr = db.get(ChangeRequest, rec.change_request_id)
        out.append({
            "id": rec.id,
            "change_request_id": rec.change_request_id,
            "title": cr.title if cr else None,
            "affected_departments": cr.affected_departments if cr else [],
            "strategy_key": rec.strategy_key,
            "run_id": rec.run_id,
            "effective_at": iso(rec.effective_at),
            "horizon_hours": rec.horizon_hours,
            "predicted": rec.predicted,
            "assumption_notes": rec.assumption_notes,
            **observe(db, rec),
            "disclaimer": "Prediction monitoring compares forecasts with later observations. It does not prove the change caused the outcome.",
        })
    return out
