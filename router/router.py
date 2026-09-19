"""System-1 router (implementation.md §2 Core Routing Policy, §10 config).

One batched Jev call answers three atomic questions:
  intent     (choice)  - what kind of request is this?
  safe_auto  (noul)     - is it safe to auto-execute without deeper review?
  complexity (score)    - how complex is the implementation?

Routing policy (§2, §6, §10):
  force keywords | intent='other' | noul(safe) < threshold | complexity > cap
    | intent confidence < threshold  ->  escalate to System 2 (GLM-5.3)
  medium confidence band             ->  System 1 auto-execute + needs_review flag
  all clear                          ->  System 1 auto-execute

Every decision is logged with full distributions (logs/routing.jsonl).
Thresholds come from router/thresholds.lockfile.json (fitted in Phase 1).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROUTER_DIR = Path(__file__).resolve().parent
EVALS_DIR = ROUTER_DIR.parent / "evals" / "golden-sets"
sys.path.insert(0, str(ROUTER_DIR))
sys.path.insert(0, str(ROUTER_DIR.parent / "evals" / "harness"))

from jev_client import call_jev  # noqa: E402
import memory  # noqa: E402

LOCKFILE = ROUTER_DIR / "thresholds.lockfile.json"

DEFAULTS = {
    "intent_conf_min": 0.75,      # §10 routing default
    "intent_conf_high": 0.90,     # medium band top -> clean auto below is flagged
    "safe_noul_escalate": 0.50,   # below: escalate (holdout: unsafe max 0.17)
    "safe_noul_clean": 0.75,      # above: clean auto; between = auto + flag
    "complexity_max": 1.5,         # score levels 0..4: allow trivial+minor only
    "force_system2_keywords": ["architecture", "security", "refactor",
                               "migrate", "design"],
}


def load_questions() -> dict:
    """Single source of truth: reuse the golden-set criteria in production."""
    questions = {}
    for qid, path in {
        "intent": EVALS_DIR / "routing" / "criteria.json",
        "safe_auto": EVALS_DIR / "guardrails" / "criteria.json",
        "complexity": EVALS_DIR / "complexity" / "criteria.json",
    }.items():
        questions.update(json.loads(path.read_text(encoding="utf-8"))["questions"])
    return questions


def load_thresholds() -> dict:
    if LOCKFILE.exists():
        data = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        return {**DEFAULTS, **data.get("locked", {})}
    return dict(DEFAULTS)


def _log(entry: dict) -> None:
    log = ROUTER_DIR.parent / "evals" / "logs" / "routing.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def route(request_text: str, project_root: str = ".", use_memory: bool = True,
          questions: dict | None = None, thr: dict | None = None,
          agent_id: str = "default") -> dict:
    """Full System-1 routing decision for one user request."""
    thr = thr or load_thresholds()
    questions = questions or load_questions()

    # Step 1: unified memory retrieval (§2)
    ctx = memory.retrieve_all(request_text, project_root) if use_memory else None
    state = f"User request:\n{request_text}"
    if ctx:
        state += "\n\n" + memory.format_context(ctx)

    # Step 2-3: batched Jev call + thresholds
    t0 = time.monotonic()
    resp = call_jev(questions, state)
    a = resp["answers"]

    intent = a["intent"]
    safe = a["safe_auto"]
    cx = a["complexity"]
    reasons, decision = [], "system1_auto"
    request_l = request_text.lower()

    # Hard gates -> System 2
    if any(k in request_l for k in thr["force_system2_keywords"]):
        decision = "system2"
        reasons.append(f"force keyword in request: {[k for k in thr['force_system2_keywords'] if k in request_l]}")
    if intent["choice"] == "other":
        decision = "system2"
        reasons.append("intent=other -> fallback (§3)")
    if intent["confidence"] < thr["intent_conf_min"]:
        decision = "system2"
        reasons.append(f"intent confidence {intent['confidence']:.2f} < {thr['intent_conf_min']}")
    safety_flagged = False
    if safe["noul"] < thr["safe_noul_escalate"]:
        decision = "system2"
        reasons.append(f"safety noul {safe['noul']:.2f} < {thr['safe_noul_escalate']}")
    elif safe["noul"] < thr["safe_noul_clean"]:
        safety_flagged = True
        reasons.append(
            f"safety noul {safe['noul']:.2f} in flagged band "
            f"[{thr['safe_noul_escalate']}, {thr['safe_noul_clean']}) -> auto + flag (§6/§14.2)")
    if cx["score"] > thr["complexity_max"]:
        decision = "system2"
        reasons.append(f"complexity {cx['score']:.2f} > {thr['complexity_max']}")

    # Medium band -> auto-execute + flag (§6)
    needs_review = (
        decision == "system1_auto"
        and (thr["intent_conf_min"] <= intent["confidence"] < thr["intent_conf_high"]
             or safety_flagged)
    )
    if needs_review and thr["intent_conf_min"] <= intent["confidence"] < thr["intent_conf_high"]:
        reasons.append("medium confidence band -> execute + flag (§6)")

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "agent_id": agent_id,
        "request": request_text[:500],
        "decision": decision,
        "needs_review": needs_review,
        "reasons": reasons,
        "intent": intent,
        "safe_auto": safe,
        "complexity": cx,
        "model_resolved": resp.get("model"),
        "usage": resp.get("usage"),
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        "memory": {"graft_chars": len(ctx["graft"]) if ctx else 0,
                   "graft_excerpt": ctx["graft"][:1000] if ctx else "",
                   "mem0_active": bool(ctx and ctx["mem0_active"])},
    }
    _log(entry)

    return {
        "decision": decision,
        "needs_review": needs_review,
        "intent": intent["choice"],
        "intent_confidence": intent["confidence"],
        "safe_noul": safe["noul"],
        "complexity_score": cx["score"],
        "reasons": reasons,
        "model": resp.get("model"),
        "latency_ms": entry["latency_ms"],
    }


if __name__ == "__main__":
    req = " ".join(sys.argv[1:]) or "What does the retry helper do in http_client.py?"
    print(json.dumps(route(req), indent=2))