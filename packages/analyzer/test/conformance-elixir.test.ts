import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import { loadModels } from "../src/load.js";
import { typeDependencyGraph } from "../src/queries.js";
import { elixirFixture, elixirGraph } from "./fixture.js";

/**
 * The acceptance gate over the FOURTH real extractor's output (PLAN §16.6):
 * every invariant the Java, Roslyn and compiler-API snapshots pass, the
 * parser-as-library snapshot passes too — closure, no self-reference,
 * provenance, profile, anchors, ids — and the analyzer's queries read it
 * without knowing which language wrote it, module = file, defmodule = type.
 */
describe("checkConformance on the committed Elixir snapshot", () => {
  const report = checkConformance(loadModels(elixirFixture(), { sources: ["fixtures/elixir"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
  });
});

describe("the analyzer over the Elixir snapshot", () => {
  it("builds a graph whose containment reaches every entity from its file", () => {
    const graph = elixirGraph();
    const entities = [...graph.entities.values()];
    expect(entities.length).toBeGreaterThan(150);
    const roots = entities.filter((e) => graph.parentOf(e.id) === undefined);
    // Only files stand without a parent — every module, function, field, attribute and parameter hangs below one.
    for (const root of roots) expect(root.kind, root.id).toBe("file");
  });

  it("folds every edge kind to the type level, a defmodule being the type", () => {
    const folded = typeDependencyGraph(elixirGraph());
    const ids = new Set(folded.nodes.map((node) => node.id));
    expect(ids.has("ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder")).toBe(true);
    expect(ids.has("ex:<otp>/GenServer")).toBe(true);
    // A function's call, a struct field's write and a `raise` fold to the enclosing module.
    const fromOrder = folded.edges
      .filter((edge) => edge.from === "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder")
      .map((edge) => edge.to);
    expect(fromOrder).toContain("ex:lib%2Facme_order%2Fmoney.ex/AcmeOrder%2EMoney");
    expect(fromOrder).toContain("ex:lib%2Facme_order%2Ferrors.ex/AcmeOrder%2EErrors%2ETooManyLines");
    expect(fromOrder).toContain("ex:<otp>/Enum");
    // A protocol call dispatches to the corpus impls: the candidates are visible at type level too.
    const fromReporting = folded.edges
      .filter((edge) => edge.from === "ex:lib%2Facme_order%2Freporting.ex/AcmeOrder%2EReporting")
      .map((edge) => edge.to);
    expect(fromReporting).toContain("ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable");
  });
});
