#!/usr/bin/env python3
"""Golden-set eval runner (implementation.md §7.3 asset #2).

Usage:
  python3 evals/harness/run_evals.py evals/golden-sets/routing
  python3 evals/harness/run_evals.py evals/golden-sets        # all sets

Loads criteria.json + *.golden.jsonl, runs each example through the Jev
Decisions API, scores against labels, writes a report to evals/results/.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import metrics as M  # noqa: E402
from jev_client import call_jev, usage_cost  # noqa: E402

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"


def load_set(set_dir: Path):
    criteria = json.loads((set_dir / "criteria.json").read_text(encoding="utf-8"))
    golden = []
    for line in (set_dir / f"{set_dir.name}.golden.jsonl").read_text(
            encoding="utf-8").splitlines():
        if line.strip():
            golden.append(json.loads(line))
    return criteria, golden


def score_record(qid: str, qdef: dict, answer: dict, label, ex_id: str = ""):
    """Normalize one answer into a metrics record."""
    p = qdef["type"]
    if p == "noul":
        pred = answer["noul"]
        correct = (pred >= 0.5) == bool(label)
    elif p == "choice":
        pred = answer["choice"]
        correct = pred == label
    else:  # score: nearest legend level vs integer label
        pred = answer["score"]  # already 0..n_levels-1
        # half-up (Python's round() would send .5 ties to the even level)
        correct = math.floor(pred + 0.5) == label
    return {
        "id": ex_id, "qid": qid, "primitive": p, "label": label,
        "prediction": pred, "confidence": answer.get("confidence"),
        "correct": correct,
    }


def run_set(set_dir: Path) -> dict:
    criteria, golden = load_set(set_dir)
    records, latencies, costs = [], [], []
    n_err = 0
    for ex in golden:
        t0 = time.monotonic()
        try:
            resp = call_jev(criteria["questions"], ex["state"])
        except Exception as e:  # noqa: BLE001
            n_err += 1
            print(f"  [error] {ex['id']}: {e}", file=sys.stderr)
            continue
        latencies.append((time.monotonic() - t0) * 1000)
        costs.append(usage_cost(resp.get("usage")))
        for qid, label in ex["labels"].items():
            if qid not in resp.get("answers", {}):
                n_err += 1
                continue
            records.append(score_record(
                qid, criteria["questions"][qid], resp["answers"][qid], label, ex.get("id", "")))

    report = {
        "set": set_dir.name,
        "records": records,  # per-example details (used by fit_thresholds.py)
        "n_examples": len(golden),
        "n_records": len(records),
        "n_errors": n_err,
        # model_resolved = the logical pinned snapshot (§6, provider-
        # independent); model_echo = what the provider actually served
        # (drift-detection signal, alerted by ci_gate).
        "model_resolved": (resp.get("model_requested") or resp.get("model")) if records else None,
        "model_echo": resp.get("model"),
        "accuracy": M.accuracy(records),
        "ece": M.ece(records),
        "brier": M.brier_score(records),
        "score_mae": M.score_mae(records),
        "other_rate": M.other_rate(records),
        "bands": M.band_report(records),
        "latency_ms": M.latency_stats(latencies),
        # Provider-reported cost only; None (never 0.0) when the provider
        # reports token counts without a price (the Jev API does not).
        "cost_total_usd": (round(sum(c for c in costs if c is not None), 8)
                           if any(c is not None for c in costs) else None),
        "cost_per_example_usd": (round(sum(c for c in costs if c is not None) / len(costs), 8)
                                 if any(c is not None for c in costs) else None),
    }
    return report


def main(argv):
    target = Path(argv[1]) if len(argv) > 1 else Path("evals/golden-sets")
    set_dirs = ([target] if (target / "criteria.json").exists()
               else sorted(d for d in target.iterdir()
                            if d.is_dir() and (d / "criteria.json").exists()))
    if not set_dirs:
        sys.exit(f"no golden sets under {target}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    all_reports = []
    for d in set_dirs:
        print(f"== {d.name} ==")
        rep = run_set(d)
        all_reports.append(rep)
        print(json.dumps(rep, indent=2))

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = RESULTS_DIR / f"run-{stamp}.json"
    out.write_text(json.dumps(all_reports, indent=2), encoding="utf-8")
    print(f"\nreport: {out}")


if __name__ == "__main__":
    main(sys.argv)