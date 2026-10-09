# Model assumptions and limitations

Every input the twin uses is labelled with where it came from:

| Label | Meaning |
| --- | --- |
| **Observed** | Read from records stored by the website (tickets, events, staff). |
| **Synthetic** | Generated demo data (`is_demo = true`), shown with a Demo tag. |
| **Assumed** | A configured default, used when there isn't enough data. |
| **Simulated** | Output of the digital twin. Never shown as fact. |
| **Derived** | Calculated from observed or simulated data. |

The labels for each snapshot are returned by `GET /api/twin/snapshots/{id}` in `assumptions`, with sample sizes.

## How parameters are estimated (14-day lookback)

| Parameter | Observed when | Otherwise (assumed) |
| --- | --- | --- |
| Demand by local hour of day | ≥ 60 tickets over ≥ 1.5 days: tickets created per hour-of-day ÷ times that hour occurred | Campus business-hours curve, mean ≈ 3.6 tickets/h |
| Category mix | ≥ 30 tickets | Account 25%, network 30%, software 20%, hardware 15%, critical 10% |
| Priority mix per category | ≥ 10 tickets in the category | Per-category defaults (critical infrastructure is mostly P1) |
| Service time per stage and category | ≥ 8 samples: from pick-up (assignment, or start of work in support) to leaving the stage; support excludes tickets that went on hold | Pooled across categories for non-support stages (Derived), else defaults: intake 4 min, triage 8 min, support 18–60 min by category, verification 6 min |
| Service-time distribution | Lognormal with the estimated mean and coefficient of variation (clipped to 0.2–2.0) | |
| Rework after verification | ≥ 20 verifications | 8% |
| Misrouting (transfer) rate | The website doesn't record misrouting yet | 15%; a misrouted ticket uses 25% of a service before transfer |
| Time on hold | | Exponential, mean 90 min |
| Priority escalation | | Once, at 75% of the SLA window |
| Smart triage effect | | Triage takes 1.15×; misrouting falls to 0.3× |

## Simulation rules

- Discrete-event simulation with a virtual clock (`app/simulation/engine.py`). Events: arrival, queue entry/exit, resource assignment/release, service start/complete, classification, transfer, rework, priority escalation, SLA breach, resource failure/recovery, shift start/end, hold release, closure, backlog carry-over.
- Arrivals: non-homogeneous Poisson process following the hourly profile × demand multiplier.
- Stages in series: intake → triage → technical support → verification → closed (or rework back to support).
- Each person serves one ticket at a time. People only start work while on shift and available. Reserves only work when activated.
- Technical support respects skills when routing is skill-aware; otherwise the first free technician takes the next ticket and transfers it if they lack the skill.
- Queue order: FIFO, or priority then FIFO (`priority`, `smart_triage`).
- Existing work from the snapshot stays in the model: queued tickets keep their place, in-progress work continues with its remaining time (if the assignee is removed, the ticket returns to the queue).
- Work still open at the horizon is reported as carried-over backlog.
- Common random numbers: each ticket has its own random stream, so strategies run on the same snapshot and seed see the same tickets.
- Replications: default 10; results show mean, standard deviation, 95% interval (normal approximation), min and max.

## Metrics

Throughput (closed tickets per hour), mean and P95 waiting time (queue time inside the simulated window), peak and ending backlog, SLA compliance (closed in time ÷ (closed + unfinished past deadline)), SLA violations, unfinished tickets, utilization by stage (busy ÷ on-shift available time), recovery time (back to the starting backlog after the peak), critical (P1) delays and compliance, SLA compliance by category, transfers, reworks, escalations.

## Prediction monitoring

After an approved change, the predicted per-hour rates are compared with what the website records afterwards, over the overlapping window only (never an 8-hour simulated total against a shorter observation). A comparison needs at least 30 minutes and 5 closed tickets. Notes flag different demand, staffing changes and later configuration changes. This is monitoring, not proof of causation.

## Limitations

- Only the four-stage desk is modelled; outages, phone or walk-in demand and requester behaviour are outside it.
- Real demand can be burstier than a Poisson process.
- Pick-up-to-exit times include interruptions the website doesn't log.
- Misrouting rates and smart-triage effects are assumptions, not measurements.
- No parallel work, breaks or learning effects.
- The demo history is synthetic and was generated with the same engine, so estimates from it naturally agree with the model; real data will not.
