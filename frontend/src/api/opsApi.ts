import { apiRequest, type QueryParams } from "./http";
import type { Page } from "./types";
import type {
  ConfigVersion,
  EventQuery,
  OperationalEvent,
  OperationsState,
  PublicRequestCreate,
  PublicRequestReceipt,
  Resource,
  ResourceCreate,
  ResourceQuery,
  ResourceUpdate,
  SlaPolicy,
  SlaPolicySet,
  Ticket,
  TicketCreate,
  TicketDetail,
  TicketQuery,
  TicketUpdate,
} from "../types/operations";

const enc = encodeURIComponent;
const q = (query: object) => query as QueryParams;

/** Public intake form for students and staff (no sign-in, rate-limited). */
export const publicApi = {
  submitRequest: (body: PublicRequestCreate) =>
    apiRequest<PublicRequestReceipt>("/public/requests", { method: "POST", body, silentAuth: true }),
};

export const operationsApi = {
  state: (query: { window_hours: number }, signal?: AbortSignal) =>
    apiRequest<OperationsState>("/operations/state", { query: q(query), signal }),
};

export const ticketsApi = {
  list: (query: TicketQuery, signal?: AbortSignal) => apiRequest<Page<Ticket>>("/tickets", { query: q(query), signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<TicketDetail>(`/tickets/${enc(id)}`, { signal }),
  create: (body: TicketCreate) => apiRequest<TicketDetail>("/tickets", { method: "POST", body }),
  update: (id: string, body: TicketUpdate) => apiRequest<TicketDetail>(`/tickets/${enc(id)}`, { method: "PATCH", body }),
  addNote: (id: string, body: string) =>
    apiRequest<TicketDetail>(`/tickets/${enc(id)}/notes`, { method: "POST", body: { body } }),
};

export const resourcesApi = {
  list: (query: ResourceQuery, signal?: AbortSignal) => apiRequest<Resource[]>("/resources", { query: q(query), signal }),
  create: (body: ResourceCreate) => apiRequest<Resource>("/resources", { method: "POST", body }),
  update: (id: string, body: ResourceUpdate) =>
    apiRequest<Resource>(`/resources/${enc(id)}`, { method: "PATCH", body }),
};

export const eventsApi = {
  list: (query: EventQuery, signal?: AbortSignal) =>
    apiRequest<Page<OperationalEvent>>("/events", { query: q(query), signal }),
};

export const settingsApi = {
  slaPolicies: (signal?: AbortSignal) => apiRequest<SlaPolicySet>("/sla-policies", { signal }),
  updateSlaPolicies: (body: { expected_config_version: string; policies: SlaPolicy[]; reason: string }) =>
    apiRequest<SlaPolicySet>("/sla-policies", { method: "PUT", body }),
  configVersions: (signal?: AbortSignal) => apiRequest<ConfigVersion[]>("/config/versions", { signal }),
};
