"""Environment-based configuration. No secrets are hardcoded."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: os.getenv("OPSTWIN_ENV", "development"))
    database_url: str = field(default_factory=lambda: os.getenv("OPSTWIN_DATABASE_URL", "sqlite:///./opstwin.db"))
    cors_origins: list[str] = field(default_factory=lambda: _list("OPSTWIN_CORS_ORIGINS", "http://localhost:5173"))
    # Secure cookies need HTTPS. Defaults to on outside development.
    cookie_secure: bool = field(
        default_factory=lambda: _bool("OPSTWIN_COOKIE_SECURE", os.getenv("OPSTWIN_ENV", "development") != "development")
    )
    session_absolute_hours: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_SESSION_HOURS", "8")))
    session_idle_minutes: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_SESSION_IDLE_MINUTES", "60")))
    login_max_failures: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_LOGIN_MAX_FAILURES", "5")))
    login_lockout_minutes: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_LOGIN_LOCKOUT_MINUTES", "15")))
    change_request_ttl_hours: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_CHANGE_REQUEST_TTL_HOURS", "24")))
    max_replications: int = field(default_factory=lambda: int(os.getenv("OPSTWIN_MAX_REPLICATIONS", "30")))

    @property
    def is_development(self) -> bool:
        return self.env == "development"


settings = Settings()

SESSION_COOKIE = "opstwin_session"
CSRF_COOKIE = "opstwin_csrf"
CSRF_HEADER = "X-CSRF-Token"
