/**
 * Shared strict TOML loading and structural merge support.
 *
 * TypeScript port of config_utils.py — behaviorally identical: same layer
 * order, same merge rules (tables deep-merge; arrays with a common `code`
 * or `id` string key merge by identity; other arrays append), same strict
 * errors for present-but-unusable layers.
 */

import { readFileSync, statSync } from "node:fs";
import { parseToml, TomlParseError } from "./toml.ts";

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type Table = { [key: string]: TomlValue | Table | Table[] };

export class ConfigError extends Error {}

const KEYED_MERGE_FIELDS = ["code", "id"] as const;

function isPlainTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Load a TOML table, allowing absence only for optional layers. */
export function loadToml(path: string, opts: { required?: boolean } = {}): Table {
  const required = opts.required ?? false;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    if (required) throw new ConfigError(`required TOML file not found: ${path}`);
    return {};
  }
  if (!stat.isFile()) throw new ConfigError(`TOML layer is not a file: ${path}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`failed to read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    if (error instanceof TomlParseError) {
      throw new ConfigError(`failed to parse ${path}: ${error.message}`);
    }
    throw error;
  }
  if (!isPlainTable(parsed)) throw new ConfigError(`TOML layer did not parse to a table: ${path}`);
  return parsed;
}

function detectKeyedMergeField(items: unknown[]): "code" | "id" | null {
  if (items.length === 0 || !items.every(isPlainTable)) return null;
  for (const candidate of KEYED_MERGE_FIELDS) {
    if (items.every((item) => candidate in item)) {
      for (const item of items) {
        const value = item[candidate];
        if (typeof value !== "string") {
          throw new ConfigError(`keyed array identifier \`${candidate}\` must be a string, got ${typeof value}`);
        }
        if (!value) {
          throw new ConfigError(`keyed array identifier \`${candidate}\` must not be empty`);
        }
      }
      return candidate;
    }
  }
  return null;
}

function mergeArrays(base: unknown[], override: unknown[]): unknown[] {
  const keyedField = detectKeyedMergeField([...base, ...override]);
  if (keyedField === null) return [...base, ...override];
  const result: unknown[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of base) {
    const copied = { ...(item as Table) };
    indexByKey.set(copied[keyedField] as string, result.length);
    result.push(copied);
  }
  for (const item of override) {
    const copied = { ...(item as Table) };
    const key = copied[keyedField] as string;
    if (indexByKey.has(key)) result[indexByKey.get(key)!] = copied;
    else {
      indexByKey.set(key, result.length);
      result.push(copied);
    }
  }
  return result;
}

/** Merge tables recursively, keyed table arrays by identity, and append other arrays. */
export function structuralMerge(base: unknown, override: unknown): unknown {
  if (isPlainTable(base) && isPlainTable(override)) {
    const result: Table = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = (key in result ? structuralMerge(result[key], value) : value) as Table[keyof Table] | Table | Table[];
    }
    return result;
  }
  if (Array.isArray(base) && Array.isArray(override)) return mergeArrays(base, override);
  return override;
}

export function mergeLayers(layers: Table[]): Table {
  let merged: Table = {};
  for (const layer of layers) {
    merged = structuralMerge(merged, layer) as Table;
  }
  return merged;
}

const LAYER_PATHS = ["config.toml", "config.user.toml", "custom/config.toml", "custom/config.user.toml"] as const;

/** The merged central BMad config: _bmad/config.toml + user/custom layers. */
export function loadCentralConfig(projectRoot: string): Table {
  const bmadDir = `${projectRoot}/_bmad`;
  return mergeLayers(
    LAYER_PATHS.map((rel) => loadToml(`${bmadDir}/${rel}`, { required: rel === "config.toml" })),
  );
}

/** Merged customization for one skill: customize.toml + team/user overrides. */
export function loadCustomization(projectRoot: string | null, skillDir: string): Table {
  const skillName = skillDir.split("/").filter(Boolean).pop() ?? skillDir;
  const customDir = projectRoot !== null ? `${projectRoot}/_bmad/custom` : null;
  const layers: Table[] = [loadToml(`${skillDir}/customize.toml`, { required: true })];
  if (customDir) {
    layers.push(loadToml(`${customDir}/${skillName}.toml`));
    layers.push(loadToml(`${customDir}/${skillName}.user.toml`));
  }
  return mergeLayers(layers);
}
