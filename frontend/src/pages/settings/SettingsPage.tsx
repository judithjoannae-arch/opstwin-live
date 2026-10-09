import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../api/http";
import { settingsApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { SlaPolicy } from "../../types/operations";
import { PRIORITY_LABELS, formatMinutes } from "../../utils/format";
import { Dialog, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

const SOURCE_LABELS = { seed: "Initial setup", manual: "Edited in settings", approved_change: "Approved change" } as const;

function validPolicies(rows: SlaPolicy[]): string | null {
  for (const r of rows) {
    if (!Number.isInteger(r.response_minutes) || !Number.isInteger(r.resolution_minutes)) return "Use whole minutes.";
    if (r.response_minutes < 1 || r.resolution_minutes < 1) return "Targets must be at least 1 minute.";
    if (r.resolution_minutes < r.response_minutes) return `${PRIORITY_LABELS[r.priority]}: resolution can't be sooner than response.`;
  }
  const sorted = [...rows].sort((a, b) => a.priority.localeCompare(b.priority));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].resolution_minutes < sorted[i - 1].resolution_minutes) {
      return `${PRIORITY_LABELS[sorted[i].priority]} can't have a tighter resolution target than ${PRIORITY_LABELS[sorted[i - 1].priority]}.`;
    }
  }
  return null;
}

