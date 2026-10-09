import { useMemo, useState } from "react";
import { authApi } from "../../api/rbacApi";
import { useAuth, useCurrentUser } from "../../auth/AuthContext";
import { permissionGroup, permissionLabel } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import { ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

export default function ProfilePage() {
  const user = useCurrentUser();
  const { refreshUser } = useAuth();
  const sessions = useResource((signal) => authApi.sessions(signal), []);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const deptName = useMemo(() => new Map(user.departments.map((d) => [d.id, d.name])), [user.departments]);

  const access = useMemo(() => {
    const byGroup = new Map<string, { code: string; scope: string }[]>();
    for (const grant of user.grants) {
      const scope =
        grant.scope === "global"
          ? "All departments"
          : grant.department_ids.map((id) => deptName.get(id) ?? "Unnamed department").join(", ");
      const group = permissionGroup(grant.code);
      byGroup.set(group, [...(byGroup.get(group) ?? []), { code: grant.code, scope }]);
    }
    return Array.from(byGroup.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [user.grants, deptName]);

  const revoke = async (id: string) => {
    setActionError(null);
    try {
      await authApi.revokeSession(id);
      setNotice("Session signed out.");
      sessions.reload();
    } catch (e) {
      setActionError(e);
    }
  };

  const revokeOthers = async () => {
    setActionError(null);
    try {
      await authApi.revokeOtherSessions();
      setNotice("Signed out of every other session.");
      sessions.reload();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <div className="ot-page">
      <PageHeader
        title="Profile and sessions"
        description="What you can see and do in OpsTwin Live. Roles and department memberships are managed by a Super Admin."
        actions={
          <button type="button" className="ot-btn ot-btn-quiet" onClick={() => void refreshUser()}>
            Refresh my access
          </button>
        }
      />

      <section className="ot-panel">
        <h2>Account</h2>
        <dl className="ot-facts">
          <div>
            <dt>Name</dt>
            <dd>{user.full_name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Roles</dt>
            <dd>{user.roles.map((r) => r.name).join(", ") || "None"}</dd>
          </div>
          <div>
            <dt>Departments</dt>
            <dd>{user.memberships.map((m) => m.department_name).join(", ") || "None"}</dd>
          </div>
          <div>
            <dt>Session ends</dt>
            <dd>{formatDateTime(user.session_expires_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="ot-panel">
        <h2>What you can do</h2>
        {access.length === 0 ? (
          <p className="ot-muted">You don't have any permissions yet. Ask a Super Admin to assign a role.</p>
        ) : (
          access.map(([group, items]) => (
            <div key={group} className="ot-access-group">
              <h3>{group}</h3>
              <div className="ot-table-wrap">
                <table className="ot-table">
                  <thead>
                    <tr>
                      <th scope="col">Permission</th>
                      <th scope="col">Where it applies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.code}>
                        <td>{permissionLabel(item.code)}</td>
                        <td>{item.scope}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="ot-panel">
        <div className="ot-panel-head">
          <h2>Active sessions</h2>
          <button type="button" className="ot-btn ot-btn-quiet" onClick={() => void revokeOthers()}>
            Sign out other sessions
          </button>
        </div>
        {notice && <Notice tone="success">{notice}</Notice>}
        <ErrorNotice error={actionError} />
        {sessions.loading && !sessions.data ? (
          <Loading label="Loading sessions" />
        ) : sessions.error ? (
          <ErrorNotice error={sessions.error} onRetry={sessions.reload} />
        ) : (
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="ot-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sessions.data ?? []).map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.user_agent ?? "Unknown device"}
                      {s.is_current && <span className="ot-tag">This device</span>}
                    </td>
                    <td>{formatDateTime(s.last_seen_at)}</td>
                    <td>{formatDateTime(s.expires_at)}</td>
                    <td className="ot-cell-actions">
                      {!s.is_current && (
                        <button type="button" className="ot-btn ot-btn-quiet" onClick={() => void revoke(s.id)}>
                          Sign out
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
    </div>
  );
}
