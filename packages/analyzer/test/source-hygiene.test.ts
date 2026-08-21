import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A raw NUL byte in a SOURCE file makes git classify it as binary: no diffs, no
 * merges, no blame, and `grep` skips it — the file silently stops being
 * reviewable. `queries.ts` documents the hazard for a separator it builds at
 * runtime; this test enforces the same rule for the files themselves, so a
 * separator constant must be written as an escape (the two characters backslash-u followed by 0000, quoted) rather than
 * pasted in as a literal control character.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST = fileURLToPath(new URL(".", import.meta.url));
/** The workspace's packages directory — this analyzer's grandparent. */
const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("analyzer sources stay text", () => {
  const files = [...typescriptFiles(SRC), ...typescriptFiles(TEST)];

  it("finds the sources to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s contains no raw NUL byte", (path) => {
    const bytes = readFileSync(path);
    expect(bytes.indexOf(0)).toBe(-1);
  });
});

/**
 * ONE LOAD SITE FOR `node:sqlite` (PLAN.md §9.3).
 *
 * The store's binding is loaded through `loadSqlite()`, which suppresses Node's
 * ExperimentalWarning for the duration of the load — `store/sqlite.ts` explains
 * why that cannot be done around a static import. `store-sqlite.test.ts` proves
 * the loader is quiet; the CLI's empty-stderr end-to-end tests prove nothing in
 * the shipped module graph is noisy.
 *
 * Neither of those can see the failure THIS test exists for: a second loader,
 * written just as carefully, in another package. It would break no assertion
 * and print nothing. It would simply be a second answer to "which SQLite are we
 * using", free to drift from the first. So the rule is stated as a count.
 *
 * The scan is workspace-wide because the rule binds every package; it lives
 * here because the analyzer owns the store.
 */
describe("node:sqlite is loaded in exactly one place", () => {
  const sources = readdirSync(PACKAGES)
    .map((pkg) => join(PACKAGES, pkg, "src"))
    .filter((dir) => existsSync(dir))
    .flatMap(typescriptFiles);

  it("scans every package's sources", () => {
    // A directory walk that quietly found nothing would pass the rule below by
    // vacuity, so state the floor: core, analyzer and cli together are dozens
    // of files.
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((path) => path.includes(join("cli", "src")))).toBe(true);
    expect(sources.some((path) => path.includes(join("core", "src")))).toBe(true);
  });

  it("has one and only one file that names it", () => {
    const mentions = sources
      .filter((path) => readFileSync(path, "utf8").includes("node:sqlite"))
      .map((path) => relative(PACKAGES, path));

    // A plain substring count, deliberately: it cannot be fooled by how the
    // import is spelled. The cost is that a COMMENT naming the builtin fails it
    // too — say "Node's SQLite builtin" in prose elsewhere, and keep the
    // literal specifier to the one file that loads it.
    expect(mentions).toEqual([join("analyzer", "src", "store", "sqlite.ts")]);
  });
});
