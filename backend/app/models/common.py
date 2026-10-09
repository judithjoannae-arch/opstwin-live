from __future__ import annotations

import uuid

from sqlalchemy import JSON
from sqlalchemy.ext.mutable import MutableDict, MutableList


def new_id() -> str:
    return uuid.uuid4().hex


JsonDict = MutableDict.as_mutable(JSON)
JsonList = MutableList.as_mutable(JSON)

STAGES = ("intake", "triage", "support", "verification")
CATEGORIES = ("account", "network", "software", "hardware", "critical_infrastructure")
PRIORITIES = ("P1", "P2", "P3", "P4")
STATUSES = ("open", "in_progress", "on_hold", "resolved", "closed", "cancelled")
