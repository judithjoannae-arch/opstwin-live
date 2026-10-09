import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { twinApi } from "../../api/twinApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { Snapshot } from "../../types/twin";
import { ErrorNotice, formatDateTime } from "../ui";

/**
 * Snapshot selection shared by twin pages. The chosen id lives in ?snapshot=,
 * defaulting to the newest snapshot the user can read.
 */
export function useSnapshotSelection() {
  const [params, setParams] = useSearchParams();
  const list = useResource((signal) => twinApi.snapshots(20, signal), []);
  const requested = params.get("snapshot");
  const selectedId = requested || list.data?.[0]?.id || null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("snapshot", id);
    setParams(next, { replace: true });
  };
  return { list, selectedId, select };
}

export function SnapshotBar({
  snapshots,
  selectedId,
  onSelect,
  onCreated,
  currentConfigVersion,
}: {
  snapshots: Snapshot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (s: Snapshot) => void;
  currentConfigVersion?: string | null;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const selected = snapshots.find((s) => s.id === selectedId);
  const outdated = selected && currentConfigVersion && selected.config_version !== currentConfigVersion;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await twinApi.createSnapshot());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-navy-950/50 px-4 py-3">
        <label className="ot-field ot-field-inline m-0">
          <span>Snapshot</span>
          <select value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value)} disabled={snapshots.length === 0}>
            {snapshots.length === 0 && <option value="">No snapshots yet</option>}
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDateTime(s.created_at)}, {s.config_version}, {s.ticket_count} active tickets
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <p className="m-0 pb-2 text-sm text-muted">
            Frozen at {formatDateTime(selected.created_at)} from configuration <span className="ot-mono">{selected.config_version}</span>
            {selected.scope ? ` for ${selected.scope.join(", ")}` : ", all departments"}.
            {outdated && <span className="ml-2 text-warn">Live configuration is now {currentConfigVersion}; refresh to simulate it.</span>}
          </p>
        )}
        {can(P.SNAPSHOTS_CREATE) && (
          <button type="button" className="ot-btn ot-btn-primary ml-auto" disabled={busy} onClick={() => void refresh()}>
            {busy ? "Reading live state…" : "Refresh twin"}
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
