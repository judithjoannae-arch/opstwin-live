import { useState } from "react";
import { rolesApi, usersApi } from "../../api/rbacApi";
import type { UserAccount } from "../../api/types";
import { useCurrentUser } from "../../auth/AuthContext";
import { useDebounced, useResource } from "../../hooks/useResource";
import { Dialog, EmptyState, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

const PAGE_SIZE = 25;

type PendingAction = { kind: "deactivate" | "activate" | "revoke"; user: UserAccount };

function RoleChecklist({
  roles,
  selected,
  onToggle,
}: {
  roles: { id: string; name: string; description: string | null }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="ot-checklist">
      <legend>Roles</legend>
      {roles.map((role) => (
        <label key={role.id} className="ot-check">
          <input type="checkbox" checked={selected.has(role.id)} onChange={() => onToggle(role.id)} />
          <span>
            {role.name}
            {role.description && <small>{role.description}</small>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export default function UsersPage() {
  const me = useCurrentUser();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [page, setPage] = useState(1);

  const users = useResource(
    (signal) => usersApi.list({ search: debouncedSearch, page, page_size: PAGE_SIZE }, signal),
    [debouncedSearch, page],
  );
  const roles = useResource((signal) => rolesApi.list(signal), []);

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: "", full_name: "", roleIds: new Set<string>() });

  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [editRoles, setEditRoles] = useState<Set<string>>(new Set());

  const [pending, setPending] = useState<PendingAction | null>(null);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setNotice(success);
      users.reload();
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const sendInvite = async () => {
    let link: string | undefined;
    const ok = await run(async () => {
      const created = await usersApi.invite({ email: invite.email.trim(), full_name: invite.full_name.trim(), role_ids: [...invite.roleIds] });
      link = created.invitation_url;
    }, `Invitation created for ${invite.email.trim()}.`);
    if (ok && link) {
      setNotice(`Invitation created. Share this single-use link with them (development mode, no email is sent): ${window.location.origin}${link}`);
    }
    if (ok) {
      setInviteOpen(false);
      setInvite({ email: "", full_name: "", roleIds: new Set() });
    }
  };

  const saveRoles = async () => {
    if (!editing) return;
    const ok = await run(() => usersApi.setRoles(editing.id, [...editRoles]), `Roles updated for ${editing.full_name}.`);
    if (ok) setEditing(null);
  };

  const confirmPending = async () => {
    if (!pending) return;
    const { kind, user } = pending;
    const work =
      kind === "revoke"
        ? () => usersApi.revokeSessions(user.id)
        : () => usersApi.setActive(user.id, kind === "activate");
    const message =
      kind === "revoke"
        ? `${user.full_name} was signed out everywhere.`
        : kind === "activate"
          ? `${user.full_name} can sign in again.`
          : `${user.full_name} was deactivated and signed out.`;
    if (await run(work, message)) setPending(null);
  };

  const total = users.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const roleOptions = roles.data ?? [];

  return (
    <div className="ot-page">
      <PageHeader
        title="Users"
        description="Invite people, set their roles, and turn accounts on or off. Department access is set on the Department memberships page."
        actions={
          <button type="button" className="ot-btn ot-btn-primary" onClick={() => setInviteOpen(true)}>
            Invite user
          </button>
        }
      />

      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={actionError} />

      <div className="ot-toolbar">
        <label className="ot-field ot-field-inline">
          <span>Search</span>
          <input
            type="search"
            value={search}
            placeholder="Name or email"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>

      {users.loading && !users.data ? (
        <Loading label="Loading users" />
      ) : users.error ? (
        <ErrorNotice error={users.error} onRetry={users.reload} />
      ) : (users.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No users match this search">Try a different name or email, or invite someone new.</EmptyState>
      ) : (
        <>
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Departments</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">
                    <span className="ot-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((u) => {
                  const isSelf = u.id === me.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.full_name}</strong>
                        {isSelf && <span className="ot-tag">You</span>}
                        <div className="ot-muted ot-small">{u.email}</div>
                      </td>
                      <td>{u.roles.map((r) => r.name).join(", ") || <span className="ot-muted">None</span>}</td>
                      <td>{u.departments.map((d) => d.name).join(", ") || <span className="ot-muted">None</span>}</td>
                      <td>
                        {u.invitation_pending ? "Invited" : u.is_active ? "Active" : <span className="ot-text-bad">Deactivated</span>}
                      </td>
                      <td>{formatDateTime(u.last_login_at)}</td>
                      <td className="ot-cell-actions">
                        {isSelf ? (
                          <span className="ot-muted ot-small">Another admin manages your account</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="ot-btn ot-btn-quiet"
                              onClick={() => {
                                setEditing(u);
                                setEditRoles(new Set(u.roles.map((r) => r.id)));
                              }}
                            >
                              Edit roles
                            </button>
                            <button
                              type="button"
                              className="ot-btn ot-btn-quiet"
                              onClick={() => setPending({ kind: u.is_active ? "deactivate" : "activate", user: u })}
                            >
                              {u.is_active ? "Deactivate" : "Activate"}
                            </button>
                            {u.is_active && (
                              <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setPending({ kind: "revoke", user: u })}>
                                Sign out everywhere
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="ot-pager">
            <button type="button" className="ot-btn ot-btn-quiet" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {lastPage}
            </span>
            <button
              type="button"
              className="ot-btn ot-btn-quiet"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      <Dialog
        open={inviteOpen}
        title="Invite user"
        onClose={() => setInviteOpen(false)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setInviteOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ot-btn ot-btn-primary"
              disabled={busy || !invite.email.includes("@") || !invite.full_name.trim()}
              onClick={() => void sendInvite()}
            >
              {busy ? "Sending…" : "Send invitation"}
            </button>
          </>
        }
      >
        <p className="ot-muted">They'll get a single-use link that expires, and set their own password.</p>
        <label className="ot-field">
          <span>Full name</span>
          <input value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} />
        </label>
        <label className="ot-field">
          <span>Work email</span>
          <input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
        </label>
        <RoleChecklist
          roles={roleOptions}
          selected={invite.roleIds}
          onToggle={(id) => setInvite({ ...invite, roleIds: toggle(invite.roleIds, id) })}
        />
      </Dialog>

      <Dialog
        open={!!editing}
        title={editing ? `Roles for ${editing.full_name}` : "Roles"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void saveRoles()}>
              {busy ? "Saving…" : "Save roles"}
            </button>
          </>
        }
      >
        <p className="ot-muted">
          Roles apply only in the departments this person belongs to, unless the role grants access to all departments.
          Their open sessions pick up the change on the next request.
        </p>
        <RoleChecklist roles={roleOptions} selected={editRoles} onToggle={(id) => setEditRoles((s) => toggle(s, id))} />
      </Dialog>

      <Dialog
        open={!!pending}
        title={
          pending?.kind === "deactivate"
            ? "Deactivate account?"
            : pending?.kind === "activate"
              ? "Activate account?"
              : "Sign out everywhere?"
        }
        onClose={() => setPending(null)}
        footer={
          <>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={pending?.kind === "activate" ? "ot-btn ot-btn-primary" : "ot-btn ot-btn-danger"}
              disabled={busy}
              onClick={() => void confirmPending()}
            >
              {pending?.kind === "deactivate" ? "Deactivate" : pending?.kind === "activate" ? "Activate" : "Sign out everywhere"}
            </button>
          </>
        }
      >
        <p>
          {pending?.kind === "deactivate" &&
            `${pending.user.full_name} will be signed out of every session and won't be able to sign in. Their history stays in the audit log.`}
          {pending?.kind === "activate" && `${pending.user.full_name} will be able to sign in again with their existing roles.`}
          {pending?.kind === "revoke" && `${pending.user.full_name} will need to sign in again on every device.`}
        </p>
      </Dialog>
    </div>
  );
}
