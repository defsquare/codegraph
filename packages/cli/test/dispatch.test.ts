import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { run } from "../src/main.js";
import { cliVersion } from "../src/version.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.json", import.meta.url));

function invoke(argv: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
  files: ReadonlyMap<string, string>;
} {
  const io = captureIo();
  const code = run(argv, io);
  return { code, stdout: io.stdout(), stderr: io.stderr(), files: io.files() };
}

describe("help and version are part of the product (decision 9)", () => {
  it("prints the global help on stdout and exits 0", () => {
    const result = invoke(["--help"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: codegraph <command> [options]");
    expect(result.stdout).toContain("validate");
    expect(result.stdout).toContain("exit codes:");
  });

  it("prints a command's help on stdout and exits 0", () => {
    const result = invoke(["export", "--help"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: codegraph export");
    expect(result.stdout).toContain("--format <dot|json|csv>");
  });

  it("prints the package version on stdout and exits 0", () => {
    const result = invoke(["--version"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toBe(`${cliVersion()}\n`);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe("");
  });
});

describe("usage errors exit 2 and stay off stdout (decisions 2 and 3)", () => {
  const cases: readonly (readonly string[])[] = [
    [],
    ["frobnicate"],
    ["--frobnicate"],
    ["validate"],
    ["validate", FIXTURE, "--nope"],
    ["analyze", FIXTURE],
    ["analyze", FIXTURE, "--report", "nonsense"],
    ["export", FIXTURE],
    ["profiles", FIXTURE],
  ];
  // An unreadable model path is a usage error too, but it is raised INSIDE a
  // command (load.ts) — it cannot reach dispatch while the commands are seams.
  // `usage-from-command.test.ts` covers that path; `load.test.ts` covers the
  // throw itself.

  it.each(cases)("codegraph %s ... exits 2 with a helpful stderr message", (...argv) => {
    const result = invoke(argv);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("codegraph:");
    expect(result.stderr.length).toBeGreaterThan(20);
  });

  it("never prints a stack trace at a user", () => {
    const result = invoke(["analyze", FIXTURE, "--report", "nonsense"]);
    expect(result.stderr).not.toContain("    at ");
  });
});

/**
 * The seams. Every command is WIRED: dispatch reaches the real function, which
 * throws until its slice lands. That the throw arrives as exit 1 — an internal
 * error, never exit 3 — is the property that keeps "the tool broke" and "the
 * model is bad" apart while the slices are being written.
 */
describe("dispatch reaches every command seam", () => {
  const seams: readonly (readonly [string, readonly string[]])[] = [
    ["validate", ["validate", FIXTURE]],
    ["analyze", ["analyze", FIXTURE, "--report", "deps"]],
    ["export", ["export", FIXTURE, "--format", "dot"]],
    ["profiles", ["profiles"]],
  ];

  it.each(seams)("%s is wired and reports its seam", (name, argv) => {
    const result = invoke(argv);
    expect(result.stderr).toContain(`M4: ${name} fills this in`);
    expect(result.code).toBe(EXIT.INTERNAL);
    expect(result.code).not.toBe(EXIT.FINDINGS);
  });

  it("says an unexpected throw is a bug in codegraph, not in the model", () => {
    const result = invoke(["validate", FIXTURE]);
    expect(result.stderr).toContain("this is a bug in codegraph");
    expect(result.stdout).toBe("");
  });
});

describe("the sink is the only way out", () => {
  it("routes everything through the sink rather than the process", () => {
    const io = captureIo();
    const code = run(["--help"], io);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout().length).toBeGreaterThan(0);
    // Nothing reached the process: `run` was handed a capture and used it.
    expect(io.files().size).toBe(0);
  });

  it("returns a code instead of exiting the process", () => {
    const before = process.exitCode;
    invoke(["frobnicate"]);
    expect(process.exitCode).toBe(before);
  });
});

describe("error messages read as one sentence", () => {
  /** `main` owns the `codegraph: ` prefix, so no message may add its own. */
  const cases: readonly (readonly string[])[] = [
    ["validate"],
    ["analyze", FIXTURE],
    ["analyze", FIXTURE, "--repot", "deps"],
    ["profiles", FIXTURE],
    ["export", FIXTURE, "--format", "graphml"],
  ];

  it.each(cases)("codegraph %s ... says 'codegraph:' exactly once", (...argv) => {
    const { stderr } = invoke(argv);
    expect(stderr).not.toContain("codegraph: codegraph");
    expect(stderr.startsWith("codegraph: ")).toBe(true);
  });
});
