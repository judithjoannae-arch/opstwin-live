import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isApiError } from "../../api/http";
import { resourcesApi, ticketsApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { TicketDetail, TicketUpdate } from "../../types/operations";
import { CATEGORY_LABELS, STAGE_LABELS, formatRelative } from "../../utils/format";
import { availableActions, isActive, type WorkflowAction } from "../../utils/workflow";
import { DataLabel, DemoTag } from "../../components/DataLabel";
import { PriorityBadge, SlaBadge, StageText, StatusText } from "../../components/OpsBadges";
import { Dialog, ErrorNotice, Loading, Notice, formatDateTime } from "../../components/ui";
import AiTriagePanel from "../../components/AiTriagePanel";

const EVENT_LABELS: Record<string, string> = {
  "ticket.created": "Ticket created",
  "ticket.stage_changed": "Stage changed",
  "ticket.status_changed": "Status changed",
  "ticket.assigned": "Assignment changed",
  "ticket.priority_changed": "Priority changed",
  "ticket.category_changed": "Category changed",
  "ticket.note_added": "Note added",
  "ticket.sla_breached": "SLA deadline passed",
};

function AssignmentPanel({ ticket, onUpdate, busy }: { ticket: TicketDetail; onUpdate: (patch: Omit<TicketUpdate, "version">, msg: string) => void; busy: boolean }) {
  const staff = useResource((signal) => resourcesApi.list({ stage: ticket.stage }, signal), [ticket.stage]);
  const [choice, setChoice] = useState(ticket.assigned_resource?.id ?? "");
  const eligible = (staff.data ?? []).filter((r) => r.is_available && r.skills.includes(ticket.category));
  const others = (staff.data ?? []).filter((r) => !eligible.includes(r));
  const current = ticket.assigned_resource?.id ?? "";

  return (
    <section className="ot-panel">
      <h2>Assignment</h2>
      {staff.error ? (
        <ErrorNotice error={staff.error} onRetry={staff.reload} />
      ) : staff.loading && !staff.data ? (
        <Loading label="Loading staff" />
      ) : (
        <>
          <label className="ot-field">
            <span>Staff in {STAGE_LABELS[ticket.stage]}</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Unassigned</option>
              {eligible.length > 0 && (
                <optgroup label={`Available with ${CATEGORY_LABELS[ticket.category]} skills`}>
                  {eligible.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.active_ticket_count} active)
                    </option>
                  ))}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="Not eligible right now">
                  {others.map((r) => (
                    <option key={r.id} value={r.id} disabled>
                      {r.name}
                      {!r.is_available ? " (unavailable)" : " (no matching skill)"}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {eligible.length === 0 && (
            <p className="text-sm text-warn">
              Nobody in {STAGE_LABELS[ticket.stage]} is available with {CATEGORY_LABELS[ticket.category]} skills.
            </p>
          )}
          <button
            type="button"
            className="ot-btn ot-btn-quiet"
            disabled={busy || choice === current}
            onClick={() =>
              onUpdate(
                { assigned_resource_id: choice || null },
                choice ? `Assigned to ${staff.data?.find((r) => r.id === choice)?.name ?? "staff member"}.` : "Assignment removed.",
              )
            }
          >
            Save assignment
          </button>
        </>
      )}
    </section>
  );
}

export default function TicketDetailPage() {
  const { ticketId = "" } = useParams();
  const { can } = useAuth();
  const ticket = useResource((signal) => ticketsApi.get(ticketId, signal), [ticketId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [note, setNote] = useState("");

  if (ticket.loading && !ticket.data) return <Loading label="Loading ticket" />;
  if (ticket.error) {
    return (
      <div className="ot-page">
        <p>
          <Link to="/tickets" className="ot-link">
            Back to tickets
          </Link>
        </p>
        <ErrorNotice error={ticket.error} onRetry={isApiError(ticket.error) && ticket.error.status === 404 ? undefined : ticket.reload} />
      </div>
    );
  }
  const t = ticket.data;
  if (!t) return null;

  const scope = { departmentId: t.stage };
  const canUpdate = can(P.TICKETS_UPDATE, scope);
  const canAssign = can(P.TICKETS_ASSIGN, scope);
  const actions = canUpdate ? availableActions(t) : [];

  const update = async (patch: Omit<TicketUpdate, "version">, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await ticketsApi.update(t.id, { ...patch, version: t.version });
      ticket.setData(() => updated);
      setNotice(success);
      return true;
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        setError(new Error("Someone else updated this ticket. The latest version is now shown; check it and try again."));
        ticket.reload();
      } else {
        setError(e);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: WorkflowAction, noteText?: string) => {
    const ok = await update(
      { stage: action.to.stage, status: action.to.status, ...(noteText ? { note: noteText } : {}) },
      `${action.label}: done.`,
    );
    if (ok) {
      setPendingAction(null);
      setActionNote("");
    }
  };

  const addNote = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await ticketsApi.addNote(t.id, note.trim());
      ticket.setData(() => updated);
      setNote("");
      setNotice("Note added.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ot-page">
      <p className="mb-3 text-sm">
        <Link to="/tickets" className="ot-link">
          Tickets
        </Link>
        <span className="text-muted"> / {t.reference}</span>
      </p>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="ot-mono m-0 text-sm text-muted">
            {t.reference}
            {t.is_demo && <DemoTag />}
          </p>
          <h1 className="mt-1">{t.title}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <PriorityBadge priority={t.priority} />
            <StageText stage={t.stage} />
            <StatusText status={t.status} />
            <SlaBadge state={t.sla_state} />
          </div>
        </div>
        <DataLabel origin={t.is_demo ? "synthetic" : "observed"} />
      </header>

      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />

      <div className="grid items-start gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div>
          <section className="ot-panel">
            <dl className="ot-facts">
              <div>
                <dt>Category</dt>
                <dd>{CATEGORY_LABELS[t.category]}</dd>
              </div>
              <div>
                <dt>Requester</dt>
                <dd>
                  {t.requester_name}
                  <span className="block text-sm text-muted">{t.requester_email}</span>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(t.created_at)}</dd>
              </div>
              <div>
                <dt>SLA deadline</dt>
                <dd>
                  {formatDateTime(t.sla_deadline)}
                  {isActive(t.status) && <span className="block text-sm text-muted">{formatRelative(t.sla_deadline)}</span>}
                </dd>
              </div>
              <div>
                <dt>Assigned</dt>
                <dd>{t.assigned_resource?.name ?? "Unassigned"}</dd>
              </div>
              {t.resolved_at && (
                <div>
                  <dt>Resolved</dt>
                  <dd>{formatDateTime(t.resolved_at)}</dd>
                </div>
              )}
              {t.closed_at && (
                <div>
                  <dt>Closed</dt>
                  <dd>{formatDateTime(t.closed_at)}</dd>
                </div>
              )}
            </dl>
            <h2 className="mt-4">Description</h2>
            <p className="whitespace-pre-wrap">{t.description}</p>
          </section>

          <section className="ot-panel">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="m-0">History</h2>
              <DataLabel origin="observed" />
            </div>
            {t.history.length === 0 ? (
              <p className="text-sm text-muted">No events recorded.</p>
            ) : (
              <ol className="ot-timeline">
                {[...t.history].reverse().map((ev) => (
                  <li key={ev.id}>
                    <p className="text-sm">
                      <strong>{EVENT_LABELS[ev.event_type] ?? ev.event_type}</strong>
                      {ev.from_value || ev.to_value ? (
                        <span className="text-muted">
                          {" "}
                          {ev.from_value ?? "—"} to {ev.to_value ?? "—"}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted">
                      {formatDateTime(ev.occurred_at)}
                      {ev.actor
                        ? `, ${ev.actor.full_name}`
                        : ev.note && (ev.note.startsWith("AI triage") || ev.note.startsWith("Automated intake"))
                          ? ", AI triage (automated)"
                          : ", requester or system"}
                    </p>
                    {ev.note && <p className="mt-1 whitespace-pre-wrap text-sm">{ev.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside>
          <AiTriagePanel ticket={t} onUpdated={(updated) => { ticket.setData(() => updated); setNotice("Updated from the AI suggestion."); }} />
          {actions.length > 0 && (
            <section className="ot-panel">
              <h2>Next step</h2>
              <div className="flex flex-col gap-2">
                {actions.map((a) => {
                  const blocked = a.requiresAssignee && !t.assigned_resource;
                  return (
                    <button
                      key={a.key}
                      type="button"
                      className={`ot-btn ot-btn-${a.tone} ot-btn-block`}
                      disabled={busy || blocked}
                      title={blocked ? "Assign someone first" : undefined}
                      onClick={() => (a.noteLabel ? setPendingAction(a) : void runAction(a))}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>
              {actions.some((a) => a.requiresAssignee) && !t.assigned_resource && (
                <p className="mt-2 text-sm text-muted">Assign a technician before starting or resolving work.</p>
              )}
            </section>
          )}

          {canAssign && isActive(t.status) && (
            <AssignmentPanel key={`${t.id}:${t.version}`} ticket={t} onUpdate={(patch, msg) => void update(patch, msg)} busy={busy} />
          )}

          {canUpdate && (
            <section className="ot-panel">
              <h2>Investigation notes</h2>
              <label className="ot-field">
                <span>Add a note</span>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, what you found" />
              </label>
              <button type="button" className="ot-btn ot-btn-quiet" disabled={busy || note.trim().length < 3} onClick={() => void addNote()}>
                Add note
              </button>
            </section>
          )}
        </aside>
      </div>

      <Dialog
        open={!!pendingAction}
        title={pendingAction?.label ?? ""}
        onClose={() => setPendingAction(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setPendingAction(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={`ot-btn ot-btn-${pendingAction?.tone === "danger" ? "danger" : "primary"}`}
              disabled={busy || actionNote.trim().length < 5}
              onClick={() => pendingAction && void runAction(pendingAction, actionNote.trim())}
            >
              {pendingAction?.label}
            </button>
          </>
        }
      >
        {pendingAction && (
          <>
            <p className="text-muted">
              Moves the ticket to {STAGE_LABELS[pendingAction.to.stage]}. The note is saved in the ticket history.
            </p>
            <label className="ot-field">
              <span>{pendingAction.noteLabel}</span>
              <textarea rows={4} value={actionNote} onChange={(e) => setActionNote(e.target.value)} />
              <small>At least 5 characters.</small>
            </label>
          </>
        )}
      </Dialog>
    </div>
  );
}
