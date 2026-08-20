import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliVersion } from "../src/version.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
  version: string;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe("the CLI's package surface", () => {
  /**
   * ZERO DEPENDENCIES FOR ARGUMENT PARSING (decision 1). Node 22 ships
   * `parseArgs`; a parser dependency here would be the first crack in a
   * dependency list that is meant to stay exactly two workspace packages.
   */
  it("depends on nothing but the two workspace packages", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@codegraph/analyzer",
      "@codegraph/core",
    ]);
  });

  it("imports no third-party argument parser", () => {
    const banned = ["commander", "yargs", "minimist", "clipanion", "cac", "meow"];
    for (const file of typescriptFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const name of banned) {
        expect(source.includes(`"${name}"`), `${file} imports ${name}`).toBe(false);
      }
    }
  });

  it("declares the codegraph bin at the built entry point", () => {
    expect(manifest.bin["codegraph"]).toBe("./dist/index.js");
  });

  it("runs its tests for real — no --passWithNoTests", () => {
    expect(manifest.scripts["test"]).toBe("vitest run");
  });

  it("reports the package's own version, with no JSON import assertion", () => {
    expect(cliVersion()).toBe(manifest.version);
    // An import assertion would be resolved at BUILD time by tsup, so the
    // installed binary would report the version it was compiled with.
    const importAssertion = /\bfrom\s+"[^"]+"\s+(with|assert)\s*\{/;
    for (const file of typescriptFiles(SRC)) {
      expect(importAssertion.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });

  it("no longer exposes the M0 placeholder", () => {
    for (const file of typescriptFiles(SRC)) {
      expect(readFileSync(file, "utf8").includes("CLI_PACKAGE"), file).toBe(false);
    }
  });
});

describe("CLI sources stay reviewable text", () => {
  const files = [...typescriptFiles(SRC), ...typescriptFiles(TEST)];

  it("finds the sources to check", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  /**
   * A raw control byte makes git call the file binary: no diff, no blame, and
   * `grep` skips it. Escape sequences only — the ANSI test writes its escape as
   * "\\u001b" for exactly this reason.
   */
  it.each(files)("%s contains no raw NUL or ESC byte", (path) => {
    const bytes = readFileSync(path);
    expect(bytes.indexOf(0)).toBe(-1);
    expect(bytes.indexOf(0x1b)).toBe(-1);
  });
});
