import { Fragment } from "react";
import type { StageKey, StageState } from "../types/operations";
import { STAGE_LABELS, STAGES, formatMinutes, formatNumber } from "../utils/format";
import { propagationPath } from "../utils/workflow";
import { BottleneckPill } from "./OpsBadges";

/**
 * The four connected workflow stages with their observed queues. Arrows
 * leaving an overloaded stage turn amber: that's where delays carry next.
 */
export function StagePipeline({
  stages,
  selected,
  onSelect,
}: {
  stages: StageState[];
  selected?: StageKey | null;
  onSelect?: (stage: StageKey) => void;
}) {
  const byKey = new Map(stages.map((s) => [s.stage, s]));
  const overloaded = stages.filter((s) => s.bottleneck !== "none").map((s) => s.stage);
  const affected = propagationPath(overloaded);

  return (
    <div className="overflow-x-auto pb-1">
      <ol className="m-0 grid min-w-[760px] list-none grid-cols-[1fr_2.25rem_1fr_2.25rem_1fr_2.25rem_1fr] items-stretch p-0">
        {STAGES.map((key, index) => {
          const s = byKey.get(key);
          const isSelected = selected === key;
          const isAffected = affected.has(key);
          const edgeHot = index > 0 && affected.has(key);
          const body = (
            <>
              <span className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{STAGE_LABELS[key]}</span>
                {s && <BottleneckPill level={s.bottleneck} />}
              </span>
              {s ? (
                <>
                  <span className="mt-3 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tabular-nums text-ink">{formatNumber(s.queue)}</span>
                    <span className="text-xs text-muted">waiting</span>
                  </span>
                  <span className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
                    <span>
                      In service <strong className="font-semibold text-ink">{formatNumber(s.in_service)}</strong>
                    </span>
                    <span>
                      On shift{" "}
                      <strong className="font-semibold text-ink">
                        {s.available_resources}/{s.total_resources}
                      </strong>
                    </span>
                    <span>
                      Avg wait{" "}
                      <strong className="font-semibold text-ink">
                        {s.avg_wait_minutes === null ? "No data" : formatMinutes(s.avg_wait_minutes)}
                      </strong>
                    </span>
                    <span>
                      SLA at risk <strong className={s.sla_at_risk ? "font-semibold text-warn" : "font-semibold text-ink"}>{s.sla_at_risk}</strong>
                    </span>
                  </span>
                  {isAffected && s.bottleneck === "none" && (
                    <span className="mt-2 text-xs text-warn">Receives delayed work from upstream</span>
                  )}
                </>
              ) : (
                <span className="mt-3 text-xs text-muted">No data for this stage</span>
              )}
            </>
          );
          const boxClass = `flex h-full w-full flex-col rounded-md border bg-navy-850 p-3 text-left ${
            isSelected ? "border-signal ring-1 ring-signal" : s?.bottleneck === "bottleneck" ? "border-bad/70" : "border-line"
          }`;
          return (
            <Fragment key={key}>
              {index > 0 && (
                <li aria-hidden="true" className="flex items-center justify-center">
                  <svg viewBox="0 0 36 16" className={`h-4 w-9 ${edgeHot ? "text-warn" : "text-line"}`}>
                    <path d="M0 8h30" stroke="currentColor" strokeWidth="2" fill="none" />
                    <path d="M28 3l7 5-7 5z" fill="currentColor" />
                  </svg>
                </li>
              )}
              <li className="min-w-0">
                {onSelect ? (
                  <button
                    type="button"
                    className={`${boxClass} cursor-pointer hover:border-signal/70`}
                    aria-pressed={isSelected}
                    onClick={() => onSelect(key)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={boxClass}>{body}</div>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
      <div className="grid min-w-[760px] grid-cols-[1fr_2.25rem_1fr_2.25rem_1fr_2.25rem_1fr]" aria-hidden="true">
        <div className="col-start-5 col-end-8 mx-[12%] mt-2 flex items-center gap-2 border-b border-dashed border-muted/60 pb-1 text-[11px] text-muted">
          <span>◂</span>
          <span>Rework returns unverified fixes to technical support</span>
        </div>
      </div>
    </div>
  );
}
