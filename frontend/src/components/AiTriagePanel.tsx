import { useState } from "react";
import { isApiError } from "../api/http";
import { aiApi } from "../api/aiApi";
import { ticketsApi } from "../api/opsApi";
import { useAuth } from "../auth/AuthContext";
import { P } from "../auth/permissions";
import { useResource } from "../hooks/useResource";
import type { TicketDetail } from "../types/operations";
import { CATEGORY_LABELS } from "../utils/format";
import { PriorityExplanation } from "./PriorityExplanation";
import { AiBadge, ConfidenceBar } from "./AiBadge";
import { ErrorNotice } from "./ui";

const ACTION_TEXT = {
  auto_applied: "AI triage handled intake for this ticket automatically.",
  left_for_human: "AI triage wasn't confident enough, so it left this ticket for a person.",
  suggested: null,
} as const;

/** Advice from the triage model, with one-click actions that go through the normal, audited ticket API. */
export default function AiTriagePanel({ ticket, onUpdated }: { ticket: TicketDetail; onUpdated: (t: TicketDetail) => void }) {
  const { can } = useAuth();
  const advice = useResource((signal) => aiApi.triage(ticket.id, signal), [ticket.id, ticket.version]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const editable = ticket.status === "open" && (ticket.stage === "intake" || ticket.stage === "triage")
    && can(P.TICKETS_UPDATE, { departmentId: ticket.stage });
  const canAssign = can(P.TICKETS_ASSIGN, { departmentId: ticket.stage });

  const act = async (patch: { category?: TicketDetail["category"]; assigned_resource_id?: string }) => {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await ticketsApi.update(ticket.id, { version: ticket.version, ...patch }));
    } catch (e) {
      setError(isApiError(e) && e.status === 409 ? new Error("The ticket changed meanwhile. Reload the page and try again.") : e);
    } finally {
      setBusy(false);
    }
  };

  if (advice.error || !advice.data) return null;
  const a = advice.data;

  return (
    <section className="ot-panel" aria-labelledby="ai-panel-title">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="ai-panel-title" className="m-0">AI triage assistant</h2>
        <AiBadge />
      </div>
      {a.automatic_action && ACTION_TEXT[a.automatic_action] && <p className="mt-0 text-sm text-muted">{ACTION_TEXT[a.automatic_action]}</p>}
      <dl className="m-0 grid gap-3">
        <div>
          <dt className="text-xs text-muted">Reads as</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <strong>{CATEGORY_LABELS[a.category.label]}</strong>
            <ConfidenceBar value={a.category.confidence} />
          </dd>
          {a.category.evidence.length > 0 && (
            <dd className="m-0 mt-1 text-xs text-muted">Because of: {a.category.evidence.join(", ")}</dd>
          )}
          {a.category_mismatch && (
            <dd className="m-0 mt-2 text-sm text-warn">
              Filed as {CATEGORY_LABELS[a.current_category]}. Correcting it also recalculates the priority.
              {editable && (
                <button type="button" className="ot-btn ot-btn-quiet ml-2" disabled={busy} onClick={() => void act({ category: a.category.label })}>
                  Change to {CATEGORY_LABELS[a.category.label]}
                </button>
              )}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-muted">Priority (calculated automatically, never chosen by hand)</dt>
          <dd className="m-0">
            <PriorityExplanation a={a.priority_assessment} />
          </dd>
        </div>
        {a.suggested_technician && canAssign && !ticket.assigned_resource && (
          <div>
            <dt className="text-xs text-muted">Suggested technician</dt>
            <dd className="m-0 flex flex-wrap items-center gap-2">
              <strong>{a.suggested_technician.name}</strong>
              <button type="button" className="ot-btn ot-btn-quiet" disabled={busy}
                      onClick={() => void act({ assigned_resource_id: a.suggested_technician!.id })}>
                Assign
              </button>
            </dd>
            <dd className="m-0 mt-1 text-xs text-muted">{a.suggested_technician.reason}</dd>
          </div>
        )}
      </dl>
      <ErrorNotice error={error} />
    </section>
  );
}
