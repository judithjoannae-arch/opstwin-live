# Architecture

Modular monolith: a FastAPI backend with clear internal boundaries, a React frontend, one SQLite database.

```
React (Vite, TS, Tailwind, Recharts)
  │  same-origin /api, HTTP-only session cookie + CSRF header
FastAPI app (app/main.py: request IDs, CSRF, security headers, error mapping)
  ├─ api/            routers: auth, admin, operations, twin, governance
  ├─ services/       authz (RBAC), audit, tickets, operations_state, config_service,
  │                  snapshots, simulation_runs, stress_tests, changes, prediction
  ├─ simulation/     engine, events, workflow model, metrics, stress_test scenarios
  ├─ recommendations/ constraints, pareto, evaluator
  └─ models/         SQLAlchemy: auth, operations, twin, governance
SQLite (WAL, foreign keys on)
```

## The two representations

**Live operational system** (tables `tickets`, `ticket_status_history`, `operational_events`, `resources`, `sla_policies`, `config_versions`): what the website records. Every ticket, assignment, status, availability or SLA change is persisted and written as an operational event.

**Digital twin** (tables `twin_snapshots`, `scenarios`, `stress_tests`, `simulation_runs`, `simulated_events`, `simulation_metrics`, `recommendations`): read-only with respect to live data.

1. **Snapshot** — one read of active tickets, staff, configuration and history-based parameter estimates, stored immutably with its configuration version, coverage and origin labels.
2. **Scenario / stress test** — hypothetical parameters applied to the snapshot (`build_model`). Hypothetical staff never become real staff.
3. **Simulation** — replications of the event-driven engine; metrics aggregated and stored; replication-1 events stored in `simulated_events`.
4. **Recommendation** — constraints → feasibility → Pareto front → deterministic selection, with evidence and the exact configuration diff.

## Decision workflow

Observe → Simulate → Compare → Recommend → **Approve** → **Apply** → Verify

- A change request copies the recommendation's diff, the source simulation and the source configuration version.
- Approvals must cover every affected department; the requester can't approve their own request (separation of duties).
- Apply runs in one transaction: re-checks permission, approval validity, configuration version (stale → rejected), resource state; flips `APPROVED → APPLIED` with a conditional update (no double apply); writes a new configuration version, updates resources, records before/after, an operational event, an audit record and a prediction record. An `Idempotency-Key` makes retries safe.
- Any later configuration change makes older requests `STALE`.

## Security model

- Argon2id password hashes; session tokens stored only as SHA-256 hashes; absolute (8 h) and idle (60 min) expiry; revocation.
- CSRF double-submit token on every state-changing request; SameSite cookies; CORS limited to configured origins.
- Login rate limiting per IP and account lockout after repeated failures.
- RBAC: permissions are database rows; role grants are `global`, `department` (via memberships) or `assigned` (own work). Checks happen at function, scope and object level on every endpoint; out-of-scope objects return the same 404 as missing ones.
- Append-only audit log: no API to edit or delete; the ORM refuses updates/deletes. Stronger tamper evidence (write-once storage, hash chaining, separate DB credentials) is recommended for production.
- No secrets in code; configuration via environment variables.

## Deliberate simplifications

- Live updates use polling (15 s) with a visible last-updated time rather than WebSockets.
- SQLite and an in-process rate limiter assume a single backend process; use PostgreSQL and a shared limiter to scale out.
- Schema is created with `create_all`; add Alembic migrations before the schema needs to evolve in place.
