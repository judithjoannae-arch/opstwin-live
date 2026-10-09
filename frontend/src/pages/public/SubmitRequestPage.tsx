import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../api/http";
import { publicApi } from "../../api/opsApi";
import type { PublicRequestReceipt, TicketCategory } from "../../types/operations";
import { CATEGORIES, CATEGORY_LABELS, isEmail } from "../../utils/format";
import { ErrorNotice, formatDateTime } from "../../components/ui";
import { PublicHeader } from "./PublicHeader";

const CATEGORY_HINTS: Record<TicketCategory, string> = {
  account: "Can't sign in, locked out, password reset",
  network: "Wi-Fi drops, no internet, VPN",
  software: "Install requests, app crashes, licences",
  hardware: "Laptop, printer, lab or classroom equipment",
  critical_infrastructure: "Outage affecting many people or core systems",
};

interface FormState {
  requester_name: string;
  requester_email: string;
  category: TicketCategory | "";
  title: string;
  description: string;
  affects_many_users: boolean;
}

const EMPTY: FormState = {
  requester_name: "",
  requester_email: "",
  category: "",
  title: "",
  description: "",
  affects_many_users: false,
};

export function validateRequest(f: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  if (f.requester_name.trim().length < 2) errors.requester_name = "Enter your name.";
  if (!isEmail(f.requester_email)) errors.requester_email = "Enter a valid email address so we can reach you.";
  if (!f.category) errors.category = "Choose the kind of problem.";
  if (f.title.trim().length < 5) errors.title = "Give the problem a short summary (at least 5 characters).";
  if (f.title.trim().length > 160) errors.title = "Keep the summary under 160 characters.";
  if (f.description.trim().length < 10) errors.description = "Describe what happened (at least 10 characters).";
  return errors;
}

export default function SubmitRequestPage() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<PublicRequestReceipt | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateRequest(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await publicApi.submitRequest({
        requester_name: form.requester_name.trim(),
        requester_email: form.requester_email.trim(),
        category: form.category as TicketCategory,
        title: form.title.trim(),
        description: form.description.trim(),
        affects_many_users: form.affects_many_users,
      });
      setReceipt(result);
      setForm(EMPTY);
    } catch (err) {
      setError(
        isApiError(err) && err.status === 429
          ? new Error("Too many requests from this connection. Wait a few minutes and try again.")
          : err,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-navy-900 text-ink">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-5 py-10">
        {receipt ? (
          <section className="ot-panel" aria-live="polite">
            <h1 className="text-2xl font-semibold">Request received</h1>
            <p>
              Your reference is <strong className="ot-mono text-signal">{receipt.reference}</strong>. Keep it if you need to follow up
              with the service desk.
            </p>
            <dl className="ot-facts">
              <div>
                <dt>Submitted</dt>
                <dd>{formatDateTime(receipt.created_at)}</dd>
              </div>
              <div>
                <dt>Response target</dt>
                <dd>{formatDateTime(receipt.sla_deadline)}</dd>
              </div>
            </dl>
            <p className="text-muted">
              Next, the triage team checks the details, sets a priority and routes it to a technician. You'll be contacted at the email
              you gave.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link to={`/track?ref=${encodeURIComponent(receipt.reference)}`} className="ot-btn ot-btn-primary">
                Track this request
              </Link>
              <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setReceipt(null)}>
                Report another problem
              </button>
            </div>
          </section>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="ot-panel">
            <h1 className="text-2xl font-semibold">Report an IT problem</h1>
            <p className="text-muted">
              For students and staff. The request goes straight into the service desk queue.{" "}
              <Link to="/login" className="ot-link">
                Service desk staff sign in here.
              </Link>
            </p>
            <ErrorNotice error={error} />

            <div className="grid gap-x-4 sm:grid-cols-2">
              <label className="ot-field">
                <span>Your name</span>
                <input
                  value={form.requester_name}
                  autoComplete="name"
                  aria-invalid={!!errors.requester_name}
                  onChange={(e) => set("requester_name", e.target.value)}
                />
                {errors.requester_name && <small className="ot-field-error">{errors.requester_name}</small>}
              </label>
              <label className="ot-field">
                <span>Campus email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={form.requester_email}
                  aria-invalid={!!errors.requester_email}
                  onChange={(e) => set("requester_email", e.target.value)}
                />
                {errors.requester_email && <small className="ot-field-error">{errors.requester_email}</small>}
              </label>
            </div>

            <fieldset className="mb-4 border-0 p-0">
              <legend className="mb-2 text-sm font-medium">What kind of problem is it?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {CATEGORIES.map((c) => (
                  <label
                    key={c}
                    className={`flex cursor-pointer gap-3 rounded-md border p-3 ${form.category === c ? "border-signal bg-signal/5" : "border-line"}`}
                  >
                    <input type="radio" name="category" value={c} checked={form.category === c} onChange={() => set("category", c)} className="mt-1" />
                    <span>
                      <span className="block text-sm font-semibold">{CATEGORY_LABELS[c]}</span>
                      <span className="block text-xs text-muted">{CATEGORY_HINTS[c]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {errors.category && <small className="ot-field-error">{errors.category}</small>}
            </fieldset>

            <label className="ot-field">
              <span>Summary</span>
              <input
                value={form.title}
                maxLength={160}
                aria-invalid={!!errors.title}
                placeholder="e.g. Can't connect to campus Wi-Fi in the library"
                onChange={(e) => set("title", e.target.value)}
              />
              {errors.title && <small className="ot-field-error">{errors.title}</small>}
            </label>
            <label className="ot-field">
              <span>What happened?</span>
              <textarea
                rows={5}
                value={form.description}
                aria-invalid={!!errors.description}
                placeholder="What you were doing, any error message, where you are on campus"
                onChange={(e) => set("description", e.target.value)}
              />
              {errors.description && <small className="ot-field-error">{errors.description}</small>}
            </label>
            <label className="ot-check border-t-0">
              <input type="checkbox" checked={form.affects_many_users} onChange={(e) => set("affects_many_users", e.target.checked)} />
              <span>
                This is affecting many people
                <small>Triage reviews these first. It doesn't change your place in the queue by itself.</small>
              </span>
            </label>

            <div className="mt-4 flex justify-end">
              <button type="submit" className="ot-btn ot-btn-primary" disabled={submitting}>
                {submitting ? "Sending…" : "Send request"}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
