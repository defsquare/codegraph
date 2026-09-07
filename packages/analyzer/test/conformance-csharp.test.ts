import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import { loadModels } from "../src/load.js";
import { typeDependencyGraph } from "../src/queries.js";
import { csharpFixture, csharpGraph } from "./fixture.js";

/**
 * The acceptance gate over the SECOND real extractor's output (PLAN §13.6):
 * every invariant the Java snapshot passes, the Roslyn snapshot passes too —
 * closure, no self-reference, provenance, profile, anchors, ids — and the
 * analyzer's queries read it without knowing which language wrote it.
 */
describe("checkConformance on the committed Roslyn snapshot", () => {
  const report = checkConformance(loadModels(csharpFixture(), { sources: ["fixtures/csharp"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
  });
});

describe("the analyzer over the Roslyn snapshot", () => {
  it("builds a graph whose containment reaches every entity from its namespace", () => {
    const graph = csharpGraph();
    const entities = [...graph.entities.values()];
    expect(entities.length).toBeGreaterThan(200);
    const roots = entities.filter((e) => graph.parentOf(e.id) === undefined);
    // Only modules stand without a parent — every type, member, local and lambda hangs below one.
    for (const root of roots) expect(root.kind, root.id).toBe("namespace");
  });

  it("folds every edge kind to the type level, C# members included", () => {
    const folded = typeDependencyGraph(csharpGraph());
    const ids = new Set(folded.nodes.map((node) => node.id));
    expect(ids.has("csharp:Acme.Order/OrderService")).toBe(true);
    expect(ids.has("csharp:Acme.Order/Repository`1")).toBe(true);
    // A property accessor's call and a lambda's access fold to their type like a method's.
    const fromBasket = folded.edges.filter((edge) => edge.from === "csharp:Acme.Order/Basket").map((edge) => edge.to);
    expect(fromBasket).toContain("csharp:System.Linq/Enumerable");
    expect(fromBasket).toContain("csharp:Acme.Order/Basket.Line");
    // An extension method's call site folds to the static host, not the extended type.
    const fromExtensions = folded.edges.filter((edge) => edge.from === "csharp:Acme.Order.Extensions/MoneyExtensions").map((edge) => edge.to);
    expect(fromExtensions).toContain("csharp:Acme.Order/Money");
  });
});
