# Decision Log

ADR-style record of the decisions that shaped this system, in roughly chronological order. Each entry: context → decision → consequence. Numbers cited are from the 2026-09-19 build-out; D13–D14 are from the 2026-09-20 hardening pass.

## D1 — OpenRouter as the only Jev access path
Direct TypeSafe access was a waitlist; OpenRouter's Decisions API was live and verified. **Decision:** OpenRouter only (`/api/alpha/decisions`), pin the resolved model string per call. **Consequence:** single provider dependency (alpha, undocumented) — mitigated by strict response validation and explicit `unavailable` statuses.

## D2 — One batched three-question routing call
**Decision:** intent (choice) + safety (noul) + complexity (score) in a single call, all gates atomic. **Consequence:** ~350 ms and ~$0.00002 per routing decision; three signals must agree for auto-execution (defense in depth); no per-gate retries without a second call.

## D3 — `choice` returning `other` falls back to System 2
**Decision:** never force a listed category; `other` escalates. **Consequence:** the Phase 1 finding — docs/config requests over-escalated until a `docs_config` label was added (other rate 16.7% → 3.3%, routing stayed 100%). The taxonomy is now deliberately granular.

## D4 — Jev-as-judge replaces human labeling (§7.6)
**Decision:** prelabeling, hindsight review, and story judging by Jev, humans retained to audit the judge (~3% sampling). **Consequence:** scalable labeling, but the circularity is real (§14.1.3) — the independent human-labeled batch remains the open §7.6 gate. Recorded honestly in §14.5.

## D5 — Tiered safety bands over a single threshold
**Context:** the §10 default lock (0.90) blocked 100% of auto-execution — safe requests score 0.5–0.95 on a bimodal noul, not ≥ 0.9. **Decision:** < 0.50 escalate · 0.50–0.75 auto+flag · ≥ 0.75 clean auto; high-stakes keyword traffic still forces System 2. **Consequence:** realistic path to the ≥70% share target, soft-fail under drift (clean → flagged before auto → escalate), flagged band feeds the audit pool. Holdout: zero unsafe leaks at the 0.50 cut (unsafe max 0.17).

## D6 — Injection gate on the auto path, over the full state
**Decision:** port the fork's serial check to `router.ts`; check request + retrieved context; unavailable check → conservative escalation. **Consequence:** +1 call (~$0.00002) and ~350 ms per auto decision; blatant injection verified at 0.97 → escalate; the safety gate independently catches many injections (overlap = defense in depth).

## D7 — CI severity split: accuracy hard-fails, ECE alerts
**Context:** score-primitive "confidence" is a concentration statistic; hard-failing CI on ECE keeps CI permanently red. **Decision:** accuracy drop > 3 pts and model drift = CI failure; ECE = dashboard alert (`--strict` opt-in). **Consequence:** CI is green-when-healthy; calibration drift is visible without being noisy.

## D8 — The disagreement rule in prelabeling
**Decision:** Jev/author label disagreements are dropped, not relabeled. **Consequence:** no coin-flip labels in ground truth; the dropped cases became the hard set — whose measurement showed Jev's calls were systematic (17/17 stable) and mostly rubric-correct (audit: 12 Jev, 5 author, 1 discard).

## D9 — Holdout splits: fit on train, report on holdout
**Context:** the audit found every fitted number had been fitted on its own reporting data. **Decision:** deterministic stratified 80/20, persisted, never reshuffled; thresholds fit train-only. **Consequence:** complexity's honest number is 90% holdout (vs 96% train); the guardrails holdout error turned out to be a bad author label (guard-022), not a model error — the audit process caught its second author mistake.

## D10 — Noul polarity alignment (the live lesson)
**Context:** judge gates framed negatively in instructions with a positive proposition returned inverted probabilities (clean code 0.05, broken 0.97). **Decision:** instructions and proposition must agree in polarity; gate questions are evidence-scoped ("judging only from the description…"). **Consequence:** verdict accuracy 60% → 100% after reframe + refit. Any new noul question gets a polarity check before deployment.

## D11 — Threshold lockfile: strictest-of(fitted, default) + model pin
**Decision:** lock the stricter of fitted vs §10 defaults; pin the resolved model; re-fit on model drift (CI-enforced). **Consequence:** conservative by construction; known caveat — criteria edits also invalidate fits but trigger no automated alarm (documented in the runbook).

## D12 — Advisory-only doctrine in the fork
**Decision:** `proceed`/`first_pass` is one vote, never an approval; `hold`/`rework` surfaces reasons, never blocks automatically; shadow mode for the readiness gate until n≥100. **Consequence:** no skill can cite Jev as authority for executing or rejecting work; adoption into skill flows stays a separate per-skill decision.
## D13 — Provider-independent provenance: pin vs echo (2026-09-20)
**Context:** live full-suite runs via TypeSafe direct failed the CI model-drift check — the API rejects the dated snapshot ID (HTTP 400 "Unknown model") and only accepts its alias `jev-1.13.0`, so recorded `model_resolved` flipped to the alias and diverged from the lockfile pin. **Decision:** the lockfile and eval reports record the *logical pin* (`model_requested` = dated snapshot, provider-independent); the provider-specific alias resolution stays an explicit, documented client behavior; the response echo is recorded separately as `model_echo`, and `ci_gate` **warns** when the echo is neither the pin nor its known alias (early repoint signal) without hard-failing. **Consequence:** eval provenance is reconstructable regardless of access path; a repointed snapshot surfaces as an alert, not silent drift or a permanently red gate.

## D14 — Structured EntryType questions where boundaries are subtle (2026-09-20)
**Context:** [docs.typesafe.ai/primitives/advanced](https://docs.typesafe.ai/primitives/advanced) documents that instructions, choice options, score levels, and noul criteria all accept JSON structure; the project had been hand-serializing exactly those boundaries into strings ("NOT for: … Example: …"). Verified live that the pinned model accepts all structured shapes with calibrated answers. **Decision:** adopt structured `{what, examples}` noul boundaries (guardrails `safe_auto`, readiness gates), `{summary, signals, examples}` score levels (readiness `ready_score`), and `{what, not_for}` choice options (judge `failure_kind`) — and *only* where the docs recommend structure for subtle boundaries (routing at 1.000 and the uniform 2–10 legend stay strings). Runtime `QUESTIONS` and golden sets kept byte-identical, enforced by a new sync test. **Consequence:** guardrails full-set accuracy 0.990 → 1.000, readiness 0.750 → 0.781 (ECE 0.275 → 0.220), story-review unchanged (option keys untouched — labels match keys); a criteria-shape regression class is now CI-caught.
