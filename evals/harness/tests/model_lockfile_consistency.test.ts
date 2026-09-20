#!/usr/bin/env node
// System-1 model pin ↔ lockfile consistency (implementation.md §6).
//
// The fitted thresholds in router/thresholds.lockfile.json are valid only for
// the model they were fitted on (model_resolved). Every live jev_client /
// jev_adapter copy must pin exactly that model, and it must be a dated
// snapshot — a floating alias here silently invalidates the thresholds.
//
// Run: npx tsx evals/harness/tests/test_model_lockfile_consistency.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { assertEq, assertTrue, test, runAll } from "./_harness.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const LOCKFILE = path.join(ROOT, "router", "thresholds.lockfile.json");

// every live copy that sends requests to the Decisions API
const CLIENTS = [
  "evals/harness/jev_client.ts",
  "modules/bmad-jev/bmad-jev-gates/scripts/jev_client.ts",
  "modules/bmad-jev/bmad-jev-review/scripts/jev_client.ts",
  "_bmad/custom/bmad-jev/jev_client.ts",
  "_bmad/custom/bmad-jev/jev_adapter.ts",
];

const DATED = /^typesafe\/jev-[\w.]+-\d{8}$/;

function pinOf(relPath: string): string | null {
  const src = fs.readFileSync(path.join(ROOT, relPath), "utf-8");
  const m = /DEFAULT_MODEL\s*=\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

test("lockfile model is a dated snapshot", () => {
  const model = JSON.parse(fs.readFileSync(LOCKFILE, "utf-8"))["model_resolved"];
  assertTrue(DATED.test(model),
    `lockfile model_resolved must be a pinned dated snapshot, got ${model}`);
});

test("every live client pins the lockfile model", () => {
  const model = JSON.parse(fs.readFileSync(LOCKFILE, "utf-8"))["model_resolved"];
  for (const relPath of CLIENTS) {
    assertEq(pinOf(relPath), model,
      `${relPath} DEFAULT_MODEL drifted from lockfile ${model}`);
  }
});

await runAll();
