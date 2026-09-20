/**
 * System-2 output judge — §7.7 rubric via Jev-as-judge (implementation.md v1.5).
 *
 * TypeScript port of the original judge.py. Reviews a story implementation with one
 * batched Jev call:
 *
 *   Gates (Noul, all must pass >= 0.95):
 *     gate_spec           implements exactly what the story specifies
 *     gate_no_regression  does not break existing behavior
 *     gate_security       no security or data-safety violations
 *
 *   Dimensions (Score, 2-10 scale rendered as a 9-level legend; pass >= 7):
 *     dim_correctness     correctness & completeness
 *     dim_quality         code quality / maintainability
 *     dim_tests           test coverage adequacy
 *     dim_bmad            BMAD compliance
 *
 *   Failure taxonomy (Choice — only meaningful when a gate fails):
 *     spec-misread | partial-implementation | regression | architecture-violation
 *     | test-gap | environment | none_applicable | other
 *
 * Verdict: `first_pass` when all gates pass and every dimension >= 7.
 * Otherwise `rework` with the taxonomy to drive the feedback loop; the caller
 * escalates to a human after 2 failed reworks (§7.7). All judgments logged.
 */
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callJev, JevError, tsStamp, pythonRound } from "../evals/harness/jev_client.ts";
import { pyDumps, pyDumpsIndent, tagPythonFloats, PyFloat, type Json, type JsonTable } from "../evals/harness/jev_policy.ts";

const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));
// jev_client.ts ships beside this script (module copies); the canonical
// router pulls it from the evals harness.
const LOCKFILE = `${THIS_DIR}thresholds.lockfile.json`;

/** Threshold from the fitted lockfile, falling back to §7.7 defaults. */
function loadLocked(key: string, defaultPyFloat: number, floatify: boolean): PyFloat | number {
  try {
    if (existsSync(LOCKFILE)) {
      const data = JSON.parse(readFileSync(LOCKFILE, "utf8")) as JsonTable;
      const gates = data["gates"];
      const v = typeof gates === "object" && gates !== null ? (gates as JsonTable)[key] : undefined;
      if (typeof v === "number") return new PyFloat(v); // Python: float(v)
    }
  } catch {
    // unreadable/invalid lockfile: fall through to the default
  }
  return floatify ? new PyFloat(defaultPyFloat) : defaultPyFloat; // Python default keeps its own type
}

export const GATE_THRESHOLDS: Record<string, PyFloat> = {
  gate_spec: loadLocked("judge_gate_spec", 0.95, true) as PyFloat,
  gate_no_regression: loadLocked("judge_gate_no_regression", 0.95, true) as PyFloat,
  gate_security: loadLocked("judge_gate_security", 0.95, true) as PyFloat,
};
// single-gate convenience/back-compat
const GATE_THRESHOLD: PyFloat = GATE_THRESHOLDS["gate_spec"];
const DIM_PASS: PyFloat | number = loadLocked("judge_dim_min", 7, false); // on the 2-10 scale

const DIM_LEGEND = [
  "2 - unacceptable: wrong or missing",
  "3 - poor: major gaps or flaws",
  "4 - below bar: several notable issues",
  "5 - mediocre: meets some expectations",
  "6 - adequate: minor issues only",
  "7 - good: solid, ready with trivial nitpicks",
  "8 - strong: clean and well-considered",
  "9 - excellent: thorough, edge cases handled",
  "10 - exemplary: nothing to improve",
];

export const QUESTIONS: JsonTable = {
  gate_spec: {
    type: "noul",
    instructions: "Judging only from the implementation description: does it satisfy every acceptance criterion in the story, with nothing missing and no substitutions (e.g. a different output format or omitted columns count as unsatisfied)?",
    proposition: "As described, the implementation satisfies the story.",
  },
  gate_no_regression: {
    type: "noul",
    instructions: "Judging only from the implementation description: does it leave all existing behavior intact — no failing or skipped tests, no conflicting features, and no removed functionality are described? Judge the evidence in the text, not what might be hidden.",
    proposition: "As described, existing behavior remains intact.",
  },
  gate_security: {
    type: "noul",
    instructions: "Judging only from the implementation description: is it free of security or data-safety violations — no secret leaks, no unsafe commands, and no weakened validation or auth are described?",
    proposition: "As described, the implementation is free of security or data-safety violations.",
  },
  dim_correctness: {
    type: "score",
    instructions: "Rate correctness and completeness of the implementation against the story (2-10 scale).",
    criteria: DIM_LEGEND,
  },
  dim_quality: {
    type: "score",
    instructions: "Rate code quality and maintainability of the implementation (2-10 scale).",
    criteria: DIM_LEGEND,
  },
  dim_tests: {
    type: "score",
    instructions: "Rate the adequacy of test coverage relative to what the story's risk actually requires (a low-risk change like a rename needs few tests; a multi-tenant isolation change needs many). 2-10 scale.",
    criteria: DIM_LEGEND,
  },
  dim_bmad: {
    type: "score",
    instructions: "Rate BMAD compliance: correct artifacts updated, workflow gates followed, story conventions respected (2-10 scale).",
    criteria: DIM_LEGEND,
  },
  failure_kind: {
    type: "choice",
    instructions: "If any gate failed, classify the primary failure. If all gates passed, choose none_applicable.",
    criteria: {
      "spec-misread": {
        what: "The story requirements were misunderstood or misread",
        not_for: "Requirements were correct but not fully delivered (partial-implementation)",
      },
      "partial-implementation": {
        what: "Some required parts of the story were not implemented",
        not_for: "Delivered parts that break existing behavior (regression)",
      },
      regression: {
        what: "Existing behavior was broken",
        not_for: "New behavior missing (partial-implementation)",
      },
      "architecture-violation": {
        what: "The solution violates documented architecture constraints",
        not_for: "Style or preference disagreements (other)",
      },
      "test-gap": {
        what: "Tests are missing or inadequate for the implemented behavior",
        not_for: "The implementation itself is wrong (spec-misread)",
      },
      environment: {
        what: "Failure caused by environment/build issues, not the implementation",
        not_for: "Bugs in the delivered code (spec-misread)",
      },
      none_applicable: {
        what: "No gate failed",
      },
      other: {
        what: "None of the listed categories fit",
      },
    },
  },
};

