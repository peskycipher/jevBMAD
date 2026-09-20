/**
 * Minimal TOML subset parser for the Jev TypeScript core.
 *
 * The BMad config surfaces this code reads (central config layers, skill
 * customize.toml files) use a conservative TOML subset: comments, bare and
 * quoted keys, tables, arrays of tables, basic strings (with escapes),
 * literal strings, multi-line basic strings, integers, floats, booleans,
 * and arrays. Anything outside that subset is a clear parse error, matching
 * config_utils.py's ConfigError behavior for undecodable layers.
 *
 * Zero dependencies by doctrine (mirrors the Python stdlib-first rule).
 */

export class TomlParseError extends Error {}

type Value = string | number | boolean | Value[] | { [key: string]: Value } | Map<string, Value>;

// Tables and arrays-of-tables are stored as a nested structure; arrays of
// tables are represented as Value[] where every element is a table object.
type Table = { [key: string]: Value | Table | Table[] };

interface Cursor {
  lines: string[];
  i: number; // current line index
}

function isBareKeyChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}

function parseKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && ((key[0] === '"' && key[key.length - 1] === '"') || (key[0] === "'" && key[key.length - 1] === "'"))) {
    const body = key.slice(1, -1);
    if (key[0] === '"') {
      // Basic-string key: process standard escapes.
      return unescapeString(body, false);
    }
    return body;
  }
  if (key.length === 0) throw new TomlParseError("empty key");
  if (![...key].every(isBareKeyChar)) {
    throw new TomlParseError(`unsupported key syntax: ${key}`);
  }
  return key;
}

/** Split "a.b.'c d'" into [a, b, c d], ignoring dots inside quoted segments. */
function splitKeyPath(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map(parseKey);
}

const ESCAPES: Record<string, string> = {
  b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\",
};

function unescapeString(body: string, multiline: boolean): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) throw new TomlParseError("dangling escape in string");
    if (next === "\n" || next === "\r") {
      // Line-ending backslash in multiline strings: trim following whitespace.
      if (multiline) {
        i++;
        while (i + 1 < body.length && /[ \t]/.test(body[i + 1])) i++;
        i++; // skip past the newline
        continue;
      }
      throw new TomlParseError("line-ending backslash in single-line string");
    }
    if (next === "u" || next === "U") {
      const width = next === "u" ? 4 : 8;
      const hex = body.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) {
        throw new TomlParseError(`invalid unicode escape \\${next}`);
      }
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 1 + width;
      continue;
    }
    const mapped = ESCAPES[next];
    if (mapped === undefined) throw new TomlParseError(`invalid escape \\${next}`);
    out += mapped;
    i++;
  }
  return out;
}

function parseScalar(text: string): Value {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return unescapeString(t.slice(1, -1), false);
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1);
  }
  if (/^[+-]?(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*)$/.test(t)) {
    return parseInt(t.replace(/_/g, ""), t.toLowerCase().startsWith("0x") ? 16 : t.toLowerCase().startsWith("0o") ? 8 : t.toLowerCase().startsWith("0b") ? 2 : 10);
  }
  if (/^[+-]?([0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*|[0-9][0-9_]*)([eE][+-]?[0-9_]+)?$/.test(t) || t === "inf" || t === "-inf" || t === "+inf" || t === "nan") {
    const cleaned = t.replace(/_/g, "");
    return parseFloat(cleanFloat(t));
  }
  throw new TomlParseError(`unsupported value: ${text.trim()}`);
}

function cleanFloat(t: string): string {
  if (t === "inf" || t === "+inf") return "Infinity";
  if (t === "-inf") return "-Infinity";
  if (t === "nan" || t === "+nan" || t === "-nan") return "NaN";
  return t;
}

function parseValue(text: string): Value {
  // Arrays: split at top level, honoring quotes and nesting.
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new TomlParseError("unterminated array");
    const body = text.slice(1, -1);
    const items: Value[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === "," && depth === 0) {
        const item = body.slice(start, i).trim();
        if (item) items.push(parseValue(item));
        start = i + 1;
      }
    }
    const tail = body.slice(start).trim();
    if (tail) items.push(parseValue(tail));
    return items;
  }
  return parseScalar(text);
}

function parseMultilineBasic(cursor: Cursor, firstLine: string): string {
  // firstLine is the remainder after the opening triple quote.
  const collected: string[] = [];
  let rest = firstLine;
  while (true) {
    const idx = rest.indexOf('"""');
    if (idx >= 0) {
      const before = rest.slice(0, idx);
      let tail = rest.slice(idx + 3);
      if (tail.trimStart().startsWith("#") && tail.trimStart() !== "") {
        tail = ""; // comment after closing quotes
      }
      collected.push(before);
      if (tail.trim() !== "") throw new TomlParseError("unexpected content after multiline string");
      cursor.i++; // consume the closing-delimiter line
      break;
    }
    collected.push(rest);
    if (cursor.i >= cursor.lines.length) throw new TomlParseError("unterminated multiline string");
    rest = cursor.lines[cursor.i];
    cursor.i++;
  }
  let body = collected.join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return unescapeString(body, true);
}

