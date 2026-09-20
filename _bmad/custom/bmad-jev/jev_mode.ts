#!/usr/bin/env -S npx tsx
/**
 * Show or change Jev decision-assist configuration.
 *
 * TypeScript port of jev_mode.py. Modes: off (default, zero network calls) |
 * shadow (evaluate only) | suggest.
 *
 * Config reads follow the same four TOML layers as the runtime —
 * _bmad/config.toml, _bmad/config.user.toml, _bmad/custom/config.toml,
 * _bmad/custom/config.user.toml (later layers override) — and the
 * BMAD_DECISION_ASSIST_MODE environment override wins over all of them,
 * exactly like jev_adapter loadSettings. Config writes go to the
 * highest-priority durable layer by default (_bmad/custom/config.user.toml);
 * pass --layer team to write _bmad/custom/config.toml instead.
 *
 * API keys are managed in the project .env file (created if missing), which
 * the Jev scripts read via their nearest-.env loader; real environment
 * variables still win at call time.
 *
 * All output is JSON on stdout. Exit codes: 0 ok, 2 usage/caller error,
 * 3 missing _bmad/ directory.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { parseToml, TomlParseError } from "./toml.ts";
import { pyDumps, tagPythonFloats, type JsonTable } from "./jev_policy.ts";

const VALID_MODES = ["off", "shadow", "suggest"] as const;

// (layer name, file path relative to _bmad/) in merge order (lowest → highest priority)
const LAYERS: [string, string][] = [
  ["base", "config.toml"],
  ["base-user", "config.user.toml"],
  ["team", "custom/config.toml"],
  ["user", "custom/config.user.toml"],
];
const WRITE_LAYERS = ["user", "team"] as const;
const DEFAULT_WRITE_LAYER = "user";

const ENV_OVERRIDE = "BMAD_DECISION_ASSIST_MODE";

// [jev] keys this tool may write via `set` (mode is also exposed as a top-level action)
const SETTABLE_KEYS = ["mode", "model", "endpoint"] as const;

// API keys managed via `key` in the project .env file
const KEY_NAMES: Record<string, string> = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const ENV_TEMPLATE = `# JevBMAD credentials and provider configuration.
# Copy of .env.example — created by \`jev_mode.py key\`. Never commit this file.

# TypeSafe direct (recommended): https://console.typesafe.ai/settings/keys
TYPESAFE_API_KEY=
# OpenRouter fallback (used when TYPESAFE_API_KEY is unset): https://openrouter.ai/keys
OPENROUTER_API_KEY=
`;

const USAGE_HINT =
  "usage: jev_mode.py [status|suggest|shadow|off|clear] [--layer user|team] [--project-root DIR]\n" +
  "       jev_mode.py set <mode|model|endpoint> <value> [--layer user|team]\n" +
  "       jev_mode.py key <typesafe|openrouter> <api-key> [--env-file PATH]";

const MASKED_KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;

/** Python repr for the string shapes used in error messages. */
function pyRepr(s: string | string[]): string {
  if (Array.isArray(s)) return `[${s.map((x) => pyRepr(x)).join(", ")}]`;
  return `'${s}'`;
}

function emitJson(obj: JsonTable): void {
  // JSON on stdout, Python json.dumps-compatible byte formatting.
  process.stdout.write(pyDumps(tagPythonFloats(obj) as never) + "\n");
}

function fail(statusReason: string, code = 2): number {
  emitJson({ status: "bad_request", reason: statusReason, usage: USAGE_HINT });
  return code;
}

function readLayer(bmadDir: string, rel: string): Record<string, unknown> {
  const path = `${bmadDir}/${rel}`;
  try {
    if (!statSync(path).isFile()) return {};
  } catch {
    return {};
  }
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof TomlParseError ? error.message : (error as Error).message;
    process.stderr.write(`warning: could not parse ${path}: ${message}\n`);
    return {};
  }
}

/** Layers that set a non-empty raw [jev] <key> string, in merge order. */
function layerSources(bmadDir: string, key = "mode"): JsonTable[] {
  const found: JsonTable[] = [];
  for (const [name, rel] of LAYERS) {
    const table = readLayer(bmadDir, rel)["jev"];
    if (typeof table === "object" && table !== null && !Array.isArray(table)) {
      const value = (table as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        found.push({ layer: name, file: `_bmad/${rel}`, [key]: value.trim() });
      }
    }
  }
  return found;
}

function resolveMode(bmadDir: string): JsonTable {
  const env = (process.env[ENV_OVERRIDE] ?? "").trim().toLowerCase();
  if (env) {
    const valid = (VALID_MODES as readonly string[]).includes(env);
    return { mode: valid ? env : "off", source: "environment", valid };
  }
  const sources = layerSources(bmadDir, "mode");
  if (sources.length > 0) {
    const top = sources[sources.length - 1];
    const mode = top["mode"] as string;
    const valid = (VALID_MODES as readonly string[]).includes(mode);
    return { mode: valid ? mode : "off", source: top["layer"], file: top["file"], valid };
  }
  return { mode: "off", source: "default", valid: true };
}

