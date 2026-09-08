import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract, type Extraction } from "../src/extraction.js";
import { run, type Io, VERSION } from "../src/main.js";
import { Progress } from "../src/progress.js";

/** The repo root, found by walking up — these tests run from worktrees too. */
export function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml")) && existsSync(join(directory, "fixtures"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repo root not found");
    directory = parent;
  }
}

export const FIXTURE_SRC = "fixtures/typescript/src";
export const SNAPSHOT = join(repoRoot(), "fixtures/typescript/expected/model.jsonl");

/** One extraction of the fixture, in-process, silent. */
export function extractFixture(sources: readonly string[] = [FIXTURE_SRC]): Extraction {
  return extract(
    {
      sources,
      cwd: repoRoot(),
      repository: undefined,
      tsconfig: undefined,
      allowJs: false,
      ignoreNodeModules: false,
    },
    Progress.silent(),
    VERSION,
  );
}

export interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The CLI in-process, both streams captured separately. */
export function invoke(args: readonly string[], cwd: string = repoRoot()): Captured {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: { write: (text) => void (stdout += text), isTerminal: false },
    stderr: { write: (text) => void (stderr += text), isTerminal: false },
  };
  const code = run(args, io, cwd);
  return { code, stdout, stderr };
}
