#!/usr/bin/env python3
"""Online sampling pipeline (implementation.md §7.3 asset 3, §7.6).

Continuously evaluates production routing decisions from the decision logs:

  1. Sample `online_sample_rate` of routing decisions (§10: 5%).
  2. Jev-as-judge hindsight review (§7.6 "routing overrides" row): a fresh
     Noul question — "was the System-1 decision correct in hindsight?" —
     judged from the request, decision, and reasons.
  3. Route ~3% (min 1) of the judged samples to the human audit queue
     (§10 judging config), deduplicated across runs.
  4. Memory relevance loop (§7.2/§7.5): Score the Graft context relevance of
     sampled memory-backed decisions (target >= 80% => >= 3.2 on a 0-4 scale).
  5. Append a dated snapshot to production_metrics.json for drift tracking.

Usage:
  python3 evals/harness/online_sample.py [log.jsonl] [--rate 0.05]
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "router"))

from jev_client import call_jev  # noqa: E402

RESULTS = HERE.parent / "results"
AUDIT = HERE.parent / "audit"
DEFAULT_LOG = HERE.parent / "logs" / "routing.jsonl"

HINDSIGHT_QUESTIONS = {
    "decision_correct": {
        "type": "noul",
        "instructions": "Given the user request, the routing decision made, and the reasons recorded, was the decision the correct call? Judge the reasoning against the request.",
        "proposition": "The routing decision was correct for this request.",
    },
    "failure_kind": {
        "type": "choice",
        "instructions": "If the decision was wrong, classify the primary routing error. If correct, choose none_applicable.",
        "criteria": {
            "over_escalation": "A simple request was sent to System 2 unnecessarily",
            "under_escalation": "A risky or complex request was auto-executed",
            "wrong_intent": "The request was misunderstood or misclassified",
            "threshold_miscalibrated": "The decision was right in kind but the thresholds fired wrongly",
            "none_applicable": "The decision was correct",
            "other": "None of the listed categories fit",
        },
    },
}

MEMORY_RELEVANCE_QUESTIONS = {
    "context_relevance": {
        "type": "score",
        "instructions": "Rate how relevant the retrieved project context is to answering the request (0-4).",
        "criteria": [
            "0 - irrelevant: context has nothing to do with the request",
            "1 - barely relevant: a passing mention at most",
            "2 - partially relevant: touches the same area but misses the point",
            "3 - relevant: directly informs the request",
            "4 - essential: the request cannot be answered well without it",
        ],
    }
}


def hindsight(review_text: str) -> dict:
    resp = call_jev(HINDSIGHT_QUESTIONS,
                    f"Routing decision review:\n\"\"\"\n{review_text}\n\"\"\"")
    a = resp["answers"]
    correct = a["decision_correct"]["noul"] >= 0.5
    kind = a["failure_kind"]["choice"] if not correct else None
    return {"correct": correct, "noul": a["decision_correct"]["noul"],
            "failure_kind": kind}


def relevance(request: str, context: str) -> float:
    state = f"User request:\n{request}\n\nRetrieved project context:\n\"\"\"\n{context[:3000]}\n\"\"\""
    resp = call_jev(MEMORY_RELEVANCE_QUESTIONS, state)
    return resp["answers"]["context_relevance"]["score"]


def main(argv):
    log_path = Path(argv[1]) if len(argv) > 1 and not argv[1].startswith("--") else DEFAULT_LOG
    rate = 0.05
    if "--rate" in argv:
        rate = float(argv[argv.index("--rate") + 1])
    # Sampling seed: random per run so continuous sampling eventually covers the
    # whole log; pass --seed 42 for a reproducible sample. Recorded in the snapshot.
    seed_arg = int(argv[argv.index("--seed") + 1]) if "--seed" in argv else None
    seed = seed_arg if seed_arg is not None else int(time.time())

    entries = [json.loads(l) for l in log_path.read_text().splitlines() if l.strip()]
    sample = random.Random(seed).sample(entries, max(1, int(len(entries) * rate))) if entries else []

    judged = []
    for e in sample:
        review = (f"Request: {e['request']}\nDecision: {e['decision']}\n"
                  f"Needs review flag: {e.get('needs_review')}\n"
                  f"Intent: {e['intent']['choice']} (confidence {e['intent']['confidence']})\n"
                  f"Safety noul: {e['safe_auto']['noul']}\n"
                  f"Complexity score: {e['complexity']['score']}\n"
                  f"Reasons: {e['reasons']}")
        h = hindsight(review)
        row = {"ts": e["ts"], "request": e["request"], "decision": e["decision"],
               "jev_hindsight_correct": h["correct"], "hindsight_noul": h["noul"],
               "failure_kind": h["failure_kind"]}
        judged.append(row)

    # memory relevance on memory-backed samples
    relevance_scores = []
    for e in sample:
        excerpt = e.get("memory", {}).get("graft_excerpt", "")
        if excerpt:
            try:
                relevance_scores.append(relevance(e["request"], excerpt))
            except Exception:  # noqa: BLE001
                pass

    # ~3% of the SAMPLE (not the log — the sample is what was judged), min 1
    # (§10 judging config); drawn randomly, not the first N.
    human_audit_n = max(1, round(len(sample) * 0.03)) if sample else 0
    audit_rows = (random.Random(seed).sample(judged, min(human_audit_n, len(judged)))
                  if judged and human_audit_n else [])

    AUDIT.mkdir(parents=True, exist_ok=True)
    q = AUDIT / "human_audit_queue.jsonl"
    existing_audit = set()
    if q.exists():
        for l in q.read_text().splitlines():
            if l.strip():
                prev = json.loads(l)
                existing_audit.add((prev.get("ts"), prev.get("request")))
    with open(q, "a", encoding="utf-8") as f:
        n_queued = 0
        for r in audit_rows:
            if (r.get("ts"), r.get("request")) in existing_audit:
                continue  # already queued by a previous run — never duplicate
            f.write(json.dumps({**r, "audit": "confirm_or_reject_routing"}) + "\n")
            n_queued += 1

    snapshot = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "log": str(log_path),
        "log_size": len(entries),
        "sample_rate": rate,
        "sample_seed": seed,
        "n_sampled": len(sample),
        "hindsight_agreement": (sum(r["jev_hindsight_correct"] for r in judged) / len(judged))
                               if judged else None,
        "human_audit_queued": n_queued,
        "memory_relevance_mean": (sum(relevance_scores) / len(relevance_scores))
                                  if relevance_scores else None,
        "memory_relevance_target": 3.2,  # 80% of 0-4 scale (§7.5)
    }

    metrics_path = RESULTS / "production_metrics.json"
    metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else []
    metrics.append(snapshot)
    RESULTS.mkdir(parents=True, exist_ok=True)
    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(json.dumps(snapshot, indent=2))
    print(f"audit queue: {q} (+{n_queued} rows, {len(audit_rows)} selected)")


if __name__ == "__main__":
    main(sys.argv)