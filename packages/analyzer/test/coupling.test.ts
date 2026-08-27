import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldGraph, type FoldedGraph } from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import {
  coupling,
  couplingRow,
  topByFanIn,
  topByFanOut,
  type CouplingRow,
} from "../src/metrics/coupling.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import { edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

/**
 * Every number asserted here was derived BY HAND from
 * `fixtures/java/expected/model.json` (the committed M2 snapshot) and the
 * derivation is written next to the assertion. A test that only checks
 * "instability is a number in [0,1]" proves nothing.
 */

const ORDER_PKG = "java:com.acme.order";
const ADAPTER_PKG = "java:com.acme.order.adapter";
const LEGACY_PKG = "java:com.acme.order.legacy";
const LEDGER_PKG = "java:com.megacorp.ledger";
const UTIL_PKG = "java:java.util";
const TIME_PKG = "java:java.time";
const ANNOTATION_PKG = "java:java.lang.annotation";
const FUNCTION_PKG = "java:java.util.function";

const MONEY = "java:com.acme.order/Money";
const PRICEABLE = "java:com.acme.order/Priceable";
const NOTIFICATIONS = "java:com.acme.order/Notifications";
const DISCOUNT = "java:com.acme.order/Basket.Line.Discount";
const OVERRIDE = "java:java.lang/Override";
const STRING = "java:java.lang/String";

function row(table: ReturnType<typeof coupling>, id: string): CouplingRow {
  const found = couplingRow(table, id);
  expect(found, `no coupling row for ${id}`).toBeDefined();
  return found as CouplingRow;
}

describe("coupling over the module-level import graph of the Java snapshot", () => {
  const graph = javaGraph();
  const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
  const table = coupling(folded);

  /**
   * The 10 `import` edges of the snapshot fold to exactly six module→module
   * edges (weights in brackets):
   *   com.acme.order         -> com.megacorp.ledger    [1] provenance "derived"
   *   com.acme.order         -> java.lang.annotation   [2]
   *   com.acme.order         -> java.time              [1]
   *   com.acme.order         -> java.util              [4]
   *   com.acme.order         -> java.util.function     [1]
   *   com.acme.order.adapter -> com.megacorp.ledger    [1] provenance "derived"
   */
  it("scores the importing package from its distinct targets, not its edge weight", () => {
    const order = row(table, ORDER_PKG);
    // Ce = |{ledger, java.lang.annotation, java.time, java.util,
    //         java.util.function}| = 5 — five DISTINCT modules, although the
    // aggregated weight is 2+2+1+4+1 = 10. Nothing imports com.acme.order, so
    // Ca = 0 and I = 5 / (0 + 5) = 1.
    expect(order.fanOut).toBe(5);
    expect(order.fanIn).toBe(0);
    expect(order.ce).toBe(5);
    expect(order.ca).toBe(0);
    expect(order.instability).toBe(1);
    expect(order.outgoingEdgeCount).toBe(10);
    expect(order.incomingEdgeCount).toBe(0);
    expect(order.isStub).toBe(false);
  });

  it("scores the imported external module as maximally stable", () => {
    const ledger = row(table, LEDGER_PKG);
    // Ca = |{com.acme.order, com.acme.order.adapter}| = 2, Ce = 0,
    // I = 0 / (2 + 0) = 0. Its three incoming EDGES (two from com.acme.order,
    // one from the adapter) collapse to those two distinct importers. It is a
    // stub: no outgoing edges, because the corpus never saw its body.
    expect(ledger.fanIn).toBe(2);
    expect(ledger.fanOut).toBe(0);
    expect(ledger.instability).toBe(0);
    expect(ledger.incomingEdgeCount).toBe(3);
    expect(ledger.isStub).toBe(true);
  });

  it("returns 0, not NaN, for a module with no imports in either direction", () => {
    // com.acme.order.legacy neither imports nor is imported: Ca + Ce === 0, so
    // I is UNDEFINED. The contract is 0 — NaN would poison every downstream
    // sort and CSV cell silently.
    const legacy = row(table, LEGACY_PKG);
    expect(legacy.ce).toBe(0);
    expect(legacy.ca).toBe(0);
    expect(legacy.instability).toBe(0);
    expect(Number.isNaN(legacy.instability)).toBe(false);
    // And no row anywhere is NaN.
    for (const each of table.rows) expect(Number.isFinite(each.instability)).toBe(true);
  });

  it("gives every imported external module Ca = 1 except the ledger", () => {
    for (const id of [UTIL_PKG, TIME_PKG, ANNOTATION_PKG, FUNCTION_PKG]) {
      // Each is imported by com.acme.order alone.
      expect(row(table, id).fanIn).toBe(1);
      expect(row(table, id).fanOut).toBe(0);
    }
    // java.util carries four import edges but still only one dependent.
    expect(row(table, UTIL_PKG).incomingEdgeCount).toBe(4);
  });

  it("states the level and the view every number was computed under", () => {
    expect(table.level).toBe("module");
    expect(table.view).toEqual({ name: "all", filters: [] });
  });

  it("drops the derived module edge under declaredOnly and the numbers move", () => {
    // The com.acme.order -> com.megacorp.ledger edge is the extractor's
    // INFERENCE (provenance "derived"); the source declares a type import. A
    // facts-only reading must not count it.
    const facts = coupling(foldGraph(graph, { level: "module", edgeKinds: ["import"], view: declaredOnly }));
    expect(facts.view.filters).toEqual(["declaredOnly"]);
    // com.acme.order keeps only the four java.* imports: Ce = 4, weight 2+1+4+1 = 8.
    expect(row(facts, ORDER_PKG).ce).toBe(4);
    expect(row(facts, ORDER_PKG).outgoingEdgeCount).toBe(8);
    // com.acme.order.adapter had a single derived import; it is now isolated.
    expect(row(facts, ADAPTER_PKG).ce).toBe(0);
    expect(row(facts, ADAPTER_PKG).instability).toBe(0);
    // Nothing declared points at the ledger any more.
    expect(row(facts, LEDGER_PKG).ca).toBe(0);
  });
});

