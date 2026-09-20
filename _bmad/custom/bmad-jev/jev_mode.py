#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Show or change Jev decision-assist configuration.

Modes: off (default, zero network calls) | shadow (evaluate only) | suggest.

Config reads follow the same four TOML layers as the runtime —
_bmad/config.toml, _bmad/config.user.toml, _bmad/custom/config.toml,
_bmad/custom/config.user.toml (later layers override) — and the
BMAD_DECISION_ASSIST_MODE environment override wins over all of them,
exactly like jev_adapter.load_settings. Config writes go to the
highest-priority durable layer by default (_bmad/custom/config.user.toml);
pass --layer team to write _bmad/custom/config.toml instead.

API keys are managed in the project .env file (created if missing), which the
Jev scripts read via their nearest-.env loader; real environment variables
still win at call time.

All output is JSON on stdout. Exit codes: 0 ok, 2 usage/caller error,
3 missing _bmad/ directory.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True

VALID_MODES = ("off", "shadow", "suggest")

# (layer name, file path relative to _bmad/) in merge order (lowest → highest priority)
LAYERS = (
    ("base", "config.toml"),
    ("base-user", "config.user.toml"),
    ("team", "custom/config.toml"),
    ("user", "custom/config.user.toml"),
)
WRITE_LAYERS = ("user", "team")
DEFAULT_WRITE_LAYER = "user"

ENV_OVERRIDE = "BMAD_DECISION_ASSIST_MODE"

# [jev] keys this tool may write via `set` (mode is also exposed as a top-level action)
SETTABLE_KEYS = ("mode", "model", "endpoint")

# API keys managed via `key` in the project .env file
KEY_NAMES = {"typesafe": "TYPESAFE_API_KEY", "openrouter": "OPENROUTER_API_KEY"}

ENV_TEMPLATE = """# JevBMAD credentials and provider configuration.
# Copy of .env.example — created by `jev_mode.py key`. Never commit this file.

# TypeSafe direct (recommended): https://console.typesafe.ai/settings/keys
TYPESAFE_API_KEY=
# OpenRouter fallback (used when TYPESAFE_API_KEY is unset): https://openrouter.ai/keys
OPENROUTER_API_KEY=
"""

USAGE_HINT = ("usage: jev_mode.py [status|suggest|shadow|off|clear] "
              "[--layer user|team] [--project-root DIR]\n"
              "       jev_mode.py set <mode|model|endpoint> <value> [--layer user|team]\n"
              "       jev_mode.py key <typesafe|openrouter> <api-key> [--env-file PATH]")

MASKED_KEYS = ("TYPESAFE_API_KEY", "OPENROUTER_API_KEY")


def _fail(status_reason: str, code: int = 2) -> int:
    print(json.dumps({"status": "bad_request", "reason": status_reason,
                      "usage": USAGE_HINT}))
    return code


def _read_layer(bmad_dir: Path, rel: str) -> dict:
    path = bmad_dir / rel
    if not path.is_file():
        return {}
    try:
        import tomllib
        with open(path, "rb") as handle:
            return tomllib.load(handle)
    except Exception as error:  # tomllib.TOMLDecodeError, OSError
        sys.stderr.write(f"warning: could not parse {path}: {error}\n")
        return {}


def _layer_sources(bmad_dir: Path, key: str = "mode") -> list[dict]:
    """Layers that set a non-empty raw [jev] <key> string, in merge order."""
    found = []
    for name, rel in LAYERS:
        table = _read_layer(bmad_dir, rel).get("jev")
        if isinstance(table, dict):
            value = table.get(key)
            if isinstance(value, str) and value.strip():
                found.append({"layer": name, "file": f"_bmad/{rel}", key: value.strip()})
    return found


def resolve_mode(bmad_dir: Path) -> dict:
    env = os.environ.get(ENV_OVERRIDE, "").strip().lower()
    if env:
        return {"mode": env if env in VALID_MODES else "off",
                "source": "environment", "valid": env in VALID_MODES}
    sources = _layer_sources(bmad_dir, "mode")
    if sources:
        top = sources[-1]
        return {"mode": top["mode"] if top["mode"] in VALID_MODES else "off",
                "source": top["layer"], "file": top["file"], "valid": top["mode"] in VALID_MODES}
    return {"mode": "off", "source": "default", "valid": True}


