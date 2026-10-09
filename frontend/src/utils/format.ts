import type {
  BottleneckLevel,
  DataOrigin,
  Priority,
  SlaState,
  StageKey,
  TicketCategory,
  TicketStatus,
} from "../types/operations";

export const STAGES: StageKey[] = ["intake", "triage", "support", "verification"];

export const STAGE_LABELS: Record<StageKey, string> = {
  intake: "Request intake",
  triage: "Triage",
  support: "Technical support",
  verification: "Verification and closure",
};

export const CATEGORIES: TicketCategory[] = ["account", "network", "software", "hardware", "critical_infrastructure"];

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  account: "Account and password",
  network: "Wi-Fi and network",
  software: "Software and applications",
  hardware: "Hardware",
  critical_infrastructure: "Critical infrastructure",
};

export const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: "P1 Critical",
  P2: "P2 High",
  P3: "P3 Medium",
  P4: "P4 Low",
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  on_hold: "On hold",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const SLA_LABELS: Record<SlaState, string> = {
  on_track: "On track",
  at_risk: "At risk",
  breached: "Breached",
  met: "Met",
  missed: "Missed",
};

export const BOTTLENECK_LABELS: Record<BottleneckLevel, string> = {
  none: "Flowing",
  watch: "Watch",
  bottleneck: "Bottleneck",
};

export const ORIGIN_LABELS: Record<DataOrigin, string> = {
  observed: "Observed",
  synthetic: "Synthetic",
  assumed: "Assumed",
  simulated: "Simulated",
  derived: "Derived",
};

export const ORIGIN_DESCRIPTIONS: Record<DataOrigin, string> = {
  observed: "Read from records stored by this application.",
  synthetic: "Generated sample data for the demonstration environment.",
  assumed: "A configured value used where no measurement exists.",
  simulated: "Predicted by the digital twin. Not a real outcome.",
  derived: "Calculated from recorded or simulated data.",
};

export const INSUFFICIENT_DATA = "Insufficient operational data";

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** 95 → "1 h 35 min", 3000 → "2 d 2 h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`;
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

/** "in 2 h", "35 min ago". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMin = Math.round((t - now) / 60_000);
  if (Math.abs(diffMin) < 1) return "now";
  return diffMin > 0 ? `in ${formatMinutes(diffMin)}` : `${formatMinutes(-diffMin)} ago`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const hourFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

export function formatClock(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "—" : timeFormat.format(d);
}

/** "14:05" or "02:05 PM", depending on locale. */
export function formatShortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : shortTimeFormat.format(d);
}

export function formatHour(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : hourFormat.format(d);
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
