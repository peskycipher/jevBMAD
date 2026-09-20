---
description: Show or change Jev decision-assist config (mode, model, endpoint) and API keys
argument-hint: "[status|suggest|shadow|off|clear|set <mode|model|endpoint> <value>|key <typesafe|openrouter> <api-key>]"
allowed-tools: Bash(uv run _bmad/scripts/jev_mode.py:*)
---

# Jev Config Control

Manage the Jev decision layer's runtime configuration via the canonical script
`_bmad/scripts/jev_mode.py` (stdlib-only, PEP 723 — always invoke through
`uv run`). All script output is JSON; report the relevant fields to the user
concisely and never print API key values (the script masks them — keep it that
way).

## User's request

$ARGUMENTS

## Instructions

Parse the user's arguments and map them to exactly ONE script invocation:

- No arguments, or "status" / "show" / "what mode" → `uv run _bmad/scripts/jev_mode.py`
- "suggest" / "on" (advisory recommendations) → `... suggest`
- "shadow" (evaluate only) → `... shadow`
- "off" / "disable" → `... off`
- "clear" / "default" (remove the mode override, revert to default `off`) → `... clear`
- "set <mode|model|endpoint> <value>" → `... set <key> <value>` (e.g. `set model jev-1.13.0`)
- "key <typesafe|openrouter> <api-key>" or "set the api key ..." → `... key <provider> <api-key>`
  - If the user gives a key, run the command. If they give no key, tell them the
    exact command to run themselves instead — do not ask them to paste the key
    into chat.
- `--layer team` targets `_bmad/custom/config.toml` (committed, team-wide);
  default writes target `_bmad/custom/config.user.toml` (personal layer).

## Reporting

From the JSON output, report to the user in one or two lines:

- `mode` + `mode_source` (e.g. "mode: suggest (user layer)" or "mode: off (default)")
- if `env_override_active` is true: the BMAD_DECISION_ASSIST_MODE environment
  variable shadows all config layers — config edits were refused (status
  bad_request); tell the user to unset it in their shell profile.
- if `keys` shows no API key anywhere and the mode is not `off`: note that
  skills will run but abstain with `status: unavailable` until a key is set.
- if `mode_valid` is false: an unknown mode string exists in a config layer and
  is being treated as `off`; point at the file in `layers_setting_mode`.

Never edit the TOML/`.env` files directly — the script is the only writer, so
comments and unrelated keys survive. If the script exits non-zero, surface its
JSON `reason` and stop.
