import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, parseInvocation, UsageError, type Invocation } from "../src/args.js";
import { commandLines, pluginFiles, prose, readPlugin, readRepo, skills, PLUGIN_ROOT, REPO_ROOT, type CommandLine } from "./plugin-support.js";

/**
 * EVERY COMMAND A SKILL WRITES EXISTS (PLAN.md §24.8).
 *
 * A skill is prose with command lines in it, and an agent runs them as
 * written. Nothing compiles a skill: a flag renamed in `args.ts` would leave
 * the skill spelling the old one until a person, mid-walk, watched it fail.
 * So each `codegraph …` line of the plugin is handed to the parser the binary
 * uses — the option specs are data, which is what makes this a test and not a
 * convention. An extractor's line is held to the one flag shape every
 * extractor honours (the container contract, `schemas/README.md` §8).
 *
 * Three of the plan's hazards (§24.9) are pinned on the way: a page is only
 * ever served on loopback, nothing is confirmed on the person's behalf, and
 * no file named in a skill is missing from the plugin.
 */

const MARKDOWN = pluginFiles().filter((path) => path.endsWith(".md"));

/** What a placeholder stands for, so a line can be parsed as it would be typed. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  REPO: "/repo",
  WS: "/repo/.codegraph",
  ROOT: "main",
  SRC: "src/main/java",
  MODEL: "/repo/.codegraph/main.jsonl",
  HISTORY: "/repo/.codegraph/history.jsonl",
  // Step 5: the run the person agreed to, and the readings of steps 5 and 6.
  PROVIDER: "openrouter",
  LEAF: "openai/gpt-5.6-luna",
  ROLLUP: "openai/gpt-5.6-luna",
  DEPTH: "1",
  SCOPE: "java:com.acme.order/Order,java:com.acme.order/Money",
  CALLS: "53",
  IN: "0.10",
  OUT: "0.60",
  STDLIB: '["java.*"]',
  CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
};

/** Replace `$NAME` and `${NAME}`; a name outside the closed list is returned as unknown. */
function substitute(word: string): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const value = PLACEHOLDERS[name];
    if (value === undefined) unknown.push(whole);
    return value ?? whole;
  });
  return { text, unknown };
}

const lines: CommandLine[] = MARKDOWN.flatMap((path) => commandLines(path, readPlugin(path)));
const cliLines = lines.filter((line) => line.words[0] === "codegraph");
const toolLines = lines.filter((line) => /^codegraph-/.test(line.words[0] ?? ""));

function parse(line: CommandLine): Invocation {
  const argv = line.words.slice(1).map((word) => substitute(word).text);
  try {
    return parseInvocation(argv);
  } catch (error) {
    const reason = error instanceof UsageError ? `${error.message}\n${error.hint ?? ""}` : String(error);
    throw new Error(`${line.at}: codegraph ${argv.join(" ")}\n  is refused by the parser: ${reason}`);
  }
}

