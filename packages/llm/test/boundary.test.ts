import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The provider SDK is confined to ONE file. Every other module in this package
 * — and every other package in the workspace — programs against `LlmClient`,
 * so a provider swap or an SDK breaking change touches exactly one place and
 * no test anywhere can accidentally reach the network.
 */

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const SDK = "@openrouter" + "/sdk"; // split so this file does not count as a use

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("the provider SDK boundary", () => {
  it("is imported by packages/llm/src/openrouter.ts and nowhere else in the workspace", () => {
    const users = typescriptFiles(PACKAGES)
      .filter((path) => readFileSync(path, "utf8").includes(SDK))
      .map((path) => relative(PACKAGES, path))
      .sort();
    expect(users).toEqual(["llm/src/openrouter.ts"]);
  });
});
