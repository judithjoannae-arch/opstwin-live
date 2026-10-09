"""Deterministic, explainable recommendation engine (spec §10).

1. Check every mitigation (C, D, E) against hard constraints. Infeasible ones are rejected.
2. Keep the Pareto-efficient feasible strategies.
3. Select by a fixed rule: highest SLA compliance; within 1 point, the lower P95 wait;
   within 5 %, the lower disruption (then cost, when cost assumptions are given).
4. If nothing is feasible, recommend no action and say why.
"""
from __future__ import annotations

from app.recommendations.constraints import Check, Constraints, evaluate
from app.recommendations.pareto import pareto_front

STAGE_NAMES = {"intake": "Request intake", "triage": "Triage", "support": "Technical support", "verification": "Verification and closure"}

COMPARED = [
    ("throughput_per_hour", "Completed per hour", 1),
    ("mean_wait_min", "Mean waiting time", -1),
    ("p95_wait_min", "95th percentile wait", -1),
    ("max_backlog", "Peak backlog", -1),
    ("ending_backlog", "Backlog at the end", -1),
    ("sla_compliance_pct", "SLA compliance", 1),
    ("sla_violations", "SLA violations", -1),
    ("p1_sla_compliance_pct", "Critical (P1) SLA compliance", 1),
    ("p1_mean_wait_min", "Critical (P1) mean wait", -1),
    ("unfinished", "Unfinished tickets", -1),
    ("recovery_time_min", "Recovery time", -1),
]


def _m(metrics: dict, name: str):
    s = metrics["scalars"].get(name)
    return None if s is None else s["mean"]


def expected_changes(strategy: dict, failure: dict, normal: dict) -> list[dict]:
    rows = []
    names = [*COMPARED, *[(f"stage_mean_wait_min.{s}", f"Mean wait in {STAGE_NAMES[s]}", -1) for s in STAGE_NAMES],
             *[(f"utilization_pct.{s}", f"Utilization of {STAGE_NAMES[s]}", 0) for s in STAGE_NAMES]]
    for name, label, direction in names:
        v, b, a = _m(strategy, name), _m(failure, name), _m(normal, name)
        delta = None if v is None or b is None else round(v - b, 2)
        sc = strategy["scalars"].get(name, {})
        rows.append({
            "metric": name, "label": label, "unit": sc.get("unit"),
            "normal_baseline": a, "failure_baseline": b, "strategy": v, "delta_vs_failure": delta,
            "delta_pct_vs_failure": None if delta is None or not b else round(100 * delta / abs(b), 1),
            "better": None if delta is None or direction == 0 or abs(delta) < 1e-9 else (delta * direction > 0),
            "ci": [sc.get("ci_low"), sc.get("ci_high")],
        })
    return rows


def disruption(spec: dict) -> int:
    score = 0
    if spec.get("routing"):
        score += 1
    score += 2 * len(spec.get("reallocations", []))
    score += 2 * len(spec.get("activate_reserves", []))
    return score


def cost(spec: dict, hours: float, c: Constraints) -> float | None:
    if c.cost_per_reserve_hour is None and c.cost_per_transfer_hour is None:
        return None
    total = 0.0
    total += len(spec.get("activate_reserves", [])) * hours * (c.cost_per_reserve_hour or 0)
    total += len(spec.get("reallocations", [])) * hours * (c.cost_per_transfer_hour or 0)
    return round(total, 2)


def config_diff(spec: dict, config: dict, resources: dict[str, dict]) -> list[dict]:
    rows = []
    routing = config.get("routing", {})
    if "routing" in spec:
        for k, v in spec["routing"].items():
            if routing.get(k) != v:
                rows.append({"path": f"routing.{k}", "before": routing.get(k), "after": v})
    for r in spec.get("reallocations", []):
        name = resources.get(r["resource_id"], {}).get("name", r["resource_id"])
        rows.append({"path": f"staffing.allocation.{name}", "before": r["from_stage"], "after": r["to_stage"]})
    for rid in spec.get("activate_reserves", []):
        name = resources.get(rid, {}).get("name", rid)
        rows.append({"path": f"staffing.reserve.{name}", "before": "inactive", "after": "active"})
    return rows


def affected_departments(spec: dict) -> list[str]:
    stages = set()
    if spec.get("routing"):
        stages |= {"triage", "support"}
    for r in spec.get("reallocations", []):
        stages |= {r["from_stage"], r["to_stage"]}
    if spec.get("activate_reserves"):
        stages.add("support")
    return [s for s in STAGE_NAMES if s in stages]


def _benefits_drawbacks(changes: list[dict], strategy: dict, failure: dict, key: str, spec: dict) -> tuple[list[str], list[str]]:
    benefits, drawbacks = [], []
    for row in changes:
        if row["better"] is None or row["delta_pct_vs_failure"] is None or abs(row["delta_pct_vs_failure"]) < 5:
            continue
        unit = row["unit"] or ""
        text = f"{row['label']}: {row['failure_baseline']:.1f} → {row['strategy']:.1f} {unit}".rstrip()
        (benefits if row["better"] else drawbacks).append(text)
    if spec.get("routing"):
        drawbacks.append("Triage takes about 15% longer per ticket to classify and route more carefully (assumed)")
    if spec.get("reallocations"):
        drawbacks.append("The donor stage loses capacity for the whole period")
    return benefits[:8], drawbacks[:8]


