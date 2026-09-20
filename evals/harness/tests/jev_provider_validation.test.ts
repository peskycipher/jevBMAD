#!/usr/bin/env node
// Unit tests: structured score criteria + Retry-After honoring.
//
// Per the repo doctrine (CONTRIBUTING.md), behavior changes need unit-test
// coverage. These cover the adapter copy and the harness client, and run
// offline (no API key, no network). Also guards the byte-identical-copy
// invariants for jev_client.ts / jev_policy.ts.
//
// Run: npx tsx evals/harness/tests/test_jev_provider_validation.ts

import * as fs from "node:fs";
import * as path from "node:path";
import {
  JevClient, JevSettings, RETRY_AFTER_CAP_SECONDS, retryAfterSeconds, validateAnswers,
} from "../../../_bmad/custom/bmad-jev/jev_adapter.ts";
import { JevError, callJev, retryAfterSeconds as clientRetryAfterSeconds } from "../jev_client.ts";
import { assertClose, assertEq, assertIn, assertTrue, test, runAll } from "./_harness.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ADAPTER_COPY = path.join(ROOT, "_bmad/custom/bmad-jev/jev_adapter.ts");

// every live copy that sends requests to the Decisions API (byte-identical)
const CLIENT_COPIES = [
  "evals/harness/jev_client.ts",
  "modules/bmad-jev/bmad-jev-gates/scripts/jev_client.ts",
  "modules/bmad-jev/bmad-jev-review/scripts/jev_client.ts",
  "_bmad/custom/bmad-jev/jev_client.ts",
];
const POLICY_COPIES = [
  "evals/harness/jev_policy.ts",
  "modules/bmad-jev/bmad-jev-gates/scripts/jev_policy.ts",
  "modules/bmad-jev/bmad-jev-review/scripts/jev_policy.ts",
  "_bmad/custom/bmad-jev/jev_policy.ts",
];

const OBJECT_CRITERIA = [
  { what: "Cosmetic", examples: ["typo"] },
  { what: "Degraded", examples: ["slow"] },
  { what: "Blocking", examples: ["crash"] },
];
const STRING_CRITERIA = ["Cosmetic", "Degraded", "Blocking"];

function scoreAnswer(score = 1.0, confidence = 0.9, probabilities?: object, legend?: unknown) {
  const answer: any = {
    type: "score",
    score,
    confidence,
    probabilities: probabilities ?? { "0": 0.0, "1": 1.0, "2": 0.0 },
  };
  if (legend !== undefined) answer.legend = legend;
  return answer;
}

const scoreQuestions = {
  severity: { type: "score", instructions: "How severe?", criteria: OBJECT_CRITERIA },
};

test("object criteria and object legend pass", () => {
  const [validated, error] = validateAnswers(scoreQuestions as never,
    { severity: scoreAnswer(1.0, 0.9, undefined, { "1": OBJECT_CRITERIA[1] }) });
  assertEq(error, null);
  assertEq((validated["severity"] as Record<string, unknown>)["score"], 1.0);
});

test("object criteria with string legend pass", () => {
  const [, error] = validateAnswers(scoreQuestions as never,
    { severity: scoreAnswer(1.0, 0.9, undefined, { "1": "Degraded" }) });
  assertEq(error, null);
});

test("object criteria reject out-of-range level", () => {
  const [, error] = validateAnswers(scoreQuestions as never,
    { severity: scoreAnswer(1.0, 0.9, { "0": 0.0, "1": 0.0, "5": 1.0 }) });
  assertIn("non-supplied rubric level", error ?? "");
});

test("single-level criteria still rejected", () => {
  const [, error] = validateAnswers(
    { severity: { type: "score", instructions: "How severe?", criteria: ["Only one"] } } as never,
    { severity: scoreAnswer() });
  assertIn("at least 2 strings or objects", error ?? "");
});

