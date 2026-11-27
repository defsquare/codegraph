import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getProfile } from "@codegraph/core";
import { FRAMEWORK_PROFILES, STORE_OPEN_OPTIONS, createHelperViews, importModel, loadSqlite, queryStore } from "@codegraph/analyzer";
import { REPO_ROOT, pluginFiles, queryFiles, readDoc, readPlugin } from "./plugin-support.js";

/**
 * THE STACK TABLES ARE DATA, AND SAY ONLY WHAT THE PAGE CAN FILE (PLAN.md §24.2).
 *
 * Step 4 finds entry points from `plugin/references/stacks/<name>.json`: names
 * of annotations, of supertypes, of types and of operations, each with a kind
 * of stimulus. Nothing compiles a table. What can drift silently:
 *
 *  - a kind the page does not list, which no reader could file;
 *  - the `conventional` names, which are core's (a language profile's
 *    lexicon), copied here because SQL cannot read a profile;
 *  - the Spring table losing a name the framework profile calls an entry
 *    point — the inventory is promised to hold every entry point of
 *    `analyze --report wiring`;
 *  - the page, the reference and the directory naming different tables.
 *
 * What a table FINDS was checked on real codebases, once, by hand
 * (`references/stacks.md`); a test cannot hold that, and does not pretend to.
 */

interface Stack {
  stack: string;
  lang: string;
  annotations: Record<string, string>;
  supertypes: Record<string, string>;
  types: Record<string, string>;
  operations: Record<string, string>;
  conventional: string[];
  entries: Record<string, string>;
}

const FILES = pluginFiles("references/stacks");
const STACKS = FILES.map((path) => ({ path, name: path.slice("references/stacks/".length, -".json".length), table: JSON.parse(readPlugin(path)) as Stack }));
const PAGE = readDoc("discover/stimuli.md");
const NOTES = readPlugin("references/stacks.md");

/** The first column of the page's table of stimuli: the only words a table may use. */
const KINDS = [...PAGE.slice(PAGE.indexOf("| Stimulus | What it is"), PAGE.indexOf("Five tables ship")).matchAll(/^\| `([a-z ]+)` \|/gm)].map((match) => match[1]!);

const FIXTURE: Readonly<Record<string, string>> = { java: "java", csharp: "csharp", ts: "typescript", ex: "elixir", rb: "ruby" };

