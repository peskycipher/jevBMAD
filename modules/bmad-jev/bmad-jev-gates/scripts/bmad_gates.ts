/**
 * BMAD phase-transition readiness gates (implementation.md §9, Phase 2).
 *
 * TypeScript port of bmad_gates.py. Maps the hybrid routing onto the BMAD
 * workflow (Analysis → Planning → Solutioning → Implementation): before a
 * phase transition, one batched Jev call evaluates the upstream artifact on
 * four atomic questions:
 *
 *   spec_specific          (noul)  requirements are concrete, not vague
 *   requirements_testable (noul)  acceptance criteria are verifiable
 *   no_blockers            (noul)  no unresolved blocking questions/decisions
 *   ready_score            (score) overall readiness 0-4
 *
 *   blocker_kind           (choice) why it is NOT ready — only meaningful when
 *                                   a gate fails; `none_applicable` otherwise.
 *
 * Policy (conservative, §6/§10): proceed only when all three noul gates clear
 * 0.90 AND ready_score >= 3.0. Any failure yields `hold` with the blocker
 * taxonomy for the rework loop. Every decision is logged.
 */
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callJev, JevError, tsStamp, pythonRound } from "./jev_client.ts";
import { pyDumps, pyDumpsIndent, tagPythonFloats, PyFloat, type Json, type JsonTable } from "./jev_policy.ts";

/** Matches the Python exception name surfaced in internal_error degrade output. */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));
// jev_client.ts ships beside this script (canonical router pulls it from
// the evals harness).
const LOCKFILE = `${THIS_DIR}thresholds.lockfile.json`;

function loadLocked(key: string, defaultPyFloat: number): PyFloat {
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
  return new PyFloat(defaultPyFloat);
}

const TRANSITIONS = ["analysis_to_planning", "planning_to_solutioning", "solutioning_to_implementation"] as const;

const NOUL_THRESHOLDS: Record<string, PyFloat> = {
  spec_specific: loadLocked("readiness_spec_specific", 0.90),
  requirements_testable: loadLocked("readiness_requirements_testable", 0.90),
  no_blockers: loadLocked("readiness_no_blockers", 0.90),
};
const SCORE_THRESHOLD: PyFloat = loadLocked("readiness_score_min", 3.0); // ready_score levels 0-4

export const QUESTIONS: JsonTable = {
  spec_specific: {
    type: "noul",
    instructions: "Does the artifact state concrete, specific requirements \u2014 named components, expected behavior, and scope \u2014 rather than vague goals or background material?",
    proposition: "The artifact states concrete, specific requirements.",
    criteria: {
      true: {
        what: "Named components, expected behavior, and explicit scope",
        examples: ["Add /health returning 200; test in tests/test_health.py"],
      },
      false: {
        what: "Vague goals or background material with no actionable requirements",
        examples: ["Make the dashboard nicer and faster"],
      },
    },
  },
  requirements_testable: {
    type: "noul",
    instructions: "Are the acceptance criteria verifiable \u2014 could a reviewer or automated test objectively confirm each one (given inputs, expected outputs, measurable conditions)?",
    proposition: "The acceptance criteria are objectively verifiable.",
    criteria: {
      true: {
        what: "Each criterion objectively confirmable: given inputs, expected outputs, measurable conditions",
        examples: ["returns 200 within 500ms for /health"],
      },
      false: {
        what: "Subjective or unverifiable criteria",
        examples: ["the system should feel fast", "improve UX"],
      },
    },
  },
  no_blockers: {
    type: "noul",
    instructions: "Work that is simply not done yet does NOT count as a blocker. Count only explicit unresolved blocking decisions: TODOs, open either/or choices, or required content that is missing or only referenced but absent. A document that is entirely absent or placeholder counts as a blocker.",
    proposition: "There are no explicit unresolved blocking decisions.",
    criteria: {
      true: {
        what: "No explicit unresolved blocking decisions",
        examples: ["All either/or choices already decided"],
      },
      false: {
        what: "Open TODOs, either/or choices, or missing required content",
        examples: ["TODO: stream or buffer?", "auth module not yet written"],
      },
    },
  },
  ready_score: {
    type: "score",
    instructions: "Rate the overall readiness of this artifact for the next BMAD phase.",
    criteria: [
      {
        summary: "0 - not ready",
        signals: [
          "background material, goals, or discussion with no actionable requirements",
          "NOT for: a concrete task list (that is at least 1)",
        ],
        examples: ["a theory overview or 'make it nice and modern'"],
      },
      {
        summary: "1 - weak",
        signals: [
          "some concrete requirements but vague scope, untestable criteria, or open blockers remain",
          "NOT for: artifacts where every criterion could be verified by a test",
        ],
        examples: ["'implement CSV export' with a TODO 'stream or buffer?' left open"],
      },
      {
        summary: "2 - partial",
        signals: ["mostly concrete and testable, but at least one significant gap (one gate fails, one criterion unmeasurable)"],
        examples: ["clear spec but acceptance criteria say only 'the system should be fast'"],
      },
      {
        summary: "3 - ready",
        signals: [
          "concrete requirements, objectively testable criteria, no open blockers; minor polish still possible",
        ],
        examples: [
          "a phase plan with named deliverables and measurable exit criteria, or a story with given/expected behavior and named test cases",
        ],
      },
      {
        summary: "4 - exemplary",
        signals: [
          "concrete, testable, complete, AND edge cases and failure modes explicitly addressed",
          "NOT for: merely solid specs that ignore edge cases",
        ],
        examples: ["'empty results yield a header-only CSV; tests cover happy path and empty state'"],
      },
    ],
  },
  blocker_kind: {
    type: "choice",
    instructions: "If any readiness gate failed, classify the primary blocker. If all gates passed, choose none_applicable.",
    criteria: {
      scope_vague: "Requirements are vague, generic, or missing scope boundaries",
      criteria_untestable: "Acceptance criteria cannot be objectively verified",
      open_questions: "Unresolved blocking decisions or TODOs remain",
      missing_artifact: "The artifact itself is empty, missing, or not provided",
      none_applicable: "No gate failed; the artifact is ready to proceed",
      other: "None of the listed categories fit",
    },
  },
};

