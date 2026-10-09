# OpsTwin Live API

Base path `/api`. Interactive schema: `http://localhost:8000/api/docs` (OpenAPI at `/api/openapi.json`).

## Conventions

- **Auth:** HTTP-only session cookie `opstwin_session` set by `POST /auth/login`. No bearer tokens.
- **CSRF:** every `POST/PUT/PATCH/DELETE` must send `X-CSRF-Token` equal to the `opstwin_csrf` cookie (get it from `GET /auth/csrf`). Failures return `403 {"detail":{"code":"csrf_failed"}}`.
- **Errors:** `{"detail": {"code": "...", "message": "..."}}`; validation errors are `422 {"detail": [ ... ]}`.
  `401` = not signed in / session ended (`session_expired`, `session_revoked`, `account_deactivated`), `403` = signed in but not allowed,
  `404` = missing **or outside your scope** (same response, no existence leak), `409` = conflict (`version_conflict`, `invalid_transition`, `stale`, `already_applied`, ...), `429` = rate limited (`Retry-After`).
- **Correlation:** every response carries `X-Request-ID`; audit records store it as `correlation_id`.
- **Times:** ISO 8601 UTC with a trailing `Z`.
- **Concurrency:** tickets, resources, roles and scenarios carry `version`; send it back on update. Config-changing writes send `expected_config_version`.
- **Provenance:** simulated payloads carry `"data_origin": "simulated"`; demo records carry `is_demo: true`.

## Endpoints

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness + DB check |
| GET | `/auth/csrf` | none | Returns/sets the CSRF token |
| POST | `/auth/login` | none | `{email, password}`; 401 `invalid_credentials`, 429 `account_locked` / `rate_limited` |
| POST | `/auth/logout` | session | Revokes the session |
| GET | `/auth/me` | session | User, roles, memberships, resolved `grants`, `session_expires_at` |
| GET / DELETE | `/auth/sessions`, `/auth/sessions/{id}` | session | Own sessions |
| POST | `/auth/sessions/revoke-others` | session | |
| POST | `/auth/invitations/accept` | invitation token | `{token, password}` |
| POST | `/public/requests` | none (rate-limited) | Student/staff intake form → ticket in `intake` |
| GET | `/operations/state?window_hours=24` | dashboard/tickets/resources/simulations read | Scoped to visible departments; nulls mean insufficient data |
| GET | `/events` | tickets/resources/audit read | Real operational events; cursor paging |
| GET / POST | `/tickets` | `tickets.read` / `tickets.create` | Filters: `q, stage, status, priority, category, sla_state, assigned=me|unassigned, sort, page, page_size` |
| GET / PATCH | `/tickets/{id}` | `tickets.read` / `tickets.update`, `tickets.assign` | PATCH `{version, stage?, status?, priority?, assigned_resource_id?, note?}` |
| POST | `/tickets/{id}/notes` | `tickets.update` (incl. own assigned) | `{body}` |
| GET / POST | `/resources` | `resources.read` / `resources.manage` | |
| PATCH | `/resources/{id}` | `resources.manage` in the stage | Availability changes are events; stage/reserve changes create a config version |
| GET / PUT | `/sla-policies` | read roles / global `policies.manage` | PUT `{expected_config_version, policies[4], reason}` |
| GET | `/config/versions` | governance roles | Immutable configuration history |
| POST / GET | `/twin/snapshots` | `snapshots.create` / twin read | Consistent snapshot + estimated model parameters with origin labels |
| GET | `/twin/snapshots/{id}` | twin read + scope | Includes `assumptions`, `limitations`, `coverage` |
| GET / POST | `/scenarios` | `simulations.read` / `simulations.run` | `{name, snapshot_id, parameters}` |
| GET / PATCH | `/scenarios/{id}` | | PATCH with `version` |
| POST | `/scenarios/{id}/clone` | `simulations.run` | Optional `snapshot_id` to re-base |
| POST | `/simulations/run` | `simulations.run` | `{scenario_id}` or `{snapshot_id, parameters, label}` |
| POST | `/simulations/stress-test` | `simulations.run` | Runs scenarios A–E on one snapshot (creates one if allowed) |
| POST | `/simulations/sensitivity` | `simulations.run` | Sweep `demand`, `service_time` or `staff` |
| GET | `/simulations`, `/simulations/{id}` | twin read + scope | |
| GET | `/simulations/{id}/metrics` | twin read + scope | Mean/std/95% CI per metric, time series, hourly demand vs completions |
| GET | `/simulations/{id}/events` | twin read + scope | Simulated events (replication 1), filtered to the snapshot's departments |
| GET | `/stress-tests`, `/stress-tests/{id}` | twin read + scope | Includes the A–E comparison |
| POST | `/recommendations/evaluate` | `recommendations.read` | `{stress_test_id, constraints?}` → recommendation cards |
| GET | `/recommendations`, `/recommendations/{id}` | `recommendations.read` | |
| POST | `/recommendations/{id}/approve` | `changes.approve` | Spec alias: approves the pending change request |
| GET / POST | `/change-requests` | change/audit roles / `changes.request` | Filters `status, awaiting=me, requested_by=me` |
| GET | `/change-requests/{id}` | change/audit roles | Includes `can_approve`, `can_apply`, `blocked_reason` |
| POST | `/change-requests/{id}/decisions` | `changes.approve` | `{decision: APPROVED|REJECTED, reason}`; 403 `separation_of_duties` |
| POST | `/change-requests/{id}/apply`, `/changes/apply` | `changes.apply` | `{expected_config_version}` + `Idempotency-Key` header |
| GET | `/audit-log` | `audit.read` | Filters `actor, action, target_type, target_id, outcome, department_id, occurred_from, occurred_to` |
| GET | `/reports/{simulation_id}/export?format=json|csv` | `reports.export` | Exactly the stored metrics, plus assumptions and limitations |
| GET | `/reports/stress-tests/{id}/export` | `reports.export` | All runs and evaluations |
| GET | `/prediction-monitor` | governance roles | Predicted vs observed after applied changes |
| | `/users…`, `/roles…`, `/permissions`, `/departments…` | global `users.manage` / `roles.manage` | Administration |

## Scenario parameters

```json
{
  "duration_hours": 8, "demand_multiplier": 2.0, "base_arrival_rate_per_hour": null,
  "category_mix": null, "removed_resource_ids": [], "resource_unavailability": [{"resource_id": "…", "from_minute": 60, "to_minute": 180}],
  "activate_reserve_ids": [], "reallocations": [{"resource_id": "…", "to_stage": "support"}],
  "extra_staff": {"support": 1}, "service_time_multipliers": {"support": 1.2},
  "routing_policy": "fifo | priority | smart_triage", "skill_aware_routing": true,
  "sla_resolution_minutes": {"P1": 180}, "rework_rate": null, "transfer_rate": null,
  "respect_shifts": true, "seed": 42, "replications": 10
}
```

`null` means "use the snapshot's observed or assumed value". `extra_staff` are hypothetical and never create real staff.

## Recommendation constraints

```json
{
  "min_p1_sla_compliance_pct": 85, "min_sla_compliance_pct": 70, "max_ending_backlog": 30,
  "min_throughput_ratio": 0.9, "max_mean_wait_min": 240, "max_stage_wait_increase_min": 30,
  "min_feasible_share": 0.7, "cost_per_reserve_hour": null, "cost_per_transfer_hour": null
}
```
