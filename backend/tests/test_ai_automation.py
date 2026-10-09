"""AI triage assistant and autonomous monitor."""
from app.ai import monitor
from app.database.session import SessionLocal
from app.models import AiPrediction, AuditLog, ChangeRequest, MonitorRun, Ticket, TwinSnapshot

FORM = {"requester_name": "Kai Tanaka", "requester_email": "kai@student.campus.example"}


def ticket_by_ref(ref):
    with SessionLocal() as db:
        return db.query(Ticket).filter(Ticket.number == int(ref[4:])).one()


def enable(admin, **over):
    body = {"auto_intake": True, "category_threshold": 0.6, "priority_threshold": 0.6, "monitor_enabled": False,
            "monitor_interval_minutes": 10, "surge_threshold": 1.5, **over}
    r = admin.put("/api/ai/settings", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_classifier_predicts_with_confidence_and_evidence(make_client):
    ops = make_client("ops")
    r = ops.post("/api/ai/classify", json={"title": "Cannot connect to the internet in lab 3", "description": "wifi down for the class"})
    body = r.json()
    assert r.status_code == 200 and body["category"]["label"] == "network"
    assert 0 < body["category"]["confidence"] <= 1 and body["category"]["evidence"]
    assert body["priority"]["priority"] in {"P1", "P2", "P3", "P4"} and body["priority"]["reasons"]
    r = ops.post("/api/ai/classify", json={"title": "Exam platform down for everyone", "description": "all students see errors"})
    assert r.json()["category"]["label"] == "critical_infrastructure"


def test_every_new_ticket_gets_a_recorded_suggestion_but_nothing_changes_while_off(make_client):
    public = make_client()
    ref = public.post("/api/public/requests", json={**FORM, "category": "hardware", "title": "Wifi keeps dropping in the library",
                                                    "description": "The wireless connection drops every few minutes."}).json()["reference"]
    t = ticket_by_ref(ref)
    assert t.stage == "intake" and t.category == "hardware"  # auto-intake is off by default
    with SessionLocal() as db:
        p = db.query(AiPrediction).filter_by(ticket_id=t.id).one()
        assert p.action == "suggested" and p.predicted_category == "network"


def test_auto_intake_corrects_category_and_moves_confident_tickets(make_client):
    admin, public = make_client("admin"), make_client()
    enable(admin)
    ref = public.post("/api/public/requests", json={**FORM, "category": "hardware", "title": "Wifi keeps dropping in the library",
                                                    "description": "Wireless network connection drops every few minutes, eduroam."}).json()["reference"]
    t = ticket_by_ref(ref)
    assert t.stage == "triage" and t.category == "network"
    with SessionLocal() as db:
        assert db.query(AuditLog).filter_by(action="ai.auto_intake", target_id=t.id).count() == 1
        p = db.query(AiPrediction).filter_by(ticket_id=t.id).one()
        assert p.submitted_category == "hardware" and p.predicted_category == "network"  # requester's choice is kept
    tracked = public.post("/api/public/requests/lookup", json={"reference": ref, "email": FORM["requester_email"]}).json()
    assert tracked["step"] == 1


def test_unsure_tickets_are_left_for_a_person(make_client):
    admin, public = make_client("admin"), make_client()
    enable(admin, category_threshold=0.99)
    ref = public.post("/api/public/requests", json={**FORM, "category": "software", "title": "Something odd happened",
                                                    "description": "Not sure what is going on here really."}).json()["reference"]
    t = ticket_by_ref(ref)
    assert t.stage == "intake"
    with SessionLocal() as db:
        assert db.query(AiPrediction).filter_by(ticket_id=t.id).one().action == "left_for_human"


def test_triage_panel_and_category_correction_rules(make_client):
    ops = make_client("ops")
    t = ops.post("/api/tickets", json={**FORM, "category": "hardware", "title": "VPN will not connect from home",
                                       "description": "stuck authenticating on the vpn client"}).json()
    panel = ops.get(f"/api/ai/triage/{t['id']}").json()
    assert panel["category"]["label"] == "network" and panel["category_mismatch"] is True
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "category": "network"}).json()
    assert t["category"] == "network"
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "triage", "status": "open"}).json()
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "stage": "support", "status": "open"}).json()
    locked = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "category": "hardware"})
    assert locked.status_code == 400 and locked.json()["detail"]["code"] == "category_locked"


