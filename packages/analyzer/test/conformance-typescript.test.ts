import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import { loadModels } from "../src/load.js";
import { typeDependencyGraph } from "../src/queries.js";
import { typescriptFixture, typescriptGraph } from "./fixture.js";

/**
 * The acceptance gate over the THIRD real extractor's output (PLAN §14.6):
 * every invariant the Java and Roslyn snapshots pass, the compiler-API
 * snapshot passes too — closure, no self-reference, provenance, profile,
 * anchors, ids — and the analyzer's queries read it without knowing which
 * language wrote it, module = file and all.
 */
describe("checkConformance on the committed TypeScript snapshot", () => {
  const report = checkConformance(loadModels(typescriptFixture(), { sources: ["fixtures/typescript"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
  });
});

describe("the analyzer over the TypeScript snapshot", () => {
  it("builds a graph whose containment reaches every entity from its file", () => {
    const graph = typescriptGraph();
    const entities = [...graph.entities.values()];
    expect(entities.length).toBeGreaterThan(150);
    const roots = entities.filter((e) => graph.parentOf(e.id) === undefined);
    // Only modules stand without a parent — every type, member, local and arrow hangs below one.
    for (const root of roots) expect(root.kind, root.id).toBe("module");
  });

  it("folds every edge kind to the type level, nameless invocables and parameter properties included", () => {
    const folded = typeDependencyGraph(typescriptGraph());
    const ids = new Set(folded.nodes.map((node) => node.id));
    expect(ids.has("ts:packages%2Forder%2Fsrc%2Forder.ts/Order")).toBe(true);
    expect(ids.has("ts:<lib>/Error")).toBe(true);
    // An arrow's call and a JSX element's call fold to the enclosing type or module like a method's.
    const fromOrder = folded.edges.filter((edge) => edge.from === "ts:packages%2Forder%2Fsrc%2Forder.ts/Order").map((edge) => edge.to);
    expect(fromOrder).toContain("ts:packages%2Forder%2Fsrc%2Fabstract-order.ts/AbstractOrder");
    expect(fromOrder).toContain("ts:packages%2Forder%2Fsrc%2Fchannel.ts/Channel");
    const fromBasket = folded.edges.filter((edge) => edge.from === "ts:packages%2Forder%2Fsrc%2Fbasket.ts/Basket").map((edge) => edge.to);
    expect(fromBasket).toContain("ts:packages%2Forder%2Fsrc%2Fbasket.ts/Line");
    expect(fromBasket).toContain("ts:<lib>/Array");
  });
});
