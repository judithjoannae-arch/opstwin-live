import { Link, useParams } from "react-router-dom";
import { reportUrl, twinApi } from "../../api/twinApi";
import { useResource } from "../../hooks/useResource";
import { STAGE_LABELS } from "../../utils/format";
import { STRATEGY_NAMES } from "../../utils/twin";
import { MetricCompareTable } from "../../components/twin/MetricCompareTable";
import { BacklogChart, DemandVsCompletedChart, StageQueueChart } from "../../components/twin/RunCharts";
import { SimPanel } from "../../components/twin/SimPanel";
import { SimulatedEventsTable } from "../../components/twin/SimulatedEventsTable";
import { ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

export default function SimulationRunPage() {
  const { simulationId = "" } = useParams();
  const run = useResource((signal) => twinApi.run(simulationId, signal), [simulationId]);
  const metrics = useResource((signal) => twinApi.metrics(simulationId, signal), [simulationId]);
  const snapshot = useResource((signal) => (run.data ? twinApi.snapshot(run.data.snapshot_id, signal) : Promise.resolve(null)), [run.data?.snapshot_id]);
  const names = Object.fromEntries((snapshot.data?.resources ?? []).map((r) => [r.id, r.name]));

  if (run.error) return <ErrorNotice error={run.error} />;
  if (!run.data) return <Loading label="Loading simulation" />;
  const r = run.data;
  const p = r.parameters;
  const changes = [
    p.demand_multiplier !== 1 && `${p.demand_multiplier}× demand`,
    p.removed_resource_ids.length && `${p.removed_resource_ids.map((id) => names[id] ?? "a staff member").join(", ")} unavailable`,
    p.reallocations.length && `${p.reallocations.map((m) => `${names[m.resource_id] ?? "staff"} to ${STAGE_LABELS[m.to_stage]}`).join(", ")}`,
    p.activate_reserve_ids.length && `reserve ${p.activate_reserve_ids.map((id) => names[id] ?? "staff").join(", ")} active`,
    Object.values(p.extra_staff).some((n) => n) && "hypothetical extra staff",
    p.routing_policy && `routing: ${p.routing_policy.replace("_", " ")}`,
    !p.respect_shifts && "shifts ignored",
  ].filter(Boolean);

  return (
    <div className="ot-page">
      <PageHeader
        title={r.strategy_key ? `${r.strategy_key}: ${STRATEGY_NAMES[r.strategy_key] ?? r.label}` : r.label}
        description={`Simulated ${p.duration_hours} h from the snapshot of ${formatDateTime(r.snapshot_created_at)} (${r.config_version}). ${r.replications} replications, seed ${r.seed}, computed in ${r.duration_ms} ms.`}
        actions={
          <>
            <a className="ot-btn ot-btn-quiet" href={reportUrl(r.id, "csv")} download>Export CSV</a>
            <a className="ot-btn ot-btn-quiet" href={reportUrl(r.id, "json")} download>Export JSON</a>
          </>
        }
      />
      <p className="text-sm">
        <span className="text-muted">Changes from the snapshot: </span>
        {changes.length ? changes.join("; ") : "none (baseline)"}.{" "}
        {r.stress_test_id && <Link className="ot-link" to={`/stress-test?id=${r.stress_test_id}`}>Part of a stress test</Link>}
      </p>
      {metrics.data && (
        <>
          <SimPanel title="Outcome">
            <MetricCompareTable
              columns={[{ key: "run", label: "This run", color: "#a78bfa", metrics: metrics.data.scalars }]}
              metrics={["arrivals", "completed", "throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog",
                        "sla_compliance_pct", "sla_violations", "p1_sla_compliance_pct", "unfinished", "recovery_time_min", "transfers", "reworks", "escalations"]}
            />
            <ul className="mb-0 mt-3 pl-5 text-xs text-muted">
              {metrics.data.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </SimPanel>
          <div className="grid gap-5 xl:grid-cols-2">
            <SimPanel title="Backlog over time">
              <BacklogChart runs={[{ key: "run", label: "Backlog", color: "#a78bfa", series: metrics.data.series }]} />
            </SimPanel>
            <SimPanel title="Queue length by stage">
              <StageQueueChart series={metrics.data.series} />
            </SimPanel>
            <SimPanel title="Demand against completed work">
              <DemandVsCompletedChart hourly={metrics.data.hourly} />
            </SimPanel>
            <SimPanel title="Carried over at the end (replication 1)">
              {metrics.data.unfinished_example.length === 0 ? (
                <p className="text-sm text-muted">Nothing left open: every ticket finished inside the period.</p>
              ) : (
                <div className="ot-table-wrap max-h-64 overflow-y-auto">
                  <table className="ot-table">
                    <thead><tr><th scope="col">Ticket</th><th scope="col">Stage</th><th scope="col">State</th><th scope="col">Priority</th></tr></thead>
                    <tbody>
                      {metrics.data.unfinished_example.map((u) => (
                        <tr key={u.ref}>
                          <td className="ot-mono">{u.ref}</td>
                          <td>{STAGE_LABELS[u.stage]}</td>
                          <td>{u.state.replace("_", " ")}</td>
                          <td>{u.priority}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SimPanel>
          </div>
        </>
      )}
      <SimPanel title="Simulated event log">
        <SimulatedEventsTable runId={r.id} resourceNames={names} />
      </SimPanel>
    </div>
  );
}
