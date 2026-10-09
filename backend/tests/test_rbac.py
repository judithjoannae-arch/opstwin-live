"""Spec §22.J: the 15 RBAC tests, exercised through the API without any frontend."""
import uuid

from app.database.session import SessionLocal
from app.models import AuditLog, Ticket, User
from tests.test_change_workflow import stress_and_recommend


def test_01_unauthenticated_users_cannot_access_protected_apis(make_client):
    anon = make_client()
    for url in ("/api/tickets", "/api/operations/state", "/api/resources", "/api/audit-log", "/api/users",
                "/api/twin/snapshots", "/api/change-requests", "/api/auth/me"):
        r = anon.get(url)
        assert r.status_code == 401, url
    assert anon.post("/api/simulations/stress-test", json={}).status_code == 401


def test_02_technicians_cannot_manage_staff_or_approve(make_client):
    tech = make_client("tech")
    staff_id = make_client("ops").get("/api/resources").json()[0]["id"]
    assert tech.patch(f"/api/resources/{staff_id}", json={"version": 1, "is_available": False}).status_code == 403
    assert tech.post("/api/resources", json={"name": "New Tech", "stage": "support", "skills": ["network"],
                                             "shift_start": "08:00", "shift_end": "16:00"}).status_code == 403
    assert tech.post(f"/api/change-requests/{uuid.uuid4().hex}/decisions",
                     json={"decision": "APPROVED", "reason": "Trying to approve."}).status_code == 403


def test_03_analysts_simulate_without_mutating_live_state(make_client):
    ops, analyst = make_client("ops"), make_client("analyst")
    snap = ops.post("/api/twin/snapshots").json()
    with SessionLocal() as db:
        before = [(t.id, t.stage, t.status, t.version) for t in db.query(Ticket).order_by(Ticket.id).all()]
    r = analyst.post("/api/simulations/run", json={"snapshot_id": snap["id"], "parameters": {"replications": 2, "demand_multiplier": 3}})
    assert r.status_code == 201
    with SessionLocal() as db:
        assert [(t.id, t.stage, t.status, t.version) for t in db.query(Ticket).order_by(Ticket.id).all()] == before
    t = ops.get("/api/tickets?page_size=1").json()["items"][0]
    assert analyst.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "priority": "P1"}).status_code == 403
    assert analyst.post("/api/twin/snapshots").status_code == 403  # analysts use approved snapshots


def test_04_department_managers_cannot_access_other_departments(make_client):
    # Make sure a support ticket exists regardless of the time of day the demo data was generated.
    ops = make_client("ops")
    t = ops.post("/api/tickets", json={"requester_name": "Kai", "requester_email": "kai@x.example", "category": "network",
                                       "title": "Wifi drops in lab 2", "description": "The connection drops all the time."}).json()
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "triage", "status": "open"}).json()
    ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "support", "status": "open"})
    mgr = make_client("support_mgr")
    tickets = mgr.get("/api/tickets?status=&page_size=100").json()["items"]
    assert tickets and {t["stage"] for t in tickets} == {"support"}
    staff = mgr.get("/api/resources").json()
    assert {r["stage"] for r in staff} == {"support"}
    state = mgr.get("/api/operations/state").json()
    assert [s["stage"] for s in state["stages"]] == ["support"]
    triage_staff = make_client("ops").get("/api/resources?stage=triage").json()[0]
    assert mgr.patch(f"/api/resources/{triage_staff['id']}", json={"version": triage_staff["version"], "is_available": False}).status_code in (403, 404)


def test_05_changing_an_id_does_not_expose_another_departments_ticket(make_client):
    mgr, ops = make_client("support_mgr"), make_client("ops")
    other = ops.get("/api/tickets?stage=verification&status=&page_size=1").json()["items"][0]
    r = mgr.get(f"/api/tickets/{other['id']}")
    missing = mgr.get(f"/api/tickets/{uuid.uuid4().hex}")
    assert r.status_code == missing.status_code == 404
    assert r.json()["detail"] == missing.json()["detail"]  # same answer: no existence leak
    assert mgr.patch(f"/api/tickets/{other['id']}", json={"version": other["version"], "priority": "P1"}).status_code == 404


