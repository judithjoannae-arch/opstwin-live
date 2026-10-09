/**
 * Permission codes and client-side permission evaluation.
 *
 * These checks only decide what the UI shows. The backend enforces the same
 * permissions (function, object and department scope) on every request.
 * Never branch on role names for authorization; use permission codes.
 */
import type { CurrentUser, PermissionGrant } from "../api/types";

export const P = {
  USERS_READ: "users.read",
  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",
  DEPARTMENTS_MANAGE: "departments.manage",
  DASHBOARD_GLOBAL_READ: "dashboard.global.read",
  TICKETS_READ: "tickets.read",
  TICKETS_CREATE: "tickets.create",
  TICKETS_UPDATE: "tickets.update",
  TICKETS_ASSIGN: "tickets.assign",
  RESOURCES_READ: "resources.read",
  RESOURCES_MANAGE: "resources.manage",
  SNAPSHOTS_CREATE: "snapshots.create",
  SIMULATIONS_RUN: "simulations.run",
  SIMULATIONS_READ: "simulations.read",
  RECOMMENDATIONS_READ: "recommendations.read",
  CHANGES_REQUEST: "changes.request",
  CHANGES_APPROVE: "changes.approve",
  CHANGES_APPLY: "changes.apply",
  REPORTS_READ: "reports.read",
  REPORTS_EXPORT: "reports.export",
  AUDIT_READ: "audit.read",
  POLICIES_MANAGE: "policies.manage",
} as const;

export type PermissionCode = (typeof P)[keyof typeof P];

export const PERMISSION_LABELS: Record<string, string> = {
  "users.read": "View user accounts",
  "users.manage": "Manage user accounts and department memberships",
  "roles.manage": "Manage roles and permissions",
  "departments.manage": "Manage departments",
  "dashboard.global.read": "View the global operations dashboard",
  "tickets.read": "View tickets",
  "tickets.create": "Create tickets",
  "tickets.update": "Update tickets",
  "tickets.assign": "Assign tickets",
  "resources.read": "View resources and staffing",
  "resources.manage": "Change resources and staffing",
  "snapshots.create": "Create digital twin snapshots",
  "simulations.run": "Run simulations",
  "simulations.read": "View simulation results",
  "recommendations.read": "View recommendations",
  "changes.request": "Request operational changes",
  "changes.approve": "Approve or reject operational changes",
  "changes.apply": "Apply approved changes",
  "reports.read": "View reports",
  "reports.export": "Export reports",
  "audit.read": "View audit logs",
  "policies.manage": "Configure operational and approval policies",
};

export const PERMISSION_GROUP_LABELS: Record<string, string> = {
  users: "People",
  roles: "People",
  departments: "Departments",
  dashboard: "Dashboards",
  tickets: "Tickets",
  resources: "Resources and staffing",
  snapshots: "Digital twin",
  simulations: "Digital twin",
  recommendations: "Digital twin",
  changes: "Operational changes",
  reports: "Reports",
  audit: "Audit",
  policies: "Policies",
};

export function permissionLabel(code: string): string {
  return PERMISSION_LABELS[code] ?? code;
}

export function permissionGroup(code: string): string {
  return PERMISSION_GROUP_LABELS[code.split(".")[0]] ?? "Other";
}

export interface ScopeTarget {
  /** Require a global (all-departments) grant. */
  global?: boolean;
  /** Require the grant to cover this department. */
  departmentId?: string | null;
  /** Require the grant to cover every one of these departments (cross-department actions). */
  departmentIds?: readonly string[];
}

function grantCovers(grant: PermissionGrant, departmentId: string): boolean {
  return grant.scope === "global" || grant.department_ids.includes(departmentId);
}

/**
 * Does the user hold `code`?
 * - No target: in any scope (used for navigation).
 * - global: only an all-departments grant counts.
 * - departmentId / departmentIds: every listed department must be covered.
 */
export function hasPermission(user: CurrentUser | null, code: PermissionCode, target: ScopeTarget = {}): boolean {
  if (!user || !user.is_active) return false;
  const grants = user.grants.filter((g) => g.code === code);
  if (grants.length === 0) return false;
  if (target.global) return grants.some((g) => g.scope === "global");

  const required = [
    ...(target.departmentId ? [target.departmentId] : []),
    ...(target.departmentIds ?? []),
  ];
  if (required.length === 0) return true;
  return required.every((dept) => grants.some((g) => grantCovers(g, dept)));
}

/** Departments where the user holds `code`: "all", or a list of department ids. */
export function scopeFor(user: CurrentUser | null, code: PermissionCode): "all" | string[] {
  if (!user || !user.is_active) return [];
  const grants = user.grants.filter((g) => g.code === code);
  if (grants.some((g) => g.scope === "global")) return "all";
  return Array.from(new Set(grants.flatMap((g) => g.department_ids)));
}

export function hasGlobalScope(user: CurrentUser | null): boolean {
  return !!user && user.grants.some((g) => g.scope === "global");
}

export interface PermissionRequirement extends ScopeTarget {
  permission?: PermissionCode;
  anyOf?: readonly PermissionCode[];
  allOf?: readonly PermissionCode[];
}

export function meetsRequirement(user: CurrentUser | null, req: PermissionRequirement): boolean {
  if (!user || !user.is_active) return false;
  const target: ScopeTarget = { global: req.global, departmentId: req.departmentId, departmentIds: req.departmentIds };
  if (req.permission && !hasPermission(user, req.permission, target)) return false;
  if (req.allOf && !req.allOf.every((c) => hasPermission(user, c, target))) return false;
  if (req.anyOf && !req.anyOf.some((c) => hasPermission(user, c, target))) return false;
  return true;
}
