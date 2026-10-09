import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

const COPY = {
  expired: {
    title: "Your session has ended",
    body: "Sessions end after a period of inactivity or at a fixed time limit. Sign in again to pick up where you left off.",
  },
  revoked: {
    title: "You've been signed out",
    body: "This session was ended from another device or by an administrator. Sign in again to continue.",
  },
  deactivated: {
    title: "This account is no longer active",
    body: "An administrator deactivated this account. Contact a Super Admin if you think this is a mistake.",
  },
} as const;

export default function SessionExpiredPage() {
  const { status, endedReason } = useAuth();
  const location = useLocation();
  const copy = COPY[endedReason ?? "expired"];

  if (status === "authenticated") {
    return (
      <div className="ot-auth">
        <section className="ot-auth-card">
          <h1>You're signed in</h1>
          <p>
            <Link className="ot-btn ot-btn-primary" to="/start">
              Go to your start page
            </Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="ot-auth">
      <section className="ot-auth-card" aria-labelledby="ot-expired-title">
        <p className="ot-wordmark">OpsTwin Live</p>
        <h1 id="ot-expired-title">{copy.title}</h1>
        <p>{copy.body}</p>
        {endedReason !== "deactivated" && (
          <Link className="ot-btn ot-btn-primary ot-btn-block" to="/login" state={location.state}>
            Sign in again
          </Link>
        )}
      </section>
    </div>
  );
}
