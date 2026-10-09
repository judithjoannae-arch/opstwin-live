/** Digital twin contract (mirrors backend/app/services/{snapshots,simulation_runs,stress_tests}.py). */
import type { DataOrigin, Priority, StageKey, TicketCategory } from "./operations";

export interface Assumption {
  key: string;
  label: string;
  value: unknown;
  unit: string;
  origin: DataOrigin;
  sample_size: number | null;
  note: string | null;
}

export interface ServiceEstimate {
  mean: number;
  cv: number;
  n: number;
  origin: DataOrigin;
}

export interface SnapshotModel {
  arrival_profile: { values: number[]; origin: DataOrigin; sample_size: number; note: string };
  category_mix: { values: Record<TicketCategory, number>; origin: DataOrigin; sample_size: number };
  priority_mix: { values: Record<TicketCategory, Partial<Record<Priority, number>>>; origin: DataOrigin };
  service_times: Record<StageKey, Record<TicketCategory, ServiceEstimate>>;
  rework_rate: { value: number; origin: DataOrigin; sample_size: number };
  transfer_rate: { value: number; origin: DataOrigin; note?: string };
  hold_mean_min: { value: number; origin: DataOrigin };
}

export interface SnapshotTicket {
  id: string;
  reference: string;
  category: TicketCategory;
  priority: Priority;
  stage: StageKey;
  status: string;
  created_at: string;
  sla_deadline: string;
  assigned_resource_id: string | null;
  is_demo: boolean;
}

export interface SnapshotResource {
  id: string;
  name: string;
  stage: StageKey;
  skills: TicketCategory[];
  is_available: boolean;
  shift_start: string;
  shift_end: string;
  is_reserve: boolean;
  reserve_active: boolean;
  is_demo: boolean;
}

export interface Snapshot {
  id: string;
  created_at: string;
  config_version: string;
  scope: string[] | null;
  ticket_count: number;
  resource_count: number;
  coverage: {
    first_ticket_at: string | null;
    days_covered: number;
    tickets_in_lookback: number;
    active_tickets: number;
    real_active_tickets: number;
    demo_active_tickets: number;
    service_samples: Record<StageKey, number>;
  };
  config: { routing?: { policy?: string; skill_aware?: boolean }; [k: string]: unknown };
  sla_resolution_minutes: Record<Priority, number>;
  model: SnapshotModel;
  assumptions: Assumption[];
  limitations: string[];
  stage_counts: Record<StageKey, { active: number; staff_available: number }>;
  tickets?: SnapshotTicket[];
  resources?: SnapshotResource[];
}

export type RoutingPolicy = "fifo" | "priority" | "smart_triage";

export interface ScenarioParameters {
  duration_hours: number;
  demand_multiplier: number;
  base_arrival_rate_per_hour: number | null;
  category_mix: Partial<Record<TicketCategory, number>> | null;
  removed_resource_ids: string[];
  resource_unavailability: { resource_id: string; from_minute: number; to_minute: number | null }[];
  activate_reserve_ids: string[];
  reallocations: { resource_id: string; to_stage: StageKey }[];
  extra_staff: Partial<Record<StageKey, number>>;
  service_time_multipliers: Partial<Record<StageKey, number>>;
  routing_policy: RoutingPolicy | null;
  skill_aware_routing: boolean | null;
  sla_resolution_minutes: Partial<Record<Priority, number>>;
  rework_rate: number | null;
  transfer_rate: number | null;
  respect_shifts: boolean;
  seed: number;
  replications: number;
}

export const DEFAULT_PARAMETERS: ScenarioParameters = {
  duration_hours: 8,
  demand_multiplier: 1,
  base_arrival_rate_per_hour: null,
  category_mix: null,
  removed_resource_ids: [],
  resource_unavailability: [],
  activate_reserve_ids: [],
  reallocations: [],
  extra_staff: {},
  service_time_multipliers: {},
  routing_policy: null,
  skill_aware_routing: null,
  sla_resolution_minutes: {},
  rework_rate: null,
  transfer_rate: null,
  respect_shifts: true,
  seed: 42,
  replications: 10,
};

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  snapshot_id: string;
  snapshot_created_at: string;
  config_version: string;
  parameters: ScenarioParameters;
  kind: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface MetricStat {
  mean: number | null;
  std: number | null;
  ci_low: number | null;
  ci_high: number | null;
  min: number | null;
  max: number | null;
  n: number;
  values: (number | null)[];
  unit: string;
}

export interface SeriesPoint {
  minute: number;
  backlog: number;
  cum_arrivals: number;
  cum_closed: number;
  queue: Partial<Record<StageKey, number>>;
  in_service: Partial<Record<StageKey, number>>;
}

export interface RunMetrics {
  replications: number;
  scalars: Record<string, MetricStat>;
  series: SeriesPoint[];
  hourly: { hour: number; arrivals: number; closed: number }[];
  unfinished_example: { ref: string; stage: StageKey; state: string; priority: Priority }[];
  notes: string[];
}

export interface SimulationRun {
  id: string;
  label: string;
  snapshot_id: string;
  snapshot_created_at: string | null;
  config_version: string | null;
  scenario_id: string | null;
  stress_test_id: string | null;
  strategy_key: string | null;
  parameters: ScenarioParameters;
  seed: number;
  replications: number;
  status: string;
  created_at: string;
  duration_ms: number;
  summary: Record<string, number | null>;
  data_origin: "simulated";
  metrics?: RunMetrics;
}