function logEntry(entry: JsonTable): void {
  const log = `${THIS_DIR}../evals/logs/bmad_gates.jsonl`;
  mkdirSync(log.split("/").slice(0, -1).join("/"), { recursive: true });
  appendFileSync(log, pyDumps(tagPythonFloats(entry) as never) + "\n", "utf8");
}

interface ReadinessResult {
  transition: string;
  verdict: "proceed" | "hold";
  blocker_kind: string | null;
  gates_failed: string[];
  ready_score: number;
  gate_nouls: JsonTable;
  reasons: string[];
  latency_ms: number;
}

/** Evaluate one BMAD phase-transition gate. Returns verdict proceed|hold. */
export async function checkReadiness(
  artifactText: string,
  transition = "planning_to_solutioning",
  log = true,
  agentId = "default",
): Promise<ReadinessResult> {
  if (!(TRANSITIONS as readonly string[]).includes(transition)) {
    const tuple = "(" + TRANSITIONS.map((t) => `'${t}'`).join(", ") + ")";
    throw new ValueError(`unknown transition '${transition}'; use one of ${tuple}`);
  }
  const state =
    `BMAD phase transition under review: ${transition}\n\n` +
    `Upstream artifact:\n"""\n${artifactText}\n"""`;
  const t0 = performance.now();
  const resp = await callJev(QUESTIONS, state);
  const a = resp["answers"] as JsonTable;

  const reasons: string[] = [];
  const gatesFailed: string[] = [];
  const gateNouls: JsonTable = {};
  for (const gate of ["spec_specific", "requirements_testable", "no_blockers"]) {
    const p = (a[gate] as JsonTable)["noul"] as number;
    const thr = NOUL_THRESHOLDS[gate].v;
    if (p < thr) {
      gatesFailed.push(gate);
      reasons.push(`${gate} noul ${p.toFixed(2)} < ${pyFloatStr(NOUL_THRESHOLDS[gate])}`);
    }
    gateNouls[gate] = new PyFloat(p);
  }
  const score = (a["ready_score"] as JsonTable)["score"] as number;
  if (score < SCORE_THRESHOLD.v) {
    gatesFailed.push("ready_score");
    reasons.push(`ready_score ${score.toFixed(2)} < ${pyFloatStr(SCORE_THRESHOLD)}`);
  }

  const verdict: "hold" | "proceed" = gatesFailed.length > 0 ? "hold" : "proceed";
  let blocker: string | null = null;
  if (verdict === "hold") {
    blocker = (a["blocker_kind"] as JsonTable)["choice"] as string;
    if (blocker === "none_applicable") blocker = "other"; // gates failed but model saw no listed blocker kind
  }

  const latencyMs = pythonRound(performance.now() - t0, 1);
  const entry: JsonTable = {
    ts: tsStamp(),
    agent_id: agentId,
    transition,
    verdict,
    blocker_kind: blocker,
    gates_failed: gatesFailed,
    reasons,
    ready_score: new PyFloat(score),
    answers: a as Json,
    model_resolved: (resp["model"] ?? null) as Json,
    usage: (resp["usage"] ?? null) as Json,
    latency_ms: new PyFloat(latencyMs),
  };
  if (log) logEntry(entry);

  return {
    transition,
    verdict,
    blocker_kind: blocker,
    gates_failed: gatesFailed,
    ready_score: score,
    gate_nouls: gateNouls,
    reasons,
    latency_ms: latencyMs,
  };
}

/** Python str() of a float value (integral floats keep ".0"). */
function pyFloatStr(v: PyFloat | number): string {
  const n = v instanceof PyFloat ? v.v : v;
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function emitIndent(obj: unknown): void {
  // Python json.dumps(..., indent=2) byte formatting on stdout
  process.stdout.write(pyDumpsIndent(tagPythonFloats(obj), 2) + "\n");
}

function degrade(reasonKind: string, reason: string): void {
  /** Defined unavailable status — JSON, never a traceback (adapter contract). */
  try {
    emitIndent({
      status: "unavailable",
      reason_kind: reasonKind,
      reason: reason.slice(0, 300),
      decision: "unavailable",
      transition: trans,
    });
  } catch {
    // BrokenPipeError equivalent: ignore
  }
}

let trans = "planning_to_solutioning";

async function main(): Promise<number> {
  trans = process.argv[3] ?? "planning_to_solutioning"; // tsx adds a script argv slot vs Python
  try {
    let art = "";
    if (!process.stdin.isTTY) {
      try {
        art = readFileSync(0, "utf8").trim();
      } catch {
        art = "";
      }
    }
    if (!art && process.argv.length > 2 && process.argv[2]) art = process.argv[2];
    if (!art) {
      emitIndent({
        status: "bad_request",
        reason_kind: "usage",
        reason: "empty artifact: pass text via stdin or argv[1]",
        transition: trans,
      });
      return 2;
    }
    emitIndent(await checkReadiness(art, trans));
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

const code = await main();
process.exitCode = code;
