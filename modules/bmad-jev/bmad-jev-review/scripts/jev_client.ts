/**
 * Minimal client for the Jev Decisions API.
 *
 * TypeScript port of jev_client.py.
 * TypeSafe direct (TYPESAFE_API_KEY): POST https://api.typesafe.ai/v1/systemone
 * OpenRouter fallback (OPENROUTER_API_KEY): POST https://openrouter.ai/api/alpha/decisions
 * TYPESAFE_API_KEY wins when both are set; see resolveProvider(). Schema
 * (validated live 2026-09-19):
 *   { "model": "typesafe/jev-1.13-20260917",
 *     "state": string | object | array,
 *     "questions": { <qid>: {
 *         "type": "noul"|"choice"|"score",
 *         "instructions": string | object | array,  // required for all
 *         "proposition": string,                    // noul only
 *         "criteria": object (choice) | array (score), // required
 *         ... } } }
 * Response answers carry `noul` (0-1), `choice` + `probabilities` + `confidence`,
 * or fractional `score` + `legend` + `probabilities` + `confidence`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pyDumps, tagPythonFloats, type Json, type JsonTable } from "./jev_policy.ts";

export const ENDPOINT_TYPESAFE = "https://api.typesafe.ai/v1/systemone";
export const ENDPOINT_OPENROUTER = "https://openrouter.ai/api/alpha/decisions";
export const MODEL_TYPESAFE = "jev-1.13.0"; // TypeSafe direct alias of DEFAULT_MODEL (the dated snapshot)
export const DEFAULT_MODEL = "typesafe/jev-1.13-20260917"; // pinned dated snapshot (reproducible eval); re-fit thresholds if this changes (§6)
export const ENDPOINT = ENDPOINT_OPENROUTER; // legacy alias: OpenRouter fallback endpoint
const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));
export const LOG_PATH = `${THIS_DIR}../../logs/decisions.jsonl`;

export const RETRY_AFTER_CAP_SECONDS = 30.0; // cap a numeric Retry-After so a huge value cannot stall a CLI run

/** Seconds to wait per a numeric `Retry-After` header, or null.
 *
 * Per docs.typesafe.ai, 429 responses may carry `Retry-After`; honor it
 * when numeric. HTTP-date form is not handled; values are capped at
 * RETRY_AFTER_CAP_SECONDS. */
export function retryAfterSeconds(headers: Headers | null): number | null {
  if (headers === null) return null;
  const value = headers.get("Retry-After");
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.min(parsed, RETRY_AFTER_CAP_SECONDS));
}

export class JevError extends Error {}

/** Provider-reported cost for one call, or null when the provider does
 * not report one. The Jev decisions API reports only token counts — never
 * invent a price here; callers must surface null as "n/a", not $0.00. */
export function usageCost(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  let cost = (usage as JsonTable)["cost"];
  if (typeof cost === "string") {
    const parsed = Number(cost);
    if (Number.isNaN(parsed)) return null;
    cost = parsed;
  }
  return typeof cost === "number" && !Number.isNaN(cost) ? cost : null;
}

let envLoaded = false;

/** Parse one KEY=VALUE line. Comments, blanks, and malformed lines -> null. */
export function parseEnvLine(line: string): [string, string] | null {
  let text = line.trim();
  if (!text || text.startsWith("#")) return null;
  if (text.startsWith("export ")) text = text.slice("export ".length).trim();
  const eq = text.indexOf("=");
  if (eq < 0) return null;
  const key = text.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = text.slice(eq + 1).trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** Load the nearest `.env` (walking up from the working directory) once.
 *
 * dotenv conventions: existing environment variables always win; a missing
 * or unreadable `.env` is silently ignored. Idempotent per module copy. */
export function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  let here = process.cwd();
  for (;;) {
    const path = `${here}/.env`;
    if (existsSync(path)) {
      let lines: string[];
      try {
        lines = readFileSync(path, "utf8").split(/\r?\n/);
      } catch {
        return;
      }
      for (const line of lines) {
        const parsed = parseEnvLine(line);
        if (parsed !== null && !(parsed[0] in process.env)) {
          process.env[parsed[0]] = parsed[1];
        }
      }
      return;
    }
    const parent = here.split("/").slice(0, -1).join("/");
    if (parent === here || parent === "") return;
    here = parent;
  }
}

/** True when TYPESAFE_API_KEY or OPENROUTER_API_KEY is available (after .env load). */
export function envHasProviderKey(): boolean {
  ensureEnvLoaded();
  return Boolean(process.env["TYPESAFE_API_KEY"] || process.env["OPENROUTER_API_KEY"]);
}

