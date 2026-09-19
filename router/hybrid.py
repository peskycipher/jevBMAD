"""Hybrid dispatcher (implementation.md §2 Core Routing Policy, steps 4-6).

Full end-to-end path: route with Jev (System 1), then
  - system1_auto  -> return the routing decision; the host harness executes
                     (System-1 execution is the harness's normal flow)
  - system2       -> escalate to the GLM consumer (router/system2.py) with
                     the retrieved memory context + routing reasons

Logs end-to-end latency and total cost per dispatch (§7.5 metrics): the
System-2 call is linked to its routing decision by decision_id.

Usage:
  python3 router/hybrid.py "user request text"
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROUTER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROUTER_DIR))
sys.path.insert(0, str(ROUTER_DIR.parent / "evals" / "harness"))

from router import route  # noqa: E402
import memory  # noqa: E402
from system2 import System2Error, execute  # noqa: E402
from jev_client import JevError  # noqa: E402


def dispatch(request_text: str, project_root: str = ".", use_memory: bool = True) -> dict:
    """Route, then execute per the decision. Returns end-to-end metrics."""
    t0 = time.monotonic()

    # Step 1-4: System-1 routing (decision_id links all downstream logs)
    routing = route(request_text, project_root=project_root, use_memory=use_memory)
    decision_id = routing["decision_id"]

    out = {
        "request": request_text,
        "decision_id": decision_id,
        "routing": {k: routing[k] for k in
                    ("decision", "needs_review", "intent", "intent_confidence",
                     "safe_noul", "complexity_score", "reasons")},
        "system2": None,
        "end_to_end_ms": None,
        "cost_usd": None,
    }

    # Step 5: System-2 escalation path
    if routing["decision"] == "system2":
        ctx = memory.retrieve_all(request_text, project_root) if use_memory else None
        try:
            s2 = execute(
                request_text,
                context=memory.format_context(ctx) if ctx else "",
                reasons=routing["reasons"],
                decision_id=decision_id,
            )
            out["system2"] = {
                "status": "ok",
                "model": s2["model"],
                "text": s2["text"],
                "latency_ms": s2["latency_ms"],
                "usage": s2["usage"],
            }
        except System2Error as e:
            out["system2"] = {"status": "error", "error": str(e)}

    routing_cost = routing.get("usage", {}).get("cost", 0)
    s2_cost = (out["system2"] or {}).get("usage", {}).get("cost", 0) if out["system2"] else 0
    out["cost_usd"] = round(routing_cost + s2_cost, 8)
    out["end_to_end_ms"] = round((time.monotonic() - t0) * 1000, 1)
    return out


if __name__ == "__main__":
    def _degrade(reason_kind: str, reason: str) -> None:
        """Defined unavailable status — JSON, never a traceback (adapter contract)."""
        try:
            print(json.dumps({"status": "unavailable", "reason_kind": reason_kind,
                              "reason": reason[:300],
                              "routing_decision": "unavailable"}, indent=2))
        except BrokenPipeError:
            pass

    req = " ".join(sys.argv[1:]) or "Refactor the router package into a cleaner module layout."
    try:
        result = dispatch(req)
        summary = {k: result[k] for k in ("decision_id", "end_to_end_ms", "cost_usd")}
        summary["routing_decision"] = result["routing"]["decision"]
        if result["system2"] and result["system2"]["status"] == "ok":
            summary["system2_model"] = result["system2"]["model"]
            summary["system2_latency_ms"] = result["system2"]["latency_ms"]
            summary["response_preview"] = result["system2"]["text"][:200]
        print(json.dumps(summary, indent=2))
    except JevError as e:
        _degrade("missing_api_key" if "API_KEY" in str(e).upper() else "provider_error",
                 str(e))
    except Exception as e:  # noqa: BLE001 — internal bugs degrade too, never traceback
        _degrade("internal_error", f"{type(e).__name__}: {e}")
