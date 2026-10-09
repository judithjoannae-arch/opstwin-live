import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../auth/AuthContext";
import { P, hasPermission, meetsRequirement, scopeFor } from "../auth/permissions";
import type { CurrentUser } from "../api/types";
import type { OperationsState } from "../types/operations";
import { availableActions, propagationPath } from "../utils/workflow";
import { formatMinutes, formatRelative } from "../utils/format";
import DashboardPage from "../pages/dashboard/DashboardPage";
import SubmitRequestPage, { validateRequest } from "../pages/public/SubmitRequestPage";

const manager: CurrentUser = {
  id: "u1",
  email: "ops@example.test",
  full_name: "Ops Manager",
  is_active: true,
  roles: [],
  memberships: [],
  grants: [P.DASHBOARD_GLOBAL_READ, P.TICKETS_READ, P.RESOURCES_READ].map((code) => ({ code, scope: "global" as const, department_ids: [] })),
  departments: [],
  session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

function auth(user: CurrentUser): AuthContextValue {
  return {
    status: "authenticated",
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

function emptyState(): OperationsState {
  return {
    generated_at: new Date().toISOString(),
    config_version: "cfg-1",
    latest_snapshot: null,
    data_coverage: { first_ticket_at: null, last_event_at: null, real_ticket_count: 0, demo_ticket_count: 0 },
    totals: { submitted: 0, open: 0, in_progress: 0, on_hold: 0, resolved: 0, closed: 0, overdue: 0 },
    stages: (["intake", "triage", "support", "verification"] as const).map((stage) => ({
      stage,
      queue: 0,
      in_service: 0,
      on_hold: 0,
      available_resources: 0,
      total_resources: 0,
      completed_per_hour: null,
      avg_wait_minutes: null,
      sla_at_risk: 0,
      sla_breached: 0,
      utilization_pct: null,
      bottleneck: "none",
      bottleneck_reason: null,
    })),
    staff: { available: 0, unavailable: 0, off_shift: 0, total: 0 },
    throughput: { window_hours: 24, completed: 0, per_hour: null, series: [] },
    sla: { compliance_pct: null, evaluated: 0, breached: 0 },
    oldest_unresolved: null,
    recent_events: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ticket workflow", () => {
  it("offers the next stage for each lifecycle point", () => {
    expect(availableActions({ stage: "intake", status: "open" }).map((a) => a.key)).toEqual(["send_to_triage"]);
    expect(availableActions({ stage: "support", status: "in_progress" }).map((a) => a.key)).toEqual(["resolve", "hold"]);
    expect(availableActions({ stage: "verification", status: "resolved" }).map((a) => a.key)).toEqual(["close", "rework"]);
  });

  it("offers nothing for finished tickets", () => {
    expect(availableActions({ stage: "verification", status: "closed" })).toEqual([]);
    expect(availableActions({ stage: "triage", status: "cancelled" })).toEqual([]);
  });

  it("requires a note when resolving and an assignee before work starts", () => {
    const resolve = availableActions({ stage: "support", status: "in_progress" }).find((a) => a.key === "resolve");
    expect(resolve?.noteLabel).toBeTruthy();
    expect(availableActions({ stage: "support", status: "open" })[0].requiresAssignee).toBe(true);
  });

  it("propagates an overload to downstream stages only", () => {
    expect([...propagationPath(["triage"])]).toEqual(["support", "verification"]);
    expect(propagationPath(["verification"]).size).toBe(0);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(95)).toBe("1 h 35 min");
    expect(formatMinutes(3000)).toBe("2 d 2 h");
    expect(formatMinutes(null)).toBe("—");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(formatRelative("2026-10-09T14:00:00Z", now)).toBe("in 2 h");
    expect(formatRelative("2026-10-09T11:30:00Z", now)).toBe("30 min ago");
  });
});

describe("public request form", () => {
  it("validates required fields", () => {
    const errors = validateRequest({
      requester_name: "",
      requester_email: "not-an-email",
      category: "",
      title: "x",
      description: "short",
      affects_many_users: false,
    });
    expect(Object.keys(errors).sort()).toEqual(["category", "description", "requester_email", "requester_name", "title"]);
  });

  it("shows field errors instead of sending an invalid request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthContext.Provider value={{ ...auth(manager), status: "anonymous", user: null }}>
        <MemoryRouter>
          <SubmitRequestPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("operations dashboard", () => {
  it("says when there isn't enough data instead of inventing numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(emptyState()), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    render(
      <AuthContext.Provider value={auth(manager)}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(await screen.findByText("Workflow right now")).toBeTruthy();
    // SLA compliance, throughput and oldest unresolved have no data yet.
    expect(screen.getAllByText("Insufficient operational data").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/Insufficient operational data in this time window/)).toBeTruthy();
    expect(screen.getByText("none yet")).toBeTruthy();
  });
});
