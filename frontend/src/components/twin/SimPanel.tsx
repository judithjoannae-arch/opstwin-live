import type { ReactNode } from "react";
import { DataLabel } from "../DataLabel";

/** Panel for simulated output: dashed violet edge plus a Simulated label. */
export function SimPanel({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="ot-panel ot-sim" aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="m-0">
          {title}
        </h2>
        <span className="flex items-center gap-3">
          {actions}
          <DataLabel origin="simulated" />
        </span>
      </div>
      {children}
    </section>
  );
}
