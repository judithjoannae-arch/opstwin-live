import type { PriorityAssessment } from "../types/ai";
import { PRIORITY_LABELS } from "../utils/format";

const LEVEL = { low: "Low", medium: "Medium", high: "High" } as const;

/** Shows how a priority was calculated. There is deliberately no way to change it by hand. */
export function PriorityExplanation({ a, compact = false }: { a: PriorityAssessment; compact?: boolean }) {
  return (
    <div>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <strong>{PRIORITY_LABELS[a.priority]}</strong>
        <span className="text-xs text-muted">
          Impact {LEVEL[a.impact].toLowerCase()} × urgency {LEVEL[a.urgency].toLowerCase()}
        </span>
      </p>
      {!compact && (
        <ul className="m-0 mt-1 list-none p-0 text-xs text-muted">
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
