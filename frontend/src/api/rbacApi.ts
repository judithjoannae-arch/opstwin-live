import { apiRequest, type QueryParams } from "./http";
import type {
  AuditEntry,
  ChangeRequest,
  ChangeRequestSummary,
  CurrentUser,
  Department,
  DepartmentMember,
  Page,
  PermissionDefinition,
  RoleDetail,
  SessionInfo,
  UserAccount,
} from "./types";

const enc = encodeURIComponent;

export const authApi = {
  me: (signal?: AbortSignal) => apiRequest<CurrentUser>("/auth/me", { signal, silentAuth: true }),
  login: (email: string, password: string) =>
    apiRequest<void>("/auth/login", { method: "POST", body: { email, password }, silentAuth: true }),
  logout: () => apiRequest<void>("/auth/logout", { method: "POST", silentAuth: true }),
  sessions: (signal?: AbortSignal) => apiRequest<SessionInfo[]>("/auth/sessions", { signal }),
  revokeSession: (sessionId: string) => apiRequest<void>(`/auth/sessions/${enc(sessionId)}`, { method: "DELETE" }),
  revokeOtherSessions: () => apiRequest<void>("/auth/sessions/revoke-others", { method: "POST" }),
  acceptInvitation: (token: string, password: string) =>
    apiRequest<void>("/auth/invitations/accept", { method: "POST", body: { token, password }, silentAuth: true }),
};

export const usersApi = {
  list: (query: { search?: string; page?: number; page_size?: number }, signal?: AbortSignal) =>
    apiRequest<Page<UserAccount>>("/users", { query, signal }),
  /** In development the response includes a single-use invitation_url (no email service locally). */
  invite: (body: { email: string; full_name: string; role_ids: string[] }) =>
    apiRequest<UserAccount & { invitation_url?: string }>("/users/invitations", { method: "POST", body }),
  setActive: (userId: string, isActive: boolean) =>
    apiRequest<UserAccount>(`/users/${enc(userId)}/status`, { method: "PATCH", body: { is_active: isActive } }),
  setRoles: (userId: string, roleIds: string[]) =>
    apiRequest<UserAccount>(`/users/${enc(userId)}/roles`, { method: "PUT", body: { role_ids: roleIds } }),
  revokeSessions: (userId: string) => apiRequest<void>(`/users/${enc(userId)}/sessions/revoke`, { method: "POST" }),
};

export const rolesApi = {
  list: (signal?: AbortSignal) => apiRequest<RoleDetail[]>("/roles", { signal }),
  permissionCatalog: (signal?: AbortSignal) => apiRequest<PermissionDefinition[]>("/permissions", { signal }),
  create: (body: { name: string; description: string }) => apiRequest<RoleDetail>("/roles", { method: "POST", body }),
  updatePermissions: (roleId: string, permissionCodes: string[], version: number) =>
    apiRequest<RoleDetail>(`/roles/${enc(roleId)}/permissions`, {
      method: "PUT",
      body: { permission_codes: permissionCodes, version },
    }),
};

export const departmentsApi = {
  list: (signal?: AbortSignal) => apiRequest<Department[]>("/departments", { signal }),
  members: (departmentId: string, signal?: AbortSignal) =>
    apiRequest<DepartmentMember[]>(`/departments/${enc(departmentId)}/memberships`, { signal }),
  addMember: (departmentId: string, userId: string) =>
    apiRequest<DepartmentMember>(`/departments/${enc(departmentId)}/memberships`, {
      method: "POST",
      body: { user_id: userId },
    }),
  removeMember: (departmentId: string, userId: string) =>
    apiRequest<void>(`/departments/${enc(departmentId)}/memberships/${enc(userId)}`, { method: "DELETE" }),
};

export const changeRequestsApi = {
  list: (query: QueryParams, signal?: AbortSignal) =>
    apiRequest<Page<ChangeRequestSummary>>("/change-requests", { query, signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<ChangeRequest>(`/change-requests/${enc(id)}`, { signal }),
  /** The backend builds the diff, affected departments and versions from the recommendation itself. */
  createFromRecommendation: (recommendationId: string, reason: string) =>
    apiRequest<ChangeRequest>("/change-requests", {
      method: "POST",
      body: { recommendation_id: recommendationId, reason },
    }),
  decide: (id: string, decision: "APPROVED" | "REJECTED", reason: string) =>
    apiRequest<ChangeRequest>(`/change-requests/${enc(id)}/decisions`, {
      method: "POST",
      body: { decision, reason },
    }),
  apply: (id: string, expectedConfigVersion: string, idempotencyKey: string) =>
    apiRequest<ChangeRequest>(`/change-requests/${enc(id)}/apply`, {
      method: "POST",
      body: { expected_config_version: expectedConfigVersion },
      headers: { "Idempotency-Key": idempotencyKey },
    }),
};

export const auditApi = {
  list: (query: QueryParams, signal?: AbortSignal) => apiRequest<Page<AuditEntry>>("/audit-log", { query, signal }),
};
