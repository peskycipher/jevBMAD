"""System-2 consumer (implementation.md §2, §8): GLM-5.3 via OpenRouter.

Consumes routing decisions with decision == "system2": sends the request,
retrieved memory context, and the routing reasons to the deep-reasoning
model, and logs cost/latency per call (evals/logs/system2.jsonl) linked to
the routing decision_id for the §7.5 end-to-end metrics.

Never silently succeeds: every failure returns an explicit status and the
caller decides. Cost comes from the provider-reported usage.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROUTER_DIR = Path(__file__).resolve().parent
LOG_PATH = ROUTER_DIR.parent / "evals" / "logs" / "system2.jsonl"

sys.path.insert(0, str(ROUTER_DIR.parent / "evals" / "harness"))
from jev_client import ensure_env_loaded  # noqa: E402  (loads the nearest .env once)

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "z-ai/glm-5.3"  # §10 system2 config

SYSTEM_PROMPT = (
    "You are the System-2 deep-reasoning agent in a hybrid routing architecture. "
    "A fast decision layer escalated this request to you. Handle it with full "
    "rigor: analyze the request, use the provided project context, and produce "
    "the requested answer or change. Be explicit about assumptions."
)


class System2Error(RuntimeError):
    pass


def execute(request_text: str, context: str = "", reasons: list | None = None,
            decision_id: str = "", log: bool = True) -> dict:
    """Send one escalated request to GLM. Returns the completion + metrics."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise System2Error("OPENROUTER_API_KEY not set")

    user_parts = [f"User request:\n{request_text}"]
    if context:
        user_parts.append(f"Project context (retrieved memory):\n{context}")
    if reasons:
        user_parts.append("Escalation reasons recorded by the System-1 router:\n- "
                          + "\n- ".join(reasons))
    payload = {
        "model": os.environ.get("SYSTEM2_MODEL", DEFAULT_MODEL),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ],
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
    )
    t0 = time.monotonic()
    last_err = None
    for attempt in range(2):  # one bounded retry on transient errors
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = json.loads(resp.read())
            latency_ms = (time.monotonic() - t0) * 1000
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code == 429 or e.code >= 500:
                last_err = System2Error(f"HTTP {e.code}: {detail}")
                time.sleep(2 ** attempt)
                continue
            raise System2Error(f"HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = System2Error(f"network error: {e}")
            time.sleep(2 ** attempt)
    else:
        raise last_err or System2Error("call failed")

    choice = body.get("choices", [{}])[0]
    result = {
        "status": "ok",
        "decision_id": decision_id,
        "model": body.get("model"),
        "text": (choice.get("message") or {}).get("content", ""),
        "finish_reason": choice.get("finish_reason"),
        "usage": body.get("usage", {}),
        "latency_ms": round(latency_ms, 1),
    }
    if log:
        _log(result, request_text)
    return result


def _log(result: dict, request_text: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "decision_id": result["decision_id"],
        "model": result["model"],
        "usage": result["usage"],
        "latency_ms": result["latency_ms"],
        "request": request_text[:500],
        "response_chars": len(result["text"]),
    }
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")