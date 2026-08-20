import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { cliBinary, ensureCliBinary, javaFixture, packageVersion, repoRoot } from "./cli-process.js";

/**
 * `codegraph` MUST be runnable as a program, not only as an argument to node.
 * Every other e2e suite spawns `node dist/index.js`, which would keep passing
 * long after the thing a user types stopped working: `node x` ignores both the
 * shebang line and the executable bit, so a bundle that lost either looks
 * healthy from there and fails on the command line.
 *
 * So this suite never passes the binary to node. It execs the file and lets the
 * KERNEL find the interpreter — the same code path as `./bin/codegraph` in a
 * shell, a `PATH` lookup, or a `git bisect run` script.
 */

/** The repo-root launcher: what you type from a fresh clone, before any link. */
function launcher(): string {
  return join(repoRoot(), "bin", "codegraph");
}

/** Exec the file itself — no `node` argv[0]. The shebang is what starts it. */
function exec(file: string, args: readonly string[], cwd?: string) {
  const result = spawnSync(file, args, {
    cwd: cwd ?? repoRoot(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`could not exec ${file}: ${result.error.message}`);
  }
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Owner-executable is the bit `execve` needs; anything less is not a program. */
function isExecutable(file: string): boolean {
  return (statSync(file).mode & 0o100) !== 0;
}

describe("the built bundle is a program", () => {
  beforeAll(ensureCliBinary);

  it("carries a node shebang and the executable bit", () => {
    expect(isExecutable(cliBinary()), `${cliBinary()} is not executable`).toBe(true);
  });

  it("runs when exec'd directly, with no node on the command line", () => {
    const run = exec(cliBinary(), ["--version"]);
    expect(`${run.code} ${run.stderr}`).toBe(`0 `);
    expect(run.stdout.trim()).toBe(packageVersion());
  });
});

describe("bin/codegraph", () => {
  beforeAll(ensureCliBinary);

  it("is an executable program", () => {
    expect(isExecutable(launcher()), `${launcher()} is not executable`).toBe(true);
  });

  it("forwards argv to the CLI", () => {
    const run = exec(launcher(), ["--version"]);
    expect(`${run.code} ${run.stderr}`).toBe(`0 `);
    expect(run.stdout.trim()).toBe(packageVersion());
  });

  /**
   * The launcher must be transparent about the two things CI reads: the exit
   * code, and which stream carried what. A wrapper that swallows either one
   * turns `codegraph validate` from a gate into decoration.
   */
  it("forwards the exit code of a failing invocation", () => {
    const run = exec(launcher(), ["no-such-command"]);
    expect(run.code).toBe(EXIT.USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
  });

  it("keeps the artifact on stdout", () => {
    const run = exec(launcher(), ["validate", javaFixture()]);
    expect(run.code).toBe(EXIT.OK);
    expect(run.stdout.length + run.stderr.length).toBeGreaterThan(0);
  });

  /**
   * Copied away from its `dist/`, the launcher has nothing to delegate to. That
   * is the state of every fresh clone, so it must say `pnpm -r build` rather
   * than spill an ERR_MODULE_NOT_FOUND stack — and exit 1 (the tool is broken),
   * never 2 (you typed it wrong) or 0.
   */
  it("explains itself when the CLI has not been built", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "codegraph-launcher-"));
    const copy = join(elsewhere, "codegraph");
    copyFileSync(launcher(), copy);
    chmodSync(copy, 0o755);

    const run = exec(copy, ["--version"], elsewhere);
    expect(run.code).toBe(EXIT.INTERNAL);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("pnpm -r build");
    expect(run.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
