"""Users, roles, permissions and department memberships (Super Admin area)."""
from __future__ import annotations

from collections import Counter
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.security import new_token, token_hash
from app.core.timeutil import iso, utcnow
from app.database.session import get_db
from app.models import Department, DepartmentMembership, Invitation, Permission, Role, RolePermission, User, UserRole, UserSession
from app.services import audit
from app.services.authz import Principal, require

router = APIRouter(tags=["admin"])


def user_out(u: User) -> dict:
    return {
        "id": u.id, "email": u.email, "full_name": u.full_name, "is_active": u.is_active,
        "invitation_pending": u.invitation_pending,
        "roles": [{"id": r.id, "name": r.name, "is_locked": r.is_locked} for r in u.roles],
        "departments": [{"id": m.department_id, "name": m.department.name} for m in u.memberships],
        "last_login_at": iso(u.last_login_at), "created_at": iso(u.created_at),
    }


def role_out(db: Session, r: Role) -> dict:
    count = db.query(func.count()).select_from(UserRole).filter(UserRole.role_id == r.id).scalar()
    return {"id": r.id, "name": r.name, "description": r.description, "is_locked": r.is_locked,
            "permission_codes": sorted(p.permission_code for p in r.permissions), "user_count": count, "version": r.version}


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    full_name: str = Field(min_length=2, max_length=120)
    role_ids: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Enter a valid email address")
        return v


class StatusIn(BaseModel):
    is_active: bool


class RolesIn(BaseModel):
    role_ids: list[str] = Field(max_length=10)


class RoleCreateIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field("", max_length=500)


class RolePermissionsIn(BaseModel):
    permission_codes: list[str] = Field(max_length=100)
    version: int


class MemberIn(BaseModel):
    user_id: str


def _get_user(db: Session, user_id: str) -> User:
    u = db.get(User, user_id)
    if u is None:
        raise not_found("That user")
    return u


def _not_self(principal: Principal, user_id: str, what: str) -> None:
    if principal.id == user_id:
        audit.record_standalone(actor_id=principal.id, action="admin.self_change_blocked", target_type="user",
                                target_id=user_id, outcome="DENIED", details={"attempted": what})
        raise forbidden(f"You can't change your own {what}. Ask another administrator.")


@router.get("/users")
def list_users(search: str = "", page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
               principal: Principal = Depends(require("users.read", "users.manage", any_of=True, global_only=True)),
               db: Session = Depends(get_db)):
    q = db.query(User)
    if search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(or_(User.full_name.ilike(like), User.email.ilike(like)))
    total = q.count()
    rows = q.order_by(User.full_name).offset((page - 1) * page_size).limit(page_size).all()
    return {"items": [user_out(u) for u in rows], "total": total}


@router.post("/users/invitations", status_code=201)
def invite(body: InviteIn, principal: Principal = Depends(require("users.manage", global_only=True)), db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == body.email).first():
        raise conflict("email_taken", "An account with that email already exists.")
    roles = db.query(Role).filter(Role.id.in_(body.role_ids)).all()
    if len(roles) != len(set(body.role_ids)):
        raise bad_request("One of the roles doesn't exist.")
    u = User(email=body.email, full_name=body.full_name.strip(), invitation_pending=True, is_active=True)
    u.roles.extend(roles)
    db.add(u)
    db.flush()
    token = new_token()
    db.add(Invitation(user_id=u.id, token_hash=token_hash(token), expires_at=utcnow() + timedelta(hours=72)))
    audit.record(db, actor_id=principal.id, action="user.invited", target_type="user", target_id=u.id,
                 after={"email": u.email, "roles": [r.name for r in roles]})
    db.commit()
    out = user_out(u)
    if settings.is_development:
        # No email service locally: hand the single-use link to the admin in development only.
        out["invitation_url"] = f"/accept-invitation?token={token}"
    return out


@router.patch("/users/{user_id}/status")
def set_status(user_id: str, body: StatusIn, principal: Principal = Depends(require("users.manage", global_only=True)),
               db: Session = Depends(get_db)):
    _not_self(principal, user_id, "account status")
    u = _get_user(db, user_id)
    before = u.is_active
    u.is_active = body.is_active
    if not body.is_active:
        db.query(UserSession).filter(UserSession.user_id == u.id, UserSession.revoked_at.is_(None)).update({"revoked_at": utcnow()})
    audit.record(db, actor_id=principal.id, action="user.activated" if body.is_active else "user.deactivated",
                 target_type="user", target_id=u.id, before={"is_active": before}, after={"is_active": u.is_active})
    db.commit()
    return user_out(u)


@router.put("/users/{user_id}/roles")
def set_roles(user_id: str, body: RolesIn, principal: Principal = Depends(require("users.manage", global_only=True)),
              db: Session = Depends(get_db)):
    _not_self(principal, user_id, "roles")
    u = _get_user(db, user_id)
    roles = db.query(Role).filter(Role.id.in_(body.role_ids)).all()
    if len(roles) != len(set(body.role_ids)):
        raise bad_request("One of the roles doesn't exist.")
    if any(r.is_locked for r in roles) and not principal.is_global("roles.manage"):
        raise forbidden("Only administrators who manage roles can grant protected roles.")
    before = sorted(r.name for r in u.roles)
    u.roles = roles
    audit.record(db, actor_id=principal.id, action="user.roles.changed", target_type="user", target_id=u.id,
                 before={"roles": before}, after={"roles": sorted(r.name for r in roles)})
    db.commit()
    return user_out(u)


