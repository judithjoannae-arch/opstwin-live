import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { twinApi } from "../../api/twinApi";
import { useResource } from "../../hooks/useResource";
import { SimulatedEventsTable } from "../../components/twin/SimulatedEventsTable";
import { isAbortError } from "../../api/http";
import { eventsApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import type { EventQuery, OperationalEvent } from "../../types/operations";
import { STAGES, STAGE_LABELS } from "../../utils/format";
import { DataLabel } from "../../components/DataLabel";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

const EVENT_TYPES = [
  "ticket.created",
  "ticket.stage_changed",
  "ticket.status_changed",
  "ticket.assigned",
  "ticket.priority_changed",
  "ticket.note_added",
  "ticket.sla_breached",
  "resource.created",
  "resource.updated",
  "resource.availability_changed",
  "sla.policy_changed",
  "config.change_applied",
];

type Filters = Required<Pick<EventQuery, "event_type" | "stage" | "ticket" | "occurred_from" | "occurred_to">>;
const EMPTY: Filters = { event_type: "", stage: "", ticket: "", occurred_from: "", occurred_to: "" };
const PAGE_SIZE = 50;

/**
 * Real operational events recorded by the website. Simulated events live
 * with each simulation run and are never mixed into this log.
 */
function RealEventLog() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    eventsApi
      .list({ ...applied, page_size: PAGE_SIZE }, controller.signal)
      .then((page) => {
        setEvents(page.items);
        setCursor(page.next_cursor ?? null);
      })
      .catch((e: unknown) => {
        if (!isAbortError(e)) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applied, nonce]);

  const loadOlder = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await eventsApi.list({ ...applied, page_size: PAGE_SIZE, cursor });
      setEvents((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...draft });
  };
  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <div>
      <form className="ot-filters" onSubmit={onSubmit} aria-label="Filter events">
        <label className="ot-field">
          <span>Event type</span>
          <select value={draft.event_type} onChange={set("event_type")}>
            <option value="">Any</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Stage</span>
          <select value={draft.stage} onChange={set("stage")}>
            <option value="">Any</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Ticket</span>
          <input value={draft.ticket} onChange={set("ticket")} placeholder="Reference, e.g. TCK-000123" />
        </label>
        <label className="ot-field">
          <span>From</span>
          <input type="date" value={draft.occurred_from} onChange={set("occurred_from")} />
        </label>
        <label className="ot-field">
          <span>To</span>
          <input type="date" value={draft.occurred_to} onChange={set("occurred_to")} />
        </label>
        <div className="ot-filters-actions">
          <button
            type="button"
            className="ot-btn ot-btn-quiet"
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
            }}
          >
            Clear
          </button>
          <button type="submit" className="ot-btn ot-btn-primary">
            Show events
          </button>
        </div>
      </form>

      <ErrorNotice error={error} onRetry={() => setNonce((n) => n + 1)} />

      {loading && events.length === 0 ? (
        <Loading label="Loading events" />
      ) : events.length === 0 && !error ? (
        <EmptyState title="No events match these filters">Clear a filter or widen the dates.</EmptyState>
      ) : (
        <div className="ot-table-wrap">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Ticket</th>
                <th scope="col">Stage</th>
                <th scope="col">Staff</th>
                <th scope="col">By</th>
                <th scope="col">What happened</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="whitespace-nowrap text-sm">{formatDateTime(ev.occurred_at)}</td>
                  <td>
                    <code>{ev.event_type}</code>
                  </td>
                  <td>
                    {ev.ticket_id ? (
                      <Link to={`/tickets/${ev.ticket_id}`} className="ot-link ot-mono">
                        {ev.ticket_reference}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>{ev.stage ? STAGE_LABELS[ev.stage] : <span className="text-muted">—</span>}</td>
                  <td>{ev.resource_name ?? <span className="text-muted">—</span>}</td>
                  <td>{ev.actor?.full_name ?? <span className="text-muted">Requester or system</span>}</td>
                  <td className="min-w-[14rem]">{ev.summary}</td>
                  <td>
                    <DataLabel origin={ev.is_demo ? "synthetic" : "observed"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div className="ot-pager">
          <button type="button" className="ot-btn ot-btn-quiet" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? "Loading…" : "Load older events"}
          </button>
        </div>
      )}
    </div>
  );
}


function SimulatedEventLog() {
  const runs = useResource((signal) => twinApi.runs({ limit: 40 }, signal), []);
  const [runId, setRunId] = useState<string>("");
  const selected = runId || runs.data?.[0]?.id || "";
  if (runs.error) return <ErrorNotice error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Loading label="Loading simulation runs" />;
  if (runs.data.length === 0) return <EmptyState title="No simulation runs yet">Run a forecast, scenario or stress test to see simulated events.</EmptyState>;
  return (
    <section className="ot-panel ot-sim">
      <label className="ot-field ot-field-inline mb-4">
        <span>Simulation run</span>
        <select value={selected} onChange={(e) => setRunId(e.target.value)}>
          {runs.data.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} ({formatDateTime(r.created_at)})
            </option>
          ))}
        </select>
      </label>
      <SimulatedEventsTable key={selected} runId={selected} />
    </section>
  );
}

export default function EventLogPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canSim = can(P.SIMULATIONS_READ) || can(P.SIMULATIONS_RUN);
  const view = canSim && params.get("view") === "simulated" ? "simulated" : "real";
  const setView = (v: string) => setParams(new URLSearchParams(v === "real" ? {} : { view: v }), { replace: true });
  return (
    <div className="ot-page">
      <PageHeader
        title="Event log"
        description="Real operational events and simulated events are stored apart and shown apart."
        actions={
          can(P.AUDIT_READ) && (
            <Link to="/audit" className="ot-btn ot-btn-quiet">
              Security audit trail
            </Link>
          )
        }
      />
      {canSim && (
        <div className="ot-tabs" role="tablist" aria-label="Event source">
          <button type="button" role="tab" aria-selected={view === "real"} className={view === "real" ? "ot-tab is-active" : "ot-tab"} onClick={() => setView("real")}>
            Real operations
          </button>
          <button type="button" role="tab" aria-selected={view === "simulated"} className={view === "simulated" ? "ot-tab is-active" : "ot-tab"} onClick={() => setView("simulated")}>
            Simulated runs
          </button>
        </div>
      )}
      {view === "real" ? <RealEventLog /> : <SimulatedEventLog />}
    </div>
  );
}
