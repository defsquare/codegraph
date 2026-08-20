import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as analyzer from "../src/index.js";

/**
 * THE PACKAGE SURFACE. This file was `seams.test.ts` while M3 was being built
 * in slices: each seam threw `M3: <slice> fills this in`, and this suite proved
 * the throw, so an unimplemented slice could never be mistaken for an empty
 * result. All five slices have landed, so the seams are gone and the file now
 * guards the two things that outlast them:
 *
 *  1. THE BARREL IS THE API. Every stage of the pipeline is reachable from
 *     `@codegraph/analyzer` itself. A function that exists in `src/` but is not
 *     re-exported is not delivered, and the failure would otherwise only appear
 *     in a downstream package (`cli`, later `viz`).
 *  2. NO SEAM PLACEHOLDER SURVIVES IN SHIPPED SOURCE. This is the durable form
 *     of the old assertion: it used to check that a named seam still threw;
 *     it now checks that no seam is left anywhere, which also catches a slice
 *     that landed only halfway (one exported function still throwing) and any
 *     future seam that is committed and then forgotten.
 */

const SEAM_MARKER = "slice fills this in";

/** Every function the pipeline's stages are driven through, by stage. */
const PUBLIC_API = {
  order: ["compareIds", "sortIds", "sortedUnique", "compareEdges", "comparePairs"],
  load: ["loadModels", "isClean"],
  graph: ["buildGraph", "hasTrait", "entityName", "entityParent", "declaredChildren"],
  views: ["projectView", "composeViews", "makeView", "provenanceOnly", "includesEntity", "includesEdge"],
  fold: ["foldGraph", "createFolder", "folderFor", "containingType", "containingModule"],
  queries: [
    "importGraph",
    "typeDependencyGraph",
    "dependenciesOf",
    "dependentsOf",
    "neighboursOf",
  ],
  metrics: ["coupling", "couplingRow", "topByFanIn", "topByFanOut", "cycles", "selfLoopEdges"],
  exports: [
    "toDot",
    "escapeDot",
    "toPlantUml",
    "escapePlantUmlLabel",
    "foldedGraphToCsv",
    "couplingToCsv",
    "cyclesToCsv",
    "foldedGraphToJson",
    "couplingToJson",
    "cyclesToJson",
    "toJsonString",
  ],
} as const;

/** Non-function exports that are part of the contract too. */
const PUBLIC_VALUES = [
  "FOLD_LEVELS",
  "identityView",
  "internalOnly",
  "declaredOnly",
  "FOLDED_GRAPH_ARTEFACT_KIND",
  "ARTEFACT_GENERATOR",
] as const;

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("the analyzer's public API", () => {
  for (const [stage, names] of Object.entries(PUBLIC_API)) {
    it(`exports every ${stage} function from the barrel`, () => {
      for (const name of names) {
        expect(typeof (analyzer as Record<string, unknown>)[name], name).toBe("function");
      }
    });
  }

  it("exports the pipeline's public values", () => {
    for (const name of PUBLIC_VALUES) {
      expect((analyzer as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("has no seam placeholder left anywhere in src", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes(SEAM_MARKER),
    );
    expect(offenders).toEqual([]);
  });

  it("no longer exposes the M0 placeholder", () => {
    expect("ANALYZER_PACKAGE" in analyzer).toBe(false);
  });
});
