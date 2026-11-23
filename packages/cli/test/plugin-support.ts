import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reading the plugin, for the tests that hold it to the CLI (PLAN.md §24.8).
 *
 * `plugin/` is text and SQL: skills an agent follows, references it reads,
 * queries it runs. Nothing imports it and it imports nothing, so nothing but
 * a test can notice that a skill spells a flag the parser dropped, runs a
 * query that no longer matches the page it was taken from, or names a file
 * that is not there. These helpers read that text the way an agent will.
 */

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PLUGIN_ROOT = join(REPO_ROOT, "plugin");
export const DOCS_ROOT = join(REPO_ROOT, "website", "content", "docs");

export function readRepo(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

export function readPlugin(path: string): string {
  return readFileSync(join(PLUGIN_ROOT, path), "utf8");
}

export function readDoc(path: string): string {
  return readFileSync(join(DOCS_ROOT, path), "utf8");
}

/** Every file of the plugin, relative to its root, sorted. */
export function pluginFiles(directory = ""): string[] {
  return readdirSync(join(PLUGIN_ROOT, directory))
    .sort()
    .flatMap((name) => {
      const path = directory === "" ? name : `${directory}/${name}`;
      return statSync(join(PLUGIN_ROOT, path)).isDirectory() ? pluginFiles(path) : [path];
    });
}

// ------------------------------------------------------------------ skills

export interface Skill {
  /** The directory name, which is the skill's name after `codegraph:`. */
  readonly name: string;
  /** `skills/<name>/SKILL.md`, relative to the plugin root. */
  readonly path: string;
  readonly text: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  /** The text after the frontmatter: what the agent reads. */
  readonly body: string;
}

/**
 * The frontmatter of a SKILL.md: `key: value` lines between two `---` lines.
 * Deliberately not a YAML parser — a skill here uses one-line string values,
 * and a value this cannot read is a value to simplify, not to support.
 */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error("no frontmatter: a SKILL.md begins with a --- block");
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field === null) throw new Error(`frontmatter line is not 'key: value': ${line}`);
    const raw = field[2]!.trim();
    frontmatter[field[1]!] = /^".*"$/.test(raw) ? (JSON.parse(raw) as string) : raw;
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

export function skills(): Skill[] {
  return readdirSync(join(PLUGIN_ROOT, "skills"))
    .sort()
    .map((name) => {
      const path = `skills/${name}/SKILL.md`;
      const text = readPlugin(path);
      return { name, path, text, ...parseFrontmatter(text) };
    });
}

// ----------------------------------------------------------- fenced blocks

export interface Fence {
  /** The info string: `bash`, `sql`, `json`, or empty. */
  readonly lang: string;
  readonly text: string;
  /** The 1-based line of the block's first content line. */
  readonly line: number;
}

/** Every fenced block of a markdown text, in order. Indented fences (inside a list) count. */
export function fences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const out: Fence[] = [];
  let open: { lang: string; start: number; indent: string } | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^(\s*)```(\S*)\s*$/.exec(line);
    if (marker === null) continue;
    if (open === undefined) {
      open = { lang: marker[2]!, start: index + 1, indent: marker[1]! };
    } else {
      const indent = open.indent;
      const body = lines.slice(open.start, index).map((text) => (text.startsWith(indent) ? text.slice(indent.length) : text));
      out.push({ lang: open.lang, text: body.join("\n"), line: open.start + 1 });
      open = undefined;
    }
  }
  if (open !== undefined) throw new Error(`a fenced block opened at line ${open.start} is never closed`);
  return out;
}

/** The text of a markdown file outside its fenced blocks: the prose. */
export function prose(markdown: string): string {
  let inside = false;
  return markdown
    .split("\n")
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inside = !inside;
        return false;
      }
      return !inside;
    })
    .join("\n");
}

export interface CommandLine {
  /** Where it is, for a failure message: `skills/discover/SKILL.md:88`. */
  readonly at: string;
  /** The words of the command, quotes resolved, redirections and what follows a pipe removed. */
  readonly words: readonly string[];
}

/** Split one shell line into words: quotes group, a backslash escapes. No expansion. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && at + 1 < line.length) {
      word += line[at + 1]!;
      at += 1;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word !== "") words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
    }
  }
  if (quote !== undefined) throw new Error(`unbalanced quote in: ${line}`);
  if (started || word !== "") words.push(word);
  return words;
}

/**
 * The commands of a markdown file's `bash` blocks, one per logical line: a
 * trailing backslash continues a line, a `#` comment ends one, and the words
 * stop at the first redirection, pipe or `&&` — what is asked of the command
 * itself, which is what its parser will see.
 */
