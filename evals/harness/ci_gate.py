#!/usr/bin/env python3
"""CI regression gate (implementation.md §10 evaluation config, Phase 3).

Runs the golden sets and compares against the committed baseline
(evals/results/baseline.json). Fails (exit 1) on:
  - per-set accuracy drop > ci_regression_threshold (default 0.03)
  - resolved model drift vs the lockfile (§6: re-fit required)
Warns (exit 0, dashboard alerts pick these up per §7.3):
  - ECE > ece_alert_threshold (default 0.05) — calibration drift is an
    alerting signal; hard-fail only with --strict

Usage:
  python3 evals/harness/ci_gate.py                 # run + gate
  python3 evals/harness/ci_gate.py --update-baseline   # refresh baseline
Skips with exit 0 + notice when OPENROUTER_API_KEY is unset (CI without secrets).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_evals  # noqa: E402

RESULTS = HERE.parent / "results"
BASELINE = RESULTS / "baseline.json"
LOCKFILE = HERE.parent.parent / "router" / "thresholds.lockfile.json"

CI_REGRESSION_THRESHOLD = 0.03  # §10
ECE_ALERT_THRESHOLD = 0.05       # §10


def run_all() -> list:
    sets_dir = HERE.parent / "golden-sets"
    set_dirs = sorted(d for d in sets_dir.iterdir()
                      if d.is_dir() and (d / "criteria.json").exists())
    return [run_evals.run_set(d) for d in set_dirs]


def main(argv):
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("CI GATE: SKIP (OPENROUTER_API_KEY not set)")
        return 0

    reports = run_all()
    RESULTS.mkdir(parents=True, exist_ok=True)

    if "--update-baseline" in argv:
        BASELINE.write_text(json.dumps(reports, indent=2), encoding="utf-8")
        print(f"baseline updated: {BASELINE}")
        return 0

    if not BASELINE.exists():
        print("CI GATE: FAIL (no baseline.json — run with --update-baseline first)")
        return 1

    baseline = {r["set"]: r for r in json.loads(BASELINE.read_text())}
    lock = json.loads(LOCKFILE.read_text()) if LOCKFILE.exists() else {}

    failures, warnings = [], []
    for rep in reports:
        name = rep["set"]
        base = baseline.get(name)
        if not base:
            warnings.append(f"{name}: not in baseline (new set)")
            continue
        acc_drop = base["accuracy"] - rep["accuracy"]
        if acc_drop > CI_REGRESSION_THRESHOLD:
            failures.append(f"{name}: accuracy dropped {acc_drop:.3f} "
                            f"({base['accuracy']:.3f} -> {rep['accuracy']:.3f})")
        if rep.get("ece") is not None and rep["ece"] > ECE_ALERT_THRESHOLD:
            (failures if "--strict" in argv else warnings).append(
                f"{name}: ECE {rep['ece']:.3f} > {ECE_ALERT_THRESHOLD}"
                + (" (strict)" if "--strict" in argv else " (alert; see dashboard)"))
        # model drift vs lockfile (§6: re-fit on model change)
        lock_model = lock.get("model_resolved")
        if lock_model and rep.get("model_resolved") and rep["model_resolved"] != lock_model:
            failures.append(f"{name}: model drift {lock_model} -> {rep['model_resolved']} "
                            f"(re-fit thresholds per §6)")
        # run-to-run variance note
        if abs(acc_drop) <= CI_REGRESSION_THRESHOLD:
            print(f"  ok {name}: acc {rep['accuracy']:.3f} "
                  f"(baseline {base['accuracy']:.3f}, delta {-acc_drop:+.3f})")

    for w in warnings:
        print(f"  WARN {w}")
    for f in failures:
        print(f"  FAIL {f}")

    if failures:
        print("CI GATE: FAIL")
        return 1
    print("CI GATE: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))