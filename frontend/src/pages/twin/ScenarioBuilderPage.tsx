import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isApiError } from "../../api/http";
import { twinApi } from "../../api/twinApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { Priority, StageKey } from "../../types/operations";
import { DEFAULT_PARAMETERS, type Scenario, type ScenarioParameters, type SimulationRun, type Snapshot } from "../../types/twin";
import { CATEGORIES, CATEGORY_LABELS, PRIORITIES, PRIORITY_LABELS, STAGES, STAGE_LABELS, formatMinutes } from "../../utils/format";
import { STRATEGY_COLORS } from "../../utils/twin";
import { DataLabel } from "../../components/DataLabel";
import { MetricCompareTable } from "../../components/twin/MetricCompareTable";
import { SimPanel } from "../../components/twin/SimPanel";
import { SnapshotBar, useSnapshotSelection } from "../../components/twin/SnapshotBar";
import { EmptyState, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

interface Draft {
  id: string | null;
  version: number;
  name: string;
  description: string;
  parameters: ScenarioParameters;
}

const newDraft = (): Draft => ({ id: null, version: 0, name: "New scenario", description: "", parameters: structuredClone(DEFAULT_PARAMETERS) });

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <fieldset className="mb-5 border-0 border-t border-line p-0 pt-4">
      <legend className="pr-2 text-base font-semibold">{title}</legend>
      {note && <p className="mt-0 text-sm text-muted">{note}</p>}
      {children}
    </fieldset>
  );
}