describe("coupling over the type-level dependency graph of the Java snapshot", () => {
  const graph = javaGraph();
  const table = coupling(foldGraph(graph, { level: "type" }));

  it("counts distinct dependents of Money, not the 18 edges that reach it", () => {
    /**
     * Money's folded type-level edges (weights in brackets):
     *   out: Money -> Money [6] (self-loop), -> Priceable [1], -> Override [1]
     *   in:  AbstractOrder [3], Batch [7], Channel [2], Discountable [1],
     *        Money [6] (self-loop), Notifications [2], Order [2], Priceable [1]
     * Self-loops excluded (default):
     *   Ce = |{Priceable, Override}| = 2
     *   Ca = |{AbstractOrder, Batch, Channel, Discountable, Notifications,
     *          Order, Priceable}| = 7
     *   I  = 2 / (7 + 2) = 2/9
     * Weights: out 1+1 = 2, in 3+7+2+1+2+2+1 = 18.
     */
    const money = row(table, MONEY);
    expect(money.fanOut).toBe(2);
    expect(money.fanIn).toBe(7);
    expect(money.instability).toBeCloseTo(2 / 9, 12);
    expect(money.outgoingEdgeCount).toBe(2);
    expect(money.incomingEdgeCount).toBe(18);
    // Fan-in is a DISTINCT node count: 7 dependents behind 18 aggregated edges.
    expect(money.fanIn).not.toBe(money.incomingEdgeCount);
  });

  it("returns 0 for a type nothing touches", () => {
    // Basket.Line.Discount is a folded node (its own members fold onto it) with
    // no folded edge at all: Ca + Ce === 0 -> I = 0.
    const discount = row(table, DISCOUNT);
    expect(discount.ce).toBe(0);
    expect(discount.ca).toBe(0);
    expect(discount.instability).toBe(0);
  });

  it("counts stubs as dependency targets under the full view", () => {
    /**
     * Notifications depends on 10 distinct types (self-loop excluded):
     *   internal: AbstractOrder, Money, Order, Priceable
     *   stubs:    PrintStream, Override, Runnable, String, System, Consumer
     * Nothing depends on it: Ca = 0, so I = 10/10 = 1.
     */
    const notifications = row(table, NOTIFICATIONS);
    expect(notifications.fanOut).toBe(10);
    expect(notifications.fanIn).toBe(0);
    expect(notifications.instability).toBe(1);
    // The stub `Override` is a row of its own: 7 annotated types depend on it.
    const override = row(table, OVERRIDE);
    expect(override.isStub).toBe(true);
    expect(override.fanIn).toBe(7);
    expect(override.fanOut).toBe(0);
  });

  it("re-scores the same types under internalOnly, and says so in the view", () => {
    const internal = coupling(foldGraph(graph, { level: "type", view: internalOnly }));
    expect(internal.view.filters).toEqual(["internalOnly"]);
    expect(couplingRow(internal, OVERRIDE)).toBeUndefined();
    // Notifications loses its six external targets: Ce 10 -> 4, Ca still 0.
    expect(row(internal, NOTIFICATIONS).ce).toBe(4);
    expect(row(internal, NOTIFICATIONS).instability).toBe(1);
    // Money loses Override: Ce 2 -> 1, Ca unchanged at 7, I = 1/8 = 0.125.
    expect(row(internal, MONEY).ce).toBe(1);
    expect(row(internal, MONEY).ca).toBe(7);
    expect(row(internal, MONEY).instability).toBe(0.125);
    // Priceable is the interface everything prices through: Ca = 5, Ce = 1
    // (Money) -> I = 1/6, a stable abstraction.
    expect(row(internal, PRICEABLE).ca).toBe(5);
    expect(row(internal, PRICEABLE).ce).toBe(1);
    expect(row(internal, PRICEABLE).instability).toBeCloseTo(1 / 6, 12);
    // Composing views composes the descriptor too.
    const both = coupling(
      foldGraph(graph, { level: "type", view: composeViews(internalOnly, declaredOnly) }),
    );
    expect(both.view.name).toBe("internalOnly+declaredOnly");
  });

  it("counts self-loops only when asked, and then in all four counters", () => {
    const cohesion = coupling(foldGraph(graph, { level: "type" }), { includeSelfLoops: true });
    // Money's self-loop [6] now counts once as a target and once as a source:
    //   Ce = 2 + 1 = 3, Ca = 7 + 1 = 8, I = 3/11
    //   weights: out 2 + 6 = 8, in 18 + 6 = 24
    const money = row(cohesion, MONEY);
    expect(money.ce).toBe(3);
    expect(money.ca).toBe(8);
    expect(money.instability).toBeCloseTo(3 / 11, 12);
    expect(money.outgoingEdgeCount).toBe(8);
    expect(money.incomingEdgeCount).toBe(24);
    // A node with no self-loop is untouched by the flag.
    expect(row(cohesion, PRICEABLE)).toEqual(row(table, PRICEABLE));
  });

  it("ranks the load-bearing types deterministically", () => {
    // Money (Ca 7) and the stub Override (Ca 7) tie; the id order breaks the
    // tie, so the ranking never depends on Map iteration order. Then the stub
    // String (Ca 6) — under the full view the most-depended-upon nodes of a
    // small corpus are largely external, which is exactly why the view travels
    // with the table.
    const top = topByFanIn(table, 3);
    expect(top.map((r) => r.id)).toEqual([MONEY, OVERRIDE, STRING]);
    expect(top.map((r) => r.fanIn)).toEqual([7, 7, 6]);
    expect(topByFanOut(table, 1).map((r) => r.id)).toEqual([NOTIFICATIONS]);
    expect(topByFanIn(table, 0)).toEqual([]);
  });

  it("is deterministic and totals what the folded graph contains", () => {
    const again = coupling(foldGraph(graph, { level: "type" }));
    expect(again).toEqual(table);
    const ids = table.rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBe(foldGraph(graph, { level: "type" }).nodes.length);

    // Every non-self folded edge is counted once as outgoing and once as
    // incoming, so the two weight columns sum to the same total.
    const folded = foldGraph(graph, { level: "type" });
    const nonSelfWeight = folded.edges
      .filter((e) => !e.selfLoop)
      .reduce((sum, e) => sum + e.count, 0);
    const out = table.rows.reduce((sum, r) => sum + r.outgoingEdgeCount, 0);
    const inc = table.rows.reduce((sum, r) => sum + r.incomingEdgeCount, 0);
    expect(out).toBe(nonSelfWeight);
    expect(inc).toBe(nonSelfWeight);
  });
});