/** Return (endpoint, api_key, default_model) for the first credential set.
 *
 * TYPESAFE_API_KEY (TypeSafe direct) wins over OPENROUTER_API_KEY
 * (OpenRouter fallback). Credentials may also come from the nearest
 * `.env` file (see ensureEnvLoaded); real environment variables win.
 * Returns null when no key is set. */
export function resolveProvider(): [string, string, string] | null {
  ensureEnvLoaded();
  const typesafe = process.env["TYPESAFE_API_KEY"] || null;
  if (typesafe) {
    // TypeSafe direct only knows its own alias (verified live: the dated
    // snapshot ID is rejected with HTTP 400). The translation below maps
    // the logical pin to it; MODEL_TYPESAFE is that alias.
    return [ENDPOINT_TYPESAFE, typesafe, MODEL_TYPESAFE];
  }
  const openrouter = process.env["OPENROUTER_API_KEY"] || null;
  if (openrouter) return [ENDPOINT_OPENROUTER, openrouter, DEFAULT_MODEL];
  return null;
}

/** Python time.strftime("%Y-%m-%dT%H:%M:%S%z") equivalent (local time). */
export function tsStamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** Append one JSON line per API call (implementation.md §6/§7: log full
 * distributions + confidence + resolved model for threshold fitting). */
function logCall(questions: JsonTable, state: unknown, response: JsonTable, latencyMs: number): void {
  mkdirSync(LOG_PATH.split("/").slice(0, -1).join("/"), { recursive: true });
  const entry: JsonTable = {
    ts: tsStamp(),
    latency_ms: round1(latencyMs),
    model_resolved: response["model"] ?? null,
    usage: (response["usage"] ?? null) as Json,
    id: response["id"] ?? null,
    questions: questions as Json,
    state: typeof state === "string" ? state : (pyDumps(state as Json) as string).slice(0, 2000),
    answers: (response["answers"] ?? null) as Json,
  };
  appendFileSync(LOG_PATH, pyDumps(tagPythonFloats(entry) as never) + "\n", "utf8");
}

/** Python round(x, 1). */
export function round1(v: number): number {
  return pythonRound(v, 1);
}

/** Python round(): banker's rounding on the binary double. */
export function pythonRound(v: number, digits: number): number {
  const scale = 10 ** digits;
  const scaled = v * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let unit: number;
  if (diff > 0.5) unit = floor + 1;
  else if (diff < 0.5) unit = floor;
  else unit = floor % 2 === 0 ? floor : floor + 1; // half to even
  return unit / scale;
}

interface CallJevOptions {
  model?: string | null;
  retries?: number;
  log?: boolean;
}

/** Call the Decisions API. Returns the full response object (answers + usage). */
export async function callJev(
  questions: JsonTable,
  state: unknown,
  options: CallJevOptions = {},
): Promise<JsonTable> {
  const { model = null, retries = 3, log = true } = options;
  const provider = resolveProvider();
  if (provider === null) {
    throw new JevError("set TYPESAFE_API_KEY (TypeSafe direct) or OPENROUTER_API_KEY (fallback)");
  }
  const [endpoint, apiKey, providerModel] = provider;
  // The caller pins DEFAULT_MODEL (the dated snapshot, §6); each endpoint
  // gets its own ID for that same logical model (TypeSafe direct rejects
  // the dated ID — verified live). model_requested records the logical pin
  // so lockfile/eval provenance stays provider-independent; the response
  // echo (model_echo in reports) is the drift-detection signal.
  const requested = model === null || model === DEFAULT_MODEL ? DEFAULT_MODEL : model;
  const resolvedModel = model === null || model === DEFAULT_MODEL ? providerModel : model;

  const payload = pyDumps({ model: resolvedModel, state: state as Json, questions: questions as Json });
  let lastErr: JevError | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const t0 = performance.now();
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      lastErr = new JevError(`network error: ${error}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 500);
      // 4xx = our payload is wrong; do not retry blindly except 429
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new JevError(`HTTP ${resp.status}: ${detail}`);
        const delay = retryAfterSeconds(resp.headers);
        const waitSeconds = delay === null ? 2 ** attempt : Math.min(delay, RETRY_AFTER_CAP_SECONDS);
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }
      throw new JevError(`HTTP ${resp.status}: ${detail}`);
    }
    const body = (await resp.json()) as JsonTable;
    const latencyMs = performance.now() - t0;
    body["model_requested"] = requested;
    if (log) logCall(questions, state, body, latencyMs);
    return body;
  }
  throw lastErr ?? new JevError("call failed");
}
