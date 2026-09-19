# Contributing to Jev-BMAD

Thanks for your interest. This repo is an experimental, evaluation-first
System-1/System-2 router and installable BMad module. A few ground rules
keep its core doctrine intact.

## The doctrine (read before changing anything)

- **Thresholds are data, not aspirations.** Never hardcode or tune a
  threshold in application code. New or changed gates go through
  golden-set fitting → held-out validation → `router/thresholds.lockfile.json`.
  See `docs/operations.md` for the model-change re-fit runbook.
- **Nothing ships without an eval.** Behavior changes need golden-set or
  unit-test coverage; `python3 evals/harness/ci_gate.py` is the gate
  (unit tests run without an API key; golden sets need
  `OPENROUTER_API_KEY`).
- **Opt-in everywhere.** Zero network calls without `OPENROUTER_API_KEY`;
  every CLI must degrade to explicit JSON statuses, never a traceback.
  The contract is enforced by `evals/harness/tests/` — run it:
  `python3 -m unittest discover -s evals/harness/tests`
- **Audit etiquette.** Golden-set labels are data. If you believe a label
  is wrong, don't edit it silently — open an issue with the example ID
  and reasoning; disputes go through the audit workflow in
  `docs/operations.md`.

## Local checks before a PR

```bash
python3 -m unittest discover -s evals/harness/tests   # fast, no API key
python3 evals/harness/ci_gate.py                      # full gate (needs key)
```

CI runs the same gate on push for `evals/`, `router/`, `modules/`, and
`_bmad/` changes.

## Repo layout

See `README.md` (repo map) and `docs/index.md` (reading order). The
authoritative history and known limitations live in
`docs/implementation.md` (§14).