/**
 * Live operational data contract (campus IT service desk).
 *
 * Departments are the four workflow stages. A department's id is its stage
 * key, so department-scoped permissions use the same values as ticket.stage
 * and resource.stage.
 */
import type { PersonRef } from "../api/types";

export type StageKey = "intake" | "triage" | "support" | "verification";
export type TicketCategory = "account" | "network" | "software" | "hardware" | "critical_infrastructure";
export type Priority = "P1" | "P2" | "P3" | "P4";
export type TicketStatus = "open" | "in_progress" | "on_hold" | "resolved" | "closed" | "cancelled";
/** on_track/at_risk/breached for open work; met/missed once resolved. */
export type SlaState = "on_track" | "at_risk" | "breached" | "met" | "missed";
/** Provenance label required by the master spec §13. */
export type DataOrigin = "observed" | "synthetic" | "assumed" | "simulated" | "derived";
export type BottleneckLevel = "none" | "watch" | "bottleneck";

export interface ResourceRef {
  id: string;
  name: string;
}

export interface Ticket {
  id: string;
  /** Human-readable unique ID, e.g. "TCK-000123". */
  reference: string;
  title: string;
  category: TicketCategory;
  priority: Priority;
  stage: StageKey;
  status: TicketStatus;
  requester_name: string;
  created_at: string;
  updated_at: string;
  sla_deadline: string;
  sla_state: SlaState;
  assigned_resource: ResourceRef | null;
  /** Synthetic seed data, shown with a Demo label. */
  is_demo: boolean;
  resolved_at: string | null;
  closed_at: string | null;
  /** Optimistic-concurrency version; send back on PATCH. */
  version: number;
}

export interface TicketEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  actor: PersonRef | null;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
}

export interface TicketDetail extends Ticket {
  description: string;
  requester_email: string;
  history: TicketEvent[];
}

export interface TicketQuery {
  q?: string;
  stage?: string;
  /** Comma-separated statuses. */
  status?: string;
  priority?: string;
  category?: string;
  sla_state?: string;
  /** "me" or "unassigned". */
  assigned?: string;
  sort?: "created_desc" | "deadline_asc";
  page?: number;
  page_size?: number;
}

export interface TicketCreate {
  title: string;
  description: string;
  category: TicketCategory;
  /** A fact about the problem. Priority itself is calculated by the server (impact x urgency). */
  affects_many_users: boolean;
  requester_name: string;
  requester_email: string;
}

export interface TicketUpdate {
  version: number;
  /** Correctable during intake and triage only. */
  category?: TicketCategory;
  stage?: StageKey;
  status?: TicketStatus;
  assigned_resource_id?: string | null;
  note?: string;
}

export interface PublicRequestCreate {
  requester_name: string;
  requester_email: string;
  category: TicketCategory;
  title: string;
  description: string;
  affects_many_users: boolean;
}

export interface PublicRequestReceipt {
  reference: string;
  created_at: string;
  sla_deadline: string;
}

export interface Resource {
  id: string;
  name: string;
  /** Home stage (department). */
  stage: StageKey;
  skills: TicketCategory[];
  is_available: boolean;
  availability_reason: string | null;
  /** "HH:MM", campus local time. */
  shift_start: string;
  shift_end: string;
  /** Reserve capacity that may be activated through an approved change. */
  is_reserve: boolean;
  /** Reserve capacity switched on by an approved change. */
  reserve_active: boolean;
  active_ticket_count: number;
  is_demo: boolean;
  version: number;
}

export interface ResourceQuery {
  stage?: string;
  available?: boolean;
  skill?: string;
}

export interface ResourceCreate {
  name: string;
  stage: StageKey;
  skills: TicketCategory[];
  shift_start: string;
  shift_end: string;
  is_reserve: boolean;
}

export interface ResourceUpdate {
  version: number;
  name?: string;
  stage?: StageKey;
  skills?: TicketCategory[];
  shift_start?: string;
  shift_end?: string;
  is_reserve?: boolean;
  is_available?: boolean;
  availability_reason?: string | null;
}

/** Observed state of one workflow stage. Null means insufficient data. */
export interface StageState {
  stage: StageKey;
  queue: number;
  in_service: number;
  on_hold: number;
  available_resources: number;
  total_resources: number;
  /** Derived from recorded completions in the window. */
  completed_per_hour: number | null;
  avg_wait_minutes: number | null;
  sla_at_risk: number;
  sla_breached: number;
  utilization_pct: number | null;
  bottleneck: BottleneckLevel;
  bottleneck_reason: string | null;
}

export interface ThroughputPoint {
  /** Start of the hour, ISO. */
  hour: string;
  created: number;
  completed: number;
}

export interface OperationalEvent {
  id: string;
  occurred_at: string;
  event_type: string;
  ticket_id: string | null;
  ticket_reference: string | null;
  stage: StageKey | null;
  resource_id: string | null;
  resource_name: string | null;
  actor: PersonRef | null;
  summary: string;
  is_demo: boolean;
}

export interface OperationsState {
  generated_at: string;
  config_version: string;
  latest_snapshot: { id: string; created_at: string; config_version: string } | null;
  data_coverage: {
    first_ticket_at: string | null;
    last_event_at: string | null;
    real_ticket_count: number;
    demo_ticket_count: number;
  };
  totals: {
    submitted: number;
    open: number;
    in_progress: number;
    on_hold: number;
    resolved: number;
    closed: number;
    overdue: number;
  };
  stages: StageState[];
  /** available = on shift now and not marked unavailable. */
  staff: { available: number; unavailable: number; off_shift: number; total: number };
  throughput: {
    window_hours: number;
    completed: number;
    per_hour: number | null;
    series: ThroughputPoint[];
  };
  sla: { compliance_pct: number | null; evaluated: number; breached: number };
  oldest_unresolved: { id: string; reference: string; created_at: string; stage: StageKey } | null;
  recent_events: OperationalEvent[];
}

export interface EventQuery {
  event_type?: string;
  stage?: string;
  ticket?: string;
  occurred_from?: string;
  occurred_to?: string;
  cursor?: string;
  page_size?: number;
}

export interface SlaPolicy {
  priority: Priority;
  response_minutes: number;
  resolution_minutes: number;
}

export interface SlaPolicySet {
  config_version: string;
  policies: SlaPolicy[];
  updated_at: string;
  updated_by: PersonRef | null;
}

export interface ConfigVersion {
  version: string;
  created_at: string;
  created_by: PersonRef | null;
  source: "seed" | "manual" | "approved_change";
  summary: string;
  change_request_id: string | null;
}
