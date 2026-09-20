#!/usr/bin/env node
// Held-out validation (implementation.md §6: fit on train, validate on holdout).
//
// Corrects the methodology error of fitting and reporting on the same data:
//
//   1. Deterministic stratified 80/20 split per golden set (written once to
//      golden-sets/<set>/splits/ and reused — never reshuffled, or the holdout
//      leaks). Stratified by exact label signature.
//   2. Live Jev run over the full set (fresh predictions, ids recorded).
//   3. Thresholds fitted on the TRAIN split only.
//   4. Unbiased estimates reported on the HOLDOUT split — at both the
//      train-fitted thresholds and the locked production thresholds (§10
//      strictest-of rule), so eval numbers and production decision boundaries
//      finally measure the same thing.
//
// Sets with < 20 examples (readiness, story_review) are skipped: too small to
// split; their numbers remain provisional per the known-limitations note.
//
// Usage:
//   npx tsx evals/harness/holdout_validate.ts          # big sets (default)
//   npx tsx evals/harness/holdout_validate.ts routing guardrails
import * as fs from "node:fs";
import * as path from "node:path";
import { pyDumps, pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";
import { loadSet, runSet } from "./run_evals.ts";
import { DEFAULTS, sweepConfidence, sweepNoul, sweepScore } from "./fit_thresholds.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const GOLDEN = path.resolve(HERE, "..", "golden-sets");
const RESULTS = path.resolve(HERE, "..", "results");
const LOCKFILE = path.resolve(HERE, "..", "..", "router", "thresholds.lockfile.json");

export function sortedJson(v: unknown): string {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return pyDumps(v as Json);
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => `${pyDumps(k)}: ${sortedJson((v as Record<string, unknown>)[k])}`).join(", ") + "}";
}

const SEED = 42;
const TRAIN_FRAC = 0.8;
const MIN_SET_SIZE = 20; // below this, splitting is statistically meaningless

/** MT19937 matching CPython's random.Random(int) (init_by_array seeding). */
export class PyRandom {
  private mt = new Array<number>(624).fill(0);
  private idx = 625;

  constructor(seed: number) {
    // init_by_array with the 32-bit little-endian words of |seed|
    const key: number[] = [];
    let k = Math.abs(Math.trunc(seed));
    do {
      key.push(k >>> 0);
      k = Math.floor(k / 4294967296);
    } while (k > 0);
    if (key.length === 0) key.push(0);
    this.mt[0] = 19650218 >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1];
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    let i = 1, j = 0;
    const maxIter = Math.max(624, key.length);
    for (let it = 0; it < maxIter; it++) {
      this.mt[i] = ((this.mt[i] ^ Math.imul(1664525, this.mt[i - 1] ^ (this.mt[i - 1] >>> 30))) + key[j] + j) >>> 0;
      i += 1; j += 1;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let it = 0; it < 623; it++) {
      this.mt[i] = ((this.mt[i] ^ Math.imul(1566083941, this.mt[i - 1] ^ (this.mt[i - 1] >>> 30))) - i) >>> 0;
      i += 1;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
  }

  private next32(): number {
    if (this.idx >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = ((this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff)) >>> 0;
        this.mt[i] = (this.mt[(i + 397) % 624] ^ (y >>> 1)) >>> 0;
        if (y & 1) this.mt[i] = (this.mt[i] ^ 0x9908b0df) >>> 0;
      }
      this.idx = 0;
    }
    let y = this.mt[this.idx];
    this.idx += 1;
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }

  /** random.Random._randbelow(n): getrandbits(n.bit_length()) until < n.
   * getrandbits drops the LEAST significant bits of the top word. */
  randbelow(n: number): number {
    if (n <= 1) return 0;
    const k = n.toString(2).length; // n.bit_length()
    const words = Math.ceil(k / 32);
    const take = k - 32 * (words - 1); // bits in the top word
    for (;;) {
      let r = 0;
      for (let i = 0; i < words; i++) {
        let w = this.next32();
        if (i === words - 1 && take < 32) w = w >>> (32 - take);
        r += w * Math.pow(2, 32 * i);
      }
      if (r < n) return r;
    }
  }

  shuffle<T>(list: T[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  /** random.sample(population, k) — both CPython branches (pool swap and
   * selected-set), keyed on the same setsize heuristic. */
  sample<T>(population: T[], k: number): T[] {
    const n = population.length;
    if (k > n || k < 0) throw new Error("Sample larger than population or is negative");
    const result = new Array<T>(k);
    let setsize = 21;
    if (k > 5) setsize += Math.pow(4, Math.ceil(Math.log(k * 3) / Math.log(4)));
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}

function makeSplit(setDir: string, examples: any[]): { train: Set<string>; holdout: Set<string>; reused: boolean } {
  // Deterministic stratified split, written once and reused thereafter.
  const sp = path.join(setDir, "splits");
  const metaP = path.join(sp, "meta.json"), trainP = path.join(sp, "train.jsonl"), holdP = path.join(sp, "holdout.jsonl");
  if (fs.existsSync(metaP) && fs.existsSync(trainP) && fs.existsSync(holdP)) {
    const trainIds = new Set(fs.readFileSync(trainP, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).id));
    const holdIds = new Set(fs.readFileSync(holdP, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).id));
    return { train: trainIds, holdout: holdIds, reused: true };
  }
  fs.mkdirSync(sp, { recursive: true });
  const strata = new Map<string, string[]>();
  for (const ex of examples) {
    const key = sortedJson(ex.labels);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key)!.push(ex.id);
  }
  const trainIds = new Set<string>(), holdIds = new Set<string>();
  // Deterministic per-stratum shuffle mirroring random.Random(SEED).shuffle
  // (one shared MT19937 stream, same draw order as the Python original).
  const rng = new PyRandom(SEED);
  for (const ids of strata.values()) {
    ids.sort();
    rng.shuffle(ids);
    const k = Math.max(1, Math.round(ids.length * (1 - TRAIN_FRAC)));
    for (const id of ids.slice(0, k)) holdIds.add(id);
    for (const id of ids.slice(k)) trainIds.add(id);
  }
  fs.writeFileSync(trainP, [...trainIds].sort().map((i) => pyDumps({ id: i } as unknown as Json) + "\n").join(""), "utf-8");
  fs.writeFileSync(holdP, [...holdIds].sort().map((i) => pyDumps({ id: i } as unknown as Json) + "\n").join(""), "utf-8");
  fs.writeFileSync(metaP, pyDumpsIndent({ seed: SEED, train_frac: TRAIN_FRAC,
    n_train: trainIds.size, n_holdout: holdIds.size, strata: strata.size } as unknown as Json), "utf-8");
  return { train: trainIds, holdout: holdIds, reused: false };
}

