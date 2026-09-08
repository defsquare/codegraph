import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeToString } from "../src/model/writer.js";
import { extract } from "../src/extraction.js";
import { Progress } from "../src/progress.js";
import { VERSION } from "../src/main.js";
import { extractFixture, FIXTURE_SRC, repoRoot } from "./harness.js";

/**
 * Two runs over one unchanged corpus write the same bytes (contract §6) — on
 * every OS, whatever the file system enumerates first, whatever the line
 * endings a checkout produced. Anchors are line-based, so a CRLF copy of the
 * corpus must produce the SAME model.
 */
const scratch = mkdtempSync(join(tmpdir(), "codegraph-ts-determinism-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function extractAt(root: string, sources: readonly string[]): string {
  return encodeToString(
    extract(
      { sources, cwd: root, repository: undefined, tsconfig: undefined, allowJs: false, ignoreNodeModules: false },
      Progress.silent(),
      VERSION,
    ).model,
  );
}

function convertToCrlf(directory: string): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) convertToCrlf(path);
    else if (/\.(ts|tsx|json)$/.test(entry)) {
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
    }
  }
}

describe("determinism", () => {
  it("writes the same bytes twice", () => {
    expect(encodeToString(extractFixture().model)).toBe(encodeToString(extractFixture().model));
  });

  it("writes the same bytes from a CRLF checkout of the corpus", () => {
    const copy = join(scratch, "crlf");
    cpSync(join(repoRoot(), FIXTURE_SRC), join(copy, FIXTURE_SRC), { recursive: true });
    convertToCrlf(copy);
    expect(extractAt(copy, [FIXTURE_SRC])).toBe(extractAt(repoRoot(), [FIXTURE_SRC]));
  });

  it("keys nothing by walk order: two roots in either order give one model", () => {
    const a = extractAt(repoRoot(), [`${FIXTURE_SRC}/packages`, `${FIXTURE_SRC}/legacy`]);
    const b = extractAt(repoRoot(), [`${FIXTURE_SRC}/legacy`, `${FIXTURE_SRC}/packages`]);
    expect(a).toBe(b);
    // With several roots the header names their common ancestor.
    expect((JSON.parse(a.split("\n")[0] as string) as { root: string }).root).toBe(FIXTURE_SRC);
  });
});
