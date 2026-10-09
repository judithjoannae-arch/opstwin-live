"""Database initialisation and the clearly labelled campus IT demonstration data.

    python -m app.seed                      # tables, permissions, roles, departments, SLA, config v1
    python -m app.seed --demo               # + demo staff, demo accounts and 72 h of synthetic history
    python -m app.seed --create-admin EMAIL # first Super Admin (password from OPSTWIN_ADMIN_PASSWORD)
    python -m app.seed --reset --demo       # drop everything first (development only)
    python -m app.seed --import-tickets ../sample_data/sample_tickets.csv   # load labelled sample tickets

Demo account passwords come from OPSTWIN_DEMO_PASSWORD, or are generated and printed once.
No credentials are hardcoded.
"""
from __future__ import annotations

import argparse
import os
import random
import secrets
import string
import sys
from collections import defaultdict
from datetime import timedelta

from sqlalchemy.orm import Session

from app.core.security import hash_password, validate_password_strength
from app.core.timeutil import local_offset, utcnow
from app.database.session import Base, SessionLocal, engine
from app.models import (
    Department,
    DepartmentMembership,
    OperationalEvent,
    Permission,
    Resource,
    Role,
    RolePermission,
    SlaPolicy,
    Ticket,
    TicketStatusHistory,
    User,
)
from app.services import config_service
from app.services.sequences import next_value
from app.services.snapshots import DEFAULT_CATEGORY_MIX, DEFAULT_PRIORITY_MIX, DEFAULT_PROFILE, DEFAULT_SERVICE
from app.services.tickets import STAGE_LABELS, STATUS_LABELS
from app.simulation import events as ev
from app.simulation.engine import run_replication
from app.simulation.workflow import ResourceSpec, ServiceDist, WorkflowModel, parse_hhmm

DEPARTMENTS = [("intake", "Request intake"), ("triage", "Triage"), ("support", "Technical support"), ("verification", "Verification and closure")]

PERMISSIONS = [
    ("users.read", "View user accounts", "People"),
    ("users.manage", "Manage user accounts and department memberships", "People"),
    ("roles.manage", "Manage roles and permissions", "People"),
    ("departments.manage", "Manage departments", "Departments"),
    ("dashboard.global.read", "View the global operations dashboard", "Dashboards"),
    ("tickets.read", "View tickets", "Tickets"),
    ("tickets.create", "Create tickets", "Tickets"),
    ("tickets.update", "Update tickets", "Tickets"),
    ("tickets.assign", "Assign tickets", "Tickets"),
    ("resources.read", "View resources and staffing", "Resources and staffing"),
    ("resources.manage", "Change resources and staffing", "Resources and staffing"),
    ("snapshots.create", "Create digital twin snapshots", "Digital twin"),
    ("simulations.run", "Run simulations", "Digital twin"),
    ("simulations.read", "View simulation results", "Digital twin"),
    ("recommendations.read", "View recommendations", "Digital twin"),
    ("changes.request", "Request operational changes", "Operational changes"),
    ("changes.approve", "Approve or reject operational changes", "Operational changes"),
    ("changes.apply", "Apply approved changes", "Operational changes"),
    ("reports.read", "View reports", "Reports"),
    ("reports.export", "Export reports", "Reports"),
    ("audit.read", "View audit logs", "Audit"),
    ("policies.manage", "Configure operational and approval policies", "Policies"),
]
ALL = [p[0] for p in PERMISSIONS]

