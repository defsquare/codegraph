import type { Edge, Entity, EntityId } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { toDot } from "../src/exports/dot.js";
import { couplingToJson, cyclesToJson, foldedGraphToJson, toJsonString } from "../src/exports/json.js";
import { foldGraph, folderFor, type FoldedGraph, type FoldLevel } from "../src/fold.js";
import { buildGraph, type CodeGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { coupling } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { dependenciesOf, dependentsOf, typeDependencyGraph } from "../src/queries.js";
import {
  composeViews,
  declaredOnly,
  identityView,
  includesEdge,
  internalOnly,
  projectView,
  type View,
} from "../src/views.js";
import { ANCHOR, edge, javaGraph, method, pkg, toyModel, type } from "./fixture.js";

/**
 * Properties the foundation must hold for EVERY corpus, not only the fixture
 * (PLAN.md §8). Generated corpora are small but structurally hostile: stubs
 * with no parent, cross-package edges, mixed provenance.
 */

interface Shape {
  readonly packages: number;
  readonly typesPerPackage: number;
  readonly methodsPerType: number;
  readonly stubs: number;
}

function corpus(shape: Shape, edgeSeeds: readonly [number, number, boolean][]) {
  const entities: Entity[] = [];
  const methods: string[] = [];
  const types: string[] = [];

  for (let p = 0; p < shape.packages; p++) {
    const pkgId = `java:p${p}`;
    const children: string[] = [];
    for (let t = 0; t < shape.typesPerPackage; t++) {
      const typeId = `${pkgId}/T${t}`;
      children.push(typeId);
      types.push(typeId);
      const typeChildren: string[] = [];
      for (let m = 0; m < shape.methodsPerType; m++) {
        const methodId = `${typeId}.m${m}()`;
        typeChildren.push(methodId);
        methods.push(methodId);
        entities.push({
          id: methodId,
          kind: "method",
          traits: ["TNamed", "TChildOf", "TInvocable", "TWithInvocations"],
          name: `m${m}`,
          signature: `m${m}()`,
          parent: typeId,
        } as Entity);
      }
      entities.push({
        id: typeId,
        kind: "class",
        traits: ["TNamed", "TChildOf", "TWithChildren", "TType"],
        name: `T${t}`,
        isStub: false,
        parent: pkgId,
        children: typeChildren,
      } as Entity);
    }
    entities.push({
      id: pkgId,
      kind: "package",
      traits: ["TNamed", "TWithChildren", "TModule"],
      name: `p${p}`,
      isStub: false,
      children,
      definedIn: ["p.java"],
    } as Entity);
  }

  // Stubs: declared, degraded, parentless — legitimate nodes, never dropped.
  for (let s = 0; s < shape.stubs; s++) {
    const stubId = `java:ext/S${s}`;
    types.push(stubId);
    entities.push({
      id: stubId,
      kind: "class",
      traits: ["TNamed", "TType"],
      name: `S${s}`,
      isStub: true,
    } as Entity);
  }

  const targets = [...methods, ...types];
  const edges: Edge[] = [];
  for (const [fromSeed, toSeed, derived] of edgeSeeds) {
    if (methods.length === 0 || targets.length === 0) break;
    const from = methods[fromSeed % methods.length]!;
    const to = targets[toSeed % targets.length]!;
    if (from === to) continue;
    edges.push({
      edge: "invocation",
      from,
      to,
      provenance: derived ? "derived" : "declared",
      anchor: ANCHOR,
    });
  }

  return buildGraph(loadModels(toyModel(entities, edges)).union);
}

const shapeArb: fc.Arbitrary<Shape> = fc.record({
  packages: fc.integer({ min: 1, max: 3 }),
  typesPerPackage: fc.integer({ min: 1, max: 3 }),
  methodsPerType: fc.integer({ min: 0, max: 3 }),
  stubs: fc.integer({ min: 0, max: 3 }),
});

const edgesArb = fc.array(
  fc.tuple(fc.nat({ max: 50 }), fc.nat({ max: 50 }), fc.boolean()),
  { maxLength: 20 },
);

const LEVELS: readonly FoldLevel[] = ["type", "module"];

describe("foundation properties", () => {
  it("every entity folds to a container that exists, or is reported unfoldable", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        const folded = foldGraph(graph, { level });
        const reported = new Set(folded.diagnostics.unfoldableEntities);
        for (const id of graph.ids()) {
          const container = folderFor(graph).container(id, level);
          if (container === undefined) {
            expect(reported.has(id)).toBe(true);
          } else {
            expect(graph.has(container)).toBe(true);
            expect(folded.node(container)).toBeDefined();
          }
        }
      }),
    );
  });

  it("a stub is its own container at every level", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        for (const id of graph.ids()) {
          if (!graph.isStub(id)) continue;
          expect(folderFor(graph).container(id, level)).toBe(id);
        }
      }),
    );
  });

  it("folding conserves edges: aggregated weight + dropped = eligible", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        const folded = foldGraph(graph, { level });
        const weight = folded.edges.reduce((sum, e) => sum + e.count, 0);
        expect(weight).toBe(folded.diagnostics.foldedEdges);
        expect(weight + folded.diagnostics.droppedEdges).toBe(graph.edges.length);
      }),
    );
  });

  it("folded edges are unique per pair, sorted, and never point at a missing node", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const folded = foldGraph(corpus(shape, seeds), { level });
        const keys = folded.edges.map((e) => `${e.from} ${e.to}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual([...keys].sort());
        for (const e of folded.edges) {
          expect(folded.node(e.from)).toBeDefined();
          expect(folded.node(e.to)).toBeDefined();
          expect(e.selfLoop).toBe(e.from === e.to);
          expect(e.kinds.size).toBeGreaterThan(0);
          expect(e.provenances.size).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("a view never adds anything the base graph does not contain", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, (shape, seeds) => {
        const graph = corpus(shape, seeds);
        const base = projectView(graph);
        const view = composeViews(internalOnly, declaredOnly);
        const projected = projectView(graph, view);
        expect(projected.entities.length).toBeLessThanOrEqual(base.entities.length);
        expect(projected.edges.length).toBeLessThanOrEqual(base.edges.length);
        for (const e of projected.edges) {
          expect(graph.edges).toContain(e);
          expect(e.provenance).toBe("declared");
          expect(graph.isStub(e.from) || graph.isStub(e.to)).toBe(false);
        }
      }),
    );
  });

  it("analysis is pure: nothing it computes changes the loaded model", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, (shape, seeds) => {
        const graph = corpus(shape, seeds);
        const before = JSON.stringify(graph.union.models);
        for (const level of LEVELS) {
          foldGraph(graph, { level });
          foldGraph(graph, { level, view: internalOnly });
        }
        projectView(graph, declaredOnly);
        expect(JSON.stringify(graph.union.models)).toBe(before);
      }),
    );
  });
});

describe("fixture properties", () => {
  const graph = javaGraph();

  it("holds every foundation property on real extractor output", () => {
    for (const level of LEVELS) {
      const folded = foldGraph(graph, { level });
      const weight = folded.edges.reduce((sum, e) => sum + e.count, 0);
      expect(weight + folded.diagnostics.droppedEdges).toBe(graph.edges.length);
      const keys = folded.edges.map((e) => `${e.from} ${e.to}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([...keys].sort());
      for (const node of folded.nodes) expect(graph.has(node.id)).toBe(true);
    }
  });
});

