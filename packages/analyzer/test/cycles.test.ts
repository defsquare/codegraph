import type { EdgeKind, Entity, Provenance } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import type { FoldedEdge, FoldedGraph, FoldedNode, FoldLevel } from "../src/fold.js";
import { foldGraph } from "../src/fold.js";
import { buildGraph, type CodeGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { cycles, selfLoopEdges } from "../src/metrics/cycles.js";
import { compareIds, sortIds } from "../src/order.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import { edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

const BASKET = "java:com.acme.order/Basket";
const CURSOR = "java:com.acme.order/Basket.Cursor";
const MONEY = "java:com.acme.order/Money";
const PRICEABLE = "java:com.acme.order/Priceable";

function corpus(entities: readonly Entity[], edges: readonly ReturnType<typeof edge>[]): CodeGraph {
  return buildGraph(loadModels(toyModel(entities, edges)).union);
}

/** `java:p` with `names` as its classes — the smallest thing that folds. */
function classes(names: readonly string[]): Entity[] {
  const ids = names.map((name) => `java:p/${name}`);
  return [pkg("java:p", ids), ...ids.map((id) => type(id, "java:p"))];
}

function ref(from: string, to: string, provenance: Provenance = "declared") {
  return edge("reference", `java:p/${from}`, `java:p/${to}`, provenance);
}

function members(graph: CodeGraph, level: FoldLevel = "type"): string[][] {
  return cycles(foldGraph(graph, { level })).components.map((component) => [...component.members]);
}

/**
 * A FoldedGraph built directly, for shapes no realistic fixture reaches — the
 * scale cases below need 20 000 nodes, and schema-validating a corpus that size
 * would measure the loader, not the algorithm under test.
 */
function syntheticFolded(
  ids: readonly string[],
  pairs: readonly (readonly [string, string])[],
): FoldedGraph {
  const nodes: FoldedNode[] = sortIds(ids).map((id) => ({
    id,
    kind: "class",
    name: id,
    isStub: false,
    members: 1,
  }));
  const edges: FoldedEdge[] = pairs
    .map(([from, to]) => ({
      from,
      to,
      count: 1,
      kinds: new Set<EdgeKind>(["reference"]) as ReadonlySet<EdgeKind>,
      provenances: new Set<Provenance>(["declared"]) as ReadonlySet<Provenance>,
      selfLoop: from === to,
    }))
    .sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));

  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, FoldedEdge[]>();
  const incoming = new Map<string, FoldedEdge[]>();
  for (const item of edges) {
    const out = outgoing.get(item.from);
    if (out === undefined) outgoing.set(item.from, [item]);
    else out.push(item);
    const inc = incoming.get(item.to);
    if (inc === undefined) incoming.set(item.to, [item]);
    else inc.push(item);
  }
  const empty: readonly FoldedEdge[] = [];
  return {
    level: "type",
    view: { name: "all", filters: [] },
    nodes,
    edges,
    diagnostics: { unfoldableEntities: [], droppedEdges: 0, foldedEdges: edges.length },
    node: (id) => byId.get(id),
    outgoing: (id) => outgoing.get(id) ?? empty,
    incoming: (id) => incoming.get(id) ?? empty,
  };
}

