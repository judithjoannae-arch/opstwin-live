import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { settingsApi } from "../../api/opsApi";
import { twinApi } from "../../api/twinApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { StageKey } from "../../types/operations";
import type { SimulationRun, Snapshot } from "../../types/twin";
import { CATEGORIES, CATEGORY_LABELS, STAGES, STAGE_LABELS, formatMinutes } from "../../utils/format";
import { fmt } from "../../utils/twin";
import { DataLabel, DemoTag } from "../../components/DataLabel";
import { MetricCompareTable } from "../../components/twin/MetricCompareTable";
import { SnapshotBar, useSnapshotSelection } from "../../components/twin/SnapshotBar";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

const FORECAST_LABEL = "Baseline forecast";

function StageColumn({
  title,
  origin,
  rows,
}: {
  title: string;
  origin: "observed" | "simulated";
  rows: { stage: StageKey; main: number | null; sub: string; flag?: string; note?: string }[];
}) {
  const sim = origin === "simulated";
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        <DataLabel origin={origin} />
      </div>
      <ol className="m-0 grid list-none gap-2 p-0">
        {rows.map((r) => (
          <li
            key={r.stage}
            className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 ${sim ? "ot-sim-box" : "border border-line"} ${r.flag ? "bg-bad/10" : "bg-navy-850"}`}
          >
            <span>
              <span className="block text-sm font-semibold">{STAGE_LABELS[r.stage]}</span>
              <span className="block text-xs text-muted">{r.sub}</span>
            </span>
            <span className="text-right">
              <span className="block text-2xl font-semibold tabular-nums">{r.main === null ? "—" : fmt(r.main, sim ? 1 : 0)}</span>
              {r.flag && <span className="block text-xs font-semibold text-bad">{r.flag}</span>}
              {r.note && <span className="block text-xs text-warn">{r.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ForecastPanel({ snapshot }: { snapshot: Snapshot }) {
  const { can } = useAuth();
  const runs = useResource((signal) => twinApi.runs({ snapshot_id: snapshot.id, limit: 50 }, signal), [snapshot.id]);
  const existing = runs.data?.find((r) => r.label === FORECAST_LABEL);
  const [created, setCreated] = useState<SimulationRun | null>(null);
  const forecastId = created?.id ?? existing?.id ?? null;
  const metrics = useResource((signal) => (forecastId ? twinApi.metrics(forecastId, signal) : Promise.resolve(null)), [forecastId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await twinApi.runAdHoc(snapshot.id, { duration_hours: 8, replications: 10 }, FORECAST_LABEL));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const m = metrics.data;
  const visible = STAGES.filter((s) => !snapshot.scope || snapshot.scope.includes(s));
  // A predicted bottleneck still has work waiting when the period ends; otherwise name the busiest stage.
  const ending = (s: StageKey) => m?.scalars[`stage_ending_queue.${s}`]?.mean ?? 0;
  const peak = (s: StageKey) => m?.scalars[`stage_max_queue.${s}`]?.mean ?? 0;
  const bottleneck = m ? visible.filter((s) => ending(s) >= 3).sort((a, b) => ending(b) - ending(a))[0] ?? null : null;
  const busiest = m && !bottleneck ? visible.filter((s) => peak(s) >= 2).sort((a, b) => peak(b) - peak(a))[0] ?? null : null;

  return (
    <section className="ot-panel" aria-labelledby="forecast-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="forecast-title" className="m-0">
            Now, and the next 8 hours
          </h2>
          <p className="m-0 mt-1 text-sm text-muted">
            Left: what the snapshot recorded. Right: what the twin predicts if nothing changes, averaged over 10 replications.
          </p>
        </div>
        {can(P.SIMULATIONS_RUN) && (
          <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void run()}>
            {busy ? "Simulating…" : forecastId ? "Run the forecast again" : "Run 8-hour forecast"}
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      <div className="grid gap-6 lg:grid-cols-2">
        <StageColumn
          title={`At ${formatDateTime(snapshot.created_at)}`}
          origin="observed"
          rows={visible.map((s) => ({
            stage: s,
            main: snapshot.stage_counts[s].active,
            sub: `${snapshot.stage_counts[s].staff_available} staff available, tickets in the stage`,
          }))}
        />
        {m ? (
          <StageColumn
            title="Predicted after 8 hours"
            origin="simulated"
            rows={visible.map((s) => ({
              stage: s,
              main: m.scalars[`stage_ending_queue.${s}`]?.mean ?? null,
              sub: `waiting at the end; peak ${fmt(m.scalars[`stage_max_queue.${s}`]?.mean, 1)}, mean wait ${formatMinutes(m.scalars[`stage_mean_wait_min.${s}`]?.mean ?? null)}`,
              flag: s === bottleneck ? "Predicted bottleneck" : undefined,
              note: s === busiest ? "Busiest stage, clears by the end" : undefined,
            }))}
          />
        ) : metrics.loading && forecastId ? (
          <Loading label="Loading forecast" />
        ) : (
          <div className="ot-sim-box flex items-center justify-center rounded-md p-6 text-center text-sm text-muted">
            No forecast for this snapshot yet.
            {can(P.SIMULATIONS_RUN) ? " Run one to see where queues are heading." : " Someone who can run simulations can create one."}
          </div>
        )}
      </div>
      {m && (
        <div className="mt-5">
          <MetricCompareTable
            columns={[{ key: "F", label: "Forecast", color: "#a78bfa", metrics: m.scalars }]}
            metrics={["throughput_per_hour", "mean_wait_min", "p95_wait_min", "ending_backlog", "sla_compliance_pct", "p1_sla_compliance_pct"]}
          />
          <p className="mt-2 text-sm">
            <Link className="ot-link" to={`/simulations/${forecastId}`}>
              Open the forecast run
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function ModelPanel({ snapshot }: { snapshot: Snapshot }) {
  const model = snapshot.model;
  const profile = model.arrival_profile.values.map((v, h) => ({ hour: `${String(h).padStart(2, "0")}:00`, rate: v }));
  const routing = snapshot.config.routing ?? {};
  return (
    <section className="ot-panel" aria-labelledby="model-title">
      <h2 id="model-title">What the twin learned from the data</h2>
      <dl className="ot-facts">
        <div>
          <dt>History used</dt>
          <dd>
            {snapshot.coverage.tickets_in_lookback} tickets over {fmt(snapshot.coverage.days_covered, 1)} days
          </dd>
        </div>
        <div>
          <dt>Active tickets in the snapshot</dt>
          <dd>
            {snapshot.coverage.real_active_tickets} real, {snapshot.coverage.demo_active_tickets} demo
          </dd>
        </div>
        <div>
          <dt>Routing policy (live configuration)</dt>
          <dd>
            {routing.policy === "smart_triage" ? "Smart triage" : routing.policy === "priority" ? "Priority first" : "First in, first out"}
            {routing.skill_aware ? ", skill-aware" : ""}
          </dd>
        </div>
        <div>
          <dt>Rework after verification</dt>
          <dd className="flex items-center gap-2">
            {fmt(model.rework_rate.value * 100, 1)}% <DataLabel origin={model.rework_rate.origin} />
          </dd>
        </div>
      </dl>

      <div className="mb-1 mt-4 flex items-center justify-between gap-2">
        <h3 className="m-0">Demand by hour of day (tickets per hour)</h3>
        <DataLabel origin={model.arrival_profile.origin} />
      </div>
      <p className="m-0 mb-2 text-xs text-muted">{model.arrival_profile.note}</p>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={profile} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="#213a55" vertical={false} />
            <XAxis dataKey="hour" tick={{ stroke: "#8da2b7", fontSize: 11 }} tickLine={false} interval={2} />
            <YAxis tick={{ stroke: "#8da2b7", fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip />
            <Bar dataKey="rate" name="Tickets per hour" fill="#2cc0d3" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <h3>Service time per ticket (mean minutes)</h3>
      <div className="ot-table-wrap">
        <table className="ot-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              {CATEGORIES.map((c) => (
                <th scope="col" key={c}>
                  {CATEGORY_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAGES.map((s) => (
              <tr key={s}>
                <th scope="row" className="font-normal">
                  {STAGE_LABELS[s]}
                </th>
                {CATEGORIES.map((c) => {
                  const e = model.service_times[s][c];
                  return (
                    <td key={c} className="whitespace-nowrap tabular-nums">
                      {fmt(e.mean, 1)} <DataLabel origin={e.origin} className="ml-1" />
                      <span className="block text-xs text-muted">n = {e.n}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm">
        <Link className="ot-link" to={`/assumptions?snapshot=${snapshot.id}`}>
          All assumptions and limitations
        </Link>
      </p>
    </section>
  );
}

function RecordsPanel({ snapshot }: { snapshot: Snapshot }) {
  const names = useMemo(() => Object.fromEntries((snapshot.resources ?? []).map((r) => [r.id, r.name])), [snapshot.resources]);
  return (
    <section className="ot-panel">
      <h2>Records frozen in this snapshot</h2>
      <details className="ot-details">
        <summary>{snapshot.tickets?.length ?? 0} active tickets</summary>
        <div className="ot-table-wrap max-h-96 overflow-y-auto">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Category</th>
                <th scope="col">Priority</th>
                <th scope="col">Stage</th>
                <th scope="col">Status</th>
                <th scope="col">Assigned</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot.tickets ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="ot-mono whitespace-nowrap">
                    {t.reference}
                    {t.is_demo && <DemoTag />}
                  </td>
                  <td>{CATEGORY_LABELS[t.category]}</td>
                  <td>{t.priority}</td>
                  <td>{STAGE_LABELS[t.stage]}</td>
                  <td>{t.status.replace("_", " ")}</td>
                  <td>{t.assigned_resource_id ? names[t.assigned_resource_id] ?? "Staff member" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="ot-details mt-3">
        <summary>{snapshot.resources?.length ?? 0} staff records</summary>
        <div className="ot-table-wrap">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Stage</th>
                <th scope="col">Shift</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot.resources ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.is_demo && <DemoTag />}
                  </td>
                  <td>{STAGE_LABELS[r.stage]}</td>
                  <td className="tabular-nums">{r.shift_start === r.shift_end ? "On call" : `${r.shift_start}–${r.shift_end}`}</td>
                  <td>
                    {!r.is_available ? "Unavailable" : r.is_reserve ? (r.reserve_active ? "Reserve, active" : "Reserve, inactive") : "Available"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export default function DigitalTwinPage() {
  const { list, selectedId, select } = useSnapshotSelection();
  const snapshot = useResource((signal) => (selectedId ? twinApi.snapshot(selectedId, signal) : Promise.resolve(null)), [selectedId]);
  const versions = useResource((signal) => settingsApi.configVersions(signal).catch(() => []), []);

  return (
    <div className="ot-page">
      <PageHeader
        title="Digital twin"
        description="A frozen, consistent copy of the live service desk and the model built from it. Simulations run on snapshots, never on live records."
        actions={
          selectedId && (
            <>
              <Link className="ot-btn ot-btn-quiet" to={`/scenarios?snapshot=${selectedId}`}>
                Build a scenario
              </Link>
              <Link className="ot-btn ot-btn-quiet" to={`/stress-test?snapshot=${selectedId}`}>
                Stress test
              </Link>
            </>
          )
        }
      />
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.data && (
        <SnapshotBar
          snapshots={list.data}
          selectedId={selectedId}
          onSelect={select}
          onCreated={(s) => {
            list.setData((prev) => [s, ...(prev ?? [])]);
            select(s.id);
          }}
          currentConfigVersion={versions.data?.[0]?.version}
        />
      )}
      {list.loading && !list.data && <Loading label="Loading snapshots" />}
      {list.data && list.data.length === 0 && (
        <EmptyState title="No snapshot yet">Refresh the twin to read the current live state and build the model.</EmptyState>
      )}
      {snapshot.error ? <ErrorNotice error={snapshot.error} onRetry={snapshot.reload} /> : null}
      {snapshot.data && (
        <>
          <ForecastPanel key={snapshot.data.id} snapshot={snapshot.data} />
          <div className="grid items-start gap-5 xl:grid-cols-[1.6fr_1fr]">
            <ModelPanel snapshot={snapshot.data} />
            <RecordsPanel snapshot={snapshot.data} />
          </div>
        </>
      )}
      <SimPanelNote />
    </div>
  );
}

function SimPanelNote() {
  return (
    <p className="text-xs text-muted">
      Dashed violet edges mark simulated predictions throughout the twin. Solid edges are recorded data.
    </p>
  );
}

