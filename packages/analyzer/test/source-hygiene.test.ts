import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
