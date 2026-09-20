# Evaluation Harness & Golden Sets

Implements §7 of `../docs/implementation.md`: offline golden-set evals for the
Jev System-1 layer, plus decision logging for later threshold fitting (Phase 1)
and Jev-as-judge calibration (§7.6).

## Layout

```
evals/
  golden-sets/           # versioned labeled datasets + exact prod criteria
                         #   (structured EntryType boundaries where subtle — see docs/decisions.md D14)
    routing/             # Choice: classify user request intent (-> route)
    guardrails/          # Noul: binary safety/correctness gates
    complexity/          # Score: implementation complexity 0-4
  harness/
    jev_client.py        # Decisions API client (TypeSafe direct / OpenRouter fallback) + JSONL logging
                         #   records model_requested (the dated-snapshot pin) + the provider echo on every call
    metrics.py           # accuracy, ECE, Brier, per-band reports
    run_evals.py        # CLI runner over a golden set
    tests/               # unit tests (entrypoint degradation, model/lockfile consistency,
                         #   golden<->runtime question sync, EntryType shapes) — run keyless
  results/               # eval run reports (versioned JSON)
  logs/                  # full decision logs (one JSON line per API call)
```

## Golden set format

Each set is a directory with:

- `criteria.json` — the exact question definitions used in production
  (identical schema to the Decisions API `questions` field).
- `<set>.golden.jsonl` — one example per line:

```json
{
  "id": "routing-001",
  "state": "the request/task text given to Jev",
  "labels": {"intent": "question"},
  "priority": "high"
}
```

`labels` keys must match the question keys in `criteria.json`. Labels are
either hand-seeded or Jev-as-judge pre-labeled with ~3% human audit (§7.6).

## Usage

```bash
export TYPESAFE_API_KEY=ts-...   # TypeSafe direct; or OPENROUTER_API_KEY=sk-or-... as fallback
# or: cp .env.example .env  — the harness reads the nearest .env; real env vars win

# Run one golden set
python3 evals/harness/run_evals.py evals/golden-sets/routing

# Run all sets
python3 evals/harness/run_evals.py evals/golden-sets
```

Each run writes `evals/results/<set>-<timestamp>.json` and appends every raw
API call to `evals/logs/decisions.jsonl` (model, probabilities, confidence,
usage — everything needed for threshold fitting and calibration tracking).

## Metrics reported

- **choice**: top-1 accuracy; per-confidence-band accuracy; `other` rate
- **noul**: accuracy @ 0.5; Brier score
- **score**: accuracy @ nearest level; MAE (levels)
- **all**: Expected Calibration Error (ECE, 10 bins), latency p50/p95, cost (`null` unless the provider reports one — never $0.00)

Run reports also record `model_resolved` (the pinned dated snapshot, provider-independent) and `model_echo` (what the provider actually served) per set.

## Phase mapping (implementation.md §7.4)

- Phase 0 (now): smoke test ✅ + scaffolding ✅ + seed examples
- Phase 1: fit thresholds from logged runs; baseline metrics
- Phase 2: expand sets with real BMAD artifacts
- Phase 3: CI gate — fail on accuracy drop > 3 pts or ECE > 0.05
## Phase 2 additions

Golden sets:
- `readiness/` — BMAD phase-transition gate questions (noul gates + readiness score),
  including real artifacts from implementation.md and brief.md
- `story_review/` — story/implementation pairs judged by `router/judge.py` (§7.7 rubric);
  run with `python3 evals/harness/run_story_review.py` (no criteria.json — questions
  live in the judge module)

Harness scripts:
- `fit_gates.py` — fits per-gate thresholds (judge + readiness) into
  `router/thresholds.lockfile.json` (`gates` section; meta in `gates_meta`)
- `memory_ablation.py` — Graft-context on/off comparison through the live router

Runtime modules (in `../router/`): `router.py` (System-1 routing),
`bmad_gates.py` (BMAD readiness gates), `judge.py` (System-2 output rubric),
`memory.py` (Graft + optional Mem0 retrieval). All load thresholds from the
lockfile; all calls logged to `evals/logs/`.

## Phase 3 additions

- `ci_gate.py` — CI regression gate (accuracy drop > 3 pts or model drift = fail; ECE and provider-echo drift = warn unless `--strict`); `--update-baseline` refreshes `results/baseline.json`; wired to `.github/workflows/evals.yml`
- `online_sample.py` — ~3% log sampling (`--seed` for reproducibility), Jev hindsight review, ~3% human audit queue, memory-relevance scoring, `production_metrics.json` snapshots
- `dashboard.py` — `results/dashboard.md` + `alerts.json` vs §7.5 targets
- `prelabel.py` — Jev-assisted golden-set growth: `--generate <set> <candidates.jsonl>` proposes labels into `audit/prelabel_queue.jsonl`; human approves; `--promote <set>` appends to the golden set
- `agent_id` parameter on router/judge/gates for multi-agent logging