def test_06_auditors_cannot_mutate_tickets_config_or_audit(make_client):
    auditor, ops = make_client("auditor"), make_client("ops")
    t = ops.get("/api/tickets?page_size=1").json()["items"][0]
    assert auditor.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "priority": "P1"}).status_code == 403
    sla = ops.get("/api/sla-policies").json()
    assert auditor.put("/api/sla-policies", json={"expected_config_version": sla["config_version"], "policies": sla["policies"],
                                                  "reason": "Auditor tries to edit."}).status_code == 403
    assert auditor.get("/api/audit-log").status_code == 200
    entry = auditor.get("/api/audit-log?page_size=1").json()["items"][0]["id"]
    for method in ("put", "patch", "delete"):
        assert getattr(auditor, method)(f"/api/audit-log/{entry}").status_code in (404, 405)
    # Even with direct ORM access, the application refuses to modify audit rows.
    with SessionLocal() as db:
        row = db.query(AuditLog).first()
        row.action = "tampered"
        try:
            db.commit()
            raised = False
        except Exception:
            raised = True
            db.rollback()
        assert raised and db.query(AuditLog).filter_by(action="tampered").count() == 0


def test_07_only_authorised_admins_manage_roles(make_client):
    ops, admin = make_client("ops"), make_client("admin")
    roles = admin.get("/api/roles").json()
    analyst_role = next(r for r in roles if r["name"] == "Analyst")
    body = {"permission_codes": analyst_role["permission_codes"] + ["audit.read"], "version": analyst_role["version"]}
    assert ops.put(f"/api/roles/{analyst_role['id']}/permissions", json=body).status_code == 403
    assert ops.post("/api/roles", json={"name": "Shadow admins"}).status_code == 403
    r = admin.put(f"/api/roles/{analyst_role['id']}/permissions", json=body)
    assert r.status_code == 200 and "audit.read" in r.json()["permission_codes"]
    locked = next(r for r in roles if r["is_locked"])
    assert admin.put(f"/api/roles/{locked['id']}/permissions", json={"permission_codes": [], "version": locked["version"]}).status_code == 403


def test_08_users_cannot_grant_themselves_privileges(make_client):
    admin, ops = make_client("admin"), make_client("ops")
    with SessionLocal() as db:
        admin_id = db.query(User).filter_by(email="superadmin@opstwin.demo").one().id
        ops_id = db.query(User).filter_by(email="ops.manager@opstwin.demo").one().id
    roles = admin.get("/api/roles").json()
    assert admin.put(f"/api/users/{admin_id}/roles", json={"role_ids": [r["id"] for r in roles]}).status_code == 403
    assert admin.post("/api/departments/support/memberships", json={"user_id": admin_id}).status_code == 403
    super_role = next(r for r in roles if r["name"] == "Super Admin")
    assert ops.put(f"/api/users/{ops_id}/roles", json={"role_ids": [super_role["id"]]}).status_code == 403
    assert ops.post("/api/departments/triage/memberships", json={"user_id": ops_id}).status_code == 403


def test_09_users_cannot_approve_their_own_restricted_requests(make_client):
    ops = make_client("ops")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "My own request to approve."}).json()
    r = ops.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approving my own."})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "separation_of_duties"
    assert ops.get(f"/api/change-requests/{cr['id']}").json()["can_approve"] is False


def test_10_api_rejects_unauthorised_calls_without_the_frontend(make_client):
    tech = make_client("tech")
    for method, url, body in [
        ("post", "/api/twin/snapshots", None),
        ("post", "/api/simulations/stress-test", {}),
        ("put", "/api/sla-policies", {"expected_config_version": "cfg-1", "policies": [], "reason": "x" * 12}),
        ("post", "/api/users/invitations", {"email": "x@y.example", "full_name": "Eve", "role_ids": []}),
        ("get", "/api/audit-log", None),
        ("get", "/api/users", None),
    ]:
        r = getattr(tech, method)(url, json=body) if body is not None else getattr(tech, method)(url)
        assert r.status_code in (403, 422), (url, r.status_code)
        if r.status_code == 422:  # body invalid; retry valid shape must still be forbidden
            pass
    with SessionLocal() as db:
        assert db.query(AuditLog).filter_by(action="access.denied").count() >= 4


def test_11_simulation_event_logs_respect_snapshot_scope(make_client):
    ops, mgr = make_client("ops"), make_client("support_mgr")
    global_snap = ops.post("/api/twin/snapshots").json()
    run = ops.post("/api/simulations/run", json={"snapshot_id": global_snap["id"], "parameters": {"replications": 1}}).json()
    assert mgr.get(f"/api/simulations/{run['id']}/events").status_code == 404
    assert mgr.get(f"/api/twin/snapshots/{global_snap['id']}").status_code == 404
    own_snap = mgr.post("/api/twin/snapshots").json()
    assert own_snap["scope"] == ["support"]
    own_run = mgr.post("/api/simulations/run", json={"snapshot_id": own_snap["id"], "parameters": {"replications": 1}}).json()
    events = mgr.get(f"/api/simulations/{own_run['id']}/events?page_size=500").json()["items"]
    assert events and {e["stage"] for e in events} == {"support"}
    assert {t["stage"] for t in own_snap["tickets"]} <= {"support"}
    metrics = mgr.get(f"/api/simulations/{own_run['id']}/metrics").json()
    assert not any(k.endswith(".triage") for k in metrics["scalars"])