describe("coupling on hand-built shapes", () => {
  it("gives an isolated node I = 0 and both extremes their endpoint", () => {
    // p{A -> B}: A depends only on B, B is depended on only by A, C is alone.
    const model = toyModel(
      [
        pkg("p", ["p/A", "p/B", "p/C"]),
        type("p/A", "p", ["p/A.m()"]),
        type("p/B", "p", ["p/B.m()"]),
        type("p/C", "p", []),
        method("p/A.m()", "p/A"),
        method("p/B.m()", "p/B"),
      ],
      [edge("invocation", "p/A.m()", "p/B.m()")],
    );
    const graph = buildGraph(loadModels(model).union);
    const table = coupling(foldGraph(graph, { level: "type" }));
    expect(table.rows.map((r) => [r.id, r.ce, r.ca, r.instability])).toEqual([
      ["p/A", 1, 0, 1], // pure consumer
      ["p/B", 0, 1, 0], // pure dependency
      ["p/C", 0, 0, 0], // isolated: undefined ratio reported as 0
    ]);
    expect(table.rows.every((r) => !Number.isNaN(r.instability))).toBe(true);
  });

  it("counts two nodes, not four edges, between the same pair", () => {
    // Four base edges A -> B fold to ONE aggregated edge of count 4.
    const model = toyModel(
      [
        pkg("p", ["p/A", "p/B"]),
        type("p/A", "p", ["p/A.m()", "p/A.n()"]),
        type("p/B", "p", ["p/B.m()", "p/B.n()"]),
        method("p/A.m()", "p/A"),
        method("p/A.n()", "p/A"),
        method("p/B.m()", "p/B"),
        method("p/B.n()", "p/B"),
      ],
      [
        edge("invocation", "p/A.m()", "p/B.m()"),
        edge("invocation", "p/A.m()", "p/B.n()"),
        edge("invocation", "p/A.n()", "p/B.m()"),
        edge("reference", "p/A.n()", "p/B.n()"),
      ],
    );
    const graph = buildGraph(loadModels(model).union);
    const table = coupling(foldGraph(graph, { level: "type" }));
    const a = row(table, "p/A");
    expect(a.fanOut).toBe(1);
    expect(a.outgoingEdgeCount).toBe(4);
  });
});

