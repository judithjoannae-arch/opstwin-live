import { API_BASE_URL, apiRequest, type QueryParams } from "./http";
import type { Page } from "./types";
import type {
  Constraints,
  Evaluation,
  PredictionRow,
  RecommendationCard,
  RunMetrics,
  Scenario,
  ScenarioParameters,
  SensitivityResult,
  SimEvent,
  SimulationRun,
  Snapshot,
  StressTest,
  StressTestRequest,
} from "../types/twin";

const enc = encodeURIComponent;

export const twinApi = {
  createSnapshot: () => apiRequest<Snapshot>("/twin/snapshots", { method: "POST" }),
  snapshots: (limit = 20, signal?: AbortSignal) => apiRequest<Snapshot[]>("/twin/snapshots", { query: { limit }, signal }),
  snapshot: (id: string, signal?: AbortSignal) => apiRequest<Snapshot>(`/twin/snapshots/${enc(id)}`, { signal }),

  scenarios: (snapshotId?: string, signal?: AbortSignal) =>
    apiRequest<Scenario[]>("/scenarios", { query: { snapshot_id: snapshotId }, signal }),
  createScenario: (body: { name: string; description?: string | null; snapshot_id: string; parameters: ScenarioParameters }) =>
    apiRequest<Scenario>("/scenarios", { method: "POST", body }),
  updateScenario: (id: string, body: { version: number; name?: string; description?: string | null; parameters?: ScenarioParameters }) =>
    apiRequest<Scenario>(`/scenarios/${enc(id)}`, { method: "PATCH", body }),
  cloneScenario: (id: string, body: { name?: string; snapshot_id?: string }) =>
    apiRequest<Scenario>(`/scenarios/${enc(id)}/clone`, { method: "POST", body }),

  runScenario: (scenarioId: string) => apiRequest<SimulationRun>("/simulations/run", { method: "POST", body: { scenario_id: scenarioId } }),
  runAdHoc: (snapshotId: string, parameters: Partial<ScenarioParameters>, label: string) =>
    apiRequest<SimulationRun>("/simulations/run", { method: "POST", body: { snapshot_id: snapshotId, parameters, label } }),
  runs: (query: { snapshot_id?: string; stress_test_id?: string; limit?: number }, signal?: AbortSignal) =>
    apiRequest<SimulationRun[]>("/simulations", { query: query as QueryParams, signal }),
  run: (id: string, signal?: AbortSignal) => apiRequest<SimulationRun>(`/simulations/${enc(id)}`, { signal }),
  metrics: (id: string, signal?: AbortSignal) => apiRequest<RunMetrics>(`/simulations/${enc(id)}/metrics`, { signal }),
  events: (id: string, query: { event_type?: string; stage?: string; ticket?: string; cursor?: string; page_size?: number }, signal?: AbortSignal) =>
    apiRequest<Page<SimEvent> & { note: string }>(`/simulations/${enc(id)}/events`, { query: query as QueryParams, signal }),
  sensitivity: (body: { snapshot_id: string; parameter: "demand" | "service_time" | "staff"; values: number[]; base?: Partial<ScenarioParameters> }) =>
    apiRequest<SensitivityResult>("/simulations/sensitivity", { method: "POST", body }),

  stressTest: (body: StressTestRequest) => apiRequest<StressTest>("/simulations/stress-test", { method: "POST", body }),
  stressTests: (limit = 20, signal?: AbortSignal) => apiRequest<StressTest[]>("/stress-tests", { query: { limit }, signal }),
  stressTestById: (id: string, signal?: AbortSignal) => apiRequest<StressTest>(`/stress-tests/${enc(id)}`, { signal }),

  evaluate: (stressTestId: string, constraints: Constraints) =>
    apiRequest<Evaluation>("/recommendations/evaluate", { method: "POST", body: { stress_test_id: stressTestId, constraints } }),
  evaluations: (stressTestId?: string, signal?: AbortSignal) =>
    apiRequest<Evaluation[]>("/recommendations", { query: { stress_test_id: stressTestId }, signal }),
  recommendation: (id: string, signal?: AbortSignal) => apiRequest<RecommendationCard>(`/recommendations/${enc(id)}`, { signal }),

  predictionMonitor: (signal?: AbortSignal) => apiRequest<PredictionRow[]>("/prediction-monitor", { signal }),
};

/** Same-origin download links: the session cookie authorises them. */
export function reportUrl(runId: string, format: "json" | "csv"): string {
  return `${API_BASE_URL}/reports/${enc(runId)}/export?format=${format}`;
}

export function stressReportUrl(stressTestId: string): string {
  return `${API_BASE_URL}/reports/stress-tests/${enc(stressTestId)}/export`;
}
