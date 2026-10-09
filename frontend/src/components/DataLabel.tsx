import type { DataOrigin } from "../types/operations";
import { ORIGIN_DESCRIPTIONS, ORIGIN_LABELS } from "../utils/format";

const ORIGIN_STYLES: Record<DataOrigin, string> = {
  observed: "border-signal/60 text-signal",
  synthetic: "border-dashed border-warn/70 text-warn",
  assumed: "border-muted/60 text-muted",
  simulated: "border-sim/70 text-sim",
  derived: "border-teal-300/50 text-teal-200",
};

/** Provenance tag: where a number or record came from (spec §13). */
export function DataLabel({ origin, className = "" }: { origin: DataOrigin; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium leading-4 ${ORIGIN_STYLES[origin]} ${className}`}
      title={ORIGIN_DESCRIPTIONS[origin]}
    >
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

/** Marks synthetic seed records so they're never mistaken for real tickets. */
export function DemoTag() {
  return (
    <span
      className="ml-2 inline-flex items-center rounded border border-dashed border-warn/70 px-1.5 py-px text-[11px] font-medium leading-4 text-warn"
      title="Synthetic sample record from the demonstration seed data"
    >
      Demo
    </span>
  );
}
