"""Minimal client for the Jev Decisions API.

TypeSafe direct (TYPESAFE_API_KEY): POST https://api.typesafe.ai/v1/systemone
OpenRouter fallback (OPENROUTER_API_KEY): POST https://openrouter.ai/api/alpha/decisions
TYPESAFE_API_KEY wins when both are set; see resolve_provider().
Schema (validated live 2026-09-19):
  { "model": "typesafe/jev-1.13-20260917",
    "state": str | dict | list,
    "questions": { <qid>: {
        "type": "noul"|"choice"|"score",
        "instructions": str | dict | list,       # required for all
        "proposition": str,                       # noul only
        "criteria": dict (choice) | array (score),  # required
        ... } } }
Response answers carry `noul` (0-1), `choice` + `probabilities` + `confidence`,
or fractional `score` + `legend` + `probabilities` + `confidence`.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT_TYPESAFE = "https://api.typesafe.ai/v1/systemone"
ENDPOINT_OPENROUTER = "https://openrouter.ai/api/alpha/decisions"
MODEL_TYPESAFE = "jev-1.13.0"  # pinned versioned ID per docs.typesafe.ai/models
DEFAULT_MODEL = "typesafe/jev-1.13-20260917"  # pinned dated snapshot (reproducible eval); re-fit thresholds if this changes (§6)
ENDPOINT = ENDPOINT_OPENROUTER  # legacy alias: OpenRouter fallback endpoint
LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "decisions.jsonl"


RETRY_AFTER_CAP_SECONDS = 30.0  # cap a numeric Retry-After so a huge value cannot stall a CLI run


def _retry_after_seconds(headers) -> float | None:
    """Seconds to wait per a numeric ``Retry-After`` header, or None.

    Per docs.typesafe.ai, 429 responses may carry ``Retry-After``; honor it
    when numeric. HTTP-date form is not handled; values are capped at
    RETRY_AFTER_CAP_SECONDS.
    """
    if headers is None:
        return None
    value = headers.get("Retry-After")  # http.client headers are case-insensitive
    if not value:
        return None
    try:
        return max(0.0, min(float(value), RETRY_AFTER_CAP_SECONDS))
    except (TypeError, ValueError):
        return None


class JevError(RuntimeError):
    pass


_ENV_LOADED = False


def _parse_env_line(line: str) -> tuple[str, str] | None:
    """Parse one KEY=VALUE line. Comments, blanks, and malformed lines -> None."""
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if text.startswith("export "):
        text = text[len("export "):].strip()
    key, sep, value = text.partition("=")
    if not sep or not key.isidentifier():
        return None
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return key, value


def ensure_env_loaded() -> None:
    """Load the nearest `.env` (walking up from the working directory) once.

    dotenv conventions: existing environment variables always win; a missing
    or unreadable `.env` is silently ignored. Idempotent per module copy.
    """
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True
    here = Path.cwd()
    for candidate in (here, *here.parents):
        path = candidate / ".env"
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        for line in lines:
            parsed = _parse_env_line(line)
            if parsed is not None and parsed[0] not in os.environ:
                os.environ[parsed[0]] = parsed[1]
        return


def env_has_provider_key() -> bool:
    """True when TYPESAFE_API_KEY or OPENROUTER_API_KEY is available (after .env load)."""
    ensure_env_loaded()
    return bool(os.environ.get("TYPESAFE_API_KEY") or os.environ.get("OPENROUTER_API_KEY"))


def resolve_provider() -> tuple[str, str, str] | None:
    """Return (endpoint, api_key, default_model) for the first credential set.

    TYPESAFE_API_KEY (TypeSafe direct) wins over OPENROUTER_API_KEY
    (OpenRouter fallback). Credentials may also come from the nearest
    `.env` file (see ensure_env_loaded); real environment variables win.
    Returns None when no key is set.
    """
    ensure_env_loaded()
    typesafe = os.environ.get("TYPESAFE_API_KEY") or None
    if typesafe:
        return ENDPOINT_TYPESAFE, typesafe, MODEL_TYPESAFE
    openrouter = os.environ.get("OPENROUTER_API_KEY") or None
    if openrouter:
        return ENDPOINT_OPENROUTER, openrouter, DEFAULT_MODEL
    return None


def call_jev(
    questions: dict,
    state,
    model: str | None = None,
    retries: int = 3,
    log: bool = True,
) -> dict:
    """Call the Decisions API. Returns the full response dict (answers + usage)."""
    provider = resolve_provider()
    if provider is None:
        raise JevError("set TYPESAFE_API_KEY (TypeSafe direct) or OPENROUTER_API_KEY (fallback)")
    endpoint, api_key, provider_model = provider
    if model is None or model == DEFAULT_MODEL:
        model = provider_model

    payload = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(
            endpoint,
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read())
            latency_ms = (time.monotonic() - t0) * 1000
            if log:
                _log_call(questions, state, body, latency_ms)
            return body
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            # 4xx = our payload is wrong; do not retry blindly except 429
            if e.code == 429 or e.code >= 500:
                last_err = JevError(f"HTTP {e.code}: {detail[:500]}")
                delay = _retry_after_seconds(e.headers)
                time.sleep(2**attempt if delay is None else min(delay, RETRY_AFTER_CAP_SECONDS))
                continue
            raise JevError(f"HTTP {e.code}: {detail[:500]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = JevError(f"network error: {e}")
            time.sleep(2**attempt)
    raise last_err or JevError("call failed")


def _log_call(questions: dict, state, response: dict, latency_ms: float) -> None:
    """Append one JSON line per API call (implementation.md §6/§7: log full
    distributions + confidence + resolved model for threshold fitting)."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "latency_ms": round(latency_ms, 1),
        "model_resolved": response.get("model"),
        "usage": response.get("usage"),
        "id": response.get("id"),
        "questions": questions,
        "state": state if isinstance(state, str) else json.dumps(state)[:2000],
        "answers": response.get("answers"),
    }
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")