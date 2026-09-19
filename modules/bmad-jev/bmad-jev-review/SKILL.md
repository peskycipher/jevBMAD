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

1. Locate the story text and the implementation output (diff, files, or transcript). Both are required; a review without the implementation text is not a review.
2. The runner needs `OPENROUTER_API_KEY` in the environment. If it is missing or the call fails, return `status: unavailable` — do not hand-wave a pass/fail yourself.

## Operation

1. Run one batched judgment:

```bash
uv run {skill-root}/scripts/judge.py <story-path> <implementation-path-or-diff>
```

Both arguments are positional: the story file first, the implementation second.

Run `uv run {skill-root}/scripts/judge.py --help` for exact arguments and the JSON verdict shape (passed, gate nouls, dimension scores, failure kind, reasons). On script failure, report `unavailable`; never improvise a verdict and present it as a Jev judgment.

2. Interpret the verdict:
   - `passed` → report the four dimension scores with confidences and note any soft spots; proceed to the next story or a walkthrough.
   - `failed` → show the failed gate(s), the typed `failure_kind`, and the reasons verbatim. Frame the fixes, then re-run the review after rework — the verdict is the gate, not the conversation.
   - Second consecutive failure on the same story → stop and escalate to the user with both verdicts side by side.
3. Append the verdict to the run's `.memlog.md` when one is active, including gate nouls and dimension scores — the calibration trail depends on complete records.

## Anti-Patterns

- Softening a failed gate because the implementation is "close" — gates are thresholds, not vibes.
- Reviewing a story without reading its acceptance criteria first.
- Re-running a failed story more than twice without human input.
- Reporting dimension scores without their confidences.

## Headless

Return the verdict JSON verbatim (passed, gates, dimensions, failure_kind, reasons). The caller owns the rework loop; honor the two-failure escalation by including `escalate: true` in the response when this is the second consecutive failure.