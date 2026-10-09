import { useEffect, useState } from "react";
import { aiApi } from "../../api/aiApi";
import { ticketsApi } from "../../api/opsApi";
import type { Classification } from "../../types/ai";
import type { TicketCategory, TicketDetail } from "../../types/operations";
import { CATEGORIES, CATEGORY_LABELS, isEmail } from "../../utils/format";
import { AiBadge } from "../../components/AiBadge";
import { PriorityExplanation } from "../../components/PriorityExplanation";
import { Dialog, ErrorNotice } from "../../components/ui";

interface Draft {
  title: string;
  description: string;
  category: TicketCategory | "";
  affects_many_users: boolean;
  requester_name: string;
  requester_email: string;
}

const EMPTY: Draft = { title: "", description: "", category: "", affects_many_users: false, requester_name: "", requester_email: "" };

function validate(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (d.title.trim().length < 5) e.title = "At least 5 characters.";
  if (d.title.trim().length > 160) e.title = "Under 160 characters.";
  if (d.description.trim().length < 10) e.description = "At least 10 characters.";
  if (!d.category) e.category = "Choose a category.";
  if (d.requester_name.trim().length < 2) e.requester_name = "Enter the requester's name.";
  if (!isEmail(d.requester_email)) e.requester_email = "Enter a valid email.";
  return e;
}

/**
 * Staff-side ticket creation (phone or walk-up requests). There is no priority field:
 * the server calculates priority from impact and urgency so it's the same for everyone.
 */
export default function CreateTicketDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: TicketDetail) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ai, setAi] = useState<Classification | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Ask the triage model while the summary is typed (debounced).
  useEffect(() => {
    if (!open || draft.title.trim().length < 6) {
      setAi(null);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      aiApi.classify(draft.title, draft.description, draft.affects_many_users, c.signal).then(setAi).catch(() => setAi(null));
    }, 400);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [open, draft.title, draft.description, draft.affects_many_users]);

  const submit = async () => {
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      const created = await ticketsApi.create({
        title: draft.title.trim(),
        description: draft.description.trim(),
        category: draft.category as TicketCategory,
        affects_many_users: draft.affects_many_users,
        requester_name: draft.requester_name.trim(),
        requester_email: draft.requester_email.trim(),
      });
      setDraft(EMPTY);
      onCreated(created);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New ticket"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ot-btn ot-btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create ticket"}
          </button>
        </>
      }
    >
      <p className="text-muted">
        The ticket starts at Request intake and appears in the next twin snapshot. Its priority is calculated automatically from
        impact and urgency.
      </p>
      {ai && (
        <div className="mb-3 rounded-md border border-signal/40 bg-signal/5 px-3 py-2 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <AiBadge />
            <span>
              Reads as <strong>{CATEGORY_LABELS[ai.category.label]}</strong> ({Math.round(ai.category.confidence * 100)}%)
            </span>
            {draft.category !== ai.category.label && (
              <button type="button" className="ot-btn ot-btn-quiet ml-auto" onClick={() => set("category", ai.category.label)}>
                Use this category
              </button>
            )}
          </div>
          <div className="mt-2">
            <span className="text-xs text-muted">Priority it will get:</span>
            <PriorityExplanation a={ai.priority} compact />
          </div>
        </div>
      )}
      <ErrorNotice error={error} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="ot-field">
          <span>Requester name</span>
          <input value={draft.requester_name} aria-invalid={!!errors.requester_name} onChange={(e) => set("requester_name", e.target.value)} />
          {errors.requester_name && <small className="ot-field-error">{errors.requester_name}</small>}
        </label>
        <label className="ot-field">
          <span>Requester email</span>
          <input type="email" value={draft.requester_email} aria-invalid={!!errors.requester_email} onChange={(e) => set("requester_email", e.target.value)} />
          {errors.requester_email && <small className="ot-field-error">{errors.requester_email}</small>}
        </label>
        <label className="ot-field">
          <span>Category</span>
          <select value={draft.category} aria-invalid={!!errors.category} onChange={(e) => set("category", e.target.value as TicketCategory | "")}>
            <option value="">Choose…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          {errors.category && <small className="ot-field-error">{errors.category}</small>}
        </label>
        <label className="ot-check border-t-0 pt-6">
          <input type="checkbox" checked={draft.affects_many_users} onChange={(e) => set("affects_many_users", e.target.checked)} />
          <span>
            Affects many people
            <small>Raises the impact, which the priority is calculated from.</small>
          </span>
        </label>
      </div>
      <label className="ot-field">
        <span>Summary</span>
        <input value={draft.title} maxLength={160} aria-invalid={!!errors.title} onChange={(e) => set("title", e.target.value)} />
        {errors.title && <small className="ot-field-error">{errors.title}</small>}
      </label>
      <label className="ot-field">
        <span>Description</span>
        <textarea rows={4} value={draft.description} aria-invalid={!!errors.description} onChange={(e) => set("description", e.target.value)} />
        {errors.description && <small className="ot-field-error">{errors.description}</small>}
      </label>
    </Dialog>
  );
}
