"""Event-driven simulation of the four-stage service desk (spec §5).

A virtual clock advances from event to event (a binary heap ordered by time
and insertion sequence). Invariants enforced here:

* a ticket is served by at most one resource at a time (``in_service`` + token);
* a completion event whose token no longer matches is ignored, so a ticket
  can't complete twice after an interruption;
* resources that are failed, removed or off shift never start new work;
* queues are Python lists, so lengths can't go negative;
* everything still queued, on hold or in service at the horizon is reported
  as carried-over backlog, never dropped.

Common random numbers: every ticket owns its own random streams seeded from
(seed, ticket key), and arrivals come from one stream, so strategies compared
on the same snapshot and seed see the same tickets with the same service needs.
"""
from __future__ import annotations

import heapq
import itertools
import random
from collections import defaultdict
from dataclasses import dataclass, field

from app.simulation import events as ev
from app.simulation.workflow import (
    ESCALATE,
    NEXT_STAGE,
    PRIORITY_RANK,
    STAGE_ORDER,
    TRANSFER_PARTIAL_FRACTION,
    ResourceSpec,
    WorkflowModel,
)

SAMPLE_EVERY_MIN = 15.0
MAX_EVENTS = 2_000_000


class SimulationError(RuntimeError):
    pass


@dataclass
class SimTicket:
    key: str
    ref: str
    category: str  # as labelled at triage
    true_category: str
    priority: str
    created: float
    deadline: float
    is_existing: bool
    rng_service: random.Random
    rng_decision: random.Random
    misroute_draw: float
    stage: str | None = None
    enter: float = 0.0
    in_service: bool = False
    resource: "SimResource | None" = None
    token: int = 0
    on_hold: bool = False
    closed: float | None = None
    wait_total: float = 0.0
    misrouted: bool = False
    transferred: bool = False
    needs_skill: bool = False
    escalated: bool = False
    breached: bool = False
    rework: int = 0
    history: list[dict] = field(default_factory=list)


@dataclass
class SimResource:
    spec: ResourceSpec
    stage: str
    working: bool = True
    on_shift: bool = True
    busy: SimTicket | None = None
    busy_since: float = 0.0
    busy_minutes: float = 0.0
    capable_minutes: float = 0.0
    _capable_since: float | None = 0.0

    @property
    def id(self) -> str:
        return self.spec.id

    @property
    def capable(self) -> bool:
        return self.working and self.on_shift

    def mark(self, now: float) -> None:
        """Close the current capability interval before a state change."""
        if self._capable_since is not None:
            self.capable_minutes += max(0.0, now - self._capable_since)
        self._capable_since = None

    def reopen(self, now: float) -> None:
        self._capable_since = now if self.capable else None


@dataclass
class ReplicationResult:
    horizon: float
    tickets: list[SimTicket]
    new_arrivals: int
    series: list[dict]
    hourly: list[dict]
    stage_waits: dict[str, list[float]]
    busy_minutes: dict[str, float]
    capable_minutes: dict[str, float]
    initial_backlog: int
    unfinished: list[dict]
    events: list[ev.RecordedEvent]
    event_count: int


