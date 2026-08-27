import { describe, expect, it } from "vitest";
import {
  containingModule,
  containingType,
  createFolder,
  foldGraph,
  folderFor,
} from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { composeViews, declaredOnly, identityView, internalOnly } from "../src/views.js";
import { edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

const PACKAGE = "java:com.acme.order";
const ORDER = "java:com.acme.order/Order";
const ORDER_DISCOUNT = "java:com.acme.order/Order.discount(int)";
const STRING = "java:java.lang/String";
const LEDGER_PKG = "java:com.megacorp.ledger";

describe("containment folding over the committed Java snapshot", () => {
  const graph = javaGraph();

  it("folds a method onto its class and a class onto its package", () => {
    expect(graph.entity(ORDER_DISCOUNT)).toBeDefined();
    expect(containingType(graph, ORDER_DISCOUNT)).toBe(ORDER);
    expect(containingModule(graph, ORDER_DISCOUNT)).toBe(PACKAGE);
    expect(containingModule(graph, ORDER)).toBe(PACKAGE);
  });

  it("folds an entity carrying the level's trait onto itself", () => {
    expect(containingType(graph, ORDER)).toBe(ORDER);
    expect(containingModule(graph, PACKAGE)).toBe(PACKAGE);
  });

  it("folds a nested entity all the way up the parent chain", () => {
    // Parameters and locals are two levels below the class, lambdas below a method.
    const nested = graph
      .ids()
      .filter((id) => ["parameter", "localVariable", "lambda"].includes(graph.entity(id)!.kind));
    expect(nested.length).toBeGreaterThan(0);
    for (const id of nested) {
      const type = containingType(graph, id);
      expect(type).toBeDefined();
      expect(graph.entity(type!)!.traits).toContain("TType");
      const module = containingModule(graph, id);
      expect(graph.entity(module!)!.traits).toContain("TModule");
    }
  });

  it("places an external type in its external module, and never in a corpus one", () => {
    // A stub type IS its own containing type — it is a type. Its MODULE is
    // reached by walking `parent`, which the extractor supplies precisely so the
    // analyzer never has to parse an id to find it (CLAUDE.md 7).
    expect(containingType(graph, STRING)).toBe(STRING);
    expect(graph.parentOf(STRING)).toBe("java:java.lang");
    expect(containingModule(graph, STRING)).toBe("java:java.lang");

    // A stub package is a module in its own right, but is NOT a type: folding it
    // onto itself at type level is what once put modules into type graphs.
    expect(containingModule(graph, LEDGER_PKG)).toBe(LEDGER_PKG);
    expect(containingType(graph, LEDGER_PKG)).toBeUndefined();
    expect(graph.isStub(LEDGER_PKG)).toBe(true);
  });

  it("leaves a type unplaceable rather than attributing it to a corpus module", () => {
    // `Invoice` is a Spoon fabrication inside the corpus's OWN package, so the
    // extractor withholds a parent (PLAN.md §5.2). It must stay out of the module
    // graph entirely — attributing it would invent a corpus self-dependency.
    const INVOICE = "java:com.acme.order/Invoice";
    expect(graph.isStub(INVOICE)).toBe(true);
    expect(graph.parentOf(INVOICE)).toBeUndefined();
    expect(containingType(graph, INVOICE)).toBe(INVOICE);
    expect(containingModule(graph, INVOICE)).toBeUndefined();
  });

  it("reports no containing type for a non-stub module", () => {
    expect(containingType(graph, PACKAGE)).toBeUndefined();
  });

  it("returns undefined for an unknown id instead of crashing", () => {
    expect(containingType(graph, "java:nope")).toBeUndefined();
    expect(containingModule(graph, "java:nope")).toBeUndefined();
  });

  it("memoizes: the folder is reused per graph and agrees with a fresh one", () => {
    expect(folderFor(graph)).toBe(folderFor(graph));
    const fresh = createFolder(graph);
    for (const id of graph.ids()) {
      expect(fresh.containingType(id)).toBe(containingType(graph, id));
      expect(fresh.containingModule(id)).toBe(containingModule(graph, id));
    }
  });
});

describe("containment folding edge cases", () => {
  it("survives a malformed parent cycle without hanging", () => {
    const a = { ...method("java:p/A.m()", "java:p/B.m()") };
    const b = { ...method("java:p/B.m()", "java:p/A.m()") };
    const graph = buildGraph(loadModels(toyModel([a, b], [])).union);
    expect(containingType(graph, "java:p/A.m()")).toBeUndefined();
    expect(containingModule(graph, "java:p/B.m()")).toBeUndefined();
  });

  it("stops at a dangling parent (a closure diagnostic, not a crash)", () => {
    const graph = buildGraph(loadModels(toyModel([method("java:p/C.m()", "java:p/C")], [])).union);
    expect(containingType(graph, "java:p/C.m()")).toBeUndefined();
  });
});

describe("foldGraph", () => {
  const graph = javaGraph();

  it("aggregates parallel edges into one weighted edge that keeps what it folded", () => {
    const folded = foldGraph(graph, { level: "type" });
    expect(folded.level).toBe("type");
    expect(folded.view).toEqual({ name: "all", filters: [] });

    // Nothing is lost: the aggregated weights account for every folded edge.
    const total = folded.edges.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(folded.diagnostics.foldedEdges);
    expect(total + folded.diagnostics.droppedEdges).toBe(179);

    // Aggregation is real on this fixture: some pair carries more than one edge.
    expect(folded.edges.some((e) => e.count > 1)).toBe(true);
    const multi = folded.edges.find((e) => e.kinds.size > 1);
    expect(multi).toBeDefined();
  });

  it("keeps folding-induced self-loops, flagged", () => {
    const folded = foldGraph(graph, { level: "type" });
    const loops = folded.edges.filter((e) => e.selfLoop);
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop.from).toBe(loop.to);

    // They are the fold's doing, not a forbidden self-edge in the stored model.
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);

    const without = foldGraph(graph, { level: "type", dropSelfLoops: true });
    expect(without.edges.some((e) => e.selfLoop)).toBe(false);
    expect(without.edges.length).toBe(folded.edges.length - loops.length);
  });

  it("counts members and carries node metadata for renderers", () => {
    const folded = foldGraph(graph, { level: "module" });
    const node = folded.node(PACKAGE);
    expect(node).toEqual({
      id: PACKAGE,
      kind: "package",
      name: "com.acme.order",
      isStub: false,
      members: expect.any(Number),
    });
    expect(node!.members).toBeGreaterThan(1);
    const stubNode = folded.node(LEDGER_PKG);
    expect(stubNode?.isStub).toBe(true);
    // Every entity is either a member of exactly one node or reported unfoldable.
    const members = folded.nodes.reduce((sum, n) => sum + n.members, 0);
    expect(members + folded.diagnostics.unfoldableEntities.length).toBe(169);
  });

  it("is deterministic: nodes and edges are sorted, and two runs agree", () => {
    const a = foldGraph(graph, { level: "type" });
    const b = foldGraph(javaGraph(), { level: "type" });
    expect(a.nodes.map((n) => n.id)).toEqual([...a.nodes.map((n) => n.id)].sort());
    expect(a.edges.map((e) => `${e.from} ${e.to}`)).toEqual(
      [...a.edges.map((e) => `${e.from} ${e.to}`)].sort(),
    );
    expect(JSON.stringify(b.edges.map((e) => [e.from, e.to, e.count]))).toBe(
      JSON.stringify(a.edges.map((e) => [e.from, e.to, e.count])),
    );
  });

  it("restricts to the requested edge kinds — the module import layer", () => {
    const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
    expect(folded.edges.every((e) => e.kinds.size === 1 && e.kinds.has("import"))).toBe(true);
    expect(folded.edges.reduce((sum, e) => sum + e.count, 0)).toBe(11);
    // Import edges are already module -> module, so folding them is the identity.
    const raw = graph.edges.filter((e) => e.edge === "import");
    for (const e of raw) {
      expect(folded.edges.some((f) => f.from === e.from && f.to === e.to)).toBe(true);
    }
    expect(
      folded.edges.find((e) => e.from === PACKAGE && e.to === LEDGER_PKG)?.provenances.has("derived"),
    ).toBe(true);
  });

  it("honours the view: internalOnly drops stubs from nodes and edges", () => {
    const folded = foldGraph(graph, { level: "type", view: internalOnly });
    expect(folded.view.name).toBe("internalOnly");
    expect(folded.nodes.every((n) => !n.isStub)).toBe(true);
    for (const e of folded.edges) {
      expect(graph.isStub(e.from)).toBe(false);
      expect(graph.isStub(e.to)).toBe(false);
    }
  });

  it("honours a composed view and states it in the result", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const folded = foldGraph(graph, { level: "module", view });
    expect(folded.view).toEqual({
      name: "internalOnly+declaredOnly",
      filters: ["internalOnly", "declaredOnly"],
    });
    for (const e of folded.edges) expect([...e.provenances]).toEqual(["declared"]);
  });

  it("reports entities with no container instead of dropping them silently", () => {
    // A package has no containing TYPE: expected, reported, never a crash.
    const folded = foldGraph(graph, { level: "type", view: identityView });
    expect(folded.diagnostics.unfoldableEntities).toContain(PACKAGE);
    expect(folded.diagnostics.unfoldableEntities).toEqual(
      [...folded.diagnostics.unfoldableEntities].sort(),
    );
  });

  it("drops an edge whose endpoint has no container and counts it", () => {
    const model = toyModel(
      [pkg("java:p", ["java:p/C"]), type("java:p/C", "java:p", ["java:p/C.m()"]), method("java:p/C.m()", "java:p/C")],
      [edge("invocation", "java:p/C.m()", "java:p")],
    );
    const graphWithPackageTarget = buildGraph(loadModels(model).union);
    const folded = foldGraph(graphWithPackageTarget, { level: "type" });
    expect(folded.edges).toHaveLength(0);
    expect(folded.diagnostics.droppedEdges).toBe(1);
    expect(folded.diagnostics.unfoldableEntities).toEqual(["java:p"]);
  });

  it("folds a whole toy corpus to the pairs a reader would draw by hand", () => {
    const model = toyModel(
      [
        pkg("java:a", ["java:a/A"]),
        pkg("java:b", ["java:b/B"]),
        type("java:a/A", "java:a", ["java:a/A.one()", "java:a/A.two()"]),
        type("java:b/B", "java:b", ["java:b/B.run()"]),
        method("java:a/A.one()", "java:a/A"),
        method("java:a/A.two()", "java:a/A"),
        method("java:b/B.run()", "java:b/B"),
      ],
      [
        edge("invocation", "java:a/A.one()", "java:b/B.run()"),
        edge("invocation", "java:a/A.two()", "java:b/B.run()"),
        edge("reference", "java:a/A.one()", "java:b/B", "derived"),
        edge("invocation", "java:a/A.one()", "java:a/A.two()"),
      ],
    );
    const graphToy = buildGraph(loadModels(model).union);

    const types = foldGraph(graphToy, { level: "type" });
    expect(types.edges.map((e) => [e.from, e.to, e.count, e.selfLoop])).toEqual([
      ["java:a/A", "java:a/A", 1, true],
      ["java:a/A", "java:b/B", 3, false],
    ]);
    const aToB = types.edges[1]!;
    expect([...aToB.kinds].sort()).toEqual(["invocation", "reference"]);
    expect([...aToB.provenances].sort()).toEqual(["declared", "derived"]);

    const modules = foldGraph(graphToy, { level: "module" });
    expect(modules.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      ["java:a", "java:a", 1],
      ["java:a", "java:b", 3],
    ]);
  });
});