// ===========================================================================
// M3 SLICE PROPERTIES
//
// The block above pins the foundation. Everything below is the contract the
// five slices must satisfy for EVERY corpus, not only the fixture. It
// exercises the seams, so until a slice lands its properties fail loudly — an
// unimplemented analysis must never be mistakable for an empty result.
// ===========================================================================

const VIEWS: readonly View[] = [
  identityView,
  internalOnly,
  declaredOnly,
  composeViews(internalOnly, declaredOnly),
];

/**
 * `n` classes in one package, one method each, plus dependencies named as
 * (from-class, to-class) index pairs. A method of `T[a]` invoking `T[b]` folds
 * to exactly one type-level edge `T[a] -> T[b]`, so the caller controls the
 * folded graph's shape precisely — which is what the SCC properties need.
 */
function typeChain(n: number, deps: readonly (readonly [number, number])[]): CodeGraph {
  const pkgId = "java:p";
  const typeIds = Array.from({ length: n }, (_, i) => `${pkgId}/T${String(i)}`);
  const methodIds = typeIds.map((id) => `${id}.m()`);
  const entities: Entity[] = [
    pkg(pkgId, typeIds),
    ...typeIds.map((id, i) => type(id, pkgId, [methodIds[i]!])),
    ...methodIds.map((id, i) => method(id, typeIds[i]!)),
  ];
  const edges = deps
    .filter(([a, b]) => a !== b && a < n && b < n)
    .map(([a, b]) => edge("invocation", methodIds[a]!, typeIds[b]!));
  return buildGraph(loadModels(toyModel(entities, edges)).union);
}

