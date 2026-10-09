import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <section className="ot-state-page" aria-labelledby="ot-notfound-title">
      <h1 id="ot-notfound-title">This page doesn't exist</h1>
      <p>Check the address, or go back to your start page.</p>
      <p>
        <Link className="ot-btn ot-btn-primary" to="/start">
          Go to your start page
        </Link>
      </p>
    </section>
  );
}
