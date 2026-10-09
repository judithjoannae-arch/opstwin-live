import { useEffect, useState } from "react";
import { isAbortError } from "../../api/http";
import { twinApi } from "../../api/twinApi";
import type { SimEvent } from "../../types/twin";
import { STAGES, STAGE_LABELS } from "../../utils/format";
import { minutesLabel } from "../../utils/twin";
import { DataLabel } from "../DataLabel";
import { EmptyState, ErrorNotice, Loading } from "../ui";

const TYPES = [
  "ARRIVAL", "QUEUE_ENTER", "QUEUE_EXIT", "RESOURCE_ASSIGNED", "SERVICE_START", "SERVICE_COMPLETE", "RESOURCE_RELEASED",
  "CLASSIFIED", "SERVICE_INTERRUPTED", "TRANSFER", "REWORK", "PRIORITY_ESCALATED", "SLA_BREACHED", "RESOURCE_FAILURE",
  "RESOURCE_RECOVERY", "SHIFT_START", "SHIFT_END", "HOLD_RELEASED", "TICKET_CLOSED", "BACKLOG_CARRYOVER",
];

/** Simulated event log of one run. Stored apart from real operational events. */
export function SimulatedEventsTable({ runId, resourceNames = {} }: { runId: string; resourceNames?: Record<string, string> }) {
  const [filters, setFilters] = useState({ event_type: "", stage: "", ticket: "" });
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError(null);
    twinApi
      .events(runId, { ...filters, page_size: 100 }, c.signal)
      .then((page) => {
        setEvents(page.items);
        setCursor(page.next_cursor ?? null);
        setNote(page.note);
      })
      .catch((e: unknown) => !isAbortError(e) && setError(e))
      .finally(() => !c.signal.aborted && setLoading(false));
    return () => c.abort();
  }, [runId, filters]);

  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await twinApi.events(runId, { ...filters, cursor, page_size: 100 });
      setEvents((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-3 grid gap-x-3 sm:grid-cols-3">
        <label className="ot-field">
          <span>Event type</span>
          <select value={filters.event_type} onChange={(e) => setFilters({ ...filters, event_type: e.target.value })}>
            <option value="">Any</option>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Stage</span>
          <select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}>
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
          <input
            placeholder="TCK-000123 or SIM-00012"
            onKeyDown={(e) => {
              if (e.key === "Enter") setFilters({ ...filters, ticket: (e.target as HTMLInputElement).value.trim() });
            }}
          />
        </label>
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}
      <ErrorNotice error={error} />
      {loading && events.length === 0 ? (
        <Loading label="Loading simulated events" />
      ) : events.length === 0 ? (
        <EmptyState title="No simulated events match" />
      ) : (
        <div className="ot-table-wrap max-h-[28rem] overflow-y-auto">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Sim time</th>
                <th scope="col">Event</th>
                <th scope="col">Ticket</th>
                <th scope="col">Stage</th>
                <th scope="col">Resource</th>
                <th scope="col">Detail</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap tabular-nums">{minutesLabel(e.sim_minute)}</td>
                  <td>
                    <code>{e.event_type}</code>
                  </td>
                  <td className="ot-mono">{e.ticket_ref ?? "—"}</td>
                  <td>{e.stage ? STAGE_LABELS[e.stage] : "—"}</td>
                  <td>{e.resource_id ? resourceNames[e.resource_id] ?? (e.resource_id.startsWith("HYP-") ? "Hypothetical staff" : "Staff member") : "—"}</td>
                  <td className="text-sm text-muted">{e.detail ?? ""}</td>
                  <td>
                    <DataLabel origin="simulated" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div className="ot-pager">
          <button type="button" className="ot-btn ot-btn-quiet" disabled={loading} onClick={() => void more()}>
            Load more events
          </button>
        </div>
      )}
    </div>
  );
}
