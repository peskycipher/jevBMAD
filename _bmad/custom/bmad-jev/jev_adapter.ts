/**
 * Shared provider adapter for optional Jev decision support.
 *
 * TypeScript port of jev_adapter.py. Calls TypeSafe's Jev decision model
 * using the native TypeSafe request/response contract ({state, questions} ->
 * {answers, usage}). The credential source is resolved from the environment:
 * TYPESAFE_API_KEY contacts TypeSafe's direct endpoint; otherwise
 * OPENROUTER_API_KEY falls back to OpenRouter's decisions endpoint. An
 * explicit `endpoint` or `model` setting (env or `[jev]` config) wins over
 * both provider defaults.
 *
 * The adapter is strictly opt-in: it runs network calls only when the
 * decision-assist mode is `suggest` or `shadow`. `off` (the default) makes
 * zero network calls; `shadow` behaves like `suggest` but its output is for
 * evaluation only. When disabled, unavailable, or given an invalid response,
 * callers get an explicit status and must fall back to the ordinary BMad path.
 *
 * Zero npm dependencies: built on global fetch and node builtins only, so a
 * plain `npx tsx jev_adapter.ts` works in any installed project.
 */

import { readFileSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import { loadCentralConfig, ConfigError } from "./config.ts";
import { pyDumps } from "./jev_policy.ts";
import type { Json, JsonTable } from "./jev_policy.ts";

// TypeSafe direct (recommended when TYPESAFE_API_KEY is present)
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.13.0"; // pinned versioned ID per docs.typesafe.ai/models
// OpenRouter fallback (the thresholds lockfile was fitted on this snapshot)
export const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "typesafe/jev-1.13-20260917"; // pinned dated snapshot: reproducible evaluation
export const VALID_MODES = ["off", "shadow", "suggest"] as const;

// Per-process call budget: each CLI run performs at most a handful of
// decisions; the adapter refuses to exceed this no matter how callers loop.
export const DEFAULT_MAX_CALLS = 4;
export const DEFAULT_TIMEOUT_SECONDS = 8.0;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_MAX_STATE_CHARS = 4000;

export class JevAdapterError extends Error {}

export interface JevSettings {
  mode: string; // "off" | "shadow" | "suggest"
  model: string;
  endpoint: string;
  apiKey: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  maxCalls: number;
  maxStateChars: number;
}

/** True only when every prerequisite for a network call is present. */
export function isCallable(s: JevSettings): boolean {
  return (s.mode === "shadow" || s.mode === "suggest") && Boolean(s.apiKey);
}

export interface JevResult {
  status: "ok" | "disabled" | "unavailable";
  reason?: string | null;
  answers: { [key: string]: JsonTable };
  usage: JsonTable;
  model?: string | null;
}

export interface TransportResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string> | null;
}

export type Transport = (
  url: string,
  payload: JsonTable,
  timeout: number,
) => Promise<TransportResponse>;

let envLoaded = false;

function parseEnvLine(line: string): [string, string] | null {
  /** Parse one KEY=VALUE line. Comments, blanks, and malformed lines -> null. */
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
 * or unreadable `.env` is silently ignored. Idempotent per module copy.
 */
export function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  let here = pathMod.resolve(process.cwd());
  for (let dir = here; ; dir = pathMod.dirname(dir)) {
    const candidate = `${dir}/.env`;
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        try {
          const lines = readFileSync(candidate, "utf8").split(/\r?\n/);
          for (const line of lines) {
            const parsed = parseEnvLine(line);
            if (parsed && !(parsed[0] in process.env)) process.env[parsed[0]] = parsed[1];
          }
        } catch {
          return;
        }
        return;
      }
    } catch {
      // missing file: keep walking
    }
    const parent = pathMod.dirname(dir);
    if (parent === dir) break;
  }
}

