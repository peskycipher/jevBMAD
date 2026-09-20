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
- `TYPESAFE_API_KEY` (TypeSafe direct) or `OPENROUTER_API_KEY` (OpenRouter
  fallback) in the environment — or in a `.env` file (copy `.env.example`
  from the repo, or the bundled `jev-setup` skill template
  `.claude/skills/jev-setup/assets/env.example` after an npx install) in the
  working directory or any parent; real environment variables win — for any
  live call. Without one of them every skill still runs and returns explicit
  `unavailable` statuses
- Optional: mode via the `BMAD_DECISION_ASSIST_MODE` environment variable, or
  the `[jev] mode` central-config key (`mode` / `model` / `endpoint`) — the
  four TOML layers `_bmad/{config,config.user}.toml` then
  `_bmad/custom/{config,config.user}.toml` are merged in that order (later
  layers override), and the environment variable overrides them all. Valid
  modes: `off` (default, zero network calls), `shadow` (evaluate only),
  `suggest`; an unknown value warns and falls back to `off`.
- Manage all of this with the bundled helper (also exposed as the
  `/jev-mode` slash command after install): `uv run jev-setup/scripts/jev_mode.py
  [status|suggest|shadow|off|clear|set <mode|model|endpoint> <value>]` writes
  the mode/config to `_bmad/custom/config.user.toml` (or `--layer team`), and
  `... key <typesafe|openrouter> <api-key>` creates/updates the project `.env`
  with the credential (values are never echoed back — output is masked).

## Install

```bash
# From this repo (one command, non-interactive; drop --tools/--yes for prompts):
npx bmad-method install --custom-source https://github.com/peskycipher/jevBMAD \
  --tools claude-code --yes
```

Or install via the BMad installer from a local clone (`bmad install
modules/bmad-jev`), or run the `jev-setup` skill in-project after copying this
folder to the host's skill directory (`.claude/skills/` for Claude Code,
`.agents/skills/` for pi).

## Customizing

Each skill ships a `customize.toml` in its folder — the schema of what is customizable. Never edit it (updates overwrite it); instead create sparse override files:

- `{project-root}/_bmad/custom/<skill>.toml` — team overrides (committed)
- `{project-root}/_bmad/custom/<skill>.user.toml` — personal overrides (gitignored)

Overridable fields per skill (merge per BMad structural rules — scalars override, plain arrays append):

```toml
[workflow]
activation_steps_prepend = []   # run before the main flow
activation_steps_append = []    # run after the main output
persistent_facts = []           # standing context (sentences or file: references)
on_complete = []                # instructions executed when the skill finishes
```

Example — a team rule for the decide skill:

```toml
# _bmad/custom/bmad-jev-decide.toml
[workflow]
persistent_facts = [
  "Recommendations must respect our AWS-only architecture rule.",
]
on_complete = "Summarize the outcome in one line and offer to log it."
```

Check what resolved at any time:

```bash
uv run {project-root}/_bmad/scripts/resolve_customization.py \
  --skill <installed-path>/bmad-jev-decide --project-root {project-root} --key workflow
```

Decision-layer settings (`[jev]` mode, model, endpoint, API keys) are **central** configuration across the four config TOML layers — manage them with the bundled `jev_mode.ts` helper or the `/jev-mode` slash command, not per-skill overrides.

## Provenance

Scripts are copied verbatim from the validated jevBMAD pipeline
(`_bmad/custom/bmad-jev/{jev_adapter,jev_recommend,jev_policy,config,toml}.ts`,
`evals/harness/jev_client.ts`, `router/{bmad_gates,judge}.ts`), with only the
import paths adjusted for the bundled layout.
Thresholds default to the conservative §10 values; no lockfile ships. To use
the fitted values, copy `router/thresholds.lockfile.json` from the repo into
each skill's `scripts/` directory (e.g.
`bmad-jev-gates/scripts/thresholds.lockfile.json` and
`bmad-jev-review/scripts/thresholds.lockfile.json`) — each script resolves its
lockfile next to itself and falls back per-key to the conservative §10
defaults when it is absent: readiness noul gates **0.90**, ready_score
**≥ 3.0**; judge gates **≥ 0.95**, dimension pass **≥ 7** (note: the fitted
lockfile is less strict for the judge — 0.75/0.65/0.85 and 5.0 — because it
was calibrated on the golden sets; the fallback is deliberately stricter).