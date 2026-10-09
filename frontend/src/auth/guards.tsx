import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { PermissionRequirement } from "./permissions";
import AccessDeniedPage from "../pages/auth/AccessDeniedPage";
import { FullPageStatus } from "../components/ui";

/** Blocks the route until there is an authenticated session. */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <FullPageStatus title="Checking your session" />;
  if (status === "unavailable") {
    return (
      <FullPageStatus title="Can't reach OpsTwin Live">
        The server didn't respond. Check your connection, then reload the page.
      </FullPageStatus>
    );
  }
  if (status === "ended") return <Navigate to="/session-expired" replace state={{ from: location }} />;
  if (status === "anonymous") return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children ?? <Outlet />}</>;
}

/**
 * Shows the access-denied page in place when the requirement isn't met.
 * This only controls what the browser shows; the API behind the page enforces
 * the same permission on every request.
 */
export function RequirePermission({ children, ...req }: PermissionRequirement & { children?: ReactNode }) {
  const { meets } = useAuth();
  if (!meets(req)) return <AccessDeniedPage />;
  return <>{children ?? <Outlet />}</>;
}

/** Renders children only when the requirement is met. */
export function Can({
  children,
  fallback = null,
  ...req
}: PermissionRequirement & { children: ReactNode; fallback?: ReactNode }) {
  const { meets } = useAuth();
  return <>{meets(req) ? children : fallback}</>;
}

export function useCan(req: PermissionRequirement): boolean {
  return useAuth().meets(req);
}
