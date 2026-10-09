import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { twinApi } from "../../api/twinApi";
import { useResource } from "../../hooks/useResource";
import { DEFAULT_CONSTRAINTS, type Constraints, type Evaluation, type RecommendationCard } from "../../types/twin";
import { STRATEGY_NAMES, fmt, strategyColor } from "../../utils/twin";
import RequestChangeButton from "../../components/RequestChangeButton";
import { DataLabel } from "../../components/DataLabel";
import { DiffTable, EmptyState, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

const CONSTRAINT_FIELDS: { key: keyof Constraints; label: string; unit: string; step: number; help: string }[] = [
  { key: "min_p1_sla_compliance_pct", label: "Minimum critical (P1) SLA compliance", unit: "%", step: 1, help: "Critical tickets met on time" },
  { key: "min_sla_compliance_pct", label: "Minimum overall SLA compliance", unit: "%", step: 1, help: "All tickets with a deadline in the window" },
  { key: "max_ending_backlog", label: "Maximum backlog at the end", unit: "tickets", step: 1, help: "Tickets still open when the period ends" },
  { key: "min_throughput_ratio", label: "Minimum throughput vs normal", unit: "× baseline", step: 0.05, help: "Completed per hour compared with scenario A" },
  { key: "max_mean_wait_min", label: "Maximum mean wait", unit: "min", step: 5, help: "Average queue time per ticket" },
  { key: "max_stage_wait_increase_min", label: "Maximum extra wait in another stage", unit: "min", step: 1, help: "Protects the stage that gives up capacity" },
  { key: "min_feasible_share", label: "Share of replications that must pass", unit: "0–1", step: 0.05, help: "Guards against lucky averages" },
];

function StatusPills({ r }: { r: RecommendationCard }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {r.selected && <span className="ot-pill ot-pill-sel">Recommended</span>}
      {r.is_no_action ? (
        <span className="ot-pill ot-pill-neutral">No change</span>
      ) : r.feasible ? (
        <span className="ot-pill ot-pill-ok">Meets every limit</span>
      ) : (
        <span className="ot-pill ot-pill-bad">Rejected: unsafe</span>
      )}
      {r.pareto_efficient && !r.selected && <span className="ot-pill ot-pill-neutral">Efficient trade-off</span>}
      {r.stale && <span className="ot-pill ot-pill-bad">Stale</span>}
    </span>
  );
}

