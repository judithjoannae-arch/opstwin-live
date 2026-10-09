import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { operationsApi } from "../../api/opsApi";
import { usePolling } from "../../hooks/usePolling";
import type { OperationsState } from "../../types/operations";
import {
  INSUFFICIENT_DATA,
  STAGE_LABELS,
  formatClock,
  formatHour,
  formatNumber,
  formatPercent,
  formatRelative,
  formatShortTime,
} from "../../utils/format";
import { DataLabel } from "../../components/DataLabel";
import { MetricValue } from "../../components/MetricValue";
import { StagePipeline } from "../../components/StagePipeline";
import { ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

const WINDOWS = [
  { hours: 8, label: "Last 8 hours" },
  { hours: 24, label: "Last 24 hours" },
  { hours: 72, label: "Last 3 days" },
  { hours: 168, label: "Last 7 days" },
];

const AXIS = { stroke: "#8da2b7", fontSize: 12 };
const GRID = "#213a55";

function Freshness({ state, lastUpdated, loading }: { state: OperationsState; lastUpdated: Date | null; loading: boolean }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-line bg-navy-950/50 px-4 py-2.5 text-sm">
      <span aria-live="polite">
        <span className="text-muted">Last updated </span>
        <strong className="tabular-nums">{formatClock(lastUpdated)}</strong>
        {loading && <span className="ml-2 text-muted">refreshing…</span>}
      </span>
      <span>
        <span className="text-muted">Configuration </span>
        <strong className="ot-mono">{state.config_version}</strong>
      </span>
      <span>
        <span className="text-muted">Latest twin snapshot </span>
        {state.latest_snapshot ? (
          <strong>
            {formatDateTime(state.latest_snapshot.created_at)}
            {state.latest_snapshot.config_version !== state.config_version && (
              <span className="ml-2 font-normal text-warn">older configuration</span>
            )}
          </strong>
        ) : (
          <strong className="font-normal text-muted">none yet</strong>
        )}
      </span>
      <span>
        <span className="text-muted">Data since </span>
        <strong>{state.data_coverage.first_ticket_at ? formatDateTime(state.data_coverage.first_ticket_at) : "no tickets yet"}</strong>
      </span>
    </div>
  );
}

