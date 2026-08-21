import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";

import { buildGraph } from "../src/graph.js";
import { loadDecodedModels } from "../src/load.js";
import { foldGraph, type FoldLevel, type FoldOptions, type FoldedGraph } from "../src/fold.js";
import {
  composeViews,
  declaredOnly,
  identityView,
  internalOnly,
  makeView,
  provenanceOnly,
  type View,
} from "../src/views.js";
import { coupling } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { toDot } from "../src/exports/dot.js";
import { toPlantUml } from "../src/exports/plantuml.js";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import {
  couplingToJson,
  cyclesToJson,
  foldedGraphToJson,
  toJsonString,
} from "../src/exports/json.js";
import { importModel, openStore } from "../src/store/import.js";
import { foldFromStore, translateView } from "../src/store/fold-sql.js";
import type { SqliteDatabase } from "../src/store/sqlite.js";

/**
 * THE PARITY CONTRACT. `foldFromStore` answers in SQL what `foldGraph` answers
 * in JavaScript, and the only acceptable relationship between them is EQUALITY.
 *
 * Stating it on the `FoldedGraph` rather than on a report is deliberate: fold
 * is the funnel — coupling, cycles, DOT, PlantUML, CSV and JSON all consume one
 * and look at nothing else — so equality here is equality everywhere
 * downstream, and the exports below prove that rather than assume it.
 *
 * The dangerous failure is not an exception; it is a fold that is *nearly*
 * right. A container walk that stops one level early, a view that filters
 * endpoints but not edges, a `members` count that includes an entity the view
 * excluded: each produces a plausible graph with different numbers in it. So
 * every case is compared whole — nodes, edges, counts, kind and provenance
 * sets, and the diagnostics, which is where an off-by-one hides.
 */

