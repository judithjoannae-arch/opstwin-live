import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { aiApi } from "../../api/aiApi";
import { useAuth } from "../../auth/AuthContext";
import { P } from "../../auth/permissions";
import { useResource } from "../../hooks/useResource";
import type { AiSettings, MonitorOutcome, MonitorRun } from "../../types/ai";
import { CATEGORY_LABELS } from "../../utils/format";
import { AiBadge, ConfidenceBar } from "../../components/AiBadge";
import { EmptyState, ErrorNotice, Loading, Notice, PageHeader, formatDateTime } from "../../components/ui";

const OUTCOME: Record<MonitorOutcome, { text: string; cls: string }> = {
  healthy: { text: "All clear", cls: "ot-pill-ok" },
  risk_recommended: { text: "Proposal raised", cls: "ot-pill-sel" },
  risk_no_safe_option: { text: "Needs a manager", cls: "ot-pill-bad" },
  risk_resolves: { text: "Watching, no change needed", cls: "ot-pill-neutral" },
  skipped: { text: "Proposal already waiting", cls: "ot-pill-neutral" },
  error: { text: "Check failed", cls: "ot-pill-bad" },
};

const ACTION_TEXT = { auto_applied: "Handled automatically", left_for_human: "Left for a person", suggested: "Suggested only" };

function Switches() {
  const { can } = useAuth();
  const editable = can(P.POLICIES_MANAGE, { global: true });
  const loaded = useResource((signal) => aiApi.settings(signal), []);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (loaded.data) setDraft(loaded.data); }, [loaded.data]);
  if (!draft) return loaded.error ? <ErrorNotice error={loaded.error} /> : <Loading label="Loading settings" />;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { updated_at: _u, ...body } = draft;
      void _u;
      setDraft(await aiApi.saveSettings(body));
      setNotice("Saved. Changes take effect immediately and are recorded in the audit trail.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.data);

  return (
    <section className="ot-panel" aria-labelledby="switches-title">
      <h2 id="switches-title">Automations</h2>
      {notice && <Notice tone="success">{notice}</Notice>}
      <fieldset disabled={!editable} className="m-0 grid gap-6 border-0 p-0 lg:grid-cols-2">
        <div>
          <label className="ot-check border-t-0 pt-0">
            <input type="checkbox" checked={draft.auto_intake} onChange={(e) => setDraft({ ...draft, auto_intake: e.target.checked })} />
            <span>
              <strong>AI intake</strong>
              <small>New tickets are classified on arrival. When the model is confident, it corrects a mislabelled category (the
                priority is then recalculated) and moves the ticket to Triage. Otherwise it leaves the ticket for a person.</small>
            </span>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-x-3">
            <label className="ot-field">
              <span>Act when category confidence is at least</span>
              <input type="number" min={0.4} max={0.99} step={0.05} value={draft.category_threshold}
                     onChange={(e) => setDraft({ ...draft, category_threshold: Number(e.target.value) })} />
            </label>
          </div>
          <p className="m-0 text-xs text-muted">
            Priority is never set by a person or guessed by the model: every ticket's priority is calculated from impact × urgency.
          </p>
        </div>
        <div>
          <label className="ot-check border-t-0 pt-0">
            <input type="checkbox" checked={draft.monitor_enabled} onChange={(e) => setDraft({ ...draft, monitor_enabled: e.target.checked })} />
            <span>
              <strong>Autonomous twin monitor</strong>
              <small>Watches live operations. When demand surges or a bottleneck forms, it refreshes the twin, simulates the next 8 hours
                with each mitigation, and puts the safest option into Approvals. It never applies anything itself.</small>
            </span>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-x-3">
            <label className="ot-field">
              <span>Check every (minutes)</span>
              <input type="number" min={1} max={240} value={draft.monitor_interval_minutes}
                     onChange={(e) => setDraft({ ...draft, monitor_interval_minutes: Math.max(1, Number(e.target.value)) })} />
            </label>
            <label className="ot-field">
              <span>Treat demand as a surge at</span>
              <input type="number" min={1.1} max={5} step={0.1} value={draft.surge_threshold}
                     onChange={(e) => setDraft({ ...draft, surge_threshold: Number(e.target.value) })} />
              <small>× the usual rate for that hour</small>
            </label>
          </div>
        </div>
      </fieldset>
      <ErrorNotice error={error} />
      {editable ? (
        <div className="flex justify-end">
          <button type="button" className="ot-btn ot-btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save automations"}
          </button>
        </div>
      ) : (
        <p className="mb-0 text-sm text-muted">Only people who manage operational policies can change these switches.</p>
      )}
    </section>
  );
}

function RunLinks({ r }: { r: MonitorRun }) {
  return (
    <span className="flex flex-wrap gap-x-3 text-sm">
      {r.stress_test_id && <Link className="ot-link" to={`/stress-test?id=${r.stress_test_id}`}>Simulation</Link>}
      {r.stress_test_id && <Link className="ot-link" to={`/recommendations?stress_test=${r.stress_test_id}`}>Recommendation</Link>}
      {r.change_request_id && <Link className="ot-link" to={`/approvals?tab=all&id=${r.change_request_id}`}>Proposal in Approvals</Link>}
    </span>
  );
}