export interface StressComparisonRow {
  key: string;
  label: string;
  run_id: string;
  metrics: Record<string, MetricStat>;
  stage_mean_wait_min: Record<StageKey, number | null>;
  stage_utilization_pct: Record<StageKey, number | null>;
}

export interface StressTest {
  id: string;
  snapshot_id: string;
  created_at: string;
  settings: {
    duration_hours: number;
    demand_multiplier: number;
    replications: number;
    seed: number;
    capacity_source: string;
    transfer_count: number;
    respect_shifts: boolean;
    removed_resource: { id: string; name: string };
    donor_stage: StageKey | null;
    moved_resources: { id: string; name: string; from_stage: StageKey }[];
    activated_reserves: { id: string; name: string }[];
    capacity_strategy_available: boolean;
    labels: Record<string, string>;
  };
  comparison: { scenarios: StressComparisonRow[] };
  runs: { id: string; strategy_key: string; label: string; summary: Record<string, number | null> }[];
  data_origin: "simulated";
}

export interface StressTestRequest {
  snapshot_id?: string;
  duration_hours: number;
  demand_multiplier: number;
  replications: number;
  seed: number;
  removed_resource_id?: string;
  capacity_source: "auto" | "transfer" | "reserve";
  transfer_count: number;
  donor_stage?: "intake" | "triage" | "verification";
  respect_shifts: boolean;
}

export interface Constraints {
  min_p1_sla_compliance_pct: number;
  min_sla_compliance_pct: number;
  max_ending_backlog: number;
  min_throughput_ratio: number;
  max_mean_wait_min: number;
  max_stage_wait_increase_min: number;
  min_feasible_share: number;
  cost_per_reserve_hour: number | null;
  cost_per_transfer_hour: number | null;
}

export const DEFAULT_CONSTRAINTS: Constraints = {
  min_p1_sla_compliance_pct: 85,
  min_sla_compliance_pct: 70,
  max_ending_backlog: 30,
  min_throughput_ratio: 0.9,
  max_mean_wait_min: 240,
  max_stage_wait_increase_min: 30,
  min_feasible_share: 0.7,
  cost_per_reserve_hour: null,
  cost_per_transfer_hour: null,
};

export interface ConstraintCheck {
  key: string;
  label: string;
  kind: "min" | "max";
  limit: number;
  value: number | null;
  passed: boolean;
  pass_share: number;
  unit: string;
  message: string;
}

export interface ExpectedChange {
  metric: string;
  label: string;
  unit: string | null;
  normal_baseline: number | null;
  failure_baseline: number | null;
  strategy: number | null;
  delta_vs_failure: number | null;
  delta_pct_vs_failure: number | null;
  better: boolean | null;
  ci: [number | null, number | null];
}

export interface RecommendationCard {
  id: string;
  evaluation_id: string;
  stress_test_id: string;
  run_id: string;
  created_at: string;
  source_config_version: string;
  current_config_version: string;
  stale: boolean;
  strategy_key: string;
  title: string;
  is_no_action: boolean;
  feasible: boolean;
  pareto_efficient: boolean;
  selected: boolean;
  explanation: string;
  constraint_checks: ConstraintCheck[];
  expected_changes: ExpectedChange[];
  benefits: string[];
  drawbacks: string[];
  affected_departments: { id: StageKey; name: string }[];
  config_diff: { path: string; before: unknown; after: unknown }[];
  disruption_score: number;
  estimated_cost: number | null;
  approval_required: boolean;
  evidence: {
    stress_test_id: string;
    snapshot_id: string;
    config_version: string;
    strategy_run_id: string;
    failure_run_id: string;
    normal_run_id: string;
    replications: number;
  };
  assumptions: string[];
  uncertainty: string;
}

export interface Evaluation {
  id: string;
  stress_test_id: string;
  created_at: string;
  constraints: Constraints;
  outcome: string;
  selected_recommendation_id: string | null;
  recommendations: RecommendationCard[];
}

export interface SimEvent {
  id: string;
  scenario_key: string;
  replication: number;
  sim_minute: number;
  occurred_at: string;
  event_type: string;
  ticket_ref: string | null;
  stage: StageKey | null;
  resource_id: string | null;
  detail: string | null;
  data_origin: "simulated";
}

export interface PredictionRow {
  id: string;
  change_request_id: string;
  title: string | null;
  affected_departments: string[];
  strategy_key: string;
  run_id: string;
  effective_at: string;
  horizon_hours: number;
  predicted: Record<string, unknown>;
  assumption_notes: string[];
  status: "compared" | "insufficient_data";
  observed_window_hours: number;
  metrics: {
    metric: string;
    label: string;
    unit: string;
    predicted: number | null;
    observed: number | null;
    error: number | null;
    error_pct: number | null;
    comparable: boolean;
    note: string | null;
  }[];
  notes: string[];
  disclaimer: string;
}

export interface SensitivityResult {
  snapshot_id: string;
  parameter: "demand" | "service_time" | "staff";
  replications: number;
  results: { value: number; summary: Record<string, number | null>; ci: Record<string, [number | null, number | null]> }[];
  data_origin: "simulated";
}
