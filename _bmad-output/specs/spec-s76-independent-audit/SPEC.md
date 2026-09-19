---
slug: s76-independent-audit
topic: §7.6 independent human audit batch + policy-layer threshold fitting
date: 2026-09-19
status: draft
companions:
  - labeling-protocol.md
sources:
  - ../../docs/implementation.md
  - ../../docs/operations.md
  - ../../router/thresholds.lockfile.json
---

# Spec — §7.6 Independent Audit + Policy-Layer Threshold Fitting

## Why

Every judge calibration in this repo rests on labels that are assistant-authored or assistant+Jev agreements (§14.1.3) — hindsight review, prelabeling, and judging all use the same pinned model, so correlated errors are invisible. The BMAD policy layer's readiness/review thresholds are provisional defaults that never went through the eval pipeline. Until an independent human batch exists and the policy thresholds are fitted, both "judge trust" and gate verdicts are provisional claims the community submission cannot make honestly.

## Capabilities

### CAP-1 — Independent human-labeled audit batch

- **Intent:** Replace correlated labels with independent ground truth for auditing the judge: collect fresh samples and label them blind (labeler never sees Jev's proposed output), 10–20 confirmed labels spanning routing/guardrail/complexity/review taxonomies.
- **Success:** A committed machine-readable batch (see `labeling-protocol.md` for format) with ≥10 settled labels, each carrying provenance fields that record labeler-blindness; auditable §14.1.3-style exclusion history.

### CAP-2 — Judge calibration re-check on independent data

- **Intent:** Run the pinned-model judge over the same samples and compare against CAP-1's labels, measuring against the fixed §7.6 targets.
- **Success:** An agreement report with an explicit met/not-met verdict on noul-gate agreement (≥95%), gated on ordering (human commit precedes the judge run) and environment isolation (judge never mounts the labeling workspace). **This batch certifies gate agreement, nothing more** — ECE on score is deferred until n≥50.

### CAP-3 — Policy-layer thresholds fitted through the eval pipeline

- **Intent:** Route the readiness/review gate thresholds through the repo's standard fit path (golden-set sweep → holdout validation → lockfile) instead of provisional defaults.
- **Success:** Fitted thresholds recorded in the lockfile with holdout numbers, **or** an explicit documented statement that a set is too small to fit, with the growth path named — no threshold left silently provisional.

## Constraints

- Labels in CAP-1 are **audit data only** — never mixed into train/holdout splits or used to fit the judge; fitting on them would re-introduce the circularity this spec exists to remove.
- The labeler must not see Jev's proposed calls for labeled samples (no peeking at `hindsight_noul`, prelabel output, or judge JSONL); provenance is recorded per label so §14.1.3-style exclusions stay auditable.
- Judge calibration targets are fixed by §7.6 (≥95% noul agreement, ECE < 0.05 on score) — this effort measures against them, never adjusts them; the score-ECE claim is explicitly deferred to n≥50.
- The judge pass for CAP-2 runs in a clean environment that never mounts the labeling workspace; the agreement report refuses to score a batch whose human-label commit does not precede the judge run (see `labeling-protocol.md`).
- CAP-3 follows all §6 fitting rules: train-only fits, holdout reporting, lockfile recording; question wording is frozen for the duration (a criteria edit invalidates fits — coupling rule).
- Everything live requires `OPENROUTER_API_KEY`; degraded paths return explicit statuses (repo adapter contract).

## Non-goals

- Growing the routing/guardrails/complexity golden sets (separate prelabel-pipeline work).
- Changing §7.6 targets or the §7.7 rubric.
- Making judge labels trusted-by-default if targets are missed — an honest "not yet trusted" verdict is an acceptable outcome.
- Generating production traffic; System-1 share measurement stays open (§14.1.4).

## Success signal

A committed independent batch (≥10 blind labels with provenance), a judge-agreement report with an explicit met/not-met verdict against the §7.6 targets, policy-layer thresholds either lockfile-fitted or explicitly marked provisional-with-growth-path, and §7.6/§14 of `docs/implementation.md` updated to reflect all of it.

## Open questions

- ~~Sample source~~ — resolved: split batch, pool-first (~10 labels from the existing online-sample pool), fresh traffic thereafter; two labeling sessions.
- ~~ECE statistical power~~ — resolved: deferred. This batch supports the ≥95% gate-agreement claim only; ECE claims wait for n≥50.
- Second human labeler: out of scope for this batch (single-labeler, author-blind); revisit if the community reception demands it.

## Assumptions

- Loki labels personally, blind to Jev outputs (author-blind bar; a second human labeler would be stronger but is out of scope).
- The existing audit-queue JSONL format (`question`/`decision`/`resolved_ts`) extends to this batch with added provenance fields.