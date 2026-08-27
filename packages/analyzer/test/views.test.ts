import { isStubEntity } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { foldGraph } from "../src/fold.js";
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
    expect(projection.entities).toHaveLength(169);
    expect(projection.edges).toHaveLength(179);
    expect(projection.view).toEqual({ name: "all", filters: [] });
  });

  it("internalOnly drops stubs and every edge touching one", () => {
    const projection = projectView(graph, internalOnly);
    expect(projection.entities).toHaveLength(169 - 26);
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
    expect(projection.edges).toHaveLength(176);
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
    expect(derived.edges).toHaveLength(3);
    expect(derived.view.name).toBe("provenance:derived");
    const both = projectView(graph, provenanceOnly("declared", "derived"));
    expect(both.edges).toHaveLength(179);
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
    expect(graph.edges).toHaveLength(179);
  });
});

/**
 * The arithmetic of filtering, and the one bug that matters.
 *
 * A view is a PREDICATE PAIR (decision 3). The classic failure is an
 * accidental in-place filter: results then depend on the order analyses ran
 * in, which is the hardest class of bug to see in a report. Every test below
 * therefore checks what was removed EXACTLY, and that nothing was touched.
 */
describe("view arithmetic and purity", () => {
  const graph = javaGraph();
  const stubIds = graph.ids().filter((id) => graph.isStub(id));

  it("internalOnly removes exactly the 26 stubs — no more, no fewer", () => {
    expect(stubIds).toHaveLength(26);
    const kept = new Set(projectView(graph, internalOnly).entities.map((e) => e.id));
    const removed = graph.ids().filter((id) => !kept.has(id));
    // Set equality, not just a count: a filter that dropped the right NUMBER of
    // the wrong entities would pass a length assertion.
    expect(removed.sort()).toEqual([...stubIds].sort());
  });

  it("internalOnly removes exactly the edges touching a stub", () => {
    const stubs = new Set(stubIds);
    const touching = graph.edges.filter((e) => stubs.has(e.from) || stubs.has(e.to));
    expect(touching).toHaveLength(78);
    const kept = projectView(graph, internalOnly).edges;
    expect(kept).toHaveLength(179 - touching.length);
    expect(kept.some((e) => touching.includes(e))).toBe(false);
    // Membership is the entity's own isStub flag, never a name or package
    // prefix (CLAUDE.md invariant 6): `java:com.acme.order/Invoice` looks
    // internal and is a stub, while `java:com.acme.order.legacy/List` looks
    // like a JDK type and is corpus-declared.
    expect(stubIds).toContain("java:com.acme.order/Invoice");
    expect(stubIds).not.toContain("java:com.acme.order.legacy/List");
  });

  it("declaredOnly drops exactly the derived edges", () => {
    const derived = graph.edges.filter((e) => e.provenance !== "declared");
    expect(derived).toHaveLength(3);
    expect(derived.map((e) => [e.edge, e.from, e.to, e.provenance])).toEqual([
      ["import", "java:com.acme.order", "java:com.megacorp.ledger", "derived"],
      ["import", "java:com.acme.order", "java:com.megacorp.ledger", "derived"],
      ["import", "java:com.acme.order.adapter", "java:com.megacorp.ledger", "derived"],
    ]);
    const kept = projectView(graph, declaredOnly).edges;
    expect(kept).toHaveLength(176);
    for (const inferred of derived) expect(kept).not.toContain(inferred);
    // Entities are untouched: declaredOnly filters edges only.
    expect(projectView(graph, declaredOnly).entities).toHaveLength(169);
  });

  it("composition is a conjunction, in any order and to any depth", () => {
    const orders = [
      composeViews(internalOnly, declaredOnly),
      composeViews(declaredOnly, internalOnly),
      composeViews(internalOnly, declaredOnly, internalOnly, declaredOnly),
      composeViews(composeViews(internalOnly, declaredOnly), internalOnly),
    ];
    const results = orders.map((view) => projectView(graph, view));
    for (const result of results) {
      expect(result.entities).toEqual(results[0]!.entities);
      expect(result.edges).toEqual(results[0]!.edges);
    }
    // Set intersection, computed independently of composeViews.
    const internalEdges = new Set(projectView(graph, internalOnly).edges);
    const declaredEdges = new Set(projectView(graph, declaredOnly).edges);
    const intersection = graph.edges.filter((e) => internalEdges.has(e) && declaredEdges.has(e));
    expect(results[0]!.edges).toEqual(intersection);
  });

  it("a projection SHARES the base entities — it is a view, not a clone", () => {
    const projection = projectView(graph, internalOnly);
    for (const entity of projection.entities) {
      // Object identity: a defensive copy here would double the memory of a
      // 15 000-entity corpus for nothing, and would let a later mutation
      // diverge silently from the model.
      expect(entity).toBe(graph.entity(entity.id));
    }
    for (const e of projection.edges) expect(graph.edges).toContain(e);
  });

  it("NO view mutates the base graph, whatever order they are built in", () => {
    const fresh = javaGraph();
    const before = JSON.stringify(fresh.union.models);
    const idsBefore = [...fresh.ids()];
    const edgesBefore = [...fresh.edges];

    for (const view of [
      internalOnly,
      declaredOnly,
      identityView,
      provenanceOnly("derived"),
      composeViews(declaredOnly, internalOnly),
      composeViews(internalOnly, declaredOnly),
    ]) {
      projectView(fresh, view);
      for (const level of ["type", "module"] as const) foldGraph(fresh, { level, view });
    }

    expect(JSON.stringify(fresh.union.models)).toBe(before);
    expect([...fresh.ids()]).toEqual(idsBefore);
    expect([...fresh.edges]).toEqual(edgesBefore);
    // And the untouched second graph still measures the same as the first.
    expect(projectView(fresh, identityView).edges).toHaveLength(179);
    expect(projectView(graph, identityView).edges).toHaveLength(179);
  });

  it("filtering is order-independent because it never consumes the base", () => {
    // Run the views in one order, then the reverse, on the SAME graph object.
    const first = projectView(graph, internalOnly).edges.length;
    projectView(graph, declaredOnly);
    projectView(graph, provenanceOnly("derived"));
    const again = projectView(graph, internalOnly).edges.length;
    expect(again).toBe(first);
  });
});
