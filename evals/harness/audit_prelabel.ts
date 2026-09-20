#!/usr/bin/env node
// Audit Jev pre-label proposals against author-intended labels (§7.6).
//
// For each queue row: if the proposal matches the author's intended label,
// approve it (final_labels = intended). Otherwise drop it (approved stays
// false) with a note — ambiguous candidates must not enter the golden set.
//
// Usage:
//   npx tsx evals/harness/audit_prelabel.ts            # audit + rewrite queue
//   npx tsx evals/harness/audit_prelabel.ts --report  # stats only
import * as fs from "node:fs";
import * as path from "node:path";
import { pyDumps, pyDumpsIndent } from "./jev_policy.ts";

const HERE = path.dirname(path.resolve(import.meta.url.replace(/^file:\/\//, "")));
const CANDIDATES = path.resolve(HERE, "..", "candidates");
const QUEUE = path.resolve(HERE, "..", "audit", "prelabel_queue.jsonl");

function main(argv: string[]): void {
  const reportOnly = argv.includes("--report");

  const intended = new Map<string, unknown>();
  for (const cfile of fs.readdirSync(CANDIDATES).sort()) {
    if (!cfile.endsWith(".candidates.jsonl")) continue;
    for (const l of fs.readFileSync(path.join(CANDIDATES, cfile), "utf-8").split("\n")) {
      if (l.trim()) {
        const row = JSON.parse(l);
        intended.set(row.state, row.intended); // states are unique across sets
      }
    }
  }

  const rows = fs.readFileSync(QUEUE, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const stats: Record<string, { total: number; agree: number; drop: number; no_intent: number }> = {};
  const outRows: any[] = [];
  for (const row of rows) {
    const intent = intended.get(row.state);
    const s = (stats[row.set] ??= { total: 0, agree: 0, drop: 0, no_intent: 0 });
    s.total += 1;
    if (intent === undefined) {
      s.no_intent += 1;
      outRows.push(row);
      continue;
    }
    const agree = Object.entries(intent as Record<string, unknown>).every(
      ([k, v]) => (row.proposed_labels as Record<string, unknown>)[k] === v,
    );
    if (agree) {
      s.agree += 1;
      if (!reportOnly) {
        row.approved = true;
        row.final_labels = intent;
        row.audit = "proposal matches author intent";
      }
    } else {
      s.drop += 1;
      if (!reportOnly) {
        row.audit = `DROPPED: proposed ${pyDumps(row.proposed_labels)} `
          + `vs intended ${pyDumps(intent as never)} — ambiguous candidate`;
      }
    }
    outRows.push(row);
  }

  console.log(pyDumpsIndent(stats as never));
  for (const [setName, s] of Object.entries(stats)) {
    if (s.total) {
      const denom = Math.max(1, s.total - s.no_intent);
      console.log(`${setName}: agreement ${s.agree}/${s.total - s.no_intent} `
        + `(${(s.agree / denom * 100).toFixed(1)}%)`);
    }
  }
  if (!reportOnly) {
    fs.writeFileSync(QUEUE, outRows.map((r) => pyDumps(r) + "\n").join(""), "utf-8");
    console.log(`queue rewritten: ${QUEUE}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
