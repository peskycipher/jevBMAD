#!/usr/bin/env node
// End-to-end BMAD story-review eval (implementation.md §9 Phase 2).
//
// Runs the §7.7 judge over the story_review golden set and reports:
//   - first-pass rate accuracy (judge verdict vs expected_verdict)
//   - failure-taxonomy accuracy (failure_kind vs label, on reworks)
//   - gate-level agreement (3 nouls)
//
// Usage:
//   npx tsx evals/harness/run_story_review.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { GATE_THRESHOLDS, judge } from "../../router/judge.ts";
import { pyDumpsIndent, tagPythonFloats, type Json } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
// PyFloat-tagged values (from judge()) unwrap to plain numbers for comparisons
const un = (v: unknown): number =>
  v !== null && typeof v === "object" && "v" in (v as Record<string, unknown>) ? ((v as Record<string, unknown>).v as number) : (v as number);
const GOLDEN = path.resolve(HERE, "..", "golden-sets", "story_review", "story_review.golden.jsonl");
const RESULTS = path.resolve(HERE, "..", "results");

function pyStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const examples = fs.readFileSync(GOLDEN, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let verdictOk = 0, taxonomyOk = 0, taxonomyN = 0, gateHits = 0, gateN = 0;
  const perExample: any[] = [];
  for (const ex of examples) {
    const res = await judge(ex.story, ex.implementation);
    const vOk = res.verdict === ex.expected_verdict;
    verdictOk += vOk ? 1 : 0;
    if (ex.expected_verdict === "rework") {
      taxonomyN += 1;
      taxonomyOk += res.failure_kind === ex.labels.failure_kind ? 1 : 0;
    }
    for (const g of ["gate_spec", "gate_no_regression", "gate_security"]) {
      gateN += 1;
      const predSafe = un(res.gate_nouls[g]) >= un(GATE_THRESHOLDS[g]);
      gateHits += predSafe === Boolean(ex.labels[g]) ? 1 : 0;
    }
    const gn: Record<string, unknown> = {};
    for (const g of ["gate_spec", "gate_no_regression", "gate_security"]) gn[g] = un(res.gate_nouls[g]);
    const dims: Record<string, unknown> = {};
    for (const d of Object.keys(res.dimensions as Record<string, unknown>)) dims[d] = Math.trunc(un((res.dimensions as Record<string, unknown>)[d]));
    perExample.push({ id: ex.id, expected: ex.expected_verdict,
      got: res.verdict, ok: vOk,
      failure_kind: res.failure_kind,
      gate_nouls: gn,
      gate_labels: Object.fromEntries(["gate_spec", "gate_no_regression", "gate_security"].map((g) => [g, ex.labels[g]])),
      dimensions: dims });
  }

  const report: Record<string, Json> = {
    set: "story_review",
    n_examples: examples.length,
    verdict_accuracy: verdictOk / examples.length,
    taxonomy_accuracy: taxonomyN ? taxonomyOk / taxonomyN : (null as unknown as Json),
    gate_agreement: gateHits / gateN,
    per_example: perExample as unknown as Json,
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `story-review-${pyStamp()}.json`);
  fs.writeFileSync(out, pyDumpsIndent(tagPythonFloats(report as unknown as Json, new Set(["dimensions"]), new Set(["verdict_accuracy", "taxonomy_accuracy", "gate_agreement"]))), "utf-8");
  const summary = Object.fromEntries(Object.entries(report).filter(([k]) => k !== "per_example"));
  console.log(pyDumpsIndent(tagPythonFloats(summary as unknown as Json, new Set(), new Set(["verdict_accuracy", "taxonomy_accuracy", "gate_agreement"]))));
  for (const p of perExample) {
    const mark = p.ok ? "ok " : "MISS";
    console.log(`  [${mark}] ${p.id}: expected=${p.expected} got=${p.got} kind=${p.failure_kind}`);
  }
  console.log(`report: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
