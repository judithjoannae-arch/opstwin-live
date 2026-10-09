import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authApi } from "../../api/rbacApi";
import { ErrorNotice } from "../../components/ui";

function strengthProblem(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  if (pw.toLowerCase() === pw || pw.toUpperCase() === pw || !/\d/.test(pw)) return "Mix upper- and lower-case letters and at least one digit.";
  return null;
}

/** Sets a password from a single-use, expiring invitation link. */
export default function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = password ? strengthProblem(password) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.acceptInvitation(token, password);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ot-auth">
      {done ? (
        <section className="ot-auth-card">
          <p className="ot-wordmark">OpsTwin Live</p>
          <h1>Your account is ready</h1>
          <Link to="/login" className="ot-btn ot-btn-primary ot-btn-block">
            Sign in
          </Link>
        </section>
      ) : (
        <form className="ot-auth-card" onSubmit={(e) => void submit(e)}>
          <p className="ot-wordmark">OpsTwin Live</p>
          <h1>Set your password</h1>
          {!token && <p className="ot-field-error">This link is missing its invitation token.</p>}
          <ErrorNotice error={error} />
          <label className="ot-field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {problem && <small className="ot-field-error">{problem}</small>}
          </label>
          <label className="ot-field">
            <span>Repeat password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {confirm && confirm !== password && <small className="ot-field-error">The passwords don't match.</small>}
          </label>
          <button type="submit" className="ot-btn ot-btn-primary ot-btn-block" disabled={busy || !token || !!problem || !password || password !== confirm}>
            {busy ? "Saving…" : "Set password"}
          </button>
        </form>
      )}
    </div>
  );
}
