"""Orchestrates the five-scenario stress test and the recommendation evaluation."""
from __future__ import annotations

from dataclasses import asdict

from sqlalchemy.orm import Session

from app.core.errors import ApiError, conflict
from app.core.timeutil import iso
from app.models import Recommendation, RecommendationEvaluation, SimulationRun, StressTest, TwinSnapshot
from app.recommendations.constraints import Constraints
from app.recommendations.evaluator import build_cards
from app.services import audit, config_service
from app.services.simulation_runs import execute
from app.services.snapshots import snapshot_resource_ids
from app.simulation.stress_test import StressSettings, build_scenarios

COMPARE = ["throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog",
           "sla_compliance_pct", "sla_violations", "p1_sla_compliance_pct", "recovery_time_min", "unfinished"]
STAGES = ["intake", "triage", "support", "verification"]


def run_stress_test(db: Session, *, snapshot: TwinSnapshot, settings: StressSettings, actor_id: str | None) -> StressTest:
    try:
        scenarios, choices = build_scenarios(snapshot.payload, settings)
    except ValueError as e:
        raise ApiError(409, "stress_test_unavailable", str(e)) from e
    st = StressTest(snapshot_id=snapshot.id, created_by=actor_id,
                    settings={**asdict(settings), **choices, "change_specs": {k: spec for k, _, _, spec in scenarios},
                              "labels": {k: label for k, label, _, _ in scenarios}})
    db.add(st)
    db.flush()
    runs: dict[str, SimulationRun] = {}
    for key, label, params, _spec in scenarios:
        runs[key] = execute(db, snapshot=snapshot, params=params, label=f"{key}: {label}", actor_id=actor_id,
                            strategy_key=key, stress_test_id=st.id)
    st.comparison = {
        "scenarios": [
            {
                "key": k, "label": st.settings["labels"][k], "run_id": r.id,
                "metrics": {m: r.metrics["scalars"][m] for m in COMPARE},
                "stage_mean_wait_min": {s: r.metrics["scalars"][f"stage_mean_wait_min.{s}"]["mean"] for s in STAGES},
                "stage_utilization_pct": {s: r.metrics["scalars"][f"utilization_pct.{s}"]["mean"] for s in STAGES},
            }
            for k, r in runs.items()
        ],
    }
    audit.record(db, actor_id=actor_id, action="simulation.stress_test", target_type="stress_test", target_id=st.id,
                 details={"snapshot_id": snapshot.id, "removed": choices["removed_resource"]["name"],
                          "scenarios": list(runs.keys())})
    return st


def stress_test_out(db: Session, st: StressTest) -> dict:
    runs = db.query(SimulationRun).filter(SimulationRun.stress_test_id == st.id).order_by(SimulationRun.strategy_key).all()
    return {
        "id": st.id,
        "snapshot_id": st.snapshot_id,
        "created_at": iso(st.created_at),
        "settings": {k: v for k, v in st.settings.items() if k not in ("change_specs",)},
        "comparison": st.comparison,
        "runs": [{"id": r.id, "strategy_key": r.strategy_key, "label": r.label, "summary": r.summary} for r in runs],
        "data_origin": "simulated",
    }


def evaluate(db: Session, *, st: StressTest, constraints: Constraints, actor_id: str | None) -> RecommendationEvaluation:
    runs = {r.strategy_key: r for r in db.query(SimulationRun).filter(SimulationRun.stress_test_id == st.id).all()}
    if "A" not in runs or "B" not in runs:
        raise conflict("incomplete_stress_test", "This stress test has no baseline and failure runs to compare.")
    snapshot = db.get(TwinSnapshot, st.snapshot_id)
    cards, selected, outcome = build_cards(
        runs={k: r.metrics for k, r in runs.items()},
        specs=st.settings["change_specs"],
        labels=st.settings["labels"],
        run_ids={k: r.id for k, r in runs.items()},
        constraints=constraints,
        config=snapshot.payload["config"],
        resources=snapshot_resource_ids(snapshot),
        hours=st.settings["duration_hours"],
        stress_test_id=st.id,
        snapshot_id=snapshot.id,
        config_version=snapshot.config_version,
    )
    ev = RecommendationEvaluation(stress_test_id=st.id, created_by=actor_id, constraints=constraints.model_dump(), outcome=outcome)
    db.add(ev)
    db.flush()
    for card in cards:
        rec = Recommendation(
            evaluation_id=ev.id, stress_test_id=st.id, run_id=runs[card["strategy_key"]].id, strategy_key=card["strategy_key"],
            title=card["title"], feasible=card["feasible"], pareto_efficient=card["pareto_efficient"], selected=card["selected"],
            is_no_action=card["is_no_action"], source_config_version=snapshot.config_version,
            card={k: v for k, v in card.items() if k != "change_spec"}, change_spec=card["change_spec"],
        )
        db.add(rec)
        db.flush()
        if card["selected"]:
            ev.selected_recommendation_id = rec.id
        audit.record(db, actor_id=actor_id, action="recommendation.created", target_type="recommendation", target_id=rec.id,
                     details={"strategy": rec.strategy_key, "feasible": rec.feasible, "selected": rec.selected})
    return ev


def recommendation_out(db: Session, rec: Recommendation, current_version: str | None = None) -> dict:
    current_version = current_version or config_service.current_label(db)
    return {
        "id": rec.id,
        "evaluation_id": rec.evaluation_id,
        "stress_test_id": rec.stress_test_id,
        "run_id": rec.run_id,
        "created_at": iso(rec.created_at),
        "source_config_version": rec.source_config_version,
        "current_config_version": current_version,
        "stale": rec.source_config_version != current_version,
        **rec.card,
    }


def evaluation_out(db: Session, ev: RecommendationEvaluation) -> dict:
    recs = db.query(Recommendation).filter(Recommendation.evaluation_id == ev.id).all()
    order = {"C": 0, "D": 1, "E": 2, "B": 3}
    current = config_service.current_label(db)
    return {
        "id": ev.id,
        "stress_test_id": ev.stress_test_id,
        "created_at": iso(ev.created_at),
        "constraints": ev.constraints,
        "outcome": ev.outcome,
        "selected_recommendation_id": ev.selected_recommendation_id,
        "recommendations": [recommendation_out(db, r, current) for r in sorted(recs, key=lambda r: order.get(r.strategy_key, 9))],
    }
