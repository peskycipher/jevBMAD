"""Metrics for golden-set evals (implementation.md §7.2).

All metrics operate over per-question records:
  {qid, primitive, label, prediction, confidence, correct}
Supports choice (top-1), noul (probability + binary label), score (fractional
vs level), plus calibration (ECE), Brier, and per-confidence-band accuracy.
"""
from __future__ import annotations

from collections import defaultdict

BANDS = [(0.0, 0.75, "low"), (0.75, 0.90, "medium"), (0.90, 1.01, "high")]


def accuracy(records):
    if not records:
        return None
    return sum(r["correct"] for r in records) / len(records)


def brier_score(records):
    """Brier for noul records: (noul_prob - label)^2."""
    recs = [r for r in records if r["primitive"] == "noul"]
    if not recs:
        return None
    return sum((r["prediction"] - r["label"]) ** 2 for r in recs) / len(recs)


def ece(records, n_bins: int = 10):
    """Expected Calibration Error over confidence-scored records."""
    recs = [r for r in records if r.get("confidence") is not None]
    if not recs:
        return None
    bins = defaultdict(lambda: [0.0, 0, 0])  # conf_sum, count, correct
    for r in recs:
        b = min(int(r["confidence"] * n_bins), n_bins - 1)
        acc = r["correct"]
        if r["primitive"] == "noul":
            # calibration of the *probability* for noul: use |label - pred| correctness
            acc = 1.0 - abs(r["prediction"] - r["label"])
        bins[b][0] += r["confidence"]
        bins[b][1] += 1
        bins[b][2] += acc
    total = sum(b[1] for b in bins.values())
    return sum((c / total) * abs((ok / c) - (cs / c))
                for cs, c, ok in bins.values() if c) or 0.0


def band_report(records):
    """Accuracy per confidence band using the §10 starting thresholds."""
    out = {}
    for lo, hi, name in BANDS:
        recs = [r for r in records
                if r.get("confidence") is not None and lo <= r["confidence"] < hi]
        if recs:
            out[name] = {
                "n": len(recs),
                "accuracy": sum(r["correct"] for r in recs) / len(recs),
            }
    return out


def latency_stats(latencies_ms):
    if not latencies_ms:
        return {}
    s = sorted(latencies_ms)

    def pct(p):
        return s[min(int(len(s) * p), len(s) - 1)]

    return {"p50": round(pct(0.50)), "p95": round(pct(0.95)),
            "min": round(s[0]), "max": round(s[-1])}


def score_mae(records):
    """Mean absolute error in levels for score records (fractional vs label)."""
    recs = [r for r in records if r["primitive"] == "score"]
    if not recs:
        return None
    return sum(abs(r["prediction"] - r["label"]) for r in recs) / len(recs)


def other_rate(records):
    """Share of choice predictions that landed on 'other' (should stay low)."""
    recs = [r for r in records if r["primitive"] == "choice"]
    if not recs:
        return None
    return sum(r["prediction"] == "other" for r in recs) / len(recs)