"""Spec §19 items 4-10: the event-driven engine."""
from app.simulation import events as ev
from app.simulation.engine import Simulator, run_replication
from app.simulation.metrics import aggregate, replication_metrics
from tests.toy_model import model, res


def mean_of(m, rate=4.0, reps=6, **kw):
    return aggregate([replication_metrics(run_replication(model(rate=rate, **kw), 100 + i)) for i in range(reps)])["scalars"][m]["mean"]


def test_same_seed_and_snapshot_reproduce_results():  # 4
    a = replication_metrics(run_replication(model(), 11, record_events=True))
    b = replication_metrics(run_replication(model(), 11, record_events=True))
    assert a["scalars"] == b["scalars"]
    assert a["series"] == b["series"]
    assert replication_metrics(run_replication(model(), 12))["scalars"] != a["scalars"]


def test_demand_spike_grows_queues_and_waits_under_constrained_capacity():  # 5
    assert mean_of("mean_wait_min", rate=8.0) > mean_of("mean_wait_min", rate=4.0) * 1.5
    assert mean_of("max_backlog", rate=8.0) > mean_of("max_backlog", rate=4.0)


def test_removing_a_resource_reduces_effective_capacity():  # 6
    full = mean_of("utilization_pct.support", rate=6.0)
    reduced = run_replication(model(rate=6.0, removed={"s3"}), 101)
    assert "s3" not in {r for r in reduced.capable_minutes}  # aggregated by stage, sanity
    assert mean_of("mean_wait_min", rate=6.0, removed={"s3"}) > mean_of("mean_wait_min", rate=6.0)
    assert full is not None


def test_capacity_reallocation_costs_the_donor_stage():  # 7
    moved = [res("i1", "intake"), res("t1", "triage"), res("t2", "support"), res("s1", "support"), res("s2", "support"),
             res("s3", "support"), res("v1", "verification")]
    donor_before = mean_of("stage_mean_wait_min.triage", rate=6.0)
    donor_after = mean_of("stage_mean_wait_min.triage", rate=6.0, res_list=moved)
    support_before = mean_of("stage_mean_wait_min.support", rate=6.0)
    support_after = mean_of("stage_mean_wait_min.support", rate=6.0, res_list=moved)
    assert donor_after > donor_before
    assert support_after < support_before


def test_existing_work_stays_in_the_simulation():  # 8
    r = run_replication(model(rate=0.0), 5, record_events=True)
    refs = {t.ref for t in r.tickets}
    assert {"TCK-000001", "TCK-000002", "TCK-000003"} <= refs
    assert r.initial_backlog == 3
    closed = {e.ticket_ref for e in r.events if e.event_type == ev.TICKET_CLOSED}
    assert "TCK-000001" in closed  # in-progress work continues to completion


def test_unfinished_work_is_carried_over_not_dropped():
    r = run_replication(model(rate=12.0, horizon=120), 3)
    in_system = sum(1 for t in r.tickets if t.closed is None)
    assert in_system == len(r.unfinished) > 0


def test_critical_priority_is_served_first_under_priority_policy():  # 9
    fifo = mean_of("p1_mean_wait_min", rate=7.0, policy="fifo")
    prio = mean_of("p1_mean_wait_min", rate=7.0, policy="priority")
    assert prio < fifo


def test_queues_never_negative_and_no_double_service():  # 10
    sim = Simulator(model(rate=9.0, removed={"s2"}, unavailability=[("s1", 60, 180)]), 9, record_events=True)
    r = sim.run()
    for point in r.series:
        assert all(q >= 0 for q in point["queue"].values())
        assert all(n >= 0 for n in point["in_service"].values())
    serving: dict[str, str] = {}
    for e in r.events:
        if e.event_type == ev.SERVICE_START:
            assert e.ticket_ref not in serving, "ticket served by two resources at once"
            serving[e.ticket_ref] = e.resource_id
        elif e.event_type in (ev.SERVICE_COMPLETE, ev.TRANSFER, ev.SERVICE_INTERRUPTED):
            serving.pop(e.ticket_ref, None)
    completes = [e for e in r.events if e.event_type == ev.TICKET_CLOSED]
    assert len(completes) == len({e.ticket_ref for e in completes})


def test_unavailable_worker_takes_no_new_work():
    r = run_replication(model(rate=8.0, unavailability=[("s1", 60, 240)]), 4, record_events=True)
    starts = [e for e in r.events if e.event_type == ev.SERVICE_START and e.resource_id == "s1" and 60 < e.minute < 240]
    assert starts == []
    assert any(e.event_type == ev.RESOURCE_RECOVERY and e.resource_id == "s1" for e in r.events)


def test_every_simulated_event_has_the_required_fields():
    r = run_replication(model(), 2, record_events=True)
    for e in r.events[:500]:
        assert e.event_type in ev.ALL_TYPES and e.minute >= 0
    arrivals = [e for e in r.events if e.event_type == ev.ARRIVAL]
    assert arrivals and all(e.ticket_ref and e.stage == "intake" for e in arrivals)


def test_breaches_before_the_snapshot_do_not_count_against_any_strategy():
    from app.simulation.workflow import TicketSpec
    from tests.toy_model import existing

    already_breached = TicketSpec("x9", "TCK-000009", "critical_infrastructure", "P1", "support", "open", -400, -60, -300, None, None)
    m = replication_metrics(run_replication(model(rate=0.0, tickets=existing() + [already_breached]), 3))["scalars"]
    assert m["breached_before_start"] == 1
    # The only P1 in the window is the old breach, so there is nothing to score.
    assert m["p1_sla_compliance_pct"] is None
