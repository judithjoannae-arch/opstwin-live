import { Link, useSearchParams } from "react-router-dom";
import { operationsApi, resourcesApi, ticketsApi } from "../../api/opsApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { usePolling } from "../../hooks/usePolling";
import { useResource } from "../../hooks/useResource";
import type { StageKey, StageState } from "../../types/operations";
import {
  CATEGORY_LABELS,
  INSUFFICIENT_DATA,
  STAGES,
  STAGE_LABELS,
  formatClock,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatRelative,
} from "../../utils/format";
import { ACTIVE_STATUSES, STAGE_EDGES, downstreamOf, isActive } from "../../utils/workflow";
import { DataLabel, DemoTag } from "../../components/DataLabel";
import { BottleneckPill, PriorityBadge, SlaBadge, StatusText } from "../../components/OpsBadges";
import { MetricValue } from "../../components/MetricValue";
import { StagePipeline } from "../../components/StagePipeline";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../../components/ui";

const STAGE_ROLE: Record<StageKey, string> = {
  intake: "Receives requests from the website form and from staff.",
  triage: "Classifies, prioritises and routes each request.",
  support: "Technicians investigate and resolve. Skills limit who can take which category.",
  verification: "Checks fixes and closes tickets, or sends them back for rework.",
};

function Legend() {
  return (
    <ul className="m-0 mb-4 flex list-none flex-wrap gap-x-6 gap-y-2 p-0 text-xs text-muted">
      <li className="flex items-center gap-2">
        <DataLabel origin="observed" /> Live queue state from the database
      </li>
      <li className="flex items-center gap-2">
        <BottleneckPill level="watch" /> <BottleneckPill level="bottleneck" /> Derived from observed queues and capacity
      </li>
      <li className="flex items-center gap-2">
        <span className="text-bad">SLA breached</span> Confirmed: a real deadline has passed
      </li>
      <li className="flex items-center gap-2">
        <DataLabel origin="simulated" /> Future queue states appear on the Digital twin page, never here
      </li>
    </ul>
  );
}

