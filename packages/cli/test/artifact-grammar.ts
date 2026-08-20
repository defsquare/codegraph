/**
 * Structural parsers for the artifacts `codegraph export` puts on stdout.
 *
 * "stdout parses as DOT" has to MEAN something, or stream purity is untested:
 * a `toContain("digraph")` assertion passes just as happily on
 * `Loaded 1 model\ndigraph "codegraph" {…}`, which is precisely the corruption
 * decision 3 exists to prevent. So these parsers accept the artifact grammar
 * and nothing else — a human sentence anywhere in the stream is a syntax error,
 * wherever it was inserted.
 *
 * They are deliberately small and dependency-free (decision 1 applies to the
 * package; pulling a DOT parser into devDependencies to test a zero-dependency
 * CLI would be its own kind of dishonest).
 */

export class ArtifactSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSyntaxError";
  }
}

/* ------------------------------------------------------------------ DOT --- */

interface DotToken {
  readonly kind: "id" | "punct";
  readonly value: string;
  /** Quoted ids may contain anything; bare ids are keywords, names and numbers. */
  readonly quoted: boolean;
  readonly offset: number;
}

const PUNCT = new Set(["{", "}", "[", "]", ";", ",", "=", ":"]);
const BARE_ID = /^(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*|-?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?))/;

/**
 * Comments and whitespace are skipped here, which is what lets the parser say
 * "the first thing in this document is `digraph`" even though `toDot` opens
 * with a `//` header block — a legal, and deliberate, part of the artifact.
 */
function tokenizeDot(text: string): DotToken[] {
  const tokens: DotToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "#" || (c === "/" && text.charAt(i + 1) === "/")) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new ArtifactSyntaxError(`unterminated /* comment at offset ${i}`);
      i = end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= text.length) {
          throw new ArtifactSyntaxError(`unterminated quoted string opened at offset ${i}`);
        }
        const d = text.charAt(j);
        if (d === "\\") {
          const escaped = text.charAt(j + 1);
          if (escaped === "") {
            throw new ArtifactSyntaxError(`trailing backslash at offset ${j}`);
          }
          value += escaped === "n" || escaped === "l" || escaped === "r" ? "\n" : escaped;
          j += 2;
          continue;
        }
        if (d === '"') {
          j += 1;
          break;
        }
        value += d;
        j += 1;
      }
      tokens.push({ kind: "id", value, quoted: true, offset: i });
      i = j;
      continue;
    }
    if (c === "-" && (text.charAt(i + 1) === ">" || text.charAt(i + 1) === "-")) {
      tokens.push({ kind: "punct", value: text.slice(i, i + 2), quoted: false, offset: i });
      i += 2;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: "punct", value: c, quoted: false, offset: i });
      i += 1;
      continue;
    }
    const bare = BARE_ID.exec(text.slice(i));
    if (bare === null) {
      const context = JSON.stringify(text.slice(Math.max(0, i - 30), i + 30));
      throw new ArtifactSyntaxError(
        `unexpected character ${JSON.stringify(c)} at offset ${i} — this is not DOT: ${context}`,
      );
    }
    tokens.push({ kind: "id", value: bare[0], quoted: false, offset: i });
    i += bare[0].length;
  }
  return tokens;
}

export interface DotDocument {
  readonly directed: boolean;
  readonly name: string;
  /** Ids that appear as a node statement, in emission order, duplicates kept. */
  readonly nodeIds: readonly string[];
  /** `from -> to` pairs in emission order, including any inside subgraphs. */
  readonly edges: readonly (readonly [string, string])[];
  /** Names of the `subgraph` blocks — the legend cluster shows up here. */
  readonly subgraphs: readonly string[];
  /**
   * Bare (unquoted) words used as a node or an edge endpoint.
   *
   * DOT syntax alone cannot catch a warning line injected into the body:
   * `note: 5 edges dropped` is three perfectly legal node statements, and
   * graphviz would draw boxes called "edges" and "dropped". `escapeDot` quotes
   * EVERY id codegraph emits, so in this artifact a bare word is prose by
   * construction — which is what makes stream purity checkable at all.
   */
  readonly bareWords: readonly string[];
}

/** Keywords that head a default-attribute statement rather than name a node. */
const ATTRIBUTE_KEYWORDS = new Set(["graph", "node", "edge"]);

/**
 * A DOT parser strict enough to be evidence. It accepts what `toDot` emits and
 * rejects anything else in the stream, at either end or in the middle.
 */
