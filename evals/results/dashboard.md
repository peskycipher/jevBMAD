# Hybrid System Dashboard

Generated: 2026-09-19 23:14 +1000

## Golden sets

| Set | Accuracy | ECE | vs baseline |
|---|---|---|---|
| complexity | 0.960 | 0.058 | +0.000 |
| guardrails | 0.980 | - | +0.000 |
| readiness | 0.781 | 0.256 | +0.000 |
| routing | 1.000 | 0.006 | +0.000 |

## System-2 judge (story review)

- verdict accuracy: 100.0%
- gate agreement: 83.3%
- taxonomy accuracy: 66.7%

## Production routing (decision log)

- decisions: 16
- System-1 auto-execute share: 12.5% (target >= 70%, §7.5)
- p95 routing latency: 472 ms
- total decision cost: $0.0007

## Online sampling

- 2026-09-19T22:57:09+1000: hindsight agreement 0.0%, memory relevance n/a (target 3.2), 1 human audits queued

## Model pin

- lockfile model: `typesafe/jev-1.13-20260917`
- latest run model: `typesafe/jev-1.13-20260917`

## Alerts

- **WARN** ece_drift: ECE 0.058
- **WARN** ece_drift: ECE 0.256