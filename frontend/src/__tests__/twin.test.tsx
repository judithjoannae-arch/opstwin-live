import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MetricStat } from "../types/twin";
import { MetricCompareTable } from "../components/twin/MetricCompareTable";
import { SimPanel } from "../components/twin/SimPanel";
import { ciHalf, isBetter, minutesLabel, strategyColor } from "../utils/twin";
import { NAV_SECTIONS } from "../components/navigation";
import { P, meetsRequirement } from "../auth/permissions";
import type { CurrentUser } from "../api/types";

const stat = (mean: number | null, lo?: number, hi?: number): MetricStat => ({
  mean, std: 1, ci_low: lo ?? mean, ci_high: hi ?? mean, min: mean, max: mean, n: 10, values: [], unit: "",
});

describe("twin utilities", () => {
  it("knows which direction is better for each metric", () => {
    expect(isBetter("mean_wait_min", 50, 100)).toBe(true);
    expect(isBetter("throughput_per_hour", 3, 4)).toBe(false);
    expect(isBetter("arrivals", 10, 5)).toBeNull();
    expect(isBetter("mean_wait_min", null, 5)).toBeNull();
  });

  it("formats confidence intervals and simulated time", () => {
    expect(ciHalf(stat(10, 8, 12))).toBe("±2.0");
    expect(ciHalf(stat(10))).toBe("");
    expect(minutesLabel(90)).toBe("1h30");
    expect(minutesLabel(120)).toBe("2h");
    expect(strategyColor("B")).toBe("#ef6458");
  });
});

describe("comparison table", () => {
  it("marks results against the failure baseline and never invents missing values", () => {
    render(
      <MetricCompareTable
        referenceKey="B"
        columns={[
          { key: "B", label: "Failure", color: "#f00", metrics: { mean_wait_min: stat(120), sla_compliance_pct: stat(80) } },
          { key: "E", label: "Combined", color: "#0ff", metrics: { mean_wait_min: stat(60), sla_compliance_pct: stat(null) } },
        ]}
        metrics={["mean_wait_min", "sla_compliance_pct"]}
      />,
    );
    expect(screen.getByText("60.0").className).toContain("ot-better");
    expect(screen.getByText("No data")).toBeTruthy();
  });
});

describe("simulated output is always labelled", () => {
  it("SimPanel carries the Simulated label", () => {
    render(<SimPanel title="Forecast"><p>content</p></SimPanel>);
    expect(screen.getByText("Simulated")).toBeTruthy();
  });

  it("twin pages are visible to analysts but not technicians", () => {
    const user = (codes: string[]): CurrentUser => ({
      id: "u", email: "u@x", full_name: "U", is_active: true, roles: [], memberships: [], departments: [],
      session_expires_at: new Date(Date.now() + 3e6).toISOString(),
      grants: codes.map((code) => ({ code: code as never, scope: "global" as const, department_ids: [] })),
    });
    const twin = NAV_SECTIONS.find((s) => s.label === "Digital twin")!.items;
    const analyst = user([P.SIMULATIONS_RUN, P.SIMULATIONS_READ, P.RECOMMENDATIONS_READ]);
    const tech = user([P.TICKETS_READ, P.TICKETS_UPDATE]);
    expect(twin.filter((i) => meetsRequirement(analyst, i.requirement)).length).toBe(7);
    expect(twin.filter((i) => meetsRequirement(tech, i.requirement))).toEqual([]);
  });
});
