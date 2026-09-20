#!/usr/bin/env python3
"""Memory-contribution ablation (implementation.md §9 Phase 2).

Runs the System-1 router on sample requests twice — with Graft context and
without — and reports decision agreement, confidence deltas, and safety-gate
deltas. Measures whether memory retrieval actually improves routing.

Usage:
  python3 evals/harness/memory_ablation.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "router"))

from router import route  # noqa: E402

REQUESTS = [
    "What does the fit_thresholds script do?",
    "Fix the typo in the eval harness metrics module if there is one.",
    "Add a CLI flag to run_evals.py to filter by priority.",
    "Where is the routing policy implemented and how does escalation work?",
    "Refactor the golden sets into a database.",
    "Update the evals README with the new gate fitter.",
]

RESULTS = Path(__file__).resolve().parent.parent / "results"


def main():
    rows = []
    agree = conf_deltas = safe_deltas = 0
    for req in REQUESTS:
        with_mem = route(req, project_root=str(ROOT), use_memory=True)
        no_mem = route(req, project_root=str(ROOT), use_memory=False)
        agree += with_mem["decision"] == no_mem["decision"]
        conf_deltas += with_mem["intent_confidence"] - no_mem["intent_confidence"]
        safe_deltas += with_mem["safe_noul"] - no_mem["safe_noul"]
        rows.append({
            "request": req,
            "decision_with_memory": with_mem["decision"],
            "decision_without": no_mem["decision"],
            "agree": with_mem["decision"] == no_mem["decision"],
            "conf_with": with_mem["intent_confidence"], "conf_without": no_mem["intent_confidence"],
            "safe_with": with_mem["safe_noul"], "safe_without": no_mem["safe_noul"],
        })
    n = len(REQUESTS)
    report = {
        "ablation": "graft_context_on_vs_off",
        "n_requests": n,
        "decision_agreement": agree / n,
        "mean_confidence_delta": round(conf_deltas / n, 3),
        "mean_safety_noul_delta": round(safe_deltas / n, 3),
        "rows": rows,
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / f"memory-ablation-{__import__('time').strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=2))
    for r in rows:
        print(f"  {'AGREE' if r['agree'] else 'DIVERGE'} conf {r['conf_without']:.2f}->{r['conf_with']:.2f} "
              f"safe {r['safe_without']:.2f}->{r['safe_with']:.2f} | {r['request'][:50]}")
    print(f"report: {out}")


if __name__ == "__main__":
    main()