/** Update (or add/remove) a key inside the [jev] section of TOML text,
 * preserving comments and unrelated keys. Returns (newText, changed). */
function rewriteJevKey(text: string, key: string, value: string | null): [string, boolean] {
  const lines = text.split(/(?<=\n)/);
  let inJev = false;
  let headerIdx: number | null = null;
  let keyIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inJev = stripped === "[jev]";
      if (inJev && headerIdx === null) headerIdx = i;
      continue;
    }
    if (inJev && !stripped.startsWith("#") && stripped.includes("=")) {
      if (stripped.split("=", 1)[0].trim() === key) {
        keyIdx = i;
        break;
      }
    }
  }
  if (value === null) {
    // clear / remove
    if (keyIdx === null) return [text, false];
    lines.splice(keyIdx, 1);
    return [lines.join(""), true];
  }
  const quoted = `${key} = "${value}"`;
  if (keyIdx !== null) {
    lines[keyIdx] = `${quoted}\n`;
    return [lines.join(""), true];
  }
  if (headerIdx !== null) {
    lines.splice(headerIdx + 1, 0, `${quoted}\n`);
    return [lines.join(""), true];
  }
  const section = `\n[jev]\n${quoted}\n`;
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return [base + section, true];
}

function writeJevKey(bmadDir: string, layer: string, key: string, value: string | null): JsonTable {
  const rel = LAYERS.find(([name]) => name === layer)![1];
  const path = `${bmadDir}/${rel}`;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const [newText, changed] = rewriteJevKey(text, key, value);
  if (changed) {
    mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(path, newText, "utf8");
  }
  return { file: `_bmad/${rel}`, changed };
}

/** Masked per-key state of the .env file (never prints key values). */
function envStatus(envFile: string): JsonTable {
  const state: JsonTable = {};
  for (const name of MASKED_KEYS) {
    state[name] = { in_env_file: false, in_environment: Boolean(process.env[name]) };
  }
  try {
    if (statSync(envFile).isFile()) {
      for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const stripped = line.trim();
        if (stripped.startsWith("#") || !stripped.includes("=")) continue;
        const name = stripped.split("=", 1)[0].trim();
        if (name in state && stripped.split("=").slice(1).join("=").trim()) {
          (state[name] as JsonTable)["in_env_file"] = true;
        }
      }
    }
  } catch {
    // missing/unreadable .env: file-based state stays false
  }
  return state;
}

/** Set KEY=value in .env text: replace an active or commented assignment,
 * else append. Returns (newText, changed). */
function rewriteEnvKey(text: string, name: string, value: string): [string, boolean] {
  const lines = text.split(/(?<=\n)/);
  let activeIdx: number | null = null;
  let commentedIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped === `${name}=` || stripped === `${name} =`) {
      activeIdx = i;
      break;
    }
    if (commentedIdx === null && stripped.replace(/^#+/, "").trim().startsWith(`${name}=`)) {
      commentedIdx = i;
    }
  }
  const assignment = `${name}=${value}\n`;
  if (activeIdx !== null) {
    if (lines[activeIdx].trim() === assignment.trim()) return [text, false];
    lines[activeIdx] = assignment;
    return [lines.join(""), true];
  }
  if (commentedIdx !== null) {
    lines[commentedIdx] = assignment;
    return [lines.join(""), true];
  }
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return [base + assignment, true];
}