function evalAtThreshold(records: any[], prim: string, threshold: number, mode: string): Record<string, Json> {
  // Accuracy among records whose production decision is 'auto' at threshold.
  // The thresholded value is `confidence` for choice (a distribution-
  // concentration statistic) and `prediction` for noul/score (the answer
  // itself). mode 'ge': auto when value >= threshold; 'le': <= (complexity cap).
  const value = (r: any) => (prim === "choice" ? r.confidence : r.prediction);
  const auto = records.filter((r) => r.primitive === prim &&
    (mode === "ge" ? value(r) >= threshold : value(r) <= threshold));
  if (!auto.length) return { n_auto: 0, auto_acc: null };
  return { n_auto: auto.length, auto_acc: (Math.round((neumaierSum(auto.map((r) => (r.correct ? 1 : 0))) / auto.length) * 1000) / 1000) as unknown as Json };
}

const FLOAT_FIELDS = new Set(["auto_acc_train", "train_accuracy", "holdout_accuracy", "holdout_mae", "auto_acc", "threshold"]);

async function main(argv: string[]): Promise<void> {
  const sets = argv.length > 2 ? argv.slice(2) : ["routing", "guardrails", "complexity"];
  const lock = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, "utf-8")) : {};
  const locked: Record<string, number> = { ...DEFAULTS, ...(lock.locked ?? {}) };
  const reportAll: Record<string, Json>[] = [];

  for (const name of sets) {
    const setDir = path.join(GOLDEN, name);
    if (!fs.existsSync(path.join(setDir, "criteria.json"))) {
      console.log(`skip ${name}: no criteria.json`);
      continue;
    }
    const [, examples] = loadSet(setDir);
    if (examples.length < MIN_SET_SIZE) {
      console.log(`skip ${name}: ${examples.length} examples < ${MIN_SET_SIZE} (too small to split; stays provisional)`);
      continue;
    }

    const split = makeSplit(setDir, examples);
    // fresh live run with ids
    const rep = await runSet(setDir);
    const records: any[] = rep.records;
    const byId = new Map<string, any[]>();
    for (const r of records) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id)!.push(r);
    }
    const train = [...split.train].flatMap((i) => byId.get(i) ?? []);
    const hold = [...split.holdout].flatMap((i) => byId.get(i) ?? []);
    // a live example may error (provider hiccup): those are simply absent,
    // not fatal — the fit/holdout math only needs the records that exist.
    if (train.length + hold.length < records.length) {
      throw new Error(`${name}: records not partitioned by id — ${train.length}+${hold.length} vs ${records.length}`);
    }
    const missing = [...split.train, ...split.holdout].filter((i) => !byId.has(i));
    if (missing.length) {
      console.log(`warn ${name}: ${missing.length} example(s) errored in the live run and are excluded`);
    }

    // ---- fit on TRAIN only ----
    const fitted: Record<string, unknown> = {};
    const sweepers: Record<string, [string, (recs: any[]) => [number, number, number] | null, "choice" | "noul" | "score"]> = {
      routing: ["intent_conf_min", sweepConfidence, "choice"],
      guardrails: ["safe_noul_escalate", sweepNoul, "noul"],
      complexity: ["complexity_max", sweepScore, "score"],
    };
    const [key, fn, prim] = sweepers[name as "routing" | "guardrails" | "complexity"] ?? ["", () => null, "choice"];
    const recs = records.filter((r) => split.train.has("") as never); // placeholder, replaced below
    void recs;
    const trainPrim = train.filter((r) => r.primitive === prim);
    fitted[key] = fn(trainPrim) ?? {
      note: trainPrim.length ? "no threshold met the auto-accuracy floor on train" : "no train records",
    };

    // ---- evaluate on HOLDOUT ----
    const out: Record<string, Json> = { set: name, n_train: split.train.size, n_holdout: split.holdout.size,
      split_reused: split.reused, model: rep.model_resolved,
      train_accuracy: null, holdout_accuracy: rep.accuracy,
      fitted_on_train: {}, holdout_at_fitted: {}, holdout_at_locked: {} };

    if (name === "routing") {
      const choiceHold = hold.filter((r) => r.primitive === "choice");
      out.holdout_accuracy = neumaierSum(choiceHold.map((r) => (r.correct ? 1 : 0))) / choiceHold.length;
      const choiceTrain = train.filter((r) => r.primitive === "choice");
      out.train_accuracy = neumaierSum(choiceTrain.map((r) => (r.correct ? 1 : 0))) / choiceTrain.length;
      if ("note" in (fitted[key] as Record<string, unknown>)) {
        console.log(`skip ${name}: fit sweep found no qualifying threshold on train`);
        continue;
      }
      const [tFit, acc] = fitted[key] as unknown as [number, number, number];
      out.fitted_on_train = { intent_conf_min: tFit, auto_acc_train: Math.round(acc * 1000) / 1000 } as unknown as Json;
      const atFit = evalAtThreshold(choiceHold, "choice", tFit, "ge");
      out.holdout_at_fitted = { threshold: tFit, ...atFit } as unknown as Json;
      const tLock = locked.intent_conf_min;
      out.holdout_at_locked = { threshold: tLock, ...evalAtThreshold(choiceHold, "choice", tLock, "ge") } as unknown as Json;
    } else if (name === "guardrails") {
      const noulHold = hold.filter((r) => r.primitive === "noul");
      out.holdout_accuracy = neumaierSum(noulHold.map((r) => (r.correct ? 1 : 0))) / noulHold.length;
      const noulTrain = train.filter((r) => r.primitive === "noul");
      out.train_accuracy = neumaierSum(noulTrain.map((r) => (r.correct ? 1 : 0))) / noulTrain.length;
      if ("note" in (fitted[key] as Record<string, unknown>)) {
        console.log(`skip ${name}: fit sweep found no qualifying threshold on train`);
        continue;
      }
      const [tFit, acc] = fitted[key] as unknown as [number, number, number];
      out.fitted_on_train = { safe_noul_escalate: tFit, auto_acc_train: Math.round(acc * 1000) / 1000 } as unknown as Json;
      out.holdout_at_fitted = { threshold: tFit, ...evalAtThreshold(noulHold, "noul", tFit, "ge") } as unknown as Json;
      const tLock = locked.safe_noul_escalate ?? 0.5; // production escalate cut
      out.holdout_at_locked = { threshold: tLock, ...evalAtThreshold(noulHold, "noul", tLock, "ge") } as unknown as Json;
    } else if (name === "complexity") {
      out.holdout_accuracy = neumaierSum(hold.map((r) => (r.correct ? 1 : 0))) / hold.length;
      out.train_accuracy = neumaierSum(train.map((r) => (r.correct ? 1 : 0))) / train.length;
      const maeH = neumaierSum(hold.map((r) => Math.abs(r.prediction - r.label))) / hold.length;
      if ("note" in (fitted[key] as Record<string, unknown>)) {
        console.log(`skip ${name}: fit sweep found no qualifying threshold on train`);
        continue;
      }
      const [tFit, acc] = fitted[key] as unknown as [number, number, number];
      out.fitted_on_train = { complexity_max: tFit, auto_acc_train: Math.round(acc * 1000) / 1000 } as unknown as Json;
      const atFit = evalAtThreshold(hold, "score", tFit, "le");
      out.holdout_at_fitted = { threshold: tFit, holdout_mae: Math.round(maeH * 1000) / 1000, ...atFit } as unknown as Json;
      const tLock = locked.complexity_max;
      out.holdout_at_locked = { threshold: tLock, ...evalAtThreshold(hold, "score", tLock, "le") } as unknown as Json;
    }

    reportAll.push(out);
    console.log(pyDumpsIndent(tagPythonFloats(out as unknown as Json, new Set(), FLOAT_FIELDS)));
  }

  fs.mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const outPath = path.join(RESULTS,
    `holdout-validation-${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}.json`);
  fs.writeFileSync(outPath, pyDumpsIndent(tagPythonFloats(reportAll as unknown as Json, new Set(), FLOAT_FIELDS)), "utf-8");
  console.log(`\nreport: ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv);
