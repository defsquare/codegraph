/**
 * Structural readers for the analyzer's text exports.
 *
 * Graphviz is NOT installed on this machine, so DOT is verified by parsing it
 * here rather than by shelling out to `dot`. Both readers are deliberately
 * dumb and independent of the export implementation: a test that reuses the
 * writer's own escaping helper proves nothing.
 */

/** The `"…"` spans of a DOT source, in order, with `\"` and `\\` honoured. */
export function dotQuotedSpans(dot: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < dot.length) {
    if (dot[i] !== '"') {
      i += 1;
      continue;
    }
    let j = i + 1;
    let body = "";
    for (; j < dot.length; j += 1) {
      const c = dot[j];
      if (c === "\\") {
        body += dot[j + 1] ?? "";
        j += 1;
        continue;
      }
      if (c === '"') break;
      body += c;
    }
    if (j >= dot.length) throw new Error(`unterminated DOT string at offset ${String(i)}`);
    spans.push(body);
    i = j + 1;
  }
  return spans;
}

/** The source with every quoted span blanked out — where DOT syntax lives. */
export function dotOutsideQuotes(dot: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < dot.length; i += 1) {
    const c = dot[i]!;
    if (inString) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    out += c;
  }
  if (inString) throw new Error("unterminated DOT string");
  return out;
}

/** True when braces balance and no string is left open, ignoring quoted text. */
export function dotIsWellFormed(dot: string): boolean {
  let depth = 0;
  for (const c of dotOutsideQuotes(dot)) {
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Non-empty, non-comment statement lines. */
export function dotStatements(dot: string): string[] {
  return dot
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("#"));
}

/** Statement lines carrying an edge operator OUTSIDE any quoted label. */
export function dotEdgeStatements(dot: string): string[] {
  return dotStatements(dot).filter((line) => dotOutsideQuotes(line).includes("->"));
}

/**
 * Statements that declare a node, keyed by the id they declare.
 *
 * A node statement opens with its (quoted) id, which excludes `digraph "x" {`
 * and the closing brace. Keyed on the FIRST quoted span, never on
 * `includes(id)`: `java:com.acme.order` is a prefix of
 * `java:com.acme.order.adapter`, so substring matching silently tests the
 * wrong node.
 */
export function dotNodeStatements(dot: string): Map<string, string> {
  const edges = new Set(dotEdgeStatements(dot));
  const out = new Map<string, string>();
  for (const line of dotStatements(dot)) {
    if (edges.has(line) || !line.startsWith('"')) continue;
    const id = dotQuotedSpans(line)[0];
    if (id !== undefined) out.set(id, line);
  }
  return out;
}

/** Key for an edge lookup. JSON-encoded, so no id character can act as a separator. */
export function pairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

/** Edge statements keyed by `pairKey`, from their first two quoted spans. */
export function dotEdgeStatementsByPair(dot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of dotEdgeStatements(dot)) {
    const spans = dotQuotedSpans(line);
    if (spans.length >= 2) out.set(pairKey(spans[0]!, spans[1]!), line);
  }
  return out;
}

/**
 * The bracketed attribute list of one statement, `[]` stripped, or "" when the
 * statement carries none. A quoted `]` does not terminate it.
 */
export function dotAttributes(line: string): string {
  const open = firstUnquoted(line, "[");
  const close = lastUnquoted(line, "]");
  if (open < 0 || close < open) return "";
  return line.slice(open + 1, close).trim();
}

function firstUnquoted(line: string, char: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === char) return i;
  }
  return -1;
}

function lastUnquoted(line: string, char: string): number {
  let inString = false;
  let last = -1;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === char) last = i;
  }
  return last;
}

/** Attribute list split into `key=value` tokens, quoted commas respected. */
export function dotAttributeTokens(line: string): string[] {
  const attrs = dotAttributes(line);
  if (attrs.length === 0) return [];
  const tokens: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < attrs.length; i += 1) {
    const c = attrs[i]!;
    if (inString) {
      current += c;
      if (c === "\\") {
        current += attrs[i + 1] ?? "";
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      current += c;
      continue;
    }
    if (c === "," || c === ";") {
      tokens.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  tokens.push(current.trim());
  return tokens.filter((token) => token.length > 0);
}

/**
 * RFC 4180 reader: a field may be quoted, and a quoted field may contain the
 * delimiter, a newline or a doubled quote. Rows are returned as raw fields.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      endRow();
      continue;
    }
    field += c;
    started = true;
  }
  if (inQuotes) throw new Error("unterminated CSV quote");
  if (started || field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * Derived inverse indexes (CLAUDE.md invariant 4). None of these may appear as
 * a key or a column in anything an export produces — they are rebuilt in memory
 * on every run and must never reach a file.
 */
export const INVERSE_INDEX_KEYS: readonly string[] = [
  "callers",
  "incoming",
  "subtypes",
  "importers",
  "accessors",
  "implementers",
];

/** Every object key reachable from a value; arrays walked, cycles not expected. */
export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(child, into);
  }
  return into;
}
