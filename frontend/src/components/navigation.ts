import { P, type PermissionRequirement } from "../auth/permissions";

export interface NavItem {
  to: string;
  label: string;
  requirement: PermissionRequirement;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar structure. An item appears only when the signed-in user meets its
 * requirement in at least one department. AppRoutes guards the same paths,
 * and the backend enforces the permission and scope on every API call.
 *
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Live operations",
    items: [
      {
        to: "/dashboard",
        label: "Operations dashboard",
        requirement: { anyOf: [P.DASHBOARD_GLOBAL_READ, P.TICKETS_READ, P.SIMULATIONS_READ] },
      },
      { to: "/tickets", label: "Tickets", requirement: { permission: P.TICKETS_READ } },
      { to: "/resources", label: "Resources and staffing", requirement: { permission: P.RESOURCES_READ } },
      { to: "/workflow", label: "Workflow explorer", requirement: { anyOf: [P.TICKETS_READ, P.RESOURCES_READ] } },
    ],
  },
  {
    label: "AI automation",
    items: [
      { to: "/ai", label: "AI automation", requirement: { anyOf: [P.TICKETS_READ, P.SIMULATIONS_READ, P.POLICIES_MANAGE] } },
    ],
  },
  {
    label: "Digital twin",
    items: [
      { to: "/twin", label: "Digital twin", requirement: { anyOf: [P.SIMULATIONS_READ, P.SIMULATIONS_RUN, P.SNAPSHOTS_CREATE] } },
      { to: "/scenarios", label: "Scenario builder", requirement: { anyOf: [P.SIMULATIONS_RUN, P.SIMULATIONS_READ] } },
      { to: "/stress-test", label: "Stress test", requirement: { anyOf: [P.SIMULATIONS_RUN, P.SIMULATIONS_READ] } },
      { to: "/recommendations", label: "Recommendations", requirement: { permission: P.RECOMMENDATIONS_READ } },
      { to: "/results", label: "Results and analytics", requirement: { anyOf: [P.SIMULATIONS_READ, P.SIMULATIONS_RUN] } },
      { to: "/assumptions", label: "Model assumptions", requirement: { anyOf: [P.SIMULATIONS_READ, P.SIMULATIONS_RUN, P.SNAPSHOTS_CREATE] } },
      {
        to: "/prediction-monitor",
        label: "Prediction monitor",
        requirement: { anyOf: [P.SIMULATIONS_READ, P.AUDIT_READ, P.CHANGES_APPLY, P.CHANGES_APPROVE] },
      },
    ],
  },
  {
    label: "Governance",
    items: [
      {
        to: "/approvals",
        label: "Approvals",
        requirement: { anyOf: [P.CHANGES_REQUEST, P.CHANGES_APPROVE, P.CHANGES_APPLY] },
      },
      { to: "/events", label: "Event log", requirement: { anyOf: [P.TICKETS_READ, P.RESOURCES_READ, P.AUDIT_READ] } },
      { to: "/audit", label: "Audit trail", requirement: { permission: P.AUDIT_READ } },
      { to: "/settings", label: "Settings", requirement: { anyOf: [P.POLICIES_MANAGE, P.AUDIT_READ] } },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/admin/users", label: "Users", requirement: { permission: P.USERS_MANAGE, global: true } },
      { to: "/admin/roles", label: "Roles and permissions", requirement: { permission: P.ROLES_MANAGE, global: true } },
      { to: "/admin/memberships", label: "Department memberships", requirement: { permission: P.USERS_MANAGE, global: true } },
    ],
  },
];
