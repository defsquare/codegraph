import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo, type IoSink } from "../src/io.js";
import { failure, run, runSync } from "../src/main.js";
import { cliVersion } from "../src/version.js";

/** Every .ts file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

function invoke(argv: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
  files: ReadonlyMap<string, string>;
} {
  const io = captureIo();
  const code = runSync(argv, io);
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
    expect(result.stdout).toContain("--format <dot|json|csv|plantuml>");
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
    ["analyze", FIXTURE, "--report", "nonsense"],
    ["analyze", FIXTURE, "--top", "0"],
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
 * The seams. While M4 was built in slices each command threw
 * `M4: <name> fills this in`, and this suite proved the throw, so an
 * unimplemented command could never be mistaken for an empty report. All four
 * slices have landed, so the seams are gone and what outlasts them is the
 * property the scaffold was really protecting: dispatch REACHES each command,
 * and reaching it is never reported as an internal error.
 *
 * The old assertion is restated the way M3's `public-api.test.ts` restated its
 * own — from "this named seam still throws" to "no seam survives anywhere",
 * which additionally catches a command that landed only halfway and any future
 * seam that is committed and then forgotten.
 */
describe("dispatch reaches every command", () => {
  const commands: readonly (readonly [string, readonly string[]])[] = [
    ["validate", ["validate", FIXTURE]],
    ["analyze", ["analyze", FIXTURE, "--report", "deps"]],
    ["export", ["export", FIXTURE, "--format", "dot"]],
    ["profiles", ["profiles"]],
  ];

  it.each(commands)("%s is wired and runs", (_name, argv) => {
    const result = invoke(argv);
    // The fixture is clean, so every command must succeed outright. The point
    // that matters either way: never exit 1 — "the tool broke" and "the model
    // is bad" stay distinguishable (decision 2).
    expect(result.code).toBe(EXIT.OK);
    expect(result.code).not.toBe(EXIT.INTERNAL);
    expect(result.stdout.length, `${_name} produced no artifact`).toBeGreaterThan(0);
  });

  it("has no seam placeholder left anywhere in src", () => {
    const offenders = sourceFiles(fileURLToPath(new URL("../src", import.meta.url))).filter((file) =>
      readFileSync(file, "utf8").includes("fills this in"),
    );
    expect(offenders).toEqual([]);
  });

  it("says an unexpected throw is a bug in codegraph, not in the model", () => {
    // The seams used to supply the unexpected throw. With them gone, provoke a
    // real one: a sink that fails mid-write is exactly the kind of internal
    // fault that must not be reported as a finding about the user's model.
    const io = captureIo();
    const boom: IoSink = {
      out: () => {
        throw new Error("sink failed");
      },
      err: io.err,
      writeFile: io.writeFile,
    };
    const code = runSync(["profiles"], boom);
    expect(code).toBe(EXIT.INTERNAL);
    expect(code).not.toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("this is a bug in codegraph");
    expect(io.stdout()).toBe("");
  });
});

describe("the sink is the only way out", () => {
  it("routes everything through the sink rather than the process", () => {
    const io = captureIo();
    const code = runSync(["--help"], io);
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
    ["analyze", FIXTURE, "--top", "zero"],
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

describe("run stays synchronous for every command that does not await the network", () => {
  it("returns a plain number, not a promise, for help, version and a model command", () => {
    for (const argv of [["--help"], ["--version"], ["validate", FIXTURE]]) {
      const outcome = run(argv, captureIo());
      expect(typeof outcome).toBe("number");
    }
  });

  it("maps a UsageError to exit 2 and anything else to exit 1 through one function", () => {
    const usage = captureIo();
    expect(failure(usage, new UsageError("no key", "Set OPENROUTER_API_KEY."))).toBe(EXIT.USAGE);
    expect(usage.stdout()).toBe("");
    expect(usage.stderr()).toContain("codegraph: no key");
    expect(usage.stderr()).toContain("Set OPENROUTER_API_KEY.");

    const bug = captureIo();
    expect(failure(bug, new TypeError("boom"))).toBe(EXIT.INTERNAL);
    expect(bug.stdout()).toBe("");
    expect(bug.stderr()).toContain("internal error");
    expect(bug.stderr()).toContain("TypeError: boom");
  });
});
