import { useState } from "react";
import { departmentsApi, usersApi } from "../../api/rbacApi";
import type { DepartmentMember } from "../../api/types";
import { useCurrentUser } from "../../auth/AuthContext";
import { useDebounced, useResource } from "../../hooks/useResource";
import { Dialog, EmptyState, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

export default function MembershipsPage() {
  const me = useCurrentUser();
  const departments = useResource((signal) => departmentsApi.list(signal), []);
  const [chosenId, setChosenId] = useState("");
  const departmentId = chosenId || departments.data?.[0]?.id || "";
  const department = departments.data?.find((d) => d.id === departmentId);

  const members = useResource(
    (signal) => (departmentId ? departmentsApi.members(departmentId, signal) : Promise.resolve([] as DepartmentMember[])),
    [departmentId],
  );

  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 300);
  const candidates = useResource(
    (signal) =>
      debounced.length >= 2 ? usersApi.list({ search: debounced, page: 1, page_size: 10 }, signal) : Promise.resolve(null),
    [debounced],
  );

  const [removing, setRemoving] = useState<DepartmentMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const memberIds = new Set((members.data ?? []).map((m) => m.user_id));

  const add = async (userId: string, name: string) => {
    setBusy(true);
    setError(null);
    try {
      await departmentsApi.addMember(departmentId, userId);
      setNotice(`${name} now belongs to ${department?.name ?? "this department"}.`);
      members.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await departmentsApi.removeMember(departmentId, removing.user_id);
      setNotice(`${removing.full_name} was removed from ${department?.name ?? "this department"}.`);
      setRemoving(null);
      members.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (departments.loading && !departments.data) return <Loading label="Loading departments" />;
  if (departments.error) return <ErrorNotice error={departments.error} onRetry={departments.reload} />;

  return (
    <div className="ot-page">
      <PageHeader
        title="Department memberships"
        description="Membership decides which departments a person's roles apply to. It grants nothing by itself: a Technician who belongs to Technical support can only act on Technical support work."
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />

      <div className="ot-toolbar">
        <label className="ot-field ot-field-inline">
          <span>Department</span>
          <select value={departmentId} onChange={(e) => setChosenId(e.target.value)}>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ot-columns">
        <section className="ot-panel">
          <h2>Members of {department?.name ?? "department"}</h2>
          {members.loading && !members.data ? (
            <Loading label="Loading members" />
          ) : members.error ? (
            <ErrorNotice error={members.error} onRetry={members.reload} />
          ) : (members.data?.length ?? 0) === 0 ? (
            <EmptyState title="Nobody belongs to this department yet">Search for a person to add them.</EmptyState>
          ) : (
            <div className="ot-table-wrap">
              <table className="ot-table">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Roles</th>
                    <th scope="col">Member since</th>
                    <th scope="col">
                      <span className="ot-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.data?.map((m) => (
                    <tr key={m.user_id}>
                      <td>
                        <strong>{m.full_name}</strong>
                        {!m.is_active && <span className="ot-tag">Deactivated</span>}
                        <div className="ot-muted ot-small">{m.email}</div>
                      </td>
                      <td>{m.roles.map((r) => r.name).join(", ") || <span className="ot-muted">None</span>}</td>
                      <td>{formatDateTime(m.added_at)}</td>
                      <td className="ot-cell-actions">
                        {m.user_id === me.id ? (
                          <span className="ot-muted ot-small">Another admin manages your access</span>
                        ) : (
                          <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setRemoving(m)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="ot-panel">
          <h2>Add a person</h2>
          <label className="ot-field">
            <span>Search by name or email</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="At least 2 characters" />
          </label>
          {candidates.error ? <ErrorNotice error={candidates.error} /> : null}
          <ul className="ot-candidates">
            {candidates.data?.items.map((u) => {
              const already = memberIds.has(u.id);
              const isSelf = u.id === me.id;
              return (
                <li key={u.id}>
                  <span>
                    {u.full_name}
                    <small>{u.email}</small>
                  </span>
                  <button
                    type="button"
                    className="ot-btn ot-btn-quiet"
                    disabled={busy || already || isSelf || !u.is_active}
                    title={isSelf ? "You can't change your own department access" : undefined}
                    onClick={() => void add(u.id, u.full_name)}
                  >
                    {already ? "Member" : isSelf ? "That's you" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
          {candidates.data && candidates.data.items.length === 0 && <p className="ot-muted">No one matches that search.</p>}
        </section>
      </div>

      <Dialog
        open={!!removing}
        title="Remove from department?"
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          </>
        }
      >
        <p>
          {removing?.full_name} will lose access to {department?.name ?? "this department"}'s tickets, resources and
          simulations right away. Their past actions stay in the audit log.
        </p>
      </Dialog>
    </div>
  );
}
