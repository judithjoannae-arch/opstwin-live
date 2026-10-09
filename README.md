# OpsTwin Live

An interactive operations digital twin for a campus IT service desk. The website runs the real ticket workflow
(intake → triage → technical support → verification) and stores everything in a database. The digital twin takes
consistent snapshots of that live state, simulates the future with an event-driven model, compares mitigation
strategies under stress, and recommends a change that only reaches live configuration after approval.

Runs locally. No paid services, external APIs or API keys.

## Status

| Part | State |
| --- | --- |
| Backend: live website API, RBAC, digital twin engine, stress test, recommendations, approvals, audit, reports, prediction monitor, AI triage, autonomous monitor | Done, 64 automated tests |
| Frontend: all 14 pages from the brief plus approvals, audit and administration | Done, 25 automated tests |
| End-to-end: the judge sequence below, run in a headless browser against the real backend | Passing |

## Quick start

Needs **Python 3.11+** and **Node.js 20+**.

### Ubuntu / Kali Linux

```bash
# Kali/Ubuntu packages (Node 20 from nodesource or nvm if your distro ships an older one)
sudo apt update && sudo apt install -y python3 python3-venv python3-pip

# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export OPSTWIN_DEMO_PASSWORD='ChooseADemoPassw0rd'     # or leave unset to get a generated one
python -m app.seed --demo                              # schema, roles, demo staff, accounts, 72 h synthetic history
uvicorn app.main:app --reload --port 8000              # API on :8000, docs at /api/docs

# Frontend (second terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                                            # http://localhost:5173
```

### Windows (PowerShell)

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
$env:OPSTWIN_DEMO_PASSWORD = "ChooseADemoPassw0rd"
python -m app.seed --demo
uvicorn app.main:app --reload --port 8000

# second terminal
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

If PowerShell blocks the activate script: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Docker

```bash
OPSTWIN_DEMO_PASSWORD='ChooseADemoPassw0rd' docker compose up --build -d
docker compose exec backend python -m app.seed --demo
# open http://localhost:8080
```

### Useful commands

```bash
python -m app.seed --reset --demo                              # start over (development only)
python -m app.seed --import-tickets ../sample_data/sample_tickets.csv
python -m app.seed --create-admin you@campus.edu               # real Super Admin; password from OPSTWIN_ADMIN_PASSWORD
python -m pytest -q                                            # backend tests
npm test && npm run typecheck                                  # frontend tests
```

## Demo accounts (development only)

Created by `python -m app.seed --demo`, all with the password from `OPSTWIN_DEMO_PASSWORD` (or the one printed once).
Never use these in production.

| Email | Role | Departments |
| --- | --- | --- |
| superadmin@opstwin.demo | Super Admin | all |
| ops.manager@opstwin.demo | Operations Manager | all |
| support.manager@opstwin.demo | Department Manager | Technical support |
| triage.manager@opstwin.demo | Department Manager | Triage |
| technician@opstwin.demo | Technician (linked to staff member Ravi Kumar) | Technical support |
| analyst@opstwin.demo | Analyst | all (read and simulate) |
| auditor@opstwin.demo | Auditor | all (read only) |

Demo staff, tickets and events are synthetic, marked `is_demo` and shown with a Demo tag. Tickets you create through
the website are real records.

## Judge walkthrough

Seed the demo first (`python -m app.seed --demo`). Pages are in the left sidebar.

1. **Live website.** Open `/submit` and report a few problems. Sign in as **ops.manager**. Tickets: send them to triage,
   route them to technical support, assign a technician. The dashboard and Workflow explorer show the real queues.
2. **Digital twin → Refresh twin.** Shows the snapshot time and configuration version, what the model learned from
   the data (each input labelled Observed / Derived / Assumed), and **Run 8-hour forecast**: observed queues on the left,
   predicted queues on the right (dashed violet = simulated).
3. **Stress test → Run stress test.** Takes a fresh snapshot, doubles demand and removes the busiest technician on
   shift, then runs A normal, B unmitigated failure, C smart triage, D capacity reallocation and E combined on the
   same snapshot and seeds. *Where waiting moves* shows reallocation shortening the support queue while the donor
   stage waits longer.
4. **Evaluate recommendations.** Unsafe options are rejected with the limit they break; the selected option shows its
   evidence, trade-offs and the exact configuration change. Click **Request this change**.
5. Sign in as **superadmin** in another browser (a different person) → Approvals → Approve. The requester can't
   approve their own request.
6. Back as **ops.manager** → Approvals → Ready to apply → **Apply change**. Settings → Configuration history shows the
   new version; Audit trail shows request, approval and application with before/after values.
