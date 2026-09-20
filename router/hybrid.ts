/**
 * Hybrid dispatcher (implementation.md §2 Core Routing Policy, steps 4-6).
 *
 * TypeScript port of the original hybrid.py. Full end-to-end path: route with Jev
 * (System 1), then
 *   - system1_auto  -> return the routing decision; the host harness executes
 *                      (System-1 execution is the harness's normal flow)
 *   - system2       -> escalate to the GLM consumer (router/system2.ts) with
 *                      the retrieved memory context + routing reasons
 *
 * Logs end-to-end latency and total cost per dispatch (§7.5 metrics): the
 * System-2 call is linked to its routing decision by decision_id.
 *
 * Usage: npx tsx router/hybrid.ts "user request text"
 */
import { performance } from "node:perf_hooks";
import { route } from "./router.ts";
import { retrieveAll, formatContext } from "./memory.ts";
import { System2Error, execute } from "./system2.ts";
import { JevError, usageCost, pythonRound } from "../evals/harness/jev_client.ts";
import { pyDumps, pyDumpsIndent, tagPythonFloats, PyFloat, type Json, type JsonTable } from "../evals/harness/jev_policy.ts";

interface DispatchResult extends JsonTable {
  request: string;
  decision_id: string;
  routing: JsonTable;
  system2: JsonTable | null;
  end_to_end_ms: Json;
  cost_usd: Json;
}

/** Route, then execute per the decision. Returns end-to-end metrics. */
export async function dispatch(
  requestText: string,
  projectRoot = ".",
  useMemory = true,
): Promise<DispatchResult> {
  const t0 = performance.now();

  // Step 1-4: System-1 routing (decision_id links all downstream logs)
  const routing = await route(requestText, { projectRoot, useMemory });
  const decisionId = routing["decision_id"];

  const out: DispatchResult = {
    request: requestText,
    decision_id: decisionId,
    routing: {
      decision: routing["decision"] as Json,
      needs_review: routing["needs_review"] as Json,
      intent: routing["intent"] as Json,
      intent_confidence: new PyFloat(routing["intent_confidence"]),
      safe_noul: new PyFloat(routing["safe_noul"]),
      complexity_score: new PyFloat(routing["complexity_score"]),
      reasons: routing["reasons"] as Json,
    },
    system2: null,
    end_to_end_ms: null,
    cost_usd: null,
  };

  // Step 5: System-2 escalation path
  if (routing["decision"] === "system2") {
    const ctx = useMemory ? await retrieveAll(requestText, projectRoot) : null;
    try {
      const s2 = await execute(requestText, {
        context: ctx ? formatContext(ctx) : "",
        reasons: routing["reasons"] as string[],
        decisionId,
      });
      out["system2"] = {
        status: "ok",
        model: s2["model"] as Json,
        text: s2["text"] as string,
        latency_ms: s2["latency_ms"] as Json,
        usage: s2["usage"] as Json,
      };
    } catch (error) {
      if (error instanceof System2Error) {
        out["system2"] = { status: "error", error: error.message };
      } else {
        throw error;
      }
    }
  }

  const routingCost = usageCost(routing["usage"]);
  const s2Table = out["system2"] as JsonTable | null;
  const s2Usage = s2Table !== null ? s2Table["usage"] : null;
  const s2Cost = usageCost(s2Usage);
  const known = [routingCost, s2Cost].filter((c): c is number => c !== null);
  out["cost_usd"] = known.length > 0 ? new PyFloat(pythonRound(known.reduce((x, y) => x + y, 0), 8)) : null;
  out["end_to_end_ms"] = new PyFloat(pythonRound(performance.now() - t0, 1));
  return out;
}

function degrade(reasonKind: string, reason: string): void {
  /** Defined unavailable status — JSON, never a traceback (adapter contract). */
  try {
    process.stdout.write(
      pyDumpsIndent(
        tagPythonFloats({
          status: "unavailable",
          reason_kind: reasonKind,
          reason: reason.slice(0, 300),
          routing_decision: "unavailable",
        }),
      ) + "\n",
    );
  } catch {
    // BrokenPipeError equivalent: ignore
  }
}

async function main(): Promise<number> {
  const req = process.argv.slice(2).join(" ") || "Refactor the router package into a cleaner module layout.";
  try {
    const result = await dispatch(req);
    const summary: JsonTable = {
      decision_id: result["decision_id"] as Json,
      end_to_end_ms: result["end_to_end_ms"] as Json,
      cost_usd: result["cost_usd"] as Json,
    };
    summary["routing_decision"] = (result["routing"] as JsonTable)["decision"] as Json;
    const s2 = result["system2"] as JsonTable | null;
    if (s2 && s2["status"] === "ok") {
      summary["system2_model"] = s2["model"] as Json;
      summary["system2_latency_ms"] = s2["latency_ms"] as Json;
      summary["response_preview"] = (s2["text"] as string).slice(0, 200);
    }
    process.stdout.write(pyDumpsIndent(tagPythonFloats(summary)) + "\n");
    return 0;
  } catch (error) {
    if (error instanceof JevError) {
      degrade(error.message.toUpperCase().includes("API_KEY") ? "missing_api_key" : "provider_error", error.message);
    } else if (error instanceof System2Error) {
      degrade("provider_error", error.message);
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
