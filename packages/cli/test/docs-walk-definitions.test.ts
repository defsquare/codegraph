import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTerm } from "@codegraph/analyzer";
import {
  DEFAULT_WALK_DEFINITION,
  EXPLAIN_WALK_DEFINITION,
  parseExplainFile,
  parseWalkDefinition,
} from "@codegraph/insights";

/**
 * THE WALK EXAMPLES IN THE DOCUMENTATION ARE CHECKED (PLAN.md §22.6, step 8).
 *
 * A `codegraph.walk/1` example that stopped matching the schema still LOOKS
 * like a definition; the reader finds out when `codegraph walk --walk FILE`
 * refuses it. So every fenced ```json block of `README.md`, `docs/**` and
 * `website/content/**` whose `kind` is `codegraph.walk/1` is parsed by the
 * schema the command uses:
 *
 *  - a block whose `name` is `explain` is an explain customization file
 *    (`codegraph explain --walk FILE`) and goes through `parseExplainFile`;
 *    every other block is a walk definition and goes through
 *    `parseWalkDefinition` (which refuses the name `explain` anyway);
 *  - a block named `adhoc` is the printed default (`walk --print-definition`)
 *    and must equal it; an explain block carrying `answer` is the printed
 *    built-in (`walk --print-definition explain`) and must equal it.
 *
 * And every `--include` / `--exclude` term of a `codegraph walk` or
 * `codegraph explain` command in a fenced shell block (```bash, ```sh,
 * ```shell; in ```console only the `$ ` lines) must parse with `parseTerm`.
 * A deliberately invalid example belongs in a ```text fence.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCES = ["README.md", "docs", "website/content"];
const SHELL = new Set(["bash", "sh", "shell", "zsh"]);

function markdownFiles(path: string): string[] {
  if (statSync(path).isFile()) return path.endsWith(".md") ? [path] : [];
  return readdirSync(path)
    .sort()
    .flatMap((entry) => markdownFiles(join(path, entry)));
}

interface Fence {
  readonly where: string;
  readonly info: string;
  readonly body: string;
}

/** Every fenced block, with the file and line it opens on. A fence closes on a run of its own character at least as long. */
function fences(file: string): Fence[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/u.exec(lines[i] as string);
    if (open === null) continue;
    const marker = open[1] as string;
    const close = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`, "u");
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !close.test(lines[i] as string); i++) body.push(lines[i] as string);
    found.push({ where: `${relative(ROOT, file)}:${start + 1}`, info: (open[2] as string).toLowerCase(), body: body.join("\n") });
  }
  return found;
}

const ALL_FENCES = SOURCES.flatMap((source) => markdownFiles(join(ROOT, source))).flatMap(fences);

const WALK_KIND = /"kind"\s*:\s*"codegraph\.walk\/1"/u;
const definitions = ALL_FENCES.filter((fence) => fence.info === "json" && WALK_KIND.test(fence.body));

/** The shell words of a command line — quotes and backslashes resolved, operators (`|`, `&&`, `;`…) as their own words, comments dropped. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? "") + line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) i++;
        word += line[i];
      }
    } else if (c === "\\") {
      word = (word ?? "") + (line[++i] ?? "");
    } else if (/\s/u.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "#" && word === undefined) {
      break;
    } else if ("|&;".includes(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      const operator = line[i + 1] === c ? c + c : c;
      words.push(operator);
      i += operator.length - 1;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** The logical command lines of a shell block: continuations joined; in a console block, only what follows `$ `. */
function commandLines(fence: Fence): string[] {
  const joined: string[] = [];
  let pending = "";
  let open = false;
  for (const raw of fence.body.split("\n")) {
    let line = raw;
    if (fence.info === "console" && !open) {
      if (!line.startsWith("$ ")) continue;
      line = line.slice(2);
    }
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      open = true;
      continue;
    }
    joined.push(pending + line);
    pending = "";
    open = false;
  }
  if (pending !== "") joined.push(pending);
  return joined;
}

interface Term {
  readonly where: string;
  readonly flag: string;
  readonly text: string;
}

/** Every `--include`/`--exclude` value of a `codegraph walk|explain` command. */
function termsOf(fence: Fence): Term[] {
  const terms: Term[] = [];
  for (const line of commandLines(fence)) {
    const words = shellWords(line);
    const commands: string[][] = [[]];
    for (const word of words) {
      if (["|", "||", "&&", ";", "&"].includes(word)) commands.push([]);
      else commands[commands.length - 1]?.push(word);
    }
    for (const command of commands) {
      const at = command.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
      const program = command[at];
      if (program === undefined || !/(^|\/)codegraph$/u.test(program)) continue;
      if (command[at + 1] !== "walk" && command[at + 1] !== "explain") continue;
      for (let i = at + 2; i < command.length; i++) {
        const word = command[i] as string;
        const flag = /^--(include|exclude)(=|$)/u.exec(word);
        if (flag === null) continue;
        const text = flag[2] === "=" ? word.slice(flag[0].length) : command[++i];
        if (text !== undefined) terms.push({ where: fence.where, flag: `--${flag[1] as string}`, text });
      }
    }
  }
  return terms;
}

const terms = ALL_FENCES.filter((fence) => SHELL.has(fence.info) || fence.info === "console").flatMap(termsOf);

describe("the documentation's codegraph.walk/1 examples parse through the schema", () => {
  it("finds the examples: walk definitions, explain files, and both printed forms", () => {
    // 7 walk definitions and 2 explain files when this test was written; a floor keeps them from vanishing unnoticed.
    const explainFiles = definitions.filter((fence) => (JSON.parse(fence.body) as { name?: unknown }).name === "explain");
    expect(definitions.length - explainFiles.length).toBeGreaterThanOrEqual(7);
    expect(explainFiles.length).toBeGreaterThanOrEqual(2);
    expect(definitions.some((fence) => (JSON.parse(fence.body) as { name?: unknown }).name === "adhoc")).toBe(true);
  });

  it.each(definitions.map((fence) => [fence.where, fence] as const))("%s", (_where, fence) => {
    const json = JSON.parse(fence.body) as Record<string, unknown>;
    if (json["name"] === "explain") {
      expect(() => parseExplainFile(json)).not.toThrow();
      if ("answer" in json) expect(json).toEqual(EXPLAIN_WALK_DEFINITION);
    } else {
      expect(() => parseWalkDefinition(json)).not.toThrow();
      if (json["name"] === "adhoc") expect(json).toEqual(DEFAULT_WALK_DEFINITION);
    }
  });
});

describe("the documentation's --include / --exclude terms parse", () => {
  it("finds the terms", () => {
    expect(terms.length).toBeGreaterThanOrEqual(10);
  });

  it.each(terms.map((term) => [`${term.where} ${term.flag} ${term.text}`, term] as const))("%s", (_name, term) => {
    expect(() => parseTerm(term.text)).not.toThrow();
  });

  it("reads a shell line as the shell does", () => {
    expect(shellWords(`codegraph walk m.jsonl --include 'edge:invocation>name:A b' --exclude "file:**/x/**" # --include bad`)).toEqual([
      "codegraph",
      "walk",
      "m.jsonl",
      "--include",
      "edge:invocation>name:A b",
      "--exclude",
      "file:**/x/**",
    ]);
    expect(
      termsOf({ where: "t", info: "console", body: "$ X=1 ./bin/codegraph explain m --include=id:a \\\n  --exclude 'kind:class' | grep --include=x y\nout --include no" }).map((t) => t.text),
    ).toEqual(["id:a", "kind:class"]);
  });
});
