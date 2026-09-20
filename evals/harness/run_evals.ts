#!/usr/bin/env node
// Golden-set eval runner (implementation.md §7.3 asset #2).
//
// Usage:
//   npx tsx evals/harness/run_evals.ts evals/golden-sets/routing
//   npx tsx evals/harness/run_evals.ts evals/golden-sets        # all sets
//
// Loads criteria.json + *.golden.jsonl, runs each example through the Jev
// Decisions API, scores against labels, writes a report to evals/results/.
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as M from "./metrics.ts";
import { callJev, usageCost } from "./jev_client.ts";
import { pyDumps, pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";

const INT_KEYS = new Set(["latency_ms"]); // latency_stats values are ints (Python round)

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS_DIR = path.resolve(HERE, "..", "results");

export type GoldenExample = { id: string; state: unknown; labels: Record<string, unknown> };

export function loadSet(setDir: string): [any, GoldenExample[]] {
  const criteria = JSON.parse(fs.readFileSync(path.join(setDir, "criteria.json"), "utf-8"));
  const golden: GoldenExample[] = [];
  for (const line of fs.readFileSync(path.join(setDir, `${path.basename(setDir)}.golden.jsonl`), "utf-8").split("\n")) {
    if (line.trim()) golden.push(JSON.parse(line));
  }
  return [criteria, golden];
}

export function scoreRecord(qid: string, qdef: any, answer: any, label: unknown, exId = "") {
  // Normalize one answer into a metrics record.
  const p = qdef.type;
  let pred: number | string;
  let correct: boolean;
  label = label as number | string;
  if (p === "noul") {
    pred = answer.noul;
    correct = ((pred as number) >= 0.5) === Boolean(label);
  } else if (p === "choice") {
    pred = answer.choice;
    correct = pred === label;
  } else {
    // score: nearest legend level vs integer label — half-up
    // (Python's round() would send .5 ties to the even level)
    pred = answer.score; // already 0..n_levels-1
    correct = Math.floor((pred as number) + 0.5) === (label as number);
  }
  return {
    id: exId, qid, primitive: p, label,
    prediction: pred, confidence: answer.confidence ?? null,
    correct,
  };
}

export async function runSet(setDir: string): Promise<any> {
  const [criteria, golden] = loadSet(setDir);
  const records: any[] = [], latencies: number[] = [], costs: (number | null)[] = [];
  let nErr = 0;
  let resp: any = undefined;
  for (const ex of golden) {
    const t0 = performance.now();
    try {
      resp = await callJev(criteria.questions, ex.state);
    } catch (e: any) {
      nErr += 1;
      process.stderr.write(`  [error] ${ex.id}: ${e.message}\n`);
      continue;
    }
    latencies.push((performance.now() - t0));
    costs.push(usageCost(resp.usage));
    for (const [qid, label] of Object.entries(ex.labels)) {
      if (!(qid in (resp.answers ?? {}))) {
        nErr += 1;
        continue;
      }
      records.push(scoreRecord(qid, criteria.questions[qid], resp.answers[qid], label, ex.id ?? ""));
    }
  }

  const known = costs.filter((c): c is number => c !== null);
  const report: Record<string, Json> = {
    set: path.basename(setDir),
    records: records as unknown as Json, // per-example details (used by fit_thresholds.ts)
    n_examples: golden.length,
    n_records: records.length,
    n_errors: nErr,
    // model_resolved = the logical pinned snapshot (§6, provider-
    // independent); model_echo = what the provider actually served
    // (drift-detection signal, alerted by ci_gate).
    model_resolved: records.length ? (resp.model_requested ?? resp.model) : null,
    model_echo: resp ? (resp.model ?? null) : null,
    accuracy: M.accuracy(records as M.MetricRecord[]) as unknown as Json,
    ece: M.ece(records as M.MetricRecord[]) as unknown as Json,
    brier: M.brierScore(records as M.MetricRecord[]) as unknown as Json,
    score_mae: M.scoreMae(records as M.MetricRecord[]) as unknown as Json,
    other_rate: M.otherRate(records as M.MetricRecord[]) as unknown as Json,
    bands: M.bandReport(records as M.MetricRecord[]) as unknown as Json,
    latency_ms: M.latencyStats(latencies) as unknown as Json,
    // Provider-reported cost only; null (never 0.0) when the provider
    // reports token counts without a price (the Jev API does not).
    cost_total_usd: (known.length
      ? M.pythonRound(neumaierSum(known) * 1e8) / 1e8
      : null) as unknown as Json,
    cost_per_example_usd: (known.length
      ? M.pythonRound((neumaierSum(known) / costs.length) * 1e8) / 1e8
      : null) as unknown as Json,
  };
  return report;
}

function pyStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  // %Y%m%d-%H%M%S in local time (matches time.strftime)
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(argv: string[]): Promise<void> {
  // argv[0] = first user arg (drivers set process.argv = ["node", script, ...args])
  const target = argv[0] ? path.resolve(argv[0]) : path.resolve("evals/golden-sets");
  let setDirs: string[];
  if (fs.existsSync(path.join(target, "criteria.json"))) {
    setDirs = [target];
  } else {
    setDirs = fs.readdirSync(target).sort()
      .map((d) => path.join(target, d))
      .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "criteria.json")));
  }
  if (!setDirs.length) {
    process.stderr.write(`no golden sets under ${target}\n`);
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const allReports: Json[] = [];
  for (const d of setDirs) {
    console.log(`== ${path.basename(d)} ==`);
    const rep = (await runSet(d)) as unknown as Json;
    allReports.push(rep);
    console.log(pyDumpsIndent(tagPythonFloats(rep, INT_KEYS)));
  }

  const out = path.join(RESULTS_DIR, `run-${pyStamp()}.json`);
  fs.writeFileSync(out, pyDumpsIndent(tagPythonFloats(allReports as unknown as Json, INT_KEYS)), "utf-8");
  console.log(`\nreport: ${out}`);
}

const argv = process.argv.slice(2); // argv[0] is the script path under tsx, like sys.argv
if (import.meta.url === `file://${process.argv[1]}`) await main(argv);