/** Parse a TOML document (subset). Returns a plain nested object. */
export function parseToml(text: string): Table {
  const root: Table = {};
  let current: Table = root;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cursor: Cursor = { lines, i: 0 };

  while (cursor.i < lines.length) {
    let line = lines[cursor.i];
    cursor.i++;

    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;

    // Table header
    if (stripped.startsWith("[")) {
      const isArrayOfTables = stripped.startsWith("[[");
      const headerEnd = isArrayOfTables ? stripped.indexOf("]]") : stripped.indexOf("]");
      if (headerEnd < 0) throw new TomlParseError(`unterminated table header: ${stripped}`);
      const headerBody = stripped.slice(isArrayOfTables ? 2 : 1, headerEnd).trim();
      const after = stripped.slice(headerEnd + (isArrayOfTables ? 2 : 1)).trim();
      if (after && !after.startsWith("#")) throw new TomlParseError(`unexpected content after table header: ${stripped}`);
      const pathParts = splitKeyPath(headerBody);
      if (pathParts.some((p) => p === "")) throw new TomlParseError(`empty key in table header: ${headerBody}`);
      current = root;
      for (let p = 0; p < pathParts.length; p++) {
        const part = pathParts[p];
        const isLast = p === pathParts.length - 1;
        const existing = current[part];
        if (isLast && isArrayOfTables) {
          if (!Array.isArray(existing)) {
            if (existing !== undefined) throw new TomlParseError(`conflicting table definition: ${headerBody}`);
            current[part] = [];
          }
          const arr = current[part] as Table[];
          const fresh: Table = {};
          arr.push(fresh);
          current = fresh;
          break;
        }
        if (Array.isArray(existing)) {
          // Dotted header targeting the latest element of an array of tables.
          const arr = existing as Table[];
          const last = arr[arr.length - 1];
          if (!isPlainTable(last)) throw new TomlParseError(`cannot descend into non-table: ${headerBody}`);
          current = last;
        } else if (isPlainTable(existing)) {
          current = existing;
        } else if (existing !== undefined) {
          throw new TomlParseError(`key redefined: ${headerBody}`);
        } else if (isLast) {
          const fresh: Table = {};
          current[part] = fresh;
          current = fresh;
        } else {
          const fresh: Table = {};
          current[part] = fresh;
          current = fresh;
        }
      }
      continue;
    }

    // key = value
    const eq = findTopLevelEquals(stripped);
    if (eq < 0) throw new TomlParseError(`expected key = value, got: ${stripped}`);
    const rawKey = stripped.slice(0, eq);
    let rawValue = stripped.slice(eq + 1).trim();
    const keyPath = splitKeyPath(rawKey);
    if (keyPath.some((p) => p === "")) throw new TomlParseError(`empty key segment in: ${stripped}`);

    // Multi-line basic strings
    if (rawValue.startsWith('"""')) {
      const rest = rawValue.slice(3);
      const value = parseMultilineBasic(cursor, rest);
      assign(current, keyPath, value);
      continue;
    }

    // Values may span lines for arrays and unquoted continuations.
    while (!isCompleteValue(rawValue)) {
      if (cursor.i >= lines.length) throw new TomlParseError(`unterminated value: ${rawValue}`);
      const nextLine = lines[cursor.i];
      cursor.i++;
      rawValue = rawValue + " " + nextLine.trim();
    }

    let value: Value;
    if (rawValue.startsWith("#")) {
      // A bare "#comment" cannot be a value: keys require values.
      throw new TomlParseError(`expected key = value, got: ${stripped}`);
    } else {
      // Strip trailing comments outside strings/arrays.
      value = parseValue(stripComment(rawValue));
    }
    assign(current, keyPath, value);
  }
  return root;
}

function isPlainTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCompleteValue(t: string): boolean {
  if (t === "") return false;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  if (quote) return false;
  if (depth > 0) return false;
  return true;
}

/** Index of the first "=" outside quotes/brackets, or -1. */
function findTopLevelEquals(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "=") return i;
  }
  return -1;
}

/** Remove a trailing `# comment`, respecting quotes and bracket depth. */
function stripComment(t: string): string {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === "#" && depth === 0) return t.slice(0, i).trim();
  }
  return t.trim();
}

function assign(table: Table, path: string[], value: Value): void {
  let cursor: Table = table;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    const existing = cursor[part];
    if (Array.isArray(existing)) {
      const arr = existing as Table[];
      const last = arr[arr.length - 1];
      if (!isPlainTable(last)) throw new TomlParseError(`cannot descend into non-table: ${path.join(".")}`);
      cursor = last;
    } else if (isPlainTable(existing)) {
      cursor = existing;
    } else if (existing !== undefined) {
      throw new TomlParseError(`key redefined: ${path.join(".")}`);
    } else {
      const fresh: Table = {};
      cursor[part] = fresh;
      cursor = fresh;
    }
  }
  const leaf = path[path.length - 1];
  if (cursor[leaf] !== undefined) throw new TomlParseError(`key redefined: ${path.join(".")}`);
  cursor[leaf] = value;
}

