from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import CSRF_COOKIE, SESSION_COOKIE, settings
from app.core.context import client_ip_var
from app.core.errors import ApiError, bad_request, not_found
from app.core.ratelimit import limiter
from app.core.security import hash_password, new_token, token_hash, validate_password_strength, verify_password
from app.core.timeutil import iso, utcnow
from app.database.session import get_db
from app.models import Invitation, User, UserSession
from app.services import audit
from app.services.authz import Principal, get_principal, grants_for_api

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class AcceptInvitationIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=12, max_length=256)


def set_csrf_cookie(response: Response, token: str) -> None:
    # Readable by the page (double-submit token); the session cookie is HttpOnly.
    response.set_cookie(CSRF_COOKIE, token, httponly=False, secure=settings.cookie_secure, samesite="strict", path="/")


@router.get("/csrf")
def csrf(request: Request, response: Response):
    token = request.cookies.get(CSRF_COOKIE) or new_token()
    set_csrf_cookie(response, token)
    return {"csrf_token": token}


@router.post("/login", status_code=204)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip_var.get() or "unknown"
    retry = limiter.hit(f"login-ip:{ip}", 20, 300)
    if retry:
        raise ApiError(429, "rate_limited", "Too many sign-in attempts. Wait a few minutes and try again.", {"Retry-After": str(retry)})
    now = utcnow()
    user = db.query(User).filter(User.email == body.email.strip().lower()).one_or_none()
    if user and user.locked_until and user.locked_until > now:
        audit.record_standalone(actor_id=user.id, action="auth.login.failed", target_type="user", target_id=user.id,
                                outcome="DENIED", details={"reason": "locked"})
        retry_after = int((user.locked_until - now).total_seconds()) + 1
        raise ApiError(429, "account_locked", "Too many failed sign-ins. Try again later.", {"Retry-After": str(retry_after)})
    ok = verify_password(body.password, user.password_hash if user else None)
    if not ok or user is None or not user.is_active or user.invitation_pending:
        if user is not None:
            user.failed_logins += 1
            if user.failed_logins >= settings.login_max_failures:
                user.locked_until = now + timedelta(minutes=settings.login_lockout_minutes)
                user.failed_logins = 0
            db.commit()
        audit.record_standalone(actor_id=user.id if user else None, action="auth.login.failed", target_type="user",
                                target_id=user.id if user else None, outcome="FAILURE", details={"reason": "invalid_credentials"})
        raise ApiError(401, "invalid_credentials", "That email and password don't match an active account.")
    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now
    token = new_token()
    db.add(UserSession(user_id=user.id, token_hash=token_hash(token), created_at=now, last_seen_at=now,
                       expires_at=now + timedelta(hours=settings.session_absolute_hours),
                       user_agent=(request.headers.get("user-agent") or "")[:300], ip_address=ip))
    audit.record(db, actor_id=user.id, action="auth.login.succeeded", target_type="user", target_id=user.id)
    db.commit()
    response.set_cookie(SESSION_COOKIE, token, httponly=True, secure=settings.cookie_secure, samesite="lax",
                        max_age=settings.session_absolute_hours * 3600, path="/")
    set_csrf_cookie(response, new_token())  # rotate on login


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        s = db.query(UserSession).filter(UserSession.token_hash == token_hash(token)).one_or_none()
        if s and s.revoked_at is None:
            s.revoked_at = utcnow()
            audit.record(db, actor_id=s.user_id, action="auth.logout", target_type="session", target_id=s.id)
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    set_csrf_cookie(response, new_token())


@router.get("/me")
def me(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    u = principal.user
    from app.models import Department

    depts = {d.id: d.name for d in db.query(Department).order_by(Department.position).all()}
    grants = grants_for_api(principal)
    referenced = {m.department_id for m in u.memberships}
    if any(g["scope"] == "global" for g in grants):
        referenced = set(depts)
    else:
        for g in grants:
            referenced |= set(g["department_ids"])
    return {
        "id": u.id, "email": u.email, "full_name": u.full_name, "is_active": u.is_active,
        "roles": [{"id": r.id, "name": r.name, "is_locked": r.is_locked} for r in u.roles],
        "memberships": [{"department_id": m.department_id, "department_name": depts.get(m.department_id, m.department_id)}
                        for m in u.memberships],
        "grants": grants,
        "departments": [{"id": d, "name": n} for d, n in depts.items() if d in referenced],
        "session_expires_at": iso(min(principal.session.expires_at,
                                      principal.session.last_seen_at + timedelta(minutes=settings.session_idle_minutes))),
    }


@router.get("/sessions")
def sessions(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    now = utcnow()
    rows = (db.query(UserSession).filter(UserSession.user_id == principal.id, UserSession.revoked_at.is_(None),
                                         UserSession.expires_at > now).order_by(UserSession.last_seen_at.desc()).all())
    return [{"id": s.id, "created_at": iso(s.created_at), "last_seen_at": iso(s.last_seen_at), "expires_at": iso(s.expires_at),
             "user_agent": s.user_agent, "ip_address": s.ip_address, "is_current": s.id == principal.session.id} for s in rows]


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(session_id: str, principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    s = db.get(UserSession, session_id)
    if s is None or s.user_id != principal.id:
        raise not_found("That session")
    s.revoked_at = utcnow()
    audit.record(db, actor_id=principal.id, action="auth.session.revoked", target_type="session", target_id=s.id)
    db.commit()


@router.post("/sessions/revoke-others", status_code=204)
def revoke_others(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    n = (db.query(UserSession).filter(UserSession.user_id == principal.id, UserSession.id != principal.session.id,
                                      UserSession.revoked_at.is_(None)).update({"revoked_at": utcnow()}))
    audit.record(db, actor_id=principal.id, action="auth.session.revoked_others", target_type="user", target_id=principal.id,
                 details={"count": n})
    db.commit()


@router.post("/invitations/accept", status_code=204)
def accept_invitation(body: AcceptInvitationIn, db: Session = Depends(get_db)):
    problem = validate_password_strength(body.password)
    if problem:
        raise bad_request(problem, "weak_password")
    inv = db.query(Invitation).filter(Invitation.token_hash == token_hash(body.token)).one_or_none()
    if inv is None or inv.used_at is not None or inv.expires_at < utcnow():
        raise ApiError(400, "invalid_invitation", "This invitation link is invalid or has expired.")
    user = db.get(User, inv.user_id)
    user.password_hash = hash_password(body.password)
    user.invitation_pending = False
    inv.used_at = utcnow()
    audit.record(db, actor_id=user.id, action="user.invitation_accepted", target_type="user", target_id=user.id)
    db.commit()


