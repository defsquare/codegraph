import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The end-to-end harness: it runs the REAL `codegraph` binary the way a user
 * and a CI job do — `node packages/cli/dist/index.js <args>` in a child process
 * — and hands back the exit code, stdout and stderr SEPARATELY.
 *
 * Separately is the whole point. Every in-process test can only observe the
 * `IoSink`; only a child process can prove that decision 3 (stdout = the
 * artifact, stderr = everything human) survives tsup's bundling, the shebang,
 * `process.exitCode`, and real OS pipes. `codegraph export … > graph.dot` is a
 * claim about file descriptors, and file descriptors are what this file uses.
 *
 * The repo root is FOUND by walking up from this file, never hardcoded: these
 * tests run from the main checkout and from agent worktrees alike, and an
 * absolute path would quietly test the wrong tree.
 */

export interface CliResult {
  /** The process exit status. `-1` when the child died from a signal instead. */
  readonly code: number;
  /** The signal that killed the child, when one did — a crash this suite must surface. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The argv as invoked, for assertion messages. */
  readonly argv: readonly string[];
}

export interface RunOptions {
  /** Extra environment for the child; `undefined` values delete a variable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/** Marker files that identify the repo root without naming a path. */
const ROOT_MARKERS = ["pnpm-workspace.yaml", "packages/cli/package.json"] as const;

let rootCache: string | undefined;

export function repoRoot(): string {
  if (rootCache !== undefined) return rootCache;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (ROOT_MARKERS.every((marker) => existsSync(join(directory, marker)))) {
      rootCache = directory;
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `could not locate the repo root above ${fileURLToPath(import.meta.url)} ` +
          `(looked for ${ROOT_MARKERS.join(" and ")})`,
      );
    }
    directory = parent;
  }
}

export function cliPackageDir(): string {
  return join(repoRoot(), "packages", "cli");
}

/** The bin `package.json` points at: `./dist/index.js`. The thing users run. */
export function cliBinary(): string {
  return join(cliPackageDir(), "dist", "index.js");
}

/** The measured corpus every e2e assertion is written against. */
export function javaFixture(): string {
  return join(repoRoot(), "fixtures", "java", "expected", "model.json");
}

/** The version `--version` must print, read from the package rather than guessed. */
export function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(cliPackageDir(), "package.json"), "utf8"));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("packages/cli/package.json has no version");
  }
  return version;
}

/**
 * Build `dist/` when it is missing. tsup is a devDependency of this package, so
 * this stays inside the package's own boundary — a sibling package's `dist` is
 * NOT built here, which is why `ensureCliBinary` probes instead of assuming.
 */
function buildCli(): { ok: boolean; detail: string } {
  const tsup = join(cliPackageDir(), "node_modules", ".bin", "tsup");
  if (!existsSync(tsup)) return { ok: false, detail: `${tsup} is missing` };
  const built = spawnSync(tsup, [], { cwd: cliPackageDir(), encoding: "utf8" });
  if (built.error !== undefined) return { ok: false, detail: built.error.message };
  if (built.status !== 0) return { ok: false, detail: `${built.stdout ?? ""}${built.stderr ?? ""}` };
  return { ok: true, detail: "" };
}

let readiness: { ready: true } | { ready: false; error: Error } | undefined;

/**
 * Make the binary runnable, or FAIL LOUDLY saying how to fix it.
 *
 * Never skips: a skipped e2e suite is indistinguishable from a passing one in a
 * CI summary, and this is the suite that guards the exit codes CI gates on.
 *
 * Readiness is proved by RUNNING `--version`, not by checking paths. The bundle
 * leaves `@codegraph/core` and `@codegraph/analyzer` external, so their imports
 * are resolved at module load — before any command runs. If either package's
 * `dist` is missing the binary cannot start at all, and `--version` says so in
 * one cheap invocation, whatever the workspace's symlink layout happens to be.
 */
