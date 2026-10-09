/**
 * Charts for simulated results. Every value comes from the backend simulation
 * (aggregated across replications); nothing is computed or invented here
 * beyond reshaping for display.
 */
import type { ReactElement } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  ComposedChart,
  LabelList,
} from "recharts";
import type { StageKey } from "../../types/operations";
import type { MetricStat, SeriesPoint } from "../../types/twin";
import { CATEGORIES, CATEGORY_LABELS, STAGES, STAGE_LABELS } from "../../utils/format";
import { metricInfo, minutesLabel } from "../../utils/twin";

const AXIS = { stroke: "#8da2b7", fontSize: 12 };
const GRID = "#213a55";
const STAGE_COLORS: Record<StageKey, string> = { intake: "#8da2b7", triage: "#a78bfa", support: "#f0b13c", verification: "#2cc0d3" };

export interface SeriesRun {
  key: string;
  label: string;
  color: string;
  series: SeriesPoint[];
}

export interface StatRun {
  key: string;
  label: string;
  color: string;
  scalars: Record<string, MetricStat>;
}

function inRange(minute: number, range?: [number, number]): boolean {
  return !range || (minute >= range[0] * 60 && minute <= range[1] * 60);
}

function Frame({ height = 260, children }: { height?: number; children: ReactElement }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** Backlog (tickets in the system) over simulated time, one line per run. */
export function BacklogChart({ runs, range, normalised = false }: { runs: SeriesRun[]; range?: [number, number]; normalised?: boolean }) {
  const minutes = runs[0]?.series.filter((p) => inRange(p.minute, range)).map((p) => p.minute) ?? [];
  const data = minutes.map((minute) => {
    const row: Record<string, number | string> = { minute, label: minutesLabel(minute) };
    for (const r of runs) {
      const p = r.series.find((x) => x.minute === minute);
      const start = r.series[0]?.backlog || 1;
      if (p) row[r.key] = normalised ? Math.round((p.backlog / start) * 100) / 100 : p.backlog;
    }
    return row;
  });
  return (
    <Frame>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={normalised} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {runs.map((r) => (
          <Line key={r.key} type="monotone" dataKey={r.key} name={r.label} stroke={r.color} strokeWidth={2} dot={false}
                strokeDasharray={r.key === "B" ? "6 4" : undefined} />
        ))}
      </LineChart>
    </Frame>
  );
}

/** Queue length by stage over time for one run. */
export function StageQueueChart({ series, range }: { series: SeriesPoint[]; range?: [number, number] }) {
  const stages = STAGES.filter((s) => series.some((p) => p.queue[s] !== undefined));
  const data = series.filter((p) => inRange(p.minute, range)).map((p) => ({ label: minutesLabel(p.minute), ...p.queue }));
  return (
    <Frame>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {stages.map((s) => (
          <Line key={s} type="monotone" dataKey={s} name={STAGE_LABELS[s]} stroke={STAGE_COLORS[s]} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </Frame>
  );
}

/** New requests vs completed tickets per simulated hour. */
export function DemandVsCompletedChart({ hourly }: { hourly: { hour: number; arrivals: number; closed: number }[] }) {
  const data = hourly.map((h) => ({ label: `Hour ${h.hour + 1}`, Requests: h.arrivals, Completed: h.closed }));
  return (
    <Frame>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: "rgba(167,139,250,0.06)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="Requests" fill="#4a77a8" />
        <Line type="monotone" dataKey="Completed" stroke="#a78bfa" strokeWidth={2} dot={false} />
      </ComposedChart>
    </Frame>
  );
}

/** One metric across runs, with the 95 % interval as an error bar. */
export function MetricBars({ runs, metric, height = 220 }: { runs: StatRun[]; metric: string; height?: number }) {
  const info = metricInfo(metric);
  const data = runs.map((r) => {
    const s = r.scalars[metric];
    const mean = s?.mean ?? null;
    const pct = info.unit === "%";
    const lo = s?.ci_low == null ? null : pct ? Math.max(0, s.ci_low) : s.ci_low;
    const hi = s?.ci_high == null ? null : pct ? Math.min(100, s.ci_high) : s.ci_high;
    const err = lo !== null && hi !== null && mean !== null ? [Math.max(0, mean - lo), Math.max(0, hi - mean)] : [0, 0];
    return { key: r.key, label: r.key, name: r.label, value: mean, err, color: r.color };
  });
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-sm text-muted">
        {info.label} {info.unit && `(${info.unit})`}
      </figcaption>
      <Frame height={height}>
        <BarChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} domain={info.unit === "%" ? [0, 100] : [0, "auto"]} />
          <Tooltip formatter={(v: number) => v?.toFixed?.(info.digits) ?? v} labelFormatter={(_l, p) => (p?.[0]?.payload?.name as string) ?? ""} />
          <Bar dataKey="value" name={info.label}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.color} />
            ))}
            <ErrorBar dataKey="err" width={6} strokeWidth={1.5} stroke="#e2ebf3" direction="y" />
          </Bar>
        </BarChart>
      </Frame>
    </figure>
  );
}

