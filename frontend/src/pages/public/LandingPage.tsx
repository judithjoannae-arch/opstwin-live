import { Link } from "react-router-dom";
import type { DataOrigin } from "../../types/operations";
import { ORIGIN_DESCRIPTIONS } from "../../utils/format";
import { DataLabel } from "../../components/DataLabel";
import { PublicHeader } from "./PublicHeader";

const QUESTIONS = [
  "What is happening in the service desk right now?",
  "What happens if requests suddenly double?",
  "What happens if a technician is unavailable?",
  "Which mitigation works best without harming another stage?",
  "What evidence supports the recommendation?",
  "What actually happened after the change was applied?",
];

const LOOP: { name: string; detail: string }[] = [
  { name: "Observe", detail: "Read the live queues, staff and SLA state from the database." },
  { name: "Simulate", detail: "Freeze a consistent snapshot and play the future forward." },
  { name: "Compare", detail: "Run the baseline, the failure and each mitigation on the same snapshot." },
  { name: "Recommend", detail: "Reject unsafe options, explain the trade-offs of the rest." },
  { name: "Approve", detail: "A second person signs off on the exact configuration change." },
  { name: "Apply", detail: "The change lands in the real configuration in one transaction." },
  { name: "Verify", detail: "Refresh the twin, rerun, and watch the observed outcome." },
];

const ORIGINS: DataOrigin[] = ["observed", "synthetic", "assumed", "simulated", "derived"];

/** A schematic, deliberately number-free: the landing page shows no metrics. */
function PipelineSketch() {
  const stages = ["Intake", "Triage", "Support", "Verify"];
  return (
    <svg viewBox="0 0 560 220" role="img" aria-label="Four connected workflow stages, with a demand spike building a queue at technical support" className="h-auto w-full">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="#8da2b7" />
        </marker>
      </defs>
      {/* demand spike */}
      <path d="M8 150 L40 150 L52 70 L64 150 L84 150" fill="none" stroke="#f0b13c" strokeWidth="2.5" />
      <text x="8" y="182" fill="#8da2b7" fontSize="12">Demand ×2</text>
      {stages.map((label, i) => {
        const x = 110 + i * 112;
        const hot = i === 2;
        return (
          <g key={label}>
            <rect x={x} y="96" width="88" height="56" rx="6" fill="#0f2135" stroke={hot ? "#ef6458" : "#213a55"} strokeWidth={hot ? 2 : 1.5} />
            <text x={x + 44} y="129" textAnchor="middle" fill="#e2ebf3" fontSize="14" fontWeight="600">
              {label}
            </text>
            {i < stages.length - 1 && (
              <line x1={x + 90} y1="124" x2={x + 108} y2="124" stroke={i >= 2 ? "#f0b13c" : "#8da2b7"} strokeWidth="2" markerEnd="url(#arrow)" />
            )}
            {/* queue blocks stack up above the overloaded stage */}
            {hot &&
              [0, 1, 2, 3, 4].map((n) => (
                <rect key={n} x={x + 14 + (n % 3) * 22} y={78 - Math.floor(n / 3) * 16 - 4} width="16" height="12" rx="2" fill="#ef6458" opacity={0.55 + n * 0.08} />
              ))}
            {hot && <text x={x + 44} y="50" textAnchor="middle" fill="#ef6458" fontSize="12">One technician out</text>}
          </g>
        );
      })}
      <path d="M 494 156 C 494 200, 366 200, 366 156" fill="none" stroke="#8da2b7" strokeDasharray="4 4" strokeWidth="1.5" markerEnd="url(#arrow)" />
      <text x="430" y="212" textAnchor="middle" fill="#8da2b7" fontSize="11">rework</text>
      <path d="M112 84 C 170 24, 280 18, 340 40" fill="none" stroke="#2cc0d3" strokeDasharray="2 6" strokeWidth="2" />
      <text x="226" y="20" textAnchor="middle" fill="#2cc0d3" fontSize="12">twin plays the next hours forward</text>
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-navy-900 text-ink">
      <PublicHeader />

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-14 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="mb-4 text-sm font-medium text-signal">Campus IT service desk with a live digital twin</p>
            <h1 className="mb-5 max-w-[16ch] text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
              Try the decision on the twin first.
            </h1>
            <p className="max-w-[56ch] text-lg leading-relaxed text-muted">
              OpsTwin Live runs the service desk and keeps a digital twin of it. Test a demand spike, a missing technician or a new
              routing rule against the real queues, then apply only the change someone has approved.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/submit" className="ot-btn ot-btn-primary">
                Report an IT problem
              </Link>
              <Link to="/login" className="ot-btn ot-btn-quiet">
                Staff sign-in
              </Link>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-navy-950/60 p-4">
            <PipelineSketch />
          </div>
        </section>

        <section className="border-t border-line bg-navy-950/40">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="text-2xl font-semibold">One small change, four connected stages</h2>
              <p className="mt-3 max-w-[48ch] text-muted">
                A busy day or one absence doesn't stay where it starts. Queues build at technical support, verification starves and then
                floods, and SLAs slip in stages nobody touched. The twin shows that chain before it happens.
              </p>
            </div>
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
              {QUESTIONS.map((q) => (
                <li key={q} className="rounded-md border border-line bg-navy-850 px-4 py-3 text-sm leading-relaxed">
                  {q}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="text-2xl font-semibold">From observation to verified change</h2>
          <p className="mt-3 max-w-[60ch] text-muted">
            Nothing in live operations changes because a simulation suggested it. Every step is recorded, and every applied change is
            checked against the configuration it was simulated on.
          </p>
          <ol className="m-0 mt-8 grid list-none gap-0 p-0 md:grid-cols-7">
            {LOOP.map((step, i) => (
              <li key={step.name} className="relative border-l-2 border-line py-2 pl-4 md:border-l-0 md:border-t-2 md:pl-0 md:pr-4 md:pt-4">
                <span className="text-xs tabular-nums text-muted">{i + 1}</span>
                <p className="m-0 mt-1 font-semibold text-ink">{step.name}</p>
                <p className="m-0 mt-1 text-sm leading-relaxed text-muted">{step.detail}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line bg-navy-950/40">
          <div className="mx-auto max-w-6xl px-5 py-14">
            <h2 className="text-2xl font-semibold">Every number says where it came from</h2>
            <p className="mt-3 max-w-[60ch] text-muted">
              Predictions are never presented as facts. If there isn't enough recorded data for a metric, the dashboard says so.
            </p>
            <dl className="m-0 mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {ORIGINS.map((origin) => (
                <div key={origin}>
                  <dt>
                    <DataLabel origin={origin} />
                  </dt>
                  <dd className="m-0 mt-2 text-sm leading-relaxed text-muted">{ORIGIN_DESCRIPTIONS[origin]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <p className="mx-auto max-w-6xl px-5 py-6 text-sm text-muted">
          Campus IT demonstration environment. Sample tickets and staff are synthetic and labelled Demo.
        </p>
      </footer>
    </div>
  );
}