function tableStr(table: JsonTable, key: string): string | null {
  const value = table[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function tableFloat(table: JsonTable, key: string): number | null {
  const value = table[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Resolve settings from central config layers, then environment overrides. */
export function loadSettings(projectRoot: string | null): JevSettings {
  ensureEnvLoaded();

  let table: JsonTable = {};
  if (projectRoot !== null) {
    try {
      const central = loadCentralConfig(projectRoot) as unknown as JsonTable;
      table = (central["jev"] as JsonTable) ?? {};
    } catch (error) {
      if (error instanceof ConfigError) table = {};
      else throw error;
    }
    if (typeof table !== "object" || table === null || Array.isArray(table)) table = {};
  }

  let mode = (process.env["BMAD_DECISION_ASSIST_MODE"] ?? "").trim().toLowerCase();
  if (!mode) {
    const configMode = table["mode"];
    mode = typeof configMode === "string" ? configMode.trim().toLowerCase() : "";
  }
  if (!(VALID_MODES as readonly string[]).includes(mode)) {
    if (mode) {
      process.stderr.write(`warning: unknown decision assist mode '${mode}'; treating as off\n`);
    }
    mode = "off";
  }

  const typesafeKey = process.env["TYPESAFE_API_KEY"] || null;
  const openrouterKey = process.env["OPENROUTER_API_KEY"] || null;
  const apiKey = typesafeKey || openrouterKey;

  const model =
    (process.env["BMAD_DECISION_ASSIST_MODEL"] ?? "").trim() || tableStr(table, "model") || "";
  let endpoint =
    (process.env["BMAD_DECISION_ASSIST_ENDPOINT"] ?? "").trim() || tableStr(table, "endpoint") || "";
  if (!endpoint) endpoint = typesafeKey ? TYPESAFE_ENDPOINT : DEFAULT_ENDPOINT;
  let finalModel = model;
  if (!finalModel) finalModel = endpoint.includes("typesafe.ai") ? TYPESAFE_MODEL : DEFAULT_MODEL;
  const timeoutSeconds = tableFloat(table, "timeout_seconds") || DEFAULT_TIMEOUT_SECONDS;
  const maxStateChars = tableFloat(table, "max_state_chars") || DEFAULT_MAX_STATE_CHARS;

  return {
    mode,
    model: finalModel,
    endpoint,
    apiKey,
    timeoutSeconds,
    maxRetries: DEFAULT_MAX_RETRIES,
    maxCalls: DEFAULT_MAX_CALLS,
    maxStateChars: Math.round(maxStateChars),
  };
}

export const RETRY_AFTER_CAP_SECONDS = 30.0;

/** Seconds to wait per a numeric `Retry-After` header, or null. */
function retryAfterSeconds(headers: Record<string, string> | null): number | null {
  if (!headers) return null;
  let value: string | undefined;
  for (const key of ["Retry-After", "retry-after"]) {
    if (key in headers) {
      value = headers[key];
      break;
    }
  }
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(parsed, RETRY_AFTER_CAP_SECONDS));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeTransport(apiKey: string): Transport {
  return async (url, payload, timeout): Promise<TransportResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await response.text();
      return { statusCode: response.status, body, headers };
    } catch {
      // Network failure, timeout, abort: uniformly an unavailable outcome.
      return { statusCode: 0, body: "", headers: null };
    } finally {
      clearTimeout(timer);
    }
  };
}

function log(operation: string, durationMs: number, status: string, reason: string | null, usage: JsonTable): void {
  /** One-line operational metadata to stderr. Never secrets, never content. */
  const record: Record<string, unknown> = {
    op: operation,
    duration_ms: durationMs,
    outcome: status,
  };
  if (reason) record["fallback_reason"] = reason;
  if (Object.keys(usage).length > 0) record["usage"] = usage;
  // json.dumps(..., sort_keys=True) parity: emit keys in sorted order.
  const sorted = Object.keys(record).sort();
  const parts = sorted.map((key) => `${JSON.stringify(key)}: ${pyDumps(record[key] as never)}`);
  process.stderr.write("{" + parts.join(", ") + "}\n");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNumObject(v: unknown): v is JsonTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the answers map against the questions. Returns (answers, error). */
export function validateAnswers(
  questions: { [id: string]: JsonTable },
  answers: unknown,
): [JsonTable, string | null] {
  if (!isNumObject(answers)) return [{}, "answers is not an object"];
  const validated: JsonTable = {};
  for (const [questionId, question] of Object.entries(questions)) {
    const answer = answers[questionId];
    if (answer === undefined || answer === null) {
      return [{}, `missing answer for question \`${questionId}\``];
    }
    if (!isNumObject(answer)) return [{}, `answer \`${questionId}\` is not an object`];
    const answerType = answer["type"];
    const expectedType = question["type"];
    if (answerType !== expectedType) {
      return [{}, `answer \`${questionId}\` type ${JSON.stringify(answerType)} != question type ${JSON.stringify(expectedType)}`];
    }
    if (expectedType === "choice") {
      const choice = answer["choice"];
      const criteria = question["criteria"];
      const options = isNumObject(criteria) ? Object.keys(criteria) : [];
      if (typeof choice !== "string" || !options.includes(choice)) {
        return [{}, `answer \`${questionId}\` choice is not one of the supplied options`];
      }
      const probabilities = answer["probabilities"];
      if (!isNumObject(probabilities) || Object.keys(probabilities).length === 0) {
        return [{}, `answer \`${questionId}\` probabilities missing`];
      }
      let total = 0;
      const normalized: JsonTable = {};
      for (const [option, probability] of Object.entries(probabilities)) {
        if (!options.includes(option)) {
          return [{}, `answer \`${questionId}\` probabilities name a non-supplied option`];
        }
        if (typeof probability !== "number" || typeof probability === "boolean" || probability < 0 || probability > 1) {
          return [{}, `answer \`${questionId}\` probability out of range`];
        }
        total += probability as number;
        normalized[option] = probability as number;
      }
      if (Math.abs(total - 1.0) > 0.05) {
        return [{}, `answer \`${questionId}\` probabilities do not sum to 1`];
      }
      const confidence = answer["confidence"];
      if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
        return [{}, `answer \`${questionId}\` confidence out of range or missing`];
      }
      validated[questionId] = {
        type: "choice",
        choice,
        probabilities: normalized,
        confidence,
      };
    } else if (expectedType === "noul") {
      const noul = answer["noul"];
      if (typeof noul !== "number" || noul < 0 || noul > 1) {
        return [{}, `answer \`${questionId}\` noul probability out of range or missing`];
      }
      validated[questionId] = { type: "noul", noul };
    } else if (expectedType === "score") {
      const criteria = question["criteria"];
      if (
        !Array.isArray(criteria) ||
        criteria.length < 2 ||
        !criteria.every((e) => typeof e === "string" || isNumObject(e))
      ) {
        return [{}, `question \`${questionId}\` score criteria must be a list of at least 2 strings or objects`];
      }
      const score = answer["score"];
      if (typeof score !== "number" || score < 0 || score > criteria.length - 1) {
        return [{}, `answer \`${questionId}\` score out of range or missing`];
      }
      const probabilities = answer["probabilities"];
      if (!isNumObject(probabilities) || Object.keys(probabilities).length === 0) {
        return [{}, `answer \`${questionId}\` probabilities missing`];
      }
      let total = 0;
      const normalized: JsonTable = {};
      for (const [option, probability] of Object.entries(probabilities)) {
        if (typeof option !== "string" || !/^\d+$/.test(option) || parseInt(option, 10) >= criteria.length) {
          return [{}, `answer \`${questionId}\` probabilities name a non-supplied rubric level`];
        }
        if (typeof probability !== "number" || probability < 0 || probability > 1) {
          return [{}, `answer \`${questionId}\` probability out of range`];
        }
        total += probability;
        normalized[option] = probability;
      }
      if (Math.abs(total - 1.0) > 0.05) {
        return [{}, `answer \`${questionId}\` probabilities do not sum to 1`];
      }
      const confidence = answer["confidence"];
      if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
        return [{}, `answer \`${questionId}\` confidence out of range or missing`];
      }
      const legendMatches = (entry: Json | JsonTable, value: unknown): boolean => {
        if (typeof entry === "string") return value === entry;
        // Structured (object) level: the API may echo the object or a
        // flattened string rendering of it; both count as a match.
        return value === entry || typeof value === "string";
      };
      const legend = answer["legend"];
      if (legend !== undefined && legend !== null) {
        if (
          !isNumObject(legend) ||
          Object.keys(legend).some((key) => {
            if (!/^\d+$/.test(key)) return true;
            if (parseInt(key, 10) >= criteria.length) return true;
            const entry = criteria[parseInt(key, 10)];
            return !legendMatches(entry, legend[key]);
          })
        ) {
          return [{}, `answer \`${questionId}\` legend does not match the supplied rubric`];
        }
      }
      validated[questionId] = {
        type: "score",
        score,
        probabilities: normalized,
        confidence,
      };
    } else {
      return [{}, `question \`${questionId}\` has unsupported type ${JSON.stringify(expectedType)}`];
    }
  }
  return [validated, null];
}

/** Bounded, budgeted client for the configured Jev decisions endpoint. */
export class JevClient {
  readonly settings: JevSettings;
  private readonly transport: Transport | null;
  private callsUsed = 0;

  constructor(settings: JevSettings, transport?: Transport | null) {
    this.settings = settings;
    this.transport =
      transport !== undefined
        ? transport
        : settings.apiKey
          ? makeTransport(settings.apiKey)
          : null;
  }

  get calls_used(): number {
    return this.callsUsed;
  }

  private budgetLeft(): boolean {
    return this.callsUsed < this.settings.maxCalls;
  }

  /** Evaluate one batch of independent questions. Explicit statuses only. */
  async postDecision(args: {
    operation: string;
    state: unknown;
    questions: { [id: string]: JsonTable };
  }): Promise<JevResult> {
    const settings = this.settings;
    if (settings.mode === "off") {
      return { status: "disabled", reason: "disabled_by_config", answers: {}, usage: {} };
    }
    if (!settings.apiKey || this.transport === null) {
      return { status: "unavailable", reason: "missing_api_key", answers: {}, usage: {} };
    }
    const questions = args.questions;
    if (Object.keys(questions).length === 0) {
      return { status: "unavailable", reason: "no_questions", answers: {}, usage: {} };
    }
    if (!this.budgetLeft()) {
      return { status: "unavailable", reason: "call_budget_exhausted", answers: {}, usage: {} };
    }

    let state = args.state;
    if (typeof state === "string") {
      if (state.length > settings.maxStateChars) state = state.slice(0, settings.maxStateChars);
    } else {
      // Structured state that outgrew its budget (or is not JSON-
      // serializable) degrades to a bounded string rather than shipping
      // an unbounded/invalid payload — postDecision never raises.
      let serialized: string;
      try {
        serialized = JSON.stringify(state);
      } catch {
        serialized = String(state);
      }
      state = serialized.slice(0, settings.maxStateChars);
    }
    const payload: JsonTable = { model: settings.model, state: state as Json, questions: questions as unknown as JsonTable };

    const started = Date.now();
    let result: JevResult | null = null;
    const attempts = settings.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.callsUsed += 1;
      let statusCode = 0;
      let body = "";
      let headers: Record<string, string> | null = null;
      try {
        const response = await this.transport(settings.endpoint, payload, settings.timeoutSeconds);
        statusCode = response.statusCode;
        body = response.body;
        headers = response.headers;
      } catch {
        // An injected transport may throw; treat every transport failure
        // uniformly as an unavailable outcome, riding the same retry ladder.
        statusCode = 0;
        body = "";
        headers = null;
      }
      if (statusCode === 200) {
        result = this.parseSuccess(body, questions);
        break;
      }
      // Retry once on rate limiting or transient upstream errors, honoring a
      // numeric Retry-After header when present.
      if ([429, 500, 502, 503, 504].includes(statusCode) && attempt < attempts - 1 && this.budgetLeft()) {
        const delay = retryAfterSeconds(headers);
        await sleep(delay === null ? 250 * (attempt + 1) : delay * 1000);
        continue;
      }
      result = { status: "unavailable", reason: `http_${statusCode}`, answers: {}, usage: {} };
      break;
    }

    const durationMs = Date.now() - started;
    const finalResult = result as JevResult;
    const usage = finalResult.status === "ok" ? finalResult.usage : {};
    log(args.operation, durationMs, finalResult.status, finalResult.reason ?? null, usage);
    return finalResult;
  }

  private parseSuccess(body: string, questions: { [id: string]: JsonTable }): JevResult {
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { status: "unavailable", reason: "invalid_json_response", answers: {}, usage: {} };
    }
    if (!isNumObject(envelope)) {
      return { status: "unavailable", reason: "invalid_json_response", answers: {}, usage: {} };
    }
    const [rawAnswers, error] = validateAnswers(questions, envelope["answers"]);
    if (error !== null) {
      return { status: "unavailable", reason: error, answers: {}, usage: {} };
    }
    const usage = envelope["usage"];
    const model = envelope["model"];
    return {
      status: "ok",
      answers: rawAnswers as { [key: string]: JsonTable },
      usage: isNumObject(usage) ? usage : {},
      model: typeof model === "string" ? model : null,
    };
  }
}
