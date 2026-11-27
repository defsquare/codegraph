import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@codegraph/core";
import { FRAMEWORK_PROFILES } from "@codegraph/analyzer";
import {
  FRAMEWORK_LANGUAGE,
  PROFILE_OF_EXTRACTOR,
  TRACE_EXTRACTORS,
  catalogue,
  renderCapabilities,
} from "./plugin-capabilities.js";
import { PLUGIN_ROOT, REPO_ROOT, readPlugin } from "./plugin-support.js";

/**
 * THE CAPABILITY SHEET IS WHAT THE CODE DECLARES (PLAN.md §24.1).
 *
 * `plugin/references/capabilities.md` tells an agent what a model of each
 * language holds, so it can say what is missing before a person finds out.
 * It is committed, because the plugin is read as files — and it is rendered,
 * because a profile that gains a kind must change it. This test fails when
 * rendering it again gives another text; `CODEGRAPH_UPDATE_SNAPSHOTS=1`
 * rewrites the file instead, as the Rust snapshots are rewritten.
 *
 * The three small tables the renderer cannot derive are each held against
 * the thing they restate.
 */

const TARGET = "references/capabilities.md";

describe("plugin/references/capabilities.md", () => {
  it("is exactly what the profiles, the framework profiles and the catalogue render to", () => {
    const rendered = renderCapabilities();
    if (process.env["CODEGRAPH_UPDATE_SNAPSHOTS"] === "1") {
      writeFileSync(join(PLUGIN_ROOT, TARGET), rendered, "utf8");
    }
    expect(readPlugin(TARGET), `regenerate: CODEGRAPH_UPDATE_SNAPSHOTS=1 pnpm --filter @codegraph/cli test plugin-capabilities`).toBe(rendered);
  });

  it("has a row for every extractor the catalogue ships, and a profile behind each", () => {
    const extractors = catalogue().filter((entry) => entry.role !== "pass");
    expect(extractors.map((entry) => entry.name).sort()).toEqual(Object.keys(PROFILE_OF_EXTRACTOR).sort());
    for (const entry of extractors) {
      expect(PROFILES[PROFILE_OF_EXTRACTOR[entry.name]!], `${entry.name} names no profile`).toBeDefined();
      expect(readPlugin(TARGET)).toContain(`\`${entry.command}\``);
    }
  });

  it("names a language for every framework profile, and no other", () => {
    expect(Object.keys(FRAMEWORK_LANGUAGE).sort()).toEqual(Object.keys(FRAMEWORK_PROFILES).sort());
    for (const lang of Object.values(FRAMEWORK_LANGUAGE)) expect(PROFILES[lang]).toBeDefined();
  });

  /**
   * "Takes a trace" is not data anywhere in TypeScript: the flag belongs to
   * each extractor. It is read off the extractors' own sources — an extractor
   * whose code spells `--trace` takes one, and no other does.
   */
  it("says an extractor takes a trace exactly when its sources spell --trace", () => {
    const SOURCE = /\.(java|cs|ts|ex|exs|rs)$/;
    const skip = new Set(["node_modules", "target", "_build", "deps", "dist", "bin", "obj"]);
    const mentions = (directory: string): boolean =>
      readdirSync(directory).some((name) => {
        if (skip.has(name)) return false;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) return mentions(path);
        return SOURCE.test(name) && readFileSync(path, "utf8").includes("--trace");
      });
    const taking = Object.keys(PROFILE_OF_EXTRACTOR).filter((name) => mentions(join(REPO_ROOT, "extractors", name)));
    expect(taking.sort()).toEqual([...TRACE_EXTRACTORS].sort());
  });
});
