import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { collectStrings, entityIdsIn, parseJsonArtifact, valuesUnderKey } from "./artifact-grammar.js";
import { UNKNOWN_ID, createBrokenModels } from "./broken-models.js";
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
 * Measured facts about `fixtures/java/expected/model.json`, used as the shared
 * ground truth for both forms: 166 entities (26 stubs), 173 edges, 171 declared
 * / 2 derived; folded to 10 module nodes / 14 edges and 36 type nodes / 71.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

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

  it("names the same offending id in both forms", () => {
    const { text, json } = bothForms(["validate", models.danglingReference]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");
    const strings = collectStrings(parsed);

    expect(
      strings.has(UNKNOWN_ID),
      `--json did not report the dangling target ${UNKNOWN_ID}`,
    ).toBe(true);
    expect(text.stdout, "the text form did not report the dangling target").toContain(UNKNOWN_ID);
  });

  it("reports the same number of profile issues in both forms", () => {
    const { text, json } = bothForms(["validate", models.profileViolation]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");

    // Verified against `loadModels`: stripping a class down to TNamed produces
    // exactly 6 missing-required-trait issues.
    const issues = valuesUnderKey(parsed, /profileIssue|issues/i).filter(Array.isArray);
    const longest = issues.reduce<number>((best, list) => Math.max(best, list.length), 0);
    expect(longest, "the JSON form must carry the 6 profile issues").toBe(6);
    expect(text.stdout + text.stderr).toContain("missing-required-trait");
  });

  it("carries the entity and edge totals in both forms", () => {
    const { text, json } = bothForms(["validate", FIXTURE]);
    const parsed = parseJsonArtifact(json.stdout, "validate --json");
    const numbers = new Set(
      valuesUnderKey(parsed, /.*/).filter((value): value is number => typeof value === "number"),
    );
    expect(numbers, "the JSON form must state how many entities were validated").toContain(166);
    expect(numbers, "the JSON form must state how many edges were validated").toContain(173);
    expect(text.stdout).toContain("166");
    expect(text.stdout).toContain("173");
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
    const fromJson = entityIdsIn(json.stdout);
    const fromText = entityIdsIn(text.stdout);
    expect(fromJson.size, "the module level of the java fixture has 10 nodes").toBe(10);
    expect([...fromText].sort(), "the two forms must name the same modules").toEqual(
      [...fromJson].sort(),
    );
  });

  it("coupling at type level names the same 36 types in both forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "coupling", "--level", "type"]);
    const fromJson = entityIdsIn(json.stdout);
    expect(fromJson.size).toBe(36);
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...fromJson].sort());
  });

  it("deps names the same nodes in both forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "deps"]);
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...entityIdsIn(json.stdout)].sort());
  });

  it("--top limits the rows shown without changing what was computed", () => {
    const full = runCli(["analyze", FIXTURE, "--report", "coupling", "--json"]);
    const topped = runCli(["analyze", FIXTURE, "--report", "coupling", "--top", "3", "--json"]);
    expect(topped.code, describeResult(topped)).toBe(full.code);

    const fullIds = entityIdsIn(full.stdout);
    const toppedIds = entityIdsIn(topped.stdout);
    expect(toppedIds.size, "--top 3 must show 3 rows").toBe(3);
    for (const id of toppedIds) {
      expect(fullIds, `--top invented the row ${id}`).toContain(id);
    }
  });

  it("--top agrees between the text and JSON forms", () => {
    const { text, json } = bothForms(["analyze", FIXTURE, "--report", "coupling", "--top", "3"]);
    expect([...entityIdsIn(text.stdout)].sort()).toEqual([...entityIdsIn(json.stdout)].sort());
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