export function parseDot(text: string): DotDocument {
  if (text === "") throw new ArtifactSyntaxError("stdout was empty — no DOT artifact at all");
  const tokens = tokenizeDot(text);
  let p = 0;

  const peek = (): DotToken | undefined => tokens[p];
  const next = (): DotToken => {
    const token = tokens[p];
    if (token === undefined) throw new ArtifactSyntaxError("unexpected end of DOT document");
    p += 1;
    return token;
  };
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.kind !== "punct" || token.value !== value) {
      throw new ArtifactSyntaxError(
        `expected '${value}' at offset ${token.offset}, found ${JSON.stringify(token.value)}`,
      );
    }
  };
  const isBareWord = (token: DotToken | undefined, word: string): boolean =>
    token !== undefined && token.kind === "id" && !token.quoted && token.value === word;

  const nodeIds: string[] = [];
  const edges: [string, string][] = [];
  const subgraphs: string[] = [];
  const bareWords: string[] = [];

  if (isBareWord(peek(), "strict")) p += 1;
  const keyword = next();
  if (keyword.kind !== "id" || keyword.quoted || (keyword.value !== "digraph" && keyword.value !== "graph")) {
    throw new ArtifactSyntaxError(
      `a DOT document must open with 'digraph' or 'graph'; found ${JSON.stringify(keyword.value)} ` +
        `at offset ${keyword.offset}. Anything printed before it does not belong on stdout.`,
    );
  }
  const directed = keyword.value === "digraph";
  let name = "";
  const maybeName = peek();
  if (maybeName !== undefined && maybeName.kind === "id") {
    name = maybeName.value;
    p += 1;
  }
  expectPunct("{");

  /** One `[ … ]` attribute list, balanced. Contents are not interpreted. */
  const skipAttributes = (): void => {
    expectPunct("[");
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token.kind !== "punct") continue;
      if (token.value === "[") depth += 1;
      else if (token.value === "]") depth -= 1;
    }
  };

  /** A node id, plus the optional `:port[:compass]` DOT allows after it. */
  const readNodeId = (): string => {
    const token = next();
    if (token.kind !== "id") {
      throw new ArtifactSyntaxError(
        `expected a node id at offset ${token.offset}, found ${JSON.stringify(token.value)}`,
      );
    }
    if (!token.quoted) bareWords.push(token.value);
    while (peek()?.kind === "punct" && peek()?.value === ":") {
      p += 1;
      const port = next();
      if (port.kind === "id" && !port.quoted) bareWords.push(port.value);
    }
    return token.value;
  };

  const parseBlock = (): void => {
    for (;;) {
      const token = peek();
      if (token === undefined) throw new ArtifactSyntaxError("unbalanced '{' — the DOT document never closes");
      if (token.kind === "punct" && token.value === "}") {
        p += 1;
        return;
      }
      if (token.kind === "punct" && (token.value === ";" || token.value === ",")) {
        p += 1;
        continue;
      }
      if (isBareWord(token, "subgraph")) {
        p += 1;
        const after = peek();
        if (after !== undefined && after.kind === "id") {
          subgraphs.push(after.value);
          p += 1;
        }
        expectPunct("{");
        parseBlock();
        continue;
      }
      if (token.kind === "punct" && token.value === "{") {
        p += 1;
        parseBlock();
        continue;
      }
      if (token.kind !== "id") {
        throw new ArtifactSyntaxError(
          `unexpected ${JSON.stringify(token.value)} at offset ${token.offset} — not a DOT statement`,
        );
      }
      if (!token.quoted && ATTRIBUTE_KEYWORDS.has(token.value) && peek0(p + 1) === "[") {
        p += 1;
        skipAttributes();
        continue;
      }
      let left = readNodeId();
      const after = peek();
      if (after !== undefined && after.kind === "punct" && after.value === "=") {
        p += 1;
        next(); // a bare `name=value` graph attribute, not a node
        continue;
      }
      let sawArrow = false;
      while (peek()?.kind === "punct" && (peek()?.value === "->" || peek()?.value === "--")) {
        p += 1;
        const right = readNodeId();
        edges.push([left, right]);
        left = right;
        sawArrow = true;
      }
      if (!sawArrow) nodeIds.push(left);
      if (peek()?.kind === "punct" && peek()?.value === "[") skipAttributes();
    }
  };

  function peek0(index: number): string | undefined {
    const token = tokens[index];
    return token === undefined ? undefined : token.value;
  }

  parseBlock();

  if (p !== tokens.length) {
    const stray = tokens[p];
    throw new ArtifactSyntaxError(
      `trailing content after the closing '}' at offset ${stray?.offset ?? -1}: ` +
        `${JSON.stringify(stray?.value ?? "")}. Nothing may be appended to the artifact.`,
    );
  }

  return { directed, name, nodeIds, edges, subgraphs, bareWords };
}