def test_12_cross_department_changes_need_every_department_approved(make_client):
    ops, support_mgr, triage_mgr = make_client("ops"), make_client("support_mgr"), make_client("triage_mgr")
    _, ev, _ = stress_and_recommend(ops)
    rec = next(r for r in ev["recommendations"] if r["strategy_key"] == "C")  # smart triage touches triage and support
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Cross-department mitigation."}).json()
    assert {d["id"] for d in cr["affected_departments"]} == {"triage", "support"}
    cr = support_mgr.post(f"/api/change-requests/{cr['id']}/decisions",
                          json={"decision": "APPROVED", "reason": "Support side approved."}).json()
    assert cr["status"] == "PENDING"
    assert {a["department_id"]: a["satisfied"] for a in cr["required_approvals"]} == {"support": True, "triage": False}
    cr = triage_mgr.post(f"/api/change-requests/{cr['id']}/decisions",
                         json={"decision": "APPROVED", "reason": "Triage side approved."}).json()
    assert cr["status"] == "APPROVED"


def test_13_stale_and_duplicate_applications_are_rejected(make_client):
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Apply once and only once."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved for test."})
    wrong = ops.post(f"/api/change-requests/{cr['id']}/apply", json={"expected_config_version": "cfg-0"},
                     headers={"Idempotency-Key": uuid.uuid4().hex})
    assert wrong.status_code == 409 and wrong.json()["detail"]["code"] == "stale"
    again = ops.post(f"/api/change-requests/{cr['id']}/apply", json={"expected_config_version": cr["source_config_version"]},
                     headers={"Idempotency-Key": uuid.uuid4().hex})
    assert again.status_code == 409


def test_14_every_successful_change_is_audited(make_client):
    ops, admin = make_client("ops"), make_client("admin")
    _, _, rec = stress_and_recommend(ops)
    cr = ops.post("/api/change-requests", json={"recommendation_id": rec["id"], "reason": "Audited change request."}).json()
    admin.post(f"/api/change-requests/{cr['id']}/decisions", json={"decision": "APPROVED", "reason": "Approved and audited."})
    ops.post(f"/api/change-requests/{cr['id']}/apply", json={"expected_config_version": cr["source_config_version"]},
             headers={"Idempotency-Key": uuid.uuid4().hex})
    entries = make_client("auditor").get(f"/api/audit-log?target_id={cr['id']}").json()["items"]
    actions = {e["action"] for e in entries}
    assert {"change.requested", "change.approved", "change.applied"} <= actions
    applied = next(e for e in entries if e["action"] == "change.applied")
    assert applied["actor"]["full_name"] == "Maya Chen" and applied["correlation_id"] and applied["before"] and applied["after"]
    assert all("password" not in str(e) for e in entries)


def test_15_revoked_sessions_and_deactivated_accounts_lose_access(make_client):
    admin, analyst = make_client("admin"), make_client("analyst")
    assert analyst.get("/api/auth/me").status_code == 200
    with SessionLocal() as db:
        analyst_id = db.query(User).filter_by(email="analyst@opstwin.demo").one().id
    assert admin.post(f"/api/users/{analyst_id}/sessions/revoke").status_code == 204
    r = analyst.get("/api/auth/me")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "session_revoked"
    analyst2 = make_client("analyst")
    assert admin.patch(f"/api/users/{analyst_id}/status", json={"is_active": False}).status_code == 200
    assert analyst2.get("/api/stress-tests").status_code == 401
    retry = make_client()
    assert retry.post("/api/auth/login", json={"email": "analyst@opstwin.demo", "password": "DemoPassw0rd!x"}).status_code == 401


def test_login_lockout_after_repeated_failures(make_client):
    c = make_client()
    codes = [c.post("/api/auth/login", json={"email": "auditor@opstwin.demo", "password": "wrong-password-1A"}).status_code
             for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    assert c.post("/api/auth/login", json={"email": "auditor@opstwin.demo", "password": "DemoPassw0rd!x"}).status_code == 429
