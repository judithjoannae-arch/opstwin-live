import type { ReactNode } from "react";
import type { DataOrigin } from "../types/operations";
import { INSUFFICIENT_DATA } from "../utils/format";
import { DataLabel } from "./DataLabel";

/**
 * One labelled metric. When the backend returns null there isn't enough
 * recorded data, and the UI says so instead of showing a made-up number.
 */
export function MetricValue({
  label,
  value,
  origin,
  hint,
  emphasis = false,
}: {
  label: string;
  value: ReactNode | null;
  origin: DataOrigin;
  hint?: ReactNode;
  emphasis?: boolean;
}) {
  const missing = value === null || value === undefined;
  return (
    <div className="min-w-0">
      <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {label}
        <DataLabel origin={origin} />
      </dt>
      <dd className="m-0 mt-1">
        {missing ? (
          <span className="text-sm text-muted">{INSUFFICIENT_DATA}</span>
        ) : (
          <span className={emphasis ? "text-2xl font-semibold tabular-nums text-ink" : "text-lg font-semibold tabular-nums text-ink"}>
            {value}
          </span>
        )}
        {hint && !missing && <span className="ml-2 text-xs text-muted">{hint}</span>}
      </dd>
    </div>
  );
}
