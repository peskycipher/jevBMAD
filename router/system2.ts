/**
 * System-2 consumer (implementation.md §2, §8): GLM-5.3 via OpenRouter.
 *
 * TypeScript port of system2.py. Consumes routing decisions with
 * decision == "system2": sends the request, retrieved memory context, and the
 * routing reasons to the deep-reasoning model, and logs cost/latency per call
 * (evals/logs/system2.jsonl) linked to the routing decision_id for the §7.5
 * end-to-end metrics.
 *
 * Never silently succeeds: every failure returns an explicit status and the
 * caller decides. Cost comes from the provider-reported usage.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureEnvLoaded, tsStamp, pythonRound } from "../evals/harness/jev_client.ts";
import { pyDumps, tagPythonFloats, PyFloat, type Json, type JsonTable } from "../evals/harness/jev_policy.ts";

const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));
const LOG_PATH = `${THIS_DIR}../evals/logs/system2.jsonl`;

export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "z-ai/glm-5.3"; // §10 system2 config

const SYSTEM_PROMPT =
  "You are the System-2 deep-reasoning agent in a hybrid routing architecture. " +
  "A fast decision layer escalated this request to you. Handle it with full " +
  "rigor: analyze the request, use the provided project context, and produce " +
  "the requested answer or change. Be explicit about assumptions.";

export class System2Error extends Error {}

interface ExecuteOptions {
  context?: string;
  reasons?: string[] | null;
  decisionId?: string;
  log?: boolean;
}

/** Send one escalated request to GLM. Returns the completion + metrics. */
export async function execute(
  requestText: string,
  options: ExecuteOptions = {},
): Promise<JsonTable> {
  const { context = "", reasons = null, decisionId = "", log = true } = options;
  ensureEnvLoaded(); // loads the nearest .env once
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new System2Error("OPENROUTER_API_KEY not set");

  const userParts = [`User request:\n${requestText}`];
  if (context) userParts.push(`Project context (retrieved memory):\n${context}`);
  if (reasons) {
    userParts.push("Escalation reasons recorded by the System-1 router:\n- " + reasons.join("\n- "));
  }
  const payload = pyDumps({
    model: process.env["SYSTEM2_MODEL"] ?? DEFAULT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ],
  });
  const t0 = performance.now();
  let body: JsonTable | null = null;
  let latencyMs = 0;
  let lastErr: System2Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // one bounded retry on transient errors
    let resp: Response;
    try {
      resp = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      lastErr = new System2Error(`network error: ${error}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new System2Error(`HTTP ${resp.status}: ${detail}`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      throw new System2Error(`HTTP ${resp.status}: ${detail}`);
    }
    body = (await resp.json()) as JsonTable;
    latencyMs = performance.now() - t0;
    break;
  }
  if (body === null) throw lastErr ?? new System2Error("call failed");

  const choices = (body["choices"] ?? [{}]) as JsonTable[];
  const choice = choices[0] ?? {};
  const result: JsonTable = {
    status: "ok",
    decision_id: decisionId,
    model: (body["model"] ?? null) as Json,
    text: ((choice["message"] ?? {}) as JsonTable)["content"] ?? "",
    finish_reason: (choice["finish_reason"] ?? null) as Json,
    usage: (body["usage"] ?? {}) as Json,
    latency_ms: new PyFloat(pythonRound(latencyMs, 1)),
  };
  if (log) logResult(result, requestText);
  return result;
}

function logResult(result: JsonTable, requestText: string): void {
  mkdirSync(LOG_PATH.split("/").slice(0, -1).join("/"), { recursive: true });
  const text = result["text"] as string;
  const entry: JsonTable = {
    ts: tsStamp(),
    decision_id: result["decision_id"] as string,
    model: result["model"] as Json,
    usage: result["usage"] as Json,
    latency_ms: result["latency_ms"] as Json,
    request: requestText.slice(0, 500),
    response_chars: text.length,
  };
  appendFileSync(LOG_PATH, pyDumps(tagPythonFloats(entry) as never) + "\n", "utf8");
}