describe("folded endpoints survive exotic ids", () => {
  // Ids are OPAQUE strings (CLAUDE.md invariant 7): a space, a NUL or any other
  // byte is legal in one. Aggregation must therefore never pack a pair of ids
  // into a single string it later splits — the endpoints below are recovered
  // verbatim or the folded graph is quietly attributing edges to nodes that do
  // not exist.
  const EXOTIC = ["p/A B", "p/C\u0000D", "p/E\u0000 F G"] as const;

  it("keeps `from` and `to` byte-identical to the container ids", () => {
    const entities = [
      pkg("x:p", EXOTIC.map((suffix) => `x:${suffix}`)),
      ...EXOTIC.map((suffix) => type(`x:${suffix}`, "x:p", [`x:${suffix}.m()`])),
      ...EXOTIC.map((suffix) => method(`x:${suffix}.m()`, `x:${suffix}`)),
    ];
    const edges = [
      edge("invocation", `x:${EXOTIC[0]}.m()`, `x:${EXOTIC[1]}.m()`),
      edge("invocation", `x:${EXOTIC[1]}.m()`, `x:${EXOTIC[2]}.m()`),
      edge("reference", `x:${EXOTIC[2]}.m()`, `x:${EXOTIC[0]}`),
    ];
    const graph = buildGraph(loadModels(toyModel(entities, edges, "x")).union);
    const folded = foldGraph(graph, { level: "type" });

    expect(folded.nodes.map((node) => node.id)).toEqual(
      EXOTIC.map((suffix) => `x:${suffix}`).sort(),
    );
    expect(folded.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      [`x:${EXOTIC[0]}`, `x:${EXOTIC[1]}`, 1],
      [`x:${EXOTIC[1]}`, `x:${EXOTIC[2]}`, 1],
      [`x:${EXOTIC[2]}`, `x:${EXOTIC[0]}`, 1],
    ]);
    // Every endpoint is a declared node: no phantom was invented by splitting.
    for (const e of folded.edges) {
      expect(folded.node(e.from)).toBeDefined();
      expect(folded.node(e.to)).toBeDefined();
    }
  });
});
