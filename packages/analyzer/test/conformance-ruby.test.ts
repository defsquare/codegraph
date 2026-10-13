import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import { loadModels } from "../src/load.js";
import { typeDependencyGraph } from "../src/queries.js";
import { rubyFixture, rubyGraph } from "./fixture.js";

const LIB = "rb:lib%2Facme_order%2F";
const ORDER = `${LIB}order.rb/AcmeOrder::Order`;

/**
 * The acceptance gate over the FIFTH real extractor's output (PLAN §19.6):
 * every invariant the Java, Roslyn, compiler-API and Elixir snapshots pass,
 * the Prism snapshot passes too — closure, no self-reference, provenance,
 * profile, anchors, ids — and the analyzer's queries read it without knowing
 * which language wrote it: module = file, a class or a module = a type, a
 * mixin an edge kind it has only ever met in a PHP profile.
 */
describe("checkConformance on the committed Ruby snapshot", () => {
  const report = checkConformance(loadModels(rubyFixture(), { sources: ["fixtures/ruby"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
  });
});

describe("the analyzer over the Ruby snapshot", () => {
  it("builds a graph whose containment reaches every entity from its file", () => {
    const graph = rubyGraph();
    const entities = [...graph.entities.values()];
    expect(entities.length).toBeGreaterThan(140);
    const roots = entities.filter((e) => graph.parentOf(e.id) === undefined);
    // Only files stand without a parent — every type, method, field, constant and parameter hangs below one.
    for (const root of roots) expect(root.kind, root.id).toBe("file");
  });

  it("folds every edge kind to the type level, mixins and derived calls included", () => {
    const folded = typeDependencyGraph(rubyGraph());
    const ids = new Set(folded.nodes.map((node) => node.id));
    expect(ids.has(ORDER)).toBe(true);
    expect(ids.has("rb:<ruby>/StandardError")).toBe(true);
    const fromOrder = folded.edges.filter((edge) => edge.from === ORDER).map((edge) => edge.to);
    // The superclass and the mixin (`traitUsage`)…
    expect(fromOrder).toContain(`${LIB}base.rb/AcmeOrder::Base`);
    expect(fromOrder).toContain(`${LIB}priceable.rb/AcmeOrder::Priceable`);
    expect(fromOrder).toContain("rb:<gems>/Forwardable");
    // …a method's call, a `raise`, and a call typed by what `@pricing` is assigned fold to the class.
    expect(fromOrder).toContain(`${LIB}money.rb/AcmeOrder::Money`);
    expect(fromOrder).toContain(`${LIB}errors.rb/AcmeOrder::TooManyLines`);
    expect(fromOrder).toContain(`${LIB}pricing%2Fstandard.rb/AcmeOrder::Pricing::Standard`);
    // A class-body call attributed to its library ancestor folds to the class too.
    const fromRecord = folded.edges
      .filter((edge) => edge.from === `${LIB}record.rb/AcmeOrder::Record`)
      .map((edge) => edge.to);
    expect(fromRecord).toContain("rb:<gems>/ActiveRecord::Base");
  });
});