describe("the stack tables", () => {
  it("are one per checked framework, one per extractor language", () => {
    expect(STACKS.map((entry) => entry.name)).toEqual(["aspnet", "nestjs", "phoenix", "rails", "spring"]);
    expect(STACKS.map((entry) => entry.table.lang).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it("the page names eight kinds of stimulus", () => {
    expect(KINDS).toEqual(["inbound command", "inbound query", "inbound request", "external event", "internal event", "temporal", "lifecycle", "framework callback"]);
  });

  it.each(STACKS.map((entry) => [entry.name, entry] as const))("%s: has the six maps and nothing else, named after its file", (_name, entry) => {
    expect(Object.keys(entry.table)).toEqual(["stack", "lang", "annotations", "supertypes", "types", "operations", "conventional", "entries"]);
    expect(entry.table.stack).toBe(entry.name);
    // What a person says goes in the workspace's copy, never in the plugin's.
    expect(entry.table.entries).toEqual({});
  });

  it.each(STACKS.map((entry) => [entry.name, entry] as const))("%s: files every name under a kind the page lists", (_name, entry) => {
    const maps = [entry.table.annotations, entry.table.supertypes, entry.table.types, entry.table.operations];
    const words = maps.flatMap((map) => Object.values(map));
    expect(words.length).toBeGreaterThan(5);
    expect(words.filter((word) => !KINDS.includes(word))).toEqual([]);
    // One name, one line: a name twice in a map would be JSON's last-wins.
    for (const map of maps) expect(Object.keys(map)).toEqual([...new Set(Object.keys(map))].sort());
  });

  it.each(STACKS.map((entry) => [entry.name, entry] as const))("%s: carries its language's conventional names, as core has them", (_name, entry) => {
    const lexicon = getProfile(entry.table.lang)?.lexicon;
    expect(lexicon, `no lexicon for ${entry.table.lang}`).toBeDefined();
    expect(entry.table.conventional.length).toBeGreaterThan(5);
    expect(entry.table.conventional).toEqual(lexicon?.conventional);
  });

  it("spring: names every annotation the framework profile calls an entry point", () => {
    const spring = STACKS.find((entry) => entry.name === "spring")!.table;
    const entryPoints = FRAMEWORK_PROFILES["spring"]!.annotations.filter((spec) => spec.role === "entry-point").map((spec) => spec.name);
    expect(entryPoints.length).toBeGreaterThan(8);
    expect(entryPoints.filter((name) => !(name in spring.annotations))).toEqual([]);
  });

  it("a pattern of `types` is a GLOB: it has a star, and no SQL wildcard that would not be one", () => {
    for (const entry of STACKS) for (const pattern of Object.keys(entry.table.types)) expect(pattern, entry.name).toMatch(/^[^%_]*\*[^%_]*$/);
  });
});

describe("the tables run", () => {
  const scratch = mkdtempSync(join(tmpdir(), "codegraph-plugin-stacks-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const inventory = queryFiles().find((file) => file.name === "entry-points")!;

  it.each(STACKS.map((entry) => [entry.name, entry] as const))("%s: the inventory accepts it on its language's fixture, and names the layer of every row", (_name, entry) => {
    const store = join(scratch, `${entry.name}.db`);
    importModel(join(REPO_ROOT, "fixtures", FIXTURE[entry.table.lang]!, "expected", "model.jsonl"), store);
    const db = loadSqlite().open(store, { ...STORE_OPEN_OPTIONS, readOnly: true });
    try {
      createHelperViews(db);
      const result = queryStore(db, inventory.statement, { params: { stack: readPlugin(entry.path) } });
      expect(result.total).toBeGreaterThan(0);
      expect(new Set(result.rows.map((row) => row[2]))).toContain("no caller");
      for (const row of result.rows) expect(row[4] === null || KINDS.includes(String(row[4]))).toBe(true);
      // No name the language itself calls is left among the rows no table names.
      const unnamed = result.rows.filter((row) => row[2] === "no caller" && row[4] === null).map((row) => String(row[0]));
      for (const name of entry.table.conventional.filter((candidate) => /^\w+$/.test(candidate))) {
        expect(unnamed.filter((id) => new RegExp(`[./]${name}(\\(|#|$)`).test(id)), `${entry.name}: ${name}`).toEqual([]);
      }
    } finally {
      db.close();
    }
  });
});

describe("the page, the reference and the directory name the same tables", () => {
  it("the page's table of tables is the directory", () => {
    const listed = [...PAGE.slice(PAGE.indexOf("Five tables ship"), PAGE.indexOf("### The inventory")).matchAll(/^\| `([a-z]+)\.json` \|/gm)].map((match) => match[1]!);
    expect(listed.sort()).toEqual(STACKS.map((entry) => entry.name));
  });

  it("the reference lists them, with the corpus each was checked on, and what is not covered", () => {
    const listed = [...NOTES.matchAll(/^\| `([a-z]+)\.json` \|/gm)].map((match) => match[1]!);
    expect(listed.sort()).toEqual(STACKS.map((entry) => entry.name));
    // The same commits on the page and in the reference: one check, told twice.
    for (const commit of ["500158f", "ab10e4c", "045b6d1", "94df49d", "418da46", "v4.3.0"]) {
      expect(PAGE, commit).toContain(commit);
      expect(NOTES, commit).toContain(commit);
    }
    expect(NOTES).toMatch(/## A framework with no table: not covered/);
    expect(PAGE).toMatch(/is \*\*not covered\*\*/);
  });

  it("the reference explains every map a table has, and the page too", () => {
    for (const map of ["annotations", "supertypes", "types", "operations", "entries", "conventional"]) {
      expect(NOTES, map).toContain(`| \`${map}\` |`);
      expect(PAGE, map).toContain(`| \`${map}\` |`);
    }
  });
});
