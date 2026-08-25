import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import {
  deadWeight,
  fileDependencies,
  hiddenCoupling,
  joinOnPaths,
} from "../src/evolution.js";
import { toyModel } from "./fixture.js";

/**
 * The cross-graph queries (M9b), hand-counted. The declared graph:
 *
 *   A.java --(2 declared edges)--> B.java --(1)--> C.java     D.java: no edges
 *   A.java ~~(derived)~~> D.java
 *
 * so A REACHES C transitively, and D is connected to nothing declared.
 */

const FILE = {
  a: "com/x/A.java",
  b: "com/x/B.java",
  c: "com/x/C.java",
  d: "com/x/D.java",
} as const;
const HIST = {
  a: "src/com/x/A.java",
  b: "src/com/x/B.java",
  c: "src/com/x/C.java",
  d: "src/com/x/D.java",
} as const;

function entity(id: string, file?: string): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TType"],
    name: id,
    isStub: file === undefined,
    ...(file === undefined ? {} : { anchor: { file, span: [1, 10] } }),
  } as unknown as Entity;
}

function edge(from: string, to: string, file: string, provenance = "declared"): Edge {
  return {
    edge: "reference",
    from,
    to,
    provenance,
    anchor: { file, span: [1, 1] },
  } as unknown as Edge;
}

const graph = buildGraph(
  loadModels(
    toyModel(
      [entity("A", FILE.a), entity("B", FILE.b), entity("C", FILE.c), entity("D", FILE.d), entity("Ext")],
      [
        edge("A", "B", FILE.a),
        edge("A", "B", FILE.a),
        edge("B", "C", FILE.b),
        edge("A", "D", FILE.a, "derived"),
        edge("A", "Ext", FILE.a), // target has no anchor: no file fact to state
      ],
    ),
    { sources: ["test"] },
  ).union,
);

describe("fileDependencies", () => {
  const deps = fileDependencies(graph);

  it("folds declared edges to file pairs with counts", () => {
    expect(deps.edges).toEqual([
      { from: FILE.a, to: FILE.b, count: 2 },
      { from: FILE.b, to: FILE.c, count: 1 },
    ]);
  });

  it("drops derived edges by default — dead weight judges facts", () => {
    expect(deps.edges.some((one) => one.to === FILE.d)).toBe(false);
    expect(fileDependencies(graph, { declaredOnly: false }).edges.some((one) => one.to === FILE.d)).toBe(
      true,
    );
  });

  it("knows every anchored file, even ones with no edges", () => {
    expect(deps.files.has(FILE.d)).toBe(true);
  });
});

describe("joinOnPaths", () => {
  it("joins history lineages onto model files by suffix", () => {
    const join = joinOnPaths(Object.values(FILE), [HIST.a, HIST.b, "README.md"]);
    expect(join.modelOf.get(HIST.a)).toBe(FILE.a);
    expect(join.historyOf.get(FILE.b)).toBe(HIST.b);
    expect(join.modelOf.has("README.md")).toBe(false);
    expect(join.ambiguous).toEqual([]);
  });

  it("joins an exactly-equal path (same root on both sides)", () => {
    const join = joinOnPaths([FILE.a], [FILE.a]);
    expect(join.modelOf.get(FILE.a)).toBe(FILE.a);
  });

  it("withdraws a model file claimed by two lineages — counted, never guessed", () => {
    const join = joinOnPaths(Object.values(FILE), [HIST.a, "other/com/x/A.java", HIST.b]);
    expect(join.modelOf.has(HIST.a)).toBe(false);
    expect(join.historyOf.has(FILE.a)).toBe(false);
    expect(join.ambiguous).toEqual([HIST.a, "other/com/x/A.java"].sort());
    expect(join.modelOf.get(HIST.b)).toBe(FILE.b); // the rest still joins
  });
});

describe("hiddenCoupling", () => {
  const deps = fileDependencies(graph);
  const join = joinOnPaths(Object.values(FILE), Object.values(HIST));

  it("keeps a co-changed pair with no declared path between them", () => {
    const report = hiddenCoupling(
      [{ a: HIST.b, b: HIST.d, support: 4, confidence: 0.8 }],
      deps,
      join,
    );
    expect(report.rows).toEqual([
      { a: HIST.b, b: HIST.d, modelA: FILE.b, modelB: FILE.d, support: 4, confidence: 0.8 },
    ]);
  });

  it("drops a pair the graph explains TRANSITIVELY (A reaches C through B)", () => {
    const report = hiddenCoupling(
      [{ a: HIST.a, b: HIST.c, support: 5, confidence: 0.9 }],
      deps,
      join,
    );
    expect(report.rows).toEqual([]);
  });

  it("drops a directly-dependent pair, in either direction", () => {
    const backward = hiddenCoupling(
      [{ a: HIST.b, b: HIST.a, support: 3, confidence: 0.7 }],
      deps,
      join,
    );
    expect(backward.rows).toEqual([]);
  });

  it("counts pairs with a side outside the model (docs, config…)", () => {
    const report = hiddenCoupling(
      [{ a: HIST.a, b: "docs/guide.md", support: 6, confidence: 1 }],
      deps,
      join,
    );
    expect(report.rows).toEqual([]);
    expect(report.outsideModel).toBe(1);
  });
});

describe("deadWeight", () => {
  const deps = fileDependencies(graph);
  const join = joinOnPaths(Object.values(FILE), Object.values(HIST));
  const revisions = new Map([
    [HIST.a, 5],
    [HIST.b, 3],
    [HIST.c, 2],
    [HIST.d, 7],
  ]);

  it("reports the declared pair history never exercised, with both revision counts", () => {
    // B and C co-changed once; A and B never did.
    const report = deadWeight(
      deps,
      join,
      [{ a: HIST.b, b: HIST.c, support: 1, confidence: 0.5 }],
      revisions,
    );
    expect(report.rows).toEqual([
      { from: FILE.a, to: FILE.b, edges: 2, revisionsFrom: 5, revisionsTo: 3 },
    ]);
    expect(report.outsideHistory).toBe(0);
  });

  it("counts declared pairs history cannot judge (an unjoined side)", () => {
    const partial = joinOnPaths(Object.values(FILE), [HIST.a, HIST.b]); // no C
    const report = deadWeight(deps, partial, [], revisions);
    expect(report.rows).toEqual([
      { from: FILE.a, to: FILE.b, edges: 2, revisionsFrom: 5, revisionsTo: 3 },
    ]);
    expect(report.outsideHistory).toBe(1); // B -> C: C never joined
  });
});
