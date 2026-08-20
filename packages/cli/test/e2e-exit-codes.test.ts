import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { createBrokenModels } from "./broken-models.js";
import { describeArgv, describeResult, ensureCliBinary, javaFixture, runCli } from "./cli-process.js";

/**
 * EXIT CODE DISCIPLINE, end to end (decision 2).
 *
 * This is the contract CI depends on and the one no in-process test can prove:
 * only a child process shows what the shell actually sees after `index.ts`
 * assigns `process.exitCode` and Node drains its streams.
 *
 *   0 the command did its job          2 the INVOCATION was wrong
 *   1 codegraph itself broke           3 the MODEL was wrong
 *
 * The load-bearing assertion in this file is that 1 never happens. A suite that
 * only checks `code !== 0` treats a crash and a bad model as the same event,
 * which is the precise confusion these four numbers exist to prevent — and a
 * crash is the failure most likely to hide behind such an assertion, because it
 * is non-zero too.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

/** Every invocation below is legitimate: none of them may ever produce a 1. */
interface Case {
  readonly why: string;
  readonly argv: readonly string[];
  readonly expected: number;
}

const SUCCESS_CASES: readonly Case[] = [
  { why: "global help", argv: ["--help"], expected: EXIT.OK },
  { why: "short help", argv: ["-h"], expected: EXIT.OK },
  { why: "version", argv: ["--version"], expected: EXIT.OK },
  { why: "profiles", argv: ["profiles"], expected: EXIT.OK },
  { why: "profiles as json", argv: ["profiles", "--json"], expected: EXIT.OK },
  { why: "one profile", argv: ["profiles", "--lang", "java"], expected: EXIT.OK },
  { why: "validate the clean fixture", argv: ["validate", FIXTURE], expected: EXIT.OK },
  { why: "validate as json", argv: ["validate", FIXTURE, "--json"], expected: EXIT.OK },
  { why: "deps report", argv: ["analyze", FIXTURE, "--report", "deps"], expected: EXIT.OK },
  {
    why: "coupling report",
    argv: ["analyze", FIXTURE, "--report", "coupling"],
    expected: EXIT.OK,
  },
  {
    why: "coupling at type level, internal only",
    argv: ["analyze", FIXTURE, "--report", "coupling", "--level", "type", "--internal-only"],
    expected: EXIT.OK,
  },
  {
    why: "coupling, top 5, as json",
    argv: ["analyze", FIXTURE, "--report", "coupling", "--top", "5", "--json"],
    expected: EXIT.OK,
  },
  { why: "export dot", argv: ["export", FIXTURE, "--format", "dot"], expected: EXIT.OK },
  { why: "export json", argv: ["export", FIXTURE, "--format", "json"], expected: EXIT.OK },
  { why: "export csv", argv: ["export", FIXTURE, "--format", "csv"], expected: EXIT.OK },
  { why: "export plantuml", argv: ["export", FIXTURE, "--format", "plantuml"], expected: EXIT.OK },
  {
    why: "export at type level, declared only",
    argv: ["export", FIXTURE, "--format", "csv", "--level", "type", "--declared-only"],
    expected: EXIT.OK,
  },
];

const USAGE_CASES: readonly Case[] = [
  { why: "no command at all", argv: [], expected: EXIT.USAGE },
  { why: "unknown command", argv: ["frobnicate"], expected: EXIT.USAGE },
  { why: "unknown global flag", argv: ["--frobnicate"], expected: EXIT.USAGE },
  { why: "missing the model path", argv: ["validate"], expected: EXIT.USAGE },
  { why: "unknown flag on validate", argv: ["validate", FIXTURE, "--nope"], expected: EXIT.USAGE },
  { why: "analyze without --report", argv: ["analyze", FIXTURE], expected: EXIT.USAGE },
  {
    why: "unknown --report value",
    argv: ["analyze", FIXTURE, "--report", "entropy"],
    expected: EXIT.USAGE,
  },
  {
    why: "unknown --level value",
    argv: ["analyze", FIXTURE, "--report", "deps", "--level", "galaxy"],
    expected: EXIT.USAGE,
  },
  {
    why: "--top below 1",
    argv: ["analyze", FIXTURE, "--report", "coupling", "--top", "0"],
    expected: EXIT.USAGE,
  },
  {
    why: "--top that is not a number",
    argv: ["analyze", FIXTURE, "--report", "coupling", "--top", "many"],
    expected: EXIT.USAGE,
  },
  { why: "export without --format", argv: ["export", FIXTURE], expected: EXIT.USAGE },
  {
    why: "unknown --format value",
    argv: ["export", FIXTURE, "--format", "svg"],
    expected: EXIT.USAGE,
  },
  {
    why: "a model path that does not exist",
    argv: ["validate", "/no/such/directory/model.json"],
    expected: EXIT.USAGE,
  },
  {
    why: "one readable and one missing path",
    argv: ["validate", FIXTURE, "/no/such/directory/model.json"],
    expected: EXIT.USAGE,
  },
  { why: "a positional profiles does not take", argv: ["profiles", FIXTURE], expected: EXIT.USAGE },
  { why: "an unknown language", argv: ["profiles", "--lang", "klingon"], expected: EXIT.USAGE },
];

