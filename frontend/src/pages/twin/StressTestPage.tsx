import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resourcesApi } from "../../api/opsApi";
import { stressReportUrl, twinApi } from "../../api/twinApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { RunMetrics, StressTest, StressTestRequest } from "../../types/twin";
import { STAGE_LABELS } from "../../utils/format";
import { STRATEGY_NAMES, strategyColor } from "../../utils/twin";
import { MetricCompareTable } from "../../components/twin/MetricCompareTable";
import { BacklogChart, MetricBars, ParetoScatter, StageGroupedChart } from "../../components/twin/RunCharts";
import { SimPanel } from "../../components/twin/SimPanel";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

const DEFAULTS: StressTestRequest = {
  duration_hours: 8, demand_multiplier: 2, replications: 10, seed: 42, capacity_source: "auto", transfer_count: 1, respect_shifts: true,
};

function Choices({ st }: { st: StressTest }) {
  const s = st.settings;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-sm">
      <li>
        <strong>Failure:</strong> {s.demand_multiplier}× demand for {s.duration_hours} h, and {s.removed_resource.name} from technical support is
        unavailable. Existing tickets stay in every scenario.
      </li>
      <li>
        <strong>Capacity reallocation:</strong>{" "}
        {s.moved_resources.length
          ? `${s.moved_resources.map((r) => r.name).join(", ")} moves from ${STAGE_LABELS[s.moved_resources[0].from_stage]} to technical support, so ${STAGE_LABELS[s.moved_resources[0].from_stage]} loses that capacity.`
          : s.activated_reserves.length
            ? `reserve ${s.activated_reserves.map((r) => r.name).join(", ")} is activated.`
            : "no eligible staff or reserve was available, so strategies D and E weren't run."}
      </li>
      <li className="text-muted">
        Same snapshot, demand profile, horizon and seeds ({s.seed} onward) for every scenario; {s.replications} replications each.
        {s.respect_shifts ? " Staff work their recorded shifts." : " Shifts ignored: everyone works the whole period."}
      </li>
    </ul>
  );
}