const fixture = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);
const unicodeFixture = fileURLToPath(
  new URL("../../../fixtures/unicode/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-fold-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A model, in both forms: the in-memory graph and its store. */
function corpus(name: string, path: string): {
  db: SqliteDatabase;
  inMemory: ReturnType<typeof buildGraph>;
} {
  const db = openStore(importModel(path, join(scratch, `${name}.db`)).path);
  const inMemory = buildGraph(loadDecodedModels([readModelFileSync(path)]).union);
  return { db, inMemory };
}

const java = corpus("java", fixture);
const unicode = corpus("unicode", unicodeFixture);
afterAll(() => {
  java.db.close();
  unicode.db.close();
});

/** Sets compare by membership, so the SQL side may build them in any order. */
function expectSameFold(actual: FoldedGraph | undefined, expected: FoldedGraph, why: string): void {
  expect(actual, `${why}: the SQL fold refused a view it should translate`).toBeDefined();
  const sql = actual!;
  expect(sql.level, why).toBe(expected.level);
  expect(sql.view, why).toEqual(expected.view);
  expect(sql.nodes, `${why}: nodes`).toEqual(expected.nodes);
  expect(sql.edges, `${why}: edges`).toEqual(expected.edges);
  expect(sql.diagnostics, `${why}: diagnostics`).toEqual(expected.diagnostics);
}

const VIEWS: [string, View][] = [
  ["all", identityView],
  ["internalOnly", internalOnly],
  ["declaredOnly", declaredOnly],
  ["internalOnly+declaredOnly", composeViews(internalOnly, declaredOnly)],
  ["provenance", provenanceOnly("declared", "derived")],
];

describe("the SQL fold equals the in-memory fold", () => {
  for (const level of ["module", "type"] as const) {
    for (const [name, view] of VIEWS) {
      it(`at ${level} level under ${name}`, () => {
        const options: FoldOptions = { level, view };
        expectSameFold(
          foldFromStore(java.db, options),
          foldGraph(java.inMemory, options),
          `${level}/${name}`,
        );
      });
    }
  }

  /**
   * A fixture whose ids SQLite would order differently than the model does
   * (fixtures/unicode/README.md). Folding sorts by rendered id, so this is
   * where "sorting belongs to the model, never to the storage engine" either
   * holds or does not.
   */
  it("agrees on ids whose canonical order SQLite disagrees with", () => {
    for (const level of ["module", "type"] as const) {
      const options: FoldOptions = { level };
      expectSameFold(
        foldFromStore(unicode.db, options),
        foldGraph(unicode.inMemory, options),
        `unicode/${level}`,
      );
    }
  });

  it("agrees when self-loops are dropped", () => {
    const options: FoldOptions = { level: "type", dropSelfLoops: true };
    expectSameFold(foldFromStore(java.db, options), foldGraph(java.inMemory, options), "selfLoops");
  });

  it("agrees when only some edge kinds are kept", () => {
    const options: FoldOptions = { level: "module", edgeKinds: ["import", "invocation"] };
    expectSameFold(foldFromStore(java.db, options), foldGraph(java.inMemory, options), "edgeKinds");
  });

  /**
   * A corpus where a TYPE's symbol is identical to its MODULE's path.
   *
   * The store renders ids from the natural key, and "is this entity its own
   * module?" decides whether the symbol slot is the module path or a symbol
   * below it. The cheap-looking test — do the two symbols match? — is true here
   * for a class that is NOT its module, so it renders `x:A` instead of `x:A/A`
   * and the class collapses onto its own package: two entities, one id.
   *
   * Only the SURROGATE answers the question, because only `m === i` means "this
   * record names itself". Found by mutation: swapping the surrogate test for
   * the symbol comparison passed every other case in this file.
   */
  it("agrees when an entity's symbol equals its module's path", () => {
    const path = join(scratch, "namesake.jsonl");
    const lines = [
      {
        t: "header",
        schemaVersion: "1.0.0",
        lang: "x",
        extractor: { name: "namesake", version: "0.0.0" },
        root: "/corpus",
        dict: {
          kinds: ["package", "class"],
          traits: ["TNamed", "TModule", "TType", "TChildOf"],
          edges: ["reference"],
          provenance: ["declared"],
        },
      },
      { t: "f", i: 0, path: "A.java" },
      // The module. Its own symbol slot carries the module path.
      { t: "e", i: 0, k: 0, tr: [0, 1], m: 0, s: "A", name: "A", definedIn: [0], isStub: false },
      // The namesake: a class in module `A` whose symbol is also `A`.
      { t: "e", i: 1, k: 1, tr: [0, 2, 3], m: 0, s: "A", name: "A", isStub: false, parent: 0 },
      { t: "e", i: 2, k: 1, tr: [0, 2, 3], m: 0, s: "B", name: "B", isStub: false, parent: 0 },
      { t: "x", k: 0, f: 1, o: 2, p: 0, anchor: [0, 1, 1] },
      { t: "eof", counts: { files: 1, entities: 3, edges: 1 } },
    ];
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const namesake = corpus("namesake", path);
    try {
      // The two entities must stay distinct — this is the corruption itself.
      const ids = namesake.inMemory.ids();
      expect(ids).toContain("x:A");
      expect(ids).toContain("x:A/A");

      for (const level of ["type", "module"] as const) {
        expectSameFold(
          foldFromStore(namesake.db, { level }),
          foldGraph(namesake.inMemory, { level }),
          `namesake/${level}`,
        );
      }
    } finally {
      namesake.db.close();
    }
  });

  /**
   * Guard against the whole suite passing vacuously. If the fixture folded to
   * an empty graph, every equality above would hold and mean nothing.
   */
  it("is not vacuous: the fixture folds to a graph with edges to get wrong", () => {
    const folded = foldFromStore(java.db, { level: "type" })!;
    expect(folded.nodes.length).toBeGreaterThan(5);
    expect(folded.edges.length).toBeGreaterThan(20);
    expect(folded.edges.some((edge) => edge.kinds.size > 1)).toBe(true);
    expect(folded.diagnostics.foldedEdges).toBeGreaterThan(50);
  });
});

/**
 * The payoff, stated rather than assumed: because fold is the funnel, an equal
 * `FoldedGraph` means every report and export is byte-identical. If a later
 * change makes one of these fail while the equalities above still pass, the
 * exporter has started reading something other than the folded graph.
 */
describe("every report and export is byte-identical from either fold", () => {
  const level: FoldLevel = "module";
  const options: FoldOptions = { level, view: internalOnly };
  const fromSql = foldFromStore(java.db, options)!;
  const fromMemory = foldGraph(java.inMemory, options);

  it("renders identical DOT and PlantUML", () => {
    expect(toDot(fromSql)).toBe(toDot(fromMemory));
    expect(toPlantUml(fromSql)).toBe(toPlantUml(fromMemory));
  });

  it("renders identical CSV and JSON for the folded graph", () => {
    expect(foldedGraphToCsv(fromSql)).toBe(foldedGraphToCsv(fromMemory));
    expect(toJsonString(foldedGraphToJson(fromSql))).toBe(toJsonString(foldedGraphToJson(fromMemory)));
  });

  it("computes identical coupling", () => {
    expect(couplingToCsv(coupling(fromSql))).toBe(couplingToCsv(coupling(fromMemory)));
    expect(toJsonString(couplingToJson(coupling(fromSql)))).toBe(
      toJsonString(couplingToJson(coupling(fromMemory))),
    );
  });

  it("computes identical cycles", () => {
    expect(cyclesToCsv(cycles(fromSql))).toBe(cyclesToCsv(cycles(fromMemory)));
    expect(toJsonString(cyclesToJson(cycles(fromSql)))).toBe(
      toJsonString(cyclesToJson(cycles(fromMemory))),
    );
  });
});

/**
 * A view is an arbitrary JavaScript predicate pair. SQL cannot run one, so the
 * facade must be able to say NO — and saying no has to be the default for
 * anything it was not taught, or the first custom view a user writes will be
 * silently answered as `all`.
 */
describe("it refuses what it cannot translate", () => {
  it("returns undefined for a view whose predicate only JavaScript knows", () => {
    const nameStartsWithS = makeView(
      "nameStartsWithS",
      (entity) => (entity as { name?: string }).name?.startsWith("S") === true,
      () => true,
    );
    expect(foldFromStore(java.db, { level: "module", view: nameStartsWithS })).toBeUndefined();
    expect(translateView(java.db, nameStartsWithS.descriptor)).toBeUndefined();
  });

  it("refuses a composition that contains one untranslatable filter", () => {
    const mixed = composeViews(internalOnly, makeView("handRolled", () => true, () => true));
    expect(foldFromStore(java.db, { level: "type", view: mixed })).toBeUndefined();
  });

  it("translates the views it does know", () => {
    for (const [, view] of VIEWS) {
      expect(translateView(java.db, view.descriptor), view.descriptor.name).toBeDefined();
    }
  });
});