/** Distinct pairs, so a generated dependency set never duplicates an edge. */
function distinctPairs(pairs: readonly (readonly [number, number])[]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const [a, b] of pairs) {
    const key = `${String(a)},${String(b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
  }
  return out;
}

const chainArb = fc
  .integer({ min: 2, max: 7 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(fc.tuple(fc.nat({ max: n - 1 }), fc.nat({ max: n - 1 })), { maxLength: 14 }),
    ),
  );

describe("folding is total and closed", () => {
  const check = (graph: CodeGraph, level: FoldLevel, view: View): void => {
    const folded = foldGraph(graph, { level, view });
    const ids = new Set(folded.nodes.map((node) => node.id));
    for (const e of folded.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  };

  it("every folded edge's endpoints are nodes of the folded graph", () => {
    // The closure invariant (CLAUDE.md 10) restated one level up. Folding bugs
    // show here first: an endpoint resolving to a container the node set does
    // not contain is a dangling reference in the derived graph.
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        for (const view of VIEWS) check(graph, level, view);
      }),
    );
  });

  it("holds on real extractor output at both levels and under every view", () => {
    const graph = javaGraph();
    for (const level of LEVELS) for (const view of VIEWS) check(graph, level, view);
  });
});

/**
 * Re-fold one edge set by hand, so the witness check never reuses the code it
 * audits. Returns the count per (container, container) pair — exactly what
 * `foldGraph` should have produced.
 */
function witnesses(graph: CodeGraph, level: FoldLevel, view: View): Map<string, number> {
  const folder = folderFor(graph);
  const out = new Map<string, number>();
  for (const e of graph.edges) {
    if (!includesEdge(view, graph, e)) continue;
    const from = folder.container(e.from, level);
    const to = folder.container(e.to, level);
    if (from === undefined || to === undefined) continue;
    const fromEntity = graph.entity(from);
    const toEntity = graph.entity(to);
    if (fromEntity === undefined || toEntity === undefined) continue;
    if (!view.entity(fromEntity, graph) || !view.entity(toEntity, graph)) continue;
    const key = `${from} ${to}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

describe("folding never invents a dependency", () => {
  const check = (graph: CodeGraph, level: FoldLevel, view: View): void => {
    const folded = foldGraph(graph, { level, view });
    const expected = witnesses(graph, level, view);
    for (const e of folded.edges) {
      const key = `${e.from} ${e.to}`;
      // At least one REAL edge of the model folds to this pair …
      expect(expected.has(key), `folded edge ${key} has no witness in the model`).toBe(true);
      // … and the weight is exactly how many, never rounded or inflated.
      expect(e.count).toBe(expected.get(key));
    }
    // And nothing the model witnesses was silently dropped.
    expect(folded.edges.map((e) => `${e.from} ${e.to}`).sort()).toEqual([...expected.keys()].sort());
  };

  it("every folded edge is witnessed by a real edge, with the right weight", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        for (const view of VIEWS) check(graph, level, view);
      }),
    );
  });

  it("holds on real extractor output", () => {
    const graph = javaGraph();
    for (const level of LEVELS) for (const view of VIEWS) check(graph, level, view);
  });

  it("holds for the query layer too, which must not re-derive folding", () => {
    const graph = javaGraph();
    const query = typeDependencyGraph(graph, internalOnly);
    const expected = witnesses(graph, "type", internalOnly);
    for (const e of query.edges) expect(e.count).toBe(expected.get(`${e.from} ${e.to}`));
    expect(query.edges).toHaveLength(expected.size);
  });
});

