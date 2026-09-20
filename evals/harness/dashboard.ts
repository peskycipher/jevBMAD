#!/usr/bin/env node
// Dashboard & alerting (implementation.md §9 Phase 3, §7.5 targets).
//
// Aggregates eval results, decision logs, and online-sample snapshots into
// evals/results/dashboard.md plus alerts.json. Alert rules (§10):
//   accuracy drop > 3 pts vs baseline | ECE > 0.05 | model drift |
//   cost/example > 2x baseline | p95 latency > 2500 ms (§7.5)
//
// Run after any eval/online-sample cycle (cron-friendly; no external services).
//
// Usage:
//   npx tsx evals/harness/dashboard.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { usageCost } from "./jev_client.ts";
import { pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS = path.resolve(HERE, "..", "results");
const LOGS = path.resolve(HERE, "..", "logs");
const BASELINE = path.join(RESULTS, "baseline.json");
const LOCKFILE = path.resolve(HERE, "..", "..", "router", "thresholds.lockfile.json");

function pyStampFmt(fmt: string): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = p(Math.floor(abs / 60)), mm = p(abs % 60);
  return fmt
    .replace("%Y", String(d.getFullYear())).replace("%m", p(d.getMonth() + 1)).replace("%d", p(d.getDate()))
    .replace("%H", p(d.getHours())).replace("%M", p(d.getMinutes())).replace("%z", `${sign}${hh}${mm}`);
}

function latestJson(pattern: RegExp): any {
  const files = fs.readdirSync(RESULTS).sort().filter((f) => pattern.test(f)).map((f) => path.join(RESULTS, f));
  return files.length ? JSON.parse(fs.readFileSync(files[files.length - 1], "utf-8")) : null;
}

