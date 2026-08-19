import { describe, expect, it } from "vitest";
import * as analyzer from "../src/index.js";
import { javaGraph } from "./fixture.js";

/**
 * The seams are wired for real: they are reachable through the package barrel
 * and they fail loudly, so an unimplemented slice can never be mistaken for an
 * empty result. When a slice lands, its case here becomes a real assertion.
 */
const SEAMS: Readonly<Record<string, () => unknown>> = {
  importGraph: () => analyzer.importGraph(javaGraph()),
  typeDependencyGraph: () => analyzer.typeDependencyGraph(javaGraph()),
  dependenciesOf: () => analyzer.dependenciesOf({} as never, "x"),
  dependentsOf: () => analyzer.dependentsOf({} as never, "x"),
  coupling: () => analyzer.coupling({} as never),
  cycles: () => analyzer.cycles({} as never),
};

/**
 * The export slice has landed, so its functions no longer belong above: they
 * are asserted for real in exports-dot/csv/json.test.ts. They still have to be
 * reachable through the barrel.
 */
const LANDED = [
  "toDot",
  "escapeDot",
  "foldedGraphToCsv",
  "couplingToCsv",
  "cyclesToCsv",
  "foldedGraphToJson",
  "couplingToJson",
  "cyclesToJson",
  "toJsonString",
] as const;

describe("M3 seams", () => {
  for (const [name, call] of Object.entries(SEAMS)) {
    it(`${name} is exported from the barrel and throws until its slice lands`, () => {
      expect(typeof (analyzer as Record<string, unknown>)[name]).toBe("function");
      expect(call).toThrow(/^M3: .* slice fills this in$/);
    });
  }

  it("still exports the landed export slice from the barrel", () => {
    for (const name of LANDED) {
      expect(typeof (analyzer as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("exports the foundation the slices code against", () => {
    for (const name of [
      "loadModels",
      "buildGraph",
      "foldGraph",
      "createFolder",
      "folderFor",
      "containingType",
      "containingModule",
      "projectView",
      "composeViews",
      "internalOnly",
      "declaredOnly",
      "identityView",
      "compareIds",
      "sortIds",
      "sortedUnique",
      "FOLD_LEVELS",
    ]) {
      expect((analyzer as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("no longer exposes the M0 placeholder", () => {
    expect("ANALYZER_PACKAGE" in analyzer).toBe(false);
  });
});
