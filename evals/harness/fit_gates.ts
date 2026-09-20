#!/usr/bin/env node
// Fit per-gate thresholds for judge.py and bmad_gates.py (§6 methodology).
//
// Reads the latest story-review report (gate nouls + dimensions per example)
// and the latest eval run (readiness records), sweeps thresholds, and merges
// a "gates" section into router/thresholds.lockfile.json.
//
// Gate fitting: per noul gate, pick the HIGHEST threshold achieving max
// accuracy (conservative ties). Dimension cutoff: global 2-10 cutoff
// maximizing verdict accuracy given fitted gates.
//
// Usage:
//   npx tsx evals/harness/fit_gates.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { pythonRound } from "./jev_client.ts";
import { pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS = path.resolve(HERE, "..", "results");
const LOCKFILE = path.resolve(HERE, "..", "..", "router", "thresholds.lockfile.json");

const GATE_KEYS = ["gate_spec", "gate_no_regression", "gate_security"];
const DIM_KEYS = ["dim_correctness", "dim_quality", "dim_tests", "dim_bmad"];
// Below this, a fit is noise (same doctrine as holdout_validate.MIN_SET_SIZE):
// the gate keeps its §7.7/§9 default instead of a fitted value.
const MIN_FIT_N = 20;

function latest(pattern: RegExp): any {
  const runs = fs.readdirSync(RESULTS).sort().filter((f) => pattern.test(f)).map((f) => path.join(RESULTS, f));
  return runs.length ? JSON.parse(fs.readFileSync(runs[runs.length - 1], "utf-8")) : null;
}

function fitNoulGate(pairs: Array<[number, number]>): [number, number] {
  // pairs: [(prob, label01)] -> best (threshold, accuracy). Highest t wins ties.
  let best: [number, number] | null = null;
  for (let i = 0; i < 14; i++) {
    const t = pythonRound(0.30 + 0.05 * i, 2);
    const acc = neumaierSum(pairs.map(([p, l]) => ((p >= t) === Boolean(l) ? 1 : 0))) / pairs.length;
    if (best === null || acc > best[1] || (acc === best[1] && t > best[0])) best = [t, acc];
  }
  return best as [number, number];
}

const FLOAT_FIELDS = new Set(["judge_dim_min", "readiness_score_min", "cutoff", "score_mae_levels", "auto_acc", "gate_accuracy", "simulated_verdict_accuracy", "verdict_accuracy"]);

function main(): void {
  const out: Record<string, Json> = {};
  const meta: Record<string, Json> = {};

  // --- judge gates + dimension cutoff (story-review report) ---
  let sr = latest(/^story-review-.*\.json$/);
  if (sr && (sr.per_example ?? []).length < MIN_FIT_N) {
    console.log(`judge gates: ${(sr.per_example ?? []).length} examples < ${MIN_FIT_N} `
      + `— skipped, keeping §7.7 defaults (0.95 gates / dim min 7)`);
    sr = null;
  }
  if (sr) {
    const gates: Record<string, number> = {};
    for (const g of GATE_KEYS) {
      const pairs = sr.per_example.map((e: any) => [e.gate_nouls[g], e.gate_labels[g]] as [number, number]);
      const [th, acc] = fitNoulGate(pairs);
      gates[`judge_${g}`] = th;
      meta[`judge_${g}`] = { gate_accuracy: pythonRound(acc, 3), n: pairs.length } as unknown as Json;
    }

    // dimension cutoff: sweep with fitted gates applied
    const verdict = (e: any, tGates: Record<string, number>, c: number): boolean => {
      const gatesPass = GATE_KEYS.every((g) => e.gate_nouls[g] >= tGates[g]);
      const dimsPass = DIM_KEYS.every((d) => e.dimensions[d] >= c);
      const got = gatesPass && dimsPass ? "first_pass" : "rework";
      return got === e.expected;
    };

    const tGates: Record<string, number> = {};
    for (const g of GATE_KEYS) tGates[g] = gates[`judge_${g}`];
    let bestC: [number, number] | null = null;
    for (let i = 0; i < 13; i++) {
      const c = pythonRound(5.0 + 0.25 * i, 2);
      const acc = sr.per_example.filter((e: any) => verdict(e, tGates, c)).length / sr.per_example.length;
      if (bestC === null || acc > bestC[1] || (acc === bestC[1] && c < bestC[0])) bestC = [c, acc];
    }
    const [cBest, accBest] = bestC as [number, number];
    gates["judge_dim_min"] = cBest;
    meta["judge_dim_min"] = { simulated_verdict_accuracy: pythonRound(accBest, 3),
      note: "2-10 scale; pass requires dimension >= cutoff" } as unknown as Json;
    Object.assign(out, gates);
  }

  // --- readiness gates (latest run with readiness records) ---
  let run: any[] | null = null;
  const runFiles = fs.readdirSync(RESULTS).sort().filter((f) => /^run-.*\.json$/.test(f)).map((f) => path.join(RESULTS, f));
  for (const p of [...runFiles].reverse()) {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.some((r: any) => r.set === "readiness")) { run = data; break; }
  }
  if (run) {
    const recs: any[] = run.filter((r: any) => r.set === "readiness").flatMap((r: any) => r.records ?? []);
    for (const g of ["spec_specific", "requirements_testable", "no_blockers"]) {
      const pairs = recs.filter((r) => r.qid === g && r.primitive === "noul")
        .map((r) => [r.prediction, r.label] as [number, number]);
      const readMeta = (meta.readiness ??= {}) as Record<string, Json>;
      if (pairs.length && pairs.length >= MIN_FIT_N) {
        const [th, acc] = fitNoulGate(pairs);
        out[`readiness_${g}`] = th;
        readMeta[g] = { gate_accuracy: pythonRound(acc, 3), n: pairs.length } as unknown as Json;
      } else if (pairs.length) {
        readMeta[g] = { note: `only ${pairs.length} examples < ${MIN_FIT_N}; keeping §9 default 0.90` } as unknown as Json;
      }
    }
    const sc = recs.filter((r) => r.qid === "ready_score");
    if (sc.length) {
      const pairs = sc.map((r) => [r.prediction, r.label] as [number, number]);
      const mae = neumaierSum(pairs.map(([p, l]) => Math.abs(p - l))) / pairs.length;
      const readMeta = (meta.readiness ??= {}) as Record<string, Json>;
      if (sc.length < MIN_FIT_N) {
        readMeta.ready_score = {
          score_mae_levels: pythonRound(mae, 2),
          note: `only ${sc.length} examples < ${MIN_FIT_N}; keeping §9 default 3.0`,
        } as unknown as Json;
      } else {
        readMeta.ready_score = { score_mae_levels: pythonRound(mae, 2) } as unknown as Json;
        // Fit the readiness score cutoff: expected verdict is proceed iff
        // every gate label is 1 AND the score label >= 3 (§9 policy).
        const byExample = new Map<string, any[]>();
        for (const r of recs) {
          const k = r.id ?? "";
          if (!byExample.has(k)) byExample.set(k, []);
          byExample.get(k)!.push(r);
        }
        const gatePreds: Record<string, number[]> = {}, gateLabels: Record<string, boolean> = {};
        const scorePred: Record<string, number> = {}, scoreLabel: Record<string, number> = {};
        for (const [exId, rs] of byExample) {
          for (const r of rs) {
            if (r.qid === "ready_score") {
              scorePred[exId] = r.prediction; scoreLabel[exId] = r.label;
            } else if (["spec_specific", "requirements_testable", "no_blockers"].includes(r.qid)) {
              (gatePreds[exId] ??= []).push(r.prediction);
              gateLabels[exId] = (gateLabels[exId] ?? true) && Boolean(r.label);
            }
          }
        }
        let best: [number, number] | null = null;
        for (let i = 0; i < 13; i++) {
          const c = 0.5 + 0.25 * i;
          let ok = 0, n = 0;
          for (const exId of Object.keys(scorePred)) {
            if (!gateLabels[exId]) continue; // a failed gate decides the verdict regardless of the score
            const gatesPass = (gatePreds[exId] ?? []).every((p) => p >= 0.5);
            const expected = scoreLabel[exId] >= 3;
            const got = gatesPass && scorePred[exId] >= c;
            n += 1;
            ok += got === expected ? 1 : 0;
          }
          if (n && (best === null || ok / n > best[1])) best = [c, ok / n];
        }
        if (best) {
          out["readiness_score_min"] = best[0];
          (meta.readiness as Record<string, Json>)["score_cutoff"] = {
            cutoff: best[0], verdict_accuracy: pythonRound(best[1], 3), n: Object.keys(scorePred).length,
          } as unknown as Json;
        }
      }
    }
  }

  // --- merge into lockfile ---
  const lock = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, "utf-8")) : {};
  lock.gates = out;
  if (Object.keys(meta).length) lock.gates_meta = meta;
  fs.writeFileSync(LOCKFILE, pyDumpsIndent(tagPythonFloats(lock as unknown as Json, undefined, FLOAT_FIELDS)) + "\n", "utf-8");
  console.log(pyDumpsIndent(tagPythonFloats(out as unknown as Json, undefined, FLOAT_FIELDS)));
  console.log(`lockfile: ${LOCKFILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