const FINDING_CASES: readonly Case[] = [
  { why: "a file that is not JSON", argv: ["validate", models.malformedJson], expected: EXIT.FINDINGS },
  { why: "JSON that is not a model", argv: ["validate", models.notAModel], expected: EXIT.FINDINGS },
  {
    why: "an edge pointing at an unknown id",
    argv: ["validate", models.danglingReference],
    expected: EXIT.FINDINGS,
  },
  { why: "an edge from an id to itself", argv: ["validate", models.selfEdge], expected: EXIT.FINDINGS },
  {
    why: "an entity missing its profile's required traits",
    argv: ["validate", models.profileViolation],
    expected: EXIT.FINDINGS,
  },
  {
    why: "one good model and one broken one",
    argv: ["validate", FIXTURE, models.notAModel],
    expected: EXIT.FINDINGS,
  },
  {
    why: "analyzing a model with a dangling reference",
    argv: ["analyze", models.danglingReference, "--report", "deps"],
    expected: EXIT.FINDINGS,
  },
  {
    why: "exporting a model with a dangling reference",
    argv: ["export", models.danglingReference, "--format", "dot"],
    expected: EXIT.FINDINGS,
  },
];

/**
 * Invocations whose CODE is deliberately not pinned here.
 *
 * `analyze --report cycles` on the java fixture finds 0 strongly-connected
 * components but 3 folding-induced self-loops at module level, and 2 components
 * with 11 self-loops at type level. Whether a cycle report counts as a FINDING
 * (exit 3) even when the load was clean — and whether a self-loop induced by
 * folding counts as a cycle at all — is a product decision the seam doc raises
 * and nobody has settled. Pinning a number here would settle it by accident.
 *
 * What is NOT in doubt is that neither answer is 1: the tool did its job.
 */
const UNSETTLED_CASES: readonly (readonly string[])[] = [
  ["analyze", FIXTURE, "--report", "cycles"],
  ["analyze", FIXTURE, "--report", "cycles", "--level", "type"],
  ["analyze", FIXTURE, "--report", "cycles", "--level", "type", "--json"],
  ["analyze", FIXTURE, "--report", "cycles", "--internal-only", "--declared-only"],
];

const ALL_CASES: readonly Case[] = [
  ...SUCCESS_CASES,
  ...USAGE_CASES,
  ...FINDING_CASES,
  ...UNSETTLED_CASES.map((argv) => ({ why: `cycles: ${argv.join(" ")}`, argv, expected: -1 })),
];

describe("exit 0 — the command did what it was asked", () => {
  it.each(SUCCESS_CASES)("$why exits 0", ({ argv }) => {
    const result = runCli(argv);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
  });
});

describe("exit 2 — the invocation was wrong", () => {
  it.each(USAGE_CASES)("$why exits 2", ({ argv }) => {
    const result = runCli(argv);
    expect(result.code, describeResult(result)).toBe(EXIT.USAGE);
  });

  it("says something useful on stderr and nothing at all on stdout", () => {
    for (const { argv } of USAGE_CASES) {
      const result = runCli(argv);
      expect(result.stdout, `${describeArgv(argv)} wrote to stdout`).toBe("");
      expect(result.stderr.trim(), `${describeArgv(argv)} said nothing`).not.toBe("");
    }
  });
});

describe("exit 3 — the tool worked, the model did not", () => {
  it.each(FINDING_CASES)("$why exits 3", ({ argv }) => {
    const result = runCli(argv);
    expect(result.code, describeResult(result)).toBe(EXIT.FINDINGS);
  });

  it("distinguishes a corrupted copy from the clean original", () => {
    const clean = runCli(["validate", FIXTURE]);
    const corrupt = runCli(["validate", models.danglingReference]);
    expect(clean.code, describeResult(clean)).toBe(EXIT.OK);
    expect(corrupt.code, describeResult(corrupt)).toBe(EXIT.FINDINGS);
    expect(clean.stdout).not.toBe(corrupt.stdout);
  });
});

describe("exit 1 is reserved for codegraph's own bugs and must never occur", () => {
  it.each(ALL_CASES)("$why does not crash the CLI", ({ argv }) => {
    const result = runCli(argv);
    expect(
      result.code,
      `${describeResult(result)}\n\n` +
        `Exit 1 means codegraph crashed. Whatever is wrong here is either the ` +
        `invocation (2) or the model (3) — never a stack trace.`,
    ).not.toBe(EXIT.INTERNAL);
    expect(result.signal, `${describeArgv(argv)} was killed by a signal`).toBeNull();
  });

  it.each(UNSETTLED_CASES)("the cycle report %s ends in a settled outcome", (...argv) => {
    const result = runCli(argv);
    expect(
      [EXIT.OK, EXIT.FINDINGS],
      `${describeResult(result)}\n\n` +
        `A cycle report is either "nothing to flag" (0) or "your model has cycles" (3). ` +
        `It is never a crash and never a usage error.`,
    ).toContain(result.code);
  });

  it("only ever exits 0, 2 or 3 across every invocation in this suite", () => {
    const seen = new Map<number, string[]>();
    for (const { argv } of ALL_CASES) {
      const result = runCli(argv);
      const bucket = seen.get(result.code) ?? [];
      bucket.push(describeArgv(argv));
      seen.set(result.code, bucket);
    }
    const unexpected = [...seen.entries()].filter(([code]) => ![EXIT.OK, EXIT.USAGE, EXIT.FINDINGS].includes(code as 0 | 2 | 3));
    expect(unexpected, `unexpected exit codes: ${JSON.stringify(unexpected)}`).toEqual([]);
    // All three legitimate outcomes must actually be exercised, or "never 1"
    // would be trivially satisfiable by a CLI that always exits 0.
    expect([...seen.keys()].sort()).toEqual([EXIT.OK, EXIT.USAGE, EXIT.FINDINGS]);
  }, 120_000);
});
