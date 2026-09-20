# Jev-BMAD — Hybrid System-1 / System-2 Agentic Architecture

**Jev-BMAD** is an evaluation-first decision layer for agentic workflows that
operationalizes Kahneman's dual-process theory. A fast, cheap, calibrated
System-1 model (Jev) routes and gates every request — intent, safety, and
complexity in a single batched call — and conservatively escalates anything it
cannot clear to a slow, deep-reasoning System-2 model. It ships as a standalone
router pipeline and as an installable [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD)
module, with golden sets, held-out validation, fitted thresholds, and an audit
trail backing every behavior change.

At a glance:

- **System 1 (fast)**: [Jev](https://docs.typesafe.ai) via the TypeSafe Decisions API (TypeSafe direct, or OpenRouter fallback) — typed, probabilistic, calibrated decisions in ~350 ms at ~$0.00002/call, using all three primitives (`choice`, `score`, `noul`), with structured JSON question boundaries where the docs recommend them
- **System 2 (slow)**: GLM-5.3 via OpenRouter chat completions — deep reasoning for escalated work (~105 s, ~$0.03/call)
- **Harness**: pi.dev · **Memory**: Graft (code, live) + Mem0 (semantic, pluggable) · **Process**: BMAD-Method
- **Doctrine**: evaluation-first — nothing ships without golden sets, held-out validation, fitted thresholds, and an audit trail

**Status (2026-09-20):** Phases 0–3 complete, holdout-validated, audit pass done, plus a 2026-09-20 hardening pass (provider-independent eval provenance, structured question boundaries, golden↔runtime sync tests). Released as [`v0.1.0`](https://github.com/peskycipher/jevBMAD/releases/tag/v0.1.0) — experimental; evaluation methodology and known limitations are published, not hidden. Full history and methodology: [`docs/implementation.md`](docs/implementation.md) (v1.5.3, incl. §14 known limitations).

> **Template note:** this repo is a GitHub template — click **"Use this template"** to start your own copy. The release link above, commit history, and evaluation results all document *this* repository's provenance; they do not describe your fork's state until you re-run the evaluation pipeline yourself (see [Quickstart](#quickstart)).

## Installation

### 1. Clone and set up the repo

```bash
# Install uv (https://docs.astral.sh/uv/):
curl -LsSf https://astral.sh/uv/install.sh | sh

git clone https://github.com/peskycipher/jevBMAD.git
cd jevBMAD

# uv manages Python 3.11+ automatically (scripts are stdlib-first / PEP 723)
# API keys: copy the example env file and fill in your keys
cp .env.example .env
# then edit .env and set TYPESAFE_API_KEY (preferred) and/or OPENROUTER_API_KEY

# Verify the install — 35 contract/sync tests pass with no API key:
uv run python -m unittest discover -s evals/harness/tests

# Optional: run the skill-script test suites too (they need pytest; the dev
# requirements are injected ephemerally — nothing is installed into a venv):
uv run --with-requirements requirements-dev.txt pytest .agents/skills modules/bmad-jev
```

Without either key nothing makes network calls — every CLI and skill
degrades to explicit `disabled` / `unavailable` statuses instead.

### 2. Install as a BMad module (optional)

The decision layer is also packaged as an installable BMad module in
[`modules/bmad-jev/`](modules/bmad-jev/README.md) (skills: `jev-setup`,
`bmad-jev-decide`, `bmad-jev-gates`, `bmad-jev-review`):

```bash
# One-liner via the BMad installer (pulls the module straight from this repo):
npx bmad-method install --custom-source https://github.com/peskycipher/jevBMAD \
  --tools claude-code --yes

# The install bundles an env template at
# .claude/skills/jev-setup/assets/env.example — copy it to .env in your
# project and fill in TYPESAFE_API_KEY (preferred) and/or OPENROUTER_API_KEY

# Or, from a local clone:
bmad install modules/bmad-jev

# Or run the jev-setup skill in-project after copying the folder to the
# host's skill directory (.claude/skills/ for Claude Code, .agents/skills/ for pi)
```

See [`modules/bmad-jev/README.md`](modules/bmad-jev/README.md) for runtime
requirements and configuration (`off` / `shadow` / `suggest` modes).

### 3. Try it

```bash
uv run python router/hybrid.py "What does the router do?"   # full loop demo (needs key)
```

More commands: [Quickstart](#quickstart) below.

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

### Router core

| Path | What it is |
|---|---|
| `router/router.py` | System-1 router: batched gates, tiered safety bands, injection gate, full logging |
| `router/hybrid.py` | End-to-end dispatcher (route → auto or GLM-5.3), end-to-end latency + cost |
| `router/system2.py` | GLM-5.3 consumer, cost/latency log, `decision_id` linkage |
| `router/bmad_gates.py` | BMAD phase-transition readiness gates (noul gates + score + blocker taxonomy) |
| `router/judge.py` | §7.7 story-review rubric (3 gates + 4 dims + failure taxonomy), Jev-as-judge |
| `router/memory.py` | Unified retrieval: Graft CLI (live) + Mem0 REST (activates with `MEM0_API_KEY`) |
| `router/thresholds.lockfile.json` | Fitted thresholds + model pin; fitted on train splits only |

### Evaluation

| Path | What it is |
|---|---|
| `evals/` | Golden sets, harness, results, audit queues — see [`evals/README.md`](evals/README.md) |
| `docs/` | Expanded documentation: architecture, evaluation methodology, reference, runbooks, decision log — see [`docs/index.md`](docs/index.md) |
| `docs/implementation.md` | The plan, phase records, baselines, findings, §14 limitations |
| `.github/workflows/evals.yml` | CI regression gate (accuracy drop > 3 pts or model drift fails) |

### BMad integration

| Path | What it is |
|---|---|
| `modules/bmad-jev/` | Installable BMad module — `jev-setup`, `bmad-jev-decide`, `bmad-jev-gates`, `bmad-jev-review` skills ([README](modules/bmad-jev/README.md)) |
| `_bmad/` | BMad Method config (TOML-based), manifests, and the canonical Jev adapter scripts (`jev_adapter.py`, `jev_recommend.py`, `jev_policy.py`) |
| `.agents/skills/` | All installed BMad skills, rendered for the pi harness (BMM plan/ship pipeline + BMad Builder factory + the jev module) |

## Quickstart

```bash
# requires keys in .env — see [Installation](#1-clone-and-set-up-the-repo) above
uv run python -m unittest discover -s evals/harness/tests   # contract tests — no key needed

uv run python router/hybrid.py "What does the router do?"       # full loop demo
uv run python router/router.py "Drop the users table"           # routing decision only
uv run python evals/harness/run_evals.py evals/golden-sets       # full eval sweep (~$0.006)
uv run python evals/harness/ci_gate.py                           # regression gate vs baseline
uv run python evals/harness/dashboard.py                         # metrics + alerts vs §7.5 targets
uv run python evals/harness/holdout_validate.py                  # honest held-out numbers
uv run python evals/harness/online_sample.py                     # hindsight sampling + audit queue
uv run python evals/harness/prelabel.py --generate <set> <candidates.jsonl>   # scale a golden set
```

## Verified state (2026-09-20, model `typesafe/jev-1.13-20260917`)

| Component | Metric |
|---|---|
| Routing (choice, n=103) | 100% holdout acc (n=21), ECE 0.006, `other` rate 3.3% |
| Guardrails (noul, n=100) | 100% holdout acc (n=20); 100% full-set acc since structured boundaries (Brier 0.013); unsafe ≤ 0.17, safe ≥ 0.50 (bimodal) |
| Complexity (score, n=117) | 92–93% acc (run-to-run variance), MAE 0.155; audited hard stratum 13/17 (76%) |
| Story judge (§7.7, n=10) | verdict accuracy 60% on the 2026-09-20 live run (100% on the fitted subset 2026-09-19; provisional — set too small to split) |
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

The BMAD-METHOD integration lives in a companion fork: [`peskycipher/BMAD-METHOD`](https://github.com/peskycipher/BMAD-METHOD).

- `feature/jev-decision-assist` — recommendation pilot (adapter, policy, `jev_recommend.py` CLI), pushed and public
- `feature/jev-gates` — readiness-gate + story-review CLIs (`jev_gates.py`, `jev_readiness.py`, `jev_review.py`), thresholds seeded from this repo's fitted lockfile — **validated locally (167 tests), not yet pushed to the public fork**

Both opt-in, disabled by default, advisory-only. Details: [`docs/bmad-integration.md`](docs/bmad-integration.md).

## Key lessons (encode these into future Jev work)

1. **Polarity alignment**: noul `instructions` and `proposition` must agree — misalignment returns inverted probabilities (found live, fixed, tested)
2. **Thresholds are data, not aspirations**: §7.7's hardcoded 0.95 rejected every passing story; fitted thresholds took verdict accuracy 60% → 100%
3. **Jev's noul is bimodal on safety**: treat mid-range as a signal (bands), not as "probably unsafe" (single high cut)
4. **The audit loop catches author errors**: guard-022 and the hard-set stratum were both author-labeling mistakes Jev caught first