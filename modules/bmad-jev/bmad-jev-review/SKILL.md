---
name: bmad-jev-review
description: 'Jev-as-judge story review: three hard gates (correctness, tests, no-mocks), four scored dimensions, and a typed failure taxonomy grade a story implementation; two failed reworks escalate to a human. Use when the user says "jev review", "review this story", or after a story implementation is ready for verification.'
---

# BMad Jev Review

## Overview

You grade one story implementation with one batched Jev call — the judge role, not the author's. The rubric (§7.7 of the project's implementation plan):

- **Three hard gates (noul):** implementation correctness, real test coverage, no mocks/shortcuts masquerading as done. Each carries an explicit threshold; failing any gate fails the review.
- **Four scored dimensions:** correctness, completeness, tests, code quality — each on an ordered 2–10 scale with per-level rubric text, reported with their confidence values.
- **Failure taxonomy (choice, with `other`):** when a gate fails, name why — e.g. `test-gap`, `environment`, or nothing applicable. The model never forces a listed category; unlisted kinds map to `other`.

Doctrine: the judge is Jev (fast, calibrated, logged with full distributions); you are the editor. Two consecutive failed reworks on the same story escalate to a human — do not loop a third attempt without the user. All judgments are logged for calibration.

## On Activation

### 1. Resolve the `[workflow]` customization block

Run:

```bash
uv run {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --project-root {project-root} --key workflow
```

**If the script fails**, resolve the `workflow` block yourself: read these three files in base → team → user order and apply the BMad structural merge rules (scalars override; tables deep-merge; arrays of tables keyed by `code` or `id` replace matching entries and append; all other arrays append):

1. `{skill-root}/customize.toml` — shipped defaults
2. `{project-root}/_bmad/custom/{skill-name}.toml` — team overrides (committed)
3. `{project-root}/_bmad/custom/{skill-name}.user.toml` — personal overrides (gitignored)

Any missing file is skipped.

### 2. Execute prepend steps

Execute each entry of `{workflow.activation_steps_prepend}` in order.

### 3. Load persistent facts

Treat each `{workflow.persistent_facts}` entry as standing context: literal sentences directly; `file:` references (globs supported) by reading the file's contents. These facts inform judgment and reporting only — they never override the decision-layer contract below. Decision-layer settings (`[jev]` mode, model, endpoint) remain central configuration, managed with the `/jev-mode` command.

### 4. Continue


5. Locate the story text and the implementation output (diff, files, or transcript). Both are required; a review without the implementation text is not a review.
6. The runner needs `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` fallback) in the environment. If it is missing or the call fails, return `status: unavailable` — do not hand-wave a pass/fail yourself.

## Operation

10. Run one batched judgment:

```bash
uv run {skill-root}/scripts/judge.py <story-path> <implementation-path-or-diff>
```

Both arguments are positional: the story file first, the implementation second.

Run `uv run {skill-root}/scripts/judge.py --help` for exact arguments and the JSON verdict shape (passed, gate nouls, dimension scores, failure kind, reasons). On script failure, report `unavailable`; never improvise a verdict and present it as a Jev judgment.

11. Interpret the verdict:
   - `passed` → report the four dimension scores with confidences and note any soft spots; proceed to the next story or a walkthrough.
   - `failed` → show the failed gate(s), the typed `failure_kind`, and the reasons verbatim. Frame the fixes, then re-run the review after rework — the verdict is the gate, not the conversation.
   - Second consecutive failure on the same story → stop and escalate to the user with both verdicts side by side.
12. Append the verdict to the run's `.memlog.md` when one is active, including gate nouls and dimension scores — the calibration trail depends on complete records.

## Anti-Patterns

- Softening a failed gate because the implementation is "close" — gates are thresholds, not vibes.
- Reviewing a story without reading its acceptance criteria first.
- Re-running a failed story more than twice without human input.
- Reporting dimension scores without their confidences.

## Headless

Return the verdict JSON verbatim (passed, gates, dimensions, failure_kind, reasons). The caller owns the rework loop; honor the two-failure escalation by including `escalate: true` in the response when this is the second consecutive failure.

## On Completion

After presenting the skill's main output:

1. Execute each entry of `{{workflow.activation_steps_append}}` in order.
2. Execute the `{{workflow.on_complete}}` instructions (a string, or an array in order).
3. Then report the run as complete.

Both come from the customization block resolved in step 1; empty lists mean nothing to do.