def test_only_policy_managers_change_ai_settings(make_client):
    analyst, tech = make_client("analyst"), make_client("tech")
    body = {"auto_intake": True, "category_threshold": 0.7, "priority_threshold": 0.5, "monitor_enabled": True,
            "monitor_interval_minutes": 5, "surge_threshold": 1.5}
    assert analyst.put("/api/ai/settings", json=body).status_code == 403
    assert tech.put("/api/ai/settings", json=body).status_code == 403
    assert make_client("ops").put("/api/ai/settings", json=body).status_code == 200


def test_monitor_does_nothing_when_operations_are_healthy(make_client, monkeypatch):
    make_client("ops")
    monkeypatch.setattr(monitor, "assess", lambda db: {"recent_rate": 2.0, "expected_rate": 2.1, "surge": 0.95,
                                                        "bottlenecks": [], "watch": [], "overdue": 0})
    with SessionLocal() as db:
        snapshots_before = db.query(TwinSnapshot).count()
    run = monitor.run_check("manual")
    assert run.outcome == "healthy"
    with SessionLocal() as db:
        assert db.query(TwinSnapshot).count() == snapshots_before


def test_monitor_detects_a_surge_simulates_and_proposes_without_applying(make_client):
    ops = make_client("ops")
    for i in range(14):  # a burst of real tickets in the last two hours
        ops.post("/api/tickets", json={**FORM, "category": "network", "title": f"No network in lab {i}",
                                       "description": "None of the PCs can connect."})
    r = ops.post("/api/ai/monitor/check").json()
    assert r["findings"]["surge"] >= 1.5
    assert r["outcome"] in {"risk_recommended", "risk_no_safe_option", "risk_resolves"}
    assert r["snapshot_id"] and r["stress_test_id"] and r["evaluation_id"]
    with SessionLocal() as db:
        cfg_changes = db.query(AuditLog).filter_by(action="change.applied").count()
    assert cfg_changes == 0  # the monitor never applies anything
    if r["outcome"] == "risk_recommended":
        with SessionLocal() as db:
            cr = db.get(ChangeRequest, r["change_request_id"])
            assert cr.status == "PENDING" and cr.requester.email == monitor.MONITOR_EMAIL
        again = ops.post("/api/ai/monitor/check").json()
        assert again["outcome"] == "skipped"  # no duplicate proposals
        # A person can approve the monitor's proposal (separation of duties holds: the requester is the monitor).
        approved = make_client("admin").post(f"/api/change-requests/{r['change_request_id']}/decisions",
                                             json={"decision": "APPROVED", "reason": "Monitor evidence checked."}).json()
        assert approved["status"] == "APPROVED"
    with SessionLocal() as db:
        assert db.query(MonitorRun).count() >= 1


def test_monitor_account_cannot_sign_in(make_client):
    with SessionLocal() as db:
        monitor.monitor_user(db)
        db.commit()
    c = make_client()
    assert c.post("/api/auth/login", json={"email": monitor.MONITOR_EMAIL, "password": "anything-Goes1"}).status_code == 401


def test_model_card_reports_training_and_accuracy(make_client):
    card = make_client("ops").get("/api/ai/model").json()
    assert card["starter_examples"] > 50 and card["history_examples"] > 0
    assert card["cross_validated"]["category_accuracy_pct"] is not None
    assert "No external AI service" in card["algorithm"]


def test_a_failing_ai_never_loses_the_ticket(make_client, monkeypatch):
    from app.ai import service

    def broken(*_a, **_k):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(service, "classify", broken)
    public = make_client()
    r = public.post("/api/public/requests", json={**FORM, "category": "network", "title": "Wifi keeps dropping in the library",
                                                  "description": "The wireless connection drops every few minutes."})
    assert r.status_code == 201
    assert ticket_by_ref(r.json()["reference"]).stage == "intake"
