import type { Priority, TicketCategory } from "./operations";

export interface RankedLabel<T extends string> {
  label: T;
  confidence: number;
}

/** Priority is calculated (impact x urgency), never predicted by the model or chosen by a person. */
export interface PriorityAssessment {
  priority: Priority;
  impact: "low" | "medium" | "high";
  urgency: "low" | "medium" | "high";
  reasons: string[];
  affects_many_users: boolean;
  method: string;
  recorded?: boolean;
}

export interface Classification {
  model_version: number;
  category: { label: TicketCategory; confidence: number; evidence: string[]; ranking: RankedLabel<TicketCategory>[] };
  priority: PriorityAssessment;
}

export interface TriageAdvice extends Classification {
  current_category: TicketCategory;
  category_mismatch: boolean;
  submitted_category: TicketCategory;
  automatic_action: "suggested" | "auto_applied" | "left_for_human" | null;
  suggested_technician: { id: string; name: string; active_tickets: number; reason: string } | null;
  priority_assessment: PriorityAssessment;
}

export interface AiSettings {
  auto_intake: boolean;
  category_threshold: number;
  priority_threshold: number;
  monitor_enabled: boolean;
  monitor_interval_minutes: number;
  surge_threshold: number;
  updated_at: string;
}

export interface ModelCard {
  version: number;
  trained_at: string;
  trigger: string;
  algorithm: string;
  priority_method: string;
  starter_examples: number;
  history_examples: number;
  vocabulary: number;
  cross_validated: { category_accuracy_pct: number | null };
  observed: {
    reviewed: number;
    category_accuracy_pct: number | null;
    mislabelled_by_requester: number;
    mislabels_caught_by_ai: number;
  };
  notes: string[];
}

export interface AiPredictionRow {
  id: number;
  created_at: string;
  ticket_id: string;
  ticket_reference: string;
  title: string;
  submitted_category: TicketCategory;
  predicted_category: TicketCategory;
  category_confidence: number;
  predicted_priority: Priority;
  priority_confidence: number;
  action: "suggested" | "auto_applied" | "left_for_human";
  current_category: TicketCategory;
  current_priority: Priority;
  reviewed: boolean;
}

export type MonitorOutcome = "healthy" | "risk_recommended" | "risk_no_safe_option" | "risk_resolves" | "skipped" | "error";

export interface MonitorRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: "scheduled" | "manual";
  outcome: MonitorOutcome;
  summary: string;
  findings: { recent_rate?: number; expected_rate?: number; surge?: number; bottlenecks?: string[]; watch?: string[]; overdue?: number };
  snapshot_id: string | null;
  stress_test_id: string | null;
  evaluation_id: string | null;
  change_request_id: string | null;
}
