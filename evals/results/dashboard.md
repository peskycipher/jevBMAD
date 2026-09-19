# Hybrid System Dashboard

Generated: 2026-09-19 23:49 +1000

## Golden sets

| Set | Accuracy | ECE | vs baseline |
|---|---|---|---|
| guardrails | 0.990 | - | +0.000 |

## System-2 judge (story review)

- verdict accuracy: 100.0%
- gate agreement: 83.3%
- taxonomy accuracy: 66.7%

## Production routing (decision log)

- decisions: 22
- System-1 auto-execute share: 18.2% (target >= 70%, §7.5)
- p95 routing latency: 626 ms
- total decision cost: $0.0009

## System-2 escalations (GLM)

- calls: 1
- p50 / max latency: 104888 / 104888 ms
- total cost: $0.0326
- models: ['z-ai/glm-5.3']

## Online sampling

- 2026-09-19T22:57:09+1000: hindsight agreement 0.0%, memory relevance n/a (target 3.2), 1 human audits queued

## Model pin

- lockfile model: `typesafe/jev-1.13-20260917`
- latest run model: `typesafe/jev-1.13-20260917`

## Alerts

- none