def _rewrite_jev_key(text: str, key: str, value: str | None) -> tuple[str, bool]:
    """Update (or add/remove) a key inside the [jev] section of TOML text,
    preserving comments and unrelated keys. Returns (new_text, changed)."""
    lines = text.splitlines(keepends=True)
    in_jev = False
    header_idx = None
    key_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_jev = stripped == "[jev]"
            if in_jev and header_idx is None:
                header_idx = i
            continue
        if in_jev and not stripped.startswith("#") and "=" in stripped:
            if stripped.split("=", 1)[0].strip() == key:
                key_idx = i
                break
    if value is None:  # clear / remove
        if key_idx is None:
            return text, False
        del lines[key_idx]
        return "".join(lines), True
    quoted = f'{key} = "{value}"'
    if key_idx is not None:
        lines[key_idx] = f"{quoted}\n"
        return "".join(lines), True
    if header_idx is not None:
        lines.insert(header_idx + 1, f"{quoted}\n")
        return "".join(lines), True
    section = f"\n[jev]\n{quoted}\n"
    if text and not text.endswith("\n"):
        text += "\n"
    return text + section, True


def _write_jev_key(bmad_dir: Path, layer: str, key: str, value: str | None) -> dict:
    rel = dict(LAYERS)[layer]
    path = bmad_dir / rel
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    new_text, changed = _rewrite_jev_key(text, key, value)
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(new_text, encoding="utf-8")
    return {"file": f"_bmad/{rel}", "changed": changed}


def _env_status(env_file: Path) -> dict:
    """Masked per-key state of the .env file (never prints key values)."""
    state = {name: {"in_env_file": False, "in_environment": bool(os.environ.get(name))}
             for name in MASKED_KEYS}
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or "=" not in stripped:
                continue
            name = stripped.split("=", 1)[0].strip()
            if name in state and stripped.split("=", 1)[1].strip():
                state[name]["in_env_file"] = True
    return state


def _rewrite_env_key(text: str, name: str, value: str) -> tuple[str, bool]:
    """Set KEY=value in .env text: replace an active or commented assignment,
    else append. Returns (new_text, changed)."""
    lines = text.splitlines(keepends=True)
    active_idx = commented_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(f"{name}=") or stripped == f"{name} =":
            active_idx = i
            break
        if commented_idx is None and stripped.lstrip("#").strip().startswith(f"{name}="):
            commented_idx = i
    assignment = f"{name}={value}\n"
    if active_idx is not None:
        already = lines[active_idx].strip() == assignment.strip()
        if already:
            return text, False
        lines[active_idx] = assignment
        return "".join(lines), True
    if commented_idx is not None:
        lines[commented_idx] = assignment
        return "".join(lines), True
    if text and not text.endswith("\n"):
        text += "\n"
    return text + assignment, True


