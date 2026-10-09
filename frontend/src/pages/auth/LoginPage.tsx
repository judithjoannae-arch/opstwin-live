import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate, type Location } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { isApiError } from "../../api/http";

/** Only allow redirects back to in-app paths (no open redirects). */
function safeReturnPath(state: unknown): string {
  const from = (state as { from?: Location } | null)?.from;
  const path = from ? `${from.pathname}${from.search ?? ""}` : "/start";
  if (path === "/" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/login") || path.startsWith("/session-expired")) {
    return "/start";
  }
  return path;
}

function loginErrorMessage(e: unknown): string {
  if (!isApiError(e)) return "Sign-in failed. Try again.";
  if (e.status === 429) {
    const minutes = e.retryAfterSeconds ? Math.ceil(e.retryAfterSeconds / 60) : null;
    return minutes
      ? `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
      : "Too many sign-in attempts. Wait a few minutes and try again.";
  }
  // One message for wrong email, wrong password and inactive accounts, so the
  // form doesn't reveal which accounts exist.
  if (e.status === 400 || e.status === 401 || e.status === 403) {
    return "That email and password don't match an active account.";
  }
  return e.message;
}

export default function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "authenticated") return <Navigate to={returnTo} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ot-auth">
      <form className="ot-auth-card" onSubmit={(e) => void onSubmit(e)} noValidate>
        <p className="ot-wordmark">OpsTwin Live</p>
        <h1>Sign in</h1>
        <p className="ot-muted">Use the account your administrator set up for you.</p>

        {error && (
          <div className="ot-notice ot-notice-error" role="alert">
            <p>{error}</p>
          </div>
        )}

        <label className="ot-field">
          <span>Work email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="ot-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" className="ot-btn ot-btn-primary ot-btn-block" disabled={submitting || !email || !password}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <p className="ot-muted ot-small">Forgot your password? Ask a Super Admin to send you a reset link.</p>
      </form>
    </div>
  );
}
