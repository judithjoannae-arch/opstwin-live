import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRequest, isApiError } from "../../api/http";
import { ErrorNotice, formatDateTime } from "../../components/ui";
import { CATEGORY_LABELS, isEmail } from "../../utils/format";
import type { TicketCategory } from "../../types/operations";
import { PublicHeader } from "./PublicHeader";

interface RequestStatus {
  reference: string;
  title: string;
  category: TicketCategory;
  status: string;
  progress: string;
  step: number;
  steps: number;
  cancelled: boolean;
  created_at: string;
  updated_at: string;
  target_at: string;
  closed_at: string | null;
}

const STEP_NAMES = ["Received", "Reviewed", "Being fixed", "Checked", "Closed"];

function lookup(reference: string, email: string) {
  return apiRequest<RequestStatus>("/public/requests/lookup", {
    method: "POST",
    body: { reference: reference.trim(), email: email.trim() },
    silentAuth: true,
  });
}

/** Lets a student or staff member check their request with its reference and their email. */
export default function TrackRequestPage() {
  const [params] = useSearchParams();
  const [reference, setReference] = useState(params.get("ref") ?? "");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<RequestStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setResult(null), [reference, email]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await lookup(reference, email));
    } catch (err) {
      setError(isApiError(err) && err.status === 429 ? new Error("Too many lookups. Wait a few minutes and try again.") : err);
    } finally {
      setBusy(false);
    }
  };

  const valid = reference.trim().length > 0 && isEmail(email);

  return (
    <div className="min-h-screen bg-navy-900 text-ink">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-5 py-10">
        <form onSubmit={(e) => void submit(e)} className="ot-panel" noValidate>
          <h1 className="text-2xl font-semibold">Track a request</h1>
          <p className="text-muted">Enter the reference you were given and the email you used when you reported the problem.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <label className="ot-field">
              <span>Reference</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TCK-000155" autoComplete="off" />
            </label>
            <label className="ot-field">
              <span>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          <ErrorNotice error={error} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to="/submit" className="ot-link text-sm">
              Report a new problem instead
            </Link>
            <button type="submit" className="ot-btn ot-btn-primary" disabled={busy || !valid}>
              {busy ? "Checking…" : "Check status"}
            </button>
          </div>
        </form>

        {result && (
          <section className="ot-panel" aria-live="polite" aria-labelledby="track-title">
            <p className="ot-mono m-0 text-sm text-signal">{result.reference}</p>
            <h2 id="track-title" className="mt-1 text-xl">
              {result.title}
            </h2>
            <p className="text-sm text-muted">{CATEGORY_LABELS[result.category]}</p>

            <ol className="m-0 my-5 grid list-none grid-cols-5 gap-2 p-0" aria-label="Progress">
              {STEP_NAMES.map((name, i) => {
                const done = !result.cancelled && i < result.step;
                const current = !result.cancelled && i === result.step;
                return (
                  <li key={name} aria-current={current ? "step" : undefined}>
                    <span
                      className={`block h-1.5 rounded-full ${done || current ? "bg-signal" : "bg-line"} ${current && i < 4 ? "opacity-60" : ""}`}
                    />
                    <span className={`mt-1.5 block text-xs ${current ? "font-semibold text-ink" : "text-muted"}`}>{name}</span>
                  </li>
                );
              })}
            </ol>

            <p className={`text-lg ${result.cancelled ? "text-warn" : ""}`}>{result.progress}</p>
            <dl className="ot-facts">
              <div>
                <dt>Reported</dt>
                <dd>{formatDateTime(result.created_at)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatDateTime(result.updated_at)}</dd>
              </div>
              <div>
                <dt>{result.closed_at ? "Closed" : "Target time"}</dt>
                <dd>{formatDateTime(result.closed_at ?? result.target_at)}</dd>
              </div>
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}
