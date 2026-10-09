"""Spec §19 items 14-17 and the end-to-end integration test."""
import uuid

from app.database.session import SessionLocal
from app.models import AuditLog, ConfigVersion, Resource


def stress_and_recommend(api):
    st = api.post("/api/simulations/stress-test", json={"replications": 4, "respect_shifts": False}).json()
    ev = api.post("/api/recommendations/evaluate",
                  json={"stress_test_id": st["id"], "constraints": {"max_ending_backlog": 500, "min_p1_sla_compliance_pct": 0,
                                                                    "min_sla_compliance_pct": 0, "min_throughput_ratio": 0,
                                                                    "max_mean_wait_min": 10000, "max_stage_wait_increase_min": 10000,
                                                                    "min_feasible_share": 0}}).json()
    feasible = [r for r in ev["recommendations"] if r["feasible"] and not r["is_no_action"]]
    assert feasible, ev["outcome"]
    return st, ev, next((r for r in feasible if r["selected"]), feasible[0])


def apply(api, cr, key=None, version=None):
    return api.post(f"/api/change-requests/{cr['id']}/apply", json={"expected_config_version": version or cr["source_config_version"]},
                    headers={"Idempotency-Key": key or uuid.uuid4().hex})


def test_end_to_end_ticket_to_applied_change(make_client):
    public, support_mgr, ops = make_client(), make_client("support_mgr"), make_client("ops")
    ref = public.post("/api/public/requests", json={"requester_name": "Kai", "requester_email": "kai@student.campus.example",
                                                     "category": "network", "title": "Lab network down",
                                                     "description": "No connectivity in lab 3 since 9am."}).json()["reference"]
    _, _, rec = stress_and_recommend(ops)
    snap = ops.get(f"/api/twin/snapshots/{rec['evidence']['snapshot_id']}").json()
    assert ref in {t["reference"] for t in snap["tickets"]}
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Mitigate the forecast backlog."}).json()
    assert cr["status"] == "PENDING"
    # Separation of duties: the requester can't approve their own request.
    own = ops.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Looks good to me."})
    assert own.status_code == 403 and own.json()["detail"]["code"] == "separation_of_duties"
    admin = make_client("admin")
    cr = admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Evidence is convincing."}).json()
    assert cr["status"] == "APPROVED"
    before = ops.get("/api/config/versions").json()[0]["version"]
    r = apply(ops, cr)
    assert r.status_code == 200 and r.json()["status"] == "APPLIED"
    after = ops.get("/api/config/versions").json()[0]
    assert after["version"] != before and after["source"] == "approved_change" and after["change_request_id"] == cr["id"]
    # The twin refreshes from the new configuration.
    snap2 = ops.post("/api/twin/snapshots").json()
    assert snap2["config_version"] == after["version"]
    for row in cr["config_diff"]:
        if row["path"].startswith("routing."):
            assert snap2["config"]["routing"][row["path"].split(".")[1]] == row["after"]
    assert support_mgr.get(f"/api/change-requests/{cr['id']}").status_code == 200


def test_approved_change_updates_real_configuration_and_audit(make_client):  # 14
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Apply the selected mitigation."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved after review."})
    assert apply(ops, cr).status_code == 200
    with SessionLocal() as db:
        latest = db.query(ConfigVersion).order_by(ConfigVersion.number.desc()).first()
        assert latest.change_request_id == cr["id"]
        for row in rec["config_diff"]:
            if row["path"].startswith("staffing.allocation."):
                name = row["path"].split(".", 2)[2]
                assert db.query(Resource).filter_by(name=name).one().stage == row["after"]
        actions = {a.action for a in db.query(AuditLog).filter(AuditLog.target_id == cr["id"]).all()}
        assert {"change.requested", "change.approved", "change.applied"} <= actions
        applied = db.query(AuditLog).filter_by(target_id=cr["id"], action="change.applied").one()
        assert applied.before and applied.after and applied.before != applied.after


def test_unapproved_change_cannot_be_applied(make_client):  # 15
    ops = make_client("ops")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Try to skip approval."}).json()
    r = apply(ops, cr)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_approved"
    with SessionLocal() as db:
        assert db.query(ConfigVersion).filter(ConfigVersion.change_request_id == cr["id"]).count() == 0


def test_stale_recommendation_cannot_overwrite_newer_configuration(make_client):  # 16
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Apply the mitigation later."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved for later."})
    sla = ops.get("/api/sla-policies").json()
    pols = sla["policies"]
    pols[3]["resolution_minutes"] += 60
    assert ops.put("/api/sla-policies", json={"expected_config_version": sla["config_version"], "policies": pols,
                                              "reason": "Extend P4 target for exams week."}).status_code == 200
    r = apply(ops, cr)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stale"
    assert ops.get(f"/api/change-requests/{cr['id']}").json()["status"] == "STALE"
    r = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Retry with the old evidence."})
    assert r.status_code == 409


def test_duplicate_application_is_rejected_and_idempotent(make_client):
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Apply exactly once please."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved, apply once."})
    key = uuid.uuid4().hex
    first = apply(ops, cr, key)
    again_same_key = apply(ops, cr, key)
    assert first.status_code == again_same_key.status_code == 200
    other_key = apply(ops, cr)
    assert other_key.status_code == 409 and other_key.json()["detail"]["code"] == "already_applied"
    with SessionLocal() as db:
        assert db.query(ConfigVersion).filter(ConfigVersion.change_request_id == cr["id"]).count() == 1


def test_exported_report_matches_stored_results(make_client):  # 17
    ops = make_client("ops")
    snap = ops.post("/api/twin/snapshots").json()
    run = ops.post("/api/simulations/run", json={"snapshot_id": snap["id"], "parameters": {"replications": 3}}).json()
    report = ops.get(f"/api/reports/{run['id']}/export").json()
    stored = ops.get(f"/api/simulations/{run['id']}/metrics").json()
    assert report["run"]["metrics"]["scalars"] == stored["scalars"]
    assert report["data_origin"] == "simulated" and report["assumptions"]
    csv_text = ops.get(f"/api/reports/{run['id']}/export?format=csv").text
    line = next(l for l in csv_text.splitlines() if l.startswith("throughput_per_hour,"))
    assert float(line.split(",")[2]) == stored["scalars"]["throughput_per_hour"]["mean"]


def test_prediction_monitor_tracks_applied_change(make_client):
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Monitor the prediction."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved for monitoring."})
    apply(ops, cr)
    rows = ops.get("/api/prediction-monitor").json()
    assert rows[0]["change_request_id"] == cr["id"]
    assert rows[0]["status"] == "insufficient_data"  # just applied: too early to compare
    assert all(m["error"] is None for m in rows[0]["metrics"])
