# Jev-BMAD — Hybrid System-1 / System-2 Agentic Architecture

Kahneman's dual-process theory, operationalized:

- **System 1 (fast)**: [Jev](https://openrouter.ai) via the OpenRouter Decisions API — typed, probabilistic, calibrated decisions in ~350 ms at ~$0.00002/call, using all three primitives (`choice`, `score`, `noul`)
- **System 2 (slow)**: GLM-5.3 via OpenRouter chat completions — deep reasoning for escalated work (~105 s, ~$0.03/call)
- **Harness**: pi.dev · **Memory**: Graft (code, live) + Mem0 (semantic, pluggable) · **Process**: BMAD-Method
- **Doctrine**: evaluation-first — nothing ships without golden sets, held-out validation, fitted thresholds, and an audit trail

**Status (2026-09-19):** Phases 0–3 complete, holdout-validated, audit pass done. Experimental, local-only, not pushed. Full history and methodology: [`implementation.md`](implementation.md) (v1.5, incl. §14 known limitations).

## How it works

```
request ──▶ router.py: ONE batched Jev call
            intent (choice) + safety (noul) + complexity (score)
            │  + retrieved memory (Graft) in state
            │  + injection gate on the auto path
            ▼
   ┌── system1_auto ──┬── clean band ──────────▶ host executes      ~1.1 s   $0.00005
   │                  └── flagged band ─────────▶ execute + audit flag
   └── system2 ───────▶ GLM-5.3 with context ──▶ deep work           ~105 s   $0.033
```

## Repo map

| Path | What it is |
|---|---|
| `router/router.py` | System-1 router: batched gates, tiered safety bands, injection gate, full logging |
| `router/hybrid.py` | End-to-end dispatcher (route → auto or GLM-5.3), end-to-end latency + cost |
| `router/system2.py` | GLM-5.3 consumer, cost/latency log, `decision_id` linkage |
| `router/bmad_gates.py` | BMAD phase-transition readiness gates (noul gates + score + blocker taxonomy) |
| `router/judge.py` | §7.7 story-review rubric (3 gates + 4 dims + failure taxonomy), Jev-as-judge |
| `router/memory.py` | Unified retrieval: Graft CLI (live) + Mem0 REST (activates with `MEM0_API_KEY`) |
| `router/thresholds.lockfile.json` | Fitted thresholds + model pin; fitted on train splits only |
| `evals/` | Golden sets, harness, results, audit queues — see [`evals/README.md`](evals/README.md) |
| `implementation.md` | The plan, phase records, baselines, findings, §14 limitations |
| `.github/workflows/evals.yml` | CI regression gate (accuracy drop > 3 pts or model drift fails) |

## Quickstart

```bash
export OPENROUTER_API_KEY=sk-...          # required for everything live

python3 router/hybrid.py "What does the router do?"       # full loop demo
python3 router/router.py "Drop the users table"           # routing decision only
python3 evals/harness/run_evals.py evals/golden-sets       # full eval sweep (~$0.006)
python3 evals/harness/ci_gate.py                           # regression gate vs baseline
python3 evals/harness/dashboard.py                         # metrics + alerts vs §7.5 targets
python3 evals/harness/holdout_validate.py                  # honest held-out numbers
python3 evals/harness/online_sample.py                     # hindsight sampling + audit queue
python3 evals/harness/prelabel.py --generate <set> <candidates.jsonl>   # scale a golden set
```

## Verified state (2026-09-19, model `typesafe/jev-1.13-20260917`)

| Component | Metric |
|---|---|
| Routing (choice, n=103) | 100% holdout acc (n=21), ECE 0.006, `other` rate 3.3% |
| Guardrails (noul, n=100) | 100% holdout acc (n=20), Brier 0.034; unsafe ≤ 0.17, safe ≥ 0.50 (bimodal) |
| Complexity (score, n=117) | 93.2% acc, MAE 0.15; audited hard stratum 13/17 (76%) |
| Story judge (§7.7, n=10) | 100% verdict accuracy (fitted; provisional — set too small to split) |
| Readiness gates (n=8) | 75–78% — provisional, needs growth |
| Tiered safety bands | < 0.50 escalate · 0.50–0.75 auto+flag · ≥ 0.75 clean auto |
| Injection gate | clean 0.41 passes · blatant injection 0.97 escalates |
| System-2 economics | GLM call ≈ 670× System-1 cost; ≥40% cost reduction holds at ≤60% escalation |

## Safety design

- **Opt-in everywhere**: zero network calls unless `OPENROUTER_API_KEY` is set; CI skips cleanly without it
- **Tiered bands** instead of a single cliff (drift fails soft: clean → flagged before auto → escalate)
- **Serial injection gate** on every auto path — checks the full state including retrieved context; unavailable check = conservative escalation; unchecked requests never auto-execute
- **Advisory doctrine in the fork**: `proceed` is one vote, never an approval; `hold` surfaces reasons, never an automatic block
- **Explicit failure statuses** everywhere: `disabled` / `unavailable` with machine-readable reasons, bounded retries, never silent success

## Honest limitations (summary — full list in §14)

1. **Selection bias**: scaled golden sets were filtered to author+Jev agreement; numbers are internal estimates, not production forecasts
2. **Partial circularity**: 12 of 17 audit-settled labels match Jev's own calls (excluded from splits/fitting; a fully independent human-labeled batch is still the open §7.6 gate)
3. **System-1 share target unmeasured**: ≥70% needs real production traffic (demo traffic skews hard)
4. Readiness/story_review sets too small to split — provisional

## Related repo

The BMAD-METHOD fork (`~/projects.io/BMAD-METHOD`) carries the skill-side wiring:
`feature/jev-decision-assist` = recommendation pilot (unchanged) · `feature/jev-gates` = readiness-gate + story-review CLIs (`jev_gates.py`, `jev_readiness.py`, `jev_review.py`), thresholds seeded from this repo's fitted lockfile. Both opt-in, disabled by default, advisory-only.

## Key lessons (encode these into future Jev work)

1. **Polarity alignment**: noul `instructions` and `proposition` must agree — misalignment returns inverted probabilities (found live, fixed, tested)
2. **Thresholds are data, not aspirations**: §7.7's hardcoded 0.95 rejected every passing story; fitted thresholds took verdict accuracy 60% → 100%
3. **Jev's noul is bimodal on safety**: treat mid-range as a signal (bands), not as "probably unsafe" (single high cut)
4. **The audit loop catches author errors**: guard-022 and the hard-set stratum were both author-labeling mistakes Jev caught first