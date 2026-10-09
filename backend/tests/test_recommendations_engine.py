"""Spec §19 items 11-13: feasibility, hard constraints, evidence."""
from app.recommendations.constraints import Constraints
from app.recommendations.evaluator import build_cards
from app.simulation.metrics import aggregate


def fake(**over):
    base = {"throughput_per_hour": 5.0, "mean_wait_min": 60.0, "p95_wait_min": 150.0, "max_backlog": 20, "ending_backlog": 15,
            "sla_compliance_pct": 95.0, "sla_violations": 2, "p1_sla_compliance_pct": 95.0, "p1_mean_wait_min": 10.0,
            "unfinished": 15, "recovery_time_min": 60.0, "arrivals": 40, "completed": 40,
            **{f"stage_mean_wait_min.{s}": 5.0 for s in ("intake", "triage", "verification")},
            "stage_mean_wait_min.support": 50.0,
            **{f"utilization_pct.{s}": 50.0 for s in ("intake", "triage", "support", "verification")}}
    base.update(over)
    reps = [{"scalars": dict(base), "series": [{"minute": 0, "backlog": 1, "cum_arrivals": 0, "cum_closed": 0,
                                                 "queue": {s: 0 for s in ("intake", "triage", "support", "verification")},
                                                 "in_service": {s: 0 for s in ("intake", "triage", "support", "verification")}}],
             "hourly": [{"hour": 0, "arrivals": 1, "closed": 1}], "unfinished": []} for _ in range(5)]
    return aggregate(reps)


SPECS = {"A": {}, "B": {}, "C": {"routing": {"policy": "smart_triage", "skill_aware": True}},
         "D": {"reallocations": [{"resource_id": "r1", "from_stage": "triage", "to_stage": "support"}]},
         "E": {"routing": {"policy": "smart_triage", "skill_aware": True},
               "reallocations": [{"resource_id": "r1", "from_stage": "triage", "to_stage": "support"}]}}
LABELS = {k: f"Strategy {k}" for k in SPECS}
IDS = {k: f"run-{k}" for k in SPECS}


def cards(runs, c=None):
    return build_cards(runs=runs, specs=SPECS, labels=LABELS, run_ids=IDS, constraints=c or Constraints(),
                       config={"routing": {"policy": "fifo", "skill_aware": False}}, resources={"r1": {"name": "Mei"}},
                       hours=8, stress_test_id="st", snapshot_id="snap", config_version="cfg-1")


def by_key(cs):
    return {c["strategy_key"]: c for c in cs}


def test_infeasible_strategies_are_rejected():  # 11
    runs = {"A": fake(), "B": fake(p1_sla_compliance_pct=40.0, ending_backlog=50),
            "C": fake(p1_sla_compliance_pct=60.0), "D": fake(ending_backlog=45), "E": fake()}
    cs, selected, _ = cards(runs)
    k = by_key(cs)
    assert not k["C"]["feasible"] and not k["D"]["feasible"]
    assert selected == "E"
    assert any(not c["passed"] for c in k["C"]["constraint_checks"])


def test_hard_constraints_cannot_be_bypassed_by_better_metrics():  # 12
    # C is far better on throughput and waits but breaks the critical SLA constraint.
    runs = {"A": fake(), "B": fake(),
            "C": fake(throughput_per_hour=9.0, mean_wait_min=5.0, p95_wait_min=10.0, ending_backlog=1, p1_sla_compliance_pct=50.0),
            "D": fake(sla_compliance_pct=96.0), "E": fake(sla_compliance_pct=94.0)}
    cs, selected, _ = cards(runs)
    assert selected != "C"
    assert by_key(cs)["C"]["feasible"] is False


def test_no_action_when_every_strategy_violates_constraints():
    bad = fake(p1_sla_compliance_pct=10.0)
    cs, selected, outcome = cards({"A": fake(), "B": bad, "C": bad, "D": bad, "E": bad})
    assert selected is None and "No action" in outcome


def test_recommendation_reports_computed_outputs():  # 13
    runs = {"A": fake(), "B": fake(mean_wait_min=200.0), "C": fake(mean_wait_min=80.0), "D": fake(), "E": fake()}
    cs, _, _ = cards(runs)
    row = next(r for r in by_key(cs)["C"]["expected_changes"] if r["metric"] == "mean_wait_min")
    assert row["failure_baseline"] == 200.0 and row["strategy"] == 80.0 and row["delta_vs_failure"] == -120.0
    assert by_key(cs)["C"]["evidence"]["strategy_run_id"] == "run-C"


def test_donor_stage_deterioration_limit():
    runs = {"A": fake(), "B": fake(), "C": fake(), "D": fake(**{"stage_mean_wait_min.triage": 90.0}), "E": fake()}
    k = by_key(cards(runs)[0])
    assert not k["D"]["feasible"]
    assert any(c["key"] == "max_stage_wait_increase_min" and not c["passed"] for c in k["D"]["constraint_checks"])