# role -> (description, locked, {permission: scope})
ROLES: dict[str, tuple[str, bool, dict[str, str]]] = {
    "Super Admin": ("Full administrative access, including users, roles and RBAC policy.", True, {p: "global" for p in ALL}),
    "Operations Manager": ("Runs operations across all departments; approves and applies operational changes.", False, {
        **{p: "global" for p in ["dashboard.global.read", "tickets.read", "tickets.create", "tickets.update", "tickets.assign",
                                 "resources.read", "resources.manage", "snapshots.create", "simulations.run", "simulations.read",
                                 "recommendations.read", "changes.request", "changes.approve", "changes.apply", "reports.read",
                                 "reports.export", "audit.read", "policies.manage"]},
    }),
    "Department Manager": ("Manages the queues and staff of their own departments.", False, {
        **{p: "department" for p in ["tickets.read", "tickets.create", "tickets.update", "tickets.assign", "resources.read",
                                     "resources.manage", "snapshots.create", "simulations.run", "simulations.read",
                                     "recommendations.read", "changes.request", "changes.approve", "changes.apply",
                                     "reports.read", "reports.export", "audit.read"]},
    }),
    "Technician": ("Works assigned tickets in their department.", False, {
        "tickets.read": "department", "tickets.update": "assigned",
    }),
    "Analyst": ("Analyses operations and runs what-if simulations without changing live data.", False, {
        **{p: "global" for p in ["simulations.run", "simulations.read", "recommendations.read", "reports.read", "reports.export"]},
    }),
    "Auditor": ("Read-only access to audit trails, approvals, configuration history and simulation records.", False, {
        **{p: "global" for p in ["audit.read", "simulations.read", "recommendations.read", "reports.read", "reports.export"]},
    }),
}

# name, stage, skills, shift, reserve
DEMO_STAFF = [
    ("Priya Nair", "intake", "all", ("07:00", "19:00"), False),
    ("Owen Clarke", "intake", "all", ("19:00", "07:00"), False),
    ("Tom Okafor", "triage", "all", ("07:00", "15:00"), False),
    ("Mei Lin", "triage", "all", ("09:00", "17:00"), False),
    ("Ibrahim Musa", "triage", "all", ("11:00", "19:00"), False),
    ("Sam Reyes", "triage", "all", ("19:00", "07:00"), False),
    ("Ravi Kumar", "support", ["network", "hardware", "critical_infrastructure"], ("08:00", "16:00"), False),
    ("Ana Souza", "support", ["software", "account"], ("08:00", "16:00"), False),
    ("Jonas Weber", "support", ["network", "software", "account"], ("10:00", "18:00"), False),
    ("Fatima Haddad", "support", ["hardware", "software", "critical_infrastructure", "account"], ("12:00", "20:00"), False),
    ("Leo Martin", "support", ["network", "account", "software", "hardware"], ("16:00", "00:00"), False),
    ("Grace Kim", "support", ["network", "account", "software", "critical_infrastructure"], ("00:00", "08:00"), False),
    ("Lena Park", "support", ["network", "hardware", "software", "critical_infrastructure"], ("00:00", "00:00"), True),
    ("Dev Patel", "verification", "all", ("08:00", "17:00"), False),
    ("Clara Jensen", "verification", "all", ("12:00", "20:00"), False),
    ("Nora Ali", "verification", "all", ("17:00", "08:00"), False),
]
# The demo service desk runs at a sustainable load; the stress test doubles it.
DEMO_DEMAND_SCALE = 0.6
CATS = ["account", "network", "software", "hardware", "critical_infrastructure"]

DEMO_USERS = [
    ("superadmin@opstwin.demo", "Alex Morgan", "Super Admin", []),
    ("ops.manager@opstwin.demo", "Maya Chen", "Operations Manager", []),
    ("support.manager@opstwin.demo", "Daniel Osei", "Department Manager", ["support"]),
    ("triage.manager@opstwin.demo", "Sofia Rossi", "Department Manager", ["triage"]),
    ("technician@opstwin.demo", "Ravi Kumar", "Technician", ["support"]),
    ("analyst@opstwin.demo", "Hana Sato", "Analyst", []),
    ("auditor@opstwin.demo", "Peter Lindqvist", "Auditor", []),
]

TITLES = {
    "account": ["Locked out after password change", "MFA prompt never arrives", "Can't sign in to the student portal",
                "Password reset link expired", "Email account shows wrong name"],
    "network": ["Library Wi-Fi drops every few minutes", "No internet in lecture hall B", "VPN won't connect from home",
                "Eduroam rejects my credentials", "Very slow network in residence block C"],
    "software": ["Request MATLAB install on lab PC", "Email client crashes on startup", "Licence error in statistics software",
                 "Teams meetings won't start", "Printer driver missing after update"],
    "hardware": ["Projector in room B204 shows no signal", "Laptop won't charge", "Lab PC 14 won't boot",
                 "Classroom microphone not working", "Monitor flickering in office 3.12"],
    "critical_infrastructure": ["Core switch in Engineering block unreachable", "Authentication service timing out",
                                "Storage array alarm in data centre", "Exam platform unavailable", "DNS failures across campus"],
}
NAMES = ["Aisha", "Ben", "Chloe", "Diego", "Elif", "Farah", "Gabriel", "Hiro", "Isla", "Jamal", "Kofi", "Lucia", "Mateo",
         "Nadia", "Oscar", "Paula", "Quinn", "Rosa", "Samir", "Tara", "Umar", "Vera", "Wen", "Yusuf", "Zoe"]


