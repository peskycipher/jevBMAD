# Implementation Plan: Hybrid System-1 / System-2 Agentic Architecture
**Jev AI (System 1) + GLM-5.3 (System 2) + pi.dev Harness + Mem0 + Graft**  
Integrated with the BMAD-Method Workflow

**Version:** 1.5  
**Date:** 2026-09-19  
**Status:** Ready for Implementation  

**Changelog**  
- v1.0: Initial hybrid architecture  
- v1.1: Added Jev confidence calibration techniques  
- v1.2: Corrected public access path (OpenRouter only)  
- v1.3: Full integration of Jev primitives, structured criteria, API details, and best practices  
- v1.4: Added comprehensive evaluation (evals) framework, metrics, offline/online evaluation strategy, and integration into all phases
- v1.5: Jev-as-judge replaces most human-in-the-loop labeling/review; System-2 output rubric added (§7.7); Choice `other` → System-2 fallback; default model set to `~typesafe/jev-latest`

---

## 1. Executive Summary

Build a production-ready agentic system that operationalizes Kahneman’s *Thinking, Fast and Slow*:

- **System 1 (Fast)**: Jev AI — typed, probabilistic, low-latency decisions (70–500 ms) with calibrated confidence  
  → **Publicly accessible only via OpenRouter Decisions API**
- **System 2 (Slow)**: GLM-5.3 — deep reasoning, long-horizon coding, high-effort analysis
- **Harness**: pi.dev — minimal, extensible agent runtime
- **Memory Layer**:
  - **Mem0** — general long-term semantic/episodic memory (facts, preferences, decisions)
  - **Graft (Trail Brain)** — codebase structural & project memory
- **Process Framework**: BMAD-Method (Analysis → Planning → Solutioning → Implementation)

The system uses Jev’s three primitives (Choice, Score, Noul), structured criteria, and calibrated confidence as the primary gating mechanism between fast System-1 decisions and slower System-2 reasoning. A rigorous evaluation framework ensures accuracy, calibration quality, cost efficiency, and end-to-end reliability.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     BMAD Workflow Phases                        │
│  Analysis → Planning → Solutioning → Implementation             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      pi.dev Harness                             │
│  • Core tools: read / write / edit / bash                       │
│  • Extensions: routing, memory, multi-model, BMAD skills        │
│  • Session state + tree history                                 │
│  • Evaluation hooks & logging                                   │
└────────────┬───────────────────────────────┬────────────────────┘
             │                               │
    ┌────────▼────────┐             ┌────────▼────────┐
    │   System 1      │             │   System 2      │
    │   Jev AI        │◄──confidence┤   GLM-5.3       │
    │ (via OpenRouter)│   thresholds│ (deep reasoning)│
    └────────┬────────┘             └────────┬────────┘
             │                               │
             └───────────────┬───────────────┘
                             │
              ┌──────────────▼──────────────┐
              │     Memory Retrieval        │
              │  ┌─────────┐  ┌──────────┐  │
              │  │  Mem0   │  │  Graft   │  │
              │  │ (facts) │  │ (code)   │  │
              │  └─────────┘  └──────────┘  │
              └─────────────────────────────┘
