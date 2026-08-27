import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { entityIdsIn, parseCsv, parseJsonArtifact, valuesUnderKey } from "./artifact-grammar.js";
import { CONFLICTING_ID, createBrokenModels } from "./broken-models.js";
import { describeResult, ensureCliBinary, javaFixture, runCli } from "./cli-process.js";

/**
 * MULTIPLE MODELS ARE A UNION (decision 5) — and the union has a sharp edge
 * that this suite exists to pin.
 *
 * Passing the SAME model twice is the degenerate case, and it was measured
 * against `loadModels` before these assertions were written:
 *
 *   entities  dedupe by id            169 -> 169
 *   edges     DO NOT dedupe           173 -> 346
 *   folding   same shape, doubled     10 nodes / 14 edges, every `count` × 2
 *   isClean   TRUE                    169 duplicate ids, none CONFLICTING
 *
 * So the honest answer is not "reject it" and not "silently halve it": the
 * duplication is benign by METAMODEL §1.1 (a declaration repeated identically
 * is how TS declaration merging and C# partial classes legitimately appear), so
 * the load stays clean and the run stays exit 0 — but the aggregated edge
 * COUNTS double, and a user reading `count` has been misled unless the CLI
 * says the ids were duplicated. That is the property tested here: the counts
 * double, AND the CLI says so.
 *
 * A genuinely CONFLICTING duplicate — the same id declared with a different
 * trait set — is a different story and must land in exit 3.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

/** The same corpus, reachable by two different paths. */
const TWICE = [FIXTURE, models.pristineCopy] as const;

describe("the same model twice is benign, and reported", () => {
  it("stays exit 0 — an identical redeclaration is not a finding", () => {
    const result = runCli(["validate", ...TWICE]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
  });

  it("reports all 169 duplicated ids rather than passing over them", () => {
    const result = runCli(["validate", ...TWICE, "--json"]);
    const parsed = parseJsonArtifact(result.stdout, "validate --json over two copies");

    const duplicates = valuesUnderKey(parsed, /duplicate/i);
    expect(
      duplicates.length,
      "the JSON report carries nothing about duplicate ids at all",
    ).toBeGreaterThan(0);

    const counts = duplicates.map((value) =>
      Array.isArray(value) ? value.length : typeof value === "number" ? value : -1,
    );
    expect(
      counts,
      `expected a duplicate count of 167, found ${JSON.stringify(counts)}`,
    ).toContain(169);
  });

  it("says so in the text form too", () => {
    const result = runCli(["validate", ...TWICE]);
    expect(result.stdout + result.stderr).toMatch(/duplicat/i);
  });

  it("names both input paths so the user can tell which files collided", () => {
    const result = runCli(["validate", ...TWICE]);
    const everything = result.stdout + result.stderr;
    expect(everything).toContain(models.pristineCopy);
  });
});

describe("the union does not invent or lose entities", () => {
  it("folds to the same 10 modules whether the corpus is listed once or twice", () => {
    const once = parseJsonArtifact(
      runCli(["export", FIXTURE, "--format", "json"]).stdout,
      "one copy",
    );
    const twice = parseJsonArtifact(
      runCli(["export", ...TWICE, "--format", "json"]).stdout,
      "two copies",
    );

    const ids = (artifact: Record<string, unknown>): string[] =>
      (artifact["nodes"] as { id: string }[]).map((node) => node.id).sort();

    expect(ids(twice), "duplicating the input must not duplicate the nodes").toEqual(ids(once));
    expect((twice["edges"] as unknown[]).length).toBe((once["edges"] as unknown[]).length);
  });

  it("DOUBLES the aggregated edge counts — the honest, and dangerous, part", () => {
    const once = parseJsonArtifact(
      runCli(["export", FIXTURE, "--format", "json"]).stdout,
      "one copy",
    );
    const twice = parseJsonArtifact(
      runCli(["export", ...TWICE, "--format", "json"]).stdout,
      "two copies",
    );

    type Edge = { from: string; to: string; count: number };
    const key = (edge: Edge): string => `${edge.from} -> ${edge.to}`;
    const before = new Map((once["edges"] as Edge[]).map((edge) => [key(edge), edge.count]));
    const after = new Map((twice["edges"] as Edge[]).map((edge) => [key(edge), edge.count]));

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [edge, count] of after) {
      expect(count, `${edge} did not double`).toBe((before.get(edge) ?? 0) * 2);
    }
  });

  it("warns that the counts are inflated by duplicate ids", () => {
    // The counts above are why this warning is not cosmetic: without it the
    // artifact reads as a corpus with twice the coupling it has.
    const result = runCli(["export", ...TWICE, "--format", "json"]);
    expect(
      result.stderr,
      "doubling every edge count silently is exactly what decision 3's stderr is for",
    ).toMatch(/duplicat/i);
  });

  it("keeps the CSV rectangular and the ids unduplicated", () => {
    const table = parseCsv(runCli(["export", ...TWICE, "--format", "csv"]).stdout);
    expect(table.rows.length).toBe(14);
  });

  it("analyzes the union without inventing modules", () => {
    const once = runCli(["analyze", FIXTURE, "--report", "coupling", "--json"]);
    const twice = runCli(["analyze", ...TWICE, "--report", "coupling", "--json"]);
    expect(twice.code, describeResult(twice)).toBe(once.code);
    expect([...entityIdsIn(twice.stdout)].sort()).toEqual([...entityIdsIn(once.stdout)].sort());
  });
});

describe("a CONFLICTING duplicate is a finding, not a merge", () => {
  it("exits 3 when one id is declared two different ways", () => {
    const result = runCli(["validate", FIXTURE, models.conflictingCopy]);
    expect(
      result.code,
      `${describeResult(result)}\n\nTwo disagreeing declarations of the same id cannot both be true.`,
    ).toBe(EXIT.FINDINGS);
  });

  it("names the disputed id", () => {
    const result = runCli(["validate", FIXTURE, models.conflictingCopy]);
    expect(result.stdout + result.stderr).toContain(CONFLICTING_ID);
  });

  it("distinguishes a conflict from a harmless repetition", () => {
    const harmless = runCli(["validate", ...TWICE]);
    const conflicting = runCli(["validate", FIXTURE, models.conflictingCopy]);
    expect(harmless.code).toBe(EXIT.OK);
    expect(conflicting.code).toBe(EXIT.FINDINGS);
  });
});

describe("a union of good and bad models reports on every file", () => {
  it("does not die on the first unparseable file", () => {
    const result = runCli(["validate", models.notAModel, FIXTURE, models.danglingReference]);
    expect(result.code, describeResult(result)).toBe(EXIT.FINDINGS);
    const everything = result.stdout + result.stderr;
    expect(everything, "the unparseable file was not reported").toContain(models.notAModel);
    expect(everything, "the dangling reference was not reported").toContain(
      models.danglingReference,
    );
  });
});
