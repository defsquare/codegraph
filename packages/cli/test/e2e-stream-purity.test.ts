import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { parseCsv, parseJsonArtifact, parsePureDot } from "./artifact-grammar.js";
import { createBrokenModels, scratchPath } from "./broken-models.js";
import { describeResult, ensureCliBinary, expectNoAnsi, javaFixture, runCli } from "./cli-process.js";

/**
 * STREAM PURITY (decisions 3 and 4): stdout is the artifact, stderr is the
 * human, and neither carries a byte of the other.
 *
 * The artifacts are checked with real grammars (see `artifact-grammar.ts`),
 * because `toContain("digraph")` would pass on a stream with a progress line
 * glued to the front — the exact corruption this property forbids. Those
 * grammars are themselves tested in `artifact-grammar.test.ts`; an untested
 * oracle proves nothing.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

describe("export puts ONLY the artifact on stdout", () => {
  it("--format dot yields a DOT document and nothing else", () => {
    const result = runCli(["export", FIXTURE, "--format", "dot"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    const dot = parsePureDot(result.stdout);
    expect(dot.directed).toBe(true);
    // Measured on the java fixture: 10 module nodes, 14 module edges. The legend
    // adds its own nodes and two edges inside a cluster, so the corpus edges are
    // asserted as a lower bound on the total.
    expect(dot.edges.length).toBeGreaterThanOrEqual(14);
    expect(dot.subgraphs.length).toBe(1);
  });

  it("--format csv yields a rectangular CSV table and nothing else", () => {
    const result = runCli(["export", FIXTURE, "--format", "csv"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    const table = parseCsv(result.stdout);
    expect(table.header).toEqual([
      "from",
      "to",
      "count",
      "kinds",
      "provenances",
      "selfLoop",
      "level",
      "view",
    ]);
    expect(table.rows.length).toBe(14);
    for (const row of table.rows) expect(table.column(row, "level")).toBe("module");
  });

  it("--format json yields one parseable analysis artefact and nothing else", () => {
    const result = runCli(["export", FIXTURE, "--format", "json"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    const json = parseJsonArtifact(result.stdout, "export --format json stdout");
    expect(json["kind"]).toBe("codegraph.foldedGraph/1");
    expect(json["level"]).toBe("module");
    expect((json["nodes"] as unknown[]).length).toBe(10);
    expect((json["edges"] as unknown[]).length).toBe(14);
  });

  it("keeps stdout pure at type level too", () => {
    const dot = runCli(["export", FIXTURE, "--format", "dot", "--level", "type"]);
    expect(dot.code, describeResult(dot)).toBe(EXIT.OK);
    expect(parsePureDot(dot.stdout).bareWords).toEqual([]);

    const json = runCli(["export", FIXTURE, "--format", "json", "--level", "type"]);
    const parsed = parseJsonArtifact(json.stdout, "type-level json");
    expect((parsed["nodes"] as unknown[]).length).toBe(36);
    expect((parsed["edges"] as unknown[]).length).toBe(71);
  });
});

describe("the human stream carries the warnings, and stdout stays an artifact", () => {
  /**
   * Folding the java fixture to module level drops 5 base edges as unplaceable
   * (10 at type level). A silently smaller graph is how a wrong number gets
   * trusted, so the drop must be SAID — on stderr, where it cannot corrupt the
   * file the user is redirecting.
   */
  it("reports the edges folding dropped, on stderr", () => {
    const result = runCli(["export", FIXTURE, "--format", "dot"]);
    expect(result.stderr, describeResult(result)).toMatch(/drop/i);
    expect(result.stderr, "the number of dropped edges is the point of the warning").toMatch(/\b5\b/);
    parsePureDot(result.stdout);
  });

  it("still emits a clean artifact when the model has findings", () => {
    const result = runCli(["export", models.danglingReference, "--format", "dot"]);
    expect(result.code, describeResult(result)).toBe(EXIT.FINDINGS);
    // A bad model is exactly when a picture helps: the artifact is still written,
    // and the diagnosis goes to the other stream.
    expect(() => parsePureDot(result.stdout)).not.toThrow();
    expect(result.stderr.trim()).not.toBe("");
  });

  it("puts nothing on stdout when --out redirects the artifact to a file", () => {
    const out = scratchPath(models, "explicit-out.dot");
    const result = runCli(["export", FIXTURE, "--format", "dot", "--out", out]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(result.stdout, "--out must not also print the artifact").toBe("");
    expect(() => parsePureDot(readFileSync(out, "utf8"))).not.toThrow();
  });

  it("treats an unwritable --out as a usage error, not a crash", () => {
    const result = runCli([
      "export",
      FIXTURE,
      "--format",
      "dot",
      "--out",
      "/no/such/directory/graph.dot",
    ]);
    expect(result.code, describeResult(result)).toBe(EXIT.USAGE);
    expect(result.stdout).toBe("");
  });
});

describe("no ANSI colour anywhere (decision 4)", () => {
  const invocations: readonly (readonly string[])[] = [
    ["--help"],
    ["--version"],
    ["profiles"],
    ["validate", FIXTURE],
    ["validate", models.profileViolation],
    ["analyze", FIXTURE, "--report", "coupling"],
    ["export", FIXTURE, "--format", "dot"],
    ["export", FIXTURE, "--format", "plantuml"],
    ["frobnicate"],
  ];

  it.each(invocations)("codegraph %s … emits no escape codes", (...argv) => {
    const result = runCli(argv);
    expectNoAnsi(result.stdout, "stdout");
    expectNoAnsi(result.stderr, "stderr");
  });

  it("stays colourless even when the environment demands colour", () => {
    for (const argv of invocations) {
      const result = runCli(argv, { env: { FORCE_COLOR: "3", TERM: "xterm-256color" } });
      expectNoAnsi(result.stdout, `stdout of ${argv.join(" ")} under FORCE_COLOR`);
      expectNoAnsi(result.stderr, `stderr of ${argv.join(" ")} under FORCE_COLOR`);
    }
  }, 60_000);
});

describe("reporting commands keep their framing off stdout", () => {
  it("analyze --json puts exactly one JSON object on stdout", () => {
    const result = runCli(["analyze", FIXTURE, "--report", "coupling", "--json"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(() => parseJsonArtifact(result.stdout, "analyze --json stdout")).not.toThrow();
  });

  it("validate --json puts exactly one JSON object on stdout", () => {
    const result = runCli(["validate", FIXTURE, "--json"]);
    expect(() => parseJsonArtifact(result.stdout, "validate --json stdout")).not.toThrow();
  });

  it("profiles --json puts exactly one JSON object on stdout", () => {
    const result = runCli(["profiles", "--json"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(() => parseJsonArtifact(result.stdout, "profiles --json stdout")).not.toThrow();
  });
});
