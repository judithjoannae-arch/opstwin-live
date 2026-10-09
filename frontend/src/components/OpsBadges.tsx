import type { BottleneckLevel, Priority, SlaState, StageKey, TicketStatus } from "../types/operations";
import { BOTTLENECK_LABELS, PRIORITY_LABELS, SLA_LABELS, STAGE_LABELS, STATUS_LABELS } from "../utils/format";

const PRIORITY_STYLES: Record<Priority, string> = {
  P1: "bg-bad/15 text-bad border-bad/50",
  P2: "bg-warn/10 text-warn border-warn/50",
  P3: "bg-signal/10 text-signal border-signal/40",
  P4: "bg-transparent text-muted border-line",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-px text-xs font-semibold ${PRIORITY_STYLES[priority]}`}>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

const SLA_STYLES: Record<SlaState, { text: string; mark: string }> = {
  on_track: { text: "text-ok", mark: "rounded-full" },
  met: { text: "text-ok", mark: "rounded-sm" },
  at_risk: { text: "text-warn", mark: "rounded-full" },
  breached: { text: "text-bad", mark: "rotate-45" },
  missed: { text: "text-bad", mark: "rotate-45" },
};

/** Colour plus shape plus text, so state never relies on colour alone. */
export function SlaBadge({ state }: { state: SlaState }) {
  const s = SLA_STYLES[state];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold ${s.text}`}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 bg-current ${s.mark}`} />
      {SLA_LABELS[state]}
    </span>
  );
}

export function StatusText({ status }: { status: TicketStatus }) {
  const tone =
    status === "closed" || status === "resolved" ? "text-ok" : status === "cancelled" ? "text-muted" : status === "on_hold" ? "text-warn" : "text-ink";
  return <span className={`whitespace-nowrap text-sm ${tone}`}>{STATUS_LABELS[status]}</span>;
}

export function StageText({ stage }: { stage: StageKey }) {
  return <span className="whitespace-nowrap text-sm">{STAGE_LABELS[stage]}</span>;
}

const BOTTLENECK_STYLES: Record<BottleneckLevel, string> = {
  none: "border-line text-muted",
  watch: "border-warn/60 text-warn",
  bottleneck: "border-bad/70 bg-bad/10 text-bad",
};

export function BottleneckPill({ level }: { level: BottleneckLevel }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-px text-xs font-semibold ${BOTTLENECK_STYLES[level]}`}>
      {BOTTLENECK_LABELS[level]}
    </span>
  );
}
