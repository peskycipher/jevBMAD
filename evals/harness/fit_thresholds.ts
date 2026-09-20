#!/usr/bin/env node
// Fit routing thresholds from golden-set eval runs (implementation.md §6).
//
// Reads eval result reports (with per-record details) from evals/results/,
// sweeps candidate thresholds, and writes router/thresholds.lockfile.json.
//
// Policy: locked threshold = strictest of (fitted, default) — conservative
// (§11: "Start conservative; expand via online sampling"). Status is
// 'provisional' until the golden set has >= min_examples (§10: 100).
//
// Usage:
//   npx tsx evals/harness/fit_thresholds.ts            # latest run in results/
//   npx tsx evals/harness/fit_thresholds.ts results/run-<stamp>.json
import * as fs from "node:fs";
import * as path from "node:path";
import { pythonRound } from "./jev_client.ts";
import { pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS_DIR = path.resolve(HERE, "..", "results");
const LOCKFILE = path.resolve(HERE, "..", "..", "router", "thresholds.lockfile.json");

const TARGET_AUTO_ACC = 0.95;  // accuracy required among auto-executed examples
const MIN_EXAMPLES = 100;      // §10 calibration.min_labeled_examples
export const DEFAULTS: Record<string, number> = { intent_conf_min: 0.75, safe_noul_escalate: 0.5,
  safe_noul_clean: 0.75, complexity_max: 1.5 };

type Sweep = [number, number, number] | null;

export function sweepConfidence(recs: any[], target = TARGET_AUTO_ACC): Sweep {
  // Choice: pick the lowest confidence threshold whose auto-band accuracy
  // still meets target (maximizes auto-rate under the accuracy constraint).
  let best: Sweep = null;
  for (let i = 0; i < 10; i++) {
    const t = 0.5 + 0.05 * i;
    const auto = recs.filter((r) => r.confidence >= t);
    if (auto.length < Math.max(3, 0.2 * recs.length)) continue; // need meaningful support
    const acc = neumaierSum(auto.map((r) => (r.correct ? 1 : 0))) / auto.length;
    if (acc >= target && (best === null || t < best[0])) best = [t, acc, auto.length];
  }
  return best;
}

export function sweepNoul(recs: any[], target = TARGET_AUTO_ACC): Sweep {
  // Noul: lowest probability threshold for 'safe' with accuracy >= target.
  let best: Sweep = null;
  for (let i = 0; i < 10; i++) {
    const t = 0.5 + 0.05 * i;
    const auto = recs.filter((r) => r.prediction >= t);
    if (auto.length < Math.max(3, 0.2 * recs.length)) continue;
    const acc = neumaierSum(auto.map((r) => (r.correct ? 1 : 0))) / auto.length;
    if (acc >= target && (best === null || t < best[0])) best = [t, acc, auto.length];
  }
  return best;
}

export function sweepScore(recs: any[], target = TARGET_AUTO_ACC): Sweep {
  // Score: highest complexity cutoff whose auto-band accuracy meets target.
  // Underestimating complexity is the error mode we guard against.
  let best: Sweep = null;
  for (let i = 0; i < 13; i++) {
    const c = 0.5 + 0.25 * i;
    const auto = recs.filter((r) => r.prediction <= c);
    if (auto.length < Math.max(3, 0.2 * recs.length)) continue;
    const acc = neumaierSum(auto.map((r) => (r.correct ? 1 : 0))) / auto.length;
    if (acc >= target && (best === null || c > best[0])) best = [c, acc, auto.length];
  }
  return best;
}

const FLOAT_FIELDS = new Set(["auto_acc", "gate_accuracy", "simulated_verdict_accuracy", "verdict_accuracy"]); // integral accuracies must render like Python floats

function main(argv: string[]): void {
  let reportPath: string;
  if (argv.length > 0) {
    reportPath = argv[0];
  } else {
    const runs = fs.readdirSync(RESULTS_DIR).sort()
      .filter((f) => /^run-.*\.json$/.test(f)).map((f) => path.join(RESULTS_DIR, f));
    if (!runs.length) {
      process.stderr.write("no eval runs found in evals/results/ — run run_evals.py first\n");
      process.exit(1);
    }
    reportPath = runs[runs.length - 1];
  }

  const reports = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const bySet: Record<string, any[]> = {};
  for (const rep of reports) {
    const recs = rep.records ?? [];
    if (recs.length) bySet[rep.set] = recs;
  }

  if (!Object.values(bySet).some((v) => v.length)) {
    process.stderr.write(`${reportPath} has no per-record details — re-run run_evals.py\n`);
    process.exit(1);
  }

  const fitted: Record<string, Json> = {};
  const sweepers: Array<[string, string, (recs: any[]) => Sweep]> = [
    ["routing", "intent_conf_min", sweepConfidence],
    ["guardrails", "safe_noul_escalate", sweepNoul],
    ["complexity", "complexity_max", sweepScore],
  ];
  for (const [setName, key, fn] of sweepers) {
    const recs = bySet[setName] ?? [];
    const result = recs.length ? fn(recs) : null;
    if (result) {
      const [t, acc, n] = result;
      fitted[key] = { fitted: pythonRound(t, 2), auto_acc: pythonRound(acc, 3),
        n_auto: n, n_total: recs.length } as unknown as Json;
    } else {
      fitted[key] = { fitted: null, note: "no threshold met target; keep default", n_total: recs.length } as unknown as Json;
    }
  }

  // Locked = strictest of fitted vs default (auto-execute requires MORE evidence)
  // safe_noul_clean has no sweep (tiered policy, §14.2): always the default.
  const locked: Record<string, number> = {};
  for (const [key, dflt] of Object.entries(DEFAULTS)) {
    const f = (fitted[key] as Record<string, unknown> | undefined)?.fitted;
    if (f === null || f === undefined) {
      locked[key] = dflt;
      continue;
    }
    if (key === "complexity_max") locked[key] = pythonRound(Math.min(f as number, dflt), 2); // stricter = lower cap
    else locked[key] = pythonRound(Math.max(f as number, dflt), 2); // stricter = higher threshold
  }

  const nTotal = neumaierSum(sweepers.map(([, key]) => (fitted[key] as any).n_total));
  // Preserve sections written by other fitters (fit_gates.py writes
  // "gates"/"gates_meta") — this script owns the routing thresholds only.
  const previous = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, "utf-8")) : {};
  const out: Record<string, Json> = {
    source_run: reportPath,
    target_auto_band_accuracy: TARGET_AUTO_ACC,
    status: nTotal < MIN_EXAMPLES ? "provisional" : "candidate-final",
    min_examples_required: MIN_EXAMPLES,
    n_examples_total: nTotal,
    model_resolved: (reports[0]?.model_resolved ?? null) as unknown as Json,
    fitted: fitted as unknown as Json,
    locked: locked as unknown as Json,
    note: "strictest of fitted vs §10 defaults; re-fit when model version changes (§6)",
    bands_note: ("safe_noul tiered policy (§14.2): <safe_noul_escalate escalate, "
      + "[escalate, safe_noul_clean) auto+flag (audit sampling pool), "
      + ">= safe_noul_clean clean auto; high-stakes keyword traffic still "
      + "forces System 2 via the keyword gate"),
  };
  for (const section of ["gates", "gates_meta"]) {
    if (section in previous) out[section] = previous[section];
  }
  fs.mkdirSync(path.dirname(LOCKFILE), { recursive: true });
  fs.writeFileSync(LOCKFILE, pyDumpsIndent(tagPythonFloats(out as unknown as Json, undefined, FLOAT_FIELDS)) + "\n", "utf-8");
  console.log(pyDumpsIndent(tagPythonFloats(out as unknown as Json, undefined, FLOAT_FIELDS)));
  console.log(`\nlockfile: ${LOCKFILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
