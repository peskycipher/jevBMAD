"""Fit routing thresholds from golden-set eval runs (implementation.md §6).

Reads eval result reports (with per-record details) from evals/results/,
sweeps candidate thresholds, and writes router/thresholds.lockfile.json.

Policy: locked threshold = strictest of (fitted, default) — conservative
(§11: "Start conservative; expand via online sampling"). Status is
'provisional' until the golden set has >= min_examples (§10: 100).

Usage:
  python3 evals/harness/fit_thresholds.py            # latest run in results/
  python3 evals/harness/fit_thresholds.py results/run-<stamp>.json
"""
from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
LOCKFILE = Path(__file__).resolve().parent.parent.parent / "router" / "thresholds.lockfile.json"

TARGET_AUTO_ACC = 0.95   # accuracy required among auto-executed examples
MIN_EXAMPLES = 100        # §10 calibration.min_labeled_examples
DEFAULTS = {"intent_conf_min": 0.75, "safe_noul_escalate": 0.50,
            "safe_noul_clean": 0.75, "complexity_max": 1.5}


def sweep_confidence(recs, target=TARGET_AUTO_ACC):
    """Choice: pick the lowest confidence threshold whose auto-band accuracy
    still meets target (maximizes auto-rate under the accuracy constraint)."""
    best = None
    for t in [0.50 + 0.05 * i for i in range(10)]:
        auto = [r for r in recs if r["confidence"] >= t]
        if len(auto) < max(3, 0.2 * len(recs)):
            continue  # need meaningful support
        acc = sum(r["correct"] for r in auto) / len(auto)
        if acc >= target and (best is None or t < best[0]):
            best = (t, acc, len(auto))
    return best


def sweep_noul(recs, target=TARGET_AUTO_ACC):
    """Noul: lowest probability threshold for 'safe' with accuracy >= target."""
    best = None
    for t in [0.50 + 0.05 * i for i in range(10)]:
        auto = [r for r in recs if r["prediction"] >= t]
        if len(auto) < max(3, 0.2 * len(recs)):
            continue
        acc = sum(r["correct"] for r in auto) / len(auto)
        if acc >= target and (best is None or t < best[0]):
            best = (t, acc, len(auto))
    return best


def sweep_score(recs, target=TARGET_AUTO_ACC):
    """Score: highest complexity cutoff whose auto-band accuracy meets target.
    Underestimating complexity is the error mode we guard against."""
    best = None
    for c in [0.5 + 0.25 * i for i in range(13)]:
        auto = [r for r in recs if r["prediction"] <= c]
        if len(auto) < max(3, 0.2 * len(recs)):
            continue
        acc = sum(r["correct"] for r in auto) / len(auto)
        if acc >= target and (best is None or c > best[0]):
            best = (c, acc, len(auto))
    return best


def main(argv):
    if len(argv) > 1:
        report_path = Path(argv[1])
    else:
        runs = sorted(glob.glob(str(RESULTS_DIR / "run-*.json")))
        if not runs:
            sys.exit("no eval runs found in evals/results/ — run run_evals.py first")
        report_path = Path(runs[-1])

    reports = json.loads(report_path.read_text(encoding="utf-8"))
    by_set = {}
    for rep in reports:
        recs = rep.get("records", [])
        if recs:
            by_set[rep["set"]] = recs

    if not any(by_set.values()):
        sys.exit(f"{report_path} has no per-record details — re-run run_evals.py")

    fitted = {}
    sweepers = {
        "routing": ("intent_conf_min", sweep_confidence),
        "guardrails": ("safe_noul_escalate", sweep_noul),
        "complexity": ("complexity_max", sweep_score),
    }
    for set_name, (key, fn) in sweepers.items():
        recs = by_set.get(set_name, [])
        result = fn(recs) if recs else None
        if result:
            t, acc, n = result
            fitted[key] = {"fitted": round(t, 2), "auto_acc": round(acc, 3),
                           "n_auto": n, "n_total": len(recs)}
        else:
            fitted[key] = {"fitted": None, "note": "no threshold met target; keep default",
                           "n_total": len(recs)}

    # Locked = strictest of fitted vs default (auto-execute requires MORE evidence)
    # safe_noul_clean has no sweep (tiered policy, §14.2): always the default.
    locked = {}
    for key, default in DEFAULTS.items():
        f = fitted.get(key, {}).get("fitted")
        if f is None:
            locked[key] = default
            continue
        if key == "complexity_max":
            locked[key] = round(min(f, default), 2)  # stricter = lower cap
        else:
            locked[key] = round(max(f, default), 2)  # stricter = higher threshold

    n_total = sum(fitted[sweepers[s][0]]["n_total"] for s in sweepers)
    # Preserve sections written by other fitters (fit_gates.py writes
    # "gates"/"gates_meta") — this script owns the routing thresholds only.
    previous = json.loads(LOCKFILE.read_text()) if LOCKFILE.exists() else {}
    out = {
        "source_run": str(report_path),
        "target_auto_band_accuracy": TARGET_AUTO_ACC,
        "status": "provisional" if n_total < MIN_EXAMPLES else "candidate-final",
        "min_examples_required": MIN_EXAMPLES,
        "n_examples_total": n_total,
        "model_resolved": reports[0].get("model_resolved"),
        "fitted": fitted,
        "locked": locked,
        "note": "strictest of fitted vs §10 defaults; re-fit when model version changes (§6)",
        "bands_note": ("safe_noul tiered policy (§14.2): <safe_noul_escalate escalate, "
                       "[escalate, safe_noul_clean) auto+flag (audit sampling pool), "
                       ">= safe_noul_clean clean auto; high-stakes keyword traffic still "
                       "forces System 2 via the keyword gate"),
    }
    for section in ("gates", "gates_meta"):
        if section in previous:
            out[section] = previous[section]
    LOCKFILE.parent.mkdir(parents=True, exist_ok=True)
    LOCKFILE.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out, indent=2))
    print(f"\nlockfile: {LOCKFILE}")


if __name__ == "__main__":
    main(sys.argv)