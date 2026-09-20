#!/usr/bin/env node
// Golden-set ↔ runtime question sync (docs.typesafe.ai primitives/advanced).
//
// Runtime QUESTIONS and the eval'd golden-set criteria.json must stay
// IDENTICAL: if they drift, the eval validates a different payload than the
// one production sends, silently invalidating the thresholds and baseline.
// Also asserts EntryType shape conformance (string | object | array | null)
// and that every golden label is a supplied Choice option key — labels are
// matched against keys, so a renamed option would orphan the golden labels.
//
// Run: npx tsx evals/harness/tests/test_questions_golden_sync.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { QUESTIONS as GATES_QUESTIONS } from "../../../router/bmad_gates.ts";
import { QUESTIONS as JUDGE_QUESTIONS } from "../../../router/judge.ts";
import { assertEq, assertTrue, test, runAll } from "./_harness.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SET_DIR = path.join(ROOT, "evals", "golden-sets");

interface Question { [k: string]: unknown; type?: unknown; criteria?: unknown; instructions?: unknown }

function questionsOf(setName: string): Record<string, Question> {
  return JSON.parse(fs.readFileSync(path.join(SET_DIR, setName, "criteria.json"), "utf-8"))["questions"];
}

/** Module copies differ from router copies only in the import-path
 *  bootstrap (bundled layout), a ships-beside comment, and the `export`
 *  keyword on internal constants — normalize all three. */
