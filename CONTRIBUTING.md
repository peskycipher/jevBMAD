# Contributing to Jev-BMAD

Thanks for your interest. This repo is an experimental, evaluation-first
System-1/System-2 router and installable BMad module. A few ground rules
keep its core doctrine intact.

## Jev lessons (standing rules — earned live, violated at your peril)

These are recorded in the README as lessons; here they are as rules:

1. **Polarity alignment**: noul `instructions` and `proposition` must agree — misalignment returns inverted probabilities. Found live, fixed, tested (see D10 in `docs/decisions.md`). If noul answers look inverted, check polarity before anything else.
2. **Thresholds are data, not aspirations**: §7.7's hardcoded 0.95 rejected every passing story; fitted thresholds took verdict accuracy 60% → 100%. Never ship a threshold that hasn't been fit and holdout-validated.
3. **Jev's noul is bimodal on safety**: treat mid-range values as a signal (tiered bands), not as "probably unsafe" (a single high cut). The lockfile encodes this — don't flatten it.
4. **The audit loop catches author errors**: guard-022 and the hard-set stratum were both author-labeling mistakes the audit caught first. If the loop disagrees with you, re-examine your label before the model's.

## The doctrine (read before changing anything)

- **Thresholds are data, not aspirations.** Never hardcode or tune a
  threshold in application code. New or changed gates go through
  golden-set fitting → held-out validation → `router/thresholds.lockfile.json`.
  See `docs/operations.md` for the model-change re-fit runbook.
- **Nothing ships without an eval.** Behavior changes need golden-set or
  unit-test coverage; `npx tsx evals/harness/ci_gate.ts` is the gate
  (unit tests run without an API key; golden sets need
  `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`).
- **Opt-in everywhere.** Zero network calls without one of those keys;
  every CLI must degrade to explicit JSON statuses, never a traceback.
  The contract is enforced by `evals/harness/tests/` — run it:
  `npm run test:unit`
- **Audit etiquette.** Golden-set labels are data. If you believe a label
  is wrong, don't edit it silently — open an issue with the example ID
  and reasoning; disputes go through the audit workflow in
  `docs/operations.md`.

## Local checks before a PR

```bash
npm run test:unit                                     # TS unit tests — fast, no API key
npx tsx evals/harness/ci_gate.ts                      # full gate (needs key)
```

CI runs the same gate on push for `evals/`, `router/`, `modules/`, and
`_bmad/` changes.

## Repo layout

See `README.md` (repo map) and `docs/index.md` (reading order). The
authoritative history and known limitations live in
`docs/implementation.md` (§14).