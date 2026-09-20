#!/usr/bin/env node
// Online sampling pipeline (implementation.md §7.3 asset 3, §7.6).
//
// Continuously evaluates production routing decisions from the decision logs:
//
//   1. Sample `online_sample_rate` of routing decisions (§10: 5%).
//   2. Jev-as-judge hindsight review (§7.6 "routing overrides" row): a fresh
//      Noul question — "was the System-1 decision correct in hindsight?" —
//      judged from the request, decision, and reasons.
//   3. Route ~3% (min 1) of the judged samples to the human audit queue
//      (§10 judging config), deduplicated across runs.
//   4. Memory relevance loop (§7.2/§7.5): Score the Graft context relevance of
//      sampled memory-backed decisions (target >= 80% => >= 3.2 on a 0-4 scale).
//   5. Append a dated snapshot to production_metrics.json for drift tracking.
//
// Usage:
//   npx tsx evals/harness/online_sample.ts [log.jsonl] [--rate 0.05]
import * as fs from "node:fs";
import * as path from "node:path";
import { callJev, pyStamp } from "./jev_client.ts";
import { pyDumps, pyDumpsIndent, tagPythonFloats, type Json, neumaierSum } from "./jev_policy.ts";
import { PyRandom } from "./holdout_validate.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const RESULTS = path.resolve(HERE, "..", "results");
const AUDIT = path.resolve(HERE, "..", "audit");
const DEFAULT_LOG = path.resolve(HERE, "..", "logs", "routing.jsonl");

const HINDSIGHT_QUESTIONS: Record<string, any> = {
  decision_correct: {
    type: "noul",
    instructions: "Given the user request, the routing decision made, and the reasons recorded, was the decision the correct call? Judge the reasoning against the request.",
    proposition: "The routing decision was correct for this request.",
  },
  failure_kind: {
    type: "choice",
    instructions: "If the decision was wrong, classify the primary routing error. If correct, choose none_applicable.",
    criteria: {
      over_escalation: "A simple request was sent to System 2 unnecessarily",
      under_escalation: "A risky or complex request was auto-executed",
      wrong_intent: "The request was misunderstood or misclassified",
      threshold_miscalibrated: "The decision was right in kind but the thresholds fired wrongly",
      none_applicable: "The decision was correct",
      other: "None of the listed categories fit",
    },
  },
};

const MEMORY_RELEVANCE_QUESTIONS: Record<string, any> = {
  context_relevance: {
    type: "score",
    instructions: "Rate how relevant the retrieved project context is to answering the request (0-4).",
    criteria: [
      "0 - irrelevant: context has nothing to do with the request",
      "1 - barely relevant: a passing mention at most",
      "2 - partially relevant: touches the same area but misses the point",
      "3 - relevant: directly informs the request",
      "4 - essential: the request cannot be answered well without it",
    ],
  },
};

async function hindsight(reviewText: string): Promise<Record<string, unknown>> {
  const resp = await callJev(HINDSIGHT_QUESTIONS, `Routing decision review:\n"""\n${reviewText}\n"""`);
  const a = resp.answers as Record<string, any>;
  const correct = a.decision_correct.noul >= 0.5;
  const kind = correct ? null : a.failure_kind.choice;
  return { correct, noul: a.decision_correct.noul, failure_kind: kind };
}

async function relevance(request: string, context: string): Promise<number> {
  const state = `User request:\n${request}\n\nRetrieved project context:\n"""\n${context.slice(0, 3000)}\n"""`;
  const resp = await callJev(MEMORY_RELEVANCE_QUESTIONS, state);
  return (resp.answers as Record<string, any>).context_relevance.score;
}

