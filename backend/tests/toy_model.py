from datetime import datetime

from app.simulation.workflow import ResourceSpec, ServiceDist, TicketSpec, WorkflowModel

CATS = ["account", "network", "software", "hardware", "critical_infrastructure"]
SERVICE = {
    "intake": {c: ServiceDist(4, 0.5) for c in CATS},
    "triage": {c: ServiceDist(8, 0.6) for c in CATS},
    "support": {c: ServiceDist(m, 0.7) for c, m in zip(CATS, [20, 35, 30, 45, 60])},
    "verification": {c: ServiceDist(6, 0.5) for c in CATS},
}


def res(rid, stage, skills=CATS):
    return ResourceSpec(rid, rid, stage, frozenset(skills), 0, 0)


def resources():
    return [res("i1", "intake"), res("t1", "triage"), res("t2", "triage"), res("s1", "support"), res("s2", "support"),
            res("s3", "support"), res("v1", "verification")]


def existing():
    return [
        TicketSpec("x1", "TCK-000001", "network", "P2", "support", "in_progress", -60, 420, -50, -30, "s1"),
        TicketSpec("x2", "TCK-000002", "account", "P3", "triage", "open", -20, 1400, -10, None, None),
        TicketSpec("x3", "TCK-000003", "hardware", "P3", "support", "open", -90, 1350, -40, None, None),
    ]


def model(rate=4.0, horizon=480, removed=None, policy="fifo", skill=False, res_list=None, tickets=None, **kw):
    return WorkflowModel(
        start=datetime(2026, 10, 9, 9, 0), local_offset_min=0, horizon_min=horizon,
        arrival_profile=[rate] * 24, category_mix={c: 1 for c in CATS},
        priority_mix={c: {"P1": 0.15, "P2": 0.25, "P3": 0.45, "P4": 0.15} for c in CATS},
        sla_resolution={"P1": 240, "P2": 480, "P3": 1440, "P4": 4320}, service=SERVICE, service_multipliers={},
        resources=res_list if res_list is not None else resources(), tickets=tickets if tickets is not None else existing(),
        routing_policy=policy, skill_aware=skill, removed=set(removed or []), **kw,
    )
