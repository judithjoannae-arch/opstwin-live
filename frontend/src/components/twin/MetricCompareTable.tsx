import type { MetricStat } from "../../types/twin";
import { ciHalf, fmt, isBetter, metricInfo } from "../../utils/twin";

export interface CompareColumn {
  key: string;
  label: string;
  color: string;
  metrics: Record<string, MetricStat>;
}

/**
 * Metrics as rows, runs as columns, mean ± 95 % interval. Cells are marked
 * better or worse than the reference column (normally the unmitigated failure).
 */
export function MetricCompareTable({ columns, metrics, referenceKey, neutralKeys = ["A"] }: {
  columns: CompareColumn[];
  metrics: string[];
  referenceKey?: string;
  /** Columns shown without better/worse colouring (the normal baseline isn't a strategy). */
  neutralKeys?: string[];
}) {
  const ref = columns.find((c) => c.key === referenceKey);
  return (
    <div className="ot-table-wrap">
      <table className="ot-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {columns.map((c) => (
              <th scope="col" key={c.key} className="whitespace-nowrap">
                <span className="ot-swatch" style={{ background: c.color }} aria-hidden="true" />
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map((name) => {
            const info = metricInfo(name);
            return (
              <tr key={name}>
                <th scope="row" className="font-normal">
                  {info.label}
                  {info.unit && <span className="text-muted"> ({info.unit})</span>}
                </th>
                {columns.map((c) => {
                  const stat = c.metrics[name];
                  const better = ref && c.key !== ref.key && !neutralKeys.includes(c.key) ? isBetter(name, stat?.mean, ref.metrics[name]?.mean) : null;
                  return (
                    <td key={c.key} className="whitespace-nowrap tabular-nums">
                      <span className={better === true ? "ot-better" : better === false ? "ot-worse" : undefined}>
                        {stat?.mean === null || stat === undefined ? <span className="text-muted">No data</span> : fmt(stat.mean, info.digits)}
                      </span>
                      {better !== null && <span className="sr-only">{better ? " (better)" : " (worse)"}</span>}
                      <span className="ml-1 text-xs text-muted">{ciHalf(stat, info.digits)}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
