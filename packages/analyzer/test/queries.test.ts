import { describe, expect, it } from "vitest";
import { foldGraph } from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import {
  dependenciesOf,
  dependentsOf,
  importGraph,
  neighboursOf,
  typeDependencyGraph,
} from "../src/queries.js";
import { composeViews, declaredOnly, identityView, internalOnly } from "../src/views.js";
import { edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

const ORDER_PKG = "java:com.acme.order";
const ADAPTER_PKG = "java:com.acme.order.adapter";
const LEGACY_PKG = "java:com.acme.order.legacy";
const LEDGER_PKG = "java:com.megacorp.ledger";
const JAVA_UTIL = "java:java.util";
const JAVA_TIME = "java:java.time";
const JAVA_ANNOTATION = "java:java.lang.annotation";
const JAVA_FUNCTION = "java:java.util.function";

const MONEY = "java:com.acme.order/Money";
const ORDER = "java:com.acme.order/Order";
const ORDER_SERVICE = "java:com.acme.order/OrderService";
const BATCH = "java:com.acme.order/Batch";
const LEDGER_CLIENT = "java:com.megacorp.ledger/LedgerClient";
const ORDER_DISCOUNT = "java:com.acme.order/Order.discount(int)";

/**
 * The import layer is the one comparable across every language (CLAUDE.md
 * invariant 9), so it is asserted against the committed snapshot edge by edge,
 * not against a toy.
 */
describe("importGraph over the committed Java snapshot", () => {
  const graph = javaGraph();

  it("is the module→module graph and says so", () => {
    const folded = importGraph(graph);
    expect(folded.level).toBe("module");
    expect(folded.view).toEqual({ name: "all", filters: [] });
  });

  it("aggregates the corpus's 11 import edges into the 6 module pairs", () => {
    const folded = importGraph(graph);
    expect(folded.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      [ORDER_PKG, LEDGER_PKG, 2],
      [ORDER_PKG, JAVA_ANNOTATION, 2],
      [ORDER_PKG, JAVA_TIME, 1],
      [ORDER_PKG, JAVA_UTIL, 4],
      [ORDER_PKG, JAVA_FUNCTION, 1],
      [ADAPTER_PKG, LEDGER_PKG, 1],
    ]);
    expect(folded.edges.reduce((sum, e) => sum + e.count, 0)).toBe(11);
    expect(folded.edges.every((e) => [...e.kinds].join() === "import")).toBe(true);
  });

  it("keeps the derived module→module inference distinguishable from the facts", () => {
    const folded = importGraph(graph);
    const inferred = folded.edges.find((e) => e.from === ORDER_PKG && e.to === LEDGER_PKG);
    // The source declares a TYPE import; the module→module edge is the
    // extractor's inference (CLAUDE.md invariant 2). Equating the two lies.
    expect([...inferred!.provenances]).toEqual(["derived"]);
    const fact = folded.edges.find((e) => e.from === ORDER_PKG && e.to === JAVA_UTIL);
    expect([...fact!.provenances]).toEqual(["declared"]);
  });

  it("keeps stub modules: an import of an external module is a real dependency", () => {
    const folded = importGraph(graph);
    for (const external of [LEDGER_PKG, JAVA_UTIL, JAVA_TIME, JAVA_ANNOTATION, JAVA_FUNCTION]) {
      expect(folded.node(external)?.isStub).toBe(true);
    }
    // Dropping them would understate com.acme.order's efferent coupling by 5.
    expect(dependenciesOf(folded, ORDER_PKG)).toEqual([
      LEDGER_PKG,
      JAVA_ANNOTATION,
      JAVA_TIME,
      JAVA_UTIL,
      JAVA_FUNCTION,
    ]);
  });

  it("has no non-module endpoint to fold in a conforming model", () => {
    const folded = importGraph(graph);
    expect(folded.importDiagnostics.importEdges).toBe(11);
    expect(folded.importDiagnostics.nonModuleEndpoints).toEqual([]);
  });

  it("honours declaredOnly: the two derived module edges disappear", () => {
    const folded = importGraph(graph, declaredOnly);
    expect(folded.view.name).toBe("declaredOnly");
    expect(folded.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      [ORDER_PKG, JAVA_ANNOTATION, 2],
      [ORDER_PKG, JAVA_TIME, 1],
      [ORDER_PKG, JAVA_UTIL, 4],
      [ORDER_PKG, JAVA_FUNCTION, 1],
    ]);
    expect(folded.edges.reduce((sum, e) => sum + e.count, 0)).toBe(8);
    expect(folded.importDiagnostics.importEdges).toBe(8);
  });

  it("honours internalOnly: every import in this corpus leaves the corpus", () => {
    const folded = importGraph(graph, internalOnly);
    expect(folded.nodes.map((n) => n.id)).toEqual([ORDER_PKG, ADAPTER_PKG, LEGACY_PKG]);
    expect(folded.nodes.every((n) => !n.isStub)).toBe(true);
    // Honest, not empty by accident: all 10 imports target an external module.
    expect(folded.edges).toEqual([]);
    expect(folded.importDiagnostics.importEdges).toBe(0);
  });

  it("composes views and records the whole composition trail", () => {
    const folded = importGraph(graph, composeViews(internalOnly, declaredOnly));
    expect(folded.view).toEqual({
      name: "internalOnly+declaredOnly",
      filters: ["internalOnly", "declaredOnly"],
    });
  });

  it("is deterministic across runs and does not mutate the graph", () => {
    const before = JSON.stringify(graph.union.edges);
    const a = importGraph(graph);
    const b = importGraph(javaGraph());
    expect(a.edges.map((e) => [e.from, e.to, e.count])).toEqual(
      b.edges.map((e) => [e.from, e.to, e.count]),
    );
    expect(a.edges.map((e) => `${e.from} ${e.to}`)).toEqual(
      [...a.edges.map((e) => `${e.from} ${e.to}`)].sort(),
    );
    expect(JSON.stringify(graph.union.edges)).toBe(before);
  });
});

