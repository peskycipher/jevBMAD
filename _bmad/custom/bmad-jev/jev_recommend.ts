#!/usr/bin/env -S npx tsx
/**
 * Advisory Jev workflow recommendation (opt-in, disabled by default).
 *
 * TypeScript port of jev_recommend.py. Narrow judgment over supplied
 * evidence: the caller (a BMad skill) derives candidate skill ids from the
 * installed registry, passes them here, and this script either honors an
 * explicit user choice, handles single-candidate cases deterministically,
 * or asks Jev when semantic ambiguity remains. Output is a JSON advisory
 * signal on stdout; the calling skill keeps full control and must fall back
 * to its ordinary reasoning whenever the status is not "ok".
 *
 * Disabled by default. Set the decision-assist mode to `suggest` or
 * `shadow` via BMAD_DECISION_ASSIST_MODE or the `[jev] mode` central-config
 * key. When off, this makes zero network calls.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { JevClient, loadSettings } from "./jev_adapter.ts";
import {
  PolicyError,
  pyDumps,
  tagPythonFloats,
  applyRequestIntegrity,
  buildIntegrityQuestions,
  buildRecommendQuestions,
  buildState,
  interpretRecommend,
  parseEvidence,
  sanitizeCandidateId,
  type JsonTable,
} from "./jev_policy.ts";

function emitJson(obj: JsonTable): void {
  // JSON on stdout, no tracebacks (contract). Serialized with Python
  // json.dumps-compatible spacing so Python- and TS-era outputs stay
  // byte-identical for golden tests.
  process.stdout.write(pyDumps(tagPythonFloats(obj) as import("./jev_policy.ts").Json) + "\n");
}

/** Caller-input errors are bad_request, not outages: JSON on stdout, exit 2. */
function failUsage(reason: string): number {
  emitJson({ status: "bad_request", reason_kind: "usage", reason, calls_made: 0 });
  return 2;
}

const USAGE = `usage: npx tsx jev_recommend.ts --request REQUEST [--project-root ROOT]
                  --candidates IDS [--chosen ID] [--evidence KEY=VALUE]...`;

interface ParsedArgs {
  request: string;
  projectRoot: string;
  candidates: string;
  chosen: string | undefined;
  evidence: string[];
}

function parseCli(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        request: { type: "string", short: "r" },
        "project-root": { type: "string", default: "." },
        candidates: { type: "string", short: "c" },
        chosen: { type: "string" },
        evidence: { type: "string", multiple: true },
      },
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  const values = parsed.values as {
    request?: string;
    "project-root"?: string;
    candidates?: string;
    chosen?: string;
    evidence?: string[];
  };
  if (!values.request || !values.candidates) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  return {
    request: values.request,
    projectRoot: values["project-root"] ?? ".",
    candidates: values.candidates,
    chosen: values.chosen,
    evidence: values.evidence ?? [],
  };
}

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot);
  const settings = loadSettings(projectRoot);

  if (!(settings.mode !== "off" && Boolean(settings.apiKey))) {
    const status = settings.mode === "off" ? "disabled" : "unavailable";
    const reason = status === "disabled" ? "disabled_by_config" : "missing_api_key";
    const kind = status === "disabled" ? "disabled" : "missing_api_key";
    emitJson({ status, reason_kind: kind, reason, calls_made: 0 });
    return 0;
  }

  if (args.chosen !== undefined && args.chosen !== "") {
    let chosen: string;
    try {
      chosen = sanitizeCandidateId(args.chosen);
    } catch (error) {
      if (error instanceof PolicyError) return failUsage(error.message);
      throw error;
    }
    // An explicit user choice outranks any model result: echo it and
    // skip the provider entirely (zero network calls).
    emitJson({ status: "ok", source: "explicit_user_choice", recommendation: { id: chosen }, calls_made: 0 });
    return 0;
  }

  let candidates: string[];
  try {
    candidates = args.candidates
      .split(",")
      .filter((raw) => raw.trim())
      .map((raw) => sanitizeCandidateId(raw));
  } catch (error) {
    if (error instanceof PolicyError) return failUsage(error.message);
    throw error;
  }
  // Dedupe, preserving order, and cap the option count via policy checks.
  candidates = [...new Set(candidates)];

  if (candidates.length === 1) {
    emitJson({ status: "ok", source: "single_candidate", recommendation: { id: candidates[0] }, calls_made: 0 });
    return 0;
  }
  if (candidates.length === 0) return failUsage("no_candidates");

  let evidence: Record<string, string>;
  try {
    evidence = parseEvidence(args.evidence);
  } catch (error) {
    if (error instanceof PolicyError) return failUsage(error.message);
    throw error;
  }

  let questions;
  let state;
  try {
    questions = buildRecommendQuestions(candidates);
    state = buildState(args.request, evidence, settings.maxStateChars);
  } catch (error) {
    // e.g. >MAX_CANDIDATES: a caller error, not an outage — never a traceback
    if (error instanceof PolicyError) return failUsage(error.message);
    throw error;
  }
  const client = new JevClient(settings);
  const result = await client.postDecision({
    operation: "workflow_recommendation",
    state,
    questions,
  });
  let outcome = interpretRecommend(result, candidates, null);
  if (outcome["status"] === "ok") {
    // Second-stage prompt-injection gate: a genuine serial dependency
    // (it only matters once every recommendation gate already passed).
    const integrityResult = await client.postDecision({
      operation: "request_integrity",
      state,
      questions: buildIntegrityQuestions(),
    });
    outcome = applyRequestIntegrity(outcome, integrityResult);
  }
  outcome["calls_made"] = client.calls_used;
  if (result.status === "ok") {
    outcome["usage"] = result.usage;
    outcome["model"] = result.model ?? null;
  }
  outcome["mode"] = settings.mode;
  outcome["advisory"] = true;
  outcome["confidence_note"] =
    "confidence is the provider's distribution-concentration statistic, not a probability of correctness";
  emitJson(outcome);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
