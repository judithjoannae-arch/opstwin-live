import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../auth/AuthContext";
import { Can, RequirePermission } from "../auth/guards";
import { P, hasPermission, meetsRequirement, scopeFor } from "../auth/permissions";
import type { CurrentUser, PermissionGrant } from "../api/types";
import { NAV_SECTIONS } from "../components/navigation";

function makeUser(grants: PermissionGrant[], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "u1",
    email: "person@example.test",
    full_name: "Test Person",
    is_active: true,
    roles: [],
    memberships: [],
    grants,
    departments: [],
    session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

const technician = makeUser([
  { code: P.TICKETS_READ, scope: "departments", department_ids: ["support"] },
  { code: P.TICKETS_UPDATE, scope: "departments", department_ids: ["support"] },
]);

const deptManager = makeUser([
  { code: P.TICKETS_READ, scope: "departments", department_ids: ["support"] },
  { code: P.SIMULATIONS_RUN, scope: "departments", department_ids: ["support"] },
  { code: P.CHANGES_REQUEST, scope: "departments", department_ids: ["support"] },
]);

const auditor = makeUser([{ code: P.AUDIT_READ, scope: "global", department_ids: [] }]);

const superAdmin = makeUser(
  Object.values(P).map((code) => ({ code, scope: "global" as const, department_ids: [] })),
);

function authValue(user: CurrentUser | null): AuthContextValue {
  return {
    status: user ? "authenticated" : "anonymous",
    user,
    endedReason: null,
    login: async () => {},
    logout: async () => {},
    refreshUser: async () => {},
    can: (code, target) => hasPermission(user, code, target),
    meets: (req) => meetsRequirement(user, req),
    scopeFor: (code) => scopeFor(user, code),
  };
}

describe("permission evaluation", () => {
  it("limits department grants to their departments", () => {
    expect(hasPermission(technician, P.TICKETS_READ, { departmentId: "support" })).toBe(true);
    expect(hasPermission(technician, P.TICKETS_READ, { departmentId: "intake" })).toBe(false);
  });

  it("requires every department for cross-department actions", () => {
    expect(hasPermission(deptManager, P.CHANGES_REQUEST, { departmentIds: ["support"] })).toBe(true);
    expect(hasPermission(deptManager, P.CHANGES_REQUEST, { departmentIds: ["support", "intake"] })).toBe(false);
  });

  it("doesn't treat a department grant as global", () => {
    expect(hasPermission(deptManager, P.TICKETS_READ, { global: true })).toBe(false);
    expect(scopeFor(deptManager, P.TICKETS_READ)).toEqual(["support"]);
    expect(scopeFor(superAdmin, P.TICKETS_READ)).toBe("all");
  });

  it("denies everything to deactivated accounts", () => {
    expect(hasPermission({ ...superAdmin, is_active: false }, P.USERS_MANAGE)).toBe(false);
  });

  it("gives technicians and auditors no change-approval or admin permissions", () => {
    for (const user of [technician, auditor]) {
      expect(hasPermission(user, P.CHANGES_APPROVE)).toBe(false);
      expect(hasPermission(user, P.CHANGES_APPLY)).toBe(false);
      expect(hasPermission(user, P.USERS_MANAGE)).toBe(false);
      expect(hasPermission(user, P.ROLES_MANAGE)).toBe(false);
    }
  });
});

describe("navigation", () => {
  const visible = (user: CurrentUser) =>
    NAV_SECTIONS.flatMap((s) => s.items).filter((i) => meetsRequirement(user, i.requirement)).map((i) => i.to);

  it("shows technicians only their operational areas", () => {
    expect(visible(technician)).toEqual(["/dashboard", "/tickets", "/workflow", "/ai", "/events"]);
  });

  it("shows auditors only read-only governance pages", () => {
    expect(visible(auditor)).toEqual(["/prediction-monitor", "/events", "/audit", "/settings"]);
  });

  it("shows administration only to global admins", () => {
    expect(visible(deptManager)).not.toContain("/admin/users");
    expect(visible(superAdmin)).toEqual(expect.arrayContaining(["/admin/users", "/admin/roles", "/admin/memberships"]));
  });
});

describe("guards", () => {
  const renderAt = (user: CurrentUser) =>
    render(
      <AuthContext.Provider value={authValue(user)}>
        <MemoryRouter initialEntries={["/admin/users"]}>
          <Routes>
            <Route element={<RequirePermission permission={P.USERS_MANAGE} global />}>
              <Route path="/admin/users" element={<p>User management</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

  it("shows access denied when the permission is missing", () => {
    renderAt(technician);
    expect(screen.getByRole("heading", { name: /don't have access/i })).toBeTruthy();
    expect(screen.queryByText("User management")).toBeNull();
  });

  it("renders the page when the permission is held globally", () => {
    renderAt(superAdmin);
    expect(screen.getByText("User management")).toBeTruthy();
  });

  it("Can hides actions outside the user's departments", () => {
    render(
      <AuthContext.Provider value={authValue(deptManager)}>
        <Can permission={P.CHANGES_REQUEST} departmentId="support">
          <button>Request in Technical support</button>
        </Can>
        <Can permission={P.CHANGES_REQUEST} departmentId="intake">
          <button>Request in Intake</button>
        </Can>
      </AuthContext.Provider>,
    );
    expect(screen.getByText("Request in Technical support")).toBeTruthy();
    expect(screen.queryByText("Request in Intake")).toBeNull();
  });
});