test("string criteria legend mismatch still rejected", () => {
  const [, error] = validateAnswers(
    { severity: { type: "score", instructions: "How severe?", criteria: STRING_CRITERIA } } as never,
    { severity: scoreAnswer(1.0, 0.9, undefined, { "1": "something else" }) });
  assertIn("legend does not match", error ?? "");
});

test("choice structured option descriptions pass", () => {
  const [validated, error] = validateAnswers(
    { dept: { type: "choice", instructions: "Which team?",
      criteria: { billing: { covers: "payments" }, technical: { covers: "bugs" } } } } as never,
    { dept: { type: "choice", choice: "technical", confidence: 0.9,
      probabilities: { billing: 0.1, technical: 0.9 } } });
  assertEq(error, null);
  assertEq((validated["dept"] as Record<string, unknown>)["choice"], "technical");
});

test("429 with retry-after is honored then succeeds", async () => {
  // 10 ms real sleep is acceptable; the point is the retry ladder, not the delay
  const settings: JevSettings = {
    mode: "suggest", model: "m", endpoint: "https://example.invalid/v1",
    apiKey: "k", timeoutSeconds: 1.0, maxRetries: 1,
    maxCalls: 4, maxStateChars: 4000,
  };
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) return { statusCode: 429, body: "rate limited", headers: { "Retry-After": "0.01" } };
    return {
      statusCode: 200,
      body: JSON.stringify({ model: "jev-1.13.0", answers: {
        severity: scoreAnswer(1.0, 0.9, undefined, { "1": OBJECT_CRITERIA[1] }) },
        usage: { input_tokens: 10, output_tokens: 1 } }),
      headers: null,
    };
  };
  const client = new JevClient(settings, transport);
  const result = await client.postDecision({
    operation: "test", state: "s", questions: scoreQuestions,
  } as never);
  assertEq(result.status, "ok");
  assertEq(calls, 2);
});

test("retry-after capped", () => {
  assertEq(retryAfterSeconds({ "Retry-After": "3600" }), RETRY_AFTER_CAP_SECONDS);
  assertEq(retryAfterSeconds({ "Retry-After": "0" }), 0.0);
  assertEq(retryAfterSeconds({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }), null);
  assertEq(retryAfterSeconds(null), null);
});

test("client retry-after: numeric, capped, fallbacks", () => {
  assertEq(clientRetryAfterSeconds(new Headers({ "Retry-After": "1.5" })), 1.5);
  assertEq(clientRetryAfterSeconds(new Headers({ "Retry-After": "999" })), RETRY_AFTER_CAP_SECONDS);
  assertEq(clientRetryAfterSeconds(new Headers({ "Retry-After": "not-a-number" })), null);
  assertEq(clientRetryAfterSeconds(new Headers()), null);
  assertEq(clientRetryAfterSeconds(null), null);
});

test("missing key raises a provider-agnostic error", async () => {
  const savedEnv: Record<string, string | undefined> = {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  const savedCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join("/tmp", "jev-nokey-"));
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.chdir(tmp);
  try {
    await callJev({ q: { type: "noul", instructions: "x" } }, "state");
    throw new Error("expected JevError");
  } catch (e) {
    assertIn("TYPESAFE_API_KEY", e instanceof Error ? e.message : String(e));
    assertTrue(e instanceof JevError);
  } finally {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("jev_client.ts copies are byte-identical", () => {
  const contents = CLIENT_COPIES.map((p) => fs.readFileSync(path.join(ROOT, p), "utf-8"));
  assertEq(new Set(contents).size, 1, `jev_client.ts copies drifted: ${CLIENT_COPIES.join(", ")}`);
});

test("jev_policy.ts copies are byte-identical", () => {
  const contents = POLICY_COPIES.map((p) => fs.readFileSync(path.join(ROOT, p), "utf-8"));
  assertEq(new Set(contents).size, 1, `jev_policy.ts copies drifted: ${POLICY_COPIES.join(", ")}`);
});

await runAll();
