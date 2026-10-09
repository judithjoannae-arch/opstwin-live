"""Digital twin: snapshots, scenarios, simulations, stress tests, sensitivity analysis.
Nothing here writes to live tickets, staff or configuration."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.deps import can_read_snapshot, readable_snapshot, readable_stress_test, visible_stages_for
from app.core.errors import bad_request, conflict, not_found
from app.core.timeutil import iso, utcnow
from app.database.session import get_db
from app.models import Scenario, SimulatedEvent, SimulationRun, StressTest, TwinSnapshot
from app.services import audit
from app.services.authz import Principal, require
from app.services.simulation_runs import execute, run_out
from app.services.snapshots import build_model, create_snapshot, snapshot_out
from app.services.stress_tests import run_stress_test, stress_test_out
from app.simulation.engine import run_replication
from app.simulation.metrics import aggregate, replication_metrics, summary
from app.simulation.parameters import ScenarioParameters
from app.simulation.stress_test import StressSettings

router = APIRouter(tags=["digital twin"])


def _snapshot_scope(principal: Principal, code: str) -> list[str] | None:
    s = principal.scope(code)
    return None if s is None else sorted(s)


# ------------------------------------------------------------------ snapshots
@router.post("/twin/snapshots", status_code=201)
def new_snapshot(principal: Principal = Depends(require("snapshots.create")), db: Session = Depends(get_db)):
    snap = create_snapshot(db, created_by=principal.id, scope=_snapshot_scope(principal, "snapshots.create"))
    audit.record(db, actor_id=principal.id, action="snapshot.created", target_type="snapshot", target_id=snap.id,
                 details={"config_version": snap.config_version, "tickets": snap.ticket_count, "scope": snap.scope})
    db.commit()
    return snapshot_out(snap, visible_stages_for(snap))


@router.get("/twin/snapshots")
def list_snapshots(limit: int = Query(20, ge=1, le=100),
                   principal: Principal = Depends(require("simulations.read", "simulations.run", "snapshots.create", any_of=True)),
                   db: Session = Depends(get_db)):
    rows = db.query(TwinSnapshot).order_by(TwinSnapshot.created_at.desc()).limit(200).all()
    rows = [s for s in rows if can_read_snapshot(principal, s)][:limit]
    return [snapshot_out(s, visible_stages_for(s), include_records=False) for s in rows]


@router.get("/twin/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str,
                 principal: Principal = Depends(require("simulations.read", "simulations.run", "snapshots.create", any_of=True)),
                 db: Session = Depends(get_db)):
    snap = readable_snapshot(db, principal, snapshot_id)
    return snapshot_out(snap, visible_stages_for(snap))


# ------------------------------------------------------------------ scenarios
class ScenarioIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=120)
    description: str | None = Field(None, max_length=2000)
    snapshot_id: str
    parameters: ScenarioParameters = Field(default_factory=ScenarioParameters)


class ScenarioPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    name: str | None = Field(None, min_length=2, max_length=120)
    description: str | None = Field(None, max_length=2000)
    parameters: ScenarioParameters | None = None


class CloneIn(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=120)
    snapshot_id: str | None = None


def scenario_out(s: Scenario) -> dict:
    return {"id": s.id, "name": s.name, "description": s.description, "snapshot_id": s.snapshot_id,
            "snapshot_created_at": iso(s.snapshot.created_at), "config_version": s.snapshot.config_version,
            "parameters": s.parameters, "kind": s.kind, "created_at": iso(s.created_at), "updated_at": iso(s.updated_at),
            "version": s.version}


def _readable_scenario(db: Session, principal: Principal, scenario_id: str) -> Scenario:
    s = db.get(Scenario, scenario_id)
    if s is None or not can_read_snapshot(principal, s.snapshot):
        raise not_found("That scenario")
    return s


@router.post("/scenarios", status_code=201)
def create_scenario(body: ScenarioIn, principal: Principal = Depends(require("simulations.run")), db: Session = Depends(get_db)):
    snap = readable_snapshot(db, principal, body.snapshot_id)
    build_model(snap, body.parameters)  # validates resource ids against the snapshot
    s = Scenario(name=body.name.strip(), description=body.description, snapshot_id=snap.id,
                 parameters=body.parameters.model_dump(mode="json"), created_by=principal.id)
    db.add(s)
    db.flush()
    audit.record(db, actor_id=principal.id, action="scenario.created", target_type="scenario", target_id=s.id)
    db.commit()
    return scenario_out(s)


@router.get("/scenarios")
def list_scenarios(snapshot_id: str = "", principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                   db: Session = Depends(get_db)):
    q = db.query(Scenario)
    if snapshot_id:
        q = q.filter(Scenario.snapshot_id == snapshot_id)
    rows = q.order_by(Scenario.updated_at.desc()).limit(200).all()
    return [scenario_out(s) for s in rows if can_read_snapshot(principal, s.snapshot)]


@router.get("/scenarios/{scenario_id}")
def get_scenario(scenario_id: str, principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                 db: Session = Depends(get_db)):
    return scenario_out(_readable_scenario(db, principal, scenario_id))


@router.patch("/scenarios/{scenario_id}")
def update_scenario(scenario_id: str, body: ScenarioPatch, principal: Principal = Depends(require("simulations.run")),
                    db: Session = Depends(get_db)):
    s = _readable_scenario(db, principal, scenario_id)
    if body.version != s.version:
        raise conflict("version_conflict", "This scenario changed since you loaded it.")
    if body.name is not None:
        s.name = body.name.strip()
    if "description" in body.model_fields_set:
        s.description = body.description
    if body.parameters is not None:
        build_model(s.snapshot, body.parameters)
        s.parameters = body.parameters.model_dump(mode="json")
    s.version += 1
    s.updated_at = utcnow()
    db.commit()
    return scenario_out(s)


@router.post("/scenarios/{scenario_id}/clone", status_code=201)
def clone_scenario(scenario_id: str, body: CloneIn, principal: Principal = Depends(require("simulations.run")),
                   db: Session = Depends(get_db)):
    src = _readable_scenario(db, principal, scenario_id)
    snap = readable_snapshot(db, principal, body.snapshot_id) if body.snapshot_id else src.snapshot
    params = ScenarioParameters(**src.parameters)
    build_model(snap, params)
    s = Scenario(name=(body.name or f"{src.name} (copy)")[:120], description=src.description, snapshot_id=snap.id,
                 parameters=params.model_dump(mode="json"), created_by=principal.id)
    db.add(s)
    db.commit()
    return scenario_out(s)


# ------------------------------------------------------------------ simulations
class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: str | None = None
    snapshot_id: str | None = None
    parameters: ScenarioParameters | None = None
    label: str | None = Field(None, max_length=160)


@router.post("/simulations/run", status_code=201)
def run_simulation(body: RunIn, principal: Principal = Depends(require("simulations.run")), db: Session = Depends(get_db)):
    if body.scenario_id:
        sc = _readable_scenario(db, principal, body.scenario_id)
        snap, params, label = sc.snapshot, ScenarioParameters(**sc.parameters), body.label or sc.name
    elif body.snapshot_id:
        snap = readable_snapshot(db, principal, body.snapshot_id)
        params, label, sc = body.parameters or ScenarioParameters(), body.label or "Ad-hoc simulation", None
    else:
        raise bad_request("Send a scenario_id, or a snapshot_id with parameters.")
    run = execute(db, snapshot=snap, params=params, label=label, actor_id=principal.id, scenario_id=sc.id if sc else None)
    db.commit()
    return run_out(run, include_metrics=True, visible_stages=visible_stages_for(snap))


class StressIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str | None = None
    duration_hours: float = Field(8, ge=1, le=72)
    demand_multiplier: float = Field(2.0, ge=1, le=5)
    replications: int = Field(10, ge=2, le=30)
    seed: int = Field(42, ge=0, le=2**31 - 1)
    removed_resource_id: str | None = None
    capacity_source: Literal["auto", "transfer", "reserve"] = "auto"
    transfer_count: int = Field(1, ge=1, le=5)
    donor_stage: Literal["intake", "triage", "verification"] | None = None
    respect_shifts: bool = True


@router.post("/simulations/stress-test", status_code=201)
def stress_test(body: StressIn, principal: Principal = Depends(require("simulations.run")), db: Session = Depends(get_db)):
    if body.snapshot_id:
        snap = readable_snapshot(db, principal, body.snapshot_id)
    else:
        if not principal.has("snapshots.create"):
            raise bad_request("Choose an existing snapshot; you can't create new ones.", "snapshot_required")
        snap = create_snapshot(db, created_by=principal.id, scope=_snapshot_scope(principal, "snapshots.create"))
        audit.record(db, actor_id=principal.id, action="snapshot.created", target_type="snapshot", target_id=snap.id,
                     details={"config_version": snap.config_version, "reason": "stress test"})
    settings = StressSettings(**body.model_dump(exclude={"snapshot_id"}))
    st = run_stress_test(db, snapshot=snap, settings=settings, actor_id=principal.id)
    db.commit()
    return stress_test_out(db, st)


@router.get("/stress-tests")
def list_stress_tests(limit: int = Query(20, ge=1, le=100),
                      principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                      db: Session = Depends(get_db)):
    rows = db.query(StressTest).order_by(StressTest.created_at.desc()).limit(200).all()
    out = []
    for st in rows:
        snap = db.get(TwinSnapshot, st.snapshot_id)
        if can_read_snapshot(principal, snap):
            out.append(stress_test_out(db, st))
        if len(out) >= limit:
            break
    return out


@router.get("/stress-tests/{stress_test_id}")
def get_stress_test(stress_test_id: str, principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                    db: Session = Depends(get_db)):
    return stress_test_out(db, readable_stress_test(db, principal, stress_test_id))


def _readable_run(db: Session, principal: Principal, run_id: str) -> SimulationRun:
    run = db.get(SimulationRun, run_id)
    if run is None or not can_read_snapshot(principal, run.snapshot):
        raise not_found("That simulation")  # guessing an ID reveals nothing
    return run


@router.get("/simulations")
def list_runs(snapshot_id: str = "", stress_test_id: str = "", limit: int = Query(30, ge=1, le=200),
              principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)), db: Session = Depends(get_db)):
    q = db.query(SimulationRun)
    if snapshot_id:
        q = q.filter(SimulationRun.snapshot_id == snapshot_id)
    if stress_test_id:
        q = q.filter(SimulationRun.stress_test_id == stress_test_id)
    rows = [r for r in q.order_by(SimulationRun.created_at.desc()).limit(500).all() if can_read_snapshot(principal, r.snapshot)]
    return [run_out(r) for r in rows[:limit]]


@router.get("/simulations/{simulation_id}")
def get_run(simulation_id: str, principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
            db: Session = Depends(get_db)):
    return run_out(_readable_run(db, principal, simulation_id))


@router.get("/simulations/{simulation_id}/metrics")
def get_run_metrics(simulation_id: str, principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                    db: Session = Depends(get_db)):
    run = _readable_run(db, principal, simulation_id)
    return run_out(run, include_metrics=True, visible_stages=visible_stages_for(run.snapshot))["metrics"]


@router.get("/simulations/{simulation_id}/events")
def get_run_events(simulation_id: str, event_type: str = "", stage: str = "", ticket: str = "", cursor: str = "",
                   page_size: int = Query(100, ge=1, le=500),
                   principal: Principal = Depends(require("simulations.read", "simulations.run", any_of=True)),
                   db: Session = Depends(get_db)):
    run = _readable_run(db, principal, simulation_id)
    q = db.query(SimulatedEvent).filter(SimulatedEvent.run_id == run.id)
    stages = visible_stages_for(run.snapshot)
    if stages is not None:
        q = q.filter(SimulatedEvent.stage.in_(stages))
    if event_type:
        q = q.filter(SimulatedEvent.event_type == event_type)
    if stage:
        q = q.filter(SimulatedEvent.stage == stage)
    if ticket:
        q = q.filter(SimulatedEvent.ticket_ref == ticket.strip().upper())
    if cursor:
        if not cursor.isdigit():
            raise bad_request("Invalid cursor.")
        q = q.filter(SimulatedEvent.id > int(cursor))
    rows = q.order_by(SimulatedEvent.id.asc()).limit(page_size + 1).all()
    more = len(rows) > page_size
    rows = rows[:page_size]
    return {
        "items": [{"id": str(e.id), "scenario_key": e.scenario_key, "replication": e.replication, "sim_minute": e.sim_minute,
                   "occurred_at": iso(e.occurred_at), "event_type": e.event_type, "ticket_ref": e.ticket_ref, "stage": e.stage,
                   "resource_id": e.resource_id, "detail": e.detail, "data_origin": "simulated"} for e in rows],
        "next_cursor": str(rows[-1].id) if more else None,
        "note": "Events from replication 1 of this run. Simulated events are stored apart from real operational events.",
    }


class SensitivityIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str
    parameter: Literal["demand", "service_time", "staff"]
    values: list[float] = Field(min_length=2, max_length=8)
    base: ScenarioParameters = Field(default_factory=lambda: ScenarioParameters(replications=5))


@router.post("/simulations/sensitivity")
def sensitivity(body: SensitivityIn, principal: Principal = Depends(require("simulations.run")), db: Session = Depends(get_db)):
    """Sweeps one input and reports how the headline metrics respond. Results are simulated and not stored as runs."""
    snap = readable_snapshot(db, principal, body.snapshot_id)
    reps = min(body.base.replications, 10)
    support = [r for r in snap.payload["resources"] if r["stage"] == "support" and r["is_available"] and not r["is_reserve"]]
    rows = []
    for v in body.values:
        p = body.base.model_copy(deep=True)
        p.replications = reps
        if body.parameter == "demand":
            if not 0 <= v <= 5:
                raise bad_request("Demand multipliers must be between 0 and 5.")
            p.demand_multiplier = v
        elif body.parameter == "service_time":
            if not 0 < v <= 5:
                raise bad_request("Service time multipliers must be in (0, 5].")
            p.service_time_multipliers = {s: v for s in ("intake", "triage", "support", "verification")}
        else:
            n = int(v)
            if n >= 0:
                p.extra_staff = {"support": n}
            else:
                p.removed_resource_ids = [r["id"] for r in support[: min(-n, max(0, len(support) - 1))]]
        model = build_model(snap, p)
        agg = aggregate([replication_metrics(run_replication(model, p.seed + i)) for i in range(reps)])
        rows.append({"value": v, "summary": summary(agg),
                     "ci": {k: [agg["scalars"][k]["ci_low"], agg["scalars"][k]["ci_high"]] for k in ("throughput_per_hour", "mean_wait_min")}})
    audit.record(db, actor_id=principal.id, action="simulation.sensitivity", target_type="snapshot", target_id=snap.id,
                 details={"parameter": body.parameter, "values": body.values})
    db.commit()
    return {"snapshot_id": snap.id, "parameter": body.parameter, "replications": reps, "results": rows, "data_origin": "simulated"}