class Simulator:
    def __init__(self, model: WorkflowModel, seed: int, record_events: bool = False):
        self.m = model
        self.seed = seed
        self.record = record_events
        self.now = 0.0
        self._heap: list = []
        self._seq = itertools.count()
        self.events: list[ev.RecordedEvent] = []
        self.event_count = 0
        self.queues: dict[str, list[SimTicket]] = {s: [] for s in STAGE_ORDER}
        self.tickets: list[SimTicket] = []
        self.resources: dict[str, SimResource] = {}
        self.by_stage: dict[str, list[SimResource]] = {s: [] for s in STAGE_ORDER}
        self.stage_waits: dict[str, list[float]] = {s: [] for s in STAGE_ORDER}
        self.series: list[dict] = []
        self.hourly_arrivals: dict[int, int] = defaultdict(int)
        self.hourly_closed: dict[int, int] = defaultdict(int)
        self.new_arrivals = 0
        self.closed_count = 0

    # ------------------------------------------------------------------ utils
    def _log(self, etype: str, ticket: SimTicket | None = None, stage: str | None = None,
             resource: str | None = None, detail: str | None = None) -> None:
        self.event_count += 1
        if self.record:
            self.events.append(ev.RecordedEvent(round(self.now, 3), etype, ticket.ref if ticket else None,
                                                stage if stage is not None else (ticket.stage if ticket else None),
                                                resource, detail))

    def _schedule(self, at: float, kind: str, *payload) -> None:
        heapq.heappush(self._heap, (at, next(self._seq), kind, payload))

    def _ticket_rngs(self, key: str) -> tuple[random.Random, random.Random]:
        return random.Random(f"{self.seed}:{key}:service"), random.Random(f"{self.seed}:{key}:decision")

    def _order_key(self, t: SimTicket):
        if self.m.routing_policy in ("priority", "smart_triage"):
            return (PRIORITY_RANK[t.priority], t.enter, t.key)
        return (t.enter, t.key)

    # ------------------------------------------------------------ set-up
    def _setup_resources(self) -> None:
        start_local = self.m.local_minute_of_day(0)
        for spec in self.m.resources:
            if spec.id in self.m.removed:
                continue
            r = SimResource(spec=spec, stage=spec.stage)
            r.on_shift = spec.on_shift(start_local) if self.m.respect_shifts else True
            r.reopen(0.0)
            self.resources[spec.id] = r
            self.by_stage[spec.stage].append(r)
            if self.m.respect_shifts and spec.shift_start != spec.shift_end:
                self._schedule_shifts(spec)
        for rid in sorted(self.m.removed):
            self._log(ev.RESOURCE_FAILURE, resource=rid, detail="removed for this scenario")
        for rid, frm, to in self.m.unavailability:
            if rid in self.resources:
                self._schedule(frm, "down", rid)
                if to is not None and to < self.m.horizon_min:
                    self._schedule(to, "up", rid)

    def _schedule_shifts(self, spec: ResourceSpec) -> None:
        day_start = -self.m.local_minute_of_day(0)  # sim minute of local midnight today
        days = int(self.m.horizon_min // 1440) + 2
        length = (spec.shift_end - spec.shift_start) % 1440
        for d in range(-1, days + 1):
            s = day_start + d * 1440 + spec.shift_start
            e = s + length
            if 0 < s < self.m.horizon_min:
                self._schedule(s, "shift_start", spec.id)
            if 0 < e < self.m.horizon_min:
                self._schedule(e, "shift_end", spec.id)

    def _setup_existing(self) -> None:
        sla = self.m.sla_resolution
        for spec in self.m.tickets:
            rs, rd = self._ticket_rngs(f"x:{spec.id}")
            t = SimTicket(
                key=f"x:{spec.id}", ref=spec.ref, category=spec.category, true_category=spec.category,
                priority=spec.priority, created=spec.created_min, deadline=spec.deadline_min, is_existing=True,
                rng_service=rs, rng_decision=rd, misroute_draw=rd.random(),
            )
            self.tickets.append(t)
            # Only work that hasn't started technical support can still turn out misrouted.
            unstarted_support = spec.stage in ("intake", "triage") or (spec.stage == "support" and spec.status == "open")
            t.misrouted = unstarted_support and t.misroute_draw < self.m.effective_transfer_rate()
            if spec.status in ("open", "in_progress", "on_hold") and spec.stage != "verification":
                window = sla.get(spec.priority, 480)
                esc_at = spec.created_min + self.m.escalation_fraction * window
                if 0 < esc_at < self.m.horizon_min:
                    self._schedule(esc_at, "escalate", t)
            if 0 < t.deadline < self.m.horizon_min:
                self._schedule(t.deadline, "deadline", t)
            elif t.deadline <= 0:
                t.breached = True

            t.stage = spec.stage
            if spec.status == "on_hold":
                t.on_hold = True
                release = rd.expovariate(1 / self.m.hold_mean_min)
                self._schedule(release, "hold_release", t)
                continue

            r = self.resources.get(spec.assigned_resource_id or "")
            in_service = spec.assigned_resource_id is not None and (
                spec.status == "in_progress" or spec.stage != "support"
            )
            if in_service and r is not None and r.capable and r.busy is None and r.stage == spec.stage:
                dist = self.m.service_dist(spec.stage, t.category)
                full = dist.sample(rs.gauss(0, 1), self.m.service_multiplier(spec.stage))
                started = spec.service_start_min if spec.service_start_min is not None else spec.stage_enter_min
                remaining = full - (0 - started)
                if remaining < 1:
                    remaining = max(1.0, rs.expovariate(1 / max(1.0, 0.25 * dist.mean)))
                self._begin(t, r, remaining, "complete", detail="in progress at snapshot", wait=None)
            else:
                if in_service:
                    self._log(ev.SERVICE_INTERRUPTED, t, resource=spec.assigned_resource_id,
                              detail="assigned resource not working in this scenario")
                t.enter = spec.stage_enter_min
                self.queues[spec.stage].append(t)

    def _setup_arrivals(self) -> None:
        rng = random.Random(f"{self.seed}:arrivals")
        mix_rng = random.Random(f"{self.seed}:mix")
        cats = list(self.m.category_mix.keys())
        weights = [self.m.category_mix[c] for c in cats]
        t, i, horizon = 0.0, 0, self.m.horizon_min
        while t < horizon:
            rate = self.m.rate_at(t)
            boundary = (t // 60 + 1) * 60
            if rate <= 0:
                t = boundary
                continue
            nxt = t + rng.expovariate(rate / 60.0)
            if nxt >= boundary:  # memoryless: restart at the hour boundary with the next rate
                t = boundary
                continue
            t = nxt
            if t >= horizon:
                break
            cat = mix_rng.choices(cats, weights)[0]
            pmix = self.m.priority_mix.get(cat) or {"P3": 1.0}
            pri = mix_rng.choices(list(pmix.keys()), list(pmix.values()))[0]
            self._schedule(t, "arrival", i, cat, pri)
            i += 1

    # ------------------------------------------------------------ mechanics
    def _enqueue(self, t: SimTicket, stage: str) -> None:
        t.stage = stage
        t.enter = self.now
        self.queues[stage].append(t)
        self._log(ev.QUEUE_ENTER, t, stage)
        self._dispatch(stage)

    def _pick(self, stage: str, t: SimTicket, idle: list[SimResource]) -> SimResource | None:
        if stage == "support" and (self.m.skill_aware or t.needs_skill):
            skilled = [r for r in idle if t.category in r.spec.skills]
            return min(skilled, key=lambda r: (r.busy_minutes, r.id)) if skilled else None
        return min(idle, key=lambda r: (r.busy_minutes, r.id))

    def _dispatch(self, stage: str) -> None:
        queue = self.queues[stage]
        if not queue:
            return
        idle = [r for r in self.by_stage[stage] if r.busy is None and r.capable]
        if not idle:
            return
        for t in sorted(queue, key=self._order_key):
            if not idle:
                break
            r = self._pick(stage, t, idle)
            if r is None:
                continue
            idle.remove(r)
            queue.remove(t)
            wait = self.now - max(t.enter, 0.0)
            self._log(ev.QUEUE_EXIT, t, stage)
            dist = self.m.service_dist(stage, t.category)
            duration = dist.sample(t.rng_service.gauss(0, 1), self.m.service_multiplier(stage))
            kind = "complete"
            if stage == "support":
                lacks_skill = t.category not in r.spec.skills
                if (t.misrouted and not t.transferred) or lacks_skill:
                    duration *= TRANSFER_PARTIAL_FRACTION
                    kind = "transfer"
            self._begin(t, r, duration, kind, wait=wait)

    def _begin(self, t: SimTicket, r: SimResource, duration: float, kind: str, wait: float | None,
               detail: str | None = None) -> None:
        if t.in_service or r.busy is not None or not r.capable:
            raise SimulationError("invariant violated: double assignment or unavailable resource")
        if wait is not None:  # work already in progress at the snapshot has no new wait
            t.wait_total += wait
            self.stage_waits[t.stage].append(wait)
        t.in_service, t.resource = True, r
        t.token += 1
        r.busy, r.busy_since = t, self.now
        self._log(ev.RESOURCE_ASSIGNED, t, resource=r.id, detail=detail)
        self._log(ev.SERVICE_START, t, resource=r.id, detail=detail)
        t.history.append({"stage": t.stage, "start": self.now, "resource": r.id, "end": None, "outcome": None})
        self._schedule(self.now + duration, kind, t, r.id, t.token)

    def _release(self, t: SimTicket, r: SimResource) -> None:
        r.busy_minutes += self.now - r.busy_since
        r.busy = None
        t.in_service, t.resource = False, None
        self._log(ev.RESOURCE_RELEASED, t, resource=r.id)

    def _on_complete(self, t: SimTicket, rid: str, token: int, transfer: bool) -> None:
        r = self.resources.get(rid)
        if r is None or t.token != token or not t.in_service or r.busy is not t:
            return  # stale event after an interruption: never complete twice
        stage = t.stage
        self._release(t, r)
        if t.history:
            t.history[-1].update(end=self.now, outcome="transfer" if transfer else "done")
        if transfer:
            t.transferred, t.needs_skill = True, True
            t.category = t.true_category
            self._log(ev.TRANSFER, t, resource=rid, detail="re-routed to a skilled technician")
            self._enqueue(t, "support")
        else:
            self._log(ev.SERVICE_COMPLETE, t, resource=rid)
            if stage == "triage":
                self._log(ev.CLASSIFIED, t, detail=f"{t.category} {t.priority}")
            nxt = NEXT_STAGE[stage]
            if nxt is not None:
                self._enqueue(t, nxt)
            elif t.rng_decision.random() < self.m.rework_rate:
                t.rework += 1
                self._log(ev.REWORK, t, detail="verification failed")
                self._enqueue(t, "support")
            else:
                t.closed = self.now
                self.closed_count += 1
                self.hourly_closed[int(self.now // 60)] += 1
                self._log(ev.TICKET_CLOSED, t)
        self._dispatch(stage)

    def _set_capability(self, r: SimResource, working: bool | None = None, on_shift: bool | None = None) -> None:
        r.mark(self.now)
        if working is not None:
            r.working = working
        if on_shift is not None:
            r.on_shift = on_shift
        r.reopen(self.now)

    def _on_down(self, rid: str) -> None:
        r = self.resources[rid]
        if not r.working:
            return
        self._set_capability(r, working=False)
        self._log(ev.RESOURCE_FAILURE, resource=rid, stage=r.stage)
        if r.busy is not None:
            t = r.busy
            self._release(t, r)
            t.token += 1  # invalidates the pending completion
            if t.history:
                t.history[-1].update(end=self.now, outcome="interrupted")
            self._log(ev.SERVICE_INTERRUPTED, t, resource=rid)
            self._enqueue(t, t.stage)

    def _on_up(self, rid: str) -> None:
        r = self.resources[rid]
        if r.working:
            return
        self._set_capability(r, working=True)
        self._log(ev.RESOURCE_RECOVERY, resource=rid, stage=r.stage)
        self._dispatch(r.stage)

    def _sample(self) -> None:
        in_service = {s: sum(1 for r in self.by_stage[s] if r.busy is not None) for s in STAGE_ORDER}
        queue = {s: len(self.queues[s]) for s in STAGE_ORDER}
        backlog = sum(1 for t in self.tickets if t.closed is None)
        self.series.append({
            "minute": round(self.now, 2),
            "queue": queue,
            "in_service": in_service,
            "backlog": backlog,
            "cum_arrivals": self.new_arrivals,
            "cum_closed": self.closed_count,
        })

    # ------------------------------------------------------------- run
    def run(self) -> ReplicationResult:
        horizon = self.m.horizon_min
        self._setup_resources()
        self._setup_existing()
        self._setup_arrivals()
        initial_backlog = len(self.tickets)
        for stage in STAGE_ORDER:
            self._dispatch(stage)
        s = 0.0
        while s <= horizon:
            self._schedule(s, "sample")
            s += SAMPLE_EVERY_MIN

        processed = 0
        while self._heap:
            at, _, kind, payload = heapq.heappop(self._heap)
            if at > horizon:
                break
            self.now = at
            processed += 1
            if processed > MAX_EVENTS:
                raise SimulationError("event limit exceeded")
            if kind == "arrival":
                i, cat, pri = payload
                key = f"n:{i}"
                rs, rd = self._ticket_rngs(key)
                draw = rd.random()
                true_cat = cat
                t = SimTicket(key=key, ref=f"SIM-{i + 1:05d}", category=cat, true_category=true_cat, priority=pri,
                              created=self.now, deadline=self.now + self.m.sla_resolution.get(pri, 480),
                              is_existing=False, rng_service=rs, rng_decision=rd, misroute_draw=draw)
                t.misrouted = draw < self.m.effective_transfer_rate()
                self.tickets.append(t)
                self.new_arrivals += 1
                self.hourly_arrivals[int(self.now // 60)] += 1
                self._log(ev.ARRIVAL, t, "intake", detail=f"{cat} {pri}")
                esc_at = self.now + self.m.escalation_fraction * self.m.sla_resolution.get(pri, 480)
                if esc_at < horizon:
                    self._schedule(esc_at, "escalate", t)
                if t.deadline < horizon:
                    self._schedule(t.deadline, "deadline", t)
                self._enqueue(t, "intake")
            elif kind in ("complete", "transfer"):
                t, rid, token = payload
                self._on_complete(t, rid, token, transfer=(kind == "transfer"))
            elif kind == "shift_start":
                r = self.resources[payload[0]]
                self._set_capability(r, on_shift=True)
                self._log(ev.SHIFT_START, resource=r.id, stage=r.stage)
                self._dispatch(r.stage)
            elif kind == "shift_end":
                r = self.resources[payload[0]]
                self._set_capability(r, on_shift=False)  # finishes current work, takes no new work
                self._log(ev.SHIFT_END, resource=r.id, stage=r.stage)
            elif kind == "down":
                self._on_down(payload[0])
            elif kind == "up":
                self._on_up(payload[0])
            elif kind == "hold_release":
                t = payload[0]
                if t.on_hold and t.closed is None:
                    t.on_hold = False
                    self._log(ev.HOLD_RELEASED, t, "support")
                    self._enqueue(t, "support")
            elif kind == "escalate":
                t = payload[0]
                if t.closed is None and not t.escalated and t.priority in ESCALATE and t.stage != "verification":
                    old = t.priority
                    t.priority = ESCALATE[old]
                    t.escalated = True
                    self._log(ev.PRIORITY_ESCALATED, t, detail=f"{old} to {t.priority}")
            elif kind == "deadline":
                t = payload[0]
                if t.closed is None and not t.breached:
                    t.breached = True
                    self._log(ev.SLA_BREACHED, t)
            elif kind == "sample":
                self._sample()

        # ---- horizon: account for unfinished work, never drop it
        self.now = horizon
        unfinished: list[dict] = []
        for stage in STAGE_ORDER:
            for t in self.queues[stage]:
                censored = horizon - max(t.enter, 0.0)
                t.wait_total += censored
                self.stage_waits[stage].append(censored)
                unfinished.append({"ref": t.ref, "stage": stage, "state": "queued", "priority": t.priority})
            for r in self.by_stage[stage]:
                if r.busy is not None:
                    unfinished.append({"ref": r.busy.ref, "stage": stage, "state": "in_service", "priority": r.busy.priority})
                    r.busy_minutes += horizon - r.busy_since
                    r.busy_since = horizon
        for t in self.tickets:
            if t.on_hold and t.closed is None:
                unfinished.append({"ref": t.ref, "stage": "support", "state": "on_hold", "priority": t.priority})
        for r in self.resources.values():
            r.mark(horizon)
        self._log(ev.BACKLOG_CARRYOVER, detail=f"{len(unfinished)} tickets carried over at the horizon")

        busy = {s: sum(r.busy_minutes for r in self.by_stage[s]) for s in STAGE_ORDER}
        capable = {s: sum(r.capable_minutes for r in self.by_stage[s]) for s in STAGE_ORDER}
        hours = int(-(-horizon // 60))
        hourly = [{"hour": h, "arrivals": self.hourly_arrivals.get(h, 0), "closed": self.hourly_closed.get(h, 0)} for h in range(hours)]
        return ReplicationResult(
            horizon=horizon, tickets=self.tickets, new_arrivals=self.new_arrivals, series=self.series, hourly=hourly,
            stage_waits=self.stage_waits, busy_minutes=busy, capable_minutes=capable, initial_backlog=initial_backlog,
            unfinished=unfinished, events=self.events, event_count=self.event_count,
        )


def run_replication(model: WorkflowModel, seed: int, record_events: bool = False) -> ReplicationResult:
    return Simulator(model, seed, record_events).run()
