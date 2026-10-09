import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isApiError, newId } from "../../api/http";
import { changeRequestsApi } from "../../api/rbacApi";
import type { ChangeRequest } from "../../api/types";
import { useAuth, useCurrentUser } from "../../auth/AuthContext";
import { P, type PermissionRequirement } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import {
  DiffTable,
  Dialog,
  EmptyState,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  StatusBadge,
  formatDateTime,
} from "../../components/ui";

type TabKey = "decide" | "apply" | "mine" | "all";

const TABS: { key: TabKey; label: string; requirement: PermissionRequirement; query: Record<string, string> }[] = [
  { key: "decide", label: "Needs my decision", requirement: { permission: P.CHANGES_APPROVE }, query: { status: "PENDING", awaiting: "me" } },
  { key: "apply", label: "Ready to apply", requirement: { permission: P.CHANGES_APPLY }, query: { status: "APPROVED" } },
  { key: "mine", label: "My requests", requirement: { permission: P.CHANGES_REQUEST }, query: { requested_by: "me" } },
  { key: "all", label: "All requests", requirement: { anyOf: [P.CHANGES_APPROVE, P.CHANGES_APPLY] }, query: {} },
];

const MIN_REASON = 10;

function ChangeRequestDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const user = useCurrentUser();
  const { can } = useAuth();
  const cr = useResource((signal) => changeRequestsApi.get(id, signal), [id]);
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [reason, setReason] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One idempotency key per request, reused if the same apply is retried.
  const applyKeys = useRef(new Map<string, string>());

  if (cr.loading && !cr.data) return <Loading label="Loading request" />;
  if (cr.error) return <ErrorNotice error={cr.error} onRetry={cr.reload} />;
  if (!cr.data) return null;
  const req: ChangeRequest = cr.data;

  const deptIds = req.affected_departments.map((d) => d.id);
  const isOwn = req.requested_by.id === user.id;
  const sodBlocks = req.requires_separation_of_duties && isOwn;
  const isStale = req.source_config_version !== req.current_config_version;
  const canDecideHere = req.status === "PENDING" && deptIds.some((d) => can(P.CHANGES_APPROVE, { departmentId: d }));
  const canApplyHere = req.status === "APPROVED" && can(P.CHANGES_APPLY, { departmentIds: deptIds });
  const decideBlockedReason = sodBlocks
    ? "You submitted this request, so a different approver has to decide on it."
    : !req.can_approve
      ? (req.blocked_reason ?? "You can't decide on this request.")
      : null;
  const applyBlockedReason = isStale
    ? "Live configuration changed after this simulation ran. Run a new simulation and submit a fresh request."
    : !req.can_apply
      ? (req.blocked_reason ?? "This request can't be applied yet.")
      : null;

  const afterAction = (message: string) => {
    setNotice(message);
    cr.reload();
    onChanged();
  };

  const submitDecision = async () => {
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      await changeRequestsApi.decide(req.id, decision, reason.trim());
      setDecision(null);
      setReason("");
      afterAction(decision === "APPROVED" ? "Approval recorded." : "Rejection recorded.");
    } catch (e) {
      setError(e);
      if (isApiError(e) && e.status === 409) cr.reload();
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    const key = applyKeys.current.get(req.id) ?? newId();
    applyKeys.current.set(req.id, key);
    try {
      await changeRequestsApi.apply(req.id, req.source_config_version, key);
      applyKeys.current.delete(req.id);
      setConfirmApply(false);
      afterAction("Change applied. The digital twin is refreshing from the new configuration; run a follow-up simulation to confirm the effect.");
    } catch (e) {
      setConfirmApply(false);
      if (isApiError(e) && e.status === 409) {
        applyKeys.current.delete(req.id);
        setError(
          new Error(
            e.code === "already_applied"
              ? "This change was already applied. Nothing was applied twice."
              : "This request is stale: live configuration changed after its simulation. It wasn't applied.",
          ),
        );
        cr.reload();
        onChanged();
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ot-panel ot-cr" aria-labelledby="ot-cr-title">
      <header className="ot-cr-head">
        <div>
          <h2 id="ot-cr-title">{req.title}</h2>
          <p className="ot-muted">
            Requested by {req.requested_by.full_name}
            {isOwn && " (you)"} on {formatDateTime(req.requested_at)}
          </p>
        </div>
        <StatusBadge status={req.status} />
      </header>

      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />
      {isStale && (req.status === "PENDING" || req.status === "APPROVED") && (
        <Notice tone="warning">
          Live configuration has moved from version {req.source_config_version} to {req.current_config_version} since this
          simulation ran. The server will refuse to apply it.
        </Notice>
      )}

      <p className="ot-cr-reason">{req.reason}</p>

      <section>
        <h3>Proposed configuration changes</h3>
        <DiffTable rows={req.config_diff} />
      </section>

      <div className="ot-columns">
        <section>
          <h3>Expected benefits</h3>
          {req.expected_benefits.length ? (
            <ul>{req.expected_benefits.map((b) => <li key={b}>{b}</li>)}</ul>
          ) : (
            <p className="ot-muted">None listed.</p>
          )}
        </section>
        <section>
          <h3>Risks</h3>
          {req.risks.length ? <ul>{req.risks.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="ot-muted">None listed.</p>}
        </section>
      </div>

      <section>
        <h3>Approvals needed</h3>
        <ul className="ot-approvals">
          {req.required_approvals.map((a) => (
            <li key={a.department_id} data-satisfied={a.satisfied ? "true" : "false"}>
              <span>{a.department_name}</span>
              <span>{a.satisfied ? "Approved" : "Waiting"}</span>
            </li>
          ))}
        </ul>
        {req.requires_separation_of_duties && (
          <p className="ot-muted ot-small">Separation of duties applies: the requester can't approve this change.</p>
        )}
      </section>

      <section>
        <h3>Source</h3>
        <dl className="ot-facts">
          <div>
            <dt>Simulation</dt>
            <dd>
              <Link to={`/simulations/${encodeURIComponent(req.source_simulation_id)}`}>Open simulation run</Link>
            </dd>
          </div>
          <div>
            <dt>Configuration version</dt>
            <dd>{req.source_config_version}</dd>
          </div>
          {req.expires_at && (
            <div>
              <dt>Request expires</dt>
              <dd>{formatDateTime(req.expires_at)}</dd>
            </div>
          )}
          {req.applied_at && (
            <div>
              <dt>Applied</dt>
              <dd>
                {formatDateTime(req.applied_at)}
                {req.applied_by && ` by ${req.applied_by.full_name}`}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {req.decisions.length > 0 && (
        <section>
          <h3>Decisions</h3>
          <ol className="ot-timeline">
            {req.decisions.map((d) => (
              <li key={d.id}>
                <p>
                  <strong>{d.approver.full_name}</strong> {d.decision === "APPROVED" ? "approved" : "rejected"} on{" "}
                  {formatDateTime(d.decided_at)}
                </p>
                <p className="ot-muted">{d.reason}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(canDecideHere || canApplyHere) && (
        <footer className="ot-cr-actions">
          {canDecideHere && (
            <>
              {decideBlockedReason && <p className="ot-muted ot-small">{decideBlockedReason}</p>}
              <button type="button" className="ot-btn ot-btn-quiet" disabled={!!decideBlockedReason} onClick={() => setDecision("REJECTED")}>
                Reject
              </button>
              <button type="button" className="ot-btn ot-btn-primary" disabled={!!decideBlockedReason} onClick={() => setDecision("APPROVED")}>
                Approve
              </button>
            </>
          )}
          {canApplyHere && (
            <>
              {applyBlockedReason && <p className="ot-muted ot-small">{applyBlockedReason}</p>}
              <button type="button" className="ot-btn ot-btn-primary" disabled={!!applyBlockedReason || busy} onClick={() => setConfirmApply(true)}>
                Apply change
              </button>
            </>
          )}
        </footer>
      )}

      <Dialog
        open={!!decision}
        title={decision === "APPROVED" ? "Approve this change" : "Reject this change"}
        onClose={() => setDecision(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setDecision(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={decision === "APPROVED" ? "ot-btn ot-btn-primary" : "ot-btn ot-btn-danger"}
              disabled={busy || reason.trim().length < MIN_REASON}
              onClick={() => void submitDecision()}
            >
              {decision === "APPROVED" ? "Approve" : "Reject"}
            </button>
          </>
        }
      >
        <p>Your decision and reason go into the audit log and can't be edited afterwards.</p>
        <label className="ot-field">
          <span>Reason</span>
          <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          <small>At least {MIN_REASON} characters.</small>
        </label>
      </Dialog>

      <Dialog
        open={confirmApply}
        title="Apply this change to live operations?"
        onClose={() => setConfirmApply(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setConfirmApply(false)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void apply()}>
              {busy ? "Applying…" : "Apply change"}
            </button>
          </>
        }
      >
        <p>
          The server checks your permissions, the approvals and the configuration version again, then applies all{" "}
          {req.config_diff.length} setting{req.config_diff.length === 1 ? "" : "s"} in one transaction. If anything has
          changed, nothing is applied.
        </p>
        <p>Affects: {req.affected_departments.map((d) => d.name).join(", ")}</p>
      </Dialog>
    </article>
  );
}

export default function ApprovalInboxPage() {
  const { meets } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => meets(t.requirement));
  const activeTab = tabs.find((t) => t.key === params.get("tab")) ?? tabs[0];
  const selectedId = params.get("id");

  const list = useResource(
    (signal) => (activeTab ? changeRequestsApi.list({ ...activeTab.query, page_size: 50 }, signal) : Promise.resolve(null)),
    [activeTab?.key],
  );

  const select = (next: { tab?: TabKey; id?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.tab) p.set("tab", next.tab);
    if (next.id === null) p.delete("id");
    else if (next.id) p.set("id", next.id);
    setParams(p, { replace: true });
  };

  if (!activeTab) {
    return <EmptyState title="No approval work for your role">Approvals appear here once you can request, approve or apply changes.</EmptyState>;
  }

  return (
    <div className="ot-page">
      <PageHeader
        title="Approvals"
        description="Operational changes from digital twin recommendations. Nothing reaches live operations until it's approved and applied."
      />

      <div className="ot-tabs" role="tablist" aria-label="Approval views">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === activeTab.key}
            className={t.key === activeTab.key ? "ot-tab is-active" : "ot-tab"}
            onClick={() => select({ tab: t.key, id: null })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ot-split">
        <div className="ot-split-list" role="tabpanel">
          {list.loading && !list.data ? (
            <Loading label="Loading requests" />
          ) : list.error ? (
            <ErrorNotice error={list.error} onRetry={list.reload} />
          ) : (list.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="Nothing here right now">New requests show up as soon as they're submitted.</EmptyState>
          ) : (
            <ul>
              {list.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === selectedId ? "ot-list-item is-active" : "ot-list-item"}
                    aria-current={item.id === selectedId ? "true" : undefined}
                    onClick={() => select({ id: item.id })}
                  >
                    <span>{item.title}</span>
                    <small>{item.affected_departments.map((d) => d.name).join(", ")}</small>
                    <small>{formatDateTime(item.requested_at)}</small>
                    <StatusBadge status={item.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ot-split-detail">
          {selectedId ? (
            <ChangeRequestDetail key={selectedId} id={selectedId} onChanged={list.reload} />
          ) : (
            <EmptyState title="Select a request">Choose a request to see the proposed changes, risks and approvals.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
