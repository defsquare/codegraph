import { isStubEntity } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import {
  composeViews,
  declaredOnly,
  identityView,
  includesEdge,
  internalOnly,
  projectView,
  provenanceOnly,
} from "../src/views.js";
import { javaGraph } from "./fixture.js";

describe("views", () => {
  const graph = javaGraph();

  it("the identity view keeps everything", () => {
    const projection = projectView(graph, identityView);
    expect(projection.entities).toHaveLength(164);
    expect(projection.edges).toHaveLength(173);
    expect(projection.view).toEqual({ name: "all", filters: [] });
  });

  it("internalOnly drops stubs and every edge touching one", () => {
    const projection = projectView(graph, internalOnly);
    expect(projection.entities).toHaveLength(164 - 24);
    expect(projection.entities.every((entity) => !isStubEntity(entity))).toBe(true);
    for (const edge of projection.edges) {
      expect(graph.isStub(edge.from)).toBe(false);
      expect(graph.isStub(edge.to)).toBe(false);
    }
    expect(projection.edges.length).toBeLessThan(173);
    expect(projection.view.name).toBe("internalOnly");
  });

  it("declaredOnly keeps facts and drops inferences", () => {
    const projection = projectView(graph, declaredOnly);
    expect(projection.edges.every((edge) => edge.provenance === "declared")).toBe(true);
    // The Java module -> module import edges are the extractor's inference.
    expect(projection.edges).toHaveLength(171);
    expect(
      projection.edges.some(
        (edge) => edge.from === "java:com.acme.order" && edge.to === "java:com.megacorp.ledger",
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === "java:com.acme.order" &&
          edge.to === "java:com.megacorp.ledger" &&
          edge.provenance === "derived",
      ),
    ).toBe(true);
  });

  it("composes, recording the whole trail in the descriptor", () => {
    const view = composeViews(internalOnly, declaredOnly);
    expect(view.descriptor).toEqual({
      name: "internalOnly+declaredOnly",
      filters: ["internalOnly", "declaredOnly"],
    });
    const projection = projectView(graph, view);
    for (const edge of projection.edges) {
      expect(edge.provenance).toBe("declared");
      expect(graph.isStub(edge.from) || graph.isStub(edge.to)).toBe(false);
    }
    // Composition is a conjunction: never more than either half alone.
    expect(projection.edges.length).toBeLessThanOrEqual(projectView(graph, internalOnly).edges.length);
    expect(projection.edges.length).toBeLessThanOrEqual(projectView(graph, declaredOnly).edges.length);
  });

  it("is idempotent and order-independent up to the descriptor", () => {
    const once = projectView(graph, composeViews(internalOnly, declaredOnly)).edges;
    const twice = projectView(graph, composeViews(internalOnly, internalOnly, declaredOnly)).edges;
    const flipped = projectView(graph, composeViews(declaredOnly, internalOnly)).edges;
    expect(twice).toEqual(once);
    expect(flipped).toEqual(once);
  });

  it("provenanceOnly generalizes the facts-only filter", () => {
    const derived = projectView(graph, provenanceOnly("derived"));
    expect(derived.edges).toHaveLength(2);
    expect(derived.view.name).toBe("provenance:derived");
    const both = projectView(graph, provenanceOnly("declared", "derived"));
    expect(both.edges).toHaveLength(173);
  });

  it("excludes an edge whose endpoint the graph does not declare", () => {
    const dangling = {
      edge: "reference" as const,
      from: "java:com.acme.order/Order",
      to: "java:nowhere/Nothing",
      provenance: "declared" as const,
      anchor: { file: "x", span: [1, 1] as [number, number] },
    };
    expect(includesEdge(identityView, graph, dangling)).toBe(false);
  });

  it("builds a view without cloning or mutating the base model", () => {
    const before = JSON.stringify(graph.union.models[0]);
    projectView(graph, composeViews(internalOnly, declaredOnly));
    expect(JSON.stringify(graph.union.models[0])).toBe(before);
    expect(graph.edges).toHaveLength(173);
  });
});
