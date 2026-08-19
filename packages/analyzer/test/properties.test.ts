import type { Edge, Entity } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldGraph, folderFor, type FoldLevel } from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { composeViews, declaredOnly, internalOnly, projectView } from "../src/views.js";
import { ANCHOR, javaGraph, toyModel } from "./fixture.js";

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
