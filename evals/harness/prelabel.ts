#!/usr/bin/env node
// Jev-assisted golden-set pre-labeling (implementation.md §7.6, Phase 3).
//
// The scalable path to >=100 labeled examples per set (§6): propose labels with
// Jev, queue for human confirmation (~audit), then promote approved rows.
//
//   1. `--generate <set> <candidates.jsonl>` — candidates are {"state": ...}
//      rows; Jev proposes a label per question using the set's criteria.
//      Proposals land in evals/audit/prelabel_queue.jsonl with "approved": false.
//   2. A human edits the queue, setting "approved": true and fixing labels.
//   3. `--promote <set>` — approved rows are appended to the golden set with a
//      `source: "jev-prelabel+human-confirm"` provenance field.
//
// Usage:
//   npx tsx evals/harness/prelabel.ts --generate routing candidates.jsonl
//   npx tsx evals/harness/prelabel.ts --promote routing
import * as fs from "node:fs";
import * as path from "node:path";
import { callJev, pythonRound } from "./jev_client.ts";
import { pyDumps } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const GOLDEN = path.resolve(HERE, "..", "golden-sets");
const AUDIT = path.resolve(HERE, "..", "audit");
const QUEUE = path.resolve(AUDIT, "prelabel_queue.jsonl");

const USAGE = `Jev-assisted golden-set pre-labeling (implementation.md §7.6, Phase 3).

The scalable path to >=100 labeled examples per set (§6): propose labels with
Jev, queue for human confirmation (~audit), then promote approved rows.

  1. \`--generate <set> <candidates.jsonl>\` — candidates are {"state": ...}
     rows; Jev proposes a label per question using the set's criteria.
     Proposals land in evals/audit/prelabel_queue.jsonl with "approved": false.
  2. A human edits the queue, setting "approved": true and fixing labels.
  3. \`--promote <set>\` — approved rows are appended to the golden set with a
     \`source: "jev-prelabel+human-confirm"\` provenance field.

Usage:
  python3 evals/harness/prelabel.py --generate routing candidates.jsonl
  python3 evals/harness/prelabel.py --promote routing

`;

async function generate(setName: string, candidatesPath: string): Promise<void> {
  const setDir = path.join(GOLDEN, setName);
  const questions = JSON.parse(fs.readFileSync(path.join(setDir, "criteria.json"), "utf-8")).questions;
  const candidates = fs.readFileSync(candidatesPath, "utf-8").split("\n")
    .filter((l) => l.trim()).map((l) => JSON.parse(l));
  fs.mkdirSync(AUDIT, { recursive: true });
  let n = 0;
  let out = "";
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const resp = (await callJev(questions, cand.state)) as unknown as { answers: Record<string, any> };
    const labels: Record<string, unknown> = {};
    for (const [qid, ans] of Object.entries(resp.answers)) {
      if (ans.type === "noul") labels[qid] = ans.noul >= 0.5 ? 1 : 0;
      else if (ans.type === "choice") labels[qid] = ans.choice;
      else labels[qid] = pythonRound(ans.score, 0); // score: nearest level
    }
    // ns-precision: second-resolution IDs collided across runs in the same second
    const ns = process.hrtime.bigint();
    const row = { set: setName, id: `${setName}-pre-${ns}-${i}`,
      state: cand.state, proposed_labels: labels,
      answers: resp.answers, approved: false,
      final_labels: null };
    out += pyDumps(row as never) + "\n";
    n += 1;
  }
  fs.appendFileSync(QUEUE, out, "utf-8");
  console.log(`queued ${n} proposals -> ${QUEUE} (human review required before promote)`);
}

function promote(setName: string): void {
  const setDir = path.join(GOLDEN, setName);
  const goldenPath = path.join(setDir, `${setName}.golden.jsonl`);
  const existing = fs.readFileSync(goldenPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const existingIds = new Set(existing.map((r: any) => r.id));
  const existingStates = new Set(existing.map((r: any) => r.state)); // dedupe by content, not just id
  const queue = fs.readFileSync(QUEUE, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let promoted = 0;
  let out = "";
  for (const row of queue) {
    if (row.set !== setName || !row.approved) continue;
    if (existingIds.has(row.id) || existingStates.has(row.state)) continue; // id or duplicate content already in the set
    const labels = row.final_labels ?? row.proposed_labels;
    out += pyDumps({ id: row.id, state: row.state, labels, source: "jev-prelabel+human-confirm" } as never) + "\n";
    existingIds.add(row.id);
    promoted += 1;
  }
  fs.appendFileSync(goldenPath, out, "utf-8");
  console.log(`promoted ${promoted} approved examples into ${goldenPath}`);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--generate")) {
    const i = argv.indexOf("--generate");
    await generate(argv[i + 1], path.resolve(argv[i + 2]));
  } else if (argv.includes("--promote")) {
    promote(argv[argv.indexOf("--promote") + 1]);
  } else {
    process.stderr.write(USAGE);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
