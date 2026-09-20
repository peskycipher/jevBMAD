# Operations Runbook

Every command runs from the repo root. Live calls need `TYPESAFE_API_KEY` (TypeSafe direct, preferred) or `OPENROUTER_API_KEY` (fallback); everything skips cleanly without either.

## Daily commands

```bash
npx tsx evals/harness/run_evals.ts evals/golden-sets   # full sweep: ~$0.006, ~2 min
npx tsx evals/harness/ci_gate.ts                     # gate vs baseline (~same cost)
npx tsx evals/harness/dashboard.ts                   # $0 — aggregates logs+results
npx tsx evals/harness/online_sample.ts               # ~3% hindsight sampling (~$0.001; --seed for reproducibility)
```

## Workflows

### Grow a golden set (prelabel pipeline)
1. Author candidates: `evals/candidates/<set>.candidates.jsonl` — one `{"state": ...}` per line, each written with a known intended label.
2. Propose: `npx tsx evals/harness/prelabel.ts --generate <set> candidates.jsonl` (~$0.00002/example).
3. Audit: `npx tsx evals/harness/audit_prelabel.ts` — agreements approved, disagreements dropped (the disagreement rule: coin-flip labels never enter ground truth).
4. Promote: `npx tsx evals/harness/prelabel.ts --promote <set>` (dedupes by id and state).
5. Refresh baseline: `npx tsx evals/harness/ci_gate.ts --update-baseline`.

### Settle an audit queue entry
Entries in `evals/audit/human_audit_queue.jsonl` carry a `question` field. Apply the decision as a `decision` field (+ `resolved_ts`), then act: relabel and return to golden set, or discard. Both prior settlements (guard-022, the 18 hard-set verdicts) are recorded there as templates.

### Model change (the §6 re-fit rule)
1. The CI gate hard-fails on resolved-model drift vs the lockfile (the pin is provider-independent; a provider *echo* change only warns — see D13).
2. Re-run full evals + `holdout_validate.ts` (fresh predictions, ids recorded).
3. `fit_thresholds.ts` + `fit_gates.ts` — refit on train splits only.
4. `ci_gate.ts --update-baseline` — lock the new baseline.
5. Record the re-fit in the lockfile (status, n, date).

### Criteria edit (manual awareness required)
Changing any `criteria.json` or gate question wording **invalidates the fitted thresholds** (coupling rule). What *is* automated: `evals/harness/tests/test_questions_golden_sync.ts` fails when runtime `QUESTIONS` drift from golden payloads, when labels lose their Choice option key, or when EntryType shapes break. What is still manual: threshold re-fit after a semantic wording change — re-run evals, check accuracy/ECE deltas by hand, refit if the distribution moved, then refresh the baseline.

## Monitoring targets (§7.5)

| Metric | Target | Where |
|---|---|---|
| System-1 auto share | ≥ 70% of decisions | dashboard (from `routing.jsonl`) |
| High-band accuracy | ≥ fitted target | dashboard golden-set table |
| ECE | < 0.05 (alert only) | dashboard alerts |
| p95 routing latency | < 2.5–3.0 s mixed traffic | dashboard |
| Memory relevance | ≥ 3.2 / 4 | online-sample snapshots |
| Cost | trend vs baseline | dashboard + system2 log |

`production_metrics.json` accumulates online-sample snapshots — prune it periodically (it grows unbounded).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"status": "disabled"}` everywhere | mode/key not set | `export BMAD_DECISION_ASSIST_MODE=suggest` (fork) / set `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`) |
| `{"status": "unavailable", "reason": "http_401"}` | bad key | check the key; the OpenRouter decisions endpoint is alpha and undocumented |
| CI warns "provider served X for pinned Y" | provider normalized the pin to an unknown ID (possible snapshot repoint) | verify at docs.typesafe.ai; if intentional, re-fit per D13 |
| HTTP 400 "Unknown model: typesafe/jev-…" from TypeSafe direct | expected: the dated snapshot ID only resolves on OpenRouter | use the alias path — the client handles this; do not "fix" by unpinning |
| Inverted-looking noul answers | instructions/proposition polarity mismatch | see D10 in `decisions.md`; rewrite the question so both agree |
| CI fails on ECE only | calibration drift (warning severity) | check dashboard alerts; `--strict` is opt-in only |
| Everything escalates, auto share ~0 | safety lock too strict (the §14.2 failure mode) | check lockfile bands: escalate 0.50 / clean 0.75 |
| Readiness gate holds a solid artifact | near-boundary score variance (n=8 calibration) | treat as advisory; run in shadow mode; grow the set |
| `git revert`-style request escalates | correct behavior per audit (guard-022) | history-altering ops are unsafe-labeled |

## Costs (measured envelope)

Full eval sweep ≈ $0.006 · CI gate ≈ $0.006 · online sample ≈ $0.001 · prelabel batch (100) ≈ $0.002 · one GLM-5.3 escalation ≈ $0.033. The entire build-out to date cost ~$0.05 in Jev calls plus one GLM call.