describe("the plugin's command lines are found", () => {
  it("reads enough of them for this file to mean something", () => {
    // A fence regex that matched nothing would make every test below pass.
    expect(cliLines.length).toBeGreaterThanOrEqual(10);
    expect(toolLines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("every codegraph line a skill writes is accepted by the parser", () => {
  it.each(cliLines.map((line) => [line.at, line] as const))("%s", (_at, line) => {
    const invocation = parse(line);
    // `--help` and `--version` parse without touching a spec: only `--version` is a command a skill runs.
    if (invocation.kind === "version") return;
    expect(invocation.kind, `${line.at} asks for help instead of running a command`).toBe("run");
  });

  it("uses only placeholders from the closed list", () => {
    const unknown = [...cliLines, ...toolLines].flatMap((line) =>
      line.words.flatMap((word) => substitute(word).unknown.map((name) => `${line.at}: ${name}`)),
    );
    expect(unknown).toEqual([]);
  });

  it("defines, in its own text, every placeholder a skill's commands use", () => {
    const undefinedOnes: string[] = [];
    for (const skill of skills()) {
      const text = prose(skill.body);
      const used = new Set(
        commandLines(skill.path, skill.text)
          .flatMap((line) => line.words)
          .flatMap((word) => [...word.matchAll(/\$([A-Z][A-Z0-9_]*)\b/g)].map((match) => match[1]!)),
      );
      for (const name of used) {
        if (!(name in PLACEHOLDERS)) continue; // shell variables of a snippet, not placeholders
        if (!text.includes(`\`$${name}\``)) undefinedOnes.push(`${skill.path}: $${name}`);
      }
    }
    expect(undefinedOnes).toEqual([]);
  });

  it("names only commands this binary has", () => {
    const named = new Set(cliLines.map((line) => line.words[1]).filter((word) => word !== undefined && !word.startsWith("-")));
    for (const command of named) expect(COMMAND_NAMES as readonly string[]).toContain(command);
  });
});

describe("the hazards a command line can carry (PLAN.md §24.9)", () => {
  it("serves a page on loopback, every time", () => {
    const serving = cliLines.filter((line) => line.words[1] === "serve");
    // One picture per step: the city by complexity, the map (plain and by
    // Spring role), the city by recent churn, the navigator.
    expect(serving.length, "each of the four steps shows a page").toBeGreaterThanOrEqual(5);
    for (const line of serving) {
      const invocation = parse(line);
      if (invocation.kind !== "run" || invocation.command !== "serve") throw new Error(`${line.at} is not a serve`);
      expect(invocation.options.host, `${line.at} would bind every interface`).toBe("127.0.0.1");
    }
    // `history --serve` is a server too, under another command's name.
    const replays = cliLines.map((line) => ({ line, invocation: parse(line) })).filter(
      ({ invocation }) => invocation.kind === "run" && invocation.command === "history" && invocation.options.serve,
    );
    expect(replays.length).toBeGreaterThan(0);
    for (const { line, invocation } of replays) {
      if (invocation.kind !== "run" || invocation.command !== "history") continue;
      expect(invocation.options.host, `${line.at} would bind every interface`).toBe("127.0.0.1");
    }
  });

  it("restyles one city per step: each step's page has its own bindings", () => {
    const bindings = (name: string): string[] =>
      commandLines(`skills/${name}/SKILL.md`, readPlugin(`skills/${name}/SKILL.md`))
        .filter((line) => line.words[0] === "codegraph" && line.words[1] === "serve")
        .map((line) => {
          const invocation = parse(line);
          if (invocation.kind !== "run" || invocation.command !== "serve") throw new Error(`${line.at} is not a serve`);
          const options = invocation.options as { height?: string; footprint?: string; framework?: string; carry?: readonly string[] };
          return [options.height ?? "-", options.footprint ?? "-", options.framework ?? "-", (options.carry ?? []).join("+") || "-"].join(" ");
        });
    // `loc` and `members` are the city's defaults: step 2's picture is the Graph tab, not a restyled city.
    expect(bindings("discover-1-structure")).toEqual(["sum:cyclomatic loc - -"]);
    expect(bindings("discover-2-boundaries")).toEqual(["loc members - -", "loc members spring -"]);
    expect(bindings("discover-3-activity")).toEqual(["history-file:churn_recent members - history:risk_score"]);
    // Step 4's picture is the Navigate tab: an entry point's fan-out, one hop per click.
    expect(bindings("discover-4-stimuli")).toEqual(["loc members - -"]);
    // Step 5 raises the buildings that spell a word the glossary flags; step 6 is the Graph tab again.
    expect(bindings("discover-5-meaning")).toEqual(["vocabulary:pet members - -"]);
    expect(bindings("discover-6-domain")).toEqual(["loc members - -"]);
  });

  /**
   * PLAN §24, principle 4: no money spent without a yes per scope. Until M23d
   * this read "no line carries --yes"; step 5 must now say how a run starts once
   * the person has agreed, so the property is restated as what it guarded: one
   * line answers the confirmation, it is `explain`'s run in step 5's Ask beat,
   * it carries the scope, provider and call bound that were agreed to, and every
   * `explain` before it in that step only plans or estimates.
   */
  it("answers a confirmation only after the person's yes, for a stated scope, provider and bound", () => {
    const confirmed = cliLines.filter((line) => line.words.includes("--yes") || line.words.includes("-y"));
    expect(confirmed.map((line) => line.at.replace(/:\d+$/, ""))).toEqual(["skills/discover-5-meaning/SKILL.md"]);
    const [run] = confirmed;
    const invocation = parse(run!);
    if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error(`${run!.at} is not an explain run`);
    const options = invocation.options as { scope: readonly string[]; provider: string; maxCalls?: number; dryRun: boolean; estimate: boolean; importFrom?: string };
    expect(options.scope.length, "a stated scope").toBeGreaterThan(0);
    expect(options.provider, "a stated provider").not.toBe("auto");
    expect(options.maxCalls, "a bound in calls").toBeDefined();
    expect([options.dryRun, options.estimate, options.importFrom]).toEqual([false, false, undefined]);

    const skill = skills().find((candidate) => candidate.name === "discover-5-meaning")!;
    const lineOf = (at: string): number => Number(at.slice(at.lastIndexOf(":") + 1));
    const heading = (name: string): number => skill.text.split("\n").findIndex((line) => line === `## ${name}`) + 1;
    expect(lineOf(run!.at)).toBeGreaterThan(heading("Ask"));
    expect(lineOf(run!.at)).toBeLessThan(heading("Write"));
    const ask = prose(skill.text.split("\n").slice(heading("Ask"), lineOf(run!.at)).join("\n"));
    expect(ask).toMatch(/Only after an explicit yes/);
    // Before the run, in the same step: explain only plans or estimates.
    const explains = commandLines(skill.path, skill.text).filter((line) => line.words[1] === "explain" && lineOf(line.at) < lineOf(run!.at));
    expect(explains.length).toBeGreaterThanOrEqual(3);
    for (const line of explains) {
      const parsed = parse(line);
      if (parsed.kind !== "run" || parsed.command !== "explain") throw new Error(`${line.at} is not explain`);
      const flags = parsed.options as { dryRun: boolean; estimate: boolean };
      expect(flags.dryRun || flags.estimate, `${line.at} would make calls`).toBe(true);
    }
    expect(explains[0]!.words, "the plan comes first").toContain("--dry-run");
  });

  it("writes a query's rows and a report into the workspace, never beside the plugin", () => {
    for (const path of MARKDOWN) {
      for (const match of readPlugin(path).matchAll(/>\s*"?(\$\{?[A-Za-z_]+\}?[^\s"]*)/g)) {
        expect(match[1], `${path}: a redirection outside the workspace`).toMatch(/^\$WS\/|^\$EXCLUDE$/);
      }
    }
  });
});

describe("an extractor's line is the contract's flag shape", () => {
  const catalogue = JSON.parse(readRepo("apps/desktop/src-tauri/resources/extractors.json")) as {
    name: string;
    command: string;
    role?: string;
  }[];
  const extractors = new Set(catalogue.filter((entry) => entry.role !== "pass").map((entry) => entry.command));

  /** The flags of the usage block in the container contract, §8. */
  const contract = readRepo("schemas/README.md");
  const usage = /<extractor> \[--src[\s\S]*?```/.exec(contract)?.[0] ?? "";
  const contractFlags = new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]));

  it("finds the contract's usage block", () => {
    expect(contractFlags.has("--src")).toBe(true);
    expect(contractFlags.has("--out")).toBe(true);
    expect(contractFlags.size).toBeGreaterThanOrEqual(8);
  });

  it("uses an extractor the catalogue knows, with flags every extractor honours", () => {
    const problems: string[] = [];
    for (const line of toolLines) {
      const command = line.words[0]!;
      if (command === "codegraph-metrics") continue;
      if (!extractors.has(command)) problems.push(`${line.at}: ${command} is not in the catalogue`);
      for (const word of line.words.slice(1)) {
        if (word.startsWith("--") && !contractFlags.has(word)) problems.push(`${line.at}: ${word} is not in the extractor contract`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives the metrics pass only flags its own source declares", () => {
    const source = readdirSync(join(REPO_ROOT, "extractors/metrics/src"))
      .filter((file) => file.endsWith(".rs"))
      .map((file) => readFileSync(join(REPO_ROOT, "extractors/metrics/src", file), "utf8"))
      .join("\n");
    const problems: string[] = [];
    const metrics = toolLines.filter((line) => line.words[0] === "codegraph-metrics");
    expect(metrics.length).toBeGreaterThan(0);
    for (const line of metrics) {
      for (const word of line.words.slice(1)) {
        if (word.startsWith("--") && !source.includes(`"${word}"`)) problems.push(`${line.at}: ${word}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("every file a skill names is in the plugin", () => {
  it("resolves each ${CLAUDE_PLUGIN_ROOT} path", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const path of MARKDOWN) {
      for (const match of readPlugin(path).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./<>-]+)/g)) {
        const target = match[1]!.replace(/[.,;:]+$/, "");
        if (target.includes("<")) continue; // a pattern (`skills/<skill>/SKILL.md`), checked by the routing test
        seen += 1;
        if (!existsSync(join(PLUGIN_ROOT, target))) missing.push(`${path}: ${target}`);
      }
    }
    expect(seen).toBeGreaterThan(8);
    expect(missing).toEqual([]);
  });

  it("resolves each reference a skill or a reference names by its file name", () => {
    const references = new Set(pluginFiles("references").map((path) => path.slice("references/".length)));
    const missing: string[] = [];
    for (const path of MARKDOWN) {
      for (const match of prose(readPlugin(path)).matchAll(/`([a-z][a-z0-9.-]*(?:\.md|\.schema\.json))`/g)) {
        const name = match[1]!;
        if (!references.has(name)) missing.push(`${path}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
