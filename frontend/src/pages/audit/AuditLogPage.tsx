import { Fragment, useEffect, useState, type FormEvent } from "react";
import { isAbortError } from "../../api/http";
import { auditApi } from "../../api/rbacApi";
import type { AuditEntry, AuditOutcome } from "../../api/types";
import { useCurrentUser } from "../../auth/AuthContext";
import { DiffTable, EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, diffSnapshots, formatDateTime, formatValue } from "../../components/ui";

interface Filters {
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: "" | AuditOutcome;
  department_id: string;
  occurred_from: string;
  occurred_to: string;
}

const EMPTY: Filters = {
  actor: "",
  action: "",
  target_type: "",
  target_id: "",
  outcome: "",
  department_id: "",
  occurred_from: "",
  occurred_to: "",
};

const KNOWN_ACTIONS = [
  "auth.login.succeeded",
  "auth.login.failed",
  "user.invited",
  "user.activated",
  "user.deactivated",
  "user.roles.changed",
  "role.permissions.changed",
  "membership.added",
  "membership.removed",
  "ticket.assigned",
  "ticket.status.changed",
  "resource.changed",
  "staffing.changed",
  "snapshot.created",
  "simulation.created",
  "simulation.run",
  "recommendation.created",
  "change.requested",
  "change.approved",
  "change.rejected",
  "change.applied",
  "report.exported",
  "access.denied",
];

const PAGE_SIZE = 50;

/**
 * Read-only audit viewer. There are no edit or delete controls, and the
 * backend exposes no endpoints for them.
 */
export default function AuditLogPage() {
  const user = useCurrentUser();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    auditApi
      .list({ ...applied, page_size: PAGE_SIZE }, controller.signal)
      .then((page) => {
        setEntries(page.items);
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
    setError(null);
    try {
      const page = await auditApi.list({ ...applied, page_size: PAGE_SIZE, cursor });
      setEntries((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setExpanded(null);
    setApplied({ ...draft });
  };

  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <div className="ot-page">
      <PageHeader
        title="Audit log"
        description="Who did what, when, and what changed. Entries are append-only and can't be edited or deleted."
      />

      <form className="ot-filters" onSubmit={onSubmit} aria-label="Filter audit entries">
        <label className="ot-field">
          <span>Person</span>
          <input value={draft.actor} onChange={set("actor")} placeholder="Name, email or user ID" />
        </label>
        <label className="ot-field">
          <span>Action</span>
          <input value={draft.action} onChange={set("action")} list="ot-audit-actions" placeholder="e.g. change.applied" />
          <datalist id="ot-audit-actions">
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
        <label className="ot-field">
          <span>Target type</span>
          <input value={draft.target_type} onChange={set("target_type")} placeholder="ticket, role, change_request…" />
        </label>
        <label className="ot-field">
          <span>Target ID</span>
          <input value={draft.target_id} onChange={set("target_id")} />
        </label>
        <label className="ot-field">
          <span>Outcome</span>
          <select value={draft.outcome} onChange={set("outcome")}>
            <option value="">Any</option>
            <option value="SUCCESS">Succeeded</option>
            <option value="DENIED">Denied</option>
            <option value="FAILURE">Failed</option>
          </select>
        </label>
        <label className="ot-field">
          <span>Department</span>
          <select value={draft.department_id} onChange={set("department_id")}>
            <option value="">All I can see</option>
            {user.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
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
          <button type="button" className="ot-btn ot-btn-quiet" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>
            Clear
          </button>
          <button type="submit" className="ot-btn ot-btn-primary">
            Show entries
          </button>
        </div>
      </form>

      <ErrorNotice error={error} onRetry={() => setNonce((n) => n + 1)} />

      {loading && entries.length === 0 ? (
        <Loading label="Loading audit entries" />
      ) : entries.length === 0 && !error ? (
        <EmptyState title="No entries match these filters">Widen the date range or clear a filter.</EmptyState>
      ) : (
        <div className="ot-table-wrap">
          <table className="ot-table ot-audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Person</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Department</th>
                <th scope="col">Outcome</th>
                <th scope="col">
                  <span className="ot-visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isOpen = expanded === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr className={isOpen ? "is-open" : undefined}>
                      <td className="ot-nowrap">{formatDateTime(entry.occurred_at)}</td>
                      <td>{entry.actor?.full_name ?? <span className="ot-muted">System or unknown</span>}</td>
                      <td>
                        <code>{entry.action}</code>
                      </td>
                      <td>
                        {entry.target_type}
                        {entry.target_id && <div className="ot-muted ot-small">{entry.target_id}</div>}
                      </td>
                      <td>{entry.department_name ?? <span className="ot-muted">—</span>}</td>
                      <td>
                        <StatusBadge status={entry.outcome} />
                      </td>
                      <td className="ot-cell-actions">
                        <button
                          type="button"
                          className="ot-btn ot-btn-quiet"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : entry.id)}
                        >
                          {isOpen ? "Hide details" : "Details"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="ot-audit-detail">
                        <td colSpan={7}>
                          <dl className="ot-facts">
                            <div>
                              <dt>Reference ID</dt>
                              <dd>
                                <code>{entry.correlation_id}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Entry ID</dt>
                              <dd>
                                <code>{entry.id}</code>
                              </dd>
                            </div>
                          </dl>
                          {(entry.before || entry.after) && (
                            <>
                              <h3>What changed</h3>
                              <DiffTable rows={diffSnapshots(entry.before, entry.after)} />
                            </>
                          )}
                          {entry.details && Object.keys(entry.details).length > 0 && (
                            <>
                              <h3>Context</h3>
                              <pre className="ot-pre">{formatValue(entry.details)}</pre>
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div className="ot-pager">
          <button type="button" className="ot-btn ot-btn-quiet" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? "Loading…" : "Load older entries"}
          </button>
        </div>
      )}
    </div>
  );
}