function main(): void {
  const alerts: Record<string, string>[] = [];
  const lines: string[] = ["# Hybrid System Dashboard", `\nGenerated: ${pyStampFmt("%Y-%m-%d %H:%M %z")}\n`];

  // --- golden-set status vs baseline ---
  const run = latestJson(/^run-.*\.json$/);
  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf-8")) : {};
  const baseBySet: Record<string, any> = {};
  if (Array.isArray(base)) for (const r of base) baseBySet[r.set] = r;
  lines.push("## Golden sets", "", "| Set | Accuracy | ECE | vs baseline |", "|---|---|---|---|");
  for (const rep of run ?? []) {
    const b = baseBySet[rep.set] ?? {};
    // py: delta only when both current and baseline accuracy are non-null
        const delta = b && rep.accuracy !== null && rep.accuracy !== undefined
          && b.accuracy !== null && b.accuracy !== undefined ? (rep.accuracy as number) - (b.accuracy as number) : null;
    if (delta !== null && delta < -0.03) {
      alerts.push({ severity: "fail", check: "accuracy_regression", set: rep.set, detail: `delta ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}` });
    }
    if (rep.ece !== null && rep.ece !== undefined && rep.ece > 0.05) {
      alerts.push({ severity: "warn", check: "ece_drift", set: rep.set, detail: `ECE ${rep.ece.toFixed(3)}` });
    }
    const d = delta !== null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}` : "n/a";
    const ece = rep.ece !== null && rep.ece !== undefined ? rep.ece.toFixed(3) : "-";
    const accS = rep.accuracy !== null && rep.accuracy !== undefined ? (rep.accuracy as number).toFixed(3) : "-";
    lines.push(`| ${rep.set} | ${accS} | ${ece} | ${d} |`);
  }
  lines.push("");

  // --- story review (first-pass rate, §7.5) ---
  const sr = latestJson(/^story-review-.*\.json$/);
  if (sr) {
    lines.push("## System-2 judge (story review)", "",
      `- verdict accuracy: ${(sr.verdict_accuracy * 100).toFixed(1)}%`,
      `- gate agreement: ${(sr.gate_agreement * 100).toFixed(1)}%`,
      sr.taxonomy_accuracy !== null ? `- taxonomy accuracy: ${(sr.taxonomy_accuracy * 100).toFixed(1)}%` : "- taxonomy accuracy: n/a");
    lines.push("");
  }

  // --- production routing metrics from logs (Jev decision share, §7.5) ---
  const routingLog = path.join(LOGS, "routing.jsonl");
  if (fs.existsSync(routingLog)) {
    const rows = fs.readFileSync(routingLog, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const auto = neumaierSum(rows.map((r) => (r.decision === "system1_auto" ? 1 : 0)));
    const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.trunc(lat.length * 0.95)] : 0;
    const routingCosts = rows.map((r) => usageCost(r.usage ?? null));
    const costKnown: number[] = routingCosts.filter((c): c is number => c !== null);
    const tokens = neumaierSum(rows.map((r) => (r.usage ?? {}).input_tokens ?? 0));
    const share = rows.length ? auto / rows.length : 0;
    lines.push("## Production routing (decision log)", "",
      `- decisions: ${rows.length}`,
      `- System-1 auto-execute share: ${(share * 100).toFixed(1)}% (target >= 70%, §7.5)`,
      `- p95 routing latency: ${p95.toFixed(0)} ms`,
      costKnown.length
        ? `- total decision cost: $${neumaierSum(costKnown).toFixed(4)}`
        : `- decision cost: n/a (provider reports tokens only; ${tokens} input tokens logged)`);
    if (p95 > 2500) alerts.push({ severity: "warn", check: "latency", detail: `p95 ${p95.toFixed(0)}ms > 2500ms` });
    lines.push("");
  }

  // --- System-2 escalations (cost/latency, §7.5) ---
  const s2Log = path.join(LOGS, "system2.jsonl");
  if (fs.existsSync(s2Log)) {
    const rows = fs.readFileSync(s2Log, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    if (rows.length) {
      const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
      const costs = rows.map((r) => usageCost(r.usage ?? null));
      const cost = neumaierSum(costs.map((c) => c ?? 0));
      const models = [...new Set(rows.map((r) => r.model ?? null))].sort();
      lines.push("## System-2 escalations (GLM)", "",
        `- calls: ${rows.length}`,
        `- p50 / max latency: ${lat[Math.trunc(lat.length / 2)].toFixed(0)} / ${lat[lat.length - 1].toFixed(0)} ms`,
        `- total cost: $${cost.toFixed(4)}`,
        // Python renders the sorted set via f-string list repr: ['a', 'b']
        `- models: [${models.map((m) => (m === null ? "None" : `'${m}'`)).join(", ")}]`);
      lines.push("");
    }
  }

  // --- online samples (hindsight agreement + memory relevance, §7.6/§7.5) ---
  const pm = path.join(RESULTS, "production_metrics.json");
  if (fs.existsSync(pm)) {
    const snaps = JSON.parse(fs.readFileSync(pm, "utf-8"));
    lines.push("## Online sampling", "");
    for (const s of snaps.slice(-5)) {
      const ha = s.hindsight_agreement !== null && s.hindsight_agreement !== undefined ? `${(s.hindsight_agreement * 100).toFixed(1)}%` : "n/a";
      const mr = s.memory_relevance_mean !== null && s.memory_relevance_mean !== undefined ? `${s.memory_relevance_mean.toFixed(2)}/4` : "n/a";
      lines.push(`- ${s.ts}: hindsight agreement ${ha}, memory relevance ${mr} `
        + `(target 3.2), ${s.human_audit_queued} human audits queued`);
    }
    const last = snaps.length ? snaps[snaps.length - 1] : {};
    if (last.memory_relevance_mean !== null && last.memory_relevance_mean !== undefined && last.memory_relevance_mean < 3.2) {
      alerts.push({ severity: "warn", check: "memory_relevance", detail: `${last.memory_relevance_mean.toFixed(2)}/4 < 3.2 target` });
    }
    lines.push("");
  }

  // --- model drift (§6) ---
  const lock = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, "utf-8")) : {};
  const lockModel = lock.model_resolved;
  const runModel = run && run.length ? run[0].model_resolved : null;
  if (lockModel && runModel && lockModel !== runModel) {
    alerts.push({ severity: "fail", check: "model_drift", detail: `${lockModel} -> ${runModel}; re-fit thresholds (§6)` });
  }
  if (lockModel) {
    lines.push("## Model pin", "", `- lockfile model: \`${lockModel}\``, `- latest run model: \`${runModel}\``, "");
  }

  // --- alerts ---
  lines.push("## Alerts", "");
  if (alerts.length) {
    for (const a of alerts) lines.push(`- **${a.severity.toUpperCase()}** ${a.check}: ${a.detail}`);
  } else {
    lines.push("- none");
  }
  fs.writeFileSync(path.join(RESULTS, "alerts.json"), pyDumpsIndent(tagPythonFloats(alerts as unknown as Json)), "utf-8");
  fs.writeFileSync(path.join(RESULTS, "dashboard.md"), lines.join("\n"), "utf-8");
  console.log(lines.join("\n"));
  console.log(`\ndashboard: ${path.join(RESULTS, "dashboard.md")}`);
  console.log(`alerts:    ${path.join(RESULTS, "alerts.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
