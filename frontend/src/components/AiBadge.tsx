/** Marks machine-learning output. AI suggestions are advice unless automation is switched on. */
export function AiBadge({ label = "AI" }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center rounded border border-signal/60 bg-signal/10 px-1.5 py-px text-[11px] font-semibold leading-4 text-signal"
      title="Prediction from the locally trained triage model"
    >
      {label}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.75 ? "bg-ok" : value >= 0.5 ? "bg-warn" : "bg-bad";
  return (
    <span className="inline-flex items-center gap-2" title={`${pct}% confident`}>
      <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums text-muted">{pct}%</span>
    </span>
  );
}
