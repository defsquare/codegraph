import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { collectStrings, entityIdsIn, parseJsonArtifact, valuesUnderKey } from "./artifact-grammar.js";
import { SELF_EDGE_ID, createBrokenModels } from "./broken-models.js";
import { describeResult, ensureCliBinary, javaFixture, runCli } from "./cli-process.js";

/**
 * `--json` PARITY (decision 8): a flag changes how a fact is printed, never
 * whether it is true.
 *
 * Parity is asserted on FACTS both forms must carry — the exit code, the set of
 * entity ids, the counts — rather than on key names, because the key names are
 * the implementer's to choose and pinning them here would freeze a schema this
 * suite has no business owning. Where a fact has to be located inside the JSON,
 * `valuesUnderKey` finds it by what the key MEANS (`/duplicate/i`), not by
 * spelling.
 *
 * Measured facts about `fixtures/java/expected/model.jsonl`, used as the shared
 * ground truth for both forms: 166 entities (26 stubs), 173 edges, 171 declared
 * / 2 derived; folded to 10 module nodes / 14 edges and 36 type nodes / 71.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

/**
 * The ids a report PRESENTS as its answer — coupling/deps rows and nodes.
 *
 * Deliberately NOT every id-shaped string in the document: `foldDiagnostics`
 * also names the entities folding could not place (2 at module level, 10 at
 * type). That diagnostic is required honesty — a silently smaller graph is how
 * a wrong number gets trusted — but it is not part of the answer, and the text
 * form correctly keeps it on stderr. Scraping the whole document conflates the
 * report with the caveat, so parity is asserted on the answer itself.
 */
function reportNodeIds(parsed: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const key of ["rows", "nodes"]) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (typeof row !== "object" || row === null) continue;
      const id = (row as Record<string, unknown>)["id"];
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

function bothForms(argv: readonly string[]): { text: ReturnType<typeof runCli>; json: ReturnType<typeof runCli> } {
  return { text: runCli(argv), json: runCli([...argv, "--json"]) };
}