function Monitor() {
  const { can } = useAuth();
  const runs = useResource((signal) => aiApi.monitorRuns(signal), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await aiApi.runMonitor();
      runs.setData((prev) => [r, ...(prev ?? [])]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ot-panel" aria-labelledby="monitor-title">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="monitor-title" className="m-0">Autonomous twin monitor</h2>
        {can(P.SIMULATIONS_RUN) && (
          <button type="button" className="ot-btn ot-btn-primary" disabled={busy} onClick={() => void check()}>
            {busy ? "Checking and simulating…" : "Run a check now"}
          </button>
        )}
      </div>
      <p className="mt-0 text-sm text-muted">
        Each check compares the last two hours of demand with what the twin expects for that time of day and looks for bottlenecks. Only
        when something is wrong does it simulate and propose. Proposals appear in Approvals from "OpsTwin Monitor (automated)".
      </p>
      <ErrorNotice error={error} />
      {runs.loading && !runs.data ? (
        <Loading label="Loading checks" />
      ) : (runs.data?.length ?? 0) === 0 ? (
        <EmptyState title="No checks yet">Switch the monitor on, or run a check now.</EmptyState>
      ) : (
        <ol className="m-0 grid list-none gap-2 p-0">
          {runs.data?.map((r) => (
            <li key={r.id} className={`rounded-md border px-4 py-3 ${r.outcome === "risk_recommended" ? "ot-sim-box" : "border-line"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`ot-pill ${OUTCOME[r.outcome].cls}`}>{OUTCOME[r.outcome].text}</span>
                <span className="text-xs text-muted">
                  {formatDateTime(r.started_at)}, {r.trigger === "manual" ? "run by hand" : "scheduled"}
                </span>
              </div>
              <p className="mb-1 mt-2 text-sm">{r.summary}</p>
              <RunLinks r={r} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ModelPanel() {
  const { can } = useAuth();
  const card = useResource((signal) => aiApi.model(signal), []);
  const [busy, setBusy] = useState(false);
  const c = card.data;
  if (card.error) return <ErrorNotice error={card.error} />;
  if (!c) return <Loading label="Loading model" />;
  const pct = (v: number | null) => (v === null ? "Not enough data yet" : `${v}%`);
  return (
    <section className="ot-panel" aria-labelledby="model-title">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="model-title" className="m-0">Triage model</h2>
        {can(P.POLICIES_MANAGE, { global: true }) && (
          <button type="button" className="ot-btn ot-btn-quiet" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const fresh = await aiApi.retrain();
                      card.setData(() => fresh);
                    } finally {
                      setBusy(false);
                    }
                  }}>
            {busy ? "Training…" : "Retrain now"}
          </button>
        )}
      </div>
      <p className="mt-0 text-sm">{c.algorithm}</p>
      <p className="text-sm"><strong>Priority:</strong> {c.priority_method}</p>
      <dl className="ot-facts">
        <div><dt>Version</dt><dd>v{c.version}, trained {formatDateTime(c.trained_at)} ({c.trigger})</dd></div>
        <div><dt>Trained on</dt><dd>{c.history_examples} reviewed tickets + {c.starter_examples} starter examples</dd></div>
        <div><dt>Category accuracy (5-fold)</dt><dd>{pct(c.cross_validated.category_accuracy_pct)}</dd></div>
        <div><dt>Live accuracy, category</dt><dd>{pct(c.observed.category_accuracy_pct)} on {c.observed.reviewed} reviewed</dd></div>
        <div><dt>Mislabelled requests caught</dt><dd>{c.observed.mislabels_caught_by_ai} of {c.observed.mislabelled_by_requester}</dd></div>
      </dl>
      <ul className="m-0 pl-5 text-xs text-muted">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}

function Decisions() {
  const rows = useResource((signal) => aiApi.predictions(signal), []);
  if (rows.error) return <ErrorNotice error={rows.error} />;
  return (
    <section className="ot-panel" aria-labelledby="decisions-title">
      <h2 id="decisions-title">Recent AI decisions</h2>
      {rows.loading && !rows.data ? (
        <Loading label="Loading decisions" />
      ) : (rows.data?.length ?? 0) === 0 ? (
        <EmptyState title="No predictions yet">Every new ticket gets one, whether or not automation is on.</EmptyState>
      ) : (
        <div className="ot-table-wrap">
          <table className="ot-table">
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Filed as</th>
                <th scope="col">AI read it as</th>
                <th scope="col">Priority (calculated)</th>
                <th scope="col">What happened</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {rows.data?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/tickets/${r.ticket_id}`} className="ot-link ot-mono">{r.ticket_reference}</Link>
                    <span className="block max-w-xs truncate text-xs text-muted">{r.title}</span>
                  </td>
                  <td>{CATEGORY_LABELS[r.submitted_category]}</td>
                  <td>
                    <span className={r.predicted_category !== r.submitted_category ? "text-warn" : ""}>{CATEGORY_LABELS[r.predicted_category]}</span>
                    <span className="block"><ConfidenceBar value={r.category_confidence} /></span>
                  </td>
                  <td>{r.current_priority}</td>
                  <td className="text-sm">{ACTION_TEXT[r.action]}</td>
                  <td className="text-sm">
                    {CATEGORY_LABELS[r.current_category]}, {r.current_priority}
                    {r.reviewed && (
                      <span className={`block text-xs ${r.current_category === r.predicted_category ? "text-ok" : "text-bad"}`}>
                        {r.current_category === r.predicted_category ? "AI was right" : "Team chose differently"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function AiAutomationPage() {
  const { can } = useAuth();
  return (
    <div className="ot-page">
      <PageHeader
        title="AI automation"
        description="Machine learning and an autonomous agent, trained and run on this server. No external AI service or API key. People approve anything that changes live operations."
        actions={<AiBadge label="Runs locally" />}
      />
      <Switches />
      {(can(P.SIMULATIONS_READ) || can(P.SIMULATIONS_RUN) || can(P.CHANGES_APPROVE)) && <Monitor />}
      <div className="grid items-start gap-5 xl:grid-cols-[1fr_1.6fr]">
        <ModelPanel />
        {can(P.TICKETS_READ) && <Decisions />}
      </div>
    </div>
  );
}
