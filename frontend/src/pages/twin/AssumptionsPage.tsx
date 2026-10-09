import { useState } from "react";
import { twinApi } from "../../api/twinApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { DataOrigin } from "../../types/operations";
import type { Assumption, SensitivityResult } from "../../types/twin";
import { ORIGIN_DESCRIPTIONS } from "../../utils/format";
import { fmt } from "../../utils/twin";
import { DataLabel } from "../../components/DataLabel";
import { SimPanel } from "../../components/twin/SimPanel";
import { SnapshotBar, useSnapshotSelection } from "../../components/twin/SnapshotBar";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../../components/ui";

const ORIGINS: DataOrigin[] = ["observed", "synthetic", "assumed", "simulated", "derived"];

function show(value: unknown): string {
  if (typeof value === "number") return fmt(value, value < 10 ? 3 : 1);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k.replace("_", " ")} ${typeof v === "number" ? fmt(v, 2) : typeof v === "object" ? show(v) : String(v)}`)
      .join(", ");
  }
  return String(value ?? "—");
}

const SWEEPS = {
  demand: { label: "Demand multiplier", values: "0.5, 1, 1.5, 2, 2.5" },
  service_time: { label: "Service time multiplier", values: "0.8, 1, 1.2, 1.5" },
  staff: { label: "Technical support staff added (negative removes)", values: "-2, -1, 0, 1, 2" },
} as const;

function Sensitivity({ snapshotId }: { snapshotId: string }) {
  const [parameter, setParameter] = useState<keyof typeof SWEEPS>("demand");
  const [values, setValues] = useState<string>(SWEEPS.demand.values);
  const [result, setResult] = useState<SensitivityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const vs = values.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v)).slice(0, 8);
      setResult(await twinApi.sensitivity({ snapshot_id: snapshotId, parameter, values: vs, base: { replications: 5, duration_hours: 8 } }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SimPanel title="Sensitivity analysis">
      <p className="mt-0 text-sm text-muted">How much do the predictions depend on one input? Each value runs 5 replications over 8 hours.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="ot-field ot-field-inline m-0">
          <span>Input</span>
          <select value={parameter} onChange={(e) => { const k = e.target.value as keyof typeof SWEEPS; setParameter(k); setValues(SWEEPS[k].values); }}>
            {Object.entries(SWEEPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="ot-field ot-field-inline m-0">
          <span>Values (comma separated)</span>
          <input value={values} onChange={(e) => setValues(e.target.value)} />
        </label>
        <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Simulating…" : "Run sweep"}
        </button>
      </div>
      <ErrorNotice error={error} />
      {result && (
        <div className="ot-table-wrap mt-4">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">{SWEEPS[result.parameter].label}</th>
                <th scope="col">Completed per hour</th>
                <th scope="col">Mean wait (min)</th>
                <th scope="col">P95 wait (min)</th>
                <th scope="col">Backlog at the end</th>
                <th scope="col">SLA compliance (%)</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r) => (
                <tr key={r.value}>
                  <th scope="row">{r.value}</th>
                  <td className="tabular-nums">{fmt(r.summary.throughput_per_hour, 2)}</td>
                  <td className="tabular-nums">{fmt(r.summary.mean_wait_min, 1)}</td>
                  <td className="tabular-nums">{fmt(r.summary.p95_wait_min, 0)}</td>
                  <td className="tabular-nums">{fmt(r.summary.ending_backlog, 1)}</td>
                  <td className="tabular-nums">{fmt(r.summary.sla_compliance_pct, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SimPanel>
  );
}

export default function AssumptionsPage() {
  const { can } = useAuth();
  const { list, selectedId, select } = useSnapshotSelection();
  const snapshot = useResource((signal) => (selectedId ? twinApi.snapshot(selectedId, signal) : Promise.resolve(null)), [selectedId]);
  const s = snapshot.data;
  const byOrigin = (o: DataOrigin) => s?.assumptions.filter((a) => a.origin === o) ?? [];

  return (
    <div className="ot-page">
      <PageHeader
        title="Model assumptions"
        description="Where every input to the twin comes from, how much data supports it, and what the model can't tell you."
      />
      <section className="ot-panel">
        <h2>How to read the labels</h2>
        <dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {ORIGINS.map((o) => (
            <div key={o}>
              <dt><DataLabel origin={o} /></dt>
              <dd className="m-0 mt-1 text-sm text-muted">{ORIGIN_DESCRIPTIONS[o]}</dd>
            </div>
          ))}
        </dl>
      </section>
      {list.data && (
        <SnapshotBar snapshots={list.data} selectedId={selectedId} onSelect={select}
                     onCreated={(x) => { list.setData((prev) => [x, ...(prev ?? [])]); select(x.id); }} />
      )}
      {list.data?.length === 0 && <EmptyState title="No snapshot yet">Refresh the twin to estimate the model from live data.</EmptyState>}
      {snapshot.error ? <ErrorNotice error={snapshot.error} /> : null}
      {snapshot.loading && !s && selectedId && <Loading label="Loading assumptions" />}
      {s && (
        <>
          <section className="ot-panel">
            <h2>Inputs for this snapshot</h2>
            <p className="text-sm text-muted">
              Estimated from {s.coverage.tickets_in_lookback} tickets over {fmt(s.coverage.days_covered, 1)} days. {byOrigin("observed").length} inputs observed,{" "}
              {byOrigin("derived").length} derived, {byOrigin("assumed").length} assumed. Inputs without enough data use labelled defaults.
            </p>
            <div className="ot-table-wrap">
              <table className="ot-table">
                <thead>
                  <tr>
                    <th scope="col">Input</th>
                    <th scope="col">Value</th>
                    <th scope="col">Source</th>
                    <th scope="col">Records behind it</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {s.assumptions.map((a: Assumption) => (
                    <tr key={a.key}>
                      <th scope="row" className="font-normal">{a.label}</th>
                      <td className="max-w-md text-sm tabular-nums">
                        {show(a.value)} {typeof a.value === "number" && <span className="text-muted">{a.unit}</span>}
                      </td>
                      <td><DataLabel origin={a.origin} /></td>
                      <td className="tabular-nums">{a.sample_size ?? "—"}</td>
                      <td className="text-sm text-muted">{a.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-muted">
              SLA resolution targets in this snapshot:{" "}
              {Object.entries(s.sla_resolution_minutes).map(([k, v]) => `${k} ${v} min`).join(", ")}. Every scenario can override any of these values.
            </p>
          </section>
          <section className="ot-panel">
            <h2>Limitations</h2>
            <ul className="m-0 pl-5">
              {s.limitations.map((l) => <li key={l} className="mb-1">{l}</li>)}
            </ul>
          </section>
          {can(P.SIMULATIONS_RUN) && <Sensitivity snapshotId={s.id} />}
        </>
      )}
    </div>
  );
}
