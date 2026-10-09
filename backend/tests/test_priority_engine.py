"""Priority is calculated (impact x urgency), never chosen by a person."""
from app.ai.priority import assess
from app.database.session import SessionLocal
from app.models import TicketAssessment

FORM = {"requester_name": "Kai Tanaka", "requester_email": "kai@student.campus.example"}


def test_matrix_is_consistent_and_explained():
    assert assess("Exam platform down", "error for all students", "critical_infrastructure", False)["priority"] == "P1"
    assert assess("Need SPSS installed", "for my statistics course", "software", False)["priority"] == "P4"
    single = assess("Wifi keeps dropping", "connection drops every few minutes", "network", False)
    many = assess("Wifi keeps dropping", "connection drops every few minutes", "network", True)
    assert single["priority"] > many["priority"]  # "P4" > "P2": more people affected means higher priority
    assert many["impact"] == "high" and many["reasons"]
    # Same input, same output: no person-to-person variation.
    assert assess("Locked out", "before my exam", "account", False) == assess("Locked out", "before my exam", "account", False)


def test_new_tickets_get_a_calculated_priority_with_reasons(make_client):
    public = make_client()
    ref = public.post("/api/public/requests", json={**FORM, "category": "critical_infrastructure", "title": "Exam platform down",
                                                    "description": "Every student in hall C sees an error page."}).json()["reference"]
    ops = make_client("ops")
    t = ops.get(f"/api/tickets?q={ref}").json()["items"][0]
    assert t["priority"] == "P1"
    with SessionLocal() as db:
        row = db.get(TicketAssessment, t["id"])
        assert row.impact == "high" and row.urgency == "high" and row.reasons
    panel = ops.get(f"/api/ai/triage/{t['id']}").json()
    assert panel["priority_assessment"]["priority"] == "P1" and panel["priority_assessment"]["recorded"] is True


def test_nobody_can_set_priority_by_hand(make_client):
    ops = make_client("ops")
    assert ops.post("/api/tickets", json={**FORM, "category": "software", "priority": "P1", "title": "Need SPSS installed",
                                          "description": "for my statistics course please"}).status_code == 422
    t = ops.post("/api/tickets", json={**FORM, "category": "software", "title": "Need SPSS installed",
                                       "description": "for my statistics course please"}).json()
    assert t["priority"] == "P4"
    r = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "priority": "P1"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "priority_automatic"
    admin = make_client("admin")
    assert admin.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "priority": "P1"}).status_code == 400


def test_correcting_the_category_recalculates_priority(make_client):
    ops = make_client("ops")
    t = ops.post("/api/tickets", json={**FORM, "category": "hardware", "title": "Backup jobs failing",
                                       "description": "Nightly backups on the main file server keep failing."}).json()
    before = t["priority"]
    t = ops.patch(f"/api/tickets/{t['id']}", json={"version": t["version"], "category": "critical_infrastructure"}).json()
    assert t["priority"] == "P2" and t["priority"] != before
    assert any(h["event_type"] == "ticket.priority_changed" and "Recalculated automatically" in (h["note"] or "") for h in t["history"])


def test_affects_many_people_raises_priority_for_staff_created_tickets(make_client):
    ops = make_client("ops")
    base = {**FORM, "category": "network", "title": "Wifi keeps dropping", "description": "The connection drops every few minutes."}
    one = ops.post("/api/tickets", json=base).json()
    many = ops.post("/api/tickets", json={**base, "affects_many_users": True}).json()
    assert many["priority"] < one["priority"]
