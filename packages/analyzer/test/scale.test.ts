import { describe, expect, it } from "vitest";
import type { Entity, Model } from "@codegraph/core";
import { loadModels } from "../src/load.js";
import { buildGraph } from "../src/graph.js";

/**
 * Sizes that only a real corpus reaches. Every bug this file guards was found
 * on apache/fineract (240 929 entities / 782 032 edges) and was invisible on
 * every hand-built graph in the suite — which is the point: "works on the
 * fixture" says nothing about the shapes a 6 704-file corpus produces.
 */

/** Big enough to overflow a call stack spread as arguments, small enough to run. */
const SIZE = 200_000;

function hugeModel(): Model {
  const entities: Entity[] = [
    {
      id: "java:m",
      kind: "package",
      traits: ["TNamed", "TModule"],
      name: "m",
      definedIn: [],
      isStub: false,
    } as unknown as Entity,
  ];
  for (let i = 0; i < SIZE; i += 1) {
    entities.push({
      id: `java:m/T${i}`,
      kind: "class",
      traits: ["TNamed", "TType"],
      name: `T${i}`,
      isStub: false,
    } as unknown as Entity);
  }
  return {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "scale", version: "0.0.0" },
    root: "/corpus",
    entities,
    edges: [],
  };
}

describe("a corpus-sized model (PLAN §9.2)", () => {
  /**
   * Regression: `entities.push(...model.entities)` passes one ARGUMENT per
   * element, so the union blew the call stack at ~240k entities and the CLI
   * reported an internal error. It fails long before memory runs out, and no
   * amount of test-sized data reaches it.
   */
  it("unions without spreading its arrays onto the call stack", () => {
    const { union } = loadModels([hugeModel()], { onSchemaError: "throw" });
    expect(union.entities.length).toBe(SIZE + 1);
  });

  it("indexes at that size too", () => {
    const graph = buildGraph(loadModels([hugeModel()], { onSchemaError: "throw" }).union);
    expect(graph.entities.size).toBe(SIZE + 1);
    expect(graph.entity(`java:m/T${SIZE - 1}`)).toBeDefined();
  });
});
