import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ticketsApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useDebounced, useResource } from "../../hooks/useResource";
import type { TicketQuery } from "../../types/operations";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  SLA_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUS_LABELS,
  formatRelative,
} from "../../utils/format";
import { ACTIVE_STATUSES, isActive } from "../../utils/workflow";
import { DemoTag } from "../../components/DataLabel";
import { PriorityBadge, SlaBadge, StageText, StatusText } from "../../components/OpsBadges";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";
import CreateTicketDialog from "./CreateTicketDialog";

const PAGE_SIZE = 25;
const FILTER_KEYS = ["stage", "status", "priority", "category", "sla_state", "assigned", "sort"] as const;

export default function TicketsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [createOpen, setCreateOpen] = useState(false);

  // Keep the search term in the URL (shareable) once typing pauses.
  useEffect(() => {
    if ((params.get("q") ?? "") === debouncedSearch) return;
    const next = new URLSearchParams(params);
    if (debouncedSearch) next.set("q", debouncedSearch);
    else next.delete("q");
    next.delete("page");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const status = params.get("status") ?? ACTIVE_STATUSES;

  const query: TicketQuery = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      stage: params.get("stage") || undefined,
      status: status || undefined,
      priority: params.get("priority") || undefined,
      category: params.get("category") || undefined,
      sla_state: params.get("sla_state") || undefined,
      assigned: params.get("assigned") || undefined,
      sort: (params.get("sort") as TicketQuery["sort"]) || "created_desc",
      page,
      page_size: PAGE_SIZE,
    }),
    [debouncedSearch, params, status, page],
  );

  const list = useResource((signal) => ticketsApi.list(query, signal), [JSON.stringify(query)]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next, { replace: true });
  };

  const setPage = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    setParams(next, { replace: true });
  };

  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = FILTER_KEYS.some((k) => params.get(k)) || !!search;

  return (
    <div className="ot-page">
      <PageHeader
        title="Tickets"
        description="Every support request stored by the website. Changes here are recorded as operational events and feed the next twin snapshot."
        actions={
          can(P.TICKETS_CREATE) && (
            <button type="button" className="ot-btn ot-btn-primary" onClick={() => setCreateOpen(true)}>
              New ticket
            </button>
          )
        }
      />

      <div className="mb-4 grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <label className="ot-field xl:col-span-2">
          <span>Search</span>
          <input
            type="search"
            value={search}
            placeholder="Reference, summary or requester"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="ot-field">
          <span>Stage</span>
          <select value={params.get("stage") ?? ""} onChange={(e) => setFilter("stage", e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Status</span>
          <select value={status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value={ACTIVE_STATUSES}>Active</option>
            <option value="">Any status</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Priority</span>
          <select value={params.get("priority") ?? ""} onChange={(e) => setFilter("priority", e.target.value)}>
            <option value="">Any</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Category</span>
          <select value={params.get("category") ?? ""} onChange={(e) => setFilter("category", e.target.value)}>
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>SLA</span>
          <select value={params.get("sla_state") ?? ""} onChange={(e) => setFilter("sla_state", e.target.value)}>
            <option value="">Any</option>
            {Object.entries(SLA_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field">
          <span>Assigned</span>
          <select value={params.get("assigned") ?? ""} onChange={(e) => setFilter("assigned", e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted">
          {list.data ? `${total.toLocaleString()} ticket${total === 1 ? "" : "s"}` : "\u00a0"}
          {hasFilters && (
            <button
              type="button"
              className="ot-link ml-3 border-0 bg-transparent p-0"
              onClick={() => {
                setSearch("");
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Clear filters
            </button>
          )}
        </span>
        <label className="flex items-center gap-2">
          <span className="text-muted">Sort</span>
          <select className="ot-select-sm" value={params.get("sort") ?? "created_desc"} onChange={(e) => setFilter("sort", e.target.value)}>
            <option value="created_desc">Newest first</option>
            <option value="deadline_asc">SLA deadline soonest</option>
          </select>
        </label>
      </div>

      {list.loading && !list.data ? (
        <Loading label="Loading tickets" />
      ) : list.error ? (
        <ErrorNotice error={list.error} onRetry={list.reload} />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState title={hasFilters ? "No tickets match these filters" : "No tickets yet"}>
          {hasFilters ? "Clear a filter to see more." : "Tickets submitted through the request form or created here will appear in this list."}
        </EmptyState>
      ) : (
        <>
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Status</th>
                  <th scope="col">SLA</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap">
                      <Link to={`/tickets/${t.id}`} className="ot-link ot-mono">
                        {t.reference}
                      </Link>
                      {t.is_demo && <DemoTag />}
                    </td>
                    <td className="min-w-[16rem]">
                      <span className="block">{t.title}</span>
                      <span className="block text-xs text-muted">{CATEGORY_LABELS[t.category]}</span>
                    </td>
                    <td>
                      <PriorityBadge priority={t.priority} />
                    </td>
                    <td>
                      <StageText stage={t.stage} />
                    </td>
                    <td>
                      <StatusText status={t.status} />
                    </td>
                    <td className="whitespace-nowrap">
                      <SlaBadge state={t.sla_state} />
                      {isActive(t.status) && (
                        <span className="block text-xs text-muted" title={formatDateTime(t.sla_deadline)}>
                          {formatRelative(t.sla_deadline)}
                        </span>
                      )}
                    </td>
                    <td>{t.assigned_resource?.name ?? <span className="text-muted">Unassigned</span>}</td>
                    <td className="whitespace-nowrap text-sm" title={formatDateTime(t.created_at)}>
                      {formatRelative(t.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ot-pager">
            <button type="button" className="ot-btn ot-btn-quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {lastPage}
            </span>
            <button type="button" className="ot-btn ot-btn-quiet" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </>
      )}

      <CreateTicketDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          setCreateOpen(false);
          navigate(`/tickets/${t.id}`);
        }}
      />
    </div>
  );
}