def _write_env_key(project_root: Path, name: str, value: str) -> dict:
    env_file = project_root / ".env"
    if env_file.is_file():
        text = env_file.read_text(encoding="utf-8")
        created = False
    else:
        text = ENV_TEMPLATE
        created = True
    new_text, changed = _rewrite_env_key(text, name, value)
    if changed:
        env_file.write_text(new_text, encoding="utf-8")
    return {"file": str(env_file), "created": created, "changed": changed,
            "masked_value": (value[:4] + "…" + value[-2:]) if len(value) > 8 else "…"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Show or change Jev decision-assist configuration.")
    parser.add_argument("action", nargs="?", default="status",
                        help="status (default) | suggest | shadow | off | clear | set <key> <value> | key <provider> <api-key>")
    parser.add_argument("value", nargs="*", help="value argument for set/key")
    parser.add_argument("--project-root", "-p", default=".",
                        help="Project root containing _bmad/ (default: cwd)")
    parser.add_argument("--layer", choices=list(WRITE_LAYERS), default=DEFAULT_WRITE_LAYER,
                        help="Config layer to write: user (default) or team")
    parser.add_argument("--env-file", default=None,
                        help="Alternative .env path (default: <project-root>/.env)")
    args = parser.parse_args()

    if args.action not in ("status", "clear", "set", "key", *VALID_MODES):
        return _fail(f"unknown action {args.action!r}")
    if args.action == "set" and (len(args.value) != 2 or args.value[0] not in SETTABLE_KEYS):
        return _fail(f"'set' expects <mode|model|endpoint> <value>; got {args.value!r}")
    if args.action == "key":
        if len(args.value) != 2 or args.value[0] not in KEY_NAMES:
            return _fail(f"'key' expects <{'|'.join(KEY_NAMES)}> <api-key>; got {args.value[:1]!r} <api-key>")
        if not args.value[1].strip():
            return _fail("api-key value must not be empty")
        if args.value[0] == "openrouter" and not args.value[1].strip().startswith("sk-or-"):
            sys.stderr.write("warning: OpenRouter keys normally start with 'sk-or-'; writing anyway\n")

    project_root = Path(args.project_root).resolve()
    bmad_dir = project_root / "_bmad"
    if not bmad_dir.is_dir():
        sys.stderr.write(f"error: no _bmad/ directory under {project_root}\n")
        return 3

    env_file = Path(args.env_file).resolve() if args.env_file else project_root / ".env"
    resolved = resolve_mode(bmad_dir)
    env_active = os.environ.get(ENV_OVERRIDE, "").strip() != ""

    result: dict = {"status": "ok", "action": args.action, "mode": resolved["mode"],
                    "mode_source": resolved["source"], "mode_valid": resolved["valid"],
                    "env_override_active": env_active,
                    "layers_setting_mode": _layer_sources(bmad_dir, "mode"),
                    "layers_setting_model": _layer_sources(bmad_dir, "model"),
                    "layers_setting_endpoint": _layer_sources(bmad_dir, "endpoint"),
                    "env_file": str(env_file),
                    "keys": _env_status(env_file)}
    api_key_present = any(v["in_env_file"] or v["in_environment"] for v in result["keys"].values())
    result["api_key_present"] = api_key_present
    result["callable"] = result["mode"] in ("shadow", "suggest") and api_key_present

    if args.action == "status":
        pass
    elif args.action == "key":
        name = KEY_NAMES[args.value[0]]
        result["written_env"] = _write_env_key(project_root, name, args.value[1].strip())
        result["keys"] = _env_status(env_file)
        result["api_key_present"] = any(v["in_env_file"] or v["in_environment"] for v in result["keys"].values())
    elif args.action == "set":
        key, value = args.value
        if key == "mode" and value not in VALID_MODES:
            return _fail(f"invalid mode {value!r}; expected one of {', '.join(VALID_MODES)}")
        if env_active:
            result["status"] = "bad_request"
            result["reason"] = (f"{ENV_OVERRIDE}={os.environ[ENV_OVERRIDE]} is set in the environment "
                                "and overrides all config layers; unset it or edit the shell profile")
            print(json.dumps(result))
            return 2
        result["written"] = _write_jev_key(bmad_dir, args.layer, key, value)
        after = resolve_mode(bmad_dir)
        result["mode"] = after["mode"]
        result["mode_source"] = after["source"]
    else:  # suggest | shadow | off | clear
        if env_active:
            result["status"] = "bad_request"
            result["reason"] = (f"{ENV_OVERRIDE}={os.environ[ENV_OVERRIDE]} is set in the environment "
                                "and overrides all config layers; unset it or edit the shell profile")
            print(json.dumps(result))
            return 2
        value = None if args.action == "clear" else args.action
        result["written"] = _write_jev_key(bmad_dir, args.layer, "mode", value)
        after = resolve_mode(bmad_dir)
        result["mode"] = after["mode"]
        result["mode_source"] = after["source"]

    result["callable"] = result["mode"] in ("shadow", "suggest") and result["api_key_present"]
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
