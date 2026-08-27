import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEP_ROLES,
  NAVIGATOR_ARTEFACT_KIND as CANONICAL_KIND,
} from "@codegraph/navigator";
import { NAVIGATOR_ARTEFACT_KIND, NavigatorLoadError, parseNavigatorModel } from "../src/guard.js";
import { DEP_ROLE_ORDER } from "../src/model/grouping.js";
import { artifact } from "./fixture.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * THE BUNDLE BOUNDARY. A value import from `@codegraph/navigator` drags
 * navigator → analyzer → core — zod, `node:fs`, the SQLite loader — into the
 * browser bundle; `vite build` then fails on `createReadStream is not exported
 * by __vite-browser-external`. That happened once, for one convenience import
 * of `DEP_ROLES`. This states the rule instead of relying on remembering it.
 */
describe("the browser bundle stays browser-only", () => {
  it("imports the navigator package for TYPES only", () => {
    const offenders = sourceFiles(SRC).filter((path) => {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/^import\s+([^;]*?)\s+from\s+"@codegraph\/navigator"/gm)) {
        if (!(match[1] as string).startsWith("type ")) return true;
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });
});

describe("the artifact guard", () => {
  /**
   * THE DRIFT ALARM. The app restates the kind as a literal so no runtime
   * import of the navigator package (and with it zod and the SQLite loader)
   * reaches the browser bundle. This test is what keeps the two in step.
   */
  it("restates the package's own kind exactly", () => {
    expect(NAVIGATOR_ARTEFACT_KIND).toBe(CANONICAL_KIND);
  });

  /** The same alarm for the role vocabulary — ORDER included: it is what
   * orders the sections of the dependency view. */
  it("restates the package's role vocabulary exactly, in order", () => {
    expect([...DEP_ROLE_ORDER]).toEqual([...DEP_ROLES]);
  });

  it("accepts a navigator artifact", () => {
    const parsed = parseNavigatorModel(JSON.stringify(artifact()));
    expect(parsed.nodes).toHaveLength(6);
    expect(parsed.corpus.name).toBe("toy");
  });

  it("refuses a model.jsonl payload, naming the command that converts it", () => {
    const modelish = JSON.stringify({ schemaVersion: "1.0.0", lang: "java", entities: [], edges: [] });
    expect(() => parseNavigatorModel(modelish)).toThrow(NavigatorLoadError);
    expect(() => parseNavigatorModel(modelish)).toThrow(/codegraph navigator/);
  });

  it("refuses a city artifact", () => {
    expect(() => parseNavigatorModel(JSON.stringify({ kind: "codegraph.city/1" }))).toThrow(
      /codegraph.navigator\/1/,
    );
  });

  it("refuses non-JSON and JSON that is not an object", () => {
    expect(() => parseNavigatorModel("not json")).toThrow(NavigatorLoadError);
    expect(() => parseNavigatorModel("[1,2]")).toThrow(NavigatorLoadError);
  });

  it("refuses an artifact missing a required array", () => {
    const broken = { ...artifact(), deps: undefined };
    expect(() => parseNavigatorModel(JSON.stringify(broken))).toThrow(/deps/);
  });
});