function Card({ r, minShare }: { r: RecommendationCard; minShare: number }) {
  const headline = r.expected_changes.filter((c) =>
    ["throughput_per_hour", "mean_wait_min", "p95_wait_min", "ending_backlog", "sla_compliance_pct", "p1_sla_compliance_pct"].includes(c.metric));
  const stages = r.expected_changes.filter((c) => c.metric.startsWith("stage_mean_wait_min."));
  return (
    <article className={`ot-panel ot-sim ${r.selected ? "ring-1 ring-signal" : ""}`} aria-labelledby={`rec-${r.id}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-sm text-muted">
            <span className="ot-swatch" style={{ background: strategyColor(r.strategy_key) }} aria-hidden="true" />
            Strategy {r.strategy_key}: {STRATEGY_NAMES[r.strategy_key] ?? ""}
          </p>
          <h2 id={`rec-${r.id}`} className="m-0 mt-1">
            {r.title}
          </h2>
        </div>
        <StatusPills r={r} />
      </header>
      <p className={r.feasible || r.is_no_action ? "" : "text-bad"}>{r.explanation}</p>
      {r.stale && (
        <Notice tone="warning">
          The live configuration moved from {r.source_config_version} to {r.current_config_version} after this simulation. Run a new stress test before
          requesting this change.
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <div>
          <h3 className="mt-0">Expected effect</h3>
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Normal (A)</th>
                  <th scope="col">Failure (B)</th>
                  <th scope="col">This option</th>
                </tr>
              </thead>
              <tbody>
                {[...headline, ...stages].map((c) => (
                  <tr key={c.metric}>
                    <th scope="row" className="font-normal">
                      {c.label}
                      {c.unit && <span className="text-muted"> ({c.unit})</span>}
                    </th>
                    <td className="tabular-nums">{fmt(c.normal_baseline, 1)}</td>
                    <td className="tabular-nums">{fmt(c.failure_baseline, 1)}</td>
                    <td className={`tabular-nums ${c.better === true ? "ot-better" : c.better === false ? "ot-worse" : ""}`}>
                      {fmt(c.strategy, 1)}
                      {c.delta_vs_failure !== null && c.better !== null && (
                        <span className="ml-1 text-xs">({c.delta_vs_failure > 0 ? "+" : ""}{fmt(c.delta_vs_failure, 1)})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3 className="mt-0">Safety limits</h3>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {r.constraint_checks.map((c) => {
              const ok = c.passed && c.pass_share >= minShare;
              return (
                <li key={c.key} className="flex items-start gap-2 text-sm">
                  <span aria-hidden="true" className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 ${ok ? "rounded-full bg-ok" : "rotate-45 bg-bad"}`} />
                  <span>
                    <span className={ok ? "" : "text-bad"}>{c.message}</span>
                    <span className="block text-xs text-muted">Holds in {Math.round(c.pass_share * 100)}% of replications</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {(r.benefits.length > 0 || r.drawbacks.length > 0) && (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="mt-0">Benefits</h3>
            {r.benefits.length ? <ul className="m-0 pl-5 text-sm">{r.benefits.map((b) => <li key={b}>{b}</li>)}</ul> : <p className="text-sm text-muted">None above 5%.</p>}
          </div>
          <div>
            <h3 className="mt-0">Drawbacks</h3>
            {r.drawbacks.length ? <ul className="m-0 pl-5 text-sm">{r.drawbacks.map((b) => <li key={b}>{b}</li>)}</ul> : <p className="text-sm text-muted">None found.</p>}
          </div>
        </div>
      )}

      {!r.is_no_action && (
        <>
          <h3>Exact configuration change if approved</h3>
          <DiffTable rows={r.config_diff} />
          <p className="mt-2 text-sm text-muted">
            Affects {r.affected_departments.map((d) => d.name).join(" and ")}. {r.approval_required ? "Needs approval from each affected department before it can be applied." : ""}
            {r.estimated_cost !== null ? ` Estimated cost: ${fmt(r.estimated_cost, 2)}.` : ""}
          </p>
        </>
      )}

      <details className="ot-details mt-3">
        <summary>Evidence, assumptions and uncertainty</summary>
        <ul className="m-0 pl-5 text-sm">
          <li>
            Simulated on snapshot from configuration <span className="ot-mono">{r.evidence.config_version}</span>, {r.evidence.replications} replications.{" "}
            {r.uncertainty}
          </li>
          <li>
            Runs:{" "}
            <Link className="ot-link" to={`/simulations/${r.evidence.strategy_run_id}`}>this option</Link>,{" "}
            <Link className="ot-link" to={`/simulations/${r.evidence.failure_run_id}`}>failure</Link>,{" "}
            <Link className="ot-link" to={`/simulations/${r.evidence.normal_run_id}`}>normal</Link>
          </li>
          {r.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>

      {r.feasible && !r.is_no_action && !r.stale && (
        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <RequestChangeButton recommendationId={r.id} affectedDepartmentIds={r.affected_departments.map((d) => d.id)} />
        </div>
      )}
    </article>
  );
}

export default function RecommendationsPage() {
  const [params, setParams] = useSearchParams();
  const tests = useResource((signal) => twinApi.stressTests(20, signal), []);
  const stId = params.get("stress_test") ?? tests.data?.[0]?.id ?? null;
  const evaluations = useResource((signal) => (stId ? twinApi.evaluations(stId, signal) : Promise.resolve([] as Evaluation[])), [stId]);
  const [constraints, setConstraints] = useState<Constraints>(DEFAULT_CONSTRAINTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const autoRan = useRef<string | null>(null);

  const latest = evaluations.data?.[0] ?? null;
  useEffect(() => {
    if (latest) setConstraints({ ...DEFAULT_CONSTRAINTS, ...latest.constraints });
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = async (c: Constraints) => {
    if (!stId) return;
    setBusy(true);
    setError(null);
    try {
      const ev = await twinApi.evaluate(stId, c);
      evaluations.setData((prev) => [ev, ...(prev ?? [])]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (params.get("evaluate") === "1" && stId && evaluations.data && evaluations.data.length === 0 && autoRan.current !== stId) {
      autoRan.current = stId;
      void evaluate(DEFAULT_CONSTRAINTS);
    }
  }, [stId, evaluations.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const order = (r: RecommendationCard) => (r.selected ? 0 : r.is_no_action ? 3 : r.feasible ? 1 : 2);
  const cards = latest ? [...latest.recommendations].sort((a, b) => order(a) - order(b)) : [];

  return (
    <div className="ot-page">
      <PageHeader
        title="Recommendations"
        description="Every option is checked against hard safety limits first. Only options that pass are compared; nothing is applied without approval."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="ot-field ot-field-inline m-0">
          <span>Stress test</span>
          <select value={stId ?? ""} onChange={(e) => setParams(new URLSearchParams({ stress_test: e.target.value }), { replace: true })}>
            {tests.data?.length === 0 && <option value="">No stress tests yet</option>}
            {tests.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {formatDateTime(t.created_at)}: {t.settings.demand_multiplier}× demand, {t.settings.removed_resource.name} out
              </option>
            ))}
          </select>
        </label>
        {stId && (
          <Link className="ot-link pb-2 text-sm" to={`/stress-test?id=${stId}`}>
            See the stress test
          </Link>
        )}
      </div>
      {tests.data?.length === 0 && <EmptyState title="Nothing to recommend yet">Run a stress test first; recommendations compare its strategies.</EmptyState>}

      {stId && (
        <details className="ot-panel ot-details" open={!latest}>
          <summary>Safety limits{latest ? " (change and re-evaluate)" : ""}</summary>
          <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4">
            {CONSTRAINT_FIELDS.map((f) => (
              <label key={f.key} className="ot-field">
                <span>{f.label}</span>
                <input type="number" step={f.step} value={(constraints[f.key] as number | null) ?? ""}
                       onChange={(e) => setConstraints({ ...constraints, [f.key]: Number(e.target.value) })} />
                <small>{f.help} ({f.unit})</small>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => setConstraints(DEFAULT_CONSTRAINTS)}>
              Restore defaults
            </button>
            <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void evaluate(constraints)}>
              {busy ? "Evaluating…" : "Evaluate strategies"}
            </button>
          </div>
        </details>
      )}
      <ErrorNotice error={error} />
      {evaluations.loading && !evaluations.data && <Loading label="Loading recommendations" />}
      {busy && !latest && <Loading label="Evaluating strategies" />}

      {latest && (
        <>
          <div className={`mb-5 rounded-md border px-4 py-3 ${latest.selected_recommendation_id ? "border-signal/60 bg-signal/5" : "border-warn/60 bg-warn/5"}`} role="status">
            <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
              {latest.outcome} <DataLabel origin="simulated" />
            </p>
            <p className="m-0 mt-1 text-xs text-muted">Evaluated {formatDateTime(latest.created_at)}. Based on simulated predictions, not observed outcomes.</p>
          </div>
          {cards.map((r) => (
            <Card key={r.id} r={r} minShare={latest.constraints.min_feasible_share ?? DEFAULT_CONSTRAINTS.min_feasible_share} />
          ))}
        </>
      )}
    </div>
  );
}