7. **Digital twin → Refresh twin**: the snapshot now uses the new configuration. Run the forecast or stress test again.
8. **Results and analytics** and each run page export JSON/CSV reports. **Model assumptions** lists every input,
   its source and sample size, the limitations, and a sensitivity sweep. **Prediction monitor** compares the
   prediction with what happens next. **Event log → Simulated runs** shows simulated events, kept apart from real ones.

Demoing late at night? Night shifts are thin. Untick **Follow staff shifts** on the Stress test page to assume day staffing.

## AI automation (runs locally, no API key)

Open **AI automation** in the sidebar. Both automations are **off** until someone with policy rights switches them on.

- **Automatic priority (nobody chooses it).** Every ticket's priority is calculated with the standard ITSM
  **impact × urgency** matrix: impact from the "affects many people" answer, the category and wording such as
  *everyone* or *whole lab*; urgency from wording such as *exam*, *down* or *locked out* (high), *slow* or *drops*
  (medium), *install* or *need access* (low). The same situation always gets the same priority, the reasons are shown
  on every ticket, and the server rejects manual priority changes. Correcting a category recalculates it.
- **AI triage assistant.** A Naive Bayes text classifier, trained on this server from reviewed tickets plus 60 starter
  examples, reads each new ticket and predicts its category with a confidence score and the words behind the decision.
  With **AI intake** on, confident predictions correct a mislabelled category and move the ticket to Triage; unsure ones
  are left for a person. Every ticket page shows the advice, and *New ticket* suggests a category (and shows the
  priority it will get) as you type. The model card shows cross-validated and live accuracy; it retrains on demand and
  after each monitor run.
- **Autonomous twin monitor.** Every few minutes (or on **Run a check now**) it compares the last two hours of demand
  with what the twin expects and looks for bottlenecks. Only when something is wrong does it refresh the twin, simulate
  today's trajectory with each mitigation and place the safest option in **Approvals** as "OpsTwin Monitor
  (automated)". It never applies changes; people approve and apply.

No LLM is used. Everything is explainable, reproducible and audited (`ai.auto_intake`, `ai.monitor.risk_detected`,
`ai.settings.changed`).

**Demo tip:** turn on AI intake, then file a Wi-Fi problem under *Hardware* at `/submit`. The ticket arrives in Triage
already corrected, with the reason in its history. For the monitor, create 6–10 tickets quickly as ops.manager and
click **Run a check now**.

## Roles and permissions

Permissions live in the database. Role grants are `global`, `department` (applies in the user's member departments)
or `assigned` (only the user's own assigned work).

| Capability | Super Admin | Ops Manager | Dept Manager | Technician | Analyst | Auditor |
| --- | --- | --- | --- | --- | --- | --- |
| Users, roles, RBAC policy | ✓ | | | | | |
| Global dashboard | ✓ | ✓ | | | metrics view | |
| Tickets read / create / update / assign | ✓ | ✓ | department | read dept, update assigned | | |
| Resources and staffing | ✓ | ✓ | department | | | |
| Snapshots | ✓ | ✓ | department | | | |
| Run simulations | ✓ | ✓ | department | | ✓ | |
| Recommendations | ✓ | ✓ | department | | ✓ | read |
| Request / approve / apply changes | ✓ | ✓ | department | | | |
| Reports | ✓ | ✓ | department | | ✓ | ✓ |
| Audit log | ✓ | ✓ | department | | | ✓ |
| SLA and operational policies | ✓ | ✓ | | | | |

**Approval policy.** Every operational change needs approval covering each affected department, by someone other
than the requester (separation of duties). Requests expire after 24 h and become stale if the live configuration
changes; stale or already-applied requests are rejected.

**Authentication.** Argon2id hashes, HTTP-only `SameSite=Lax` session cookie, CSRF double-submit token, 8 h absolute
and 60 min idle expiry, revocation, login rate limiting and lockout, admin-created accounts with single-use expiring
invitation links (shown in the admin UI in development because there's no email service).

## Security limitations

- Single-process rate limiter and SQLite: fine for a demo, not for horizontal scaling.
- Audit log is append-only at the application level; production should add write-once storage or hash chaining and
  restrict direct database access.
- Development mode serves cookies without `Secure`; set `OPSTWIN_ENV=production` behind HTTPS.
- No email delivery: invitation links are surfaced to administrators in development only.

## Repository layout

```
backend/   FastAPI app (api, core, database, models, services, simulation, recommendations), tests
frontend/  React + Vite + TypeScript + Tailwind
docs/      architecture.md, model_assumptions.md, api.md
sample_data/sample_tickets.csv
docker-compose.yml, .github/workflows/ci.yml
```
