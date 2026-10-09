import { apiRequest } from "./http";
import type { AiPredictionRow, AiSettings, Classification, ModelCard, MonitorRun, TriageAdvice } from "../types/ai";

const enc = encodeURIComponent;

export const aiApi = {
  classify: (title: string, description: string, affectsMany: boolean, signal?: AbortSignal) =>
    apiRequest<Classification>("/ai/classify", { method: "POST", body: { title, description, affects_many_users: affectsMany }, signal }),
  triage: (ticketId: string, signal?: AbortSignal) => apiRequest<TriageAdvice>(`/ai/triage/${enc(ticketId)}`, { signal }),
  model: (signal?: AbortSignal) => apiRequest<ModelCard>("/ai/model", { signal }),
  retrain: () => apiRequest<ModelCard>("/ai/model/retrain", { method: "POST" }),
  settings: (signal?: AbortSignal) => apiRequest<AiSettings>("/ai/settings", { signal }),
  saveSettings: (body: Omit<AiSettings, "updated_at">) => apiRequest<AiSettings>("/ai/settings", { method: "PUT", body }),
  predictions: (signal?: AbortSignal) => apiRequest<AiPredictionRow[]>("/ai/predictions", { query: { limit: 30 }, signal }),
  monitorRuns: (signal?: AbortSignal) => apiRequest<MonitorRun[]>("/ai/monitor/runs", { query: { limit: 20 }, signal }),
  runMonitor: () => apiRequest<MonitorRun & { change_request_status: string | null }>("/ai/monitor/check", { method: "POST" }),
};
