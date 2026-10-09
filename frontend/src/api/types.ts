/**
 * API contract types shared by the RBAC frontend.
 * Field names follow the FastAPI backend's JSON (snake_case).
 */
import type { PermissionCode } from "../auth/permissions";

export interface Department {
  id: string;
  name: string;
}

export interface RoleSummary {
  id: string;
  name: string;
  /** System roles (e.g. Super Admin) can't be edited from the UI. */
  is_locked: boolean;
}

/**
 * One effective permission for the signed-in user, already resolved by the
 * backend from roles + department memberships.
 * scope "global": applies to every department.
 * scope "departments": applies only to department_ids.
 */
export interface PermissionGrant {
  code: PermissionCode;
  scope: "global" | "departments";
  department_ids: string[];
}

export interface Membership {
  department_id: string;
  department_name: string;
}

/** Response of GET /auth/me. Contains no secrets or tokens. */
export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: RoleSummary[];
  memberships: Membership[];
  grants: PermissionGrant[];
  /** Every department referenced by the user's grants/memberships (all departments for global grants). */
  departments: Department[];
  session_expires_at: string;
}

export interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip_address: string | null;
  is_current: boolean;
}

export interface Page<T> {
  items: T[];
  total?: number;
  next_cursor?: string | null;
}

export interface UserAccount {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  invitation_pending: boolean;
  roles: RoleSummary[];
  departments: Department[];
  last_login_at: string | null;
  created_at: string;
}

export interface RoleDetail extends RoleSummary {
  description: string | null;
  permission_codes: string[];
  user_count: number;
  /** Optimistic-concurrency version; sent back on update. */
  version: number;
}

export interface PermissionDefinition {
  code: string;
  description: string;
  group: string;
}

export interface DepartmentMember {
  user_id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  roles: RoleSummary[];
  added_at: string;
}

export type ChangeRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "APPLIED" | "EXPIRED" | "STALE";

export interface PersonRef {
  id: string;
  full_name: string;
}

export interface ConfigDiffRow {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ApprovalDecision {
  id: string;
  approver: PersonRef;
  decision: "APPROVED" | "REJECTED";
  reason: string;
  decided_at: string;
  department_id: string | null;
}

export interface RequiredApproval {
  department_id: string;
  department_name: string;
  satisfied: boolean;
}

export interface ChangeRequestSummary {
  id: string;
  title: string;
  status: ChangeRequestStatus;
  requested_by: PersonRef;
  requested_at: string;
  affected_departments: Department[];
}

export interface ChangeRequest extends ChangeRequestSummary {
  reason: string;
  recommendation_id: string;
  source_simulation_id: string;
  source_config_version: string;
  /** Live configuration version right now; differs from the source when stale. */
  current_config_version: string;
  expected_benefits: string[];
  risks: string[];
  config_diff: ConfigDiffRow[];
  requires_separation_of_duties: boolean;
  required_approvals: RequiredApproval[];
  decisions: ApprovalDecision[];
  expires_at: string | null;
  applied_at: string | null;
  applied_by: PersonRef | null;
  /** Server-computed hints for the current user. The server re-checks on every action. */
  can_approve: boolean;
  can_apply: boolean;
  blocked_reason: string | null;
}

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILURE";

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor: PersonRef | null;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: AuditOutcome;
  department_id: string | null;
  department_name: string | null;
  correlation_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
}