describe("importGraph with a non-conforming import endpoint", () => {
  // An extractor may write an import between TYPES. Folding recovers the module
  // layer, and the fact that it had to is reported rather than hidden.
  const model = toyModel(
    [
      pkg("java:a", ["java:a/A"]),
      pkg("java:b", ["java:b/B"]),
      type("java:a/A", "java:a"),
      type("java:b/B", "java:b"),
    ],
    [edge("import", "java:a/A", "java:b/B")],
  );
  const graph = buildGraph(loadModels(model).union);

  it("folds both endpoints up to their modules", () => {
    const folded = importGraph(graph);
    expect(folded.edges.map((e) => [e.from, e.to, e.count])).toEqual([["java:a", "java:b", 1]]);
  });

  it("reports each non-module endpoint with what it was folded onto", () => {
    const folded = importGraph(graph);
    expect(folded.importDiagnostics.importEdges).toBe(1);
    expect(folded.importDiagnostics.nonModuleEndpoints).toEqual([
      {
        edgeFrom: "java:a/A",
        edgeTo: "java:b/B",
        role: "from",
        endpoint: "java:a/A",
        foldedTo: "java:a",
      },
      {
        edgeFrom: "java:a/A",
        edgeTo: "java:b/B",
        role: "to",
        endpoint: "java:b/B",
        foldedTo: "java:b",
      },
    ]);
  });
});

