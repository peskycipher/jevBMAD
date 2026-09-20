# Evaluation Methodology

The doctrine: nothing is trusted until it survives golden sets, a held-out split, fitted thresholds, and — for disputed cases — an audit. The history of this doctrine is in `implementation.md` §14 (known limitations); this file describes the methodology as implemented.

## Golden sets

| Set | n | Primitive | Question | Status |
|---|---|---|---|---|
| routing | 103 | choice | intent: bug_fix / new_feature / question / refactor / docs_config / other | holdout-validated |
| guardrails | 100 | noul | safe to auto-execute? (structured true/false boundary: what + examples) | holdout-validated (audit-corrected); full-set acc 1.000 since structured questions |
| complexity | 117 | score | 0–4 implementation complexity | holdout-validated; 17 audited stratum excluded from splits |
| readiness | 8 | noul×3 + score + choice | BMAD phase-transition gates (structured boundaries + `{summary, signals, examples}` levels) | provisional (too small); full-set acc 0.781, ECE 0.22 |
| story_review | 10 | rubric | §7.7 judge over story/implementation pairs | provisional (too small) |
| hard (hard-sets/) | 18 | mixed | the preserved disagreement cases | settled by audit 2026-09-19 |

Growth path is the prelabel pipeline (Jev proposes, audit confirms, promote only agreements). Provenance is recorded per example (`source` field) — hand-authored, `jev-prelabel+human-confirm`, `human-audit`, or `online-sample` (the completed feedback cycle).

## Metric definitions

- **Accuracy**: top-1 for choice; nearest-level for score; (pred ≥ 0.5) vs label for noul in eval scoring. *Caveat:* eval noul scoring uses 0.5 while production gates use the fitted band values — holdout reports evaluate at production thresholds too.
- **Brier** (noul): mean (prob − label)². Guardrails: 0.013 (structured-boundary questions, run-20260920-151200).
- **MAE** (score): mean |prediction − label| in levels. Complexity: 0.155.
- **ECE**: 10-bin calibration error. *Honest caveat:* the implementation mixes hard accuracy (choice/score) with soft 1−|pred−label| (noul), and score `confidence` is a distribution-concentration statistic — so the §10 "ECE > 0.05" alert is ill-defined across sets. Treated as an alerting signal only (dashboard), never a CI hard-fail without `--strict`.
- **Auto-band accuracy**: accuracy among records whose production decision is "auto" at a given threshold — the number that actually matters for routing.

## Splits (holdout validation)

Deterministic stratified 80/20 per set (seed 42, stratified by exact label signature), written **once** to `golden-sets/*/splits/` and never reshuffled — a reshuffled holdout is a leaked holdout. Thresholds fit on train only; results reported on holdout at both train-fitted and locked thresholds. Run: `python3 evals/harness/holdout_validate.py`.

**Verified holdout numbers (2026-09-19):**

| Set | Train | Holdout | At production threshold |
|---|---|---|---|
| routing | 100% | **100%** (n=21) | 100% auto-band @ intent 0.75 |
| guardrails | 100% | **100%** (n=20) | 9 auto, 100% acc @ escalate 0.50 |
| complexity | 96.3% | **90%** (n=20) | 9 auto, 100% acc @ cap 1.5 |

The complexity train→holdout gap (96→90) is the overfit that same-data reporting hid — the reason this file exists.

## Threshold fitting

- `fit_thresholds.py`: routing gates (intent confidence, safety noul, complexity cap) — swept to maximize auto-rate under a 95% auto-band-accuracy floor, then **locked at the strictest of (fitted, §10 default)**.
- `fit_gates.py`: per-gate judge and readiness thresholds from per-record eval detail.
- Lockfile (`router/thresholds.lockfile.json`): fitted values, locked values, provenance (n, source run, resolved model), status (`candidate-final`).
- **Coupling rule**: any criteria wording change invalidates fitted thresholds (only model-version changes trigger automated re-fit — manual awareness required on criteria edits). One drift class **is** now machine-checked: `evals/harness/tests/test_questions_golden_sync.py` fails CI when runtime `QUESTIONS` (bmad_gates, judge) drift from the golden-set payloads, when a golden label is no longer a supplied Choice option key, or when any question violates the documented EntryType shapes.

## The audit pipeline

1. **Prelabel**: `prelabel.py --generate` — Jev proposes labels for candidate examples into `evals/audit/prelabel_queue.jsonl`.
2. **Audit**: `audit_prelabel.py` — proposals checked against author intent. Agreement → promote; disagreement → drop (**the disagreement rule**: coin-flip labels never enter ground truth).
3. **Human audit queue** (`evals/audit/human_audit_queue.jsonl`): labeling disputes, hard-set settlements, online-sample hindsight confirmations.
4. **Hard set** (`evals/hard-sets/`): dropped disagreement candidates preserved with both labels — the boundary-case signal, measured (Jev's calls were systematic: 17/17 stable), settled by audit (12 Jev-right, 5 author-right, 1 discard).

## Known biases (unchanged, on the record)

1. **Selection bias**: sets were filtered to author+Jev agreement — numbers are internal estimates on a filtered distribution, not production forecasts.
2. **Partial circularity**: 12/17 audit-settled labels match Jev's own calls (user approved assistant recommendations). Those 17 are excluded from splits and threshold fitting. The real §7.6 gate — a fully independent human-labeled batch — remains open.
3. **Distribution shift**: all candidates are English, single-tenant, synthetic; production BMAD traffic will differ. Online sampling + drift alerts are the mitigation.

## CI gate

`ci_gate.py` against the committed `evals/results/baseline.json`:
- **Hard-fail**: per-set accuracy drop > 3 pts; resolved-model drift vs lockfile (the lockfile records the logical pin, provider-independent — D13).
- **Warn** (dashboard alerts): ECE > 0.05; provider echo neither the pinned snapshot nor its known alias (early repoint signal, D13).
- Skips cleanly (exit 0) without `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`; `--strict` promotes warnings to failures; `--update-baseline` refreshes after intentional changes. Unknown flags are silently ignored (manual argv checks) — typos don't error.
- Noise caveat: a 3-point threshold on n=100 is ~3 examples, near observed run-to-run variance — aggregate multiple runs before investigating a single failure.