---
name: jev-setup
description: Sets up the Jev BMad Hybrid module in a project. Use when the user requests to 'install jev module', 'configure Jev BMad', or 'setup Jev decision layer'.
---

# Jev Module Setup

## Overview

Installs and configures the **Jev BMad Hybrid** module — a System-1/System-2 decision layer for BMad. Module identity (name, code, version) comes from `./assets/module.yaml`. Collects user preferences and writes them to three files:

- **`{project-root}/_bmad/config.yaml`** — shared project config: core settings at root (e.g. `output_folder`, `document_output_language`) plus a section per module with metadata and module-specific values. User-only keys (`user_name`, `communication_language`) are **never** written here.
- **`{project-root}/_bmad/config.user.yaml`** — personal settings intended to be gitignored: `user_name`, `communication_language`, and any module variable marked `user_setting: true` in `./assets/module.yaml`. These values live exclusively here.
- **`{project-root}/_bmad/module-help.csv`** — registers module capabilities for the help system.

Both config scripts use an anti-zombie pattern — existing entries for this module are removed before writing fresh ones, so stale values never persist.

`{project-root}` is a **literal token** in config _values_ (the data written into the files above) — never substitute it there. It signals to the consuming LLM that the value is relative to the project root, not the skill root. **This does not apply to the filesystem path _arguments_ passed to the scripts below** (the `--*-path`, `--*-dir`, and `--target` arguments): those are real paths, so you **must** resolve `{project-root}` to the actual project root before running, or the scripts will write to a literal `{project-root}/` directory under the skill folder. The scripts reject an unresolved token with an error.

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


5. Read `./assets/module.yaml` for module metadata and variable definitions (the `code` field is the module identifier)
6. Check if `{project-root}/_bmad/config.yaml` exists — if a section matching the module's code is already present, inform the user this is an update
7. Check for per-module configuration at `{project-root}/_bmad/custom/bmad-jev/config.yaml` and `{project-root}/_bmad/core/config.yaml`. If either file exists:
   - If `{project-root}/_bmad/config.yaml` does **not** yet have a section for this module: this is a **fresh install**. Inform the user that installer config was detected and values will be consolidated into the new format.
   - If `{project-root}/_bmad/config.yaml` **already** has a section for this module: this is a **legacy migration**. Inform the user that legacy per-module config was found alongside existing config, and legacy values will be used as fallback defaults.
   - In both cases, per-module config files and directories will be cleaned up after setup.

If the user provides arguments (e.g. `accept all defaults`, `--headless`, or inline values), map any provided values to config keys, use defaults for the rest, and skip interactive prompting. Still display the full confirmation summary at the end.

## Collect Configuration

Ask the user for values. Show defaults in brackets. Present all values together so the user can respond once with only the values they want to change. Never tell the user to "press enter" or "leave blank" — in a chat interface they must type something to respond.

**Default priority** (highest wins): existing new config values > legacy config values > `./assets/module.yaml` defaults. When legacy configs exist, read them and use matching values as defaults instead of `module.yaml` defaults. Only keys that match the current schema are carried forward — changed or removed keys are ignored.

**Core config** (only if no core keys exist yet): `user_name` (default: BMad), `communication_language` and `document_output_language` (default: English — ask as a single language question, both keys get the same answer), `output_folder` (default: `{project-root}/_bmad-output`). Of these, `user_name` and `communication_language` are written exclusively to `config.user.yaml`. The rest go to `config.yaml` at root and are shared across all modules.

**Module config — Jev runtime**: the module has no installer-managed module variables. Instead, confirm these two runtime settings with the user (defaults in brackets):

- Provider credentials — required for any live Jev call (`TYPESAFE_API_KEY` preferred, `OPENROUTER_API_KEY` as fallback). Do **not** ask the user to paste the key into chat. A template ships with this skill at `./assets/env.example`: copy it to `{project-root}/.env` if no `.env` exists there yet (`cp ./assets/env.example {project-root}/.env`), then have the user fill in the key in that file or export it in their shell. Without credentials, every skill still runs and returns explicit `unavailable` statuses.
- `BMAD_DECISION_ASSIST_MODE` — `off` (default), `shadow`, or `suggest`. The decision-support skill makes zero network calls in `off`; `shadow` behaves like `suggest` but its output is evaluation-only. Optionally persisted durably in `{project-root}/_bmad/custom/config.toml` under `[jev]` → `mode`.

## Write Files

