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
# jev_client.py ships beside this script

from jev_client import call_jev, JevError  # noqa: E402

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
        "instructions": "Does the artifact state concrete, specific requirements \u2014 named components, expected behavior, and scope \u2014 rather than vague goals or background material?",
        "proposition": "The artifact states concrete, specific requirements.",
        "criteria": {
                "true": {
                        "what": "Named components, expected behavior, and explicit scope",
                        "examples": [
                                "Add /health returning 200; test in tests/test_health.py"
                        ]
                },
                "false": {
                        "what": "Vague goals or background material with no actionable requirements",
                        "examples": [
                                "Make the dashboard nicer and faster"
                        ]
                }
        }
},
    "requirements_testable": {
        "type": "noul",
        "instructions": "Are the acceptance criteria verifiable \u2014 could a reviewer or automated test objectively confirm each one (given inputs, expected outputs, measurable conditions)?",
        "proposition": "The acceptance criteria are objectively verifiable.",
        "criteria": {
                "true": {
                        "what": "Each criterion objectively confirmable: given inputs, expected outputs, measurable conditions",
                        "examples": [
                                "returns 200 within 500ms for /health"
                        ]
                },
                "false": {
                        "what": "Subjective or unverifiable criteria",
                        "examples": [
                                "the system should feel fast",
                                "improve UX"
                        ]
                }
        }
},
    "no_blockers": {
        "type": "noul",
        "instructions": "Work that is simply not done yet does NOT count as a blocker. Count only explicit unresolved blocking decisions: TODOs, open either/or choices, or required content that is missing or only referenced but absent. A document that is entirely absent or placeholder counts as a blocker.",
        "proposition": "There are no explicit unresolved blocking decisions.",
        "criteria": {
                "true": {
                        "what": "No explicit unresolved blocking decisions",
                        "examples": [
                                "All either/or choices already decided"
                        ]
                },
                "false": {
                        "what": "Open TODOs, either/or choices, or missing required content",
                        "examples": [
                                "TODO: stream or buffer?",
                                "auth module not yet written"
                        ]
                }
        }
},
    "ready_score": {
        "type": "score",
        "instructions": "Rate the overall readiness of this artifact for the next BMAD phase.",
        "criteria": [
                {
                        "summary": "0 - not ready",
                        "signals": [
                                "background material, goals, or discussion with no actionable requirements",
                                "NOT for: a concrete task list (that is at least 1)"
                        ],
                        "examples": [
                                "a theory overview or 'make it nice and modern'"
                        ]
                },
                {
                        "summary": "1 - weak",
                        "signals": [
                                "some concrete requirements but vague scope, untestable criteria, or open blockers remain",
                                "NOT for: artifacts where every criterion could be verified by a test"
                        ],
                        "examples": [
                                "'implement CSV export' with a TODO 'stream or buffer?' left open"
                        ]
                },
                {
                        "summary": "2 - partial",
                        "signals": [
                                "mostly concrete and testable, but at least one significant gap (one gate fails, one criterion unmeasurable)"
                        ],
                        "examples": [
                                "clear spec but acceptance criteria say only 'the system should be fast'"
                        ]
                },
                {
                        "summary": "3 - ready",
                        "signals": [
                                "concrete requirements, objectively testable criteria, no open blockers; minor polish still possible"
                        ],
                        "examples": [
                                "a phase plan with named deliverables and measurable exit criteria, or a story with given/expected behavior and named test cases"
                        ]
                },
                {
                        "summary": "4 - exemplary",
                        "signals": [
                                "concrete, testable, complete, AND edge cases and failure modes explicitly addressed",
                                "NOT for: merely solid specs that ignore edge cases"
                        ],
                        "examples": [
                                "'empty results yield a header-only CSV; tests cover happy path and empty state'"
                        ]
                }
        ]
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
    def _degrade(reason_kind: str, reason: str) -> None:
        """Defined unavailable status — JSON, never a traceback (adapter contract)."""
        try:
            print(json.dumps({"status": "unavailable", "reason_kind": reason_kind,
                              "reason": reason[:300], "decision": "unavailable",
                              "transition": trans}, indent=2))
        except BrokenPipeError:
            pass

    trans = sys.argv[2] if len(sys.argv) > 2 else "planning_to_solutioning"
    try:
        stdin = sys.stdin
        art = "" if (stdin is None or stdin.isatty()) else stdin.read().strip()
        if not art and len(sys.argv) > 1:
            art = sys.argv[1]
        if not art:
            print(json.dumps({"status": "bad_request", "reason_kind": "usage",
                              "reason": "empty artifact: pass text via stdin or argv[1]",
                              "transition": trans}, indent=2))
            raise SystemExit(2)
        print(json.dumps(check_readiness(art, trans), indent=2))
    except JevError as e:
        _degrade("missing_api_key" if "API_KEY" in str(e).upper() else "provider_error",
                 str(e))
    except Exception as e:  # noqa: BLE001 — graceful degradation: JSON, never a traceback
        _degrade("internal_error", f"{type(e).__name__}: {e}")
