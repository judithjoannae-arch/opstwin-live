import { Link } from "react-router-dom";
import { twinApi } from "../../api/twinApi";
import { useResource } from "../../hooks/useResource";
import { fmt } from "../../utils/twin";
import { DataLabel } from "../../components/DataLabel";
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDateTime } from "../../components/ui";

export default function PredictionMonitorPage() {
  const rows = useResource((signal) => twinApi.predictionMonitor(signal), []);
  return (
    <div className="ot-page">
      <PageHeader
        title="Prediction monitor"
        description="After an approved change, compares what the twin predicted with what the website recorded. Rates are compared per hour over the same window."
        actions={<button type="button" className="ot-btn ot-btn-quiet" onClick={rows.reload}>Refresh</button>}
      />
      <p className="text-sm text-muted">This is monitoring, not proof that a change caused an outcome. Demand and staffing also change after a decision.</p>
      {rows.error ? <ErrorNotice error={rows.error} onRetry={rows.reload} /> : null}
      {rows.loading && !rows.data && <Loading label="Loading predictions" />}
      {rows.data?.length === 0 && (
        <EmptyState title="No applied changes to monitor yet">Once an approved change is applied, its predictions are tracked here.</EmptyState>
      )}
      {rows.data?.map((r) => (
        <section key={r.id} className="ot-panel">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0">{r.title ?? "Applied change"}</h2>
              <p className="m-0 mt-1 text-sm text-muted">
                Applied {formatDateTime(r.effective_at)}. Predicted for {r.horizon_hours} h; {fmt(r.observed_window_hours, 1)} h observed so far.{" "}
                <Link className="ot-link" to={`/approvals?tab=all&id=${r.change_request_id}`}>Change request</Link>,{" "}
                <Link className="ot-link" to={`/simulations/${r.run_id}`}>prediction run</Link>
              </p>
            </div>
            <span className={`ot-pill ${r.status === "compared" ? "ot-pill-ok" : "ot-pill-neutral"}`}>
              {r.status === "compared" ? "Compared" : "Waiting for enough data"}
            </span>
          </div>
          <div className="ot-table-wrap">
            <table className="ot-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Predicted <DataLabel origin="simulated" /></th>
                  <th scope="col">Observed <DataLabel origin="observed" /></th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {r.metrics.map((m) => (
                  <tr key={m.metric}>
                    <th scope="row" className="font-normal">{m.label}</th>
                    <td className="tabular-nums">{fmt(m.predicted, 2)}</td>
                    <td className="tabular-nums">{m.observed === null ? <span className="text-muted">Not yet</span> : fmt(m.observed, 2)}</td>
                    <td className="tabular-nums">
                      {m.comparable && m.error !== null ? (
                        <>
                          {m.error > 0 ? "+" : ""}{fmt(m.error, 2)}
                          {m.error_pct !== null && <span className="ml-1 text-xs text-muted">({m.error_pct > 0 ? "+" : ""}{fmt(m.error_pct, 1)}%)</span>}
                        </>
                      ) : (
                        <span className="text-xs text-muted">{m.note}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(r.notes.length > 0 || r.assumption_notes.length > 0) && (
            <ul className="mb-0 mt-3 pl-5 text-sm text-muted">
              {[...r.notes, ...r.assumption_notes].map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