Write a temp JSON file with the collected answers structured as `{"core": {...}, "module": {}}` (omit `core` if it already exists; this module defines no installer-managed module variables). Values inside this JSON keep the literal `{project-root}` token. Then run both scripts — they can run in parallel since they write to different files.

In the commands below, replace `{project-root}` in every path argument with the actual project root (e.g. `/home/me/myapp`) before running — these are filesystem paths, not config values.

```bash
uv run ./scripts/merge-config.py --config-path "{project-root}/_bmad/config.yaml" --user-config-path "{project-root}/_bmad/config.user.yaml" --module-yaml ./assets/module.yaml --answers {temp-file} --legacy-dir "{project-root}/_bmad"
uv run ./scripts/merge-help-csv.py --target "{project-root}/_bmad/module-help.csv" --source ./assets/module-help.csv --legacy-dir "{project-root}/_bmad" --module-code custom/bmad-jev
```

Both scripts output JSON to stdout with results. If either exits non-zero, surface the error and stop. The scripts automatically read legacy config values as fallback defaults, then delete the legacy files after a successful merge. Check `legacy_configs_deleted` and `legacy_csvs_deleted` in the output to confirm cleanup.

Run `./scripts/merge-config.py --help` or `./scripts/merge-help-csv.py --help` for full usage.

## Create Output Directories

After writing config, create any output directories that were configured. For filesystem operations only (such as creating directories), resolve the `{project-root}` token to the actual project root and create each path-type value from `config.yaml` that does not yet exist — this includes `output_folder` and any module variable whose value starts with `{project-root}/`. The paths stored in the config files must continue to use the literal `{project-root}` token; only the directories on disk should use the resolved paths. Use `mkdir -p` or equivalent to create the full path.

## Verify Runtime Prerequisites

After registration, verify the runtime environment so the user knows what to expect:

11. `uv run ./scripts/merge-config.py --help` — confirms `uv` and PEP 723 resolution work (no output means `uv` is missing; tell the user, but do not fail the install).
12. `cp -n ./assets/env.example "{project-root}/.env"` — seed the env template if the project has no `.env` yet; the user still has to fill in `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` before any live call succeeds.
13. `echo ${TYPESAFE_API_KEY:+set} ${OPENROUTER_API_KEY:+set}` — if neither is set, warn: the skills still work and abstain conservatively, but every decision returns `status: unavailable` until a key is exported or written to `.env`.
14. Optional: persist `[jev] mode = "suggest"` in `{project-root}/_bmad/custom/config.toml` if the user chose a durable mode.

## Cleanup Legacy Directories

After both merge scripts complete successfully, remove the installer's package directories. Skills and agents in these directories are already installed at `.claude/skills/` — the `_bmad/` directory should only contain config files.

As with the merge scripts, replace `{project-root}` in the `--bmad-dir` and `--skills-dir` path arguments with the actual project root before running.

```bash
uv run ./scripts/cleanup-legacy.py --bmad-dir "{project-root}/_bmad" --module-code custom/bmad-jev --also-remove _config --also-remove jev --also-remove bmad-jev --skills-dir "{project-root}/.claude/skills"
```

The `jev` and `bmad-jev` entries in `--also-remove` clean up installs made under earlier module folder names (`_bmad/jev/`, `_bmad/bmad-jev/`); each holds only config files, no skills, so they are removed directly. The script verifies that every skill in the legacy directories exists at `.claude/skills/` before removing anything. Directories without skills (like `_config/`) are removed directly. If the script exits non-zero, surface the error and stop. Missing directories (already cleaned by a prior run) are not errors — the script is idempotent.

Check `directories_removed` and `files_removed_count` in the JSON output for the confirmation step. Run `./scripts/cleanup-legacy.py --help` for full usage.

## Confirm

Use the script JSON output to display what was written — config values set (written to `config.yaml` at root for core, module section for module values), user settings written to `config.user.yaml` (`user_keys` in result), help entries added, fresh install vs update. If legacy files were deleted, mention the migration. If legacy directories were removed, report the count and list. Then display the `module_greeting` from `./assets/module.yaml` to the user.

## Outcome

Once the user's `user_name` and `communication_language` are known (from collected input, arguments, or existing config), use them consistently for the remainder of the session: address the user by their configured name and communicate in their configured `communication_language`.

## On Completion

After presenting the skill's main output:

1. Execute each entry of `{{workflow.activation_steps_append}}` in order.
2. Execute the `{{workflow.on_complete}}` instructions (a string, or an array in order).
3. Then report the run as complete.

Both come from the customization block resolved in step 1; empty lists mean nothing to do.