function ThroughputChart({ state }: { state: OperationsState }) {
  const data = state.throughput.series.map((p) => ({ ...p, label: formatHour(p.hour) }));
  const hasData = data.some((p) => p.created > 0 || p.completed > 0);
  return (
    <section className="ot-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="m-0">Demand and completed work per hour</h2>
        <DataLabel origin="observed" />
      </div>
      {!hasData ? (
        <p className="text-sm text-muted">{INSUFFICIENT_DATA} in this time window.</p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="created" name="Submitted" fill="#4a77a8" />
              <Line type="monotone" dataKey="completed" name="Completed" stroke="#2cc0d3" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function QueueChart({ state }: { state: OperationsState }) {
  const data = state.stages.map((s) => ({
    stage: STAGE_LABELS[s.stage].replace(" and closure", ""),
    Waiting: s.queue,
    "In service": s.in_service,
    "On hold": s.on_hold,
  }));
  return (
    <section className="ot-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="m-0">Work in each stage</h2>
        <DataLabel origin="observed" />
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="stage" tick={AXIS} tickLine={false} />
            <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
            <Tooltip cursor={{ fill: "rgba(44,192,211,0.06)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Waiting" stackId="a" fill="#f0b13c" />
            <Bar dataKey="In service" stackId="a" fill="#2cc0d3" />
            <Bar dataKey="On hold" stackId="a" fill="#8da2b7" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const [windowHours, setWindowHours] = useState(24);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const polled = usePolling((signal) => operationsApi.state({ window_hours: windowHours }, signal), {
    intervalMs: 15_000,
    enabled: autoRefresh,
    deps: [windowHours],
  });
  const s = polled.data;

  return (
    <div className="ot-page">
      <PageHeader
        title="Operations dashboard"
        description="Live state of the campus IT service desk, read from the application database."
        actions={
          <>
            <select
              className="ot-select-sm"
              aria-label="Time window"
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w.hours} value={w.hours}>
                  {w.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Auto-refresh every 15 s
            </label>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => void polled.refresh()}>
              Refresh now
            </button>
          </>
        }
      />

      {polled.error ? <ErrorNotice error={polled.error} onRetry={() => void polled.refresh()} /> : null}
      {!s && polled.loading && <Loading label="Loading operational state" />}

      {s && (
        <>
          <Freshness state={s} lastUpdated={polled.lastUpdated} loading={polled.loading} />

          {s.data_coverage.demo_ticket_count > 0 && (
            <Notice tone="info">
              {s.data_coverage.demo_ticket_count} of the tickets counted here are synthetic demonstration records, marked Demo in the ticket
              list. {s.data_coverage.real_ticket_count} were created through this website.
            </Notice>
          )}

          <section className="mb-5" aria-labelledby="pipeline-title">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 id="pipeline-title" className="m-0 text-base font-semibold">
                Workflow right now
              </h2>
              <span className="flex items-center gap-3">
                <DataLabel origin="observed" />
                <Link to="/workflow" className="ot-link text-sm">
                  Inspect stages
                </Link>
              </span>
            </div>
            <StagePipeline stages={s.stages} />
          </section>

          <section className="ot-panel">
            <h2 className="sr-only">Ticket totals</h2>
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 2xl:grid-cols-8">
              <MetricValue label="Submitted" value={formatNumber(s.totals.submitted)} origin="observed" emphasis />
              <MetricValue label="Open" value={formatNumber(s.totals.open)} origin="observed" emphasis />
              <MetricValue label="In progress" value={formatNumber(s.totals.in_progress)} origin="observed" emphasis />
              <MetricValue
                label="Resolved or closed"
                value={formatNumber(s.totals.resolved + s.totals.closed)}
                origin="observed"
                emphasis
              />
              <MetricValue
                label="Overdue"
                value={<span className={s.totals.overdue > 0 ? "text-bad" : undefined}>{formatNumber(s.totals.overdue)}</span>}
                origin="observed"
                emphasis
              />
              <MetricValue
                label="SLA compliance"
                value={s.sla.compliance_pct === null ? null : formatPercent(s.sla.compliance_pct)}
                hint={s.sla.compliance_pct === null ? undefined : `${s.sla.evaluated} evaluated`}
                origin="derived"
                emphasis
              />
              <MetricValue
                label="Completed per hour"
                value={s.throughput.per_hour === null ? null : formatNumber(s.throughput.per_hour, 1)}
                origin="derived"
                emphasis
              />
              <MetricValue
                label="Oldest unresolved"
                value={
                  s.oldest_unresolved ? (
                    <Link to={`/tickets/${s.oldest_unresolved.id}`} className="ot-link">
                      {formatRelative(s.oldest_unresolved.created_at).replace(" ago", "")}
                    </Link>
                  ) : null
                }
                hint={s.oldest_unresolved ? s.oldest_unresolved.reference : undefined}
                origin="observed"
                emphasis
              />
            </dl>
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <ThroughputChart state={s} />
            <QueueChart state={s} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
            <section className="ot-panel">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="m-0">Staff and utilization</h2>
                <Link to="/resources" className="ot-link text-sm">
                  Manage staff
                </Link>
              </div>
              <dl className="m-0 mb-4 grid grid-cols-3 gap-4">
                <MetricValue label="On shift now" value={formatNumber(s.staff.available)} origin="observed"
                  hint={s.staff.off_shift ? `${s.staff.off_shift} off shift` : undefined} />
                <MetricValue
                  label="Unavailable"
                  value={<span className={s.staff.unavailable > 0 ? "text-warn" : undefined}>{formatNumber(s.staff.unavailable)}</span>}
                  origin="observed"
                />
                <MetricValue label="Total" value={formatNumber(s.staff.total)} origin="observed" />
              </dl>
              <div className="ot-table-wrap">
                <table className="ot-table">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">On shift now</th>
                      <th scope="col">
                        Utilization <DataLabel origin="derived" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.stages.map((st) => (
                      <tr key={st.stage}>
                        <td>{STAGE_LABELS[st.stage]}</td>
                        <td className="tabular-nums">
                          {st.available_resources} of {st.total_resources}
                        </td>
                        <td className="tabular-nums">
                          {st.utilization_pct === null ? <span className="text-muted">{INSUFFICIENT_DATA}</span> : formatPercent(st.utilization_pct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="ot-panel">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="m-0">Recent operational events</h2>
                <Link to="/events" className="ot-link text-sm">
                  Full event log
                </Link>
              </div>
              {s.recent_events.length === 0 ? (
                <p className="text-sm text-muted">No events recorded yet. Submitting or updating a ticket creates one.</p>
              ) : (
                <ol className="m-0 list-none divide-y divide-line p-0">
                  {s.recent_events.map((ev) => (
                    <li key={ev.id} className="flex gap-3 py-2 text-sm">
                      <time className="w-20 shrink-0 tabular-nums text-muted" dateTime={ev.occurred_at}>
                        {formatShortTime(ev.occurred_at)}
                      </time>
                      <span className="min-w-0">
                        {ev.ticket_id ? (
                          <Link to={`/tickets/${ev.ticket_id}`} className="ot-link ot-mono mr-2">
                            {ev.ticket_reference}
                          </Link>
                        ) : null}
                        {ev.summary}
                        {ev.is_demo && <span className="ml-2 text-xs text-warn">Demo</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
