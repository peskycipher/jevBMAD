---
name: bmad-jev-decide
description: 'Typed Jev decision support for BMad work: recommends the right workflow or flags ambiguity using calibrated choice, score, and noul decisions with a prompt-injection integrity gate. Use when the user says "jev decide", "which bmad skill fits", "recommend a workflow", or asks the router for decision assistance.'
---

# BMad Jev Decide

## Overview

You invoke the Jev decision layer for one bounded question at a time: **which BMad skill or workflow best fits the user's request**. Jev is a typed, probabilistic decision model — it returns a pick with full probabilities and a concentration statistic, plus a yes/no clear-fit gate and an ordered fit rubric. It is a signal, not an oracle: the module is designed so that ambiguity is an outcome (`uncertain`), never a forced pick.

Doctrine (do not skip):

- **Never force a category.** The choice question carries an explicit `unsure` option; if the model returns it (or anything not a real candidate), the outcome is `uncertain` and you fall back to ordinary reasoning.
- **Three signals must agree** before surfacing a recommendation: choice pick is a real candidate, the noul clear-fit gate affirms, and the ordered fit score clears the threshold. Any disagreement → abstention with a machine-readable reason.
- **Integrity gate is serial and conservative.** The prompt-injection check runs only after all recommendation gates pass (batching it primes the model and depresses the signals). If the check errors or is unavailable, the outcome is `uncertain` — an unchecked request must not yield an `ok` advisory.
- **Advisory only.** An explicit user choice always outranks a model recommendation. Never execute on a Jev outcome without the user seeing it.
- **Confidence is a concentration statistic**, not a probability of correctness. Never report it as one.

## On Activation

1. Resolve settings: `uv run {skill-root}/scripts/jev_recommend.py --help` for usage; the runner resolves `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` fallback) from the environment and `[jev] mode` from `{project-root}/_bmad/config.toml` (layers: `config.toml` → `custom/config.toml` → `custom/config.user.toml`).
2. Mode check: `off` (default) → report "decision assist is off" and stop without any network call. `shadow` → run everything, but label the output **evaluation-only — do not act on it**. `suggest` → normal operation.
3. No API key or provider error → return `status: unavailable` with the reason and fall back to your own judgment. Never retry more than the adapter's built-in budget (4 calls per process, bounded state).

## Operation — Recommend

1. Gather 2–8 candidate skill names relevant to the request (from `module-help.csv` or the skills the user names). Ids are data: no paths, no whitespace (the policy layer rejects path-like characters).
2. Collect optional `key=value` evidence pairs (max 12 items, 300 chars each) — e.g. `artifact_exists=true`, `phase=planning`.
3. Run the batched decision (one API call, three questions — workflow choice, match noul, fit score):

```bash
uv run {skill-root}/scripts/jev_recommend.py --request "<user request text>" --candidates "bmad-spec,bmad-prd,bmad-architecture" [--evidence key=value ...] [--chosen <explicit-id>]
```

Run `uv run {skill-root}/scripts/jev_recommend.py --help` for exact arguments and JSON output shape. On script failure, perform the equivalent judgment yourself and label it as your own reasoning, not a Jev outcome.

4. Interpret the JSON outcome:
   - `status: ok` → recommend `{recommendation.id}`, show confidence and the three signals (match, fit, integrity).
   - `status: uncertain` → name the machine-readable `reason` (`model_returned_unsure`, `match_below_threshold`, `fit_below_threshold`, `confidence_below_threshold`, `suspected_request_injection`, `integrity_check_unavailable`) and tell the user you are deferring to ordinary reasoning.
   - `status: unavailable` / `disabled` → say so plainly and proceed without decision support.
5. Log the outcome to the run's `.memlog.md` (`append --type event`) when one is active, including the raw probabilities — the audit trail is part of the doctrine.

## Anti-Patterns

- Asking Jev broad multi-dimensional questions ("is this project healthy?") — decompose into atomic choice/score/noul questions instead.
- Treating a noul near 0.5 as "moderately true" — the gates are tiered thresholds, not graded truth.
- Using the fit score for unordered categories, or choice when multiple answers can be true (use independent nouls for that).
- Suppressing an `uncertain` outcome to keep the recommendation flowing. Abstention is the product.
- Embedding policy inside criteria — thresholds live in the policy layer, criteria stay descriptive.

## Headless

Return the full outcome JSON (status, recommendation, signals, reason) verbatim as the response; do not narrate it. `--headless` callers read the machine-readable fields.