function logEntry(entry: JsonTable): void {
  const log = `${THIS_DIR}../evals/logs/judge.jsonl`;
  mkdirSync(log.split("/").slice(0, -1).join("/"), { recursive: true });
  appendFileSync(log, pyDumps(tagPythonFloats(entry) as never) + "\n", "utf8");
}

/** Map the 0-8 raw score position onto the 2-10 scale. */
function to210(raw: number): number {
  return raw + 2;
}

/** Python str() of a number the way this module holds it (floats keep ".0"). */
function pyStrNum(v: PyFloat | number): string {
  const n = v instanceof PyFloat ? v.v : v;
  if (v instanceof PyFloat) return Number.isInteger(n) ? `${n}.0` : String(n);
  return Number.isInteger(n) ? String(n) : String(n);
}

interface JudgeResult {
  verdict: "first_pass" | "rework";
  failure_kind: string | null;
  gates_failed: string[];
  reasons: string[];
  dimensions: JsonTable;
  gate_nouls: JsonTable;
  latency_ms: number;
}

/** Judge one (story, implementation) pair against the §7.7 rubric. */
export async function judge(
  storyText: string,
  implementationText: string,
  log = true,
  agentId = "default",
): Promise<JudgeResult> {
  const state =
    `User story:\n"""\n${storyText}\n"""\n\n` +
    `Implementation (code/diff/description):\n"""\n${implementationText}\n"""`;
  const t0 = performance.now();
  const resp = await callJev(QUESTIONS, state);
  const a = resp["answers"] as JsonTable;

  const reasons: string[] = [];
  const gatesFailed: string[] = [];
  const gateNouls: JsonTable = {};
  for (const gate of ["gate_spec", "gate_no_regression", "gate_security"]) {
    const p = (a[gate] as JsonTable)["noul"] as number;
    const thr = GATE_THRESHOLDS[gate];
    if (p < thr.v) {
      gatesFailed.push(gate);
      reasons.push(`${gate} noul ${p.toFixed(2)} < ${pyStrNum(thr)}`);
    }
    gateNouls[gate] = new PyFloat(p);
  }

  const dims: JsonTable = {};
  for (const dim of ["dim_correctness", "dim_quality", "dim_tests", "dim_bmad"]) {
    const v = to210((a[dim] as JsonTable)["score"] as number);
    const rounded = pythonRound(v, 2);
    dims[dim] = { score_210: new PyFloat(rounded), confidence: (a[dim] as JsonTable)["confidence"] as Json };
    if (v < (DIM_PASS instanceof PyFloat ? DIM_PASS.v : DIM_PASS)) {
      gatesFailed.push(dim);
      reasons.push(`${dim} ${v.toFixed(1)} < ${pyStrNum(DIM_PASS)} (2-10 scale)`);
    }
  }

  const verdict: "rework" | "first_pass" = gatesFailed.length > 0 ? "rework" : "first_pass";
  let failureKind: string | null = null;
  if (verdict === "rework") {
    failureKind = (a["failure_kind"] as JsonTable)["choice"] as string;
    if (failureKind === "none_applicable") failureKind = "other";
  }

  const latencyMs = pythonRound(performance.now() - t0, 1);
  const entry: JsonTable = {
    ts: tsStamp(),
    agent_id: agentId,
    verdict,
    failure_kind: failureKind,
    gates_failed: gatesFailed,
    reasons,
    dimensions: dims,
    gate_nouls: gateNouls,
    story: storyText.slice(0, 300),
    model_resolved: (resp["model"] ?? null) as Json,
    usage: (resp["usage"] ?? null) as Json,
    latency_ms: new PyFloat(latencyMs),
  };
  if (log) logEntry(entry);

  const dimensionScores: JsonTable = {};
  for (const [k, v] of Object.entries(dims)) dimensionScores[k] = (v as JsonTable)["score_210"];
  return {
    verdict,
    failure_kind: failureKind,
    gates_failed: gatesFailed,
    reasons,
    dimensions: dimensionScores,
    gate_nouls: gateNouls,
    latency_ms: latencyMs,
  };
}

function emitIndent(obj: unknown): void {
  process.stdout.write(pyDumpsIndent(tagPythonFloats(obj), 2) + "\n");
}

function degrade(reasonKind: string, reason: string): void {
  /** Defined unavailable status — JSON, never a traceback (adapter contract). */
  try {
    emitIndent({
      status: "unavailable",
      reason_kind: reasonKind,
      reason: reason.slice(0, 300),
      passed: null,
    });
  } catch {
    // BrokenPipeError equivalent: ignore
  }
}

async function main(): Promise<number> {
  if (process.argv.length < 4) {
    emitIndent({
      status: "bad_request",
      reason_kind: "usage",
      reason: "usage: judge.ts <story_text> <implementation_text>",
      passed: null,
    });
    return 2;
  }
  try {
    emitIndent(await judge(process.argv[2], process.argv[3]));
    return 0;
  } catch (error) {
    if (error instanceof JevError) {
      degrade(error.message.toUpperCase().includes("API_KEY") ? "missing_api_key" : "provider_error", error.message);
    } else {
      degrade("internal_error", `${(error as Error).name}: ${(error as Error).message}`);
    }
    return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exitCode = code;
}