def build_cards(*, runs: dict[str, dict], specs: dict[str, dict], labels: dict[str, str], run_ids: dict[str, str],
                constraints: Constraints, config: dict, resources: dict[str, dict], hours: float,
                stress_test_id: str, snapshot_id: str, config_version: str) -> tuple[list[dict], str | None, str]:
    normal, failure = runs["A"], runs["B"]
    checks: dict[str, list[Check]] = {}
    feasible: dict[str, bool] = {}
    for key in [k for k in ("B", "C", "D", "E") if k in runs]:
        cs = evaluate(runs[key], normal, failure, constraints)
        checks[key] = cs
        feasible[key] = all(c.passed and c.pass_share >= constraints.min_feasible_share for c in cs)

    mitigations = [k for k in ("C", "D", "E") if k in runs]
    feasible_set = {k: runs[k] for k in mitigations if feasible[k]}
    front = pareto_front(feasible_set) if feasible_set else set()

    def sort_key(k):
        return (-(_m(runs[k], "sla_compliance_pct") or 0), _m(runs[k], "p95_wait_min") or 1e9, disruption(specs[k]))

    selected = None
    if front:
        ranked = sorted(front, key=sort_key)
        selected = ranked[0]
        for other in ranked[1:]:  # prefer less disruption when outcomes are practically equal
            a, b = runs[selected], runs[other]
            close_sla = abs((_m(a, "sla_compliance_pct") or 0) - (_m(b, "sla_compliance_pct") or 0)) <= 1.0
            pa, pb = _m(a, "p95_wait_min") or 0, _m(b, "p95_wait_min") or 0
            close_wait = abs(pa - pb) <= 0.05 * max(pa, pb, 1)
            if close_sla and close_wait:
                ca, cb = cost(specs[selected], hours, constraints), cost(specs[other], hours, constraints)
                if (disruption(specs[other]), cb or 0) < (disruption(specs[selected]), ca or 0):
                    selected = other

    cards = []
    for key in mitigations + ["B"]:
        m = runs[key]
        spec = specs.get(key, {})
        changes = expected_changes(m, failure, normal)
        benefits, drawbacks = _benefits_drawbacks(changes, m, failure, key, spec) if key != "B" else ([], [])
        failed = [c for c in checks[key] if not (c.passed and c.pass_share >= constraints.min_feasible_share)]
        if key == "B":
            explanation = ("Doing nothing: this is the failure baseline every mitigation is compared with. "
                           + ("It already meets every constraint." if feasible[key] else
                              "It breaks: " + "; ".join(c.message() for c in failed) + "."))
        elif not feasible[key]:
            explanation = "Rejected because it breaks a hard constraint: " + "; ".join(
                c.message() if not c.passed else
                f"{c.label} is within the limit on average but holds in only {c.pass_share:.0%} of replications "
                f"(at least {constraints.min_feasible_share:.0%} required)" for c in failed) + "."
        elif key not in front:
            dominators = [k for k in front if k != key]
            explanation = f"Feasible, but another feasible strategy ({', '.join(dominators)}) is at least as good on every compared metric."
        elif key == selected:
            explanation = (
                f"Selected: every constraint holds in at least {min(c.pass_share for c in checks[key]):.0%} of replications, "
                f"Pareto-efficient, and it has the highest SLA compliance ({_m(m, 'sla_compliance_pct'):.1f}%) among the "
                f"efficient options, with a P95 wait of {_m(m, 'p95_wait_min'):.0f} min."
                + (" Chosen over an equally good option because it disrupts less." if len(front) > 1 else "")
            )
        else:
            explanation = "Feasible and Pareto-efficient, but the selected strategy has better SLA compliance or shorter tail waits."
        c_val = cost(spec, hours, constraints)
        cards.append({
            "strategy_key": key,
            "title": labels[key],
            "is_no_action": key == "B",
            "feasible": feasible[key],
            "pareto_efficient": key in front,
            "selected": key == selected,
            "explanation": explanation,
            "constraint_checks": [c.as_dict() for c in checks[key]],
            "expected_changes": changes,
            "benefits": benefits,
            "drawbacks": drawbacks,
            "affected_departments": [{"id": s, "name": STAGE_NAMES[s]} for s in affected_departments(spec)],
            "config_diff": config_diff(spec, config, resources) if key != "B" else [],
            "disruption_score": disruption(spec),
            "estimated_cost": c_val,
            "approval_required": key != "B",
            "evidence": {
                "stress_test_id": stress_test_id, "snapshot_id": snapshot_id, "config_version": config_version,
                "strategy_run_id": run_ids[key], "failure_run_id": run_ids["B"], "normal_run_id": run_ids["A"],
                "replications": m["replications"],
                "variability": {k: {"std": m["scalars"][k]["std"], "ci": [m["scalars"][k]["ci_low"], m["scalars"][k]["ci_high"]]}
                                for k in ("throughput_per_hour", "mean_wait_min", "sla_compliance_pct", "ending_backlog")},
            },
            "assumptions": [
                "Results are simulated predictions from the snapshot, not observed outcomes.",
                "All strategies use the same snapshot, demand profile, horizon and random seeds.",
                "Smart-triage effects and misrouting rates are assumed values (see Model assumptions).",
            ],
            "uncertainty": f"{m['replications']} replications; ranges are 95% intervals (normal approximation).",
            "change_spec": spec,
        })

    if selected:
        outcome = f"Recommend strategy {selected}: {labels[selected]}."
    else:
        outcome = ("No action recommended: every available mitigation breaks at least one hard constraint. "
                   "Review the constraints or consider options outside this stress test.")
    return cards, selected, outcome