export default function SettingsPage() {
  const { can } = useAuth();
  const canEdit = can(P.POLICIES_MANAGE, { global: true });
  const sla = useResource((signal) => settingsApi.slaPolicies(signal), []);
  const versions = useResource((signal) => settingsApi.configVersions(signal), []);
  const [draft, setDraft] = useState<SlaPolicy[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (sla.data) setDraft(sla.data.policies.map((p) => ({ ...p })));
  }, [sla.data]);

  const dirty = !!sla.data && JSON.stringify(draft) !== JSON.stringify(sla.data.policies);
  const problem = validPolicies(draft);

  const setValue = (index: number, key: "response_minutes" | "resolution_minutes", value: string) =>
    setDraft((rows) => rows.map((r, i) => (i === index ? { ...r, [key]: Math.round(Number(value)) } : r)));

  const save = async () => {
    if (!sla.data) return;
    setBusy(true);
    setError(null);
    try {
      await settingsApi.updateSlaPolicies({ expected_config_version: sla.data.config_version, policies: draft, reason: reason.trim() });
      setConfirmOpen(false);
      setReason("");
      setNotice("SLA targets saved as a new configuration version. New tickets use them right away; existing deadlines don't move.");
      sla.reload();
      versions.reload();
    } catch (e) {
      setConfirmOpen(false);
      setError(
        isApiError(e) && e.status === 409
          ? new Error("The configuration changed while you were editing. The latest targets are loaded; review them and try again.")
          : e,
      );
      sla.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ot-page">
      <PageHeader
        title="Settings"
        description="Operational configuration for the live service desk. Every saved change creates a new configuration version that twin snapshots and approvals check against."
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />

      <section className="ot-panel">
        <div className="ot-panel-head">
          <h2>SLA targets</h2>
          {sla.data && <span className="ot-mono text-sm text-muted">Version {sla.data.config_version}</span>}
        </div>
        {sla.loading && !sla.data ? (
          <Loading label="Loading SLA targets" />
        ) : sla.error ? (
          <ErrorNotice error={sla.error} onRetry={sla.reload} />
        ) : (
          <>
            {!canEdit && <p className="text-sm text-muted">You can view these targets. Changing them needs the policy management permission.</p>}
            <div className="ot-table-wrap">
              <table className="ot-table">
                <thead>
                  <tr>
                    <th scope="col">Priority</th>
                    <th scope="col">First response within (minutes)</th>
                    <th scope="col">Resolve within (minutes)</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((p, i) => (
                    <tr key={p.priority}>
                      <th scope="row" className="font-semibold">
                        {PRIORITY_LABELS[p.priority]}
                      </th>
                      <td>
                        {canEdit ? (
                          <input
                            type="number"
                            min={1}
                            className="ot-select-sm w-28 tabular-nums"
                            aria-label={`${PRIORITY_LABELS[p.priority]} response minutes`}
                            value={p.response_minutes}
                            onChange={(e) => setValue(i, "response_minutes", e.target.value)}
                          />
                        ) : (
                          formatMinutes(p.response_minutes)
                        )}
                        {canEdit && <span className="ml-2 text-xs text-muted">{formatMinutes(p.response_minutes)}</span>}
                      </td>
                      <td>
                        {canEdit ? (
                          <input
                            type="number"
                            min={1}
                            className="ot-select-sm w-28 tabular-nums"
                            aria-label={`${PRIORITY_LABELS[p.priority]} resolution minutes`}
                            value={p.resolution_minutes}
                            onChange={(e) => setValue(i, "resolution_minutes", e.target.value)}
                          />
                        ) : (
                          formatMinutes(p.resolution_minutes)
                        )}
                        {canEdit && <span className="ml-2 text-xs text-muted">{formatMinutes(p.resolution_minutes)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sla.data && (
              <p className="mt-2 text-xs text-muted">
                Last changed {formatDateTime(sla.data.updated_at)}
                {sla.data.updated_by ? ` by ${sla.data.updated_by.full_name}` : ""}
              </p>
            )}
            {canEdit && (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
                {problem && dirty && <span className="ot-field-error">{problem}</span>}
                <button
                  type="button"
                  className="ot-btn ot-btn-quiet"
                  disabled={!dirty}
                  onClick={() => sla.data && setDraft(sla.data.policies.map((p) => ({ ...p })))}
                >
                  Discard changes
                </button>
                <button type="button" className="ot-btn ot-btn-primary" disabled={!dirty || !!problem} onClick={() => setConfirmOpen(true)}>
                  Save SLA targets
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ot-panel">
        <h2>Configuration history</h2>
        {versions.loading && !versions.data ? (
          <Loading label="Loading history" />
        ) : versions.error ? (
          <ErrorNotice error={versions.error} onRetry={versions.reload} />
        ) : (
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">When</th>
                  <th scope="col">How</th>
                  <th scope="col">By</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {versions.data?.map((v) => (
                  <tr key={v.version}>
                    <td className="ot-mono">{v.version}</td>
                    <td className="whitespace-nowrap text-sm">{formatDateTime(v.created_at)}</td>
                    <td>
                      {SOURCE_LABELS[v.source]}
                      {v.change_request_id && (
                        <Link to={`/approvals?tab=all&id=${encodeURIComponent(v.change_request_id)}`} className="ot-link ml-2 text-sm">
                          View request
                        </Link>
                      )}
                    </td>
                    <td>{v.created_by?.full_name ?? <span className="text-muted">System</span>}</td>
                    <td>{v.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(can(P.ROLES_MANAGE, { global: true }) || can(P.USERS_MANAGE, { global: true })) && (
        <section className="ot-panel">
          <h2>Access</h2>
          <p className="text-sm text-muted">Who can see and change what is managed on the administration pages.</p>
          <div className="flex flex-wrap gap-2">
            {can(P.USERS_MANAGE, { global: true }) && (
              <Link to="/admin/users" className="ot-btn ot-btn-quiet">
                Users
              </Link>
            )}
            {can(P.ROLES_MANAGE, { global: true }) && (
              <Link to="/admin/roles" className="ot-btn ot-btn-quiet">
                Roles and permissions
              </Link>
            )}
            {can(P.USERS_MANAGE, { global: true }) && (
              <Link to="/admin/memberships" className="ot-btn ot-btn-quiet">
                Department memberships
              </Link>
            )}
          </div>
        </section>
      )}

      <Dialog
        open={confirmOpen}
        title="Save new SLA targets?"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setConfirmOpen(false)}>
              Keep editing
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy || reason.trim().length < 10} onClick={() => void save()}>
              {busy ? "Saving…" : "Save SLA targets"}
            </button>
          </>
        }
      >
        <p>
          This creates a new configuration version. Simulations and change requests based on the current version will be marked stale.
        </p>
        <label className="ot-field">
          <span>Reason for the change</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <small>At least 10 characters. Recorded in the audit trail.</small>
        </label>
      </Dialog>
    </div>
  );
}
