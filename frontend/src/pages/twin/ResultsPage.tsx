import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isAbortError } from "../../api/http";
import { reportUrl, stressReportUrl, twinApi } from "../../api/twinApi";
import { useResource } from "../../hooks/useResource";
import type { RunMetrics, SimulationRun } from "../../types/twin";
import { STRATEGY_NAMES, strategyColor } from "../../utils/twin";
import { MetricCompareTable } from "../../components/twin/MetricCompareTable";
import {
  BacklogChart,
  CategorySlaChart,
  DemandVsCompletedChart,
  MetricBars,
  ParetoScatter,
  StageGroupedChart,
  StageQueueChart,
} from "../../components/twin/RunCharts";
import { SimPanel } from "../../components/twin/SimPanel";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

interface Loaded {
  run: SimulationRun;
  metrics: RunMetrics;
  key: string;
  label: string;
  color: string;
}

export default function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const tests = useResource((signal) => twinApi.stressTests(20, signal), []);
  const recentRuns = useResource((signal) => twinApi.runs({ limit: 40 }, signal), []);
  const explicitRuns = params.get("runs")?.split(",").filter(Boolean) ?? [];
  const stressId = explicitRuns.length ? null : params.get("stress_test") ?? tests.data?.[0]?.id ?? null;

  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);

  const runIds = useMemo(() => {
    if (explicitRuns.length) return explicitRuns;
    const st = tests.data?.find((t) => t.id === stressId);
    return st ? st.runs.map((r) => r.id) : [];
  }, [explicitRuns.join(","), stressId, tests.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!runIds.length) {
      setLoaded([]);
      return;
    }
    const c = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all(runIds.map(async (id, i) => {
      const [run, metrics] = await Promise.all([twinApi.run(id, c.signal), twinApi.metrics(id, c.signal)]);
      const key = run.strategy_key ?? String.fromCharCode(49 + i);
      const label = run.strategy_key ? `${run.strategy_key}: ${STRATEGY_NAMES[run.strategy_key] ?? run.label}` : run.label;
      return { run, metrics, key, label, color: strategyColor(run.strategy_key, i) };
    }))
      .then((rows) => {
        setLoaded(rows);
        setFocus((f) => (f && rows.some((r) => r.key === f) ? f : rows.find((r) => r.key === "B")?.key ?? rows[0]?.key ?? null));
        const hours = Math.max(...rows.map((r) => r.run.parameters.duration_hours));
        setRange([0, hours]);
      })
      .catch((e: unknown) => !isAbortError(e) && setError(e))
      .finally(() => !c.signal.aborted && setLoading(false));
    return () => c.abort();
  }, [runIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const statRuns = loaded.map((l) => ({ key: l.key, label: l.label, color: l.color, scalars: l.metrics.scalars }));
  const seriesRuns = loaded.map((l) => ({ key: l.key, label: l.label, color: l.color, series: l.metrics.series }));
  const focused = loaded.find((l) => l.key === focus);
  const maxHours = Math.max(1, ...loaded.map((l) => l.run.parameters.duration_hours));
  const r = range ?? [0, maxHours];

  return (
    <div className="ot-page">
      <PageHeader
        title="Results and analytics"
        description="Charts of simulated outcomes. All values come from the twin's runs, averaged across replications."
        actions={<Link className="ot-btn ot-btn-quiet" to="/prediction-monitor">Prediction against observed</Link>}
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="ot-field ot-field-inline m-0">
          <span>Compare</span>
          <select
            value={explicitRuns.length ? "custom" : stressId ?? ""}
            onChange={(e) => e.target.value !== "custom" && setParams(new URLSearchParams({ stress_test: e.target.value }), { replace: true })}
          >
            {explicitRuns.length > 0 && <option value="custom">Selected runs</option>}
            {tests.data?.map((t) => (
              <option key={t.id} value={t.id}>
                Stress test {formatDateTime(t.created_at)} ({t.settings.demand_multiplier}× demand)
              </option>
            ))}
          </select>
        </label>
        <label className="ot-field ot-field-inline m-0">
          <span>Or add a run</span>
          <select value="" onChange={(e) => e.target.value && setParams(new URLSearchParams({ runs: [...(explicitRuns.length ? explicitRuns : runIds), e.target.value].join(",") }), { replace: true })}>
            <option value="">Choose a run…</option>
            {recentRuns.data?.filter((x) => !runIds.includes(x.id)).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label} ({formatDateTime(x.created_at)})
              </option>
            ))}
          </select>
        </label>
        {loaded.length > 0 && (
          <fieldset className="m-0 flex items-end gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">Time range (hours)</legend>
            <input className="ot-select-sm w-20" type="number" min={0} max={r[1]} value={r[0]} aria-label="From hour"
                   onChange={(e) => setRange([Math.max(0, Math.min(Number(e.target.value), r[1])), r[1]])} />
            <span className="pb-1 text-muted">to</span>
            <input className="ot-select-sm w-20" type="number" min={r[0]} max={maxHours} value={r[1]} aria-label="To hour"
                   onChange={(e) => setRange([r[0], Math.min(maxHours, Math.max(Number(e.target.value), r[0]))])} />
          </fieldset>
        )}
      </div>

      <ErrorNotice error={error} />
      {loading && <Loading label="Loading simulation results" />}
      {!loading && loaded.length === 0 && (
        <EmptyState title="No results to show">Run a stress test or a scenario, then come back to compare them.</EmptyState>
      )}

      {loaded.length > 0 && (
        <>
          <SimPanel title="Summary" actions={stressId ? <a className="ot-btn ot-btn-quiet" href={stressReportUrl(stressId)} download>Export all (JSON)</a> : null}>
            <MetricCompareTable
              referenceKey={loaded.some((l) => l.key === "B") ? "B" : loaded[0].key}
              columns={loaded.map((l) => ({ key: l.key, label: l.label, color: l.color, metrics: l.metrics.scalars }))}
              metrics={["arrivals", "completed", "throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog",
                        "sla_compliance_pct", "sla_violations", "p1_sla_compliance_pct", "p1_mean_wait_min", "unfinished", "recovery_time_min",
                        "transfers", "reworks"]}
            />
            <p className="mb-0 mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {loaded.map((l) => (
                <span key={l.key}>
                  {l.key}:{" "}
                  <Link className="ot-link" to={`/simulations/${l.run.id}`}>run</Link>,{" "}
                  <a className="ot-link" href={reportUrl(l.run.id, "csv")} download>CSV</a>,{" "}
                  <a className="ot-link" href={reportUrl(l.run.id, "json")} download>JSON</a>
                </span>
              ))}
            </p>
          </SimPanel>

          <div className="grid gap-5 xl:grid-cols-2">
            <SimPanel title="Backlog over time">
              <BacklogChart runs={seriesRuns} range={r} />
            </SimPanel>
            <SimPanel title="Recovery: backlog relative to the start">
              <BacklogChart runs={seriesRuns} range={r} normalised />
              <p className="m-0 text-xs text-muted">1.0 is the backlog at the snapshot. Falling back to 1.0 means the desk has recovered.</p>
            </SimPanel>
          </div>

          <SimPanel title="Comparisons with 95% intervals">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <MetricBars runs={statRuns} metric="throughput_per_hour" />
              <MetricBars runs={statRuns} metric="mean_wait_min" />
              <MetricBars runs={statRuns} metric="p95_wait_min" />
              <MetricBars runs={statRuns} metric="ending_backlog" />
              <MetricBars runs={statRuns} metric="sla_compliance_pct" />
              <MetricBars runs={statRuns} metric="p1_sla_compliance_pct" />
            </div>
          </SimPanel>

          <div className="grid gap-5 xl:grid-cols-2">
            <SimPanel title="SLA compliance by category (%)">
              <CategorySlaChart runs={statRuns} />
            </SimPanel>
            <SimPanel title="Utilization by stage (%)">
              <StageGroupedChart runs={statRuns} prefix="utilization_pct" unit="%" />
            </SimPanel>
            <SimPanel title="Mean wait by stage (minutes)">
              <StageGroupedChart runs={statRuns} prefix="stage_mean_wait_min" unit="min" />
            </SimPanel>
            <SimPanel title="Throughput against mean wait">
              <ParetoScatter runs={statRuns} />
            </SimPanel>
          </div>

          <SimPanel title="One run in detail" actions={
            <select className="ot-select-sm" aria-label="Run to inspect" value={focus ?? ""} onChange={(e) => setFocus(e.target.value)}>
              {loaded.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
          }>
            {focused && (
              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="mt-0">Queue length by stage</h3>
                  <StageQueueChart series={focused.metrics.series} range={r} />
                </div>
                <div>
                  <h3 className="mt-0">Demand against completed work</h3>
                  <DemandVsCompletedChart hourly={focused.metrics.hourly.filter((h) => h.hour >= r[0] && h.hour < r[1])} />
                </div>
              </div>
            )}
          </SimPanel>
        </>
      )}
    </div>
  );
}
