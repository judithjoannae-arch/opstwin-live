/**
 * HTTP client for the OpsTwin Live API.
 *
 * Security notes
 * - Authentication uses the HTTP-only session cookie set by the backend.
 *   This module never reads, stores or logs session tokens, and nothing
 *   auth-related goes into localStorage or sessionStorage.
 * - State-changing requests send X-CSRF-Token. The token comes from
 *   GET /auth/csrf and lives in memory only.
 * - Every request sends X-Request-ID so an error shown in the UI can be
 *   matched to backend logs and audit entries.
 * - The UI hides actions a user can't take, but the backend decides every
 *   call. A 401/403/404 from here is the source of truth.
 */

const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
export const API_BASE_URL = rawBase.replace(/\/+$/, "");

export type SessionEndReason = "expired" | "revoked" | "deactivated";

type QueryValue = string | number | boolean | null | undefined | string[];
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Don't broadcast "session ended" on 401. Used by login and the initial
   * /auth/me probe, where 401 just means "not signed in".
   */
  silentAuth?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly payload: unknown;

  constructor(
    status: number,
    message: string,
    code: string | null,
    correlationId: string | null,
    payload?: unknown,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.payload = payload;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback for older browsers / non-secure contexts.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- session-ended broadcast ---------- */

const sessionListeners = new Set<(reason: SessionEndReason) => void>();

export function onSessionEnded(listener: (reason: SessionEndReason) => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function emitSessionEnded(reason: SessionEndReason): void {
  csrfToken = null;
  sessionListeners.forEach((l) => l(reason));
}

function reasonFromCode(code: string | null): SessionEndReason {
  if (code === "session_revoked") return "revoked";
  if (code === "account_deactivated") return "deactivated";
  return "expired";
}

/* ---------- CSRF ---------- */

let csrfToken: string | null = null;
let csrfPromise: Promise<string> | null = null;

/** Drop the cached token, e.g. after login/logout when the backend rotates it. */
export function resetCsrfToken(): void {
  csrfToken = null;
}

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (!csrfPromise) {
    csrfPromise = (async () => {
      const res = await fetch(`${API_BASE_URL}/auth/csrf`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        throw new ApiError(
          res.status,
          "Couldn't start a secure session with the server. Reload the page and try again.",
          "csrf_unavailable",
          res.headers.get("X-Request-ID"),
        );
      }
      const data = (await res.json()) as { csrf_token: string };
      csrfToken = data.csrf_token;
      return csrfToken;
    })().finally(() => {
      csrfPromise = null;
    });
  }
  return csrfPromise;
}

/* ---------- errors ---------- */

function defaultMessage(status: number): string {
  if (status === 400) return "The request wasn't valid. Check the values and try again.";
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You don't have permission to do that.";
  // The backend also returns 404 for objects outside the user's scope, so this
  // message never confirms whether a restricted object exists.
  if (status === 404) return "That item doesn't exist or isn't available to you.";
  if (status === 409) return "This item changed since you loaded it. Reload and try again.";
  if (status === 422) return "Some fields are invalid. Check them and try again.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  return "The server couldn't complete the request. Try again, and share the reference ID if it keeps happening.";
}

function extractError(payload: unknown, status: number): { code: string | null; message: string } {
  const fallback = defaultMessage(status);
  if (status >= 500) return { code: null, message: fallback };
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === "string") return { code: null, message: detail };
    if (Array.isArray(detail)) return { code: "validation_error", message: defaultMessage(422) };
    if (detail && typeof detail === "object") {
      const d = detail as { code?: unknown; message?: unknown };
      return {
        code: typeof d.code === "string" ? d.code : null,
        message: typeof d.message === "string" ? d.message : fallback,
      };
    }
  }
  return { code: null, message: fallback };
}

/* ---------- request ---------- */

function buildUrl(path: string, query?: QueryParams): string {
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseBody(res: Response): Promise<unknown> {
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const method = options.method ?? "GET";
  const correlationId = newId();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-ID": correlationId,
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = await ensureCsrf();

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: "include",
      cache: "no-store",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiError(0, "Can't reach the OpsTwin server. Check your connection and try again.", "network_error", correlationId);
  }

  const responseId = res.headers.get("X-Request-ID") ?? correlationId;
  if (res.status === 204) return undefined as T;
  const payload = await parseBody(res);
  if (res.ok) return payload as T;

  const { code, message } = extractError(payload, res.status);

  // Rotated or expired CSRF token: fetch a fresh one and retry once.
  if (res.status === 403 && code === "csrf_failed" && !isRetry) {
    csrfToken = null;
    return apiRequest<T>(path, options, true);
  }
  if (res.status === 401 && !options.silentAuth) emitSessionEnded(reasonFromCode(code));

  const retryAfter = Number(res.headers.get("Retry-After"));
  throw new ApiError(
    res.status,
    message,
    code,
    responseId,
    payload,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  );
}
