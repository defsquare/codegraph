import { describe, expect, it } from "vitest";
import { buildGraph, compareEdges, entityName, entityParent } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

const ORDER_SERVICE = "java:com.acme.order/OrderService";
const ORDER = "java:com.acme.order/Order";
const ABSTRACT_ORDER = "java:com.acme.order/AbstractOrder";
const ABSTRACT_ORDER_REFERENCE = "java:com.acme.order/AbstractOrder.reference()";
const PACKAGE = "java:com.acme.order";
const STRING = "java:java.lang/String";

describe("buildGraph over the committed Java snapshot", () => {
  const graph = javaGraph();

  it("indexes every declared entity, stubs included", () => {
    expect(graph.entities.size).toBe(169);
    expect(graph.ids()).toHaveLength(169);
    expect(graph.has(STRING)).toBe(true);
    expect(graph.isStub(STRING)).toBe(true);
    expect(graph.isStub(ORDER)).toBe(false);
  });

  it("returns ids in a deterministic sorted order", () => {
    const ids = [...graph.ids()];
    expect(ids).toEqual([...ids].sort());
    expect(javaGraph().ids()).toEqual(graph.ids());
  });

  it("reads containment through the trait key, never by parsing an id", () => {
    expect(graph.parentOf(ORDER)).toBe(PACKAGE);
    expect(graph.parentOf(PACKAGE)).toBeUndefined();
    // A stub has no children, and a parent only when its module is itself
    // external — which is how the analyzer reaches it without parsing the id.
    expect(graph.parentOf(STRING)).toBe("java:java.lang");
    expect(graph.childrenOf(STRING)).toEqual([]);
  });

  /**
   * MM-2: `children` is not in the model at all, so the index can only come from
   * `parent`. What it must equal is therefore stated the only way left — the
   * entities that claim this one as their parent.
   */
  it("derives children as exactly the entities claiming the parent", () => {
    const pkgEntity = graph.entity(PACKAGE);
    expect(pkgEntity).toBeDefined();
    expect(pkgEntity).not.toHaveProperty("children");
    const claiming = graph
      .ids()
      .filter((id) => entityParent(graph.entity(id)!) === PACKAGE)
      .sort();
    expect(graph.childrenOf(PACKAGE)).toEqual(claiming);
    expect(claiming.length).toBeGreaterThan(0);
    expect(entityName(pkgEntity!)).toBe("com.acme.order");
    expect(entityParent(pkgEntity!)).toBeUndefined();
  });

  it("splits outgoing edges by kind without rescanning the model", () => {
    const outgoing = graph.outgoing(PACKAGE);
    expect(outgoing.length).toBeGreaterThan(0);
    expect(graph.outgoingOfKind(PACKAGE, "import")).toEqual(
      outgoing.filter((e) => e.edge === "import"),
    );
  });

  it("derives inverse indexes the model never stores", () => {
    // Inheritance is stored subtype -> supertype; subtypesOf is the inverse.
    expect(graph.subtypesOf(ABSTRACT_ORDER)).toContain(ORDER);
    expect(graph.callersOf(ABSTRACT_ORDER_REFERENCE)).toHaveLength(6);

    // Every derived index agrees with a brute-force scan of the stored edges.
    for (const id of graph.ids()) {
      const scanned = [
        ...new Set(graph.edges.filter((e) => e.edge === "invocation" && e.to === id).map((e) => e.from)),
      ].sort();
      expect(graph.callersOf(id)).toEqual(scanned);
    }
  });

  it("keeps derived indexes sorted, distinct and frozen", () => {
    for (const id of graph.ids()) {
      for (const list of [
        graph.callersOf(id),
        graph.accessorsOf(id),
        graph.subtypesOf(id),
        graph.implementersOf(id),
        graph.importersOf(id),
        graph.childrenOf(id),
      ]) {
        expect([...list]).toEqual([...new Set(list)].sort());
        expect(Object.isFrozen(list)).toBe(true);
      }
    }
  });

  it("answers unknown ids with empty results rather than throwing", () => {
    expect(graph.entity("java:nope")).toBeUndefined();
    expect(graph.outgoing("java:nope")).toEqual([]);
    expect(graph.callersOf("java:nope")).toEqual([]);
    expect(graph.isStub("java:nope")).toBe(false);
  });

  it("never mutates the union it indexes", () => {
    const before = JSON.stringify(graph.union.models[0]);
    graph.callersOf(ORDER_SERVICE);
    graph.childrenOf(PACKAGE);
    expect(JSON.stringify(graph.union.models[0])).toBe(before);
  });
});

describe("buildGraph edge cases", () => {
  it("keeps the first declaration when an id is declared twice", () => {
    const first = type("java:p/C", "java:p", ["java:p/C.m()"]);
    const second = type("java:p/C", "java:p", []);
    const graph = buildGraph(
      loadModels([
        toyModel([pkg("java:p", ["java:p/C"]), first, method("java:p/C.m()", "java:p/C")], []),
        toyModel([second], []),
      ]).union,
    );
    // The first declaration wins, and the derived index still finds the member.
    expect(graph.entity("java:p/C")).toEqual(first);
    expect(graph.childrenOf("java:p/C")).toEqual(["java:p/C.m()"]);
  });

  it("orders edges deterministically with compareEdges", () => {
    const a = edge("invocation", "java:p/A", "java:p/B");
    const b = edge("reference", "java:p/A", "java:p/B");
    const c = edge("invocation", "java:p/B", "java:p/A");
    const sorted = [c, b, a].sort(compareEdges);
    expect(sorted).toEqual([a, b, c]);
  });
});
