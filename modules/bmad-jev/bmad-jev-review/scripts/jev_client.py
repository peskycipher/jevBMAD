"""Minimal client for the Jev Decisions API (OpenRouter).

POST https://openrouter.ai/api/alpha/decisions
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

ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_MODEL = "typesafe/jev-1.13-20260917"  # pinned dated snapshot (reproducible eval); re-fit thresholds if this changes (§6)
LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "decisions.jsonl"


class JevError(RuntimeError):
    pass


def call_jev(
    questions: dict,
    state,
    model: str = DEFAULT_MODEL,
    retries: int = 3,
    log: bool = True,
) -> dict:
    """Call the Decisions API. Returns the full response dict (answers + usage)."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise JevError("OPENROUTER_API_KEY not set")

    payload = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(
            ENDPOINT,
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
                time.sleep(2**attempt)
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