describe("coupling is well defined everywhere", () => {
  const assertTable = (folded: FoldedGraph): void => {
    const table = coupling(folded);
    expect(table.level).toBe(folded.level);
    expect(table.view).toEqual(folded.view);
    // One row per node, in the folded graph's order — never Map iteration order.
    expect(table.rows.map((r) => r.id)).toEqual(folded.nodes.map((n) => n.id));
    for (const row of table.rows) {
      expect(Number.isNaN(row.instability)).toBe(false);
      expect(row.instability).toBeGreaterThanOrEqual(0);
      expect(row.instability).toBeLessThanOrEqual(1);
      expect(row.ce).toBe(row.fanOut);
      expect(row.ca).toBe(row.fanIn);
      // fanOut counts DISTINCT nodes, so it can never exceed the edge count.
      expect(row.fanOut).toBeLessThanOrEqual(folded.outgoing(row.id).length);
      expect(row.fanIn).toBeLessThanOrEqual(folded.incoming(row.id).length);
      if (row.ca + row.ce === 0) {
        // The ratio is undefined here. 0 is the documented choice; NaN would
        // silently poison every downstream sort and CSV.
        expect(row.instability).toBe(0);
      } else {
        expect(row.instability).toBeCloseTo(row.ce / (row.ca + row.ce), 10);
      }
    }
  };

  it("holds for every generated graph, isolated nodes included", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        for (const view of VIEWS) assertTable(foldGraph(graph, { level, view }));
      }),
    );
  });

  it("holds for a corpus with no edges at all", () => {
    // The degenerate case is exactly where a naive Ce/(Ca+Ce) returns NaN.
    const folded = foldGraph(typeChain(3, []), { level: "type" });
    expect(folded.edges).toEqual([]);
    assertTable(folded);
    expect(coupling(folded).rows.every((r) => r.instability === 0)).toBe(true);
  });

  it("holds on real extractor output", () => {
    const graph = javaGraph();
    for (const level of LEVELS) {
      for (const view of VIEWS) assertTable(foldGraph(graph, { level, view }));
    }
  });
});

describe("strongly connected components partition the folded graph", () => {
  const assertPartition = (folded: FoldedGraph): void => {
    const report = cycles(folded);
    expect(report.level).toBe(folded.level);
    expect(report.view).toEqual(folded.view);
    const ids = new Set(folded.nodes.map((n) => n.id));
    const seen = new Set<EntityId>();
    for (const component of report.components) {
      expect(component.size).toBe(component.members.length);
      expect(component.size).toBeGreaterThan(1);
      expect(component.members).toEqual([...component.members].sort());
      for (const member of component.members) {
        expect(ids.has(member)).toBe(true);
        // Disjoint: a node belongs to AT MOST one reported component.
        expect(seen.has(member)).toBe(false);
        seen.add(member);
      }
    }
    // Deterministic order: components sorted by their first member.
    const firsts = report.components.map((c) => c.members[0]!);
    expect(firsts).toEqual([...firsts].sort());
    // Folding self-loops are reported separately from architectural cycles.
    expect(report.selfLoops).toEqual([...report.selfLoops].sort());
    expect(new Set(report.selfLoops)).toEqual(
      new Set(folded.edges.filter((e) => e.selfLoop).map((e) => e.from)),
    );
  };

  it("partitions every generated graph", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const graph = corpus(shape, seeds);
        for (const view of VIEWS) assertPartition(foldGraph(graph, { level, view }));
      }),
    );
  });

  it("a DAG yields no component of size > 1", () => {
    fc.assert(
      fc.property(chainArb, ([n, pairs]) => {
        // Forward edges only: acyclic by construction.
        const deps = distinctPairs(pairs).filter(([a, b]) => a < b);
        const folded = foldGraph(typeChain(n, deps), { level: "type" });
        expect(folded.edges.filter((e) => e.selfLoop)).toEqual([]);
        const report = cycles(folded);
        expect(report.components).toEqual([]);
        expect(report.selfLoops).toEqual([]);
      }),
    );
  });

  it("a ring of n classes is exactly one component of size n", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const ring = Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as const);
        const folded = foldGraph(typeChain(n, ring), { level: "type" });
        const report = cycles(folded);
        expect(report.components).toHaveLength(1);
        expect(report.components[0]!.size).toBe(n);
        expect(report.components[0]!.internalEdgeCount).toBe(n);
        expect(report.components[0]!.weight).toBe(n);
      }),
    );
  });

  it("minSize widens the report without changing what a cycle is", () => {
    const graph = typeChain(3, [
      [0, 1],
      [1, 0],
    ]);
    const report = cycles(foldGraph(graph, { level: "type" }), { minSize: 1 });
    // Every node now gets a component; the 2-cycle is still one of them.
    expect(report.components.map((c) => c.size).sort()).toEqual([1, 2]);
  });

  it("holds on real extractor output", () => {
    const graph = javaGraph();
    for (const level of LEVELS) {
      for (const view of VIEWS) assertPartition(foldGraph(graph, { level, view }));
    }
  });

  it("does not blow the stack on a long chain — Tarjan must be iterative", () => {
    // A 5 000-deep path is far past the default call-stack depth of a recursive
    // Tarjan. On real data that failure looks like a mysterious crash, so it is
    // pinned here rather than discovered at 15 000 nodes.
    const n = 5000;
    const chain = Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as const);
    const report = cycles(foldGraph(typeChain(n, chain), { level: "type" }));
    expect(report.components).toEqual([]);
  });
});

