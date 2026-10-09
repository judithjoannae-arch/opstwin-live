"""Runs simulations against a snapshot and persists results separately from live data."""
from __future__ import annotations

import time
from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.timeutil import iso, parse_iso
from app.models import SimulatedEvent, SimulationMetric, SimulationRun, TwinSnapshot
from app.services import audit
from app.simulation.engine import run_replication
from app.simulation.metrics import aggregate, replication_metrics, summary
from app.simulation.parameters import ScenarioParameters
from app.services.snapshots import build_model


def execute(
    db: Session,
    *,
    snapshot: TwinSnapshot,
    params: ScenarioParameters,
    label: str,
    actor_id: str | None,
    strategy_key: str | None = None,
    scenario_id: str | None = None,
    stress_test_id: str | None = None,
) -> SimulationRun:
    model = build_model(snapshot, params)
    t0 = time.perf_counter()
    reps = []
    events = []
    for i in range(params.replications):
        res = run_replication(model, params.seed + i, record_events=(i == 0))
        if i == 0:
            events = res.events
        reps.append(replication_metrics(res))
    agg = aggregate(reps)
    elapsed = int((time.perf_counter() - t0) * 1000)

    run = SimulationRun(
        snapshot_id=snapshot.id, scenario_id=scenario_id, stress_test_id=stress_test_id, strategy_key=strategy_key,
        label=label[:160], parameters=params.model_dump(mode="json"), seed=params.seed, replications=params.replications,
        status="completed", created_by=actor_id, duration_ms=elapsed, summary=summary(agg), metrics=agg,
    )
    db.add(run)
    db.flush()
    for name, s in agg["scalars"].items():
        db.add(SimulationMetric(run_id=run.id, name=name, unit=s["unit"], mean=s["mean"], std=s["std"],
                                ci_low=s["ci_low"], ci_high=s["ci_high"], min=s["min"], max=s["max"]))
    start = parse_iso(snapshot.payload["created_at"])
    key = strategy_key or (scenario_id or "custom")
    db.bulk_insert_mappings(SimulatedEvent, [
        {"run_id": run.id, "scenario_key": key, "replication": 0, "sim_minute": e.minute,
         "occurred_at": start + timedelta(minutes=e.minute), "event_type": e.event_type, "ticket_ref": e.ticket_ref,
         "stage": e.stage, "resource_id": e.resource_id, "detail": e.detail}
        for e in events
    ])
    audit.record(db, actor_id=actor_id, action="simulation.run", target_type="simulation_run", target_id=run.id,
                 details={"snapshot_id": snapshot.id, "label": run.label, "replications": params.replications,
                          "seed": params.seed, "strategy": strategy_key})
    return run


def run_out(run: SimulationRun, include_metrics: bool = False, visible_stages: list[str] | None = None) -> dict:
    out = {
        "id": run.id,
        "label": run.label,
        "snapshot_id": run.snapshot_id,
        "snapshot_created_at": iso(run.snapshot.created_at) if run.snapshot else None,
        "config_version": run.snapshot.config_version if run.snapshot else None,
        "scenario_id": run.scenario_id,
        "stress_test_id": run.stress_test_id,
        "strategy_key": run.strategy_key,
        "parameters": run.parameters,
        "seed": run.seed,
        "replications": run.replications,
        "status": run.status,
        "created_at": iso(run.created_at),
        "duration_ms": run.duration_ms,
        "summary": run.summary,
        "data_origin": "simulated",
    }
    if include_metrics:
        m = run.metrics
        if visible_stages is not None:
            hidden = {"intake", "triage", "support", "verification"} - set(visible_stages)
            m = {
                **m,
                "scalars": {k: v for k, v in m["scalars"].items() if k.split(".")[-1] not in hidden},
                "series": [
                    {**p, "queue": {s: q for s, q in p["queue"].items() if s not in hidden},
                     "in_service": {s: q for s, q in p["in_service"].items() if s not in hidden}}
                    for p in m["series"]
                ],
                "unfinished_example": [u for u in m["unfinished_example"] if u["stage"] not in hidden],
            }
        out["metrics"] = m
    return out