export function commandLines(path: string, markdown: string): CommandLine[] {
  const out: CommandLine[] = [];
  for (const fence of fences(markdown)) {
    if (fence.lang !== "bash") continue;
    let pending = "";
    let start = fence.line;
    for (const [offset, raw] of fence.text.split("\n").entries()) {
      if (pending === "") start = fence.line + offset;
      if (raw.endsWith("\\")) {
        pending += `${raw.slice(0, -1)} `;
        continue;
      }
      const logical = (pending + raw).trim();
      pending = "";
      if (logical === "" || logical.startsWith("#")) continue;
      const words = shellWords(logical);
      const comment = words.findIndex((word) => word.startsWith("#"));
      const stop = words.findIndex((word) => /^(\d?>>?|\||&&|\|\||;)$/.test(word) || /^\d?>/.test(word));
      const cut = [comment, stop].filter((index) => index !== -1);
      out.push({ at: `${path}:${start}`, words: cut.length === 0 ? words : words.slice(0, Math.min(...cut)) });
    }
  }
  return out;
}

// --------------------------------------------------------------- queries

export interface QueryFile {
  /** The file name without `.sql`. */
  readonly name: string;
  /** The documentation page the statement is shown on, relative to the docs root. */
  readonly page: string;
  readonly what: string;
  /** The declared parameters, by name without the colon; empty for `none`. */
  readonly parameters: readonly string[];
  /** The statement alone: the file minus its header comment. */
  readonly statement: string;
}

/**
 * A query file is a three-line header and one statement:
 *
 *   -- page: discover/structure.md
 *   -- what: source lines per module, with its share of the whole
 *   -- parameters: none            (or  :id — the entity, :n — how many)
 *
 *   SELECT …;
 */
export function parseQueryFile(name: string, text: string): QueryFile {
  const header = /^-- page: (\S+)\n-- what: (.+)\n-- parameters: (.+)\n\n/.exec(text);
  if (header === null) {
    throw new Error(`${name}.sql does not begin with the three header lines (page, what, parameters) and a blank line`);
  }
  const declared = header[3]!.trim();
  const parameters = declared === "none" ? [] : [...declared.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
  return { name, page: header[1]!, what: header[2]!, parameters, statement: text.slice(header[0].length).trim() };
}

export function queryFiles(): QueryFile[] {
  return readdirSync(join(PLUGIN_ROOT, "queries"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => parseQueryFile(file.slice(0, -".sql".length), readPlugin(`queries/${file}`)));
}

export interface PageSql {
  readonly sql: string;
  readonly line: number;
  /** The markdown table printed right after the block, when there is one: its data rows. */
  readonly table: readonly (readonly string[])[] | undefined;
}

/** A cell as the page prints it, without the code span around an id. */
const cell = (text: string): string => text.trim().replace(/^`(.*)`$/, "$1");

/**
 * Every `sql` block of a page, each with the table the page prints under it —
 * the next table before any other block or heading.
 */
export function pageSql(markdown: string): PageSql[] {
  const lines = markdown.split("\n");
  return fences(markdown)
    .filter((fence) => fence.lang === "sql")
    .map((fence) => {
      // `fence.line` is the first content line; the block closes after its text.
      let at = fence.line - 1 + fence.text.split("\n").length + 1;
      while (at < lines.length && lines[at]!.trim() === "") at += 1;
      if (at >= lines.length || !lines[at]!.trim().startsWith("|")) return { sql: fence.text.trim(), line: fence.line, table: undefined };
      const rows: string[][] = [];
      for (; at < lines.length && lines[at]!.trim().startsWith("|"); at += 1) {
        rows.push(lines[at]!.trim().replace(/^\||\|$/g, "").split("|").map(cell));
      }
      // rows[0] is the header, rows[1] the |---| rule.
      return { sql: fence.text.trim(), line: fence.line, table: rows.slice(2) };
    });
}

export interface PageCommandTable {
  /** The query file the command runs: the `NAME` of its `--file NAME.sql`. */
  readonly file: string;
  /** The whole command, as the page writes it, continuation lines joined. */
  readonly command: string;
  readonly line: number;
  readonly table: readonly (readonly string[])[];
}

/**
 * The other way a page shows a query: the COMMAND that runs a query file, then
 * the rows it printed. A page whose statements are long keeps them together at
 * its end and shows this where it explains them. The file is the one the last
 * command of the block names.
 */
export function pageCommandTables(markdown: string): PageCommandTable[] {
  const lines = markdown.split("\n");
  const out: PageCommandTable[] = [];
  for (const fence of fences(markdown)) {
    if (fence.lang !== "bash") continue;
    const commands = fence.text.replace(/\\\n\s*/g, " ").split("\n").filter((text) => text.trim() !== "");
    const command = commands[commands.length - 1] ?? "";
    const file = /--file (\S+)\.sql/.exec(command)?.[1];
    if (file === undefined) continue;
    let at = fence.line - 1 + fence.text.split("\n").length + 1;
    while (at < lines.length && lines[at]!.trim() === "") at += 1;
    if (at >= lines.length || !lines[at]!.trim().startsWith("|")) continue;
    const rows: string[][] = [];
    for (; at < lines.length && lines[at]!.trim().startsWith("|"); at += 1) {
      rows.push(lines[at]!.trim().replace(/^\||\|$/g, "").split("|").map(cell));
    }
    out.push({ file, command, line: fence.line, table: rows.slice(2) });
  }
  return out;
}

// ----------------------------------------------- a JSON Schema, checked small

const ANNOTATIONS = new Set(["$schema", "title", "description", "$defs"]);
const CHECKED = new Set(["type", "const", "enum", "properties", "required", "additionalProperties", "items", "oneOf", "$ref", "minimum"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [keyword: string]: Json };

function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The keywords a schema uses that this checker does not check — any is a hole in the test. */
export function uncheckedKeywords(schema: Json, path = "#"): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: string[] = [];
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword.startsWith("x-") || ANNOTATIONS.has(keyword)) {
      if (keyword === "$defs") for (const [name, def] of Object.entries(value as Schema)) out.push(...uncheckedKeywords(def, `${path}/$defs/${name}`));
      continue;
    }
    if (!CHECKED.has(keyword)) out.push(`${path}: ${keyword}`);
    if (keyword === "properties") for (const [name, sub] of Object.entries(value as Schema)) out.push(...uncheckedKeywords(sub, `${path}/${name}`));
    if (keyword === "items" || keyword === "additionalProperties") out.push(...uncheckedKeywords(value, `${path}/${keyword}`));
    if (keyword === "oneOf") (value as Json[]).forEach((sub, index) => out.push(...uncheckedKeywords(sub, `${path}/oneOf/${index}`)));
  }
  return out;
}

