import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokenModels, scratchPath } from "./broken-models.js";
import { describeArgv, ensureCliBinary, javaFixture, runCli, unicodeFixture } from "./cli-process.js";

/**
 * DETERMINISM (decision 6): identical inputs and flags produce byte-identical
 * stdout.
 *
 * This is what makes an artifact committable, diffable and reviewable. The
 * usual way to lose it is letting `Map`/`Set` iteration order reach the user —
 * which is invisible in a single run and shows up as noise in a pull request
 * six weeks later. Two runs of the same command are the cheapest way to catch
 * it, and the only one that tests the built binary rather than a sorted helper.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();
const UNICODE = unicodeFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

const INVOCATIONS: readonly (readonly string[])[] = [
  ["--help"],
  ["--version"],
  ["profiles"],
  ["profiles", "--json"],
  ["profiles", "--lang", "java"],
  ["validate", FIXTURE],
  ["validate", FIXTURE, "--json"],
  ["analyze", FIXTURE, "--report", "deps"],
  ["analyze", FIXTURE, "--report", "cycles", "--level", "type"],
  ["analyze", FIXTURE, "--report", "coupling", "--json"],
  ["analyze", FIXTURE, "--report", "coupling", "--top", "5"],
  ["export", FIXTURE, "--format", "dot"],
  ["export", FIXTURE, "--format", "csv", "--level", "type"],
  ["export", FIXTURE, "--format", "json", "--internal-only"],
  ["export", FIXTURE, "--format", "plantuml", "--internal-only"],
  // The collation fixture: its identifiers order differently under UTF-16 code
  // units (what codegraph uses) than under UTF-8 bytes (what a database would),
  // so it is the one input where "sorted" is not a single answer.
  ["validate", UNICODE],
  ["analyze", UNICODE, "--report", "deps", "--level", "type"],
  ["export", UNICODE, "--format", "csv", "--level", "type"],
  ["export", UNICODE, "--format", "json", "--level", "type"],
];

describe("stdout is byte-identical across runs", () => {
  it.each(INVOCATIONS)("%s repeats exactly", (...argv) => {
    const first = runCli(argv);
    const second = runCli(argv);
    expect(second.code).toBe(first.code);
    expect(second.stdout, `${describeArgv(argv)} produced different stdout on the second run`).toBe(
      first.stdout,
    );
  });
});

describe("the human stream is diffable too", () => {
  /**
   * Not required by decision 6, which speaks only of stdout — but a timestamp
   * or an elapsed-time figure on stderr turns every CI log into a false diff,
   * and there is nothing this CLI reports that needs one. Relax this test only
   * by deciding, deliberately, that stderr may vary.
   */
  it.each(INVOCATIONS)("%s repeats its stderr exactly", (...argv) => {
    const first = runCli(argv);
    const second = runCli(argv);
    expect(second.stderr, `${describeArgv(argv)} produced different stderr on the second run`).toBe(
      first.stderr,
    );
  });
});

describe("determinism survives the paths the artifact can take", () => {
  it("--out writes the same bytes twice", () => {
    const first = scratchPath(models, "determinism-1.csv");
    const second = scratchPath(models, "determinism-2.csv");
    runCli(["export", FIXTURE, "--format", "csv", "--out", first]);
    runCli(["export", FIXTURE, "--format", "csv", "--out", second]);
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
  });

  it("does not depend on the working directory", () => {
    const fromRoot = runCli(["export", FIXTURE, "--format", "json"]);
    const fromTemp = runCli(["export", FIXTURE, "--format", "json"], { cwd: models.dir });
    expect(fromTemp.stdout, "an absolute model path must give the same artifact anywhere").toBe(
      fromRoot.stdout,
    );
  });

  it("does not depend on the order two identical models are listed in", () => {
    const first = runCli(["export", FIXTURE, models.pristineCopy, "--format", "json"]);
    const second = runCli(["export", models.pristineCopy, FIXTURE, "--format", "json"]);
    // The union is the same set of declarations either way, so the folded graph
    // — and therefore the artifact — must not know which path came first.
    expect(second.stdout).toBe(first.stdout);
  });
});
