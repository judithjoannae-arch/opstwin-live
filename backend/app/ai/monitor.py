"""Autonomous twin monitor: watches live operations, and when trouble is building it
refreshes the twin, simulates today's trajectory and the mitigations, and puts the safest
option into the Approvals inbox. It never applies anything: people approve and apply.

Runs every N minutes in a background thread once switched on, or on demand.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import timedelta

from sqlalchemy.orm import Session

from app.ai.service import settings, train
from app.core.timeutil import utcnow
from app.database.session import SessionLocal
from app.models import ChangeRequest, MonitorRun, Recommendation, Ticket, User
from app.models.common import STAGES
from app.recommendations.constraints import Constraints
from app.services import audit
from app.services.operations_state import compute_state
from app.services.snapshots import DEFAULT_PROFILE, create_snapshot, estimate_model
from app.services.stress_tests import evaluate, run_stress_test
from app.simulation.stress_test import StressSettings
from app.core.config import settings as app_settings
from app.core.timeutil import local_offset

log = logging.getLogger("opstwin.monitor")

MONITOR_EMAIL = "monitor@opstwin.system"
SURGE_WINDOW_HOURS = 2
COOLDOWN_MINUTES = 30
_run_lock = threading.Lock()


def monitor_user(db: Session) -> User:
    """A system account that can't sign in (no password). It only appears as the requester of its proposals."""
    u = db.query(User).filter(User.email == MONITOR_EMAIL).one_or_none()
    if u is None:
        u = User(email=MONITOR_EMAIL, full_name="OpsTwin Monitor (automated)", password_hash=None, is_active=True)
        db.add(u)
        db.flush()
    return u