/** Throughput vs mean wait. Up and to the left is better. */
export function ParetoScatter({ runs, feasible }: { runs: StatRun[]; feasible?: Record<string, boolean> }) {
  const data = runs
    .map((r) => ({ key: r.key, name: r.label, x: r.scalars.mean_wait_min?.mean, y: r.scalars.throughput_per_hour?.mean, color: r.color }))
    .filter((d) => d.x != null && d.y != null);
  return (
    <Frame height={280}>
      <ScatterChart margin={{ top: 16, right: 24, bottom: 16, left: -8 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis type="number" dataKey="x" name="Mean wait" unit=" min" tick={AXIS} tickLine={false}
               label={{ value: "Mean wait (min), lower is better", position: "insideBottom", offset: -8, fill: "#8da2b7", fontSize: 12 }} />
        <YAxis type="number" dataKey="y" name="Completed per hour" tick={AXIS} tickLine={false} axisLine={false} />
        <ZAxis range={[160, 160]} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v: number) => v?.toFixed?.(2) ?? v} />
        <Scatter data={data} name="Strategies">
          {data.map((d) => (
            <Cell key={d.key} fill={d.color} stroke={feasible && feasible[d.key] === false ? "#ef6458" : "#e2ebf3"}
                  strokeWidth={feasible && feasible[d.key] === false ? 2 : 1} />
          ))}
          <LabelList dataKey="key" position="top" fill="#e2ebf3" fontSize={12} />
        </Scatter>
      </ScatterChart>
    </Frame>
  );
}

/** Grouped bars of a per-stage metric (e.g. stage_mean_wait_min, utilization_pct). */
export function StageGroupedChart({ runs, prefix, unit }: { runs: StatRun[]; prefix: string; unit: string }) {
  const stages = STAGES.filter((s) => runs.some((r) => r.scalars[`${prefix}.${s}`] !== undefined));
  const data = stages.map((s) => {
    const row: Record<string, string | number | null> = { stage: STAGE_LABELS[s].replace(" and closure", "") };
    for (const r of runs) row[r.key] = r.scalars[`${prefix}.${s}`]?.mean ?? null;
    return row;
  });
  return (
    <Frame>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="stage" tick={AXIS} tickLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} unit={unit === "%" ? "%" : ""} domain={unit === "%" ? [0, 100] : [0, "auto"]} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {runs.map((r) => (
          <Bar key={r.key} dataKey={r.key} name={r.label} fill={r.color} />
        ))}
      </BarChart>
    </Frame>
  );
}

/** SLA compliance by ticket category across runs. */
export function CategorySlaChart({ runs }: { runs: StatRun[] }) {
  const data = CATEGORIES.map((c) => {
    const row: Record<string, string | number | null> = { category: CATEGORY_LABELS[c].replace(" and password", "").replace(" and network", "").replace(" and applications", "") };
    for (const r of runs) row[r.key] = r.scalars[`sla_compliance_pct.category.${c}`]?.mean ?? null;
    return row;
  });
  return (
    <Frame>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="category" tick={AXIS} tickLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {runs.map((r) => (
          <Bar key={r.key} dataKey={r.key} name={r.label} fill={r.color} />
        ))}
      </BarChart>
    </Frame>
  );
}
