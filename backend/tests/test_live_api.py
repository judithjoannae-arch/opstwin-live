"""Spec §19 items 1-3 and 18: live website persistence, twin synchronisation, validation."""
from app.database.session import SessionLocal
from app.models import OperationalEvent, SimulatedEvent, Ticket

REQUEST = {"requester_name": "Student One", "requester_email": "s1@student.campus.example", "category": "network",
           "title": "Wi-Fi drops in the library", "description": "Connection drops every few minutes on floor 2."}


def test_ticket_from_website_is_persisted(make_client):  # 1
    public = make_client()
    r = public.post("/api/public/requests", json=REQUEST)
    assert r.status_code == 201
    ref = r.json()["reference"]
    with SessionLocal() as db:
        t = db.query(Ticket).filter(Ticket.number == int(ref[4:])).one()
        assert t.source == "web_form" and t.stage == "intake" and not t.is_demo
        assert db.query(OperationalEvent).filter_by(ticket_id=t.id, event_type="ticket.created").count() == 1
    ops = make_client("ops")
    found = ops.get(f"/api/tickets?q={ref}").json()
    assert found["total"] == 1 and found["items"][0]["reference"] == ref


def test_new_ticket_appears_in_next_snapshot(make_client):  # 2
    ops = make_client("ops")
    before = ops.post("/api/twin/snapshots").json()
    created = ops.post("/api/tickets", json=REQUEST).json()
    after = ops.post("/api/twin/snapshots").json()
    assert created["id"] not in {t["id"] for t in before["tickets"]}
    assert created["id"] in {t["id"] for t in after["tickets"]}
    assert after["ticket_count"] == before["ticket_count"] + 1


def test_real_and_simulated_events_are_stored_separately(make_client):  # 3
    ops = make_client("ops")
    with SessionLocal() as db:
        real_before = db.query(OperationalEvent).count()
    snap = ops.post("/api/twin/snapshots").json()
    run = ops.post("/api/simulations/run", json={"snapshot_id": snap["id"], "parameters": {"replications": 2}}).json()
    with SessionLocal() as db:
        assert db.query(OperationalEvent).count() == real_before  # simulating writes no real events
        assert db.query(SimulatedEvent).filter_by(run_id=run["id"]).count() > 0
    events = ops.get(f"/api/simulations/{run['id']}/events?page_size=5").json()
    assert all(e["data_origin"] == "simulated" for e in events["items"])
    live = ops.get("/api/events?page_size=200").json()["items"]
    assert not any(e["event_type"].isupper() for e in live)


def test_ticket_lifecycle_and_assignment_rules(make_client):
    ops = make_client("ops")
    t = ops.post("/api/tickets", json=REQUEST).json()
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "triage", "status": "open"}).json()
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "support", "status": "open"}).json()
    staff = ops.get("/api/resources?stage=support").json()
    unskilled = next(r for r in staff if "network" not in r["skills"] and r["is_available"] and not r["is_reserve"])
    r = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "assigned_resource_id": unskilled["id"]})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "skill_mismatch"
    r = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "support", "status": "in_progress"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "assignee_required"
    skilled = next(r for r in staff if "network" in r["skills"] and r["is_available"] and not r["is_reserve"])
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "assigned_resource_id": skilled["id"]}).json()
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "status": "in_progress"}).json()
    r = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "verification", "status": "resolved"})
    assert r.json()["detail"]["code"] == "note_required"
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "verification", "status": "resolved",
                                                   "note": "Replaced the access point."}).json()
    assert t["stage"] == "verification" and t["status"] == "resolved" and t["assigned_resource"] is None
    stale = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"] - 1, "status": "closed"})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "version_conflict"
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "status": "closed"}).json()
    assert t["status"] == "closed" and t["closed_at"]
    kinds = [h["event_type"] for h in t["history"]]
    assert kinds.count("ticket.stage_changed") == 3 and "ticket.assigned" in kinds


def test_invalid_requests_get_clear_errors(make_client):  # 18
    ops = make_client("ops")
    assert ops.post("/api/tickets", json={**REQUEST, "category": "plumbing"}).status_code == 422
    assert ops.post("/api/tickets", json={**REQUEST, "requester_email": "nope"}).status_code == 422
    t = ops.post("/api/tickets", json=REQUEST).json()
    bad = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "verification", "status": "closed"})
    assert bad.status_code == 409 and bad.json()["detail"]["code"] == "invalid_transition"
    snap = ops.post("/api/twin/snapshots").json()
    r = ops.post("/api/simulations/run", json={"snapshot_id": snap["id"], "parameters": {"replications": 99}})
    assert r.status_code == 422
    r = ops.post("/api/simulations/run", json={"snapshot_id": snap["id"], "parameters": {"removed_resource_ids": ["ghost"]}})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "unknown_resource"
    assert ops.get("/api/tickets/does-not-exist").status_code == 404


def test_state_changes_require_csrf_token(make_client):
    ops = make_client("ops")
    r = ops.c.post("/api/tickets", json=REQUEST)  # no X-CSRF-Token header
    assert r.status_code == 403 and r.json()["detail"]["code"] == "csrf_failed"


def test_public_form_is_rate_limited(make_client):
    public = make_client()
    codes = [public.post("/api/public/requests", json=REQUEST).status_code for _ in range(11)]
    assert codes[:10] == [201] * 10 and codes[10] == 429


def test_dashboard_never_invents_metrics_without_data(make_client, fresh_db):
    from app.database.session import Base, engine
    from app.seed import init_reference_data

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        init_reference_data(db)
        from app.core.security import hash_password
        from app.models import Role, User

        u = User(email="solo@x.example", full_name="Solo", password_hash=hash_password("DemoPassw0rd!x"))
        u.roles.append(db.query(Role).filter_by(name="Operations Manager").one())
        db.add(u)
        db.commit()
    c = make_client()
    assert c.post("/api/auth/login", json={"email": "solo@x.example", "password": "DemoPassw0rd!x"}).status_code == 204
    s = c.get("/api/operations/state").json()
    assert s["sla"]["compliance_pct"] is None and s["throughput"]["per_hour"] is None and s["oldest_unresolved"] is None


def test_requester_can_track_their_request_only_with_the_right_email(make_client):
    public = make_client()
    ref = public.post("/api/public/requests", json=REQUEST).json()["reference"]
    r = public.post("/api/public/requests/lookup", json={"reference": ref, "email": REQUEST["requester_email"].upper()})
    assert r.status_code == 200
    body = r.json()
    assert body["reference"] == ref and body["step"] == 0 and "waiting to be reviewed" in body["progress"]
    assert "requester_email" not in body and "assigned_resource" not in body  # nothing internal leaks
    wrong_email = public.post("/api/public/requests/lookup", json={"reference": ref, "email": "someone@else.example"})
    unknown = public.post("/api/public/requests/lookup", json={"reference": "TCK-999999", "email": REQUEST["requester_email"]})
    assert wrong_email.status_code == unknown.status_code == 404
    assert wrong_email.json() == unknown.json()  # same answer: references can't be probed

    ops = make_client("ops")
    t = ops.get(f"/api/tickets?q={ref}").json()["items"][0]
    ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "triage", "status": "open"})
    moved = public.post("/api/public/requests/lookup", json={"reference": ref, "email": REQUEST["requester_email"]}).json()
    assert moved["step"] == 1 and "reviewing" in moved["progress"]
