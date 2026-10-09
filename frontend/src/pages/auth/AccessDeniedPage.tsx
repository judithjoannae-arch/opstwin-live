import { Link } from "react-router-dom";

/**
 * Shown in place of a page the user can't open. It doesn't say which
 * permission is missing or whether a specific record exists.
 */
export default function AccessDeniedPage() {
  return (
    <section className="ot-state-page" aria-labelledby="ot-denied-title">
      <h1 id="ot-denied-title">You don't have access to this page</h1>
      <p>
        Your roles don't cover this area for your departments. If you need it for your work, ask a Super Admin to review
        your roles or department memberships.
      </p>
      <p>
        <Link className="ot-btn ot-btn-primary" to="/start">
          Go to your start page
        </Link>
      </p>
    </section>
  );
}
