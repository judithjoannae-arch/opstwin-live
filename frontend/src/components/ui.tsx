import { useEffect, useId, useRef, type ReactNode } from "react";
import { isApiError } from "../api/http";
import type { AuditOutcome, ChangeRequestStatus, ConfigDiffRow } from "../api/types";

/* ---------- formatting ---------- */

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFormat.format(d);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/* ---------- layout ---------- */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ot-page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="ot-page-description">{description}</p>}
      </div>
      {actions && <div className="ot-page-actions">{actions}</div>}
    </header>
  );
}

export function FullPageStatus({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ot-fullpage" role="status">
      <div className="ot-fullpage-card">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ot-empty">
      <p className="ot-empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="ot-loading" role="status">
      {label}…
    </p>
  );
}

/* ---------- feedback ---------- */

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const ref = isApiError(error) ? error.correlationId : null;
  return (
    <div className="ot-notice ot-notice-error" role="alert">
      <p>{message}</p>
      {ref && (
        <p className="ot-notice-ref">
          Reference ID: <code>{ref}</code>
        </p>
      )}
      {onRetry && (
        <button type="button" className="ot-btn ot-btn-quiet" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "warning"; children: ReactNode }) {
  return (
    <div className={`ot-notice ot-notice-${tone}`} role={tone === "warning" ? "alert" : "status"}>
      {children}
    </div>
  );
}

const STATUS_TEXT: Record<ChangeRequestStatus | AuditOutcome, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  APPLIED: "Applied",
  EXPIRED: "Expired",
  STALE: "Stale",
  SUCCESS: "Succeeded",
  DENIED: "Denied",
  FAILURE: "Failed",
};

export function StatusBadge({ status }: { status: ChangeRequestStatus | AuditOutcome }) {
  return (
    <span className={`ot-badge ot-badge-${status.toLowerCase()}`}>
      <span className="ot-badge-mark" aria-hidden="true" />
      {STATUS_TEXT[status]}
    </span>
  );
}

/* ---------- dialog ---------- */

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`ot-dialog ot-dialog-${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="ot-dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
          {footer && <div className="ot-dialog-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/* ---------- diffs ---------- */

export function DiffTable({ rows, emptyText = "No field-level changes recorded." }: { rows: ConfigDiffRow[]; emptyText?: string }) {
  if (rows.length === 0) return <p className="ot-muted">{emptyText}</p>;
  return (
    <div className="ot-table-wrap">
      <table className="ot-table ot-diff">
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <th scope="row">
                <code>{row.path}</code>
              </th>
              <td className="ot-diff-before">
                <pre>{formatValue(row.before)}</pre>
              </td>
              <td className="ot-diff-after">
                <pre>{formatValue(row.after)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flattened before/after diff of two snapshots, e.g. from an audit record. */
export function diffSnapshots(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  prefix = "",
): ConfigDiffRow[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows: ConfigDiffRow[] = [];
  for (const key of Array.from(keys).sort()) {
    const b = before?.[key];
    const a = after?.[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(b) && isPlainObject(a)) rows.push(...diffSnapshots(b, a, path));
    else if (JSON.stringify(b) !== JSON.stringify(a)) rows.push({ path, before: b ?? null, after: a ?? null });
  }
  return rows;
}
