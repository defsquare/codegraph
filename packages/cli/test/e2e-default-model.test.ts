import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBinary, javaFixture, runCli } from "./cli-process.js";

/**
 * The default model path is a claim about the PROCESS's working directory, so
 * only a child process started elsewhere can prove it: an in-process test would
 * be measuring the test runner's cwd, which is not where users stand.
 *
 * The pairing under test is the whole point — `codegraph-java` run bare writes
 * `<dir>-codegraph.jsonl`, and `analyze`/`city` run bare read it back.
 */
describe("analyze and city default to the model the extractor writes here", () => {
  let root: string;
  let corpus: string;
  let empty: string;

  beforeAll(() => {
    ensureCliBinary();
    root = mkdtempSync(join(tmpdir(), "codegraph-default-"));
    corpus = join(root, "acme-shop");
    empty = join(root, "empty-corpus");
    mkdirSync(corpus);
    mkdirSync(empty);
    copyFileSync(javaFixture(), join(corpus, `${basename(corpus)}-codegraph.jsonl`));
  });

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("analyzes the local model with no path given", () => {
    const bare = runCli(["analyze", "--report", "deps"], { cwd: corpus });
    const explicit = runCli(["analyze", "--report", "deps", `${basename(corpus)}-codegraph.jsonl`], {
      cwd: corpus,
    });

    expect(bare.code, bare.stderr).toBe(explicit.code);
    expect(bare.stdout).toBe(explicit.stdout);
    expect(bare.stdout.length).toBeGreaterThan(0);
  });

  it("builds the city from the local model with no path given", () => {
    const run = runCli(["city", "--layout"], { cwd: corpus });

    expect(run.code, run.stderr).toBe(0);
    const city: unknown = JSON.parse(run.stdout);
    expect((city as { districts?: unknown[] }).districts?.length ?? 0).toBeGreaterThan(0);
  });

  it("says which file it looked for, and how to make it, when it is not there", () => {
    for (const argv of [["analyze", "--report", "deps"], ["city"]]) {
      const run = runCli(argv, { cwd: empty });

      expect(run.code, run.stderr).toBe(2);
      expect(run.stderr).toContain("empty-corpus-codegraph.jsonl");
      expect(run.stderr).toContain("codegraph-java");
      expect(run.stdout, "a usage error writes nothing to stdout").toBe("");
    }
  });
});