function StageDetail({ state }: { state: StageState }) {
  const { can } = useAuth();
  const stage = state.stage;
  const canSeeTickets = can(P.TICKETS_READ);
  const canSeeStaff = can(P.RESOURCES_READ);
  const tickets = useResource(
    (signal) =>
      canSeeTickets
        ? ticketsApi.list({ stage, status: ACTIVE_STATUSES, sort: "deadline_asc", page: 1, page_size: 15 }, signal)
        : Promise.resolve(null),
    [stage, canSeeTickets],
  );
  const staff = useResource((signal) => (canSeeStaff ? resourcesApi.list({ stage }, signal) : Promise.resolve(null)), [stage, canSeeStaff]);
  const downstream = downstreamOf(stage);
  const feedsBack = STAGE_EDGES.filter((e) => e.kind === "rework" && e.from === stage);

  return (
    <section className="ot-panel" aria-labelledby="stage-detail-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 id="stage-detail-title" className="m-0">
          {STAGE_LABELS[stage]}
        </h2>
        <BottleneckPill level={state.bottleneck} />
      </div>
      <p className="text-sm text-muted">{STAGE_ROLE[stage]}</p>
      {state.bottleneck_reason && <p className="text-sm text-warn">{state.bottleneck_reason}</p>}

      <dl className="m-0 my-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <MetricValue label="Waiting" value={formatNumber(state.queue)} origin="observed" />
        <MetricValue label="In service" value={formatNumber(state.in_service)} origin="observed" />
        <MetricValue label="On hold" value={formatNumber(state.on_hold)} origin="observed" />
        <MetricValue label="Staff available" value={`${state.available_resources} of ${state.total_resources}`} origin="observed" />
        <MetricValue
          label="Completed per hour"
          value={state.completed_per_hour === null ? null : formatNumber(state.completed_per_hour, 1)}
          origin="derived"
        />
        <MetricValue label="Average wait" value={state.avg_wait_minutes === null ? null : formatMinutes(state.avg_wait_minutes)} origin="derived" />
        <MetricValue label="Utilization" value={state.utilization_pct === null ? null : formatPercent(state.utilization_pct)} origin="derived" />
        <MetricValue
          label="SLA at risk / breached"
          value={
            <span>
              <span className={state.sla_at_risk ? "text-warn" : undefined}>{state.sla_at_risk}</span>
              {" / "}
              <span className={state.sla_breached ? "text-bad" : undefined}>{state.sla_breached}</span>
            </span>
          }
          origin="observed"
        />
      </dl>

      <h3>Dependencies</h3>
      <p className="text-sm">
        {downstream.length > 0 ? (
          <>
            Work leaving this stage goes to <strong>{STAGE_LABELS[downstream[0]]}</strong>. A backlog here delays{" "}
            {downstream.map((d) => STAGE_LABELS[d]).join(", then ")}.
          </>
        ) : (
          <>This is the last stage. Tickets leave the workflow when they're closed.</>
        )}
        {feedsBack.length > 0 && <> Failed verification sends tickets back to {STAGE_LABELS[feedsBack[0].to]} as rework.</>}
      </p>

      {canSeeTickets && (
        <>
          <h3>Tickets here, soonest deadline first</h3>
          {tickets.loading && !tickets.data ? (
            <Loading label="Loading tickets" />
          ) : tickets.error ? (
            <ErrorNotice error={tickets.error} onRetry={tickets.reload} />
          ) : (tickets.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No active tickets in this stage" />
          ) : (
            <div className="ot-table-wrap">
              <table className="ot-table">
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Status</th>
                    <th scope="col">SLA</th>
                    <th scope="col">Assigned</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.data?.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/tickets/${t.id}`} className="ot-link ot-mono">
                          {t.reference}
                        </Link>
                        {t.is_demo && <DemoTag />}
                        <span className="block text-xs text-muted">{CATEGORY_LABELS[t.category]}</span>
                      </td>
                      <td>
                        <PriorityBadge priority={t.priority} />
                      </td>
                      <td>
                        <StatusText status={t.status} />
                      </td>
                      <td className="whitespace-nowrap">
                        <SlaBadge state={t.sla_state} />
                        {isActive(t.status) && <span className="block text-xs text-muted">{formatRelative(t.sla_deadline)}</span>}
                      </td>
                      <td>{t.assigned_resource?.name ?? <span className="text-muted">Unassigned</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(tickets.data?.total ?? 0) > 15 && (
            <p className="mt-2 text-sm">
              <Link className="ot-link" to={`/tickets?stage=${stage}&sort=deadline_asc`}>
                See all {tickets.data?.total} tickets in this stage
              </Link>
            </p>
          )}
        </>
      )}

      {canSeeStaff && (
        <>
          <h3>Staff</h3>
          {staff.error ? (
            <ErrorNotice error={staff.error} onRetry={staff.reload} />
          ) : (staff.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">{staff.loading ? "Loading staff…" : "No staff assigned to this stage."}</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
              {staff.data?.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2 text-sm">
                  <span>
                    {r.name}
                    {r.is_reserve && <span className="ot-tag">Reserve</span>}
                    <span className="block text-xs text-muted">{r.active_ticket_count} active</span>
                  </span>
                  <span className={r.is_available ? "text-ok" : "text-warn"}>{r.is_available ? "Available" : "Unavailable"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default function WorkflowExplorerPage() {
  const [params, setParams] = useSearchParams();
  const polled = usePolling((signal) => operationsApi.state({ window_hours: 24 }, signal), { intervalMs: 15_000 });
  const raw = params.get("stage");
  const selected: StageKey = STAGES.includes(raw as StageKey) ? (raw as StageKey) : "support";
  const state = polled.data?.stages.find((s) => s.stage === selected);

  return (
    <div className="ot-page">
      <PageHeader
        title="Workflow explorer"
        description="The four connected stages of the service desk. Choose a stage to see its tickets, staff and what it feeds."
        actions={
          <span className="text-sm text-muted" aria-live="polite">
            Updated {formatClock(polled.lastUpdated)}
            <button type="button" className="ot-btn ot-btn-quiet ml-3" onClick={() => void polled.refresh()}>
              Refresh
            </button>
          </span>
        }
      />
      <Legend />
      {polled.error ? <ErrorNotice error={polled.error} onRetry={() => void polled.refresh()} /> : null}
      {!polled.data && polled.loading && <Loading label="Loading workflow" />}
      {polled.data && (
        <>
          <div className="mb-5">
            <StagePipeline
              stages={polled.data.stages}
              selected={selected}
              onSelect={(s) => setParams(new URLSearchParams({ stage: s }), { replace: true })}
            />
          </div>
          {state ? <StageDetail key={selected} state={state} /> : <p className="text-muted">{INSUFFICIENT_DATA} for this stage.</p>}
        </>
      )}
    </div>
  );
}
