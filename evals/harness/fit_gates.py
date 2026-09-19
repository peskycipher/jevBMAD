#!/usr/bin/env python3
"""Fit per-gate thresholds for judge.py and bmad_gates.py (§6 methodology).

Reads the latest story-review report (gate nouls + dimensions per example)
and the latest eval run (readiness records), sweeps thresholds, and merges
a "gates" section into router/thresholds.lockfile.json.

Gate fitting: per noul gate, pick the HIGHEST threshold achieving max
accuracy (conservative ties). Dimension cutoff: global 2-10 cutoff
maximizing verdict accuracy given fitted gates.

Usage:
  python3 evals/harness/fit_gates.py
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results"
LOCKFILE = Path(__file__).resolve().parent.parent.parent / "router" / "thresholds.lockfile.json"

GATE_KEYS = ["gate_spec", "gate_no_regression", "gate_security"]
DIM_KEYS = ["dim_correctness", "dim_quality", "dim_tests", "dim_bmad"]


def latest(pattern):
    runs = sorted(glob.glob(str(RESULTS / pattern)))
    return json.loads(Path(runs[-1]).read_text()) if runs else None


def fit_noul_gate(pairs):
    """pairs: [(prob, label01)] -> best (threshold, accuracy). Highest t wins ties."""
    best = None
    for t in [round(0.30 + 0.05 * i, 2) for i in range(14)]:
        acc = sum((p >= t) == bool(l) for p, l in pairs) / len(pairs)
        if best is None or acc > best[1] or (acc == best[1] and t > best[0]):
            best = (t, acc)
    return best


def main():
    out = {}

    # --- judge gates + dimension cutoff (story-review report) ---
    sr = latest("story-review-*.json")
    if sr:
        gates, meta = {}, {}
        for g in GATE_KEYS:
            pairs = [(e["gate_nouls"][g], e["gate_labels"][g]) for e in sr["per_example"]]
            th, acc = fit_noul_gate(pairs)
            gates[f"judge_{g}"] = th
            meta[f"judge_{g}"] = {"gate_accuracy": round(acc, 3), "n": len(pairs)}

        # dimension cutoff: sweep with fitted gates applied
        def verdict(e, t_gates, c):
            gates_pass = all(e["gate_nouls"][g] >= t_gates[g] for g in GATE_KEYS)
            dims_pass = all(e["dimensions"][d] >= c for d in DIM_KEYS)
            got = "first_pass" if (gates_pass and dims_pass) else "rework"
            return got == e["expected"]

        t_gates = {g: gates[f"judge_{g}"] for g in GATE_KEYS}
        best_c = None
        for c in [round(5.0 + 0.25 * i, 2) for i in range(13)]:
            acc = sum(verdict(e, t_gates, c) for e in sr["per_example"]) / len(sr["per_example"])
            if best_c is None or acc > best_c[1] or (acc == best_c[1] and c < best_c[0]):
                best_c = (c, acc)
        gates["judge_dim_min"] = best_c[0]
        meta["judge_dim_min"] = {"simulated_verdict_accuracy": round(best_c[1], 3),
                                 "note": "2-10 scale; pass requires dimension >= cutoff"}
        out.update(gates)

    # --- readiness gates (latest run with readiness records) ---
    run = None
    for p in reversed(sorted(glob.glob(str(RESULTS / "run-*.json")))):
        data = json.loads(Path(p).read_text())
        if any(r.get("set") == "readiness" for r in data):
            run = data
            break
    if run:
        recs = [r for r in run if r["set"] == "readiness" for r in r.get("records", [])]
        for g in ("spec_specific", "requirements_testable", "no_blockers"):
            pairs = [(r["prediction"], r["label"]) for r in recs
                     if r["qid"] == g and r["primitive"] == "noul"]
            if pairs:
                th, acc = fit_noul_gate(pairs)
                out[f"readiness_{g}"] = th
                meta.setdefault("readiness", {})[g] = {"gate_accuracy": round(acc, 3), "n": len(pairs)}
        sc = [r for r in recs if r["qid"] == "ready_score"]
        if sc:
            pairs = [(r["prediction"], r["label"]) for r in sc]
            mae = sum(abs(p - l) for p, l in pairs) / len(pairs)
            meta.setdefault("readiness", {})["ready_score"] = {"score_mae_levels": round(mae, 2)}
            # fit score cutoff: expected verdict = proceed iff all gate labels 1 AND score label >= 3
            by_id = {}
            for r in recs:
                by_id.setdefault(r.get("qid"), r)
            # reconstruct verdict accuracy over score cutoff using gate thresholds
            ids = [r.get("id") for r in sc]

    # --- merge into lockfile ---
    lock = json.loads(LOCKFILE.read_text()) if LOCKFILE.exists() else {}
    lock["gates"] = out
    lock["gates_meta"] = meta
    LOCKFILE.write_text(json.dumps(lock, indent=2) + "\n")
    print(json.dumps(out, indent=2))
    print(f"lockfile: {LOCKFILE}")


if __name__ == "__main__":
    main()