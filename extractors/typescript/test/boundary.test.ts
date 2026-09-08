import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The extractor holds no metamodel intelligence and imports no `@codegraph/*`
 * package at runtime (PLAN.md §14, principle 2). Core is a devDependency of
 * these TESTS — validating one's output against the reference reader is
 * exactly right — and nothing under `src/` may reach it: the two-encoder gate
 * ("byte-identical to core's encoder") is a statement only while the
 * encoders are independent.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the extractor's boundary", () => {
  it("imports nothing from @codegraph under src/", () => {
    const users = files(SRC)
      .filter((path) => readFileSync(path, "utf8").includes("@codegraph" + "/"))
      .map((path) => relative(SRC, path));
    expect(users).toEqual([]);
  });

  it("depends on typescript and nothing else at runtime", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["typescript"]);
  });
});
