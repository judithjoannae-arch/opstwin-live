"""Automatic priority: impact x urgency matrix (standard ITSM practice).

People never choose a priority, so the same situation always gets the same priority.
Impact = how many people are affected; urgency = how badly their work is blocked.
Signals come from the "affects many people" answer, the category and the wording
of the request. Every result carries the reasons, so it can be explained and audited.
"""
from __future__ import annotations

import re

LEVELS = ["low", "medium", "high"]

IMPACT_HIGH = ["everyone", "every student", "all students", "all staff", "all users", "whole campus", "entire campus",
               "campus wide", "campus-wide", "across campus", "across the campus", "nobody can", "no one can", "whole building",
               "entire building", "whole department", "outage"]
IMPACT_MEDIUM = ["lab", "class", "classroom", "lecture", "hall", "department", "team", "several", "multiple", "many people",
                 "students", "floor", "building", "block", "library", "residence", "auditorium", "the whole", "all the"]
URGENCY_HIGH = ["exam", "deadline", "is down", "are down", "down for", "outage", "unreachable", "cannot work", "can't work",
                "cant work", "unable to work", "urgent", "emergency", "completely", "offline", "data loss", "security",
                "virus", "threat", "breach", "locked out", "cannot access", "can't access", "cant access", "no access",
                "payroll", "alarm", "failure", "not booting", "won't boot", "will not boot", "502", "500 error"]
URGENCY_MEDIUM = ["slow", "drop", "intermittent", "error", "crash", "fail", "not working", "broken", "cannot", "can't", "cant",
                  "unable", "keeps", "no signal", "not responding", "won't", "will not", "flicker", "jam", "no internet",
                  "not connecting", "doesn't work", "does not work", "no network", "no connection", "cannot connect",
                  "can't connect", "cant connect", "can connect", "none of", "not able", "isn't working", "stopped", "no wifi"]
URGENCY_LOW = ["install", "installation", "request", "would like", "when possible", "how do", "how to", "question",
               "upgrade", "new account", "guest account", "need access", "please add"]

MATRIX = {
    ("high", "high"): "P1",
    ("high", "medium"): "P2", ("medium", "high"): "P2",
    ("high", "low"): "P3", ("medium", "medium"): "P3", ("low", "high"): "P3",
    ("medium", "low"): "P4", ("low", "medium"): "P4", ("low", "low"): "P4",
}


def _found(text: str, phrases: list[str]) -> list[str]:
    hits = []
    for p in phrases:
        if re.search(r"(?<![a-z])" + re.escape(p), text):
            hits.append(p)
    return hits


def assess(title: str, description: str, category: str, affects_many_users: bool) -> dict:
    text = f" {title} {description} ".lower().replace("wi-fi", "wifi")
    reasons: list[str] = []

    # Impact
    high_i, med_i = _found(text, IMPACT_HIGH), _found(text, IMPACT_MEDIUM)
    if affects_many_users:
        impact = "high"
        reasons.append("Impact high: the requester said it affects many people")
    elif category == "critical_infrastructure":
        impact = "high"
        reasons.append("Impact high: critical infrastructure serves the whole campus")
    elif high_i:
        impact = "high"
        reasons.append(f"Impact high: mentions \u201c{high_i[0]}\u201d")
    elif med_i:
        impact = "medium"
        reasons.append(f"Impact medium: mentions \u201c{med_i[0]}\u201d (a group or shared space)")
    else:
        impact = "low"
        reasons.append("Impact low: reads as one person's problem")

    # Urgency
    high_u, med_u, low_u = _found(text, URGENCY_HIGH), _found(text, URGENCY_MEDIUM), _found(text, URGENCY_LOW)
    if high_u:
        urgency = "high"
        reasons.append(f"Urgency high: mentions \u201c{high_u[0]}\u201d")
    elif med_u:
        urgency = "medium"
        reasons.append(f"Urgency medium: mentions \u201c{med_u[0]}\u201d")
    elif low_u:
        urgency = "low"
        reasons.append(f"Urgency low: reads as a request (\u201c{low_u[0]}\u201d)")
    else:
        urgency = "medium" if category == "critical_infrastructure" else "low"
        reasons.append("Urgency " + urgency + ": no time pressure stated")
    if category == "critical_infrastructure" and urgency == "low":
        urgency = "medium"
        reasons.append("Urgency raised to medium for critical infrastructure")

    return {"priority": MATRIX[(impact, urgency)], "impact": impact, "urgency": urgency, "reasons": reasons,
            "affects_many_users": affects_many_users, "method": "Impact × urgency matrix"}
