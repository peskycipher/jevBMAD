#!/usr/bin/env python3
"""Dashboard & alerting (implementation.md §9 Phase 3, §7.5 targets).

Aggregates eval results, decision logs, and online-sample snapshots into
evals/results/dashboard.md plus alerts.json. Alert rules (§10):
  accuracy drop > 3 pts vs baseline | ECE > 0.05 | model drift |
  cost/example > 2x baseline | p95 latency > 2500 ms (§7.5)

Run after any eval/online-sample cycle (cron-friendly; no external services).

Usage:
  python3 evals/harness/dashboard.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from jev_client import usage_cost  # noqa: E402

RESULTS = HERE.parent / "results"
LOGS = HERE.parent / "logs"
BASELINE = RESULTS / "baseline.json"
LOCKFILE = HERE.parent.parent / "router" / "thresholds.lockfile.json"


def latest_json(pattern):
    files = sorted(RESULTS.glob(pattern))
    return json.loads(files[-1].read_text()) if files else None


def main():
    alerts = []
    lines = ["# Hybrid System Dashboard", f"\nGenerated: {time.strftime('%Y-%m-%d %H:%M %z')}\n"]

    # --- golden-set status vs baseline ---
    run = latest_json("run-*.json")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    base_by_set = {r["set"]: r for r in base} if base else {}
    lines += ["## Golden sets", "", "| Set | Accuracy | ECE | vs baseline |", "|---|---|---|---|"]
    for rep in (run or []):
        b = base_by_set.get(rep["set"], {})
        b_acc = b.get("accuracy")
        delta = ((rep["accuracy"] - b_acc)
                 if (b and rep["accuracy"] is not None and b_acc is not None) else None)
        if delta is not None and delta < -0.03:
            alerts.append({"severity": "fail", "check": "accuracy_regression",
                           "set": rep["set"], "detail": f"delta {delta:+.3f}"})
        if rep.get("ece") is not None and rep["ece"] > 0.05:
            alerts.append({"severity": "warn", "check": "ece_drift",
                           "set": rep["set"], "detail": f"ECE {rep['ece']:.3f}"})
        d = f"{delta:+.3f}" if delta is not None else "n/a"
        ece = f"{rep['ece']:.3f}" if rep.get("ece") is not None else "-"
        acc_s = f"{rep['accuracy']:.3f}" if rep["accuracy"] is not None else "-"
        lines.append(f"| {rep['set']} | {acc_s} | {ece} | {d} |")
    lines.append("")

    # --- story review (first-pass rate, §7.5) ---
    sr = latest_json("story-review-*.json")
    if sr:
        lines += ["## System-2 judge (story review)", "",
                  f"- verdict accuracy: {sr['verdict_accuracy']:.1%}",
                  f"- gate agreement: {sr['gate_agreement']:.1%}",
                  f"- taxonomy accuracy: {sr['taxonomy_accuracy']:.1%}" if sr["taxonomy_accuracy"] is not None else "- taxonomy accuracy: n/a"]
        lines.append("")

    # --- production routing metrics from logs (Jev decision share, §7.5) ---
    routing_log = LOGS / "routing.jsonl"
    if routing_log.exists():
        rows = [json.loads(l) for l in routing_log.read_text().splitlines() if l.strip()]
        auto = sum(r["decision"] == "system1_auto" for r in rows)
        lat = sorted(r["latency_ms"] for r in rows)
        p95 = lat[int(len(lat) * 0.95)] if lat else 0
        routing_costs = [usage_cost(r.get("usage")) for r in rows]
        cost_known = [c for c in routing_costs if c is not None]
        tokens = sum((r.get("usage") or {}).get("input_tokens", 0) for r in rows)
        share = auto / len(rows) if rows else 0
        lines += ["## Production routing (decision log)", "",
                  f"- decisions: {len(rows)}",
                  f"- System-1 auto-execute share: {share:.1%} (target >= 70%, §7.5)",
                  f"- p95 routing latency: {p95:.0f} ms",
                  (f"- total decision cost: ${sum(cost_known):.4f}"
                   if cost_known else
                   f"- decision cost: n/a (provider reports tokens only; {tokens} input tokens logged)")]
        if p95 > 2500:
            alerts.append({"severity": "warn", "check": "latency", "detail": f"p95 {p95:.0f}ms > 2500ms"})
        lines.append("")

    # --- System-2 escalations (cost/latency, §7.5) ---
    s2_log = LOGS / "system2.jsonl"
    if s2_log.exists():
        rows = [json.loads(l) for l in s2_log.read_text().splitlines() if l.strip()]
        if rows:
            lat = sorted(r["latency_ms"] for r in rows)
            costs = [usage_cost(r.get("usage")) for r in rows]
            cost = sum(c for c in costs if c is not None)
            lines += ["## System-2 escalations (GLM)", "",
                      f"- calls: {len(rows)}",
                      f"- p50 / max latency: {lat[len(lat)//2]:.0f} / {lat[-1]:.0f} ms",
                      f"- total cost: ${cost:.4f}",
                      f"- models: {sorted({r.get('model') for r in rows})}"]
            lines.append("")

    # --- online samples (hindsight agreement + memory relevance, §7.6/§7.5) ---
    pm = RESULTS / "production_metrics.json"
    if pm.exists():
        snaps = json.loads(pm.read_text())
        lines += ["## Online sampling", ""]
        for s in snaps[-5:]:
            ha = f"{s['hindsight_agreement']:.1%}" if s.get("hindsight_agreement") is not None else "n/a"
            mr = (f"{s['memory_relevance_mean']:.2f}/4" if s.get("memory_relevance_mean") is not None
                  else "n/a")
            lines.append(f"- {s['ts']}: hindsight agreement {ha}, memory relevance {mr} "
                         f"(target 3.2), {s['human_audit_queued']} human audits queued")
        last = snaps[-1] if snaps else {}
        if last.get("memory_relevance_mean") is not None and last["memory_relevance_mean"] < 3.2:
            alerts.append({"severity": "warn", "check": "memory_relevance",
                           "detail": f"{last['memory_relevance_mean']:.2f}/4 < 3.2 target"})
        lines.append("")

    # --- model drift (§6) ---
    lock = json.loads(LOCKFILE.read_text()) if LOCKFILE.exists() else {}
    lock_model = lock.get("model_resolved")
    run_model = run[0].get("model_resolved") if run else None
    if lock_model and run_model and lock_model != run_model:
        alerts.append({"severity": "fail", "check": "model_drift",
                       "detail": f"{lock_model} -> {run_model}; re-fit thresholds (§6)"})
    if lock_model:
        lines += ["## Model pin", "", f"- lockfile model: `{lock_model}`",
                  f"- latest run model: `{run_model}`", ""]

    # --- alerts ---
    lines += ["## Alerts", ""]
    if alerts:
        for a in alerts:
            lines.append(f"- **{a['severity'].upper()}** {a['check']}: {a['detail']}")
    else:
        lines.append("- none")
    (RESULTS / "alerts.json").write_text(json.dumps(alerts, indent=2), encoding="utf-8")
    (RESULTS / "dashboard.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\ndashboard: {RESULTS / 'dashboard.md'}")
    print(f"alerts:    {RESULTS / 'alerts.json'}")


if __name__ == "__main__":
    main()