describe("queries read the folded graph and nothing else", () => {
  it("dependencies and dependents mirror the folded edge lists", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        const folded = foldGraph(corpus(shape, seeds), { level });
        for (const node of folded.nodes) {
          const out = dependenciesOf(folded, node.id);
          const inc = dependentsOf(folded, node.id);
          expect(out).toEqual([...new Set(out)].sort());
          expect(inc).toEqual([...new Set(inc)].sort());
          // Everything reported is an actual folded edge, and every non-self
          // edge is reported. Whether a folding self-loop counts as a
          // dependency is the slice's call; both readings satisfy these bounds.
          const outTargets = new Set(folded.outgoing(node.id).map((e) => e.to));
          const incSources = new Set(folded.incoming(node.id).map((e) => e.from));
          for (const id of out) expect(outTargets.has(id)).toBe(true);
          for (const id of inc) expect(incSources.has(id)).toBe(true);
          for (const e of folded.outgoing(node.id)) {
            if (!e.selfLoop) expect(out).toContain(e.to);
          }
          for (const e of folded.incoming(node.id)) {
            if (!e.selfLoop) expect(inc).toContain(e.from);
          }
        }
      }),
    );
  });

  it("an unknown id is empty, not an error", () => {
    const folded = foldGraph(typeChain(2, [[0, 1]]), { level: "type" });
    expect(dependenciesOf(folded, "java:nope")).toEqual([]);
    expect(dependentsOf(folded, "java:nope")).toEqual([]);
  });
});

describe("the pipeline is deterministic end to end", () => {
  /** A full run from raw JSON to every export, sharing nothing between runs. */
  const run = (shape: Shape, seeds: readonly [number, number, boolean][]): string => {
    const folded = typeDependencyGraph(
      corpus(shape, seeds),
      composeViews(internalOnly, declaredOnly),
    );
    const table = coupling(folded);
    const report = cycles(folded);
    return [
      toDot(folded),
      foldedGraphToCsv(folded),
      couplingToCsv(table),
      cyclesToCsv(report),
      toJsonString(foldedGraphToJson(folded)),
      toJsonString(couplingToJson(table)),
      toJsonString(cyclesToJson(report)),
    ].join("\n \n");
  };

  it("two runs over the same generated input are byte-identical", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, (shape, seeds) => {
        expect(run(shape, seeds)).toBe(run(shape, seeds));
      }),
      { numRuns: 25 },
    );
  });

  it("two runs over the real fixture are byte-identical", () => {
    const once = pipelineDigest();
    expect(pipelineDigest()).toBe(once);
    expect(once.length).toBeGreaterThan(0);
  });

  it("is pure: the whole pipeline leaves the loaded model untouched", () => {
    const graph = javaGraph();
    const before = JSON.stringify(graph.union.models);
    pipelineDigest();
    for (const level of LEVELS) {
      for (const view of VIEWS) {
        const folded = foldGraph(graph, { level, view });
        coupling(folded);
        cycles(folded);
      }
    }
    expect(JSON.stringify(graph.union.models)).toBe(before);
  });
});

/** Every export of the real fixture, concatenated — the determinism yardstick. */
function pipelineDigest(): string {
  const graph = javaGraph();
  const parts: string[] = [];
  for (const level of LEVELS) {
    for (const view of VIEWS) {
      const folded = foldGraph(graph, { level, view });
      parts.push(
        toDot(folded),
        foldedGraphToCsv(folded),
        couplingToCsv(coupling(folded)),
        cyclesToCsv(cycles(folded)),
        toJsonString(foldedGraphToJson(folded)),
      );
    }
  }
  return parts.join("\n \n");
}