export function ensureCliBinary(): void {
  if (readiness !== undefined) {
    if (readiness.ready) return;
    throw readiness.error;
  }
  const fail = (message: string): never => {
    const error = new Error(message);
    readiness = { ready: false, error };
    throw error;
  };

  if (!existsSync(cliBinary())) {
    const built = buildCli();
    if (!built.ok || !existsSync(cliBinary())) {
      fail(
        `${cliBinary()} is missing and could not be built.\n` +
          `Run \`pnpm -r build\` from ${repoRoot()} and re-run these tests.\n` +
          `Build output: ${built.detail}`,
      );
    }
  }

  const probe = runCli(["--version"]);
  if (probe.code !== 0 || probe.stdout.trim().length === 0) {
    fail(
      `the built CLI cannot start, so the end-to-end suite cannot run.\n` +
        `Run \`pnpm -r build\` from ${repoRoot()} — @codegraph/core and ` +
        `@codegraph/analyzer are external to the bundle and must be built too.\n` +
        `\`codegraph --version\` exited ${probe.code}${probe.signal === null ? "" : ` (signal ${probe.signal})`}.\n` +
        `stderr: ${probe.stderr.trim()}`,
    );
  }
  readiness = { ready: true };
}

/**
 * `NO_COLOR` and `FORCE_COLOR` are removed by default: inheriting either would
 * make colour assertions depend on the developer's shell, and decision 4 is
 * unconditional. A test that wants to provoke colour passes it explicitly.
 */
function childEnv(overrides: RunOptions["env"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["NO_COLOR"];
  delete env["FORCE_COLOR"];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Run the binary and capture both streams. Never throws on a non-zero exit. */
export function runCli(args: readonly string[], options?: RunOptions): CliResult {
  const result = spawnSync(process.execPath, [cliBinary(), ...args], {
    cwd: options?.cwd ?? repoRoot(),
    encoding: "utf8",
    env: childEnv(options?.env),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`could not spawn the CLI: ${result.error.message}`);
  }
  return {
    code: result.status ?? -1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    argv: args,
  };
}

/**
 * `codegraph … > file` with a REAL redirect: the child's fd 1 IS the file, so
 * nothing in this process can touch the bytes on the way. That is the only
 * honest way to test the property `--out`-less export exists for.
 */
export function runCliRedirectingStdout(
  args: readonly string[],
  path: string,
  options?: RunOptions,
): Omit<CliResult, "stdout"> {
  const fd = openSync(path, "w");
  try {
    const result = spawnSync(process.execPath, [cliBinary(), ...args], {
      cwd: options?.cwd ?? repoRoot(),
      encoding: "utf8",
      env: childEnv(options?.env),
      stdio: ["ignore", fd, "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      throw new Error(`could not spawn the CLI: ${result.error.message}`);
    }
    return {
      code: result.status ?? -1,
      signal: result.signal,
      stderr: result.stderr ?? "",
      argv: args,
    };
  } finally {
    closeSync(fd);
  }
}

/** `codegraph …` rendered the way a user typed it, for assertion messages. */
export function describeArgv(argv: readonly string[]): string {
  return `codegraph ${argv.join(" ")}`;
}

/** The full picture of a run, so a failing assertion explains itself. */
export function describeResult(result: Pick<CliResult, "argv" | "code" | "stderr">): string {
  return [
    `command: ${describeArgv(result.argv)}`,
    `exit:    ${result.code}`,
    `stderr:  ${result.stderr.trim() === "" ? "(empty)" : result.stderr.trim()}`,
  ].join("\n");
}

/**
 * Decision 4 is unconditional, so the check is the strictest one available: no
 * ESC (U+001B) and no 8-bit CSI (U+009B) byte anywhere, rather than a pattern for
 * whichever sequences we happened to think of. Every ANSI escape starts with one
 * of those two bytes, and neither has any business in a report, a DOT file or a
 * CSV.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_INTRODUCER = /[\u001B\u009B]/;

export function expectNoAnsi(text: string, label: string): void {
  const match = ANSI_INTRODUCER.exec(text);
  if (match !== null) {
    const from = Math.max(0, match.index - 20);
    throw new Error(
      `${label} contains an ANSI escape introducer at offset ${match.index}: ` +
        JSON.stringify(text.slice(from, match.index + 20)),
    );
  }
}
