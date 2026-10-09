import type { MetricStat } from "../types/twin";

/** Colour per stress-test strategy. Failure is red; the rest stay distinguishable on navy. */
export const STRATEGY_COLORS: Record<string, string> = {
  A: "#8da2b7",
  B: "#ef6458",
  C: "#a78bfa",
  D: "#f0b13c",
  E: "#2cc0d3",
};
const FALLBACK = ["#7dd3a8", "#f472b6", "#93c5fd", "#fcd34d", "#c4b5fd"];

export function strategyColor(key: string | null | undefined, index = 0): string {
  return (key && STRATEGY_COLORS[key]) || FALLBACK[index % FALLBACK.length];
}

export const STRATEGY_NAMES: Record<string, string> = {
  A: "Normal baseline",
  B: "Unmitigated failure",
  C: "Smart triage",
  D: "Capacity reallocation",
  E: "Combined strategy",
};

export interface MetricInfo {
  label: string;
  unit: string;
  /** 1 higher is better, -1 lower is better, 0 neutral. */
  direction: 1 | -1 | 0;
  digits: number;
}

export const METRICS: Record<string, MetricInfo> = {
  throughput_per_hour: { label: "Completed per hour", unit: "/h", direction: 1, digits: 2 },
  mean_wait_min: { label: "Mean wait", unit: "min", direction: -1, digits: 1 },
  p95_wait_min: { label: "95th percentile wait", unit: "min", direction: -1, digits: 0 },
  max_backlog: { label: "Peak backlog", unit: "tickets", direction: -1, digits: 1 },
  ending_backlog: { label: "Backlog at the end", unit: "tickets", direction: -1, digits: 1 },
  sla_compliance_pct: { label: "SLA compliance", unit: "%", direction: 1, digits: 1 },
  sla_violations: { label: "SLA violations", unit: "tickets", direction: -1, digits: 1 },
  p1_sla_compliance_pct: { label: "Critical (P1) SLA compliance", unit: "%", direction: 1, digits: 1 },
  p1_mean_wait_min: { label: "Critical (P1) mean wait", unit: "min", direction: -1, digits: 1 },
  unfinished: { label: "Unfinished at the horizon", unit: "tickets", direction: -1, digits: 1 },
  recovery_time_min: { label: "Recovery time", unit: "min", direction: -1, digits: 0 },
  arrivals: { label: "New requests", unit: "tickets", direction: 0, digits: 1 },
  completed: { label: "Completed", unit: "tickets", direction: 1, digits: 1 },
  transfers: { label: "Misrouted and transferred", unit: "tickets", direction: -1, digits: 1 },
  reworks: { label: "Reworked after verification", unit: "tickets", direction: -1, digits: 1 },
  escalations: { label: "Priority escalations", unit: "tickets", direction: -1, digits: 1 },
};

export function metricInfo(name: string): MetricInfo {
  return METRICS[name] ?? { label: name, unit: "", direction: 0, digits: 1 };
}

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtStat(stat: MetricStat | undefined, digits = 1): string {
  return stat ? fmt(stat.mean, digits) : "—";
}

/** "±1.2" half-width of the 95 % interval, or empty when there's no spread. */
export function ciHalf(stat: MetricStat | undefined, digits = 1): string {
  if (!stat || stat.ci_low === null || stat.ci_high === null || stat.n < 2) return "";
  const half = (stat.ci_high - stat.ci_low) / 2;
  return half > 0 ? `±${fmt(half, digits)}` : "";
}

/** Is `value` better than `reference` for this metric? null when not comparable. */
export function isBetter(name: string, value: number | null | undefined, reference: number | null | undefined): boolean | null {
  const info = metricInfo(name);
  if (info.direction === 0 || value == null || reference == null || Math.abs(value - reference) < 1e-9) return null;
  return (value - reference) * info.direction > 0;
}

export function minutesLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
