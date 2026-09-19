"""System-2 output judge — §7.7 rubric via Jev-as-judge (implementation.md v1.5).

Reviews a story implementation with one batched Jev call:

  Gates (Noul, all must pass >= 0.95):
    gate_spec           implements exactly what the story specifies
    gate_no_regression  does not break existing behavior
    gate_security       no security or data-safety violations

  Dimensions (Score, 2-10 scale rendered as a 9-level legend; pass >= 7):
    dim_correctness     correctness & completeness
    dim_quality         code quality / maintainability
    dim_tests           test coverage adequacy
    dim_bmad            BMAD compliance

  Failure taxonomy (Choice — only meaningful when a gate fails):
    spec-misread | partial-implementation | regression | architecture-violation
    | test-gap | environment | none_applicable | other

Verdict: `first_pass` when all gates pass and every dimension >= 7.
Otherwise `rework` with the taxonomy to drive the feedback loop; the caller
escalates to a human after 2 failed reworks (§7.7). All judgments logged.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROUTER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROUTER_DIR))
# jev_client.py ships beside this script

from jev_client import call_jev, JevError  # noqa: E402

LOCKFILE = ROUTER_DIR / "thresholds.lockfile.json"


def _load_locked(key: str, default: float) -> float:
    """Threshold from the fitted lockfile, falling back to §7.7 defaults."""
    if LOCKFILE.exists():
        data = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        v = data.get("gates", {}).get(key)
        if isinstance(v, (int, float)):
            return float(v)
    return default


GATE_THRESHOLDS = {g: _load_locked(f"judge_{g}", 0.95)
                   for g in ("gate_spec", "gate_no_regression", "gate_security")}
GATE_THRESHOLD = GATE_THRESHOLDS["gate_spec"]  # single-gate convenience/back-compat
DIM_PASS = _load_locked("judge_dim_min", 7)  # on the 2-10 scale

_DIM_LEGEND = [
    "2 - unacceptable: wrong or missing",
    "3 - poor: major gaps or flaws",
    "4 - below bar: several notable issues",
    "5 - mediocre: meets some expectations",
    "6 - adequate: minor issues only",
    "7 - good: solid, ready with trivial nitpicks",
    "8 - strong: clean and well-considered",
    "9 - excellent: thorough, edge cases handled",
    "10 - exemplary: nothing to improve",
]

QUESTIONS = {
    "gate_spec": {
        "type": "noul",
        "instructions": "Judging only from the implementation description: does it satisfy every acceptance criterion in the story, with nothing missing and no substitutions (e.g. a different output format or omitted columns count as unsatisfied)?",
        "proposition": "As described, the implementation satisfies the story.",
    },
    "gate_no_regression": {
        "type": "noul",
        "instructions": "Judging only from the implementation description: does it leave all existing behavior intact — no failing or skipped tests, no conflicting features, and no removed functionality are described? Judge the evidence in the text, not what might be hidden.",
        "proposition": "As described, existing behavior remains intact.",
    },
    "gate_security": {
        "type": "noul",
        "instructions": "Judging only from the implementation description: is it free of security or data-safety violations — no secret leaks, no unsafe commands, and no weakened validation or auth are described?",
        "proposition": "As described, the implementation is free of security or data-safety violations.",
    },
    "dim_correctness": {
        "type": "score",
        "instructions": "Rate correctness and completeness of the implementation against the story (2-10 scale).",
        "criteria": _DIM_LEGEND,
    },
    "dim_quality": {
        "type": "score",
        "instructions": "Rate code quality and maintainability of the implementation (2-10 scale).",
        "criteria": _DIM_LEGEND,
    },
    "dim_tests": {
        "type": "score",
        "instructions": "Rate the adequacy of test coverage relative to what the story's risk actually requires (a low-risk change like a rename needs few tests; a multi-tenant isolation change needs many). 2-10 scale.",
        "criteria": _DIM_LEGEND,
    },
    "dim_bmad": {
        "type": "score",
        "instructions": "Rate BMAD compliance: correct artifacts updated, workflow gates followed, story conventions respected (2-10 scale).",
        "criteria": _DIM_LEGEND,
    },
    "failure_kind": {
        "type": "choice",
        "instructions": "If any gate failed, classify the primary failure. If all gates passed, choose none_applicable.",
        "criteria": {
            "spec-misread": "The story requirements were misunderstood or misread",
            "partial-implementation": "Some required parts of the story were not implemented",
            "regression": "Existing behavior was broken",
            "architecture-violation": "The solution violates documented architecture constraints",
            "test-gap": "Tests are missing or inadequate for the implemented behavior",
            "environment": "Failure caused by environment/build issues, not the implementation",
            "none_applicable": "No gate failed",
            "other": "None of the listed categories fit",
        },
    },
}


def _log(entry: dict) -> None:
    log = ROUTER_DIR.parent / "evals" / "logs" / "judge.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _to_210(raw: float) -> float:
    """Map the 0-8 raw score position onto the 2-10 scale."""
    return raw + 2


def judge(story_text: str, implementation_text: str, log: bool = True,
          agent_id: str = "default") -> dict:
    """Judge one (story, implementation) pair against the §7.7 rubric."""
    state = (f"User story:\n\"\"\"\n{story_text}\n\"\"\"\n\n"
             f"Implementation (code/diff/description):\n\"\"\"\n{implementation_text}\n\"\"\"")
    t0 = time.monotonic()
    resp = call_jev(QUESTIONS, state)
    a = resp["answers"]

    reasons, gates_failed = [], []
    for gate in ("gate_spec", "gate_no_regression", "gate_security"):
        p = a[gate]["noul"]
        thr = GATE_THRESHOLDS[gate]
        if p < thr:
            gates_failed.append(gate)
            reasons.append(f"{gate} noul {p:.2f} < {thr}")

    dims = {}
    for dim in ("dim_correctness", "dim_quality", "dim_tests", "dim_bmad"):
        v = _to_210(a[dim]["score"])
        dims[dim] = {"score_210": round(v, 2), "confidence": a[dim]["confidence"]}
        if v < DIM_PASS:
            gates_failed.append(dim)
            reasons.append(f"{dim} {v:.1f} < {DIM_PASS} (2-10 scale)")

    verdict = "rework" if gates_failed else "first_pass"
    failure_kind = None
    if verdict == "rework":
        failure_kind = a["failure_kind"]["choice"]
        if failure_kind == "none_applicable":
            failure_kind = "other"

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "agent_id": agent_id,
        "verdict": verdict,
        "failure_kind": failure_kind,
        "gates_failed": gates_failed,
        "reasons": reasons,
        "dimensions": dims,
        "gate_nouls": {g: a[g]["noul"] for g in
                       ("gate_spec", "gate_no_regression", "gate_security")},
        "story": story_text[:300],
        "model_resolved": resp.get("model"),
        "usage": resp.get("usage"),
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
    }
    if log:
        _log(entry)

    return {
        "verdict": verdict,
        "failure_kind": failure_kind,
        "gates_failed": gates_failed,
        "reasons": reasons,
        "dimensions": {k: v["score_210"] for k, v in dims.items()},
        "gate_nouls": entry["gate_nouls"],
        "latency_ms": entry["latency_ms"],
    }


if __name__ == "__main__":
    def _degrade(reason_kind: str, reason: str) -> None:
        """Defined unavailable status — JSON, never a traceback (adapter contract)."""
        try:
            print(json.dumps({"status": "unavailable", "reason_kind": reason_kind,
                              "reason": reason[:300], "passed": None}, indent=2))
        except BrokenPipeError:
            pass

    if len(sys.argv) < 3:
        print(json.dumps({"status": "bad_request", "reason_kind": "usage",
                          "reason": "usage: judge.py <story_text> <implementation_text>",
                          "passed": None}, indent=2))
        raise SystemExit(2)
    try:
        print(json.dumps(judge(sys.argv[1], sys.argv[2]), indent=2))
    except JevError as e:
        _degrade("missing_api_key" if "API_KEY" in str(e).upper() else "provider_error",
                 str(e))
    except Exception as e:  # noqa: BLE001 — graceful degradation: JSON, never a traceback
        _degrade("internal_error", f"{type(e).__name__}: {e}")
