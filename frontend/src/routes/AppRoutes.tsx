import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "../components/AppShell";
import { NAV_SECTIONS } from "../components/navigation";
import { useAuth } from "../auth/AuthContext";
import { RequireAuth, RequirePermission } from "../auth/guards";
import { P } from "../auth/permissions";
import LandingPage from "../pages/public/LandingPage";
import SubmitRequestPage from "../pages/public/SubmitRequestPage";
import AcceptInvitationPage from "../pages/public/AcceptInvitationPage";
import TrackRequestPage from "../pages/public/TrackRequestPage";
import LoginPage from "../pages/auth/LoginPage";
import SessionExpiredPage from "../pages/auth/SessionExpiredPage";
import AccessDeniedPage from "../pages/auth/AccessDeniedPage";
import NotFoundPage from "../pages/NotFoundPage";
import ProfilePage from "../pages/account/ProfilePage";
import DashboardPage from "../pages/dashboard/DashboardPage";
import TicketsPage from "../pages/tickets/TicketsPage";
import TicketDetailPage from "../pages/tickets/TicketDetailPage";
import ResourcesPage from "../pages/resources/ResourcesPage";
import WorkflowExplorerPage from "../pages/workflow/WorkflowExplorerPage";
import EventLogPage from "../pages/events/EventLogPage";
import SettingsPage from "../pages/settings/SettingsPage";
import ApprovalInboxPage from "../pages/approvals/ApprovalInboxPage";
import AuditLogPage from "../pages/audit/AuditLogPage";
import UsersPage from "../pages/admin/UsersPage";
import RolesPage from "../pages/admin/RolesPage";
import MembershipsPage from "../pages/admin/MembershipsPage";
import DigitalTwinPage from "../pages/twin/DigitalTwinPage";
import ScenarioBuilderPage from "../pages/twin/ScenarioBuilderPage";
import StressTestPage from "../pages/twin/StressTestPage";
import RecommendationsPage from "../pages/twin/RecommendationsPage";
import ResultsPage from "../pages/twin/ResultsPage";
import SimulationRunPage from "../pages/twin/SimulationRunPage";
import AssumptionsPage from "../pages/twin/AssumptionsPage";
import PredictionMonitorPage from "../pages/twin/PredictionMonitorPage";
import AiAutomationPage from "../pages/ai/AiAutomationPage";

/** Sends each person to the first area their permissions allow. */
function StartPage() {
  const { meets } = useAuth();
  const first = NAV_SECTIONS.flatMap((s) => s.items).find((i) => meets(i.requirement));
  return <Navigate to={first?.to ?? "/profile"} replace />;
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/submit" element={<SubmitRequestPage />} />
      <Route path="/track" element={<TrackRequestPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route path="/session-expired" element={<SessionExpiredPage />} />

      {/* Signed in */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/start" element={<StartPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/access-denied" element={<AccessDeniedPage />} />

          <Route element={<RequirePermission anyOf={[P.DASHBOARD_GLOBAL_READ, P.TICKETS_READ, P.SIMULATIONS_READ]} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<RequirePermission permission={P.TICKETS_READ} />}>
            <Route path="/tickets" element={<TicketsPage />} />
            {/* The API returns 404 for tickets outside the user's scope, so changing the ID reveals nothing. */}
            <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission={P.RESOURCES_READ} />}>
            <Route path="/resources" element={<ResourcesPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={[P.TICKETS_READ, P.RESOURCES_READ]} />}>
            <Route path="/workflow" element={<WorkflowExplorerPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[P.TICKETS_READ, P.SIMULATIONS_READ, P.POLICIES_MANAGE]} />}>
            <Route path="/ai" element={<AiAutomationPage />} />
          </Route>

          {/* Digital twin: reads snapshots and simulation results; never writes live operational data. */}
          <Route element={<RequirePermission anyOf={[P.SIMULATIONS_READ, P.SIMULATIONS_RUN, P.SNAPSHOTS_CREATE]} />}>
            <Route path="/twin" element={<DigitalTwinPage />} />
            <Route path="/assumptions" element={<AssumptionsPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={[P.SIMULATIONS_READ, P.SIMULATIONS_RUN]} />}>
            <Route path="/scenarios" element={<ScenarioBuilderPage />} />
            <Route path="/stress-test" element={<StressTestPage />} />
            <Route path="/results" element={<ResultsPage />} />
            {/* The API answers 404 for runs outside the caller's snapshot scope. */}
            <Route path="/simulations/:simulationId" element={<SimulationRunPage />} />
          </Route>
          <Route element={<RequirePermission permission={P.RECOMMENDATIONS_READ} />}>
            <Route path="/recommendations" element={<RecommendationsPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={[P.SIMULATIONS_READ, P.AUDIT_READ, P.CHANGES_APPLY, P.CHANGES_APPROVE]} />}>
            <Route path="/prediction-monitor" element={<PredictionMonitorPage />} />
          </Route>

          <Route element={<RequirePermission anyOf={[P.CHANGES_REQUEST, P.CHANGES_APPROVE, P.CHANGES_APPLY]} />}>
            <Route path="/approvals" element={<ApprovalInboxPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={[P.TICKETS_READ, P.RESOURCES_READ, P.AUDIT_READ]} />}>
            <Route path="/events" element={<EventLogPage />} />
          </Route>
          <Route element={<RequirePermission permission={P.AUDIT_READ} />}>
            <Route path="/audit" element={<AuditLogPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={[P.POLICIES_MANAGE, P.AUDIT_READ]} />}>
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route element={<RequirePermission permission={P.USERS_MANAGE} global />}>
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/memberships" element={<MembershipsPage />} />
          </Route>
          <Route element={<RequirePermission permission={P.ROLES_MANAGE} global />}>
            <Route path="/admin/roles" element={<RolesPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