describe("cycles over the committed Java snapshot", () => {
  const graph = javaGraph();

  it("finds the two type-level cycles the corpus really contains", () => {
    // Measured against fixtures/java/expected/model.json, not invented:
    // Basket <-> its inner Cursor, and Money <-> the Priceable it implements.
    expect(members(graph)).toEqual([
      [BASKET, CURSOR],
      [MONEY, PRICEABLE],
    ]);
  });

  it("reports the module level as acyclic on this corpus", () => {
    const report = cycles(foldGraph(graph, { level: "module" }));
    expect(report.components).toEqual([]);
    // The three internal packages depend on themselves, which is not a cycle.
    expect(report.selfLoops).toEqual([
      "java:com.acme.order",
      "java:com.acme.order.adapter",
      "java:com.acme.order.legacy",
    ]);
  });

  it("hands back the edges that hold each cycle together, so it can be broken", () => {
    const report = cycles(foldGraph(graph, { level: "type" }));
    const moneyPriceable = report.components[1];
    expect(moneyPriceable?.members).toEqual([MONEY, PRICEABLE]);

    // The two links across the cycle, minus the self-loop that is internal to
    // it but is not part of the loop.
    const across = (moneyPriceable?.edges ?? []).filter((e) => !e.selfLoop);
    expect(across.map((e) => [e.from, e.to, e.kinds, e.allDeclared])).toEqual([
      [MONEY, PRICEABLE, ["interfaceImplementation"], true],
      [PRICEABLE, MONEY, ["reference"], true],
    ]);
    // internalEdgeCount/weight count the self-loop too, per the contract.
    expect(moneyPriceable?.internalEdgeCount).toBe(3);
    expect(moneyPriceable?.weight).toBe(8);
  });

  it("recommends the minimum feedback set and scores each tangle", () => {
    // Hand-derived from the dumped fixture components (self-loops excluded on
    // BOTH sides of the metric — they are intra-member cohesion, not links in
    // the loop): Basket->Cursor carries 2, Cursor->Basket 1, so the cut is the
    // lighter Cursor->Basket and the tangle is 1 of 3 cyclic references.
    // Money<->Priceable is an even 2-cycle: the tie-break cuts the edge into
    // the smaller id, 1 of 2 references.
    const report = cycles(foldGraph(graph, { level: "type" }));
    const basketCursor = report.components[0];
    expect(basketCursor?.feedbackEdges.map((e) => [e.from, e.to, e.count])).toEqual([
      [CURSOR, BASKET, 1],
    ]);
    expect(basketCursor?.feedbackWeight).toBe(1);
    expect(basketCursor?.tangleMetric).toBe(1 / 3);

    const moneyPriceable = report.components[1];
    expect(moneyPriceable?.feedbackEdges.map((e) => [e.from, e.to, e.count])).toEqual([
      [PRICEABLE, MONEY, 1],
    ]);
    expect(moneyPriceable?.feedbackWeight).toBe(1);
    expect(moneyPriceable?.tangleMetric).toBe(1 / 2);

    // The union over both components; weight 8 (incl. self-loops) is untouched.
    expect(report.tangle).toEqual({
      feedbackEdgeCount: 2,
      feedbackWeight: 2,
      cyclicWeight: 5,
      metric: 2 / 5,
    });
  });

  it("hands feedback edges back by reference, so membership is a Set lookup", () => {
    const report = cycles(foldGraph(graph, { level: "type" }));
    for (const component of report.components) {
      for (const cut of component.feedbackEdges) {
        expect(component.edges.includes(cut)).toBe(true);
        expect(cut.selfLoop).toBe(false);
      }
    }
  });

  it("states the level and the view it was computed under", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const report = cycles(foldGraph(graph, { level: "type", view }));
    expect(report.level).toBe("type");
    expect(report.view).toEqual({
      name: "internalOnly+declaredOnly",
      filters: ["internalOnly", "declaredOnly"],
    });
    // Both cycles are internal, declared facts: no view can explain them away.
    expect(report.components.map((c) => [...c.members])).toEqual([
      [BASKET, CURSOR],
      [MONEY, PRICEABLE],
    ]);
  });

  it("is deterministic and survives a JSON round trip without losing detail", () => {
    const once = cycles(foldGraph(graph, { level: "type" }));
    const twice = cycles(foldGraph(javaGraph(), { level: "type" }));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    // Sets would stringify to `{}`: kinds and provenances are sorted arrays.
    const round = JSON.parse(JSON.stringify(once)) as typeof once;
    expect(round.components[0]?.edges[1]?.kinds).toEqual(["invocation", "reference"]);
    expect(round.components[0]?.edges[1]?.provenances).toEqual(["declared"]);
    // The tangle detail is data, not object identity — it must survive too.
    expect(round.components[0]?.feedbackEdges).toEqual(once.components[0]?.feedbackEdges);
    expect(round.tangle).toEqual(once.tangle);
  });

  it("exposes self-loop detail the id list omits", () => {
    const loops = selfLoopEdges(foldGraph(graph, { level: "type" }));
    expect(loops.map((e) => e.from)).toEqual(cycles(foldGraph(graph, { level: "type" })).selfLoops);
    expect(loops.every((e) => e.selfLoop && e.from === e.to)).toBe(true);
    expect(loops.find((e) => e.from === MONEY)?.kinds).toEqual([
      "access",
      "invocation",
      "reference",
    ]);
  });
});