describe("typeDependencyGraph over the committed Java snapshot", () => {
  const graph = javaGraph();

  it("is the type-level graph and says so", () => {
    const folded = typeDependencyGraph(graph);
    expect(folded.level).toBe("type");
    expect(folded.view).toEqual({ name: "all", filters: [] });
  });

  it("folds all 188 edges: 177 aggregate into 78 pairs, 11 have no type", () => {
    const folded = typeDependencyGraph(graph);
    expect(folded.edges).toHaveLength(78);
    expect(folded.nodes).toHaveLength(39);
    const weight = folded.edges.reduce((sum, e) => sum + e.count, 0);
    expect(weight).toBe(177);
    expect(weight).toBe(folded.diagnostics.foldedEdges);
    // The 11 dropped edges are the module-level imports: a package has no
    // containing TYPE. Reported, never silently discarded.
    expect(folded.diagnostics.droppedEdges).toBe(11);
    expect(weight + folded.diagnostics.droppedEdges).toBe(188);
    // Packages have no containing TYPE — the corpus's three plus the seven
    // external modules external types now hang off. Reported, never hidden.
    expect(folded.diagnostics.unfoldableEntities).toEqual([
      "java:com.acme.order",
      "java:com.acme.order.adapter",
      "java:com.acme.order.legacy",
      "java:com.megacorp.ledger",
      "java:java.io",
      "java:java.lang",
      "java:java.lang.annotation",
      "java:java.time",
      "java:java.util",
      "java:java.util.function",
    ]);
  });

  it("contributes every edge kind, not just invocations", () => {
    const folded = typeDependencyGraph(graph);
    const kinds = new Set<string>();
    for (const e of folded.edges) for (const kind of e.kinds) kinds.add(kind);
    expect([...kinds].sort()).toEqual([
      "access",
      "annotationUse",
      "inheritance",
      "interfaceImplementation",
      "invocation",
      "reference",
      "throws",
    ]);
  });

  it("aggregates parallel edges and keeps what they were", () => {
    const folded = typeDependencyGraph(graph);
    const batchToMoney = folded.edges.find((e) => e.from === BATCH && e.to === MONEY);
    expect(batchToMoney?.count).toBe(7);
    expect([...batchToMoney!.kinds].sort()).toEqual(["invocation", "reference"]);
    // Aggregation must not collapse the provenance question away.
    expect([...batchToMoney!.provenances]).toEqual(["declared"]);
  });

  it("keeps folding-induced self-loops flagged rather than dropping them", () => {
    const folded = typeDependencyGraph(graph);
    const loops = folded.edges.filter((e) => e.selfLoop);
    expect(loops).toHaveLength(12);
    for (const loop of loops) expect(loop.from).toBe(loop.to);
    // Not the forbidden `from === to` of a stored edge.
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("matches an explicit foldGraph at the same level and view", () => {
    const expected = foldGraph(graph, { level: "type", view: identityView });
    const folded = typeDependencyGraph(graph);
    expect(folded.edges.map((e) => [e.from, e.to, e.count])).toEqual(
      expected.edges.map((e) => [e.from, e.to, e.count]),
    );
  });

  it("honours internalOnly by filtering, not by dropping data at load", () => {
    const folded = typeDependencyGraph(graph, internalOnly);
    expect(folded.nodes).toHaveLength(19);
    expect(folded.edges).toHaveLength(39);
    expect(folded.nodes.every((n) => !n.isStub)).toBe(true);
    for (const e of folded.edges) {
      expect(graph.isStub(e.from)).toBe(false);
      expect(graph.isStub(e.to)).toBe(false);
    }
    // The stub dependency still exists in the unfiltered graph.
    expect(dependenciesOf(typeDependencyGraph(graph), ORDER_SERVICE)).toContain(LEDGER_CLIENT);
    expect(dependenciesOf(folded, ORDER_SERVICE)).not.toContain(LEDGER_CLIENT);
  });
});

describe("dependenciesOf / dependentsOf", () => {
  const graph = javaGraph();
  const types = typeDependencyGraph(graph);

  it("returns the distinct targets of a node, sorted", () => {
    expect(dependenciesOf(types, ORDER_SERVICE)).toEqual([
      LEGACY_PKG + "/List",
      "java:com.acme.order/AbstractOrder",
      "java:com.acme.order/Invoice",
      ORDER,
      LEDGER_CLIENT,
      "java:java.util/List",
    ]);
  });

  it("returns the distinct sources depending on a node, sorted", () => {
    expect(dependentsOf(types, MONEY)).toEqual([
      "java:com.acme.order/AbstractOrder",
      BATCH,
      "java:com.acme.order/Channel",
      "java:com.acme.order/Discountable",
      "java:com.acme.order/Notifications",
      ORDER,
      "java:com.acme.order/Priceable",
    ]);
  });

  it("excludes the folding self-loop — a type is not its own dependency", () => {
    // OrderService->OrderService and Money->Money exist as flagged self-loops.
    expect(types.outgoing(ORDER_SERVICE).some((e) => e.selfLoop)).toBe(true);
    expect(dependenciesOf(types, ORDER_SERVICE)).not.toContain(ORDER_SERVICE);
    expect(types.incoming(MONEY).some((e) => e.selfLoop)).toBe(true);
    expect(dependentsOf(types, MONEY)).not.toContain(MONEY);
  });

  it("counts distinct nodes, not edge weights", () => {
    const money = dependentsOf(types, MONEY);
    const weight = types
      .incoming(MONEY)
      .filter((e) => !e.selfLoop)
      .reduce((sum, e) => sum + e.count, 0);
    // 7 distinct dependents carrying 18 base edges between them: fanIn is the
    // node count, not the weight — the two get confused constantly.
    expect(money.length).toBe(7);
    expect(weight).toBe(18);
  });

  it("returns nothing for a node the folded graph does not contain", () => {
    expect(dependenciesOf(types, "java:nope")).toEqual([]);
    expect(dependentsOf(types, "java:nope")).toEqual([]);
  });

  it("works on the import graph too — the same shape at module level", () => {
    const imports = importGraph(graph);
    expect(dependentsOf(imports, LEDGER_PKG)).toEqual([ORDER_PKG, ADAPTER_PKG]);
    expect(dependenciesOf(imports, LEGACY_PKG)).toEqual([]);
  });
});

describe("neighboursOf — METAMODEL §9 derived concepts, in memory only", () => {
  const graph = javaGraph();

  it("reads the graph's derived inverse indexes for a real entity", () => {
    const money = neighboursOf(graph, MONEY);
    expect(money.exists).toBe(true);
    expect(money.parent).toBe(ORDER_PKG);
    expect(money.children.length).toBeGreaterThan(0);
    expect(money.callers).toEqual(graph.callersOf(MONEY));
    expect(money.accessors).toEqual(graph.accessorsOf(MONEY));
    expect(money.subtypes).toEqual(graph.subtypesOf(MONEY));
    expect(money.implementers).toEqual(graph.implementersOf(MONEY));
    expect(money.importers).toEqual(graph.importersOf(MONEY));
  });

  it("finds the importers of an external module", () => {
    expect(neighboursOf(graph, LEDGER_PKG).importers).toEqual([ORDER_PKG, ADAPTER_PKG]);
    expect(neighboursOf(graph, JAVA_UTIL).importers).toEqual([ORDER_PKG]);
  });

  it("finds callers of a method and implementers of an interface", () => {
    const discount = neighboursOf(graph, ORDER_DISCOUNT);
    expect(discount.exists).toBe(true);
    const implemented = graph
      .ids()
      .filter((id) => graph.implementersOf(id).length > 0)
      .map((id) => neighboursOf(graph, id));
    expect(implemented.length).toBeGreaterThan(0);
    for (const n of implemented) {
      for (const implementer of n.implementers) expect(graph.has(implementer)).toBe(true);
    }
  });

  it("is sorted and free of duplicates on every axis", () => {
    for (const id of graph.ids()) {
      const n = neighboursOf(graph, id);
      for (const list of [n.children, n.callers, n.accessors, n.subtypes, n.implementers, n.importers]) {
        expect(list).toEqual([...new Set(list)].sort());
      }
    }
  });

  it("reports an unknown id as absent instead of crashing", () => {
    const missing = neighboursOf(graph, "java:nope");
    expect(missing).toEqual({
      id: "java:nope",
      exists: false,
      parent: undefined,
      children: [],
      callers: [],
      accessors: [],
      subtypes: [],
      implementers: [],
      importers: [],
    });
  });
});

describe("queries on a hand-built corpus", () => {
  const model = toyModel(
    [
      pkg("java:a", ["java:a/A"]),
      pkg("java:b", ["java:b/B"]),
      pkg("java:ext", [], true),
      type("java:a/A", "java:a", ["java:a/A.one()"]),
      type("java:b/B", "java:b", ["java:b/B.run()"]),
      method("java:a/A.one()", "java:a/A"),
      method("java:b/B.run()", "java:b/B"),
    ],
    [
      edge("import", "java:a", "java:b"),
      edge("import", "java:a", "java:ext", "derived"),
      edge("invocation", "java:a/A.one()", "java:b/B.run()"),
      edge("reference", "java:a/A.one()", "java:b/B", "derived"),
    ],
  );
  const graph = buildGraph(loadModels(model).union);

  it("builds the import layer from import edges only", () => {
    const imports = importGraph(graph);
    expect(imports.edges.map((e) => [e.from, e.to, e.count, [...e.provenances]])).toEqual([
      ["java:a", "java:b", 1, ["declared"]],
      ["java:a", "java:ext", 1, ["derived"]],
    ]);
    expect(dependenciesOf(imports, "java:a")).toEqual(["java:b", "java:ext"]);
  });

  it("builds the type layer from every other kind as well", () => {
    const types = typeDependencyGraph(graph);
    expect(types.edges.map((e) => [e.from, e.to, e.count])).toEqual([["java:a/A", "java:b/B", 2]]);
    const only = types.edges[0]!;
    expect([...only.kinds].sort()).toEqual(["invocation", "reference"]);
    expect([...only.provenances].sort()).toEqual(["declared", "derived"]);
    // The import edges are module-level: no containing type, dropped and counted.
    expect(types.diagnostics.droppedEdges).toBe(2);
  });
});
