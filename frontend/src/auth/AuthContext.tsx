import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authApi } from "../api/rbacApi";
import { isApiError, onSessionEnded, resetCsrfToken, type SessionEndReason } from "../api/http";
import type { CurrentUser } from "../api/types";
import {
  hasPermission,
  meetsRequirement,
  scopeFor,
  type PermissionCode,
  type PermissionRequirement,
  type ScopeTarget,
} from "./permissions";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "ended" | "unavailable";

export interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  endedReason: SessionEndReason | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads /auth/me, e.g. after an admin changed this user's roles. */
  refreshUser: () => Promise<void>;
  can: (code: PermissionCode, target?: ScopeTarget) => boolean;
  meets: (req: PermissionRequirement) => boolean;
  scopeFor: (code: PermissionCode) => "all" | string[];
}

export const AuthContext = createContext<AuthContextValue | null>(null);

interface State {
  status: AuthStatus;
  user: CurrentUser | null;
  endedReason: SessionEndReason | null;
}

/** Re-validate the session when the tab regains focus after this long. */
const REVALIDATE_AFTER_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading", user: null, endedReason: null });
  const lastCheck = useRef(0);

  const loadMe = useCallback(async () => {
    lastCheck.current = Date.now();
    try {
      const me = await authApi.me();
      if (!me.is_active) throw new Error("inactive");
      setState({ status: "authenticated", user: me, endedReason: null });
    } catch (e) {
      if (isApiError(e) && e.status === 0) {
        // Server unreachable: keep a signed-in user in place, otherwise report it.
        setState((s) => (s.status === "authenticated" ? s : { status: "unavailable", user: null, endedReason: null }));
        return;
      }
      setState((s) =>
        s.status === "authenticated"
          ? { status: "ended", user: null, endedReason: isApiError(e) && e.code === "account_deactivated" ? "deactivated" : "expired" }
          : { status: "anonymous", user: null, endedReason: null },
      );
    }
  }, []);

  // Initial probe.
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // Any API call that gets a 401 ends the session everywhere in the UI.
  useEffect(
    () =>
      onSessionEnded((reason) =>
        setState((s) => (s.status === "authenticated" ? { status: "ended", user: null, endedReason: reason } : s)),
      ),
    [],
  );

  // Proactively end the session at its expiry time.
  useEffect(() => {
    if (state.status !== "authenticated" || !state.user) return;
    const ms = new Date(state.user.session_expires_at).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    const timer = setTimeout(() => void loadMe(), Math.min(Math.max(ms + 1000, 0), MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [state.status, state.user, loadMe]);

  // Pick up revoked sessions, deactivation and role changes when the user returns.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck.current > REVALIDATE_AFTER_MS) {
        void loadMe();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      await authApi.login(email, password);
      // The backend rotates the session and CSRF token on login.
      resetCsrfToken();
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the local session is cleared either way */
    } finally {
      resetCsrfToken();
      setState({ status: "anonymous", user: null, endedReason: null });
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      logout,
      refreshUser: loadMe,
      can: (code, target) => hasPermission(state.user, code, target),
      meets: (req) => meetsRequirement(state.user, req),
      scopeFor: (code) => scopeFor(state.user, code),
    }),
    [state, login, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** For pages that only render inside RequireAuth. */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error("useCurrentUser used outside an authenticated route");
  return user;
}
