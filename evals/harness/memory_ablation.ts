#!/usr/bin/env node
// Memory-contribution ablation (implementation.md §9 Phase 2).
//
// Runs the System-1 router on sample requests twice — with Graft context and
// without — and reports decision agreement, confidence deltas, and safety-gate
// deltas. Measures whether memory retrieval actually improves routing.
//
// Usage:
//   npx tsx evals/harness/memory_ablation.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { route } from "../../router/router.ts";
import { pyDumpsIndent, tagPythonFloats, type Json } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const ROOT = path.resolve(HERE, "..", "..");

const REQUESTS = [
  "What does the fit_thresholds script do?",
  "Fix the typo in the eval harness metrics module if there is one.",
  "Add a CLI flag to run_evals.py to filter by priority.",
  "Where is the routing policy implemented and how does escalation work?",
  "Refactor the golden sets into a database.",
  "Update the evals README with the new gate fitter.",
];

const RESULTS = path.resolve(HERE, "..", "results");

const FLOAT_FIELDS = new Set(["decision_agreement", "mean_confidence_delta", "mean_safety_noul_delta",
  "conf_with", "conf_without", "safe_with", "safe_without"]);

async function main(): Promise<void> {
  const rows: Record<string, Json>[] = [];
  let agree = 0, confDeltas = 0, safeDeltas = 0;
  for (const req of REQUESTS) {
    const withMem = await route(req, { projectRoot: ROOT, useMemory: true });
    const noMem = await route(req, { projectRoot: ROOT, useMemory: false });
    agree += withMem.decision === noMem.decision ? 1 : 0;
    confDeltas += (withMem.intent_confidence as number) - (noMem.intent_confidence as number);
    safeDeltas += (withMem.safe_noul as number) - (noMem.safe_noul as number);
    rows.push({
      request: req,
      decision_with_memory: withMem.decision,
      decision_without: noMem.decision,
      agree: withMem.decision === noMem.decision,
      conf_with: withMem.intent_confidence, conf_without: noMem.intent_confidence,
      safe_with: withMem.safe_noul, safe_without: noMem.safe_noul,
    } as unknown as Record<string, Json>);
  }
  const n = REQUESTS.length;
  const report: Record<string, Json> = {
    ablation: "graft_context_on_vs_off",
    n_requests: n,
    decision_agreement: agree / n,
    mean_confidence_delta: (Math.round((confDeltas / n) * 1000) / 1000) as unknown as Json,
    mean_safety_noul_delta: (Math.round((safeDeltas / n) * 1000) / 1000) as unknown as Json,
    rows: rows as unknown as Json,
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const out = path.join(RESULTS,
    `memory-ablation-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`);
  fs.writeFileSync(out, pyDumpsIndent(tagPythonFloats(report as unknown as Json, new Set(), FLOAT_FIELDS)), "utf-8");
  console.log(pyDumpsIndent(tagPythonFloats(Object.fromEntries(Object.entries(report).filter(([k]) => k !== "rows")) as unknown as Json, new Set(), FLOAT_FIELDS)));
  for (const r of rows) {
    console.log(`  ${r.agree ? "AGREE" : "DIVERGE"} conf ${Number(r.conf_without).toFixed(2)}->${Number(r.conf_with).toFixed(2)} `
      + `safe ${Number(r.safe_without).toFixed(2)}->${Number(r.safe_with).toFixed(2)} | ${(r.request as string).slice(0, 50)}`);
  }
  console.log(`report: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
