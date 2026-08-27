import { beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import {
  describeArgv,
  describeResult,
  ensureCliBinary,
  javaFixture,
  packageVersion,
  runCli,
} from "./cli-process.js";

/**
 * HELP IS PART OF THE PRODUCT (decision 9), and the two directions matter
 * separately:
 *
 *   help you ASKED for      is that invocation's artifact -> stdout, exit 0
 *   help you were GIVEN     because the line was wrong    -> stderr, exit 2
 *
 * Getting this backwards is how `codegraph --help > usage.txt` ends up empty,
 * and how a CI job that greps stderr for failures starts reporting successes.
 */

const FIXTURE = javaFixture();
const COMMANDS = ["validate", "analyze", "export", "profiles"] as const;

beforeAll(ensureCliBinary, 120_000);

describe("requested help goes to stdout and exits 0", () => {
  it.each([["--help"], ["-h"]])("%s prints the global help", (flag) => {
    const result = runCli([flag]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(result.stderr, "requested help is not an error").toBe("");
    expect(result.stdout).toContain("usage: codegraph <command> [options]");
    for (const command of COMMANDS) expect(result.stdout).toContain(command);
    expect(result.stdout, "the help must document what the exit codes mean").toContain("exit codes:");
  });

  it.each(COMMANDS)("%s --help prints that command's own options", (command) => {
    const result = runCli([command, "--help"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`usage: codegraph ${command}`);
    expect(result.stdout).toContain("--help");
  });

  it("documents the flags each command actually accepts", () => {
    expect(runCli(["analyze", "--help"]).stdout).toContain("--report <deps|cycles|coupling|wiring>");
    expect(runCli(["export", "--help"]).stdout).toContain("--format <dot|json|csv|plantuml>");
    expect(runCli(["export", "--help"]).stdout).toContain("--out FILE");
    expect(runCli(["validate", "--help"]).stdout).toContain("--json");
    expect(runCli(["profiles", "--help"]).stdout).toContain("--lang");
  });

  it("answers --help even when the rest of the line is wrong", () => {
    // Help is usually asked for precisely BECAUSE the line is wrong; a missing
    // required flag must not shadow the answer.
    const result = runCli(["analyze", "--help", "--report", "nonsense"]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(result.stdout).toContain("usage: codegraph analyze");
  });
});

describe("--version prints the package version on stdout", () => {
  it.each([["--version"], ["-v"], ["-V"]])("%s exits 0 with the version", (flag) => {
    const result = runCli([flag]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageVersion());
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("a usage ERROR goes to stderr and exits 2", () => {
  const mistakes: readonly { readonly why: string; readonly argv: readonly string[]; readonly names: string }[] = [
    { why: "an unknown command", argv: ["frobnicate"], names: "validate" },
    { why: "an unknown global flag", argv: ["--frobnicate"], names: "--help" },
    { why: "a mistyped option", argv: ["analyze", FIXTURE, "--repot", "deps"], names: "--report" },
    { why: "a missing required option", argv: ["export", FIXTURE], names: "--format" },
    { why: "an invalid option value", argv: ["export", FIXTURE, "--format", "svg"], names: "dot" },
    { why: "a missing positional", argv: ["validate"], names: "model.jsonl" },
  ];

  it.each(mistakes)("$why exits 2 with nothing on stdout", ({ argv }) => {
    const result = runCli(argv);
    expect(result.code, describeResult(result)).toBe(EXIT.USAGE);
    expect(result.stdout, `${describeArgv(argv)} put an error on the artifact stream`).toBe("");
  });

  it.each(mistakes)("$why names what would have been valid", ({ argv, names }) => {
    const result = runCli(argv);
    expect(
      result.stderr,
      `${describeArgv(argv)} refused without saying what to type instead`,
    ).toContain(names);
  });

  it("prefixes the message once, and reads as one sentence", () => {
    const result = runCli(["frobnicate"]);
    expect(result.stderr).toMatch(/^codegraph: /);
    expect(result.stderr, "the prefix belongs to main.ts alone").not.toContain(
      "codegraph: codegraph",
    );
  });

  it("never prints a stack trace for a usage mistake", () => {
    for (const { argv } of mistakes) {
      const result = runCli(argv);
      expect(result.stderr, `${describeArgv(argv)} leaked a stack trace`).not.toMatch(/\n\s+at /);
    }
  });

  it("does not claim a bug in codegraph when the user simply mistyped", () => {
    const result = runCli(["analyze", FIXTURE, "--repot", "deps"]);
    expect(result.stderr).not.toContain("bug in codegraph");
    expect(result.code).toBe(EXIT.USAGE);
  });
});
