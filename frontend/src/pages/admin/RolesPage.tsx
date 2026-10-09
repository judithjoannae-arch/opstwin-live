import { useEffect, useMemo, useState } from "react";
import { isApiError } from "../../api/http";
import { rolesApi } from "../../api/rbacApi";
import type { PermissionDefinition } from "../../api/types";
import { useCurrentUser } from "../../auth/AuthContext";
import { permissionGroup, permissionLabel } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import { Dialog, ErrorNotice, Loading, Notice, PageHeader } from "../../components/ui";

function sameSet(a: Set<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((x) => a.has(x));
}

export default function RolesPage() {
  const me = useCurrentUser();
  const roles = useResource((signal) => rolesApi.list(signal), []);
  const catalog = useResource((signal) => rolesApi.permissionCatalog(signal), []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0] ?? null;
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newRole, setNewRole] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (selected) setDraft(new Set(selected.permission_codes));
  }, [selected?.id, selected?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const defs: PermissionDefinition[] = catalog.data ?? [];
    const map = new Map<string, PermissionDefinition[]>();
    for (const def of defs) {
      const group = def.group || permissionGroup(def.code);
      map.set(group, [...(map.get(group) ?? []), def]);
    }
    return Array.from(map.entries());
  }, [catalog.data]);

  if ((roles.loading && !roles.data) || (catalog.loading && !catalog.data)) return <Loading label="Loading roles" />;
  if (roles.error || catalog.error) {
    return (
      <ErrorNotice
        error={roles.error ?? catalog.error}
        onRetry={() => {
          roles.reload();
          catalog.reload();
        }}
      />
    );
  }

  const holdsRole = !!selected && me.roles.some((r) => r.id === selected.id);
  const readOnly = !selected || selected.is_locked || holdsRole;
  const added = selected ? [...draft].filter((c) => !selected.permission_codes.includes(c)) : [];
  const removed = selected ? selected.permission_codes.filter((c) => !draft.has(c)) : [];
  const dirty = !!selected && !sameSet(draft, selected.permission_codes);

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await rolesApi.updatePermissions(selected.id, [...draft], selected.version);
      setNotice(`Saved permissions for ${selected.name}.`);
      setConfirmOpen(false);
      roles.reload();
    } catch (e) {
      setError(
        isApiError(e) && e.status === 409
          ? new Error("Someone else changed this role while you were editing. Reload to see their changes, then try again.")
          : e,
      );
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const role = await rolesApi.create({ name: newRole.name.trim(), description: newRole.description.trim() });
      setCreateOpen(false);
      setNewRole({ name: "", description: "" });
      setNotice(`Created ${role.name}. It has no permissions yet.`);
      roles.reload();
      setSelectedId(role.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ot-page">
      <PageHeader
        title="Roles and permissions"
        description="A role is a set of permissions. People get those permissions only in the departments they belong to, unless the permission is granted for all departments."
        actions={
          <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setCreateOpen(true)}>
            New role
          </button>
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} onRetry={error ? roles.reload : undefined} />

      <div className="ot-split">
        <nav className="ot-split-list" aria-label="Roles">
          <ul>
            {roles.data?.map((role) => (
              <li key={role.id}>
                <button
                  type="button"
                  className={role.id === selected?.id ? "ot-list-item is-active" : "ot-list-item"}
                  aria-current={role.id === selected?.id ? "true" : undefined}
                  onClick={() => setSelectedId(role.id)}
                >
                  <span>{role.name}</span>
                  <small>
                    {role.user_count} {role.user_count === 1 ? "person" : "people"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {selected && (
          <section className="ot-panel ot-split-detail" aria-labelledby="ot-role-title">
            <div className="ot-panel-head">
              <h2 id="ot-role-title">{selected.name}</h2>
              {!readOnly && (
                <div className="ot-row">
                  <button
                    type="button"
                    className="ot-btn ot-btn-quiet"
                    disabled={!dirty}
                    onClick={() => setDraft(new Set(selected.permission_codes))}
                  >
                    Discard changes
                  </button>
                  <button type="button" className="ot-btn ot-btn-primary" disabled={!dirty} onClick={() => setConfirmOpen(true)}>
                    Review and save
                  </button>
                </div>
              )}
            </div>
            {selected.description && <p className="ot-muted">{selected.description}</p>}
            {selected.is_locked && (
              <Notice>This is a protected system role. Its permissions can't be changed here.</Notice>
            )}
            {!selected.is_locked && holdsRole && (
              <Notice>You hold this role, so another administrator has to change it. Nobody can edit their own access.</Notice>
            )}

            {groups.map(([group, defs]) => (
              <fieldset key={group} className="ot-checklist" disabled={readOnly}>
                <legend>{group}</legend>
                {defs.map((def) => (
                  <label key={def.code} className="ot-check">
                    <input
                      type="checkbox"
                      checked={draft.has(def.code)}
                      onChange={() =>
                        setDraft((s) => {
                          const next = new Set(s);
                          if (next.has(def.code)) next.delete(def.code);
                          else next.add(def.code);
                          return next;
                        })
                      }
                    />
                    <span>
                      {def.description || permissionLabel(def.code)}
                      <small>
                        <code>{def.code}</code>
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </section>
        )}
      </div>

      <Dialog
        open={confirmOpen}
        title={`Save changes to ${selected?.name ?? "role"}?`}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setConfirmOpen(false)}>
              Keep editing
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save permissions"}
            </button>
          </>
        }
      >
        <p>
          This affects {selected?.user_count ?? 0} {selected?.user_count === 1 ? "person" : "people"} and is recorded in the
          audit log.
        </p>
        {added.length > 0 && (
          <>
            <h3>Adds</h3>
            <ul>
              {added.map((c) => (
                <li key={c}>{permissionLabel(c)}</li>
              ))}
            </ul>
          </>
        )}
        {removed.length > 0 && (
          <>
            <h3>Removes</h3>
            <ul>
              {removed.map((c) => (
                <li key={c}>{permissionLabel(c)}</li>
              ))}
            </ul>
          </>
        )}
      </Dialog>

      <Dialog
        open={createOpen}
        title="New role"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy || !newRole.name.trim()} onClick={() => void create()}>
              Create role
            </button>
          </>
        }
      >
        <label className="ot-field">
          <span>Name</span>
          <input value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
        </label>
        <label className="ot-field">
          <span>What it's for</span>
          <textarea rows={3} value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
        </label>
      </Dialog>
    </div>
  );
}