def init_reference_data(db: Session) -> None:
    for i, (did, name) in enumerate(DEPARTMENTS):
        if db.get(Department, did) is None:
            db.add(Department(id=did, name=name, position=i))
    for code, desc, group in PERMISSIONS:
        if db.get(Permission, code) is None:
            db.add(Permission(code=code, description=desc, group=group))
    db.flush()
    for name, (desc, locked, perms) in ROLES.items():
        if db.query(Role).filter(Role.name == name).first() is None:
            role = Role(name=name, description=desc, is_locked=locked)
            db.add(role)
            db.flush()
            for code, scope in perms.items():
                db.add(RolePermission(role_id=role.id, permission_code=code, scope=scope))
    for pri, v in config_service.DEFAULT_SLA.items():
        if db.get(SlaPolicy, pri) is None:
            db.add(SlaPolicy(priority=pri, **v))
    db.flush()
    if not db.query(config_service.ConfigVersion).first():
        config_service.create_version(db, config=config_service.DEFAULT_CONFIG, source="seed",
                                      summary="Initial configuration: FIFO routing, default SLA targets", created_by=None)
    db.commit()


def _password(env_name: str) -> tuple[str, bool]:
    pw = os.getenv(env_name)
    if pw:
        problem = validate_password_strength(pw)
        if problem:
            sys.exit(f"{env_name} is too weak: {problem}")
        return pw, False
    alphabet = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(16))
        if validate_password_strength(pw) is None:
            return pw, True


def create_admin(db: Session, email: str, full_name: str = "Administrator") -> str | None:
    pw, generated = _password("OPSTWIN_ADMIN_PASSWORD")
    if db.query(User).filter(User.email == email.lower()).first():
        sys.exit(f"{email} already exists.")
    role = db.query(Role).filter(Role.name == "Super Admin").one()
    user = User(email=email.lower(), full_name=full_name, password_hash=hash_password(pw))
    user.roles.append(role)
    db.add(user)
    db.commit()
    return pw if generated else None