describe("coupling properties", () => {
  const ids = ["p/A", "p/B", "p/C", "p/D"] as const;

  /** A random dependency shape between four classes of one package. */
  const arbitraryGraph = fc
    .uniqueArray(
      fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)).filter(([a, b]) => a !== b),
      { maxLength: 12 },
    )
    .map((pairs) => {
      const model = toyModel(
        [
          pkg("p", [...ids]),
          ...ids.map((id) => type(id, "p", [`${id}.m()`])),
          ...ids.map((id) => method(`${id}.m()`, id)),
        ],
        pairs.map(([from, to]) => edge("invocation", `${from}.m()`, `${to}.m()`)),
      );
      return foldGraph(buildGraph(loadModels(model).union), { level: "type" });
    });

  it("keeps instability finite and in [0,1], with one row per folded node", () => {
    fc.assert(
      fc.property(arbitraryGraph, (folded: FoldedGraph) => {
        const table = coupling(folded);
        expect(table.rows.length).toBe(folded.nodes.length);
        for (const r of table.rows) {
          expect(Number.isFinite(r.instability)).toBe(true);
          expect(r.instability).toBeGreaterThanOrEqual(0);
          expect(r.instability).toBeLessThanOrEqual(1);
          expect(r.ce).toBe(r.fanOut);
          expect(r.ca).toBe(r.fanIn);
          // Fan-out never exceeds the number of other nodes it could reach.
          expect(r.fanOut).toBeLessThanOrEqual(folded.nodes.length);
        }
        // Σ fanOut === Σ fanIn === number of non-self folded edges: every
        // dependency is counted once from each end.
        const distinctEdges = folded.edges.filter((e) => !e.selfLoop).length;
        expect(table.rows.reduce((s, r) => s + r.fanOut, 0)).toBe(distinctEdges);
        expect(table.rows.reduce((s, r) => s + r.fanIn, 0)).toBe(distinctEdges);
      }),
      { numRuns: 60 },
    );
  });

  it("orders rows by id whatever the edge insertion order was", () => {
    fc.assert(
      fc.property(arbitraryGraph, (folded: FoldedGraph) => {
        const rowIds = coupling(folded).rows.map((r) => r.id);
        expect(rowIds).toEqual([...rowIds].sort());
      }),
      { numRuns: 30 },
    );
  });
});