/**
 * Validate a value against the subset of JSON Schema 2020-12 the state's
 * schema is written in. Returns the violations, each with its path; empty
 * means valid. No dependency: the workspace has no schema validator, and the
 * ten keywords used here do not justify one.
 */
export function schemaViolations(root: Schema, value: Json, schema: Json = root, path = "$"): string[] {
  if (schema === true || schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: string[] = [];
  const node = schema as Schema;

  if (typeof node["$ref"] === "string") {
    const target = node["$ref"].replace(/^#\/\$defs\//, "");
    const resolved = (root["$defs"] as Schema | undefined)?.[target];
    if (resolved === undefined) throw new Error(`unresolved $ref ${node["$ref"]}`);
    out.push(...schemaViolations(root, value, resolved, path));
  }
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node["const"])) {
    out.push(`${path}: expected ${JSON.stringify(node["const"])}`);
  }
  if (Array.isArray(node["enum"]) && !node["enum"].some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node["enum"])}`);
  }
  if (node["type"] !== undefined) {
    const allowed = Array.isArray(node["type"]) ? node["type"] : [node["type"]];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
      out.push(`${path}: is ${actual}, expected ${allowed.join(" or ")}`);
      return out;
    }
  }
  if (typeof node["minimum"] === "number" && typeof value === "number" && value < node["minimum"]) {
    out.push(`${path}: ${value} is below ${node["minimum"]}`);
  }
  if (Array.isArray(node["oneOf"])) {
    const matches = node["oneOf"].filter((option) => schemaViolations(root, value, option, path).length === 0).length;
    if (matches !== 1) out.push(`${path}: matches ${matches} of the ${node["oneOf"].length} alternatives, expected exactly 1`);
  }
  if (Array.isArray(value) && node["items"] !== undefined) {
    value.forEach((item, index) => out.push(...schemaViolations(root, item, node["items"]!, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = (node["properties"] ?? {}) as Schema;
    for (const name of (node["required"] ?? []) as string[]) {
      if (!(name in value)) out.push(`${path}: missing ${name}`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (name in properties) out.push(...schemaViolations(root, item, properties[name]!, `${path}.${name}`));
      else if (node["additionalProperties"] === false) out.push(`${path}: unknown field ${name}`);
      else if (node["additionalProperties"] !== undefined) {
        out.push(...schemaViolations(root, item, node["additionalProperties"], `${path}.${name}`));
      }
    }
  }
  return out;
}
