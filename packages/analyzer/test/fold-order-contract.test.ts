import { describe, expect, it } from "vitest";
import { loadDecodedModels } from "../src/load.js";
import { buildGraph } from "../src/graph.js";
import { foldGraph, type FoldLevel } from "../src/fold.js";
import { identityView, internalOnly } from "../src/views.js";
import { coupling } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { toDot } from "../src/exports/dot.js";
import { toPlantUml } from "../src/exports/plantuml.js";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { couplingToJson, cyclesToJson, foldedGraphToJson, toJsonString } from "../src/exports/json.js";
import { javaFixture } from "./fixture.js";

/**
 * THE ORDER CONTRACT, frozen before the SQLite store exists (PLAN.md §9.3).
 *
 * A `FoldedEdge` aggregates its `kinds` and `provenances` into SETS, and a Set
 * iterates in INSERTION order — which is the order the base edges arrived in.
 * Today that order is the canonical one the JSONL decoder produces, so every
 * output is stable and nobody has to think about it. A DB-backed load path
 * changes exactly that: rows come back in whatever order the query planner
 * chose, so any exporter that iterates a Set without sorting would start
 * emitting different bytes for the same model.
 *
 * So this file states the property while it is still cheap to state: **no
 * output depends on the order edges arrive in.** It is deliberately written
 * against the REAL pipeline — load, fold, metric, export — rather than against
 * hand-built structs, because the insertion order being frozen is the one the
 * pipeline actually produces.
 *
 * If a later change makes one of these fail, the fix is to sort in the
 * exporter, never to restore the input order that happened to hide it.
 */

/** The same model, with its edges handed over in the opposite order. */
function reversedEdges() {
  const model = javaFixture();
  return { ...model, edges: [...model.edges].reverse() };
}

function pipeline(model: ReturnType<typeof javaFixture>, level: FoldLevel) {
  const graph = buildGraph(loadDecodedModels([model]).union);
  return {
    folded: foldGraph(graph, { level, view: identityView }),
    internal: foldGraph(graph, { level, view: internalOnly }),
  };
}

describe("no rendering depends on the order edges arrived in", () => {
  for (const level of ["module", "type"] as const) {
    describe(`at ${level} level`, () => {
      const forward = pipeline(javaFixture(), level);
      const backward = pipeline(reversedEdges(), level);

      it("folds to the same graph", () => {
        expect(backward.folded.edges.length).toBe(forward.folded.edges.length);
        expect(backward.folded.diagnostics.foldedEdges).toBe(forward.folded.diagnostics.foldedEdges);
      });

      it("renders identical DOT", () => {
        expect(toDot(backward.folded)).toBe(toDot(forward.folded));
      });

      it("renders identical PlantUML", () => {
        expect(toPlantUml(backward.folded)).toBe(toPlantUml(forward.folded));
      });

      it("renders identical CSV for the folded graph", () => {
        expect(foldedGraphToCsv(backward.folded)).toBe(foldedGraphToCsv(forward.folded));
      });

      it("renders identical JSON for the folded graph", () => {
        expect(toJsonString(foldedGraphToJson(backward.folded))).toBe(
          toJsonString(foldedGraphToJson(forward.folded)),
        );
      });

      /**
       * The one place a Set survives into a metric: `CycleEdge.kinds` and
       * `.provenances` are documented "Sorted." and `toCycleEdge` sorts them.
       * That documentation is what this asserts — otherwise a cycle report
       * would carry the fold's insertion order into its JSON.
       */
      it("renders identical cycle reports, in both forms", () => {
        const before = cycles(forward.folded);
        const after = cycles(backward.folded);
        expect(toJsonString(cyclesToJson(after))).toBe(toJsonString(cyclesToJson(before)));
        expect(cyclesToCsv(after)).toBe(cyclesToCsv(before));
      });

      it("renders identical coupling tables, in both forms", () => {
        const before = coupling(forward.folded);
        const after = coupling(backward.folded);
        expect(toJsonString(couplingToJson(after))).toBe(toJsonString(couplingToJson(before)));
        expect(couplingToCsv(after)).toBe(couplingToCsv(before));
      });

      it("holds under a view as well as under the identity", () => {
        expect(toDot(backward.internal)).toBe(toDot(forward.internal));
        expect(foldedGraphToCsv(backward.internal)).toBe(foldedGraphToCsv(forward.internal));
      });
    });
  }

  /**
   * The property above is only meaningful if the fixture actually aggregates
   * several kinds or provenances into ONE folded edge — otherwise every Set has
   * one member and insertion order cannot differ. This is the guard against the
   * whole file passing vacuously.
   */
  it("is not vacuous: the fixture folds edges that differ in kind or provenance", () => {
    const { folded } = pipeline(javaFixture(), "type");
    const multiKind = folded.edges.filter((edge) => edge.kinds.size > 1);
    const multiProvenance = folded.edges.filter((edge) => edge.provenances.size > 1);
    expect(
      multiKind.length,
      "no folded edge aggregates two kinds — the order contract would be vacuous",
    ).toBeGreaterThan(0);
    // Provenance variety is rarer; state which it is rather than assuming.
    expect(multiKind.length + multiProvenance.length).toBeGreaterThan(0);
  });
});