def _expected_rate(db: Session, now) -> float:
    """Tickets per hour the twin expects for the last two local hours (observed profile when there's data)."""
    offset = int(local_offset().total_seconds() // 60)
    try:
        profile = estimate_model(db, now, offset)[0]["arrival_profile"]["values"]
    except Exception:  # noqa: BLE001
        profile = DEFAULT_PROFILE
    hours = [int((((now - timedelta(hours=h)).hour * 60 + offset) % 1440) // 60) for h in range(1, SURGE_WINDOW_HOURS + 1)]
    return sum(profile[h] for h in hours) / len(hours)


def assess(db: Session) -> dict:
    now = utcnow()
    state = compute_state(db, list(STAGES), SURGE_WINDOW_HOURS)
    recent = db.query(Ticket).filter(Ticket.created_at >= now - timedelta(hours=SURGE_WINDOW_HOURS)).count() / SURGE_WINDOW_HOURS
    expected = _expected_rate(db, now)
    surge = round(recent / expected, 2) if expected > 0.05 else (round(recent / 0.5, 2) if recent else 0.0)
    bottlenecks = [s["stage"] for s in state["stages"] if s["bottleneck"] == "bottleneck"]
    watch = [s["stage"] for s in state["stages"] if s["bottleneck"] == "watch"]
    return {"recent_rate": round(recent, 2), "expected_rate": round(expected, 2), "surge": surge,
            "bottlenecks": bottlenecks, "watch": watch, "overdue": state["totals"]["overdue"]}


def run_check(trigger: str = "manual", actor_id: str | None = None) -> MonitorRun:
    """One full monitor cycle in its own session and transaction."""
    if not _run_lock.acquire(blocking=False):
        db = SessionLocal()
        try:
            run = MonitorRun(trigger=trigger, outcome="skipped", summary="Another check was already running.", finished_at=utcnow())
            db.add(run)
            db.commit()
            return run
        finally:
            db.close()
    db = SessionLocal()
    try:
        return _run(db, trigger, actor_id)
    finally:
        db.close()
        _run_lock.release()


def _run(db: Session, trigger: str, actor_id: str | None) -> MonitorRun:
    s = settings(db)
    run = MonitorRun(trigger=trigger, outcome="healthy", summary="", findings={})
    db.add(run)
    try:
        f = assess(db)
        run.findings = f
        reasons = []
        if f["surge"] >= s.surge_threshold:
            reasons.append(f"demand is {f['surge']:.1f}x the usual rate for this time ({f['recent_rate']}/h vs {f['expected_rate']}/h)")
        if f["bottlenecks"]:
            reasons.append("bottleneck in " + ", ".join(f["bottlenecks"]))
        if not reasons:
            run.summary = (f"All clear. Demand {f['recent_rate']}/h against {f['expected_rate']}/h expected; "
                           f"no bottlenecks{'; watching ' + ', '.join(f['watch']) if f['watch'] else ''}.")
            run.finished_at = utcnow()
            db.commit()
            return run

        mon = monitor_user(db)
        open_auto = (db.query(ChangeRequest).filter(ChangeRequest.requested_by == mon.id,
                                                    ChangeRequest.status.in_(("PENDING", "APPROVED"))).first())
        recent_risk = (db.query(MonitorRun).filter(MonitorRun.outcome == "risk_recommended",
                                                   MonitorRun.started_at >= utcnow() - timedelta(minutes=COOLDOWN_MINUTES)).first())
        finding = "; ".join(reasons)
        if open_auto or recent_risk:
            run.outcome = "skipped"
            run.summary = f"Risk still present ({finding}), but a proposal is already waiting in Approvals."
            run.change_request_id = open_auto.id if open_auto else recent_risk.change_request_id
            run.finished_at = utcnow()
            db.commit()
            return run

        # Refresh the twin and simulate today's trajectory plus the mitigations.
        snap = create_snapshot(db, created_by=mon.id, scope=None)
        run.snapshot_id = snap.id
        multiplier = round(min(3.0, max(1.0, f["surge"])), 2)
        st = run_stress_test(db, snapshot=snap, actor_id=mon.id, settings=StressSettings(
            duration_hours=8, demand_multiplier=multiplier, replications=6, seed=42, remove_technician=False, respect_shifts=True))
        run.stress_test_id = st.id
        ev = evaluate(db, st=st, constraints=Constraints(), actor_id=mon.id)
        run.evaluation_id = ev.id
        recs = db.query(Recommendation).filter(Recommendation.evaluation_id == ev.id).all()
        trajectory = next(r for r in recs if r.strategy_key == "B")
        selected = next((r for r in recs if r.selected), None)

        if trajectory.feasible and selected is None:
            run.outcome = "risk_resolves"
            run.summary = f"Noticed: {finding}. The twin predicts the desk stays within every safety limit, so no change is proposed."
        elif selected is None:
            run.outcome = "risk_no_safe_option"
            run.summary = (f"Warning: {finding}. No available mitigation keeps every safety limit; a manager should review. "
                           "See the recommendation for details.")
        else:
            cr = ChangeRequest(
                title=f"Monitor proposal: {selected.title}"[:160], status="PENDING", recommendation_id=selected.id,
                source_simulation_id=selected.run_id, source_config_version=selected.source_config_version, requested_by=mon.id,
                reason=f"Raised automatically by the OpsTwin monitor: {finding}. Simulated on snapshot {snap.id[:8]} "
                       f"at {multiplier}x demand; this option keeps every safety limit.",
                expected_benefits=list(selected.card.get("benefits", [])), risks=list(selected.card.get("drawbacks", [])),
                config_diff=list(selected.card.get("config_diff", [])), change_spec=dict(selected.change_spec),
                affected_departments=[d["id"] for d in selected.card["affected_departments"]], requires_separation_of_duties=True,
                expires_at=utcnow() + timedelta(hours=app_settings.change_request_ttl_hours),
            )
            db.add(cr)
            db.flush()
            run.change_request_id = cr.id
            run.outcome = "risk_recommended"
            run.summary = f"Detected: {finding}. Proposed strategy {selected.strategy_key} ({selected.title}); waiting for approval."
            audit.record(db, actor_id=mon.id, action="change.requested", target_type="change_request", target_id=cr.id,
                         details={"automated": True, "finding": finding, "recommendation_id": selected.id})
        audit.record(db, actor_id=mon.id, action="ai.monitor.risk_detected", target_type="monitor_run", target_id=run.id,
                     details={"finding": finding, "outcome": run.outcome, "triggered_by": actor_id})
        # Keep the triage model current with what people have reviewed since the last run.
        train(db, "monitor")
        run.finished_at = utcnow()
        db.commit()
        return run
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("monitor check failed")
        failed = MonitorRun(trigger=trigger, outcome="error", summary=f"The check failed: {type(e).__name__}. See the server log.",
                            finished_at=utcnow())
        db.add(failed)
        db.commit()
        return failed


class MonitorThread(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="opstwin-monitor", daemon=True)
        self.stop_event = threading.Event()
        self.last_run = 0.0

    def run(self) -> None:
        while not self.stop_event.wait(30):
            try:
                db = SessionLocal()
                try:
                    s = settings(db)
                    db.commit()
                    enabled, interval = s.monitor_enabled, max(1, s.monitor_interval_minutes)
                finally:
                    db.close()
                if enabled and time.monotonic() - self.last_run >= interval * 60:
                    self.last_run = time.monotonic()
                    run_check("scheduled")
            except Exception:  # noqa: BLE001
                log.exception("monitor loop error")


_thread: MonitorThread | None = None


def start() -> None:
    global _thread
    if _thread is None or not _thread.is_alive():
        _thread = MonitorThread()
        _thread.start()


def stop() -> None:
    if _thread is not None:
        _thread.stop_event.set()

