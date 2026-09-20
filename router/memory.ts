/**
 * Unified memory retrieval (implementation.md §2, step 1 of routing policy).
 *
 * TypeScript port of memory.py. Combines:
 *   - Graft (Trail Brain): codebase structural & project memory, via local CLI
 *   - Mem0: general long-term semantic memory, via platform REST API
 *     (active only when MEM0_API_KEY is set; otherwise skipped gracefully)
 *
 * The merged context is prepended to the Jev `state` for routing decisions.
 */
import { spawnSync } from "node:child_process";
import type { JsonTable } from "../evals/harness/jev_policy.ts";

/** Project/code memory via the local graft CLI (`graft ask --source`). */
export function graftRetrieve(query: string, projectRoot = ".", maxChars = 1500): string {
  let out;
  try {
    out = spawnSync("graft", [query.slice(0, 400), "--source"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (error) {
    return `[graft unavailable: ${error}]`;
  }
  if (out.error) return `[graft unavailable: ${out.error}]`;
  const text = (out.stdout ?? "").trim();
  return text.length > 0 ? text.slice(0, maxChars) : "[graft: no context returned]";
}

export interface Mem0RetrieverOptions {
  topK?: number;
  minScore?: number;
  apiKey?: string;
  userId?: string;
}

/** Long-term semantic memory via the Mem0 platform API.
 *
 * Disabled unless MEM0_API_KEY is set — the router logs a note and
 * continues with Graft-only context (degraded, not failed). */
export class Mem0Retriever {
  readonly topK: number;
  readonly minScore: number; // §10 memory.mem0 config
  readonly apiKey: string;
  readonly userId: string;

  constructor(options: Mem0RetrieverOptions = {}) {
    this.topK = options.topK ?? 8;
    this.minScore = options.minScore ?? 0.65;
    this.apiKey = options.apiKey ?? process.env["MEM0_API_KEY"] ?? "";
    this.userId = options.userId ?? "default";
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async retrieve(query: string): Promise<string> {
    if (!this.available) {
      return "[mem0: not configured (MEM0_API_KEY unset); graft-only context]";
    }
    try {
      const resp = await fetch("https://api.mem0.ai/v1/memories/search/", {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.slice(0, 1000),
          user_id: this.userId,
          filters: { AND: [{ user_id: this.userId }] },
          top_k: this.topK,
          min_score: this.minScore,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await resp.json()) as { results?: Array<{ memory?: string }> };
      const hits = (data["results"] ?? []).map((m) => m["memory"] ?? "");
      return hits.length > 0 ? hits.join(" | ") : "[mem0: no relevant memories]";
    } catch (error) {
      return `[mem0: search failed: ${error}]`;
    }
  }
}

/** Run both retrievers and return structured context for the router state. */
export async function retrieveAll(query: string, projectRoot = "."): Promise<JsonTable> {
  const graft = graftRetrieve(query, projectRoot);
  const mem0 = new Mem0Retriever();
  const mem0Out = await mem0.retrieve(query);
  return {
    graft,
    mem0: mem0Out,
    mem0_active: mem0.available,
  };
}

/** Render retrieved memory into the state block fed to Jev. */
export function formatContext(ctx: JsonTable): string {
  return `Project context (Graft):\n${ctx["graft"]}\n\nLong-term memory (Mem0):\n${ctx["mem0"]}`;
}