function Results({ st }: { st: StressTest }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const rows = st.comparison.scenarios;
  const [metrics, setMetrics] = useState<Record<string, RunMetrics>>({});
  useEffect(() => {
    const c = new AbortController();
    Promise.all(rows.map((r) => twinApi.metrics(r.run_id, c.signal).then((m) => [r.key, m] as const)))
      .then((pairs) => setMetrics(Object.fromEntries(pairs)))
      .catch(() => undefined);
    return () => c.abort();
  }, [st.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const statRuns = rows.map((r, i) => ({ key: r.key, label: `${r.key}: ${STRATEGY_NAMES[r.key] ?? r.label}`, color: strategyColor(r.key, i),
                                         scalars: metrics[r.key]?.scalars ?? r.metrics }));
  const seriesRuns = rows.filter((r) => metrics[r.key]).map((r, i) => ({ key: r.key, label: `${r.key}: ${STRATEGY_NAMES[r.key] ?? r.label}`,
                                                                         color: strategyColor(r.key, i), series: metrics[r.key].series }));

  return (
    <>
      <SimPanel title="Five scenarios, one snapshot" actions={
        <>
          <a className="ot-btn ot-btn-quiet" href={stressReportUrl(st.id)} download>Export report</a>
          {can(P.RECOMMENDATIONS_READ) && (
            <button type="button" className="ot-btn ot-btn-primary" onClick={() => navigate(`/recommendations?stress_test=${st.id}&evaluate=1`)}>
              Evaluate recommendations
            </button>
          )}
        </>
      }>
        <Choices st={st} />
        <div className="mt-4">
          <MetricCompareTable
            referenceKey="B"
            columns={rows.map((r, i) => ({ key: r.key, label: `${r.key}: ${STRATEGY_NAMES[r.key] ?? r.label}`, color: strategyColor(r.key, i), metrics: r.metrics }))}
            metrics={["throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog", "sla_compliance_pct", "sla_violations",
                      "p1_sla_compliance_pct", "unfinished", "recovery_time_min"]}
          />
          <p className="mt-2 text-xs text-muted">Green and red compare each scenario with B, the unmitigated failure. ± is the 95% interval across replications.</p>
        </div>
      </SimPanel>

      <div className="grid gap-5 xl:grid-cols-2">
        <SimPanel title="Backlog over the simulated period">
          {seriesRuns.length ? <BacklogChart runs={seriesRuns} /> : <Loading label="Loading time series" />}
        </SimPanel>
        <SimPanel title="Where waiting moves (mean wait per stage, minutes)">
          <StageGroupedChart runs={statRuns} prefix="stage_mean_wait_min" unit="min" />
          <p className="m-0 mt-2 text-xs text-muted">
            Moving capacity into technical support shortens its queue but can lengthen waits in the stage that gave it up.
          </p>
        </SimPanel>
      </div>
      <SimPanel title="Key metrics with 95% intervals">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricBars runs={statRuns} metric="throughput_per_hour" />
          <MetricBars runs={statRuns} metric="mean_wait_min" />
          <MetricBars runs={statRuns} metric="sla_compliance_pct" />
          <MetricBars runs={statRuns} metric="p1_sla_compliance_pct" />
        </div>
      </SimPanel>
      <SimPanel title="Throughput against waiting">
        <ParetoScatter runs={statRuns} />
        <p className="m-0 text-xs text-muted">Higher and further left is better on both. The recommendation page checks safety limits before choosing.</p>
      </SimPanel>
      <p className="text-sm">
        <Link className="ot-link" to={`/results?stress_test=${st.id}`}>All charts for this stress test</Link>
      </p>
    </>
  );
}

export default function StressTestPage() {
  const { can } = useAuth();
  const canRun = can(P.SIMULATIONS_RUN);
  const [params, setParams] = useSearchParams();
  const history = useResource((signal) => twinApi.stressTests(15, signal), []);
  const snapshots = useResource((signal) => twinApi.snapshots(20, signal), []);
  const staff = useResource((signal) => (can(P.RESOURCES_READ) ? resourcesApi.list({ stage: "support" }, signal) : Promise.resolve([])), []);
  const [form, setForm] = useState<StressTestRequest>({ ...DEFAULTS, snapshot_id: params.get("snapshot") ?? undefined });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const selectedId = params.get("id") ?? history.data?.[0]?.id ?? null;
  const current = useResource((signal) => (selectedId ? twinApi.stressTestById(selectedId, signal) : Promise.resolve(null)), [selectedId]);
  const technicians = useMemo(() => (staff.data ?? []).filter((r) => r.is_available && !r.is_reserve), [staff.data]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const st = await twinApi.stressTest({ ...form, snapshot_id: form.snapshot_id || undefined, removed_resource_id: form.removed_resource_id || undefined,
                                            donor_stage: form.donor_stage || undefined });
      history.setData((prev) => [st, ...(prev ?? [])]);
      current.setData(() => st);
      const next = new URLSearchParams(params);
      next.set("id", st.id);
      setParams(next, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ot-page">
      <PageHeader
        title="Stress test"
        description="Doubles demand, removes a technician and compares four responses against the same failure. Live tickets and staff are never changed."
      />
      {canRun && (
        <section className="ot-panel">
          <h2>Set up the test</h2>
          <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="ot-field">
              <span>Snapshot</span>
              <select value={form.snapshot_id ?? ""} onChange={(e) => setForm({ ...form, snapshot_id: e.target.value || undefined })}>
                {can(P.SNAPSHOTS_CREATE) && <option value="">Take a fresh snapshot now</option>}
                {snapshots.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatDateTime(s.created_at)} ({s.config_version})
                  </option>
                ))}
              </select>
            </label>
            <label className="ot-field">
              <span>Demand multiplier</span>
              <input type="number" min={1} max={5} step={0.1} value={form.demand_multiplier}
                     onChange={(e) => setForm({ ...form, demand_multiplier: Number(e.target.value) || 2 })} />
            </label>
            <label className="ot-field">
              <span>Technician who becomes unavailable</span>
              <select value={form.removed_resource_id ?? ""} onChange={(e) => setForm({ ...form, removed_resource_id: e.target.value || undefined })}>
                <option value="">Busiest technician on shift (automatic)</option>
                {technicians.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.shift_start}–{r.shift_end})
                  </option>
                ))}
              </select>
            </label>
            <label className="ot-field">
              <span>Simulated period (hours)</span>
              <input type="number" min={1} max={72} value={form.duration_hours}
                     onChange={(e) => setForm({ ...form, duration_hours: Number(e.target.value) || 8 })} />
            </label>
            <label className="ot-field">
              <span>Extra capacity for strategy D</span>
              <select value={form.capacity_source} onChange={(e) => setForm({ ...form, capacity_source: e.target.value as StressTestRequest["capacity_source"] })}>
                <option value="auto">Move staff from a quieter stage, else use reserve</option>
                <option value="transfer">Move staff from a quieter stage only</option>
                <option value="reserve">Activate reserve capacity</option>
              </select>
            </label>
            <label className="ot-field">
              <span>People to move or activate</span>
              <input type="number" min={1} max={5} value={form.transfer_count}
                     onChange={(e) => setForm({ ...form, transfer_count: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
            </label>
            <label className="ot-field">
              <span>Donor stage</span>
              <select value={form.donor_stage ?? ""} onChange={(e) => setForm({ ...form, donor_stage: (e.target.value || undefined) as StressTestRequest["donor_stage"] })}>
                <option value="">Least loaded (automatic)</option>
                <option value="triage">Triage</option>
                <option value="verification">Verification and closure</option>
                <option value="intake">Request intake</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-x-3">
              <label className="ot-field">
                <span>Replications</span>
                <input type="number" min={2} max={30} value={form.replications}
                       onChange={(e) => setForm({ ...form, replications: Math.max(2, Math.min(30, Number(e.target.value) || 10)) })} />
              </label>
              <label className="ot-field">
                <span>Seed</span>
                <input type="number" min={0} value={form.seed} onChange={(e) => setForm({ ...form, seed: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="ot-check border-t-0">
              <input type="checkbox" checked={form.respect_shifts} onChange={(e) => setForm({ ...form, respect_shifts: e.target.checked })} />
              <span>
                Follow staff shifts
                <small>Turn off to assume day staffing, for example when demonstrating at night.</small>
              </span>
            </label>
            <button type="button" className="ot-btn ot-btn-primary ml-auto" disabled={busy} onClick={() => void run()}>
              {busy ? "Running five scenarios…" : "Run stress test"}
            </button>
          </div>
          <ErrorNotice error={error} />
        </section>
      )}

      {history.data && history.data.length > 0 && (
        <label className="ot-field ot-field-inline mb-4">
          <span>Showing</span>
          <select value={selectedId ?? ""} onChange={(e) => { const n = new URLSearchParams(params); n.set("id", e.target.value); setParams(n, { replace: true }); }}>
            {history.data.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDateTime(s.created_at)}: {s.settings.demand_multiplier}× demand, {s.settings.removed_resource.name} out
              </option>
            ))}
          </select>
        </label>
      )}
      {history.data?.length === 0 && !busy && (
        <EmptyState title="No stress tests yet">{canRun ? "Run one to see how the desk copes with a demand spike and a missing technician." : "Results appear here once someone runs one."}</EmptyState>
      )}
      {current.error ? <ErrorNotice error={current.error} onRetry={current.reload} /> : null}
      {current.data && <Results key={current.data.id} st={current.data} />}
    </div>
  );
}
