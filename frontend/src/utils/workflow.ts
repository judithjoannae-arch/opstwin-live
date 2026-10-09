import type { StageKey, Ticket, TicketStatus } from "../types/operations";
import { STAGES } from "./format";

/**
 * Ticket lifecycle used to offer actions in the UI. The backend validates
 * every transition (and the actor's permission and scope) independently.
 *
 * intake → triage → support → verification → closed
 *                      ↑______rework______|
 */
export interface WorkflowAction {
  key: string;
  label: string;
  to: { stage: StageKey; status: TicketStatus };
  /** A note is mandatory (reason, resolution details). */
  noteLabel: string | null;
  requiresAssignee: boolean;
  tone: "primary" | "quiet" | "danger";
}

const ACTIONS: Record<string, WorkflowAction[]> = {
  "intake:open": [
    { key: "send_to_triage", label: "Send to triage", to: { stage: "triage", status: "open" }, noteLabel: null, requiresAssignee: false, tone: "primary" },
  ],
  "triage:open": [
    { key: "route_to_support", label: "Route to technical support", to: { stage: "support", status: "open" }, noteLabel: null, requiresAssignee: false, tone: "primary" },
    { key: "cancel", label: "Cancel request", to: { stage: "triage", status: "cancelled" }, noteLabel: "Why is this request being cancelled?", requiresAssignee: false, tone: "danger" },
  ],
  "support:open": [
    { key: "start_work", label: "Start work", to: { stage: "support", status: "in_progress" }, noteLabel: null, requiresAssignee: true, tone: "primary" },
  ],
  "support:in_progress": [
    { key: "resolve", label: "Mark resolved", to: { stage: "verification", status: "resolved" }, noteLabel: "Resolution details", requiresAssignee: true, tone: "primary" },
    { key: "hold", label: "Put on hold", to: { stage: "support", status: "on_hold" }, noteLabel: "What is the ticket waiting for?", requiresAssignee: false, tone: "quiet" },
  ],
  "support:on_hold": [
    { key: "resume", label: "Resume work", to: { stage: "support", status: "in_progress" }, noteLabel: null, requiresAssignee: true, tone: "primary" },
  ],
  "verification:resolved": [
    { key: "close", label: "Verify and close", to: { stage: "verification", status: "closed" }, noteLabel: null, requiresAssignee: false, tone: "primary" },
    { key: "rework", label: "Send back for rework", to: { stage: "support", status: "open" }, noteLabel: "What still needs fixing?", requiresAssignee: false, tone: "quiet" },
  ],
};

export function availableActions(ticket: Pick<Ticket, "stage" | "status">): WorkflowAction[] {
  return ACTIONS[`${ticket.stage}:${ticket.status}`] ?? [];
}

/** Still in the workflow: "resolved" tickets are waiting in Verification. */
export function isActive(status: TicketStatus): boolean {
  return status === "open" || status === "in_progress" || status === "on_hold" || status === "resolved";
}

export const ACTIVE_STATUSES = "open,in_progress,on_hold,resolved";

export interface StageEdge {
  from: StageKey;
  to: StageKey;
  kind: "flow" | "rework";
}

export const STAGE_EDGES: StageEdge[] = [
  { from: "intake", to: "triage", kind: "flow" },
  { from: "triage", to: "support", kind: "flow" },
  { from: "support", to: "verification", kind: "flow" },
  { from: "verification", to: "support", kind: "rework" },
];

/** Stages that receive work after `stage` in the forward flow. */
export function downstreamOf(stage: StageKey): StageKey[] {
  return STAGES.slice(STAGES.indexOf(stage) + 1);
}

/** Stages whose work is delayed when any stage in `overloaded` backs up. */
export function propagationPath(overloaded: StageKey[]): Set<StageKey> {
  const affected = new Set<StageKey>();
  for (const s of overloaded) downstreamOf(s).forEach((d) => affected.add(d));
  return affected;
}
