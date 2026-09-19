#!/usr/bin/env python3
"""End-to-end BMAD story-review eval (implementation.md §9 Phase 2).

Runs the §7.7 judge over the story_review golden set and reports:
  - first-pass rate accuracy (judge verdict vs expected_verdict)
  - failure-taxonomy accuracy (failure_kind vs label, on reworks)
  - gate-level agreement (3 nouls)

Usage:
  python3 evals/harness/run_story_review.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "router"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from judge import GATE_THRESHOLD, judge  # noqa: E402

GOLDEN = Path(__file__).resolve().parent.parent / "golden-sets" / "story_review" / "story_review.golden.jsonl"
RESULTS = Path(__file__).resolve().parent.parent / "results"


def main():
    examples = [json.loads(l) for l in GOLDEN.read_text().splitlines() if l.strip()]
    verdict_ok = taxonomy_ok = taxonomy_n = 0
    gate_hits = gate_n = 0
    per_example = []
    for ex in examples:
        res = judge(ex["story"], ex["implementation"])
        v_ok = res["verdict"] == ex["expected_verdict"]
        verdict_ok += v_ok
        if ex["expected_verdict"] == "rework":
            taxonomy_n += 1
            taxonomy_ok += res["failure_kind"] == ex["labels"]["failure_kind"]
        for g in ("gate_spec", "gate_no_regression", "gate_security"):
            gate_n += 1
            pred_safe = res["gate_nouls"][g] >= GATE_THRESHOLD
            gate_hits += pred_safe == bool(ex["labels"][g])
        per_example.append({"id": ex["id"], "expected": ex["expected_verdict"],
                            "got": res["verdict"], "ok": v_ok,
                            "failure_kind": res["failure_kind"],
                            "gate_nouls": res["gate_nouls"],
                            "gate_labels": {g: ex["labels"][g] for g in
                                            ("gate_spec", "gate_no_regression", "gate_security")},
                            "dimensions": res["dimensions"]})

    report = {
        "set": "story_review",
        "n_examples": len(examples),
        "verdict_accuracy": verdict_ok / len(examples),
        "taxonomy_accuracy": (taxonomy_ok / taxonomy_n) if taxonomy_n else None,
        "gate_agreement": gate_hits / gate_n,
        "per_example": per_example,
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / f"story-review-{__import__('time').strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "per_example"}, indent=2))
    for p in per_example:
        mark = "ok " if p["ok"] else "MISS"
        print(f"  [{mark}] {p['id']}: expected={p['expected']} got={p['got']} kind={p['failure_kind']}")
    print(f"report: {out}")


if __name__ == "__main__":
    main()