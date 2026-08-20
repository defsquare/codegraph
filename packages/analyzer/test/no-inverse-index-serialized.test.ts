import { ENTITY_REFERENCE_KEYS } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { toDot } from "../src/exports/dot.js";
import { toPlantUml } from "../src/exports/plantuml.js";
import { couplingToJson, cyclesToJson, foldedGraphToJson, toJsonString } from "../src/exports/json.js";
import { foldGraph, type FoldedGraph } from "../src/fold.js";
import { coupling } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { importGraph, typeDependencyGraph } from "../src/queries.js";
import { composeViews, declaredOnly, identityView, internalOnly, type View } from "../src/views.js";
import { collectKeys, INVERSE_INDEX_KEYS, parseCsv } from "./analysis-support.js";
import { javaFixture, javaGraph } from "./fixture.js";

/**
 * CLAUDE.md INVARIANT 4, MADE EXECUTABLE.
 *
 * The model stores OUTGOING edges only. Callers, importers, subtypes,
 * accessors, implementers and incoming-edge lists are DERIVED IN MEMORY by the
 * analyzer on every run — "if one of these maps can reach a file on disk, that
 * is a bug, not an optimization" (graph.ts). Until now that rested on
 * discipline. It rests on this file instead.
 *
 * Every export is run over the real fixture, at both fold levels, under every
 * view, and the output is searched for any trace of an inverse index.
 */

const LEVELS = ["type", "module"] as const;
const VIEWS: readonly View[] = [
  identityView,
  internalOnly,
  declaredOnly,
  composeViews(internalOnly, declaredOnly),
];

function foldedGraphs(): FoldedGraph[] {
  const graph = javaGraph();
  const out: FoldedGraph[] = [];
  for (const level of LEVELS) for (const view of VIEWS) out.push(foldGraph(graph, { level, view }));
  out.push(importGraph(graph), typeDependencyGraph(graph));
  return out;
}

describe("no export serializes an inverse index", () => {
  it("the fixture's own ids contain none of the forbidden words", () => {
    // Otherwise a text search below would fire on legitimate content and the
    // guard would be quietly weakened into a tautology.
    const model = javaFixture();
    for (const entity of model.entities) {
      for (const word of INVERSE_INDEX_KEYS) {
        expect(entity.id.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("core does not even define a reference key for one", () => {
    // Closure never has to walk an inverse relation, because none is stored.
    for (const spec of Object.values(ENTITY_REFERENCE_KEYS)) {
      expect(INVERSE_INDEX_KEYS).not.toContain(spec.key);
    }
  });

  it("the JSON exports carry no inverse-index key, at any depth", () => {
    for (const folded of foldedGraphs()) {
      const payloads: unknown[] = [
        foldedGraphToJson(folded),
        couplingToJson(coupling(folded)),
        cyclesToJson(cycles(folded)),
      ];
      for (const payload of payloads) {
        const keys = [...collectKeys(payload)].map((key) => key.toLowerCase());
        for (const forbidden of INVERSE_INDEX_KEYS) {
          expect(keys, `${forbidden} leaked into a JSON export`).not.toContain(forbidden);
        }
        // The serialized form must round-trip through JSON: a Map or a Set
        // reaching a file is how a derived index escapes in the first place.
        const text = toJsonString(payload);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(payload)));
        for (const forbidden of INVERSE_INDEX_KEYS) {
          expect(text.toLowerCase()).not.toContain(`"${forbidden}"`);
        }
      }
    }
  });

  it("the CSV exports declare no inverse-index column", () => {
    for (const folded of foldedGraphs()) {
      const headers = [
        parseCsv(foldedGraphToCsv(folded))[0] ?? [],
        parseCsv(couplingToCsv(coupling(folded)))[0] ?? [],
        parseCsv(cyclesToCsv(cycles(folded)))[0] ?? [],
      ];
      for (const header of headers) {
        for (const column of header) {
          expect(INVERSE_INDEX_KEYS).not.toContain(column.toLowerCase());
        }
      }
    }
  });

  it("the DOT export names no inverse-index attribute", () => {
    for (const folded of foldedGraphs()) {
      const dot = toDot(folded).toLowerCase();
      for (const forbidden of INVERSE_INDEX_KEYS) {
        expect(dot, `${forbidden} leaked into DOT`).not.toContain(`${forbidden}=`);
        expect(dot).not.toContain(`${forbidden}:`);
      }
    }
  });

  it("the PlantUML export names no inverse-index attribute", () => {
    for (const folded of foldedGraphs()) {
      const uml = toPlantUml(folded).toLowerCase();
      for (const forbidden of INVERSE_INDEX_KEYS) {
        expect(uml, `${forbidden} leaked into PlantUML`).not.toContain(`${forbidden}=`);
        expect(uml).not.toContain(`${forbidden}:`);
      }
    }
  });

  it("no export result exposes a live Map, Set or function", () => {
    // A `Set` survives an in-memory `toEqual` but vanishes through
    // `JSON.stringify`, so a leaked one shows up as `{}` in a written file —
    // silently, which is the worst failure mode of all.
    const isPlain = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") {
        expect(typeof value, `${path} is not serializable`).not.toBe("function");
        return;
      }
      expect(value instanceof Map, `${path} is a Map`).toBe(false);
      expect(value instanceof Set, `${path} is a Set`).toBe(false);
      if (Array.isArray(value)) {
        value.forEach((item, i) => isPlain(item, `${path}[${String(i)}]`));
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        isPlain(child, `${path}.${key}`);
      }
    };
    for (const folded of foldedGraphs()) {
      isPlain(foldedGraphToJson(folded), "foldedGraphToJson");
    }
  });

  it("the analyzer still derives those indexes in memory — they are not gone", () => {
    // The invariant is "never serialized", not "never computed". If this ever
    // fails, the guard above has been satisfied by deleting the feature.
    const graph = javaGraph();
    const derived = graph
      .ids()
      .some(
        (id) =>
          graph.callersOf(id).length > 0 ||
          graph.importersOf(id).length > 0 ||
          graph.subtypesOf(id).length > 0,
      );
    expect(derived).toBe(true);
  });
});
