#!/usr/bin/env node
// CI regression gate (implementation.md §10 evaluation config, Phase 3).
//
// Runs the TS unit tests and the golden sets, and compares against the
// committed baseline (evals/results/baseline.json). Fails (exit 1) on:
//   - per-set accuracy drop > ci_regression_threshold (default 0.03)
//   - resolved model drift vs the lockfile (§6: re-fit required)
// Warns (exit 0, dashboard alerts pick these up per §7.3):
//   - ECE > ece_alert_threshold (default 0.05) — calibration drift is an
//     alerting signal; hard-fail only with --strict
//
// Unit tests (evals/harness/tests/*.test.ts) run first and do not need an API
// key — the gate fails there before touching the golden sets.
//
// Usage:
//   npx tsx evals/harness/ci_gate.ts                 # run + gate
//   npx tsx evals/harness/ci_gate.ts --update-baseline   # refresh baseline
// Skips golden sets with exit 0 + notice when neither TYPESAFE_API_KEY nor
// OPENROUTER_API_KEY is set (CI without secrets); unit tests still run.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MODEL, MODEL_TYPESAFE, JevError, envHasProviderKey } from "./jev_client.ts";
import { pyDumpsIndent, type Json } from "./jev_policy.ts";
import { runSet } from "./run_evals.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS = path.resolve(HERE, "..", "results");
const BASELINE = path.join(RESULTS, "baseline.json");
const LOCKFILE = path.resolve(HERE, "..", "..", "router", "thresholds.lockfile.json");

const CI_REGRESSION_THRESHOLD = 0.03; // §10
const ECE_ALERT_THRESHOLD = 0.05;     // §10

function runUnitTests(): boolean {
  // Run each tests/*.test.ts via tsx (exit 0 = pass). No API key required.
  const testsDir = path.join(HERE, "tests");
  if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) {
    console.log("  unit tests: skipped (no tests/ directory)");
    return true;
  }
  const tests = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")).sort();
  let ok = true;
  for (const t of tests) {
    const tsxBin = path.resolve(HERE, "..", "..", "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(process.execPath, [tsxBin, path.join(testsDir, t)],
      { encoding: "utf8", cwd: path.resolve(HERE, "..", "..", "..") });
    const passed = r.status === 0;
    if (!passed) ok = false;
  }
  return ok;
}

async function runAll(): Promise<Record<string, unknown>[]> {
  const setsDir = path.resolve(HERE, "..", "golden-sets");
  const setDirs = fs.readdirSync(setsDir).sort()
    .filter((d) => fs.statSync(path.join(setsDir, d)).isDirectory() && fs.existsSync(path.join(setsDir, d, "criteria.json")))
    .map((d) => path.join(setsDir, d));
  const out: Record<string, unknown>[] = [];
  for (const d of setDirs) out.push(await runSet(d));
  return out;
}

async function main(argv: string[]): Promise<number> {
  if (!runUnitTests()) {
    console.log("CI GATE: FAIL (unit tests)");
    return 1;
  }

  if (!envHasProviderKey()) {
    console.log("CI GATE: SKIP (no TYPESAFE_API_KEY or OPENROUTER_API_KEY set)");
    return 0;
  }

  let reports: Record<string, unknown>[];
  try {
    reports = await runAll();
  } catch (error) {
    if (error instanceof JevError) {
      // provider outage is a FAIL with a message, not a traceback (degrade contract)
      console.log(`CI GATE: FAIL (provider unavailable: ${error.message})`);
      return 1;
    }
    throw error;
  }
  fs.mkdirSync(RESULTS, { recursive: true });

  if (argv.includes("--update-baseline")) {
    fs.writeFileSync(BASELINE, pyDumpsIndent(reports as unknown as Json, 2), "utf-8");
    console.log(`baseline updated: ${BASELINE}`);
    return 0;
  }

  if (!fs.existsSync(BASELINE)) {
    console.log("CI GATE: FAIL (no baseline.json — run with --update-baseline first)");
    return 1;
  }

  const baselineRaw = JSON.parse(fs.readFileSync(BASELINE, "utf-8")) as Record<string, any>[];
  const baseline = new Map<string, any>();
  for (const r of baselineRaw) baseline.set(r.set, r);
  const lock = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, "utf-8")) : {};

  const failures: string[] = [], warnings: string[] = [];
  for (const rep of reports) {
    const name = rep.set as string;
    const base = baseline.get(name);
    if (!base) {
      warnings.push(`${name}: not in baseline (new set)`);
      continue;
    }
    const baseAcc = base.accuracy ?? null, repAcc = (rep.accuracy as number | null) ?? null;
    if (baseAcc === null || repAcc === null) {
      // None accuracy means the set produced no comparable records
      // (e.g. every live call errored): fail loudly, never TypeError.
      // Python interpolates None as "None" in the f-string
      failures.push(`${name}: accuracy unavailable (baseline=${baseAcc === null ? "None" : baseAcc}, current=${repAcc === null ? "None" : repAcc})`);
      continue;
    }
    const accDrop = baseAcc - repAcc;
    if (accDrop > CI_REGRESSION_THRESHOLD) {
      failures.push(`${name}: accuracy dropped ${fmt3(accDrop)} (${fmt3(baseAcc)} -> ${fmt3(repAcc)})`);
    }
    // The provider serving an ID that is neither the pinned snapshot nor
    // its known alias is an early drift signal (e.g. a repointed
    // snapshot) — alert, don't fail; re-fit decision stays with §6.
    if (rep.model_echo && ![DEFAULT_MODEL, MODEL_TYPESAFE].includes(rep.model_echo as string)) {
      warnings.push(`${name}: provider served ${rep.model_echo} for pinned `
        + `${rep.model_resolved} (normalization or repoint — verify §6)`);
    }
    const ece = rep.ece as number | null | undefined;
    if (ece !== null && ece !== undefined && ece > ECE_ALERT_THRESHOLD) {
      const bucket = argv.includes("--strict") ? failures : warnings;
      bucket.push(`${name}: ECE ${fmt3(ece)} > ${ECE_ALERT_THRESHOLD}`
        + (argv.includes("--strict") ? " (strict)" : " (alert; see dashboard)"));
    }
    // model drift vs lockfile (§6: re-fit on model change)
    const lockModel = lock.model_resolved;
    if (lockModel && rep.model_resolved && rep.model_resolved !== lockModel) {
      failures.push(`${name}: model drift ${lockModel} -> ${rep.model_resolved} (re-fit thresholds per §6)`);
    }
    // run-to-run variance note
    if (Math.abs(accDrop) <= CI_REGRESSION_THRESHOLD) {
      console.log(`  ok ${name}: acc ${fmt3(rep.accuracy)} (baseline ${fmt3(base.accuracy)}, delta ${fmtSigned3(-accDrop)})`);
    }
  }

  for (const w of warnings) console.log(`  WARN ${w}`);
  for (const f of failures) console.log(`  FAIL ${f}`);

  if (failures.length) {
    console.log("CI GATE: FAIL");
    return 1;
  }
  console.log("CI GATE: PASS");
  return 0;
}

/** f"{x:.3f}" with a sign prefix for the delta column. */
function fmt3(v: unknown): string {
  return (v as number).toFixed(3);
}
function fmtSigned3(v: number): string {
  const s = v.toFixed(3);
  // Python f"{-0.0:+.3f}" renders "-0.000" (negative zero keeps its sign);
  // toFixed drops the -0 sign, so restore it.
  if (Object.is(v, -0)) return `-${Math.abs(v).toFixed(3)}`;
  return v > 0 ? `+${s}` : s;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv);