function ParameterForm({ p, set, snapshot, disabled }: {
  p: ScenarioParameters;
  set: (fn: (p: ScenarioParameters) => ScenarioParameters) => void;
  snapshot: Snapshot;
  disabled: boolean;
}) {
  const staff = (snapshot.resources ?? []).filter((r) => r.is_available);
  const regular = staff.filter((r) => !r.is_reserve || r.reserve_active);
  const reserves = staff.filter((r) => r.is_reserve && !r.reserve_active);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const moveTarget = (id: string) => p.reallocations.find((r) => r.resource_id === id)?.to_stage ?? "";
  const observedMean = snapshot.model.arrival_profile.values.reduce((a, b) => a + b, 0) / 24;
  const routing = snapshot.config.routing ?? {};

  return (
    <fieldset disabled={disabled} className="m-0 border-0 p-0">
      <Section title="Demand">
        <div className="grid gap-x-4 sm:grid-cols-3">
          <label className="ot-field">
            <span>Demand multiplier: {p.demand_multiplier.toFixed(2)}×</span>
            <input type="range" min={0} max={4} step={0.05} value={p.demand_multiplier}
                   onChange={(e) => set((x) => ({ ...x, demand_multiplier: num(e.target.value, 1) }))} />
          </label>
          <label className="ot-field">
            <span>Average arrivals per hour</span>
            <input type="number" min={0} step={0.1} placeholder={`${observedMean.toFixed(2)} (from the snapshot)`}
                   value={p.base_arrival_rate_per_hour ?? ""}
                   onChange={(e) => set((x) => ({ ...x, base_arrival_rate_per_hour: e.target.value === "" ? null : num(e.target.value, 0) }))} />
            <small>Leave blank to use the snapshot's hourly pattern.</small>
          </label>
          <label className="ot-field">
            <span>Simulated period (hours)</span>
            <input type="number" min={1} max={72} value={p.duration_hours}
                   onChange={(e) => set((x) => ({ ...x, duration_hours: Math.min(72, Math.max(1, num(e.target.value, 8))) }))} />
          </label>
        </div>
        <label className="ot-check border-t-0">
          <input type="checkbox" checked={p.category_mix !== null}
                 onChange={(e) => set((x) => ({ ...x, category_mix: e.target.checked ? { ...snapshot.model.category_mix.values } : null }))} />
          <span>Override the category mix</span>
        </label>
        {p.category_mix && (
          <div className="grid gap-x-3 sm:grid-cols-5">
            {CATEGORIES.map((c) => (
              <label key={c} className="ot-field">
                <span>{CATEGORY_LABELS[c]}</span>
                <input type="number" min={0} step={0.05} value={p.category_mix?.[c] ?? 0}
                       onChange={(e) => set((x) => ({ ...x, category_mix: { ...(x.category_mix ?? {}), [c]: num(e.target.value, 0) } }))} />
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="Staffing" note="Hypothetical: these changes exist only in the simulation. Real staff records don't change.">
        <div className="ot-table-wrap">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Staff member</th>
                <th scope="col">Stage</th>
                <th scope="col">Shift</th>
                <th scope="col">Unavailable in scenario</th>
                <th scope="col">Move to</th>
              </tr>
            </thead>
            <tbody>
              {regular.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{STAGE_LABELS[r.stage]}</td>
                  <td className="tabular-nums">{r.shift_start === r.shift_end ? "On call" : `${r.shift_start}–${r.shift_end}`}</td>
                  <td>
                    <input type="checkbox" aria-label={`${r.name} unavailable`} checked={p.removed_resource_ids.includes(r.id)}
                           onChange={() => set((x) => ({ ...x, removed_resource_ids: toggle(x.removed_resource_ids, r.id) }))} />
                  </td>
                  <td>
                    <select className="ot-select-sm" aria-label={`Move ${r.name}`} value={moveTarget(r.id)}
                            onChange={(e) => set((x) => ({
                              ...x,
                              reallocations: [
                                ...x.reallocations.filter((m) => m.resource_id !== r.id),
                                ...(e.target.value ? [{ resource_id: r.id, to_stage: e.target.value as StageKey }] : []),
                              ],
                            }))}>
                      <option value="">Stays</option>
                      {STAGES.filter((s) => s !== r.stage).map((s) => (
                        <option key={s} value={s}>
                          {STAGE_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {reserves.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-sm font-medium">Reserve capacity</p>
            {reserves.map((r) => (
              <label key={r.id} className="ot-check">
                <input type="checkbox" checked={p.activate_reserve_ids.includes(r.id)}
                       onChange={() => set((x) => ({ ...x, activate_reserve_ids: toggle(x.activate_reserve_ids, r.id) }))} />
                <span>
                  Activate {r.name}
                  <small>{STAGE_LABELS[r.stage]}, {r.skills.map((s) => CATEGORY_LABELS[s]).join(", ")}</small>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="mt-3 grid gap-x-3 sm:grid-cols-4">
          {STAGES.map((s) => (
            <label key={s} className="ot-field">
              <span>Extra hypothetical staff, {STAGE_LABELS[s]}</span>
              <input type="number" min={0} max={20} value={p.extra_staff[s] ?? 0}
                     onChange={(e) => set((x) => ({ ...x, extra_staff: { ...x.extra_staff, [s]: Math.max(0, Math.min(20, num(e.target.value, 0))) } }))} />
            </label>
          ))}
        </div>
        <p className="mb-1 mt-2 text-sm font-medium">Temporary unavailability</p>
        {p.resource_unavailability.map((u, i) => (
          <div key={i} className="mb-2 grid items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <label className="ot-field m-0">
              <span>Staff member</span>
              <select value={u.resource_id} onChange={(e) => set((x) => ({ ...x, resource_unavailability: x.resource_unavailability.map((w, j) => (j === i ? { ...w, resource_id: e.target.value } : w)) }))}>
                {regular.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="ot-field m-0">
              <span>From minute</span>
              <input type="number" min={0} value={u.from_minute}
                     onChange={(e) => set((x) => ({ ...x, resource_unavailability: x.resource_unavailability.map((w, j) => (j === i ? { ...w, from_minute: Math.max(0, num(e.target.value, 0)) } : w)) }))} />
            </label>
            <label className="ot-field m-0">
              <span>Back at minute</span>
              <input type="number" min={1} placeholder="Not back" value={u.to_minute ?? ""}
                     onChange={(e) => set((x) => ({ ...x, resource_unavailability: x.resource_unavailability.map((w, j) => (j === i ? { ...w, to_minute: e.target.value === "" ? null : num(e.target.value, 60) } : w)) }))} />
            </label>
            <button type="button" className="ot-btn ot-btn-quiet" onClick={() => set((x) => ({ ...x, resource_unavailability: x.resource_unavailability.filter((_, j) => j !== i) }))}>
              Remove
            </button>
          </div>
        ))}
        {regular.length > 0 && (
          <button type="button" className="ot-btn ot-btn-quiet"
                  onClick={() => set((x) => ({ ...x, resource_unavailability: [...x.resource_unavailability, { resource_id: regular[0].id, from_minute: 60, to_minute: 180 }] }))}>
            Add an absence
          </button>
        )}
      </Section>

      <Section title="Routing and service">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <label className="ot-field">
            <span>Queue policy</span>
            <select value={p.routing_policy ?? ""} onChange={(e) => set((x) => ({ ...x, routing_policy: (e.target.value || null) as ScenarioParameters["routing_policy"] }))}>
              <option value="">Live configuration ({routing.policy ?? "fifo"})</option>
              <option value="fifo">First in, first out</option>
              <option value="priority">Priority first</option>
              <option value="smart_triage">Smart triage (priority, skill-aware, careful classification)</option>
            </select>
          </label>
          <label className="ot-field">
            <span>Skill-aware routing in technical support</span>
            <select value={p.skill_aware_routing === null ? "" : String(p.skill_aware_routing)}
                    onChange={(e) => set((x) => ({ ...x, skill_aware_routing: e.target.value === "" ? null : e.target.value === "true" }))}>
              <option value="">Follow the policy</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        </div>
        <div className="grid gap-x-3 sm:grid-cols-4">
          {STAGES.map((s) => (
            <label key={s} className="ot-field">
              <span>Service time, {STAGE_LABELS[s]}</span>
              <input type="number" min={0.1} max={5} step={0.05} value={p.service_time_multipliers[s] ?? 1}
                     onChange={(e) => set((x) => ({ ...x, service_time_multipliers: { ...x.service_time_multipliers, [s]: Math.max(0.1, num(e.target.value, 1)) } }))} />
              <small>× the estimated time</small>
            </label>
          ))}
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <label className="ot-field">
            <span>Rework rate after verification</span>
            <input type="number" min={0} max={0.9} step={0.01} placeholder={`${snapshot.model.rework_rate.value} (${snapshot.model.rework_rate.origin})`}
                   value={p.rework_rate ?? ""} onChange={(e) => set((x) => ({ ...x, rework_rate: e.target.value === "" ? null : Math.min(0.9, Math.max(0, num(e.target.value, 0))) }))} />
          </label>
          <label className="ot-field">
            <span>Misrouting (transfer) rate</span>
            <input type="number" min={0} max={0.9} step={0.01} placeholder={`${snapshot.model.transfer_rate.value} (${snapshot.model.transfer_rate.origin})`}
                   value={p.transfer_rate ?? ""} onChange={(e) => set((x) => ({ ...x, transfer_rate: e.target.value === "" ? null : Math.min(0.9, Math.max(0, num(e.target.value, 0))) }))} />
          </label>
        </div>
      </Section>

      <Section title="SLA targets" note="Resolution targets in minutes. Leave blank to keep the snapshot's values.">
        <div className="grid gap-x-3 sm:grid-cols-4">
          {PRIORITIES.map((pr: Priority) => (
            <label key={pr} className="ot-field">
              <span>{PRIORITY_LABELS[pr]}</span>
              <input type="number" min={1} placeholder={`${snapshot.sla_resolution_minutes[pr]} (${formatMinutes(snapshot.sla_resolution_minutes[pr])})`}
                     value={p.sla_resolution_minutes[pr] ?? ""}
                     onChange={(e) => set((x) => {
                       const next = { ...x.sla_resolution_minutes };
                       if (e.target.value === "") delete next[pr];
                       else next[pr] = Math.max(1, num(e.target.value, 60));
                       return { ...x, sla_resolution_minutes: next };
                     })} />
            </label>
          ))}
        </div>
      </Section>

      <Section title="Simulation settings">
        <div className="grid gap-x-4 sm:grid-cols-3">
          <label className="ot-field">
            <span>Random seed</span>
            <input type="number" min={0} value={p.seed} onChange={(e) => set((x) => ({ ...x, seed: Math.max(0, Math.round(num(e.target.value, 42))) }))} />
          </label>
          <label className="ot-field">
            <span>Replications</span>
            <input type="number" min={1} max={30} value={p.replications}
                   onChange={(e) => set((x) => ({ ...x, replications: Math.min(30, Math.max(1, Math.round(num(e.target.value, 10)))) }))} />
          </label>
          <label className="ot-check border-t-0 pt-6">
            <input type="checkbox" checked={p.respect_shifts} onChange={(e) => set((x) => ({ ...x, respect_shifts: e.target.checked }))} />
            <span>
              Follow staff shifts
              <small>Off assumes everyone works the whole period.</small>
            </span>
          </label>
        </div>
      </Section>
    </fieldset>
  );
}

export default function ScenarioBuilderPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canRun = can(P.SIMULATIONS_RUN);
  const { list, selectedId, select } = useSnapshotSelection();
  const snapshot = useResource((signal) => (selectedId ? twinApi.snapshot(selectedId, signal) : Promise.resolve(null)), [selectedId]);
  const scenarios = useResource((signal) => (selectedId ? twinApi.scenarios(selectedId, signal) : Promise.resolve([] as Scenario[])), [selectedId]);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [saved, setSaved] = useState<string>(JSON.stringify(newDraft()));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<SimulationRun | null>(null);
  const [result, setResult] = useState<SimulationRun | null>(null);

  useEffect(() => {
    const d = newDraft();
    setDraft(d);
    setSaved(JSON.stringify(d));
    setBaseline(null);
    setResult(null);
  }, [selectedId]);

  const dirty = useMemo(() => JSON.stringify(draft) !== saved, [draft, saved]);
  const setParams = (fn: (p: ScenarioParameters) => ScenarioParameters) => setDraft((d) => ({ ...d, parameters: fn(d.parameters) }));

  const load = (s: Scenario) => {
    const d: Draft = { id: s.id, version: s.version, name: s.name, description: s.description ?? "", parameters: { ...DEFAULT_PARAMETERS, ...s.parameters } };
    setDraft(d);
    setSaved(JSON.stringify(d));
    setResult(null);
  };

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(isApiError(e) && e.status === 409 ? new Error("This scenario changed elsewhere. Reload it from the list and try again.") : e);
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<Scenario | null> => {
    if (!selectedId) return null;
    const body = { name: draft.name.trim() || "Untitled scenario", description: draft.description || null, parameters: draft.parameters };
    const s = draft.id
      ? await twinApi.updateScenario(draft.id, { version: draft.version, ...body })
      : await twinApi.createScenario({ ...body, snapshot_id: selectedId });
    load(s);
    scenarios.reload();
    return s;
  };

  const snap = snapshot.data;

  return (
    <div className="ot-page">
      <PageHeader
        title="Scenario builder"
        description="Change demand, staffing, routing and SLA targets hypothetically, then simulate. Nothing here touches live tickets or staff."
      />
      {list.data && (
        <SnapshotBar snapshots={list.data} selectedId={selectedId} onSelect={select}
                     onCreated={(s) => { list.setData((prev) => [s, ...(prev ?? [])]); select(s.id); }} />
      )}
      {list.data?.length === 0 && <EmptyState title="No snapshot yet">Refresh the twin first; scenarios are built on a snapshot.</EmptyState>}
      {notice && <Notice tone="success">{notice}</Notice>}
      <ErrorNotice error={error} />

      {snap && (
        <div className="grid items-start gap-5 xl:grid-cols-[17rem_1fr]">
          <nav className="ot-split-list" aria-label="Saved scenarios">
            <button type="button" className={`ot-list-item mb-2 ${draft.id === null ? "is-active" : ""}`} onClick={() => { const d = newDraft(); setDraft(d); setSaved(JSON.stringify(d)); setResult(null); }}>
              <span>New scenario</span>
              <small>Start from the snapshot as it is</small>
            </button>
            {scenarios.loading && !scenarios.data ? <Loading label="Loading scenarios" /> : null}
            <ul>
              {scenarios.data?.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`ot-list-item ${draft.id === s.id ? "is-active" : ""}`} onClick={() => load(s)}>
                    <span>{s.name}</span>
                    <small>Updated {formatDateTime(s.updated_at)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <section className="ot-panel">
              <div className="grid gap-x-4 sm:grid-cols-[1fr_2fr]">
                <label className="ot-field">
                  <span>Scenario name</span>
                  <input value={draft.name} disabled={!canRun} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label className="ot-field">
                  <span>What it tests</span>
                  <input value={draft.description} disabled={!canRun} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                         placeholder="e.g. exam week demand with one technician on leave" />
                </label>
              </div>
              <ParameterForm p={draft.parameters} set={setParams} snapshot={snap} disabled={!canRun} />
              {canRun && (
                <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                  <button type="button" className="ot-btn ot-btn-quiet" disabled={!!busy || !dirty}
                          onClick={() => void act("save", async () => { await save(); setNotice("Scenario saved."); })}>
                    {busy === "save" ? "Saving…" : "Save scenario"}
                  </button>
                  <button type="button" className="ot-btn ot-btn-quiet" disabled={!!busy || !draft.id}
                          onClick={() => void act("clone", async () => {
                            const c = await twinApi.cloneScenario(draft.id!, { name: `${draft.name} (copy)` });
                            load(c);
                            scenarios.reload();
                            setNotice("Scenario cloned.");
                          })}>
                    Clone
                  </button>
                  <button type="button" className="ot-btn ot-btn-quiet" disabled={!!busy}
                          onClick={() => setParams(() => structuredClone(DEFAULT_PARAMETERS))}>
                    Reset parameters
                  </button>
                  {draft.id && list.data?.[0] && list.data[0].id !== selectedId && (
                    <button type="button" className="ot-btn ot-btn-quiet" disabled={!!busy}
                            onClick={() => void act("rebase", async () => {
                              const c = await twinApi.cloneScenario(draft.id!, { name: draft.name, snapshot_id: list.data![0].id });
                              select(c.snapshot_id);
                              setNotice("Copied onto the latest snapshot.");
                            })}>
                      Copy onto the latest snapshot
                    </button>
                  )}
                  <span className="ml-auto flex flex-wrap gap-2">
                    <button type="button" className="ot-btn ot-btn-quiet" disabled={!!busy}
                            onClick={() => void act("baseline", async () => {
                              setBaseline(await twinApi.runAdHoc(snap.id, { duration_hours: draft.parameters.duration_hours,
                                seed: draft.parameters.seed, replications: draft.parameters.replications,
                                respect_shifts: draft.parameters.respect_shifts }, "Baseline (no changes)"));
                            })}>
                      {busy === "baseline" ? "Simulating…" : "Run baseline"}
                    </button>
                    <button type="button" className="ot-btn ot-btn-primary" disabled={!!busy}
                            onClick={() => void act("run", async () => {
                              const s = dirty || !draft.id ? await save() : null;
                              const id = s?.id ?? draft.id!;
                              setResult(await twinApi.runScenario(id));
                            })}>
                      {busy === "run" ? "Simulating…" : dirty || !draft.id ? "Save and run scenario" : "Run scenario"}
                    </button>
                  </span>
                </div>
              )}
            </section>

            {(baseline || result) && (
              <SimPanel title="Results" actions={
                baseline && result ? (
                  <button type="button" className="ot-btn ot-btn-quiet" onClick={() => navigate(`/results?runs=${baseline.id},${result.id}`)}>
                    Compare in detail
                  </button>
                ) : null
              }>
                <MetricCompareTable
                  referenceKey={baseline ? "base" : undefined}
                  columns={[
                    ...(baseline?.metrics ? [{ key: "base", label: "Baseline", color: STRATEGY_COLORS.A, metrics: baseline.metrics.scalars }] : []),
                    ...(result?.metrics ? [{ key: "scen", label: draft.name || "Scenario", color: STRATEGY_COLORS.C, metrics: result.metrics.scalars }] : []),
                  ]}
                  metrics={["throughput_per_hour", "mean_wait_min", "p95_wait_min", "max_backlog", "ending_backlog", "sla_compliance_pct",
                            "p1_sla_compliance_pct", "unfinished", "recovery_time_min"]}
                />
                <p className="mt-2 flex flex-wrap gap-4 text-sm">
                  {baseline && <Link className="ot-link" to={`/simulations/${baseline.id}`}>Open baseline run</Link>}
                  {result && <Link className="ot-link" to={`/simulations/${result.id}`}>Open scenario run</Link>}
                  <span className="text-muted">Colour shows better or worse than the baseline.</span>
                </p>
              </SimPanel>
            )}
            <p className="flex items-center gap-2 text-xs text-muted">
              <DataLabel origin="assumed" /> Placeholders show the snapshot's values; blank fields keep them.
            </p>
          </div>
        </div>
      )}
      {snapshot.loading && !snap && selectedId && <Loading label="Loading snapshot" />}
    </div>
  );
}

