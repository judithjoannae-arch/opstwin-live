"""All timestamps are stored as naive UTC and serialised with a trailing Z."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.replace(microsecond=0).isoformat() + "Z"


def parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def local_offset() -> timedelta:
    """Offset of the server's local time zone (shift times are local wall-clock)."""
    return datetime.now().astimezone().utcoffset() or timedelta(0)


def minutes_between(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 60.0