def _history_model(start, resources: list[Resource], hours: float) -> WorkflowModel:
    specs = [
        ResourceSpec(r.id, r.name, r.stage, frozenset(r.skills), parse_hhmm(r.shift_start), parse_hhmm(r.shift_end))
        for r in resources if not r.is_reserve
    ]
    return WorkflowModel(
        start=start, local_offset_min=int(local_offset().total_seconds() // 60), horizon_min=hours * 60,
        arrival_profile=[x * DEMO_DEMAND_SCALE for x in DEFAULT_PROFILE], category_mix=dict(DEFAULT_CATEGORY_MIX),
        priority_mix={c: dict(v) for c, v in DEFAULT_PRIORITY_MIX.items()},
        sla_resolution={k: v["resolution_minutes"] for k, v in config_service.DEFAULT_SLA.items()},
        service={s: {c: ServiceDist(*v) for c, v in cats.items()} for s, cats in DEFAULT_SERVICE.items()},
        service_multipliers={}, resources=specs, tickets=[], routing_policy="fifo", skill_aware=False,
        transfer_rate=0.12, rework_rate=0.07,
    )


def seed_demo(db: Session, hours: float = 72, seed: int = 2026) -> dict:
    """Synthetic, clearly labelled history generated by the same event-driven engine the twin uses."""
    if db.query(Resource).filter(Resource.is_demo.is_(True)).first():
        return {"skipped": True}
    staff: list[Resource] = []
    for name, stage, skills, (s, e), reserve in DEMO_STAFF:
        r = Resource(name=name, stage=stage, skills=list(CATS) if skills == "all" else list(skills), shift_start=s, shift_end=e,
                     is_reserve=reserve, is_available=True, is_demo=True)
        db.add(r)
        staff.append(r)
    db.flush()
    by_name = {r.name: r for r in staff}

    pw, generated = _password("OPSTWIN_DEMO_PASSWORD")
    pw_hash = hash_password(pw)
    roles = {r.name: r for r in db.query(Role).all()}
    for email, name, role, depts in DEMO_USERS:
        if db.query(User).filter(User.email == email).first():
            continue
        u = User(email=email, full_name=name, password_hash=pw_hash)
        u.roles.append(roles[role])
        db.add(u)
        db.flush()
        for d in depts:
            db.add(DepartmentMembership(user_id=u.id, department_id=d))
        if role == "Technician" and name in by_name:
            by_name[name].user_id = u.id

    now = utcnow()
    start = now - timedelta(hours=hours)
    result = run_replication(_history_model(start, staff, hours), seed, record_events=True)
    _materialise_history(db, result, start, staff, seed)
    db.commit()
    return {"password": pw if generated else None, "tickets": db.query(Ticket).count()}


def _materialise_history(db: Session, result, start, staff: list[Resource], seed: int) -> None:
    rng = random.Random(seed)
    res_by_id = {r.id: r for r in staff}
    sla = {k: v["resolution_minutes"] for k, v in config_service.DEFAULT_SLA.items()}
    per_ticket: dict[str, list] = defaultdict(list)
    for e in result.events:
        if e.ticket_ref:
            per_ticket[e.ticket_ref].append(e)
    sim_by_ref = {t.ref: t for t in result.tickets}
    at = lambda minute: start + timedelta(minutes=minute)  # noqa: E731

    for ref in sorted(per_ticket, key=lambda r: sim_by_ref[r].created):
        st = sim_by_ref[ref]
        evs = per_ticket[ref]
        created = at(st.created)
        name = rng.choice(NAMES)
        original_priority = next((e.detail.split()[-1] for e in evs if e.event_type == ev.ARRIVAL), st.priority)
        t = Ticket(
            number=next_value(db, "ticket"), title=rng.choice(TITLES[st.true_category]),
            description="Synthetic demonstration ticket generated for the campus IT demo environment.",
            category=st.true_category, priority=original_priority, stage="intake", status="open", requester_name=name,
            requester_email=f"{name.lower()}.{rng.randint(100, 999)}@student.campus.example", source="seed",
            created_at=created, updated_at=created, stage_entered_at=created,
            sla_deadline=created + timedelta(minutes=sla[original_priority]), is_demo=True,
        )
        db.add(t)
        db.flush()

        def log(etype, when, summary, **kw):
            db.add(OperationalEvent(occurred_at=when, event_type=etype, ticket_id=t.id, stage=kw.pop("stage", t.stage),
                                    summary=summary, is_demo=True, **kw))

        def move(when, to_stage, to_status, note=None):
            if to_stage != t.stage:
                log("ticket.stage_changed", when, f"Moved from {STAGE_LABELS[t.stage]} to {STAGE_LABELS[to_stage]}",
                    from_value=STAGE_LABELS[t.stage], to_value=STAGE_LABELS[to_stage], note=note if to_status == t.status else None)
            if to_status != t.status:
                log("ticket.status_changed", when, f"Status changed from {STATUS_LABELS[t.status]} to {STATUS_LABELS[to_status]}",
                    stage=to_stage, from_value=STATUS_LABELS[t.status], to_value=STATUS_LABELS[to_status], note=note)
            db.add(TicketStatusHistory(ticket_id=t.id, from_stage=t.stage, to_stage=to_stage, from_status=t.status,
                                       to_status=to_status, changed_at=when))
            if to_stage != t.stage:
                t.stage, t.stage_entered_at = to_stage, when
                t.assigned_resource_id, t.service_started_at = None, None
            t.status = to_status
            t.updated_at = when

        log("ticket.created", created, "Ticket submitted through the request form (demo)")
        for e in evs:
            when = at(e.minute)
            if e.event_type == ev.SERVICE_START and e.resource_id in res_by_id:
                r = res_by_id[e.resource_id]
                t.assigned_resource_id = r.id
                log("ticket.assigned", when, f"Assigned to {r.name}", resource_id=r.id, to_value=r.name)
                if e.stage == "support":
                    move(when, "support", "in_progress")
                t.service_started_at = when
            elif e.event_type == ev.TRANSFER:
                log("ticket.assigned", when, "Returned to the queue for a technician with the right skills",
                    from_value=res_by_id[e.resource_id].name if e.resource_id in res_by_id else None, to_value="Unassigned")
                t.assigned_resource_id, t.service_started_at = None, None
                move(when, "support", "open", note="Needs a different specialist")
            elif e.event_type == ev.SERVICE_COMPLETE:
                if e.stage == "intake":
                    move(when, "triage", "open")
                elif e.stage == "triage":
                    move(when, "support", "open")
                elif e.stage == "support":
                    move(when, "verification", "resolved", note="Fixed and tested with the requester (demo)")
                    t.resolved_at = when
            elif e.event_type == ev.REWORK:
                move(when, "support", "open", note="Verification failed: issue still reproducible (demo)")
                t.rework_count += 1
                t.resolved_at = None
            elif e.event_type == ev.TICKET_CLOSED:
                move(when, "verification", "closed")
                t.closed_at = when
            elif e.event_type == ev.PRIORITY_ESCALATED:
                old, new = e.detail.split(" to ")
                if t.status not in ("closed", "resolved"):
                    log("ticket.priority_changed", when, f"Priority changed from {old} to {new} (automatic escalation)",
                        from_value=old, to_value=new)
                    t.priority = new
                    t.sla_deadline = t.created_at + timedelta(minutes=sla[new])


def import_tickets(db: Session, path: str) -> int:
    """Load sample tickets from CSV. They are synthetic, so they're stored with is_demo=True."""
    import csv

    from app.services.tickets import create_ticket

    count = 0
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["category"] not in CATS:
                raise SystemExit(f"Unknown category {row['category']!r} in {path}")
            created = utcnow() - timedelta(minutes=float(row.get("created_minutes_ago") or 0))
            # The CSV's priority column is ignored: priority is always calculated (impact x urgency).
            create_ticket(db, title=row["title"][:160], description=row["description"], category=row["category"],
                          requester_name=row["requester_name"],
                          requester_email=row["requester_email"].lower(), source="seed", actor_id=None,
                          created_at=created, is_demo=True)
            count += 1
    db.commit()
    return count


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", action="store_true", help="add demo staff, demo accounts and synthetic history")
    parser.add_argument("--reset", action="store_true", help="drop all tables first (development only)")
    parser.add_argument("--create-admin", metavar="EMAIL")
    parser.add_argument("--hours", type=float, default=72, help="hours of synthetic history (default 72)")
    parser.add_argument("--import-tickets", metavar="CSV", help="load sample tickets (stored as demo data)")
    args = parser.parse_args(argv)

    from app.core.config import settings

    if args.reset:
        if not settings.is_development:
            sys.exit("--reset is only allowed when OPSTWIN_ENV=development")
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        init_reference_data(db)
        print("Reference data ready: departments, permissions, roles, SLA policies, configuration cfg-1.")
        if args.create_admin:
            pw = create_admin(db, args.create_admin)
            print(f"Created Super Admin {args.create_admin}.")
            if pw:
                print(f"Generated password (shown once): {pw}")
        if args.demo:
            out = seed_demo(db, hours=args.hours)
            if out.get("skipped"):
                print("Demo data already present; nothing added.")
            else:
                print(f"Demo environment ready: {out['tickets']} synthetic tickets, {len(DEMO_STAFF)} staff, {len(DEMO_USERS)} demo accounts.")
                print("Demo accounts: " + ", ".join(u[0] for u in DEMO_USERS))
                if out["password"]:
                    print(f"Generated demo password (shown once; set OPSTWIN_DEMO_PASSWORD to choose your own): {out['password']}")
                else:
                    print("Demo password: the value of OPSTWIN_DEMO_PASSWORD.")
        if args.import_tickets:
            print(f"Imported {import_tickets(db, args.import_tickets)} sample tickets (labelled as demo data).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
