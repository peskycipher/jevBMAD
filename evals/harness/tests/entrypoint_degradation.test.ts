#!/usr/bin/env node
// Entrypoint degradation contract (adapter convention, repo-wide).
//
// Every Jev entry point must return explicit status JSON — never a traceback —
// when the provider is unavailable (missing OPENROUTER_API_KEY, HTTP errors).
// Exit code 0: an unavailable outcome is a defined status, not a crash.
// Mirrors jev_adapter.JevResult / jev_recommend status semantics.
//
// Run: npx tsx evals/harness/tests/test_entrypoint_degradation.ts

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { assertEq, assertIn, assertTrue, test, runAll } from "./_harness.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

interface Case {
  label: string;
  script: string;   // ROOT-relative .ts path
  args: string[];
  stdin: string | null;
  statusKey: string;
}

// (label, script, args, stdin, expected status key)
const CASES: Case[] = [
  { label: "router.ts", script: "router/router.ts", args: ["test request"], stdin: null, statusKey: "routing_decision" },
  { label: "hybrid.ts", script: "router/hybrid.ts", args: ["test request"], stdin: null, statusKey: "routing_decision" },
  { label: "bmad_gates.ts", script: "router/bmad_gates.ts", args: ["planning_to_solutioning"], stdin: "spec text\n", statusKey: "decision" },
  { label: "judge.ts", script: "router/judge.ts", args: ["/dev/null", "/dev/null"], stdin: null, statusKey: "passed" },
  { label: "module gates copy", script: "modules/bmad-jev/bmad-jev-gates/scripts/bmad_gates.ts",
    args: ["planning_to_solutioning"], stdin: "spec text\n", statusKey: "decision" },
  { label: "module judge copy", script: "modules/bmad-jev/bmad-jev-review/scripts/judge.ts",
    args: ["/dev/null", "/dev/null"], stdin: null, statusKey: "passed" },
  { label: "canonical recommend", script: "_bmad/custom/bmad-jev/jev_recommend.ts",
    args: ["--request", "test", "--candidates", "a,b"], stdin: null, statusKey: "status" },
];

interface UsageCase {
  label: string;
  script: string;
  args: string[];
  stdin: string | null;
}

const USAGE_CASES: UsageCase[] = [
  { label: "judge.ts no args", script: "router/judge.ts", args: [], stdin: null },
  { label: "bmad_gates.ts empty input", script: "router/bmad_gates.ts", args: [], stdin: "" },
];

function run(argv: string[], stdinText: string | null, extraEnv?: Record<string, string>) {
  // Force provider-unavailable: both keys set (empty) so no .env file can
  // supply a credential — real environment variables always win.
  const env = { ...process.env, OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "", ...extraEnv };
  return spawnSync(process.execPath, [TSX, ...argv], {
    input: stdinText === null ? undefined : stdinText,
    encoding: "utf8", env, cwd: ROOT, timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function parseJson(label: string, stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not emit JSON on stdout: ${JSON.stringify(stdout)}`);
  }
}

test("no traceback, explicit status, exit zero on provider outage", () => {
  for (const c of CASES) {
    const proc = run([c.script, ...c.args], c.stdin);
    assertTrue(!proc.stderr!.includes("Traceback"), `${c.label} leaked a traceback:\n${proc.stderr}`);
    assertEq(proc.status, 0, `${c.label} should exit 0 on a defined unavailable status (stderr: ${proc.stderr?.slice(0, 300)})`);
    const data = parseJson(c.label, proc.stdout!);
    assertTrue(["unavailable", "disabled"].includes(data.status),
      `${c.label} should report an unavailable/disabled status, got ${data.status}`);
    assertTrue("reason_kind" in data, `${c.label} should carry a machine-readable reason_kind`);
  }
});

test("recommend too many candidates: bad request, exit 2", () => {
  // Regression: build_recommend_questions raised an uncaught PolicyError
  // (>MAX_CANDIDATES) after the degrade handlers — raw traceback instead of
  // JSON. The adapter must degrade to bad_request / exit 2.
  const proc = run(["_bmad/custom/bmad-jev/jev_recommend.ts", "--request", "t",
    "--candidates", "a,b,c,d,e,f,g,h,i"],
    null, { BMAD_DECISION_ASSIST_MODE: "suggest", TYPESAFE_API_KEY: "test" });
  assertTrue(!proc.stderr!.includes("Traceback"), `traceback:\n${proc.stderr}`);
  const data = parseJson("recommend", proc.stdout!);
  assertEq(data.status, "bad_request");
  assertEq(data.reason_kind, "usage");
  assertEq(proc.status, 2);
  assertEq(data.calls_made, 0);
});

test("usage errors report bad_request, exit 2", () => {
  // usage errors are caller mistakes, not provider outages
  for (const c of USAGE_CASES) {
    const proc = run([c.script, ...c.args], c.stdin);
    assertTrue(!proc.stderr!.includes("Traceback"), `${c.label} leaked a traceback:\n${proc.stderr}`);
    const data = parseJson(c.label, proc.stdout!);
    assertEq(data.status, "bad_request", `${c.label} should report a caller error, not an outage`);
    assertEq(data.reason_kind, "usage");
    assertEq(proc.status, 2);
  }
});

test("closed stdin degrades, no crash", () => {
  // stdin is closed when fd 0 is closed — handler must still emit JSON
  for (const [label, script, args] of [
    ["bmad_gates.ts", "router/bmad_gates.ts", ["spec text", "planning_to_solutioning"]],
    ["router.ts", "router/router.ts", ["test request"]],
  ] as Array<[string, string, string[]]>) {
    const env = { ...process.env, OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "" };
    const proc = spawnSync(process.execPath, [TSX, script, ...args], {
      encoding: "utf8", env, cwd: ROOT, timeout: 120_000, stdin: "ignore" as never,
    } as never);
    assertTrue(!proc.stderr!.includes("Traceback"), `${label} leaked a traceback:\n${proc.stderr}`);
    const data = parseJson(label, proc.stdout!);
    assertEq(data.status, "unavailable");
  }
});

await runAll();
