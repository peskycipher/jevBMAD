---
name: bmad-jev-gates
description: 'Batched Jev readiness gates for BMAD phase transitions: three noul gates (spec specificity, testable requirements, no blockers) plus an ordered readiness score decide proceed or hold, with a typed blocker taxonomy. Use when the user says "run phase gates", "check readiness", "can we move to planning/solutioning/implementation", or before transitioning BMAD phases.'
---

# BMad Jev Gates

## Overview

You guard BMAD phase transitions with one batched Jev call. Before any transition (Analysis → Planning → Solutioning → Implementation), the layer evaluates five atomic questions over the phase artifact:

- `spec_specific` (noul) — requirements are concrete, not vague
- `requirements_testable` (noul) — acceptance criteria are objectively verifiable
- `no_blockers` (noul) — no unresolved blocking decisions (work that is simply not done yet does NOT count)
- `ready_score` (score, 0–4) — overall readiness on an ordered rubric
- `blocker_kind` (choice, with `other`) — why it is NOT ready; only meaningful when a gate fails

**Policy (conservative):** proceed only when all three noul gates clear 0.90 **and** `ready_score ≥ 3.0`. Any failure yields `hold` with the typed blocker. Work that is simply unfinished yields `in_progress`, not a blocker. The choice never forces a listed category — an unlisted failure kind maps to `other`.

Thresholds default to the conservative values above and may be tightened via a lockfile; they are never loosened at runtime. Every evaluation is logged with the full distributions.

## On Activation

1. Confirm the artifact to evaluate (spec, PRD, solution doc, or phase plan) and the source→target transition.
2. The runner needs `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` fallback) in the environment. If it is missing or the call fails, return `status: unavailable` — never assume readiness when the gate could not run. An unchecked transition must not proceed.

## Operation

1. Read the artifact text (trim to the bounded state size the script documents).
2. Run one batched evaluation:

```bash
uv run {skill-root}/scripts/bmad_gates.py <transition> < artifact.md
```

The artifact text is read from stdin; the transition (e.g. `analysis_to_planning`, `planning_to_solutioning`, `solutioning_to_implementation`) is the first argument.

Run `uv run {skill-root}/scripts/bmad_gates.py --help` for exact arguments and the JSON output shape (decision, gate nouls, ready score, reasons). On script failure, do not eyeball a verdict — report `unavailable` and let the user decide.

3. Interpret the JSON:
   - `decision: proceed` → state which gates cleared and the score; transition may proceed.
   - `decision: hold` → name the failed gates, the blocker kind, and the reasons verbatim. Help the user fix the named blocker; then re-run the gates rather than arguing the case.
   - `status: unavailable` → say so; the phase question stays open.
4. Append the gate report to the run's `.memlog.md` when one is active (append-only, chronological).

## Anti-Patterns

- Judging readiness by reading the artifact yourself when the gate could run — the script is the deterministic path; you are the fallback.
- Loosening thresholds to unblock a transition — the answer is to fix the artifact.
- Counting unfinished work as a blocker — blockers are explicit unresolved decisions, TODOs, or missing referenced content.
- Skipping the gates on a "small" transition. Every phase transition goes through the same gate.

## Headless

Return the gate JSON verbatim (decision, gate_nouls, ready_score, reasons, blocker_kind). Non-zero findings are data, not errors.