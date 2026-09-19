# Operations Runbook

Every command runs from the repo root. Everything live requires `OPENROUTER_API_KEY`; everything skips cleanly without it.

## Daily commands

```bash
python3 evals/harness/run_evals.py evals/golden-sets   # full sweep: ~$0.006, ~2 min
python3 evals/harness/ci_gate.py                     # gate vs baseline (~same cost)
python3 evals/harness/dashboard.py                   # $0 — aggregates logs+results
python3 evals/harness/online_sample.py               # 5% hindsight sampling (~$0.001)
```

## Workflows

### Grow a golden set (prelabel pipeline)
1. Author candidates: `evals/candidates/<set>.candidates.jsonl` — one `{"state": ...}` per line, each written with a known intended label.
2. Propose: `python3 evals/harness/prelabel.py --generate <set> candidates.jsonl` (~$0.00002/example).
3. Audit: `python3 evals/harness/audit_prelabel.py` — agreements approved, disagreements dropped (the disagreement rule: coin-flip labels never enter ground truth).
4. Promote: `python3 evals/harness/prelabel.py --promote <set>` (dedupes by id and state).
5. Refresh baseline: `python3 evals/harness/ci_gate.py --update-baseline`.

### Settle an audit queue entry
Entries in `evals/audit/human_audit_queue.jsonl` carry a `question` field. Apply the decision as a `decision` field (+ `resolved_ts`), then act: relabel and return to golden set, or discard. Both prior settlements (guard-022, the 18 hard-set verdicts) are recorded there as templates.

### Model change (the §6 re-fit rule)
1. The CI gate hard-fails on resolved-model drift vs the lockfile.
2. Re-run full evals + `holdout_validate.py` (fresh predictions, ids recorded).
3. `fit_thresholds.py` + `fit_gates.py` — refit on train splits only.
4. `ci_gate.py --update-baseline` — lock the new baseline.
5. Record the re-fit in the lockfile (status, n, date).

### Criteria edit (manual awareness required)
Changing any `criteria.json` or gate question wording **invalidates the fitted thresholds** (coupling rule) but triggers no automated alarm. After a criteria edit: re-run evals, check accuracy/ECE deltas by hand, refit if the distribution moved.

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
| `{"status": "disabled"}` everywhere | mode/key not set | `export BMAD_DECISION_ASSIST_MODE=suggest` (fork) / set `OPENROUTER_API_KEY` |
| `{"status": "unavailable", "reason": "http_401"}` | bad key | check the key; the decisions endpoint is alpha and undocumented |
| Inverted-looking noul answers | instructions/proposition polarity mismatch | see D10 in `decisions.md`; rewrite the question so both agree |
| CI fails on ECE only | calibration drift (warning severity) | check dashboard alerts; `--strict` is opt-in only |
| Everything escalates, auto share ~0 | safety lock too strict (the §14.2 failure mode) | check lockfile bands: escalate 0.50 / clean 0.75 |
| Readiness gate holds a solid artifact | near-boundary score variance (n=8 calibration) | treat as advisory; run in shadow mode; grow the set |
| `git revert`-style request escalates | correct behavior per audit (guard-022) | history-altering ops are unsafe-labeled |

## Costs (measured envelope)

Full eval sweep ≈ $0.006 · CI gate ≈ $0.006 · online sample ≈ $0.001 · prelabel batch (100) ≈ $0.002 · one GLM-5.3 escalation ≈ $0.033. The entire build-out to date cost ~$0.05 in Jev calls plus one GLM call.