describe("views and folding: what commutes and what does not", () => {
  /**
   * internalOnly COMMUTES with folding. Why: it removes exactly the `isStub`
   * entities, and a stub is declared with no children (METAMODEL.md §6), so no
   * surviving entity's `parent` chain passes through a removed node. Every
   * survivor keeps the same container, and filtering stubs out of the identity
   * fold gives the same graph as folding under the view.
   */
  const assertCommutes = (graph: CodeGraph, level: FoldLevel): void => {
    const base = foldGraph(graph, { level });
    const viewFirst = foldGraph(graph, { level, view: internalOnly });
    const isStub = (id: EntityId): boolean => base.node(id)?.isStub ?? true;
    expect(viewFirst.nodes).toEqual(base.nodes.filter((n) => !n.isStub));
    expect(viewFirst.edges).toEqual(base.edges.filter((e) => !isStub(e.from) && !isStub(e.to)));
  };

  it("commutes for every generated corpus", () => {
    fc.assert(
      fc.property(shapeArb, edgesArb, fc.constantFrom(...LEVELS), (shape, seeds, level) => {
        assertCommutes(corpus(shape, seeds), level);
      }),
    );
  });

  it("commutes on real extractor output at both levels", () => {
    const graph = javaGraph();
    for (const level of LEVELS) assertCommutes(graph, level);
  });

  it("declaredOnly does NOT commute — aggregation destroys the information", () => {
    // Two calls into the same class, one a fact, one an inference. Folded under
    // the identity view they become ONE edge of weight 2 whose provenance set
    // is {declared, derived}. No post-hoc filter can recover the weight of the
    // declared half: the fold has already merged them. The view must therefore
    // be applied BEFORE folding, which is why FoldOptions takes one.
    const entities: Entity[] = [
      pkg("java:p", ["java:p/A", "java:p/B"]),
      type("java:p/A", "java:p", ["java:p/A.f()", "java:p/A.g()"]),
      type("java:p/B", "java:p", ["java:p/B.m()"]),
      method("java:p/A.f()", "java:p/A"),
      method("java:p/A.g()", "java:p/A"),
      method("java:p/B.m()", "java:p/B"),
    ];
    const graph = buildGraph(
      loadModels(
        toyModel(entities, [
          edge("invocation", "java:p/A.f()", "java:p/B.m()", "declared"),
          edge("invocation", "java:p/A.g()", "java:p/B.m()", "derived"),
        ]),
      ).union,
    );

    const all = foldGraph(graph, { level: "type" });
    expect(all.edges).toHaveLength(1);
    expect(all.edges[0]!.count).toBe(2);
    expect([...all.edges[0]!.provenances].sort()).toEqual(["declared", "derived"]);

    const facts = foldGraph(graph, { level: "type", view: declaredOnly });
    expect(facts.edges).toHaveLength(1);
    expect(facts.edges[0]!.count).toBe(1);
    expect([...facts.edges[0]!.provenances]).toEqual(["declared"]);

    // Folding first and filtering after is not an optimization — it is a
    // different, wrong answer.
    expect(facts.edges[0]!.count).not.toBe(all.edges[0]!.count);
  });

  it("a view that excludes a container reports the orphans it creates", () => {
    // The other half of non-commutation: `unfoldableEntities` is produced BY
    // folding under the view, and cannot be reconstructed by filtering the node
    // list of an identity fold afterwards.
    const graph = typeChain(2, [[0, 1]]);
    const noT0: View = {
      descriptor: { name: "noT0", filters: ["noT0"] },
      entity: (entity) => entity.id !== "java:p/T0",
      edge: () => true,
    };
    const folded = foldGraph(graph, { level: "type", view: noT0 });
    expect(folded.nodes.map((n) => n.id)).toEqual(["java:p/T1"]);
    // T0's method survives the entity filter, but its container does not.
    expect(folded.diagnostics.unfoldableEntities).toContain("java:p/T0.m()");
    expect(folded.diagnostics.droppedEdges).toBe(1);
    expect(folded.edges).toEqual([]);
    // The identity fold has no way to say this.
    expect(foldGraph(graph, { level: "type" }).diagnostics.unfoldableEntities).toEqual(["java:p"]);
  });
});