describe("validate says the same thing in both forms", () => {
  it("agrees on the verdict for a clean model", () => {
    const { text, json } = bothForms(["validate", FIXTURE]);
    expect(text.code, describeResult(text)).toBe(EXIT.OK);
    expect(json.code, describeResult(json)).toBe(EXIT.OK);
    expect(() => parseJsonArtifact(json.stdout, "validate --json")).not.toThrow();
  });

  it("agrees on the verdict for a broken model", () => {
    const { text, json } = bothForms(["validate", models.profileViolation]);
    expect(text.code).toBe(EXIT.FINDINGS);
    expect(json.code, "--json must not change the exit code").toBe(text.code);
  });

  /**
   * A self-edge, not a dangling reference: since M6 a reference is a surrogate,
   * so "points at nothing" is a malformed FILE rather than a finding about a
   * valid one, and there is no offending id left to name. A self-edge is still
   * writable and still a finding, which is what this parity check needs.
   */
  it("names the same offending id in both forms", () => {
    const { text, json } = bothForms(["validate", models.selfEdge]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");
    const strings = collectStrings(parsed);

    expect(strings.has(SELF_EDGE_ID), `--json did not report ${SELF_EDGE_ID}`).toBe(true);
    expect(text.stdout, "the text form did not report the self-edge").toContain(SELF_EDGE_ID);
  });

  it("reports the same number of profile issues in both forms", () => {
    const { text, json } = bothForms(["validate", models.profileViolation]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");

    // Verified against `loadModels`: stripping a class down to TNamed produces
    // exactly 6 missing-required-trait issues.
    // The KEY holding them is the implementer's to name: the merged shape
    // reports them as `findings[]` entries under the `profile` rule (plus a
    // rolled-up `counts.byRule.profile`), not under a `profileIssues` key.
    // Locate them by what they SAY, per this file's spelling-agnostic rule.
    const findings = valuesUnderKey(parsed, /finding|issue/i)
      .filter(Array.isArray)
      .flat()
      .filter((finding) => JSON.stringify(finding).includes("missing-required-trait"));
    expect(findings.length, "the JSON form must carry the 6 profile issues").toBe(6);
    expect(text.stdout + text.stderr).toContain("missing-required-trait");
  });

  it("carries the entity and edge totals in both forms", () => {
    const { text, json } = bothForms(["validate", FIXTURE]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");
    const numbers = new Set(
      valuesUnderKey(parsed, /.*/).filter((value): value is number => typeof value === "number"),
    );
    expect(numbers, "the JSON form must state how many entities were validated").toContain(179);
    expect(numbers, "the JSON form must state how many edges were validated").toContain(188);
    expect(text.stdout).toContain("179");
    expect(text.stdout).toContain("188");
  });
});

describe("analyze says the same thing in both forms", () => {
  const reports = ["deps", "cycles", "coupling"] as const;

  it.each(reports)("%s agrees on the exit code", (report) => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", report]);
    expect(json.code, `${report}: --json changed the exit code`).toBe(text.code);
  });

  it.each(reports)("%s produces parseable JSON stating its level and view", (report) => {
    const result = runCli(["analyze", FIXTURE, "--report", report, "--json"]);
    const parsed = parseJsonArtifact(result.stdout, `analyze --report ${report} --json`);
    // A coupling number without its view is not a fact, so both must be stated.
    expect(parsed["level"], `${report} did not state its level`).toBe("module");
    expect(String(JSON.stringify(parsed["view"])), `${report} did not state its view`).not.toBe(
      "undefined",
    );
  });

  it("coupling names the same 10 modules in both forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "coupling"]);
    const fromJson = reportNodeIds(parseJsonArtifact(json.stdout, "analyze --report coupling --json"));
    const fromText = entityIdsIn(text.stdout);
    expect(fromJson.size, "the module level of the java fixture has 10 nodes").toBe(10);
    expect([...fromText].sort(), "the two forms must name the same modules").toEqual(
      [...fromJson].sort(),
    );
  });

  it("coupling at type level names the same 39 types in both forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "coupling", "--level", "type"]);
    const fromJson = reportNodeIds(parseJsonArtifact(json.stdout, "analyze coupling type --json"));
    expect(fromJson.size).toBe(39);
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...fromJson].sort());
  });

  it("deps names the same nodes in both forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "deps"]);
    const fromJson = reportNodeIds(parseJsonArtifact(json.stdout, "analyze --report deps --json"));
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...fromJson].sort());
  });

  it("--top limits the rows shown without changing what was computed", () => {
    const full = runCli(["analyze", FIXTURE, "--report", "coupling", "--json"]);
    const topped = runCli(["analyze", FIXTURE, "--report", "coupling", "--top", "3", "--json"]);
    expect(topped.code, describeResult(topped)).toBe(full.code);

    const fullIds = reportNodeIds(parseJsonArtifact(full.stdout, "coupling --json"));
    const toppedIds = reportNodeIds(parseJsonArtifact(topped.stdout, "coupling --top 3 --json"));
    expect(toppedIds.size, "--top 3 must show 3 rows").toBe(3);
    for (const id of toppedIds) {
      expect(fullIds, `--top invented the row ${id}`).toContain(id);
    }
  });

  it("--top agrees between the text and JSON forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "coupling", "--top", "3"]);
    const fromJson = reportNodeIds(parseJsonArtifact(json.stdout, "coupling --top 3 --json"));
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...fromJson].sort());
  });

  it("a view flag changes the answer in both forms identically", () => {
    const all = runCli(["analyze", FIXTURE, "--report", "coupling", "--json"]);
    const internal = runCli(["analyze", FIXTURE, "--report", "coupling", "--internal-only", "--json"]);
    const allIds = entityIdsIn(all.stdout);
    const internalIds = entityIdsIn(internal.stdout);
    // 26 of the fixture's 166 entities are stubs, so the internal-only view must
    // be a strict subset — never larger, never unrelated.
    expect(internalIds.size).toBeLessThanOrEqual(allIds.size);
    for (const id of internalIds) expect(allIds).toContain(id);

    const internalText = runCli(["analyze", FIXTURE, "--report", "coupling", "--internal-only"]);
    expect([...entityIdsIn(internalText.stdout)].sort()).toEqual([...internalIds].sort());
  });
});

describe("profiles says the same thing in both forms", () => {
  it("lists the same languages either way", () => {
    const { text, json } = bothForms(["profiles"]);
    expect(text.code, describeResult(text)).toBe(EXIT.OK);
    const parsed = parseJsonArtifact(json.stdout, "profiles --json");
    const langs = collectStrings(parsed);
    expect(langs, "java must be among the shipped profiles").toContain("java");
    expect(text.stdout).toContain("java");
  });

  it("prints java's traits in both forms", () => {
    const { text, json } = bothForms(["profiles", "--lang", "java"]);
    const parsed = parseJsonArtifact(json.stdout, "profiles --lang java --json");
    const values = collectStrings(parsed);
    expect(values).toContain("TNamed");
    expect(text.stdout).toContain("TNamed");
    expect(text.stdout).toContain("package");
  });
});
