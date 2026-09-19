"""BMAD phase-transition readiness gates (implementation.md §9, Phase 2).

Maps the hybrid routing onto the BMAD workflow (Analysis → Planning →
Solutioning → Implementation): before a phase transition, one batched Jev
call evaluates the upstream artifact on four atomic questions:

  spec_specific          (noul)  requirements are concrete, not vague
  requirements_testable (noul)  acceptance criteria are verifiable
  no_blockers            (noul)  no unresolved blocking questions/decisions
  ready_score            (score) overall readiness 0-4

  blocker_kind           (choice) why it is NOT ready — only meaningful when
                                 a gate fails; `none_applicable` otherwise.

Policy (conservative, §6/§10): proceed only when all three noul gates clear
0.90 AND ready_score >= 3.0. Any failure yields `hold` with the blocker
taxonomy for the rework loop. Every decision is logged.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROUTER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROUTER_DIR))
sys.path.insert(0, str(ROUTER_DIR.parent / "evals" / "harness"))

from jev_client import call_jev  # noqa: E402

LOCKFILE = ROUTER_DIR / "thresholds.lockfile.json"


def _load_locked(key: str, default: float) -> float:
    if LOCKFILE.exists():
        data = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        v = data.get("gates", {}).get(key)
        if isinstance(v, (int, float)):
            return float(v)
    return default


TRANSITIONS = ("analysis_to_planning", "planning_to_solutioning",
               "solutioning_to_implementation")

NOUL_THRESHOLDS = {g: _load_locked(f"readiness_{g}", 0.90)
                   for g in ("spec_specific", "requirements_testable", "no_blockers")}
SCORE_THRESHOLD = _load_locked("readiness_score_min", 3.0)  # ready_score levels 0-4

QUESTIONS = {
    "spec_specific": {
        "type": "noul",
        "instructions": "Does the artifact state concrete, specific requirements — named components, expected behavior, and scope — rather than vague goals or background material?",
        "proposition": "The artifact states concrete, specific requirements.",
    },
    "requirements_testable": {
        "type": "noul",
        "instructions": "Are the acceptance criteria verifiable — could a reviewer or automated test objectively confirm each one (given inputs, expected outputs, measurable conditions)?",
        "proposition": "The acceptance criteria are objectively verifiable.",
    },
    "no_blockers": {
        "type": "noul",
        "instructions": "Work that is simply not done yet does NOT count as a blocker. Count only explicit unresolved blocking decisions: TODOs, open either/or choices, or required content that is missing or only referenced but absent. A document that is entirely absent or placeholder counts as a blocker.",
        "proposition": "There are no explicit unresolved blocking decisions.",
    },
    "ready_score": {
        "type": "score",
        "instructions": "Rate the overall readiness of this artifact for the next BMAD phase.",
        "criteria": [
            "0 - not ready: background material, goals, or discussion with no actionable requirements. NOT for: a concrete task list (that is at least 1). Example: a theory overview or 'make it nice and modern'.",
            "1 - weak: some concrete requirements but vague scope, untestable criteria, or open blockers remain. NOT for: artifacts where every criterion could be verified by a test. Example: 'implement CSV export' with a TODO 'stream or buffer?' left open.",
            "2 - partial: mostly concrete and testable, but at least one significant gap (one gate fails, one criterion unmeasurable). Example: clear spec but acceptance criteria say only 'the system should be fast'.",
            "3 - ready: concrete requirements, objectively testable criteria, no open blockers; minor polish still possible. Example: a phase plan with named deliverables and measurable exit criteria, or a story with given/expected behavior and named test cases.",
            "4 - exemplary: concrete, testable, complete, AND edge cases and failure modes explicitly addressed. NOT for: merely solid specs that ignore edge cases. Example: 'empty results yield a header-only CSV; tests cover happy path and empty state'.",
        ],
    },
    "blocker_kind": {
        "type": "choice",
        "instructions": "If any readiness gate failed, classify the primary blocker. If all gates passed, choose none_applicable.",
        "criteria": {
            "scope_vague": "Requirements are vague, generic, or missing scope boundaries",
            "criteria_untestable": "Acceptance criteria cannot be objectively verified",
            "open_questions": "Unresolved blocking decisions or TODOs remain",
            "missing_artifact": "The artifact itself is empty, missing, or not provided",
            "none_applicable": "No gate failed; the artifact is ready to proceed",
            "other": "None of the listed categories fit",
        },
    },
}


def _log(entry: dict) -> None:
    log = ROUTER_DIR.parent / "evals" / "logs" / "bmad_gates.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def check_readiness(artifact_text: str, transition: str = "planning_to_solutioning",
                    log: bool = True, agent_id: str = "default") -> dict:
    """Evaluate one BMAD phase-transition gate. Returns verdict proceed|hold."""
    if transition not in TRANSITIONS:
        raise ValueError(f"unknown transition {transition!r}; use one of {TRANSITIONS}")
    state = (f"BMAD phase transition under review: {transition}\n\n"
             f"Upstream artifact:\n\"\"\"\n{artifact_text}\n\"\"\"")
    t0 = time.monotonic()
    resp = call_jev(QUESTIONS, state)
    a = resp["answers"]

    reasons, gates_failed = [], []
    for gate in ("spec_specific", "requirements_testable", "no_blockers"):
        p = a[gate]["noul"]
        thr = NOUL_THRESHOLDS[gate]
        if p < thr:
            gates_failed.append(gate)
            reasons.append(f"{gate} noul {p:.2f} < {thr}")
    score = a["ready_score"]["score"]
    if score < SCORE_THRESHOLD:
        gates_failed.append("ready_score")
        reasons.append(f"ready_score {score:.2f} < {SCORE_THRESHOLD}")

    verdict = "hold" if gates_failed else "proceed"
    blocker = None
    if verdict == "hold":
        blocker = a["blocker_kind"]["choice"]
        if blocker == "none_applicable":
            blocker = "other"  # gates failed but model saw no listed blocker kind

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "agent_id": agent_id,
        "transition": transition,
        "verdict": verdict,
        "blocker_kind": blocker,
        "gates_failed": gates_failed,
        "reasons": reasons,
        "ready_score": score,
        "answers": a,
        "model_resolved": resp.get("model"),
        "usage": resp.get("usage"),
        "latency_ms": round((time.monotonic() - t0) * 1000, 1),
    }
    if log:
        _log(entry)

    return {
        "transition": transition,
        "verdict": verdict,
        "blocker_kind": blocker,
        "gates_failed": gates_failed,
        "ready_score": score,
        "gate_nouls": {g: a[g]["noul"] for g in
                       ("spec_specific", "requirements_testable", "no_blockers")},
        "reasons": reasons,
        "latency_ms": entry["latency_ms"],
    }


if __name__ == "__main__":
    art = sys.stdin.read().strip() or sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    trans = sys.argv[2] if len(sys.argv) > 2 else "planning_to_solutioning"
    try:
        print(json.dumps(check_readiness(art, trans), indent=2))
    except Exception as e:  # noqa: BLE001 — explicit status, never a traceback (adapter contract)
        print(json.dumps({"status": "unavailable", "reason": str(e)[:300],
                          "decision": "unavailable", "transition": trans}, indent=2))