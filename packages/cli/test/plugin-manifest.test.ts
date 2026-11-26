import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, commandLines, pluginFiles, prose, readPlugin, readRepo, skills } from "./plugin-support.js";

/**
 * THE PLUGIN IS WELL-FORMED, AND STAYS SMALL (PLAN.md §24.1, §24.8).
 *
 * Three things here are constraints of the host, not preferences:
 *
 *  - after a long conversation is compacted, Claude Code keeps the first
 *    5 000 tokens of an invoked skill. A step whose instructions run past
 *    that is a step that forgets its own gate — so a `SKILL.md` has a budget
 *    in lines and in words, the proxy a test can hold without a tokenizer;
 *  - a skill's description is cut at 1 536 characters in the listing a model
 *    chooses from;
 *  - a top-level `bin/` makes a plugin uninstallable on claude.ai, and the
 *    plan keeps the plugin to text and SQL: no binary, no server, no hook.
 *
 * The rest is the plugin telling the truth about itself: its version is the
 * binary's, its guide routes only to steps it can name, its README lists the
 * skills that are there.
 */

const MAX_LINES = 300;
const MAX_WORDS = 2500;
const MAX_DESCRIPTION = 1536;

const manifest = JSON.parse(readPlugin(".claude-plugin/plugin.json")) as Record<string, unknown>;
const SKILLS = skills();

/** The steps the guide's table names that a later milestone ships. Shrinks; never grows. */
const PLANNED: Readonly<Record<string, string>> = {};

describe("plugin.json", () => {
  it("is named codegraph and carries the version of the binary it drives", () => {
    const root = JSON.parse(readRepo("package.json")) as { version: string };
    expect(manifest["name"]).toBe("codegraph");
    expect(manifest["version"]).toBe(root.version);
  });

  it("uses only fields the manifest reference documents", () => {
    const known = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];
    expect(Object.keys(manifest).filter((key) => !known.includes(key))).toEqual([]);
    expect(typeof manifest["description"]).toBe("string");
  });
});

describe("the plugin is text and SQL, nothing executable", () => {
  const files = pluginFiles();

  it("holds markdown, SQL and JSON, and nothing else", () => {
    expect(files.filter((path) => !/\.(md|sql|json)$/.test(path))).toEqual([]);
  });

  it("has no bin/, no hook, no server, no agent, no command", () => {
    for (const forbidden of ["bin", "hooks", "agents", "commands", ".mcp.json", ".lsp.json"]) {
      expect(existsSync(join(PLUGIN_ROOT, forbidden)), `plugin/${forbidden}`).toBe(false);
    }
  });

  it.runIf(process.platform !== "win32")("marks no file executable", () => {
    const executable = files.filter((path) => (statSync(join(PLUGIN_ROOT, path)).mode & 0o111) !== 0);
    expect(executable).toEqual([]);
  });

  it("is imported by nothing: the workspace does not list it as a package", () => {
    expect(readRepo("pnpm-workspace.yaml")).not.toMatch(/["' ]plugin["'\n/]/);
    expect(existsSync(join(PLUGIN_ROOT, "package.json"))).toBe(false);
  });
});

describe("every skill", () => {
  it("is found", () => {
    expect(SKILLS.map((skill) => skill.name)).toEqual([
      "discover",
      "discover-1-structure",
      "discover-2-boundaries",
      "discover-3-activity",
      "discover-4-stimuli",
      "discover-5-meaning",
      "discover-6-domain",
      "query",
    ]);
  });

  it.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s: is named after its directory and says when to use it", (_name, skill) => {
    expect(skill.frontmatter["name"]).toBe(skill.name);
    const description = `${skill.frontmatter["description"] ?? ""}${skill.frontmatter["when_to_use"] ?? ""}`;
    expect(description.length, "a description the listing would show whole").toBeGreaterThan(80);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(Object.keys(skill.frontmatter).filter((key) => !["name", "description", "when_to_use", "argument-hint"].includes(key))).toEqual([]);
  });

  it.each(SKILLS.map((skill) => [skill.name, skill] as const))(`%s: fits the budget — ${MAX_LINES} lines, ${MAX_WORDS} words`, (_name, skill) => {
    expect(skill.text.split("\n").length).toBeLessThanOrEqual(MAX_LINES);
    expect(skill.text.split(/\s+/).filter((word) => word !== "").length).toBeLessThanOrEqual(MAX_WORDS);
  });

  it.each(SKILLS.map((skill) => [skill.name, skill] as const))("%s: takes its argument, and substitutes nothing else by accident", (_name, skill) => {
    expect(skill.body).toContain("$ARGUMENTS");
    // `$0`, `$1`… are replaced by the host with the skill's arguments.
    expect(skill.body.match(/\$\d/g) ?? []).toEqual([]);
  });
});