describe("cycles over hand-built graphs with a known SCC structure", () => {
  it("finds a simple 2-cycle", () => {
    const graph = corpus(classes(["A", "B"]), [ref("A", "B"), ref("B", "A")]);
    const report = cycles(foldGraph(graph, { level: "type" }));
    expect(report.components).toHaveLength(1);
    const cycle = report.components[0];
    expect(cycle?.members).toEqual(["java:p/A", "java:p/B"]);
    expect(cycle?.size).toBe(2);
    expect(cycle?.internalEdgeCount).toBe(2);
    expect(cycle?.weight).toBe(2);
    expect(report.selfLoops).toEqual([]);

    // Folded one level up, both classes are the same module: a self-dependency,
    // not a cycle between modules.
    const modules = cycles(foldGraph(graph, { level: "module" }));
    expect(modules.components).toEqual([]);
    expect(modules.selfLoops).toEqual(["java:p"]);
  });

  it("finds a 3-cycle and keeps its tails out of it", () => {
    const graph = corpus(classes(["A", "B", "C", "D", "E"]), [
      ref("A", "B"),
      ref("B", "C"),
      ref("C", "A"),
      ref("D", "A"), // tail in
      ref("C", "E"), // tail out
    ]);
    const report = cycles(foldGraph(graph, { level: "type" }));
    expect(report.components.map((c) => [...c.members])).toEqual([
      ["java:p/A", "java:p/B", "java:p/C"],
    ]);
    expect(report.components[0]?.internalEdgeCount).toBe(3);
    // The tails are not internal to the component, so they are not reported.
    expect(report.components[0]?.edges.map((e) => e.to)).not.toContain("java:p/E");
  });

  it("finds two disjoint cycles and orders them", () => {
    const graph = corpus(classes(["A", "B", "C", "D"]), [
      // Declared out of order on purpose: the report must not inherit it.
      ref("C", "D"),
      ref("D", "C"),
      ref("A", "B"),
      ref("B", "A"),
    ]);
    expect(members(graph)).toEqual([
      ["java:p/A", "java:p/B"],
      ["java:p/C", "java:p/D"],
    ]);
  });

  it("reports a self-loop separately from a cycle", () => {
    // A method invoking a sibling of its own class: a self-loop only once folded.
    const graph = corpus(
      [
        pkg("java:p", ["java:p/A"]),
        type("java:p/A", "java:p", ["java:p/A.one()", "java:p/A.two()"]),
        method("java:p/A.one()", "java:p/A"),
        method("java:p/A.two()", "java:p/A"),
      ],
      [edge("invocation", "java:p/A.one()", "java:p/A.two()")],
    );
    const report = cycles(foldGraph(graph, { level: "type" }));
    expect(report.components).toEqual([]);
    expect(report.selfLoops).toEqual(["java:p/A"]);
  });

  it("reports nothing on a DAG", () => {
    const graph = corpus(classes(["A", "B", "C"]), [
      ref("A", "B"),
      ref("B", "C"),
      ref("A", "C"),
    ]);
    const report = cycles(foldGraph(graph, { level: "type" }));
    expect(report.components).toEqual([]);
    expect(report.selfLoops).toEqual([]);
  });

  it("weights a cycle by the base edges it aggregates, not by the folded pairs", () => {
    const graph = corpus(classes(["A", "B"]), [
      ref("A", "B"),
      edge("invocation", "java:p/A", "java:p/B"),
      ref("B", "A"),
    ]);
    const cycle = cycles(foldGraph(graph, { level: "type" })).components[0];
    expect(cycle?.internalEdgeCount).toBe(2);
    expect(cycle?.weight).toBe(3);
    expect(cycle?.edges[0]?.count).toBe(2);
    expect(cycle?.edges[0]?.kinds).toEqual(["invocation", "reference"]);
  });

  it("shows whether a cycle rests on a fact or on an inference", () => {
    const graph = corpus(classes(["A", "B"]), [ref("A", "B"), ref("B", "A", "derived")]);
    const cycle = cycles(foldGraph(graph, { level: "type" })).components[0];
    expect(cycle?.edges.map((e) => [e.from, e.provenances, e.allDeclared])).toEqual([
      ["java:p/A", ["declared"], true],
      ["java:p/B", ["derived"], false],
    ]);

    // Facts only: the inferred link is gone, and with it the cycle. An analysis
    // that mixed the two would report an architectural problem that the source
    // does not actually declare.
    const facts = cycles(foldGraph(graph, { level: "type", view: declaredOnly }));
    expect(facts.components).toEqual([]);
  });

  it("honours minSize in both directions", () => {
    const graph = corpus(classes(["A", "B", "C", "D", "E"]), [
      ref("A", "B"),
      ref("B", "C"),
      ref("C", "A"),
      ref("D", "E"),
    ]);
    const folded = foldGraph(graph, { level: "type" });
    expect(cycles(folded, { minSize: 4 }).components).toEqual([]);
    expect(cycles(folded, { minSize: 3 }).components.map((c) => c.size)).toEqual([3]);
    // minSize 1 asks for the trivial components too — every node is one.
    expect(cycles(folded, { minSize: 1 }).components.map((c) => [...c.members])).toEqual([
      ["java:p/A", "java:p/B", "java:p/C"],
      ["java:p/D"],
      ["java:p/E"],
    ]);
    // A floor of 1: a component of size 0 does not exist.
    expect(cycles(folded, { minSize: 0 }).components).toHaveLength(3);
    // A trivial component has nothing to cut, and its metric is 0 — never NaN
    // (the coupling I=0 rule: an absent denominator is not an error state).
    const trivial = cycles(folded, { minSize: 1 }).components.find((c) => c.size === 1);
    expect(trivial?.feedbackEdges).toEqual([]);
    expect(trivial?.feedbackWeight).toBe(0);
    expect(trivial?.tangleMetric).toBe(0);
    // A threshold that failed to parse falls back to the default, rather than
    // silently reporting every node as a cycle.
    expect(cycles(folded, { minSize: Number.NaN }).components.map((c) => c.size)).toEqual([3]);
  });

  it("reports a stub that is caught in a cycle rather than hiding it", () => {
    // `internalOnly` is a filter applied at analysis time, never a reason to
    // drop data: the full view must still show the stub.
    const graph = corpus(
      [pkg("java:p", ["java:p/A"]), type("java:p/A", "java:p"), type("java:ext/X")],
      [edge("reference", "java:p/A", "java:ext/X"), edge("reference", "java:ext/X", "java:p/A")],
    );
    expect(members(graph)).toEqual([["java:ext/X", "java:p/A"]]);
    const internal = cycles(foldGraph(graph, { level: "type", view: internalOnly }));
    expect(internal.components).toEqual([]);
  });
});