/**
 * The assertion an export test actually wants: this stream is a DOT artifact
 * and nothing else. Syntax first, then the no-bare-words rule that catches the
 * prose DOT's own grammar would happily swallow.
 */
export function parsePureDot(text: string): DotDocument {
  const parsed = parseDot(text);
  if (parsed.bareWords.length > 0) {
    throw new ArtifactSyntaxError(
      `unquoted words used as DOT nodes: ${JSON.stringify(parsed.bareWords.slice(0, 8))}. ` +
        `codegraph quotes every id it emits, so these are human output that belongs on stderr.`,
    );
  }
  return parsed;
}

/* ------------------------------------------------------------------ CSV --- */

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** `header` plus every row, so a caller can index by column name. */
  column(row: readonly string[], name: string): string;
}

/** RFC 4180, LF-separated, as `foldedGraphToCsv` documents its own output. */
function parseCsvRecords(text: string, delimiter = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let started = false;

  const endField = (): void => {
    record.push(field);
    field = "";
    started = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (started && field !== "") {
        throw new ArtifactSyntaxError(`quote inside an unquoted CSV field at offset ${i}`);
      }
      quoted = true;
      started = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    field += c;
    started = true;
    i += 1;
  }
  if (quoted) throw new ArtifactSyntaxError("unterminated quoted CSV field at end of input");
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/**
 * Parse and check the shape a spreadsheet or `csv` reader would rely on: a
 * header, and every row with exactly as many fields as the header. A prose line
 * on stdout shows up as a row of the wrong width, which is the point.
 */
export function parseCsv(text: string, delimiter = ","): CsvTable {
  if (text === "") throw new ArtifactSyntaxError("stdout was empty — no CSV artifact at all");
  if (!text.endsWith("\n")) throw new ArtifactSyntaxError("CSV output must end with a newline");
  const records = parseCsvRecords(text, delimiter);
  const header = records[0];
  if (header === undefined) throw new ArtifactSyntaxError("CSV output has no header row");
  const rows = records.slice(1);
  rows.forEach((row, index) => {
    if (row.length !== header.length) {
      throw new ArtifactSyntaxError(
        `CSV row ${index + 2} has ${row.length} fields, the header has ${header.length}: ` +
          `${JSON.stringify(row.slice(0, 4))}. A non-CSV line on stdout looks exactly like this.`,
      );
    }
  });
  return {
    header,
    rows,
    column(row: readonly string[], name: string): string {
      const index = header.indexOf(name);
      if (index === -1) throw new ArtifactSyntaxError(`no '${name}' column in ${header.join(",")}`);
      return row[index] ?? "";
    },
  };
}

/* ----------------------------------------------------------------- JSON --- */

/**
 * `JSON.parse` is already the strictest possible purity check — one byte of
 * prose anywhere and it throws — so this only adds a readable failure and the
 * object-shaped guarantee `--json` promises (decision 8).
 */
export function parseJsonArtifact(text: string, label: string): Record<string, unknown> {
  if (text.trim() === "") throw new ArtifactSyntaxError(`${label} was empty — no JSON artifact`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ArtifactSyntaxError(
      `${label} is not valid JSON (${message}). First 200 bytes: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ArtifactSyntaxError(`${label} must be a JSON object, got ${JSON.stringify(parsed).slice(0, 120)}`);
  }
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------- JSON inspection --- */

/** Every string anywhere in a parsed JSON value. Key names are not included. */
export function collectStrings(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

/**
 * Values found under any key whose NAME matches `pattern`, at any depth.
 *
 * Parity and union tests need to find "the duplicate-id information" without
 * pinning the exact key an unwritten command will choose — the fact must be
 * there, its spelling is the implementer's call.
 */
export function valuesUnderKey(value: unknown, pattern: RegExp, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) valuesUnderKey(item, pattern, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (pattern.test(key)) into.push(item);
      valuesUnderKey(item, pattern, into);
    }
  }
  return into;
}

/** Entity ids as they appear in output. Ids are opaque, but a TEST may match them. */
export const ENTITY_ID = /\bjava:[^\s"',;\]]+/g;

export function entityIdsIn(text: string): Set<string> {
  return new Set(text.match(ENTITY_ID) ?? []);
}