describe("a step's skill", () => {
  const steps = SKILLS.filter((skill) => /^discover-\d-/.test(skill.name));
  const BEATS = ["Frame", "Run", "Show", "Read", "Ask", "Write", "Gate"];

  it.each(steps.map((skill) => [skill.name, skill] as const))("%s: states its question, its cost and its needs on its first screen", (_name, skill) => {
    const first = skill.body.split("\n").slice(0, 30).join("\n");
    for (const label of ["**The question.**", "**The method**", "**Cost.**", "**Needs.**"]) expect(first).toContain(label);
    expect(first).toMatch(/https:\/\/codegraph\.biz\/docs\/discover\/[a-z]+\//);
  });

  it.each(steps.map((skill) => [skill.name, skill] as const))("%s: plays the seven beats, in order, and can be entered on its own", (_name, skill) => {
    const headings = [...skill.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    expect(headings).toEqual(["Enter", ...BEATS]);
    expect(skill.body).toContain("discovery.json");
  });

  it("ships the six steps, in order", () => {
    expect(steps.map((skill) => skill.name)).toEqual([
      "discover-1-structure",
      "discover-2-boundaries",
      "discover-3-activity",
      "discover-4-stimuli",
      "discover-5-meaning",
      "discover-6-domain",
    ]);
  });

  it.each(steps.map((skill) => [skill.name, skill] as const))("%s: reads the rhythm and the evidence rules before it plays a beat", (_name, skill) => {
    const enter = skill.body.slice(skill.body.indexOf("\n## Enter\n"), skill.body.indexOf("\n## Frame\n"));
    expect(enter).toContain("${CLAUDE_PLUGIN_ROOT}/references/rhythm.md");
    expect(enter).toContain("${CLAUDE_PLUGIN_ROOT}/references/evidence.md");
  });

  it.each(steps.slice(1).map((skill) => [skill.name, skill] as const))("%s: builds the free thing it needs when entered alone — step 1's extraction, and only that", (_name, skill) => {
    const enter = prose(skill.body.slice(skill.body.indexOf("\n## Enter\n"), skill.body.indexOf("\n## Frame\n")));
    expect(enter).toMatch(/has no model/);
    expect(skill.body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md");
    expect(enter).toMatch(/\*\*Extract\*\* commands/);
  });

  it("the rhythm it follows names the same seven beats", () => {
    const rhythm = readPlugin("references/rhythm.md");
    const named = [...rhythm.matchAll(/^\d\. \*\*(\w+)\.\*\*/gm)].map((match) => match[1]!);
    expect(named).toEqual(BEATS);
  });
});

describe("the guide routes only to what it can name", () => {
  const guide = SKILLS.find((skill) => skill.name === "discover")!;
  const routed = [...new Set([...guide.body.matchAll(/`(discover-\d-[a-z]+)`/g)].map((match) => match[1]!))];

  it("names the six steps", () => {
    expect(routed.length).toBe(6);
    expect(routed.map((name) => name.split("-")[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("each is a skill of this plugin, or a step a later milestone ships", () => {
    const shipped = new Set(SKILLS.map((skill) => skill.name));
    expect(routed.filter((name) => !shipped.has(name) && !(name in PLANNED))).toEqual([]);
    expect(Object.keys(PLANNED).filter((name) => shipped.has(name)), "shipped: remove it from PLANNED").toEqual([]);
  });

  it("says what to do when a step's file is not there, instead of improvising it", () => {
    expect(prose(guide.body)).toMatch(/this version of the plugin does not carry the\s+step/);
    expect(guide.body).toContain("${CLAUDE_PLUGIN_ROOT}/skills/<skill>/SKILL.md");
  });

  /**
   * Found by the first live run: `CODEGRAPH_HOME` pointed at a build without
   * `query`, and the agent answered the step's queries with a Python script.
   * The guide now asks the binary for a command only this release has, and
   * every step is told that a failing command is reported, never replaced.
   */
  it("checks at preflight that the codegraph found has the commands the steps spell", () => {
    const probes = commandLines(guide.path, guide.text).filter((line) => line.words.join(" ") === "codegraph query --views");
    expect(probes.length).toBe(1);
    expect(prose(guide.body)).toMatch(/older than\s+this plugin/);
  });

  it("tells every step that a failing command is reported, not replaced", () => {
    expect(prose(guide.body)).toMatch(/reported, not replaced/);
    expect(readPlugin("references/rhythm.md")).toMatch(/never replaced: no other database client/);
  });

  it("the README lists exactly the skills that are there", () => {
    const listed = [...readPlugin("README.md").matchAll(/`\/codegraph:([a-z0-9-]+)/g)].map((match) => match[1]!);
    expect(listed.sort()).toEqual(SKILLS.map((skill) => skill.name).sort());
  });
});

describe("the tour and the report (PLAN.md §24.2, §24.7)", () => {
  const guide = SKILLS.find((skill) => skill.name === "discover")!;
  const rhythm = readPlugin("references/rhythm.md");
  const report = readPlugin("references/report.md");
  const section = (markdown: string, heading: string): string => {
    const start = markdown.indexOf(`\n## ${heading}\n`);
    if (start === -1) throw new Error(`no section "${heading}"`);
    const end = markdown.indexOf("\n## ", start + 4);
    return markdown.slice(start, end === -1 ? markdown.length : end);
  };

  it("the guide takes --tour, asks nothing in it, and marks what it chose as a guess", () => {
    expect(guide.frontmatter["argument-hint"]).toContain("--tour");
    const body = prose(guide.body);
    expect(body).toMatch(/With `--tour`, ask nothing/);
    expect(body).toContain('time: "tour"');
    expect(body).toContain("guessed: true");
  });

  it("the rhythm says how each beat is played in a tour", () => {
    const tour = prose(section(rhythm, "The tour"));
    for (const beat of ["Frame", "Run", "Show", "Ask", "Write", "Gate"]) expect(tour, beat).toContain(`**${beat}`);
    expect(tour).toMatch(/nothing is asked/);
    // Nobody is watching a tour: no page is left listening.
    expect(tour).toMatch(/No page is served/);
    expect(tour).toMatch(/what the tour could not do/);
    expect(tour).toContain("`capabilities.md`");
    // The tour is the three free steps and no other.
    expect(tour).toMatch(/steps 1 to 3/);
  });

  /**
   * Found by the first live run of step 4: the session ended at the gate with
   * the state saying four steps done and `REPORT.md` still saying three — "the
   * guide rewrites it at a stop, and this run only goes up to the gate". A gate
   * where the session ends IS a stop, and nothing tells the two apart in time.
   */
  it("a step rewrites the report when it writes the state, before its gate", () => {
    const write = prose(rhythm.slice(rhythm.indexOf("6. **Write.**"), rhythm.indexOf("7. **Gate.**")));
    expect(write).toMatch(/Then\s+rewrite `REPORT\.md` from the state/);
    expect(write).toMatch(/does not describe an older walk than the state does/);
    // A tour writes it once, when its three steps are done.
    expect(prose(section(rhythm, "The tour"))).toMatch(/the report once,\s+after step 3/);
  });

  it("every stop rewrites the report, from the state", () => {
    expect(prose(section(guide.body, "5. At any stop"))).toMatch(/Rewrite `\$WS\/REPORT\.md` from the state/);
    expect(guide.body).toContain("${CLAUDE_PLUGIN_ROOT}/references/report.md");
    expect(prose(section(rhythm, "Stopping is a success"))).toContain("`REPORT.md`");
    expect(prose(report)).toMatch(/rewritten\s+whole at every stop/);
    expect(prose(report)).toMatch(/Read `discovery\.json` again, then write/);
  });

  it("the report has its six sections, the questions and the blind spots among them", () => {
    const layout = /```markdown\n([\s\S]*?)```/.exec(report)?.[1] ?? "";
    expect([...layout.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      "In brief",
      "What was found",
      "The hotspot shortlist",
      "Questions for the team",
      "What was not looked at",
      "What was spent",
    ]);
    // Each is then described, by name.
    for (const name of ["In brief", "What was found", "The hotspot shortlist", "Questions for the team", "What was not looked at", "What was spent"]) {
      expect(report, name).toContain(`- **${name}`);
    }
  });

  it("orders the report by the purposes the state can hold, and by no other", () => {
    const schema = JSON.parse(readPlugin("references/discovery.schema.json")) as {
      properties: { intake: { properties: { purpose: { enum: string[] } } } };
    };
    const named = new Set([...section(report, "Its order follows the purpose").matchAll(/`([a-z-]+)`/g)].map((match) => match[1]!));
    named.delete("intake.purpose");
    expect([...named].sort()).toEqual(schema.properties.intake.properties.purpose.enum.filter((purpose) => purpose !== "other").sort());
  });

  /**
   * PLAN §24.9: an author's name in a deliverable. The joined report gives a
   * share and a date and no name (`history-joined.test.ts`); these hold the
   * text that tells the agent to keep it that way.
   */
  it("keeps a person's name out of every deliverable", () => {
    const never = prose(section(report, "What it never holds"));
    expect(never).toMatch(/A person's name or address/);
    expect(never).toContain("`reports/authors.json`");
    const activity = SKILLS.find((skill) => skill.name === "discover-3-activity")!;
    const write = prose(activity.body.slice(activity.body.indexOf("\n## Write\n"), activity.body.indexOf("\n## Gate\n")));
    expect(write).toMatch(/Names stay in `reports\/authors\.json`/);
    for (const file of ["`discovery.json`", "`NOTEBOOK.md`", "`REPORT.md`"]) expect(write).toContain(file);
    expect(prose(readPlugin("references/state.md"))).toMatch(/Never write a person's name/);
  });

  /**
   * Found by the first live tour: the agent assembled `discovery.json` with
   * `jq` and `mv`, and two of those writes failed before it recovered. `jq` is
   * on this machine and not on every one (PLAN §24, "measured before planning").
   */
  it("has the state written with the agent's file tool, not with a shell pipeline", () => {
    const state = prose(readPlugin("references/state.md"));
    expect(state).toMatch(/Write it with your own file tool, the whole file/);
    expect(state).toMatch(/Not with `jq`, `sed`/);
    // And no skill shows a command that would teach the opposite.
    for (const skill of SKILLS) {
      const offenders = commandLines(skill.path, skill.text).filter((line) => ["jq", "sed"].includes(line.words[0] ?? "") && line.words.join(" ").includes("discovery.json"));
      expect(offenders.map((line) => line.at)).toEqual([]);
    }
  });

  /**
   * Found by the second live tour: every saved report was read through a
   * `python3` snippet (the first tour's agent used `jq`). Nothing was computed
   * that way, but the walk needs only codegraph, and says so.
   */
  it("reads a saved result with the file tool or the command's own table, not with a script", () => {
    const run = prose(rhythm.slice(rhythm.indexOf("2. **Run.**"), rhythm.indexOf("3. **Show.**")));
    expect(run).toMatch(/To read a saved result, use your file-reading tool/);
    expect(run).toMatch(/without `--json` and with `--top 5` or `--limit 5`/);
    expect(run).toMatch(/no `python`, no `jq`/);
  });

  it("never states a price, and never advises", () => {
    const never = prose(section(report, "What it never holds"));
    expect(never).toMatch(/\*\*A price\.\*\*/);
    expect(never).toMatch(/\*\*A guess that looks like a fact\.\*\*/);
  });
});

describe("the query skill", () => {
  const skill = SKILLS.find((candidate) => candidate.name === "query")!;
  const body = prose(skill.body);

  it("reads the schema with statements, saves the query and its rows, and checks before it answers", () => {
    const commands = commandLines(skill.path, skill.text).map((line) => line.words.join(" "));
    expect(commands).toContain("codegraph query --views");
    expect(commands.some((command) => command.includes("sqlite_schema"))).toBe(true);
    expect(commands.some((command) => command.includes("pragma_table_info"))).toBe(true);
    expect(skill.text).toMatch(/--file "\$WS\/queries\/NN-name\.sql" --json > "\$WS\/queries\/NN-name\.json"/);
    expect(body).toMatch(/zero rows/i);
  });

  it("asks for a type by its trait and binds its values", () => {
    expect(skill.body).toContain("t.name = 'TType'");
    expect(body).toMatch(/Bind values, never splice them/);
    expect(body).toMatch(/Never reach for another database client/);
  });
});

describe("the host accepts it", () => {
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const available = claude.status === 0;

  it.runIf(available)("claude plugin validate --strict passes, and sees the same skills", () => {
    const result = spawnSync("claude", ["plugin", "validate", PLUGIN_ROOT, "--strict", "--json"], { encoding: "utf8", timeout: 60_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout) as { success: boolean; provides: { skills: string[]; bin: string[]; hooks: string[]; mcpServers: string[] } };
    expect(report.success).toBe(true);
    expect(report.provides.skills.sort()).toEqual(SKILLS.map((skill) => `codegraph:${skill.name}`).sort());
    expect([...report.provides.bin, ...report.provides.hooks, ...report.provides.mcpServers]).toEqual([]);
  }, 90_000);

  it("can be read by anyone who can read the repository", () => {
    for (const path of pluginFiles()) accessSync(join(PLUGIN_ROOT, path), constants.R_OK);
  });
});