function writeEnvKey(projectRoot: string, name: string, value: string): JsonTable {
  const envFile = `${projectRoot}/.env`;
  let text: string;
  let created: boolean;
  try {
    text = readFileSync(envFile, "utf8");
    created = false;
  } catch {
    text = ENV_TEMPLATE;
    created = true;
  }
  const [newText, changed] = rewriteEnvKey(text, name, value);
  if (changed) writeFileSync(envFile, newText, "utf8");
  const maskedValue = value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-2)}` : "…";
  return { file: envFile, created, changed, masked_value: maskedValue };
}

interface ParsedInvocation {
  action: string;
  values: string[];
  projectRoot: string;
  layer: string;
  envFile: string | null;
}

function parseCli(argv: string[]): ParsedInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "project-root": { type: "string", short: "p", default: "." },
        layer: { type: "string", default: DEFAULT_WRITE_LAYER },
        "env-file": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE_HINT}\n`);
    process.exit(2);
  }
  const positionals = parsed.positionals;
  const action = positionals[0] ?? "status";
  const values = positionals.slice(1);
  let projectRoot = parsed.values["project-root"] ?? ".";
  const layer = parsed.values["layer"] ?? DEFAULT_WRITE_LAYER;
  if (!(WRITE_LAYERS as readonly string[]).includes(layer)) {
    process.stderr.write(
      `argument --layer: invalid choice: '${layer}' (choose from 'user', 'team')\n${USAGE_HINT}\n`,
    );
    process.exit(2);
  }
  projectRoot = resolve(projectRoot);
  const envFile = resolve(parsed.values["env-file"] ?? `${projectRoot}/.env`);
  return { action, values, projectRoot, layer, envFile };
}

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2));

  if (args.action !== "status" && args.action !== "clear" && args.action !== "set" && args.action !== "key" && !(VALID_MODES as readonly string[]).includes(args.action)) {
    return fail(`unknown action ${pyRepr(args.action)}`);
  }
  if (args.action === "set" && (args.values.length !== 2 || !(SETTABLE_KEYS as readonly string[]).includes(args.values[0]))) {
    return fail(`'set' expects <mode|model|endpoint> <value>; got ${pyRepr(args.values)}`);
  }
  if (args.action === "key") {
    if (args.values.length !== 2 || !(args.values[0] in KEY_NAMES)) {
      return fail(`'key' expects <${Object.keys(KEY_NAMES).join("|")}> <api-key>; got ${pyRepr(args.values.slice(0, 1))} <api-key>`);
    }
    if (!args.values[1].trim()) return fail("api-key value must not be empty");
    if (args.values[0] === "openrouter" && !args.values[1].trim().startsWith("sk-or-")) {
      process.stderr.write("warning: OpenRouter keys normally start with 'sk-or-'; writing anyway\n");
    }
  }

  const projectRoot = args.projectRoot;
  const bmadDir = `${projectRoot}/_bmad`;
  try {
    if (!statSync(bmadDir).isDirectory()) {
      process.stderr.write(`error: no _bmad/ directory under ${projectRoot}\n`);
      return 3;
    }
  } catch {
    process.stderr.write(`error: no _bmad/ directory under ${projectRoot}\n`);
    return 3;
  }

  const envFile = args.envFile;
  const resolved = resolveMode(bmadDir);
  const envActive = (process.env[ENV_OVERRIDE] ?? "").trim() !== "";

  const result: JsonTable = {
    status: "ok",
    action: args.action,
    mode: resolved["mode"],
    mode_source: resolved["source"],
    mode_valid: resolved["valid"],
    env_override_active: envActive,
    layers_setting_mode: layerSources(bmadDir, "mode"),
    layers_setting_model: layerSources(bmadDir, "model"),
    layers_setting_endpoint: layerSources(bmadDir, "endpoint"),
    env_file: envFile,
    keys: envStatus(envFile as string),
  };
  const keyState = result["keys"] as JsonTable;
  let apiKeyPresent = Object.values(keyState).some(
    (v) => (v as JsonTable)["in_env_file"] === true || (v as JsonTable)["in_environment"] === true,
  );
  result["api_key_present"] = apiKeyPresent;
  result["callable"] = (result["mode"] === "shadow" || result["mode"] === "suggest") && apiKeyPresent;

  const envLockout = (): JsonTable => ({
    status: "bad_request",
    reason: `${ENV_OVERRIDE}=${process.env[ENV_OVERRIDE]} is set in the environment and overrides all config layers; unset it or edit the shell profile`,
  });

  if (args.action === "status") {
    // no write
  } else if (args.action === "key") {
    const name = KEY_NAMES[args.values[0]];
    result["written_env"] = writeEnvKey(projectRoot, name, args.values[1].trim());
    result["keys"] = envStatus(envFile as string);
    const ks = result["keys"] as JsonTable;
    apiKeyPresent = Object.values(ks).some(
      (v) => (v as JsonTable)["in_env_file"] === true || (v as JsonTable)["in_environment"] === true,
    );
    result["api_key_present"] = apiKeyPresent;
  } else if (args.action === "set") {
    const key = args.values[0];
    const value = args.values[1];
    if (key === "mode" && !(VALID_MODES as readonly string[]).includes(value)) {
      return fail(`invalid mode ${pyRepr(value)}; expected one of ${VALID_MODES.join(", ")}`);
    }
    if (envActive) {
      result["status"] = "bad_request";
      Object.assign(result, envLockout());
      emitJson(result);
      return 2;
    }
    result["written"] = writeJevKey(bmadDir, args.layer, key, value);
    const after = resolveMode(bmadDir);
    result["mode"] = after["mode"] as string;
    result["mode_source"] = after["source"] as string;
  } else {
    // suggest | shadow | off | clear
    if (envActive) {
      result["status"] = "bad_request";
      Object.assign(result, envLockout());
      emitJson(result);
      return 2;
    }
    const value = args.action === "clear" ? null : args.action;
    result["written"] = writeJevKey(bmadDir, args.layer, "mode", value);
    const after = resolveMode(bmadDir);
    result["mode"] = after["mode"] as string;
    result["mode_source"] = after["source"] as string;
  }

  const ks = result["keys"] as JsonTable;
  apiKeyPresent = Object.values(ks).some(
    (v) => (v as JsonTable)["in_env_file"] === true || (v as JsonTable)["in_environment"] === true,
  );
  result["api_key_present"] = apiKeyPresent;
  result["callable"] = (result["mode"] === "shadow" || result["mode"] === "suggest") && apiKeyPresent;
  emitJson(result);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
