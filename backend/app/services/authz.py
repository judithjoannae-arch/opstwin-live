"""Authorization: permission resolution, request dependencies and scope checks.

Three levels (spec §22.E):
  function  - does the user hold the permission at all?          require(...)
  scope     - does it cover this department?                       principal.covers(...)
  object    - can they act on this specific record?                 can_update_ticket(...) etc.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.config import SESSION_COOKIE, settings
from app.core.errors import ApiError
from app.core.security import token_hash
from app.core.timeutil import utcnow
from app.database.session import get_db
from app.models import Department, User, UserSession
from app.models.common import STAGES


@dataclass
class Grant:
    is_global: bool = False
    departments: set[str] = field(default_factory=set)
    # Departments where the permission only applies to the user's own assigned work.
    assigned_only: set[str] = field(default_factory=set)


@dataclass
class Principal:
    user: User
    session: UserSession | None
    grants: dict[str, Grant]

    @property
    def id(self) -> str:
        return self.user.id

    def has(self, code: str) -> bool:
        g = self.grants.get(code)
        return bool(g and (g.is_global or g.departments or g.assigned_only))

    def is_global(self, code: str) -> bool:
        g = self.grants.get(code)
        return bool(g and g.is_global)

    def covers(self, code: str, department_id: str | None, *, allow_assigned: bool = False) -> bool:
        g = self.grants.get(code)
        if not g:
            return False
        if g.is_global:
            return True
        if department_id is None:
            return False
        return department_id in g.departments or (allow_assigned and department_id in g.assigned_only)

    def covers_all(self, code: str, department_ids: list[str] | set[str]) -> bool:
        return all(self.covers(code, d) for d in department_ids)

    def scope(self, code: str) -> set[str] | None:
        """None means every department."""
        g = self.grants.get(code)
        if not g:
            return set()
        if g.is_global:
            return None
        return set(g.departments) | set(g.assigned_only)

    def visible_stages(self, *codes: str) -> list[str]:
        out: set[str] = set()
        for c in codes:
            s = self.scope(c)
            if s is None:
                return list(STAGES)
            out |= s
        return [s for s in STAGES if s in out]


def resolve_grants(user: User) -> dict[str, Grant]:
    member_of = {m.department_id for m in user.memberships}
    grants: dict[str, Grant] = {}
    if not user.is_active:
        return grants
    for role in user.roles:
        for rp in role.permissions:
            g = grants.setdefault(rp.permission_code, Grant())
            if rp.scope == "global":
                g.is_global = True
            elif rp.scope == "department":
                g.departments |= member_of
            else:
                g.assigned_only |= member_of
    for g in grants.values():
        g.assigned_only -= g.departments
    return grants


def grants_for_api(principal: Principal) -> list[dict]:
    out = []
    for code, g in sorted(principal.grants.items()):
        if g.is_global:
            out.append({"code": code, "scope": "global", "department_ids": []})
        elif g.departments or g.assigned_only:
            out.append({"code": code, "scope": "departments", "department_ids": sorted(g.departments | g.assigned_only)})
    return out


def _session_from_request(request: Request, db: Session) -> UserSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    return db.query(UserSession).filter(UserSession.token_hash == token_hash(token)).one_or_none()


def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    session = _session_from_request(request, db)
    if session is None:
        raise ApiError(401, "not_authenticated", "Sign in to continue.")
    now = utcnow()
    if session.revoked_at is not None:
        raise ApiError(401, "session_revoked", "This session was signed out.")
    idle_limit = session.last_seen_at.timestamp() + settings.session_idle_minutes * 60
    if now >= session.expires_at or now.timestamp() > idle_limit:
        raise ApiError(401, "session_expired", "Your session has ended.")
    user = session.user
    if not user.is_active:
        raise ApiError(401, "account_deactivated", "This account is no longer active.")
    if (now - session.last_seen_at).total_seconds() > 60:
        session.last_seen_at = now
        db.commit()
    principal = Principal(user=user, session=session, grants=resolve_grants(user))
    request.state.principal = principal
    return principal


def optional_principal(request: Request, db: Session = Depends(get_db)) -> Principal | None:
    try:
        return get_principal(request, db)
    except ApiError:
        return None


def require(*codes: str, any_of: bool = False, global_only: bool = False):
    """Dependency: the caller holds every code (or any, with any_of) in some scope."""

    def dep(principal: Principal = Depends(get_principal)) -> Principal:
        check = (lambda c: principal.is_global(c)) if global_only else principal.has
        ok = any(check(c) for c in codes) if any_of else all(check(c) for c in codes)
        if not ok:
            from app.services.audit import record_denied  # local import avoids a cycle

            record_denied(principal, "permission:" + ",".join(codes))
            raise ApiError(403, "forbidden", "You don't have permission to do that.")
        return principal

    return dep


def department_names(db: Session) -> dict[str, str]:
    return {d.id: d.name for d in db.query(Department).all()}
