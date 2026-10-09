"""OpsTwin Live API: live service-desk website + operational digital twin."""
from __future__ import annotations

import logging
import os
import re
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import admin, ai, auth, governance, operations, twin
from app.core.config import CSRF_COOKIE, CSRF_HEADER, settings
from app.core.context import client_ip_var, request_id_var
from app.core.logging import configure_logging
from app.core.security import tokens_equal
from app.database.session import Base, SessionLocal, engine
from app.models import AuditLogImmutableError

configure_logging(os.getenv("OPSTWIN_LOG_LEVEL", "INFO"))
log = logging.getLogger("opstwin")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    from app.seed import init_reference_data

    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        init_reference_data(db)
    finally:
        db.close()
    log.info("OpsTwin Live API ready (env=%s)", settings.env)
    # The monitor thread only acts once someone switches it on in AI automation settings.
    if os.getenv("OPSTWIN_MONITOR_THREAD", "on") != "off":
        from app.ai import monitor

        monitor.start()
    yield


app = FastAPI(
    lifespan=lifespan,
    title="OpsTwin Live API",
    version="1.0.0",
    description="Campus IT service desk with a predictive operational digital twin. Simulated data is always labelled.",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-CSRF-Token", "X-Request-ID", "Idempotency-Key"],
    expose_headers=["X-Request-ID", "Retry-After"],
)

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
REQUEST_ID_OK = re.compile(r"^[A-Za-z0-9-]{8,64}$")


@app.middleware("http")
async def request_context(request: Request, call_next):
    incoming = request.headers.get("X-Request-ID", "")
    rid = incoming if REQUEST_ID_OK.match(incoming) else uuid.uuid4().hex
    request_id_var.set(rid)
    client_ip_var.set(request.client.host if request.client else None)

    # CSRF: double-submit token for every state-changing API request.
    if request.method in UNSAFE and request.url.path.startswith("/api/"):
        cookie = request.cookies.get(CSRF_COOKIE, "")
        header = request.headers.get(CSRF_HEADER, "")
        if not cookie or not header or not tokens_equal(cookie, header):
            resp = JSONResponse({"detail": {"code": "csrf_failed", "message": "Security check failed. Reload the page and try again."}},
                                status_code=403)
            resp.headers["X-Request-ID"] = rid
            return resp

    response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.exception_handler(AuditLogImmutableError)
async def audit_immutable_handler(_request: Request, _exc: AuditLogImmutableError):
    return JSONResponse({"detail": {"code": "audit_immutable", "message": "Audit records can't be changed."}}, status_code=403)


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception):
    log.exception("unhandled error: %s", exc)
    return JSONResponse({"detail": {"code": "server_error", "message": "Something went wrong on the server."}}, status_code=500)


@app.get("/api/health", tags=["health"])
def health():
    with SessionLocal() as db:
        db.execute(__import__("sqlalchemy").text("SELECT 1"))
    return {"status": "ok", "version": app.version}


for module in (auth, admin, operations, twin, governance, ai):
    app.include_router(module.router, prefix="/api")
