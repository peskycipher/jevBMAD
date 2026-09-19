# Jev BMad Hybrid — installable BMad module

System-1/System-2 decision layer for the BMad Method, packaged per the
[bmad-builder](https://github.com/bmad-code-org/bmad-builder) module conventions.

- **System 1 (fast)**: Jev via the OpenRouter Decisions API — typed, probabilistic,
  calibrated decisions (choice / score / noul), batched, with conservative
  escalation and explicit abstention.
- **System 2 (slow)**: your deep-reasoning model (GLM-class) handles anything the
  gates do not clear; the layer never force-fits an answer.

## Skills

| Skill | Purpose |
|---|---|
| `jev-setup` | Registers the module (`module.yaml`, `module-help.csv`), merges config, verifies runtime prerequisites |
| `bmad-jev-decide` | Decision support: workflow recommendation with three-signal agreement, prompt-injection integrity gate, conservative abstention |
| `bmad-jev-gates` | Phase-transition readiness: 3 noul gates + ordered readiness score + typed blocker taxonomy |
| `bmad-jev-review` | Jev-as-judge story review: 3 hard gates + 4 scored dimensions + failure taxonomy, human escalation after 2 failed reworks |

## Runtime requirements

- Python 3.11+ with `uv` (scripts are PEP 723 / stdlib-first)
- `OPENROUTER_API_KEY` in the environment for any live call — without it every
  skill still runs and returns explicit `unavailable` statuses
- Optional: `[jev] mode = "suggest"` in `_bmad/custom/config.toml`
  (`off` by default; `shadow` = evaluate only)

## Install

Install via the BMad installer from any Git host or local path, or run the
`jev-setup` skill in-project after copying this folder to `.claude/skills/`.

## Provenance

Scripts are copied verbatim from the validated jevBMAD pipeline
(`_bmad/scripts/jev_*.py`, `evals/harness/jev_client.py`, `router/{bmad_gates,judge}.py`),
with only the `sys.path` bootstrap lines adjusted for the bundled layout.
Thresholds default to the conservative §10 values; no lockfile ships.