import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

export function PublicHeader() {
  const { status } = useAuth();
  return (
    <header className="border-b border-line bg-navy-950">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <Link to="/" className="whitespace-nowrap text-lg font-bold tracking-tight text-ink no-underline">
          OpsTwin Live
        </Link>
        <nav className="flex items-center gap-2" aria-label="Site">
          <span className="hidden gap-2 sm:inline-flex">
            <Link to="/track" className="ot-btn ot-btn-quiet">
              Track a request
            </Link>
            <Link to="/submit" className="ot-btn ot-btn-quiet">
              Report an IT problem
            </Link>
          </span>
          {status === "authenticated" ? (
            <Link to="/start" className="ot-btn ot-btn-primary">
              Open operations
            </Link>
          ) : (
            <Link to="/login" className="ot-btn ot-btn-primary">
              Staff sign-in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