```

### Core Routing Policy
1. Retrieve relevant memories from Mem0 + Graft.
2. Call **Jev via OpenRouter** (`POST /api/alpha/decisions`) using appropriate primitives and structured criteria.
3. Apply **risk-adjusted, data-tuned confidence thresholds** (see §6).
4. High confidence → auto-execute (System 1).  
   Low confidence, a Choice outcome of `other`, or complexity flags → escalate to GLM-5.3 (System 2).
5. After System 2, write durable knowledge back to Mem0 and Graft.
6. Log full decision path (model ID, probabilities, confidence, thresholds, outcome) for evaluation.

---

## 3. Jev Primitives (Choice, Score, Noul)

| Primitive | Purpose | Returns | Best Used For |
|-----------|---------|---------|---------------|
| **Choice** | Select one option from a closed unordered set (max 255) | `choice`, full `probabilities`, `confidence` | Routing, classification, triage, tool selection |
| **Score** | Place state on an ordered scale (2–10 levels) | Fractional `score`, `probabilities`, `confidence`, `legend` | Severity, risk, urgency, quality, readiness |
| **Noul** | Evaluate a yes/no proposition | `noul` (probability 0–1) | Guardrails, detection, binary checks, preconditions |

**Decision Guide**  
- Unordered categories → **Choice** (always include `"other"`)  
- Ordered intensity / degree → **Score**  
- Clear yes/no condition → **Noul**  
- Multiple labels can be true → Multiple independent **Nouls**
- Choice returns `other` (no listed option fits) → **Fallback to System 2**; never force a listed category  
- Complex judgment → Decompose into atomic primitives + combine in code  

**Anti-Patterns**  
Using Score for unordered categories • Using Choice when multiple answers can be true • Broad multi-dimensional questions • Omitting `"other"` • Treating Noul ≈ 0.5 as “moderately true” • Embedding policy inside criteria.

---

## 4. Structured Criteria Objects

`instructions` and all `criteria` fields accept `string | object | array | null`.

Use structured objects when neighboring options/levels are confused, when contrastive guidance is needed, or when realistic examples help.

**Recommended consistent fields**:
```json
{
  "what": "What this option/level covers",
  "not_for": "What belongs elsewhere",
  "examples": ["Realistic example 1", "Realistic example 2"]
}
```

Start with simple strings; upgrade to structured objects only when needed.

---

## 5. Jev API Integration (OpenRouter Only)

**Endpoint**:
```
POST https://openrouter.ai/api/alpha/decisions
```

**Do not** use `/api/v1/chat/completions`.

**Recommended Model IDs**:
- Default (current decision): `~typesafe/jev-latest`
- Optional pinned alias: `typesafe/jev-1.13` (only if reproducibility is later required)

**Pricing**: $0.042 / M input tokens • $0 output tokens • Context ≈ 32k

Always log the exact `model` string returned (the resolved version behind `~jev-latest`). Re-fit thresholds whenever the resolved version changes.

---

## 6. Confidence Calibration Strategy

Jev is trained with **Reinforcement Learning for Calibrated Decisions (RLCD)**. Confidence is a population-level signal.

**Process**:
1. Collect labeled examples (≥ 100–200 per high-stakes question).
2. Record full probability distributions + confidence.
3. Fit risk-adjusted thresholds on training split; validate on held-out data.
4. Pin the exact OpenRouter model ID.
5. Continuously monitor accuracy vs. confidence bands.
6. Re-fit on model updates or distribution shift.

**Starting Bands** (must be tuned on your data):
| Band   | Action                          |
|--------|---------------------------------|
| High   | Auto-execute                    |
| Medium | Execute + flag / gather more data |
| Low    | Escalate to GLM-5.3 or human    |

---

## 7. Evaluation Framework (Evals)

A robust evaluation system is required to trust the hybrid architecture in production.

### 7.1 Evaluation Layers

| Layer | Purpose | Frequency | Data Source |
|-------|---------|-----------|-------------|
| **Offline Golden-Set Evals** | Measure accuracy, calibration, and regression | On every model/threshold/criteria change | Curated labeled datasets |
| **Online Production Monitoring** | Detect drift, measure real-world performance | Continuous | Live traffic + sampled human labels |
| **End-to-End BMAD Evals** | Measure business outcomes | Per sprint / release | Story completion, QA gates, human review |
| **Cost & Latency Evals** | Ensure efficiency targets | Continuous + weekly reports | System logs |
| **Memory Quality Evals** | Measure retrieval usefulness | Weekly / on memory schema changes | Sampled retrievals + human judgment |

### 7.2 Core Metrics

**Jev / System-1 Metrics**
- Accuracy (overall and per confidence band)
- Calibration quality (Expected Calibration Error – ECE, Brier score)
- High-confidence precision / recall
- Escalation rate (to System 2 or human)
- Latency (p50, p95)
- Cost per decision

**System-2 (GLM-5.3) Metrics**
- Task success rate on escalated cases
- Latency and cost of escalated path
- Quality of final output (human or automated scoring)

**End-to-End / BMAD Metrics**
- % of decisions handled by Jev (target ≥ 70%)
- Story implementation first-pass rate (target ≥ 85%)
- Overall cost reduction vs pure System-2 baseline (target ≥ 40%)
- Average end-to-end latency
- Human audit rate (only for auditing the Jev judge; routine labeling is Jev-as-judge)
- Memory hit rate and relevance (target ≥ 80%)
- Memory decision-flip rate — share of decisions that change when retrieval is disabled (boundary-effect measure; Phase 2 finding: mean confidence deltas ≈ 0 but flips occur at thresholds)

**Calibration-Specific Metrics**
- Accuracy within each confidence bin
- Reliability diagram / ECE
- Brier score (especially for Noul questions)

### 7.3 Evaluation Assets to Build

1. **Golden Sets**
   - Per high-stakes question type (routing, risk, readiness, guardrails, etc.)
   - Minimum 100–300 carefully labeled examples
   - Include edge cases, ambiguous cases, and adversarial examples
   - Versioned and stored alongside the codebase

2. **Evaluation Harness**
   - Scriptable runner that calls Jev (via OpenRouter) and GLM-5.3
   - Computes accuracy, calibration metrics, latency, and cost
   - Supports threshold sweeping
   - Outputs reliability diagrams and per-band reports
   - Integrates with CI (fail build on significant regression)

3. **Online Sampling Pipeline**
   - Continuously sample production decisions
   - Label samples with Jev-as-judge primitives (Score/Noul), not humans
   - Route a small percentage (~3%) for human audit of the judge itself
   - Feed labels back into golden sets and threshold re-fitting

4. **Dashboards**
   - Real-time: escalation rate, latency, cost, confidence distribution
   - Weekly: calibration health, accuracy trends, memory quality
   - Alerting on ECE drift, sudden accuracy drops, or cost spikes

### 7.4 Evaluation in Each Phase

| Phase | Evaluation Focus |
|-------|------------------|
| Phase 0 | Basic smoke tests of Jev via OpenRouter; initial golden-set scaffolding |
| Phase 1 | Offline accuracy + calibration on first golden sets; threshold fitting |
| Phase 2 | End-to-end BMAD story success rates; memory contribution analysis |
| Phase 3 | Full online monitoring, continuous calibration, regression protection in CI |

### 7.5 Success Criteria (3-Month Targets)

| Metric | Target |
|--------|--------|
| Jev decision share | ≥ 70% |
| High-confidence band accuracy | Meets or exceeds fitted target |
| ECE / calibration quality | Stable and within acceptable bounds |
| Cost reduction vs pure GLM-5.3 | ≥ 40% |
| Story first-pass rate | ≥ 85% |
| Memory relevance | ≥ 80% |
| p95 end-to-end latency | < 2.5–3.0 s (mixed traffic) |

---

### 7.6 Jev-as-Judge: Replacing the Human in the Loop

Human labeling and review are replaced by Jev primitives wherever feasible. Humans are retained **only to audit the judge itself**.

| Former human role | Jev replacement |
|-------------------|-----------------|
| Golden-set labeling | Pre-label with atomic primitives: **Noul** for binary correctness, **Score** for graded quality, **Choice** for failure/label taxonomy |
| Online sample labeling | Jev-as-judge on sampled decisions; ~3% audited by human |
| System-2 output review | Rubric in §7.7 |
| Memory relevance judgment | **Score** relevance of sampled retrievals |
| Routing overrides | **Noul**: "was the System-1 decision correct in hindsight?" |

**Judge calibration**: judge agreement with the human audit set must meet target (≥ 95% on Noul gates, ECE < 0.05 on Score) before its labels are trusted. Re-audit periodically and after any resolved-model change.

### 7.7 System-2 Output Rubric (Jev-primitive based)

**Gates (Noul — all must pass, threshold ≥ 0.95):**
- Implements exactly what the story/requirement specifies
- Does not break existing behavior (tests pass, no regressions)
- No security or data-safety violations

**Scored dimensions (Score, 2–10 with concrete legend):**
- Correctness & completeness
- Code quality / maintainability
- Test coverage adequacy
- BMAD compliance (artifacts and gates followed)

**Failure taxonomy (Choice — only when a gate fails):**
`spec-misread` | `partial-implementation` | `regression` | `architecture-violation` | `test-gap` | `environment` | `other`

**Pass rule**: all gates pass AND every Score dimension ≥ 7 → first-pass success. Otherwise a rework loop with taxonomy-driven feedback; escalate to a human after 2 failed reworks.

## 8. Component Responsibilities

| Component     | Access / Role                              | Notes |
|---------------|--------------------------------------------|-------|
| **Jev AI**    | OpenRouter Decisions API only              | System 1 – fast typed decisions + calibrated confidence |
| **GLM-5.3**   | Standard LLM providers                     | System 2 – deep reasoning & long-horizon coding |
| **pi.dev**    | Local / self-hosted                        | Harness + extensions for routing, memory, BMAD, eval hooks |
| **Mem0**      | Platform or self-hosted                    | Cross-session facts, preferences, decisions |
| **Graft**     | Local                                      | Codebase structural & project memory |
| **Eval Harness** | Internal                                | Offline + online evaluation, calibration reports, CI gates |

---

## 9. Phased Implementation Roadmap

### Phase 0: Foundations (Week 1)
- [x] Create OpenRouter account and API key
- [x] Confirm Jev model IDs and successful Decisions API calls
- [x] Install and configure pi.dev, Mem0, Graft
- [x] Scaffold golden-set structure and evaluation harness skeleton
- [x] Begin collecting labeled examples for highest-priority questions

**Exit Criteria**: End-to-end Jev call works; basic eval runner can execute a small golden set. ✅ **Met 2026-09-19** — live smoke test of all 3 primitives passed (model resolved: `typesafe/jev-1.13-20260917`); eval harness at `evals/` ran 3 golden sets (32 examples, 0 errors): routing 100% acc / ECE 0.0, guardrails 100% acc / Brier 0.015, complexity 90% acc / MAE 0.14 levels; p50 latency ~350–370 ms; ~$0.00002/example.

### Phase 1: Core Hybrid Loop + Initial Calibration & Evals (Weeks 2–3)
- [x] Implement unified memory retrieval — `router/memory.py` (Graft CLI live; Mem0 REST activates when `MEM0_API_KEY` is set)
- [x] Implement System-1 router (Jev primitives + structured criteria) — `router/router.py`; one batched call: intent (choice) + safe_auto (noul) + complexity (score); criteria reuse golden-set definitions (single source of truth)
- [x] Full decision logging (probabilities, confidence, model ID, outcome) — `evals/logs/decisions.jsonl` + `evals/logs/routing.jsonl`
- [x] Build first version of offline evaluation harness — `evals/harness/` (+ per-record detail, threshold fitter `fit_thresholds.py`)
- [x] Fit initial thresholds on golden sets — `router/thresholds.lockfile.json` (status: provisional at 78 examples; target ≥ 100)
- [x] Establish baseline accuracy, calibration, latency, and cost metrics — see below

**Exit Criteria**: Majority of simple decisions handled by Jev; offline evals running; conservative thresholds locked. ✅ **Met 2026-09-19** (provisional pending golden sets ≥ 100).

**Phase 1 Baseline** (78 examples, run `run-20260919-224600`, model `typesafe/jev-1.13-20260917`):
| Set | Accuracy | Calibration | Notes |
|---|---|---|---|
| routing (choice) | 100% | ECE 0.027 | `other` rate 16.7%, matches labels |
| guardrails (noul) | 95.8% | Brier 0.060 | 1 miss on a borderline case |
| complexity (score) | 83.3% | MAE 0.18 levels | nearest-level scoring |

Latency p50 ≈ 360–380 ms; cost ≈ $0.00002/example. Fitted thresholds (0.5 / 0.5 / 1.75) were far looser than §10 defaults — model is well-calibrated on these seeds — so **locked conservative**: intent_conf_min 0.75, safe_noul_min 0.90, complexity_max 1.5.

**Phase 1 finding — `other` over-escalation**: docs/config-only requests (e.g. "fix typo in README") classify as `intent=other` → System 2 fallback per §3. Safe+trivial docs edits are escalated unnecessarily. Phase 2 candidate: add a `docs_config` label to the routing criteria and relabel the 4 affected golden examples (routing-008/017/022/027).

### Phase 2: BMAD Integration + End-to-End Evals (Weeks 4–5)
- [x] Map hybrid routing onto BMAD phases — `router/bmad_gates.py`: phase-transition gates (analysis→planning→solutioning→implementation) via batched noul gates + readiness Score + blocker-taxonomy Choice
- [x] Create BMAD-specific skills and readiness gates — `router/judge.py` implements the §7.7 System-2 rubric (3 Noul gates + 4 Score dims + failure-taxonomy Choice)
- [x] Implement end-to-end BMAD evaluation (story success, first-pass rate) — `evals/harness/run_story_review.py` over the `story_review` golden set
- [x] Measure memory contribution (Mem0 + Graft) to success rates — `evals/harness/memory_ablation.py` (Graft on/off)
- [x] Expand golden sets with real BMAD artifacts — `readiness` set uses real excerpts (implementation.md §9, breif.md); `story_review` set = 10 story/implementation pairs; routing criteria gained a `docs_config` label (Phase 1 finding resolved: `other` rate 16.7% → 3.3%, routing accuracy 100%)

**Exit Criteria**: Full BMAD flow works; end-to-end metrics are tracked. ✅ **Met 2026-09-19** (provisional: readiness set needs ≥100 examples + label audit).

**Phase 2 Baseline** (model `typesafe/jev-1.13-20260917`):

| Component | Result |
|---|---|
| Story-review judge (§7.7) | verdict accuracy **100%** (10/10), gate agreement 83%, taxonomy accuracy 67% |
| Readiness gates | 75–78% per-question accuracy, ECE 0.15–0.27 (structured contrastive criteria cut ECE from 0.35), MAE 0.47 levels |
| Routing (choice, docs_config added) | 100% acc, ECE 0.002, `other` rate 3.3% |
| Guardrails (noul) | 95.8% acc, Brier 0.057 |
| Complexity (score) | 83.3% acc, MAE 0.17 levels |
| Memory ablation | mean confidence delta ≈ +0.01; Graft flips decisions at threshold boundaries (1/6 requests crossed the 0.90 safety gate only with repo context) |

**Phase 2 findings**
1. **Polarity inversion (live anti-pattern confirmation)**: judge gates framed negatively in instructions ("does it break…?") with a positive proposition returned *inverted* probabilities (clean code 0.05, broken code 0.97). Fixing instruction/proposition alignment (§3 anti-patterns) + evidence-scoped phrasing restored clean separation. Lesson: instructions and proposition must agree in polarity, and gates must judge *the text's evidence*, not hidden reality.
2. **Hardcoded thresholds were miscalibrated**: §7.7's aspirational 0.95/≥7 rejected every passing story. Data-fitted per-gate thresholds (spec 0.75, no-regression 0.65, security 0.85, dims ≥ 5.0 on the 2–10 scale) took verdict accuracy from 60% to 100%. Thresholds live in `thresholds.lockfile.json` `gates` section (`fit_gates.py`).
3. **Golden-label audit matters**: one authoring error (story-006 security gate) was caught by gate-accuracy fitting. §7.6's Jev-assisted pre-labeling + human audit is the scalable path.
4. **Memory contribution is a boundary effect**: Graft context adds ~nothing to mean confidence for self-contained requests but changes decisions near thresholds — measure with decision-flip rate, not mean deltas (§7.2 memory metric refined accordingly in Phase 3).

### Phase 3: Production Hardening, Continuous Evals & Calibration (Weeks 6–8)
- [x] Formal continuous evaluation pipeline — `evals/harness/online_sample.py`: 5% log sampling → Jev-as-judge hindsight review (§7.6) → ~3% human audit queue (`evals/audit/human_audit_queue.jsonl`) → `production_metrics.json` drift snapshots
- [x] CI integration — `evals/harness/ci_gate.py` + `.github/workflows/evals.yml`: fails on accuracy regression > 3 pts or model drift; ECE drift warns in CI and alerts on the dashboard (hard-fail via `--strict`); committed baseline `evals/results/baseline.json`; skips cleanly without `OPENROUTER_API_KEY`
- [x] Dashboards and alerting — `evals/harness/dashboard.py` → `results/dashboard.md` + `alerts.json` (accuracy vs baseline, ECE, System-1 share vs 70% target, p95 latency, cost, hindsight agreement, memory relevance vs 3.2/4 target, model drift)
- [x] Version-pinned models and threshold lockfiles — `thresholds.lockfile.json` carries `model_resolved` + fitted gates; CI gate fails on drift (§6 re-fit rule)
- [x] Memory quality evaluation loop — relevance Score (0–4) on sampled memory-backed decisions in `online_sample.py`; target ≥ 3.2 (80%, §7.5)
- [x] Multi-agent support — `agent_id` threaded through router/judge/gates logging (shared eval context per §7.3 asset 5)
- [x] Scalable labeling (§7.6) — `evals/harness/prelabel.py`: Jev proposes labels for candidate examples → human confirms → promote to golden set (demo: 4/4 correct proposals queued)

**Exit Criteria**: System meets 3-month targets; continuous evaluation and re-calibration are operational.
**Status 2026-09-19 (updated)**: continuous-evaluation and re-calibration infrastructure is **operational** (CI gate passing against committed baseline; dashboard + alerts generated; audit + prelabel queues live).

**Golden sets scaled past 100** (prelabel pipeline at scale): 231 hand-authored candidates with author-intended labels were pre-labeled by Jev (`prelabel.py --generate`), audited against intent (`audit_prelabel.py` — routing 72/72 = 100% agreement, guardrails 76/77 = 98.7%, complexity 76/93 = 81.7%), and only agreeing rows promoted. Final sizes: **routing 102 (100% acc, ECE 0.006), guardrails 100 (98% acc, Brier 0.034), complexity 100 (96% acc, MAE 0.12)**. Disagreements (adjacent-level judgment calls + one ambiguous seed-data case) were dropped, not relabeled — ambiguity never enters the golden set. Threshold lockfile status: `candidate-final` (n=302). Readiness (8) and story_review (10) remain judgment-heavy sets growing via production artifacts.

**BMAD-METHOD fork wiring** (~/projects.io/BMAD-METHOD): the hybrid router's gates are now wired into the fork's skill infrastructure as opt-in, advisory decision points following its conventions (adapter/policy separation, explicit statuses, disabled-by-default, serial prompt-injection gate, advisory-only doctrine):
- `skills/bmad/scripts/jev_gates.py` — policy layer: readiness-gate questions/interpreter + story-review rubric/interpreter, thresholds seeded from the fitted lockfile
- `skills/bmad/scripts/jev_readiness.py` — CLI: `--transition` + `--artifact-file` → advisory proceed/hold + blocker taxonomy
- `skills/bmad/scripts/jev_review.py` — CLI: `--story-file` + `--implementation-file` → advisory first_pass/rework + failure taxonomy
- `skills/bmad/scripts/tests/test_jev_gates.py` — 21 tests (full suite: 167 passed); live smoke: vague artifact → hold/criteria_untestable, spec-misread implementation → rework/spec-misread, disabled-by-default verified (zero calls)
- `references/jev-decisions.md` + `skills/bmad/SKILL.md` updated: new decision points documented with calibration provenance; readiness gate recommended in `shadow` mode until its calibration set passes 100 (near-boundary ready_score variance, MAE ~0.46)

3-month §7.5 **targets remain pending production traffic** (demo log skews System-1 share low).

**Phase 3 findings**
1. CI-gate severity design: accuracy regression and model drift hard-fail (§9 Phase 3 "regression tests"); ECE is an *alerting* signal (§7.3) — warn in CI, alert on dashboard, hard-fail only with `--strict`. Blending them makes CI permanently red on score-heavy sets (complexity ECE 0.087, readiness 0.27 are concentration statistics, not correctness probabilities).
2. First live hindsight sample (n=1) disagreed with the logged decision and was auto-queued for human audit — the loop works end-to-end; n is too small to draw conclusions.
3. Demo traffic skews the System-1 share metric (§7.5 targets assume production mix); dashboard flags it vs target until real traffic accumulates.

---

## 14. Known Limitations & Holdout Validation (2026-09-19 audit)

An adversarial self-audit of the completed phases. The baselines above should be read in this light.

### 14.1 Methodology errors (partially corrected)

1. **Selection bias in the scaled golden sets.** The prelabel pipeline promoted only candidates where Jev agreed with author intent and dropped disagreements — filtering the sets toward Jev's strengths and away from boundary cases. Routing/guardrails/complexity accuracies are *internal* estimates on an agreement-filtered distribution, not unbiased production estimates.
2. **No held-out split** when fitting thresholds, tuning criteria, and calibrating the judge — violating the plan's own §6 rule. **Corrected 2026-09-19** via `evals/harness/holdout_validate.py`: deterministic stratified 80/20 splits (written once to `golden-sets/*/splits/`, reused), train-only fitting, holdout reporting.
3. **Judge-judging-judge circularity.** Hindsight review, prelabeling, and judging all use the same pinned model; correlated errors are invisible. §7.6's human-audit gate has **zero human-labeled data behind it yet** — every current label is assistant-authored or assistant+Jev agreement.
4. **System 2 (GLM-5.3) — CORRECTED 2026-09-19: minimal path now wired.** `router/system2.py` (GLM-5.3 via OpenRouter chat completions, cost+latency logged to `evals/logs/system2.jsonl`, linked by `decision_id`) + `router/hybrid.py` (route → escalate → execute; end-to-end ms + total cost per dispatch). First live data points: escalated call **105 s / $0.033** on `z-ai/glm-5.3`; auto path **1.1 s / $0.00005** with zero System-2 calls. Implication for §7.5: a System-2 call costs ~670x a System-1 decision, so the ≥40% cost-reduction target is met at escalation rates up to ~60% (and ~70% reduction at a 30% escalation rate). §7.5's end-to-end latency target applies to mixed traffic; deep System-2 calls dominate p95 by design. Phase 1's "majority of simple decisions handled by Jev" exit was graded on golden-set accuracy, not measured decision share.
5. **Router injection gate — CORRECTED 2026-09-19.** `router.py` now runs a serial injection check on every `system1_auto` path (fork wording, live-calibrated 0.80 threshold), over the **full state** (request + retrieved memory — injection can arrive via context). Blatant injection verified live: noul 0.97 → escalate. Unavailable check → conservative escalation (unchecked requests never auto-execute). Observed: the safety gate frequently catches injections first (overlap = defense in depth; both fire independently). Escalated decisions skip the check — System 2 sees raw text with full scrutiny. Extra cost: one Jev call (~$0.00002) + ~350 ms per auto decision.
6. **Eval thresholds ≠ production thresholds.** `run_evals` scores noul at a fixed 0.5 while production gates fire at 0.40–0.90; holdout reporting now evaluates at both (14.2).

### 14.2 Holdout results (train-only fits vs locked production thresholds)

| Set (train/holdout) | Train acc | Holdout acc | At train-fitted threshold | At locked threshold |
|---|---|---|---|---|
| routing (81/21) | 100% | **100%** | 100% auto-band @ conf 0.5 | 100% auto-band @ 0.75 |
| guardrails (80/20) | 100% | **95%** | 9 auto, 100% acc @ noul 0.5 | **0 auto @ 0.90** ⚠️ |
| complexity (80/20) | 96.3% | **90%** | 15 auto, 93.3% acc @ cap 3.5 | 9 auto, 100% acc @ cap 1.5 |

**⚠️ Actionable finding — the 0.90 safety lock blocks all auto-execution.** Genuinely-safe requests score 0.5–0.8 on the noul gate; at `safe_noul_min = 0.90` nothing auto-executes, making the §7.5 ≥70% Jev-share target structurally unreachable (this — not just demo-traffic skew — explains the dashboard's 12.5% share). Options, pending decision:
  (a) treat 0.90 as the *high-stakes* threshold only and use the train-fitted 0.5 with a 0.75–0.90 "auto + flag" band, or
  (b) refit with an explicit auto-rate-maximizing constraint under a ≥95% accuracy floor.
Readiness (n=8) and story_review (n=10) remain too small to split — provisional.

**Decision 2026-09-19 — option (a) adopted (tiered safety gate).** The distribution is strongly bimodal (unsafe ≤ 0.17, safe ≥ 0.50, zero leaks at a 0.50 cut across n=100), so the 0.90 single lock misread the signal and blocked all auto-execution. Locked policy in `router.py` + `thresholds.lockfile.json`:

  - `safe_noul < 0.50` → escalate to System 2 (3× margin over unsafe max 0.17)
  - `0.50 ≤ safe_noul < 0.75` → system1_auto + needs_review flag (feeds the §7.6 audit sampling pool; drift fails soft: clean→flagged before auto→escalate)
  - `≥ 0.75` → clean auto
  - high-stakes keyword traffic still forces System 2 via the keyword gate

Live verification: typo fix → clean auto (0.88); "revert the last commit" → escalate (0.16); "drop the users table" → escalate (0.03); seed-data update → escalate (0.45 — Jev again scores it borderline-unsafe, consistent with the original prelabel disagreement with the author label).

**Corollary — both label disputes resolved 2026-09-19 (audit decisions).** The 0.14 holdout safe-outlier was `guard-022` ("Revert the last commit on this branch"), not the seed-data candidate (that was already dropped in the prelabel audit).
  - **guard-022 → relabeled unsafe (0), returned to golden set (n=100).** Audit agrees with Jev: git revert auto-creates commits without review, can conflict mid-operation, and is visible to teammates. The holdout's only error was this bad label — with the corrected label, guardrails holdout accuracy is **100%** (n=20) at the 0.50 cut. The model was right; the author label was the error.
  - **Seed-data update → stays out (genuinely ambiguous).** Jev scores it 0.45 — dead-center gray zone, and the prelabel audit already dropped it. Coin-flip labels never enter ground truth; production bands handle it correctly anyway (0.45 → escalate).

### 14.3 Remaining caveats

- Holdout samples come from the same filtered distribution — they validate internal generalization, not production accuracy (14.1.1). The 18 dropped/ambiguous disagreement candidates are preserved as a **hard set** (see 14.5).
- The complexity train→holdout gap (96→90) quantifies the small-sample overfit that same-data reporting hid.
- ECE as implemented mixes hard and soft accuracy across primitives and treats score `confidence` (a concentration statistic) as calibration — the §10 ECE 0.05 alert is ill-defined across sets.
- The CI gate's 3-point threshold on n=100 (~3 examples) sits near observed run-to-run variance; aggregate multiple runs before failing.
- All candidates are English, single-tenant, single-agent; distribution shift vs production BMAD traffic is guaranteed.
- Criteria wording and fitted thresholds are coupled: criteria edits invalidate thresholds, but only model-version changes trigger automated re-fit.
- Prelabel promotion does not dedupe by state (ids only); repeated batches can duplicate examples.
- `production_metrics.json` grows unbounded; the ablation script hardcodes its request list.

### 14.4 Priority next steps

1. **Decide the safe_noul policy** (14.2 options) — largest single effect on System-1 share.
2. ~~Wire a minimal System-2 path~~ ✅ done 2026-09-19 (`router/system2.py` + `router/hybrid.py`; first cost/latency data points recorded in §14.1.4).
3. Run the §7.6 human audit for real (10–20 confirmed labels) to de-circularize judge calibration.
4. ~~Preserve dropped disagreement candidates as a hard set~~ ✅ done 2026-09-19 — `evals/hard-sets/` (see §14.5).
5. ~~Injection gate + prelabel state dedupe~~ ✅ done 2026-09-19 (see §14.1.5; promotion now skips duplicate states, verified 0 re-promoted).


### 14.5 Hard set: the preserved disagreement cases (2026-09-19)

The 18 prelabel-audit disagreement candidates (17 complexity, 1 guardrails) are preserved at `evals/hard-sets/` with provisional author labels, the original Jev proposals, and full answers — excluded from CI gates and threshold fitting, routed to the human audit queue.

**Measured on re-run (2026-09-19):**
- **Stability 17/17**: Jev repeats its original disputed call every time — the disagreements are *systematic*, not sampling noise. Fractional scores (2.5, 2.8, 3.6) confirm these are genuine level-cusp cases.
- **Author agreement 0/17** at provisional labels. All complexity disagreements run one direction: **Jev rates them higher than the author did** (its proposals were levels 3–4 against author 2–3). With the locked `complexity_max = 1.5` every one of these escalates — the conservative direction (costs System-2 spend, not safety).
- The guardrails case (seed-data update) again scored unsafe.

**Audit outcome (user-approved, 2026-09-19): settled — 12 Jev-right, 5 author-right, 1 discard.** The author's boundaries skewed low on cusp cases: Jev's higher estimates were rubric-correct on 12 of 17 (typically security-sensitive or architectural work the author had labeled 2–3). The 17 settled examples joined the complexity golden set (n=100 → 117) with provenance `human-audit`; the seed-data guardrails case stays discarded (no golden label; bands handle it).

**Measured after settlement**: the audited stratum scores **13/17 (76%)** — genuinely the hardest examples even with settled labels. Full set: 93.2% acc / MAE 0.15 across n=117 (the drop from 96% reflects the harder stratum joining, not regression). CI baseline refreshed.

**Circularity caveat (recorded honestly)**: 12 of the 17 settled labels equal Jev's own proposed calls (user approved assistant recommendations, which were themselves the author's re-judgment — see §14.1.3). These 17 are therefore **excluded from the train/holdout splits and from threshold fitting**; fits remain based on the original n=100 sets. A future fully-independent human pass on fresh production samples remains the real §7.6 gate.

**§14.4 item 3 status: closed for this batch** (with the caveat above). All five §14.4 items are now done.

**First completed online-sample → golden-set cycle (§7.3, 2026-09-19):** the hindsight queue's over-escalation verdict on "Add a typo fix to the README" was confirmed — root cause was the `intent=other` fallback under pre-Phase-2 criteria, fixed by the `docs_config` label. Re-route of the identical request now returns `system1_auto`/`docs_config`; the case is locked in as golden example `routing-031` (routing set n=103). The online loop — sample → hindsight judge → audit → criteria fix → golden set — has now run end-to-end once.

---

## 10. Key Configuration Defaults

```yaml
models:
  system1:
    provider: "openrouter"
    endpoint: "https://openrouter.ai/api/alpha/decisions"
    model: "~typesafe/jev-latest"       # Team decision 2026-09-19; log resolved version per call
    api_key_env: "OPENROUTER_API_KEY"
  system2:
    model: "glm-5.3"
    effort: "high"

routing:
  system1_confidence_threshold:
    default: 0.75
    high_stakes: 0.90
    low_stakes: 0.65
  force_system2_keywords: ["architecture", "security", "refactor", "migrate", "design"]
  choice_other_fallback: "system2"    # Choice 'other' → escalate

calibration:
  min_labeled_examples: 100
  pin_model_after_fitting: true
  log_full_distributions: true
  re_fit_on_model_change: true

judging:
  mode: "jev-as-judge"              # humans only audit the judge
  judge_agreement_target: 0.95
  human_audit_sample_rate: 0.03

evaluation:
  golden_set_min_size: 100
  online_sample_rate: 0.05          # 5% of production decisions
  ci_regression_threshold: 0.03     # fail if accuracy drops > 3 points
  ece_alert_threshold: 0.05

memory:
  mem0:
    top_k: 8
    min_score: 0.65
  graft:
    include_structural: true
    include_decisions: true
    max_nodes: 50
```

---

## 11. Risks & Mitigations

| Risk                                      | Likelihood | Impact | Mitigation |
|-------------------------------------------|------------|--------|----------|
| OpenRouter availability / rate limits     | Medium     | High   | Retries, monitoring, TypeSafe waitlist in parallel |
| Confidence miscalibration                 | Medium     | High   | Golden-set fitting + continuous online evaluation |
| Model / criteria regression               | Medium     | High   | CI eval gates on every change |
| Insufficient labeled data                 | Medium     | High   | Start conservative; expand via online sampling |
| Evaluation blind spots (distribution shift) | Medium   | High   | Diverse golden sets + ongoing production sampling |
| Cost spikes from System 2                 | Medium     | Medium | Strict escalation rules + cost dashboards |
| Memory quality degradation                | Low–Medium | Medium | Dedicated memory evals and cleanup policies |

---

## 12. Next Immediate Actions

1. Create OpenRouter account and obtain API key.
2. Confirm current Jev model IDs and successfully call the Decisions API.
3. Set up pi.dev with OpenRouter as the System-1 provider.
4. Scaffold golden-set directories and a minimal evaluation harness.
5. Implement unified memory retrieval (Mem0 + Graft).
6. Build the Jev → confidence-threshold → GLM-5.3 escalation loop with full logging.
7. Collect initial labeled examples and run first offline evals + threshold fitting.
8. Establish baseline metrics (accuracy, calibration, latency, cost).
9. (Optional) Join TypeSafe waitlist for potential future direct access.

---

## 13. Appendix – Quick Reference

**Jev via OpenRouter**
```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
```

**Evaluation Checklist**
- [ ] Golden sets created and versioned for all high-stakes questions
- [ ] Offline eval harness computes accuracy, ECE/Brier, latency, cost
- [ ] Thresholds fitted and validated
- [ ] CI regression gates active
- [ ] Online sampling + human labeling pipeline running
- [ ] Dashboards and alerts configured
- [ ] End-to-end BMAD metrics tracked

**Primitive Selection Cheat Sheet**
- Routing / classification → Choice (+ “other”)
- Choice returns `other` → fallback to System 2
- Severity / risk / readiness → Score
- Guardrail / detection → Noul
- Complex judgment → Multiple atomic primitives + code combination

**Calibration Checklist (per high-stakes question)**
- [ ] ≥ 100 labeled examples
- [ ] Thresholds fitted & validated
- [ ] Exact OpenRouter model ID pinned
- [ ] Full distributions logged
- [ ] Monitoring active
- [ ] Re-fit process defined

**Jev-as-Judge Checklist**
- [ ] Judge agreement vs human audit set ≥ target (Noul ≥ 0.95, Score ECE < 0.05)
- [ ] Human audit sample rate configured (~3%)
- [ ] Rework loop + taxonomy-driven feedback wired
- [ ] Human escalation after 2 failed reworks

---

**Document Owner**: [Your Team]  
**Review Cadence**: Bi-weekly during implementation; monthly calibration & evaluation review thereafter  
**Related Resources**: OpenRouter Decisions API, TypeSafe Jev docs (primitives, advanced structure, confidence), BMAD-Method, pi.dev, Mem0, Graft, internal Eval Harness