@router.post("/users/{user_id}/sessions/revoke", status_code=204)
def revoke_user_sessions(user_id: str, principal: Principal = Depends(require("users.manage", global_only=True)),
                         db: Session = Depends(get_db)):
    _get_user(db, user_id)
    n = db.query(UserSession).filter(UserSession.user_id == user_id, UserSession.revoked_at.is_(None)).update({"revoked_at": utcnow()})
    audit.record(db, actor_id=principal.id, action="user.sessions.revoked", target_type="user", target_id=user_id, details={"count": n})
    db.commit()


@router.get("/roles")
def list_roles(principal: Principal = Depends(require("roles.manage", "users.manage", any_of=True, global_only=True)),
               db: Session = Depends(get_db)):
    return [role_out(db, r) for r in db.query(Role).order_by(Role.name).all()]


@router.post("/roles", status_code=201)
def create_role(body: RoleCreateIn, principal: Principal = Depends(require("roles.manage", global_only=True)), db: Session = Depends(get_db)):
    if db.query(Role).filter(func.lower(Role.name) == body.name.strip().lower()).first():
        raise conflict("role_exists", "A role with that name already exists.")
    r = Role(name=body.name.strip(), description=body.description.strip() or None)
    db.add(r)
    db.flush()
    audit.record(db, actor_id=principal.id, action="role.created", target_type="role", target_id=r.id, after={"name": r.name})
    db.commit()
    return role_out(db, r)


@router.put("/roles/{role_id}/permissions")
def set_role_permissions(role_id: str, body: RolePermissionsIn,
                         principal: Principal = Depends(require("roles.manage", global_only=True)), db: Session = Depends(get_db)):
    r = db.get(Role, role_id)
    if r is None:
        raise not_found("That role")
    if r.is_locked:
        raise forbidden("This is a protected system role.")
    if any(ur.id == r.id for ur in principal.user.roles):
        audit.record_standalone(actor_id=principal.id, action="role.self_edit_blocked", target_type="role", target_id=r.id, outcome="DENIED")
        raise forbidden("You hold this role, so another administrator has to change it.")
    if body.version != r.version:
        raise conflict("version_conflict", "Someone else changed this role. Reload and try again.")
    codes = set(body.permission_codes)
    known = {p.code for p in db.query(Permission).all()}
    if codes - known:
        raise bad_request(f"Unknown permissions: {', '.join(sorted(codes - known))}")
    existing = {p.permission_code: p for p in r.permissions}
    default_scope = Counter(p.scope for p in r.permissions).most_common(1)[0][0] if r.permissions else "department"
    before = sorted(existing)
    for code in set(existing) - codes:
        r.permissions.remove(existing[code])
    for code in codes - set(existing):
        r.permissions.append(RolePermission(role_id=r.id, permission_code=code, scope=default_scope))
    r.version += 1
    audit.record(db, actor_id=principal.id, action="role.permissions.changed", target_type="role", target_id=r.id,
                 before={"permissions": before}, after={"permissions": sorted(codes)}, details={"new_permission_scope": default_scope})
    db.commit()
    return role_out(db, r)


@router.get("/permissions")
def list_permissions(principal: Principal = Depends(require("roles.manage", global_only=True)), db: Session = Depends(get_db)):
    return [{"code": p.code, "description": p.description, "group": p.group} for p in db.query(Permission).order_by(Permission.code).all()]


@router.get("/departments")
def list_departments(principal: Principal = Depends(require("users.manage", "audit.read", "tickets.read", "resources.read",
                                                            any_of=True)), db: Session = Depends(get_db)):
    return [{"id": d.id, "name": d.name} for d in db.query(Department).order_by(Department.position).all()]


@router.get("/departments/{department_id}/memberships")
def list_members(department_id: str, principal: Principal = Depends(require("users.manage", global_only=True)),
                 db: Session = Depends(get_db)):
    if db.get(Department, department_id) is None:
        raise not_found("That department")
    rows = db.query(DepartmentMembership).filter(DepartmentMembership.department_id == department_id).all()
    return [{"user_id": m.user_id, "full_name": m.user.full_name, "email": m.user.email, "is_active": m.user.is_active,
             "roles": [{"id": r.id, "name": r.name, "is_locked": r.is_locked} for r in m.user.roles], "added_at": iso(m.added_at)}
            for m in sorted(rows, key=lambda m: m.user.full_name)]


@router.post("/departments/{department_id}/memberships", status_code=201)
def add_member(department_id: str, body: MemberIn, principal: Principal = Depends(require("users.manage", global_only=True)),
               db: Session = Depends(get_db)):
    _not_self(principal, body.user_id, "department memberships")
    if db.get(Department, department_id) is None:
        raise not_found("That department")
    u = _get_user(db, body.user_id)
    if any(m.department_id == department_id for m in u.memberships):
        raise conflict("already_member", f"{u.full_name} already belongs to this department.")
    m = DepartmentMembership(user_id=u.id, department_id=department_id, added_by=principal.id)
    db.add(m)
    audit.record(db, actor_id=principal.id, action="membership.added", target_type="user", target_id=u.id, department_id=department_id)
    db.commit()
    return {"user_id": u.id, "full_name": u.full_name, "email": u.email, "is_active": u.is_active,
            "roles": [{"id": r.id, "name": r.name, "is_locked": r.is_locked} for r in u.roles], "added_at": iso(m.added_at)}


@router.delete("/departments/{department_id}/memberships/{user_id}", status_code=204)
def remove_member(department_id: str, user_id: str, principal: Principal = Depends(require("users.manage", global_only=True)),
                  db: Session = Depends(get_db)):
    _not_self(principal, user_id, "department memberships")
    m = db.query(DepartmentMembership).filter_by(department_id=department_id, user_id=user_id).one_or_none()
    if m is None:
        raise not_found("That membership")
    db.delete(m)
    audit.record(db, actor_id=principal.id, action="membership.removed", target_type="user", target_id=user_id, department_id=department_id)
    db.commit()