async function main(argv: string[]): Promise<void> {
  const logPath = argv.length > 2 && !argv[2].startsWith("--") ? argv[2] : DEFAULT_LOG;
  let rate = 0.05;
  if (argv.includes("--rate")) rate = parseFloat(argv[argv.indexOf("--rate") + 1]);
  // Sampling seed: random per run so continuous sampling eventually covers the
  // whole log; pass --seed 42 for a reproducible sample. Recorded in the snapshot.
  const seedArg = argv.includes("--seed") ? parseInt(argv[argv.indexOf("--seed") + 1], 10) : null;
  const seed = seedArg !== null ? seedArg : Math.floor(Date.now() / 1000);

  const entries = fs.readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const rng = new PyRandom(seed);
  const sample = entries.length ? rng.sample(entries, Math.max(1, Math.trunc(entries.length * rate))) : [];

  const judged: Record<string, Json>[] = [];
  for (const e of sample) {
    const review = `Request: ${e.request}\nDecision: ${e.decision}\n`
      + `Needs review flag: ${e.needs_review === true ? "True" : e.needs_review === false ? "False" : "None"}\n`
      + `Intent: ${e.intent.choice} (confidence ${e.intent.confidence})\n`
      + `Safety noul: ${e.safe_auto.noul}\n`
      + `Complexity score: ${e.complexity.score}\n`
      + `Reasons: [${(e.reasons as unknown as string[]).map((s) => `'${s}'`).join(", ")}]`;
    const h = await hindsight(review);
    judged.push({
      ts: e.ts, request: e.request, decision: e.decision,
      jev_hindsight_correct: h.correct, hindsight_noul: h.noul as unknown as Json,
      failure_kind: (h.failure_kind ?? null) as unknown as Json,
    } as unknown as Record<string, Json>);
  }

  // memory relevance on memory-backed samples
  const relevanceScores: number[] = [];
  for (const e of sample) {
    const excerpt = (e.memory ?? {}).graft_excerpt ?? "";
    if (excerpt) {
      try {
        relevanceScores.push(await relevance(e.request, excerpt));
      } catch {
        // degraded: relevance is best-effort
      }
    }
  }

  // ~3% of the SAMPLE (not the log — the sample is what was judged), min 1
  // (§10 judging config); drawn randomly, not the first N.
  const humanAuditN = sample.length ? Math.max(1, Math.round(sample.length * 0.03)) : 0;
  const rng2 = new PyRandom(seed);
  const auditRows = judged.length && humanAuditN
    ? rng2.sample(judged, Math.min(humanAuditN, judged.length)) : [];

  fs.mkdirSync(AUDIT, { recursive: true });
  const q = path.join(AUDIT, "human_audit_queue.jsonl");
  const existingAudit = new Set<string>();
  if (fs.existsSync(q)) {
    for (const l of fs.readFileSync(q, "utf-8").split("\n")) {
      if (!l.trim()) continue;
      const prev = JSON.parse(l);
      existingAudit.add(`${prev.ts ?? null}\u0000${prev.request ?? null}`);
    }
  }
  let nQueued = 0;
  const lines: string[] = [];
  for (const r of auditRows) {
    if (existingAudit.has(`${r.ts ?? null}\u0000${r.request ?? null}`)) {
      continue; // already queued by a previous run — never duplicate
    }
    lines.push(pyDumps({ ...r, audit: "confirm_or_reject_routing" } as unknown as Json));
    nQueued += 1;
  }
  // Python opens the queue in append mode unconditionally (creating an empty
  // file on first run) — mirror that side effect.
  fs.appendFileSync(q, lines.length ? lines.join("\n") + "\n" : "", "utf-8");

  const snapshot: Record<string, Json> = {
    ts: pyStamp("%Y-%m-%dT%H:%M:%S%z"),
    log: logPath,
    log_size: entries.length,
    sample_rate: rate,
    sample_seed: seed,
    n_sampled: sample.length,
    hindsight_agreement: judged.length
      ? (neumaierSum(judged.map((r) => (r.jev_hindsight_correct ? 1 : 0))) / judged.length) as unknown as Json
      : null,
    human_audit_queued: nQueued,
    memory_relevance_mean: relevanceScores.length
      ? (neumaierSum(relevanceScores) / relevanceScores.length) as unknown as Json
      : null,
    memory_relevance_target: 3.2, // 80% of 0-4 scale (§7.5)
  };

  const metricsPath = path.join(RESULTS, "production_metrics.json");
  const metrics: any[] = fs.existsSync(metricsPath) ? JSON.parse(fs.readFileSync(metricsPath, "utf-8")) : [];
  metrics.push(snapshot);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(metricsPath, pyDumpsIndent(tagPythonFloats(metrics as unknown as Json, new Set(),
    new Set(["hindsight_agreement", "memory_relevance_mean"]))) as unknown as string, "utf-8");

  console.log(pyDumpsIndent(tagPythonFloats(snapshot as unknown as Json, new Set(),
    new Set(["hindsight_agreement", "memory_relevance_mean"]))));
  console.log(`audit queue: ${q} (+${nQueued} rows, ${auditRows.length} selected)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv);
