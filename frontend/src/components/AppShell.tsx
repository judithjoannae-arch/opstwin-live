import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { hasGlobalScope, meetsRequirement } from "../auth/permissions";
import type { CurrentUser } from "../api/types";
import { NAV_SECTIONS } from "./navigation";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function ScopeSummary({ user }: { user: CurrentUser }) {
  const global = hasGlobalScope(user);
  return (
    <section className="ot-scope" aria-label="Your access">
      <p className="ot-scope-roles">{user.roles.map((r) => r.name).join(", ") || "No role assigned"}</p>
      {global ? (
        <p className="ot-scope-line">All departments</p>
      ) : user.memberships.length > 0 ? (
        <ul className="ot-scope-depts">
          {user.memberships.map((m) => (
            <li key={m.department_id}>{m.department_name}</li>
          ))}
        </ul>
      ) : (
        <p className="ot-scope-line">No department access yet</p>
      )}
    </section>
  );
}

function AccountMenu({ user, onSignOut }: { user: CurrentUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="ot-account" ref={wrapRef}>
      <button
        type="button"
        className="ot-account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ot-avatar" aria-hidden="true">
          {initials(user.full_name)}
        </span>
        <span className="ot-account-name">{user.full_name}</span>
      </button>
      {open && (
        <div className="ot-account-menu" role="menu">
          <p className="ot-account-email">{user.email}</p>
          <Link role="menuitem" to="/profile" onClick={() => setOpen(false)}>
            Profile and sessions
          </Link>
          <button role="menuitem" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => setNavOpen(false), [location.pathname]);

  if (!user) return null;

  const sections = NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => meetsRequirement(user, i.requirement)),
  })).filter((s) => s.items.length > 0);

  const signOut = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="ot-shell" data-nav-open={navOpen ? "true" : undefined}>
      <a className="ot-skip" href="#ot-main">
        Skip to content
      </a>
      <header className="ot-topbar">
        <button
          type="button"
          className="ot-btn ot-btn-quiet"
          aria-expanded={navOpen}
          aria-controls="ot-sidebar"
          onClick={() => setNavOpen((o) => !o)}
        >
          {navOpen ? "Close menu" : "Menu"}
        </button>
        <span className="ot-wordmark">OpsTwin Live</span>
      </header>

      <aside id="ot-sidebar" className="ot-sidebar">
        <Link to="/start" className="ot-wordmark ot-sidebar-wordmark">
          OpsTwin Live
        </Link>
        <nav aria-label="Main">
          {sections.map((section) => (
            <div className="ot-nav-section" key={section.label}>
              <h2 className="ot-nav-heading">{section.label}</h2>
              <ul>
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} className={({ isActive }) => (isActive ? "ot-nav-link is-active" : "ot-nav-link")}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="ot-sidebar-foot">
          <ScopeSummary user={user} />
          <AccountMenu user={user} onSignOut={() => void signOut()} />
        </div>
      </aside>

      <main className="ot-main" id="ot-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