describe("Tarjan is iterative — depth must not reach the call stack", () => {
  // A recursive implementation recurses once per node on the DFS path. These
  // depths overflow V8's stack, which is exactly how the bug hides: it never
  // shows up on a six-node test graph, only on a real corpus.
  const SIZE = 20_000;
  const ids = Array.from({ length: SIZE }, (_, i) => `n${String(i).padStart(6, "0")}`);
  const chain: [string, string][] = [];
  for (let i = 0; i + 1 < SIZE; i += 1) {
    const from = ids[i];
    const to = ids[i + 1];
    if (from !== undefined && to !== undefined) chain.push([from, to]);
  }

  it("walks a 20 000-node acyclic chain without recursing", () => {
    const report = cycles(syntheticFolded(ids, chain));
    expect(report.components).toEqual([]);
    expect(report.selfLoops).toEqual([]);
  });

  it("collapses a 20 000-node ring into one component", () => {
    const first = ids[0];
    const last = ids[SIZE - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    const ring: [string, string][] = [...chain, [last ?? "", first ?? ""]];
    const report = cycles(syntheticFolded(ids, ring));
    expect(report.components).toHaveLength(1);
    expect(report.components[0]?.size).toBe(SIZE);
    expect(report.components[0]?.members[0]).toBe(first);
    expect(report.components[0]?.internalEdgeCount).toBe(SIZE);
    expect(report.components[0]?.weight).toBe(SIZE);
  });
});
