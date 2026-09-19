# BMAD Integration

Two layers of integration exist: this repo's runtime modules (used by the hybrid architecture directly) and the wiring inside the BMAD-METHOD fork (used by BMad skills as opt-in advisory scripts).

## This repo (runtime layer)

- `router/bmad_gates.py` — BMAD phase-transition readiness gates, callable from any skill or agent that follows the BMAD workflow (Analysis → Planning → Solutioning → Implementation).
- `router/judge.py` — the §7.7 story-review rubric for post-implementation review (System-2 output quality, Jev-as-judge).
- Both load thresholds from the fitted lockfile and log every decision with `agent_id` for multi-agent attribution.

## The BMAD-METHOD fork (`~/projects.io/BMAD-METHOD`)

| Branch | Contents | Status |
|---|---|---|
| `feature/jev-decision-assist` | Recommendation pilot only: adapter (`jev_adapter.py`), policy (`jev_policy.py`), CLI (`jev_recommend.py`) — skill recommendation in the help flow, three agreeing primitives, serial injection gate | unchanged, 146 tests |
| `feature/jev-gates` | `jev_gates.py` (readiness/review policy layer + 21 tests), `jev_readiness.py` and `jev_review.py` (CLIs), docs updates | 167 tests passing, live-verified |

The fork wiring follows its own conventions exactly: adapter/policy separation, disabled-by-default (`off` | `shadow` | `suggest` modes via `BMAD_DECISION_ASSIST_MODE` or the `[jev]` config table), explicit statuses, bounded call budgets, and the serial prompt-injection gate on passing verdicts.

### CLI usage (from a skill)

```bash
# Readiness gate before a phase transition
uv run scripts/jev_readiness.py --project-root . \
  --transition planning_to_solutioning --artifact-file path/to/artifact.md

# Story review after implementation
uv run scripts/jev_review.py --project-root . \
  --story-file path/to/story.md --implementation-file path/to/impl-report.md
```

Both print advisory JSON: `verdict` (`proceed`/`hold`, `first_pass`/`rework`), gate values, reasons, taxonomy, `calls_made`, usage. On anything but `status: ok`, the calling skill continues with ordinary reasoning — silently, no retries.

### The advisory doctrine (non-negotiable)

- `proceed` / `first_pass` is **one vote**, never an approval; it never bypasses a checkpoint.
- `hold` / `rework` is a **signal to surface the recorded reasons** in the skill's own flow, never an automatic block.
- `shadow` mode runs the same logic but its output must not influence anything user-facing.
- The readiness gate is recommended to run in **shadow mode until its calibration set passes 100 examples** (currently n=8, near-boundary score variance, MAE ~0.46 levels — a solid artifact can occasionally draw a conservative hold).

### Threshold provenance

The fork's `jev_gates.py` thresholds are seeded from this repo's fitted lockfile (fitted 2026-09-19 against these golden sets, model `typesafe/jev-1.13-20260917`): readiness spec ≥ 0.40, testable ≥ 0.45, blockers ≥ 0.55, score ≥ 3.0; review spec ≥ 0.75, no-regression ≥ 0.65, security ≥ 0.85, dims ≥ 5.0. Re-fit on model change (§6 rule); the fork's model is pinned to the same dated snapshot for reproducibility.

### What is deliberately NOT wired

- No skill SKILL.md (other than the bmad help pointer) currently instructs an agent to call these CLIs in-flow — the wiring is available tooling, not enforced process. Adopting them into a skill's flow is a per-skill decision requiring its own review.
- No autonomous execution anywhere: nothing in either repo lets Jev approve, reject, or execute work.