function normalized(relPath: string): string {
  const lines: string[] = [];
  for (const line of fs.readFileSync(path.join(ROOT, relPath), "utf-8").split("\n")) {
    let l = line;
    if (/^import .* from "(\.\/(jev_client|jev_policy|config)|\.\.\/evals\/harness\/(jev_client|jev_policy))\.ts";?$/.test(l.trim())) {
      l = l.replace(/from "[^"]+"/, 'from "<copy>"');
    }
    if (/^\/\//.test(l.trim()) && (l.includes("ships beside this script") || l.includes("the evals harness"))) continue;
    if (/^\s*export const GATE_THRESHOLDS/.test(l)) l = l.replace("export ", "");
    lines.push(l);
  }
  return lines.join("\n");
}

function goldenLabels(setName: string): Set<string> {
  const labels = new Set<string>();
  for (const line of fs.readFileSync(path.join(SET_DIR, setName, `${setName}.golden.jsonl`), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const ex = JSON.parse(line);
    for (const v of Object.values(ex.labels ?? {})) if (v !== null && v !== undefined) labels.add(String(v));
  }
  return labels;
}

test("bmad_gates QUESTIONS match the readiness golden set", () => {
  // Golden readiness questions must appear in runtime QUESTIONS (subset —
  // the runtime additionally asks blocker_kind).
  const golden = questionsOf("readiness");
  const gateQ = GATES_QUESTIONS as Record<string, Question>;
  for (const qid of Object.keys(golden)) {
    assertTrue(qid in gateQ, `runtime QUESTIONS missing golden questions: ${qid}`);
    assertEq(JSON.stringify(gateQ[qid]), JSON.stringify(golden[qid]),
      `runtime QUESTIONS[${qid}] drifted from readiness golden`);
  }
});

test("bmad_gates QUESTIONS cover all gate questions", () => {
  // Regression: b67e9fb silently dropped blocker_kind from QUESTIONS — the
  // readiness gate must ask every question its verdict path reads.
  const expected = new Set([...Object.keys(questionsOf("readiness")), "blocker_kind"]);
  assertEq(JSON.stringify([...Object.keys(GATES_QUESTIONS as object)].sort()),
    JSON.stringify([...expected].sort()));
});

test("bmad_gates router/module copies are identical", () => {
  const routerSrc = normalized("router/bmad_gates.ts");
  const moduleSrc = normalized("modules/bmad-jev/bmad-jev-gates/scripts/bmad_gates.ts");
  assertEq(routerSrc, moduleSrc, "router/bmad_gates.ts and the module copy diverged");
});

test("judge router/module copies are identical", () => {
  const routerSrc = normalized("router/judge.ts");
  const moduleSrc = normalized("modules/bmad-jev/bmad-jev-review/scripts/judge.ts");
  assertEq(routerSrc, moduleSrc, "router/judge.ts and the module copy diverged");
});

test("judge failure_kind options cover golden labels", () => {
  const judgeQ = JUDGE_QUESTIONS as Record<string, Question>;
  const options = new Set(Object.keys(judgeQ["failure_kind"]["criteria"] as object));
  const labels = new Set<string>();
  for (const line of fs.readFileSync(path.join(SET_DIR, "story_review", "story_review.golden.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const ex = JSON.parse(line);
    const fk = ex.failure_kind ?? (ex.labels ?? {})["failure_kind"];
    if (fk) labels.add(fk);
  }
  assertTrue(labels.size > 0, "no failure_kind labels found in story_review golden");
  const missing = [...labels].filter((l) => !options.has(l));
  assertTrue(missing.length === 0, `golden failure_kind labels not in judge options: ${missing}`);
});

test("golden labels are supplied choice options", () => {
  const qs = questionsOf("routing");
  for (const line of fs.readFileSync(path.join(SET_DIR, "routing", "routing.golden.jsonl"), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const ex = JSON.parse(line);
    for (const [qid, label] of Object.entries(ex.labels ?? {})) {
      const options = new Set(Object.keys((qs[qid].criteria ?? {}) as object));
      assertTrue(options.has(String(label)),
        `routing/${ex.id}: label ${JSON.stringify(label)} not a supplied option of ${qid}`);
    }
  }
});

class EntryTypeShape {
  static *iterQuestions(): Generator<[string, string, Question]> {
    for (const setDir of fs.readdirSync(SET_DIR).sort()) {
      const cf = path.join(SET_DIR, setDir, "criteria.json");
      if (!fs.existsSync(cf)) continue;
      const qs = JSON.parse(fs.readFileSync(cf, "utf-8"))["questions"] as Record<string, Question>;
      for (const [qid, q] of Object.entries(qs)) yield [setDir, qid, q];
    }
  }
  static isEntry(v: unknown): boolean {
    return v === null || typeof v === "string" || typeof v === "object";
  }
}

test("noul criteria is true/false boundary", () => {
  for (const [setName, qid, q] of EntryTypeShape.iterQuestions()) {
    if (q.type !== "noul" || q.criteria === undefined || q.criteria === null) continue;
    const crit = q.criteria as Record<string, unknown>;
    assertEq(JSON.stringify(Object.keys(crit).sort()), JSON.stringify(["false", "true"]),
      `${setName}/${qid}: noul criteria keys must be true/false`);
    for (const [side, v] of Object.entries(crit)) {
      assertTrue(EntryTypeShape.isEntry(v), `${setName}/${qid}.criteria.${side}: bad EntryType`);
    }
  }
});

test("score criteria entries are str or dict", () => {
  for (const [setName, qid, q] of EntryTypeShape.iterQuestions()) {
    if (q.type !== "score") continue;
    const crit = q.criteria as unknown[];
    assertTrue(Array.isArray(crit), `${setName}/${qid}: score criteria must be a list`);
    assertTrue(crit.length >= 2, `${setName}/${qid}: score needs >= 2 levels`);
    crit.forEach((entry, i) => {
      assertTrue(typeof entry === "string" || (entry !== null && typeof entry === "object" && !Array.isArray(entry)),
        `${setName}/${qid}.criteria[${i}]: bad EntryType`);
    });
  }
});

test("choice criteria is object of entrytypes", () => {
  for (const [setName, qid, q] of EntryTypeShape.iterQuestions()) {
    if (q.type !== "choice") continue;
    const crit = q.criteria as Record<string, unknown>;
    assertTrue(crit !== null && typeof crit === "object" && !Array.isArray(crit),
      `${setName}/${qid}: choice criteria must be an object`);
    for (const [opt, desc] of Object.entries(crit)) {
      assertTrue(EntryTypeShape.isEntry(desc), `${setName}/${qid}.criteria.${opt}: bad EntryType`);
    }
  }
});

test("instructions are entrytypes", () => {
  for (const [, qid, q] of EntryTypeShape.iterQuestions()) {
    const ins = q.instructions;
    assertTrue(ins === undefined || ins === null || typeof ins === "string" || typeof ins === "object",
      `${qid}: instructions bad EntryType`);
  }
});

await runAll();
