"""The mandatory judge failure scenario (spec §9): A normal, B 2x demand with one
technician removed, C smart triage, D capacity reallocation, E combined.
All five share the snapshot, horizon, demand profile and seeds."""
from __future__ import annotations

from dataclasses import dataclass

from app.core.timeutil import parse_iso
from app.simulation.parameters import ScenarioParameters
from app.simulation.workflow import ResourceSpec, parse_hhmm

DONOR_STAGES = ("triage", "verification", "intake")


@dataclass
class StressSettings:
    duration_hours: float = 8
    demand_multiplier: float = 2.0
    replications: int = 10
    seed: int = 42
    removed_resource_id: str | None = None
    capacity_source: str = "auto"  # auto | transfer | reserve
    transfer_count: int = 1
    donor_stage: str | None = None
    respect_shifts: bool = True
    # The autonomous monitor tests today's trajectory, so it keeps every technician.
    remove_technician: bool = True


def _working(r: dict) -> bool:
    return r["is_available"] and (not r["is_reserve"] or r["reserve_active"])


def _on_shift_now(r: dict, payload: dict) -> bool:
    start = parse_iso(payload["created_at"])
    minute = (start.hour * 60 + start.minute + payload["local_utc_offset_min"]) % 1440
    return ResourceSpec(r["id"], r["name"], r["stage"], frozenset(), parse_hhmm(r["shift_start"]),
                        parse_hhmm(r["shift_end"])).on_shift(minute)


def choose_removed_technician(snapshot_payload: dict) -> dict | None:
    """The available support technician carrying the most active work (ties: name)."""
    load: dict[str, int] = {}
    for t in snapshot_payload["tickets"]:
        if t["assigned_resource_id"]:
            load[t["assigned_resource_id"]] = load.get(t["assigned_resource_id"], 0) + 1
    techs = [r for r in snapshot_payload["resources"] if r["stage"] == "support" and _working(r) and not r["is_reserve"]]
    if not techs:
        return None
    # Prefer someone on shift now, so the loss is felt inside the simulated window.
    return sorted(techs, key=lambda r: (not _on_shift_now(r, snapshot_payload), -load.get(r["id"], 0), r["name"]))[0]


def choose_donors(snapshot_payload: dict, settings: StressSettings) -> tuple[str | None, list[dict]]:
    """Pick staff to move into technical support from the least-loaded other stage.
    The donor stage always keeps at least one available person."""
    resources = snapshot_payload["resources"]
    queues: dict[str, int] = {}
    for t in snapshot_payload["tickets"]:
        queues[t["stage"]] = queues.get(t["stage"], 0) + 1
    stages = [settings.donor_stage] if settings.donor_stage else list(DONOR_STAGES)
    best: tuple[float, str, list[dict]] | None = None
    for stage in stages:
        staff = [r for r in resources if r["stage"] == stage and _working(r) and not r["is_reserve"]]
        if settings.respect_shifts:
            staff = [r for r in staff if _on_shift_now(r, snapshot_payload)]
        eligible = sorted([r for r in staff if len(r["skills"]) >= 3], key=lambda r: (-len(r["skills"]), r["name"]))
        # The donor stage keeps at least one person on shift.
        movable = eligible[: max(0, min(settings.transfer_count, len(staff) - 1))]
        if not movable:
            continue
        pressure = queues.get(stage, 0) / max(1, len(staff))
        if best is None or pressure < best[0]:
            best = (pressure, stage, movable)
    return (best[1], best[2]) if best else (None, [])


def choose_reserves(snapshot_payload: dict, count: int) -> list[dict]:
    return [r for r in snapshot_payload["resources"] if r["is_reserve"] and not r["reserve_active"] and r["is_available"]][:count]


def build_scenarios(snapshot_payload: dict, s: StressSettings) -> tuple[list[tuple[str, str, ScenarioParameters, dict]], dict]:
    """Returns (key, label, parameters, change_spec) for A–E plus a description of the choices made."""
    removed = None
    if s.remove_technician:
        if s.removed_resource_id:
            removed = next((r for r in snapshot_payload["resources"] if r["id"] == s.removed_resource_id), None)
        else:
            removed = choose_removed_technician(snapshot_payload)
        if removed is None:
            raise ValueError("There is no available technical support technician to remove.")

    base = dict(duration_hours=s.duration_hours, replications=s.replications, seed=s.seed, respect_shifts=s.respect_shifts)
    failure = dict(base, demand_multiplier=s.demand_multiplier, removed_resource_ids=[removed["id"]] if removed else [])

    capacity_params: dict = {}
    capacity_spec: dict = {}
    donor_stage, donors, reserves = None, [], []
    if s.capacity_source not in ("auto", "transfer", "reserve"):
        raise ValueError("capacity_source must be auto, transfer or reserve.")
    if s.capacity_source == "reserve":
        reserves = choose_reserves(snapshot_payload, s.transfer_count)
        if reserves:
            capacity_params = {"activate_reserve_ids": [r["id"] for r in reserves]}
            capacity_spec = {"activate_reserves": [r["id"] for r in reserves]}
    if not capacity_params:
        donor_stage, donors = choose_donors(snapshot_payload, s)
        if donors:
            capacity_params = {"reallocations": [{"resource_id": r["id"], "to_stage": "support"} for r in donors]}
            capacity_spec = {"reallocations": [{"resource_id": r["id"], "from_stage": r["stage"], "to_stage": "support"} for r in donors]}
        elif s.capacity_source == "auto":
            reserves = choose_reserves(snapshot_payload, s.transfer_count)
            capacity_params = {"activate_reserve_ids": [r["id"] for r in reserves]} if reserves else {}
            capacity_spec = {"activate_reserves": [r["id"] for r in reserves]} if reserves else {}

    smart = {"routing_policy": "smart_triage", "skill_aware_routing": True}
    smart_spec = {"routing": {"policy": "smart_triage", "skill_aware": True}}
    scenarios = [
        ("A", "Normal baseline", ScenarioParameters(**base, demand_multiplier=1.0), {}),
        ("B", (f"Unmitigated failure: {s.demand_multiplier:g}x demand, {removed['name']} unavailable" if removed
               else f"Current trajectory: {s.demand_multiplier:g}x demand, no change"), ScenarioParameters(**failure), {}),
        ("C", "Smart triage", ScenarioParameters(**failure, **smart), smart_spec),
    ]
    if capacity_params:
        what = (f"move {', '.join(r['name'] for r in donors)} from {donor_stage} to technical support" if donors
                else f"activate reserve {', '.join(r['name'] for r in reserves)}")
        scenarios.append(("D", f"Capacity reallocation: {what}", ScenarioParameters(**failure, **capacity_params), capacity_spec))
        scenarios.append(("E", "Combined: smart triage and capacity reallocation",
                          ScenarioParameters(**failure, **smart, **capacity_params), {**smart_spec, **capacity_spec}))
    choices = {
        "removed_resource": {"id": removed["id"], "name": removed["name"]} if removed else {"id": None, "name": "nobody"},
        "donor_stage": donor_stage,
        "moved_resources": [{"id": r["id"], "name": r["name"], "from_stage": r["stage"]} for r in donors],
        "activated_reserves": [{"id": r["id"], "name": r["name"]} for r in reserves] if capacity_spec.get("activate_reserves") else [],
        "capacity_strategy_available": bool(capacity_params),
    }
    return scenarios, choices
