import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import {
  HOTSPOT_FAMILIES,
  crossModuleShare,
  fileDependencies,
  fileMeasures,
  joinOnPaths,
  joinedHotspots,
  type FileActivity,
} from "../src/evolution.js";
import { pkg, toyModel } from "./fixture.js";

/**
 * THE JOINED HOTSPOT REPORT (M23b, PLAN §24.5), hand-counted.
 *
 * The model, extracted from `src/`:
 *
 *   com/x/order/Order.java     Order 40 lines · place() cc 6 · a lambda in it cc 2
 *                              · nested Order.Line 8 lines · Line.total() cc 1
 *   com/x/order/Pricing.java   Pricing 20 lines · price() cc 9
 *   com/x/stock/Stock.java     Stock 30 lines · reserve() cc 4
 *   com/x/stock/Bin.java       Bin 10 lines · no operation, so no cyclomatic
 *   com/x/App.java             App 5 lines · main() cc 1
 *   gen/Dto.java               Dto, measured by nothing, touched by no commit
 *
 *   declared:  Order <-> Pricing (a cycle of two files)   Order -> Stock -> Bin
 *              App -> Order
 *   derived:   Bin -> Stock (would close a second cycle; an inference does not)
 *
 * The history, mined from the repository root:
 *
 *   src/com/x/order/Order.java     10 revisions, 2 fixes
 *   src/com/x/order/Pricing.java    4 revisions, 3 fixes
 *   src/com/x/stock/Stock.java     12 revisions, 0 fixes
 *   src/com/x/stock/Bin.java       30 revisions, 1 fix
 *   src/com/x/App.java              1 revision,  0 fixes
 *   README.md                      50 revisions — no counterpart in the model
 */

const FILE = {
  order: "com/x/order/Order.java",
  pricing: "com/x/order/Pricing.java",
  stock: "com/x/stock/Stock.java",
  bin: "com/x/stock/Bin.java",
  app: "com/x/App.java",
  dto: "gen/Dto.java",
} as const;
const HIST = Object.fromEntries(Object.entries(FILE).map(([key, path]) => [key, `src/${path}`])) as Record<keyof typeof FILE, string>;

function entity(
  id: string,
  kind: string,
  traits: readonly string[],
  parent: string,
  file: string,
  metrics?: Readonly<Record<string, number>>,
): Entity {
  return {
    id,
    kind,
    traits: ["TNamed", "TChildOf", "TSourceAnchor", ...traits],
    name: id,
    isStub: false,
    parent,
    anchor: { file, span: [1, 10] },
    ...(metrics === undefined ? {} : { metrics }),
  } as unknown as Entity;
}

const type = (id: string, parent: string, file: string, sloc?: number): Entity =>
  entity(id, "class", ["TType", "TWithChildren"], parent, file, sloc === undefined ? undefined : { sloc });
const operation = (id: string, parent: string, file: string, cyclomatic: number, kind = "method"): Entity =>
  ({ ...entity(id, kind, ["TInvocable"], parent, file, { cyclomatic, sloc: 3 }), signature: "()" }) as Entity;

function edge(from: string, to: string, file: string, provenance = "declared"): Edge {
  return { edge: "reference", from, to, provenance, anchor: { file, span: [1, 1] } } as unknown as Edge;
}

const graph = buildGraph(
  loadModels(
    toyModel(
      [
        pkg("com.x"),
        pkg("com.x.order"),
        pkg("com.x.stock"),
        pkg("gen"),
        type("Order", "com.x.order", FILE.order, 40),
        operation("Order.place", "Order", FILE.order, 6),
        operation("Order.place.lambda", "Order.place", FILE.order, 2, "lambda"),
        type("Order.Line", "Order", FILE.order, 8),
        operation("Order.Line.total", "Order.Line", FILE.order, 1),
        type("Pricing", "com.x.order", FILE.pricing, 20),
        operation("Pricing.price", "Pricing", FILE.pricing, 9),
        type("Stock", "com.x.stock", FILE.stock, 30),
        operation("Stock.reserve", "Stock", FILE.stock, 4),
        type("Bin", "com.x.stock", FILE.bin, 10),
        type("App", "com.x", FILE.app, 5),
        operation("App.main", "App", FILE.app, 1),
        type("Dto", "gen", FILE.dto),
      ],
      [
        edge("Order.place", "Pricing", FILE.order),
        edge("Pricing.price", "Order", FILE.pricing),
        edge("Order", "Stock", FILE.order),
        edge("Stock", "Bin", FILE.stock),
        edge("App.main", "Order", FILE.app),
        edge("Bin", "Stock", FILE.bin, "derived"),
      ],
    ),
    { sources: ["test"] },
  ).union,
);

const deps = fileDependencies(graph);
const measures = fileMeasures(graph, deps);

const activity = (path: string, revisions: number, fixes: number): FileActivity => ({
  path,
  revisions,
  churn: revisions * 10,
  fixes,
  bugDensity: fixes / revisions,
  authors: 1,
});
const ACTIVITY: readonly FileActivity[] = [
  activity("README.md", 50, 0),
  activity(HIST.bin, 30, 1),
  activity(HIST.stock, 12, 0),
  activity(HIST.order, 10, 2),
  activity(HIST.pricing, 4, 3),
  activity(HIST.app, 1, 0),
];
const join = joinOnPaths(deps.files, ACTIVITY.map((row) => row.path));

describe("fileMeasures: what the model measures in one file", () => {
  it("counts a file's lines once: the outermost measured entity, not what is nested in it", () => {
    // Order (40) holds Order.Line (8) and the operations' own lines: 40, not 40 + 8 + 3 + 3 + 3.
    expect(measures.get(FILE.order)?.sloc).toBe(40);
    expect(measures.get(FILE.pricing)?.sloc).toBe(20);
  });

  it("sums cyclomatic over every operation written in the file, a lambda apart from its method", () => {
    expect(measures.get(FILE.order)?.cyclomatic).toBe(6 + 2 + 1);
    expect(measures.get(FILE.stock)?.cyclomatic).toBe(4);
  });

  it("says unmeasured, not zero, where nothing carries the key", () => {
    expect(measures.get(FILE.bin)).toEqual({ sloc: 10, cyclomatic: undefined, cycle: 0 });
    expect(measures.get(FILE.dto)).toEqual({ sloc: undefined, cyclomatic: undefined, cycle: 0 });
  });

  it("gives each file the size of its dependency cycle, on declared facts", () => {
    expect(measures.get(FILE.order)?.cycle).toBe(2);
    expect(measures.get(FILE.pricing)?.cycle).toBe(2);
    // Stock -> Bin is declared, Bin -> Stock only derived: no cycle is stated.
    expect(measures.get(FILE.stock)?.cycle).toBe(0);
    expect(measures.get(FILE.bin)?.cycle).toBe(0);
  });

  it("counts an inferred cycle when asked to fold inferences too", () => {
    const loose = fileDependencies(graph, { declaredOnly: false });
    expect(fileMeasures(graph, loose).get(FILE.bin)?.cycle).toBe(2);
  });

  it("measures every file of the model, and only those", () => {
    expect([...measures.keys()].sort()).toEqual(Object.values(FILE).sort());
  });
});

describe("joinedHotspots: effort times complexity, four ways", () => {
  const report = joinedHotspots(ACTIVITY, measures, join);
  const row = (path: string) => report.rows.find((one) => one.path === path)!;

  it("names the four families, in the page's order", () => {
    expect(HOTSPOT_FAMILIES).toEqual(["classic", "branchy", "tangled", "fragile"]);
  });

  it("keeps the files that joined, and counts the two kinds that did not", () => {
    expect(report.rows.map((one) => one.path).sort()).toEqual([HIST.app, HIST.bin, HIST.order, HIST.pricing, HIST.stock].sort());
    expect(report.outsideModel).toBe(1); // README.md
    expect(report.outsideHistory).toBe(1); // gen/Dto.java
  });

  it("carries both sides on each row", () => {
    expect(row(HIST.order)).toMatchObject({
      path: HIST.order,
      model: FILE.order,
      revisions: 10,
      churn: 100,
      fixes: 2,
      bugDensity: 0.2,
      authors: 1,
      sloc: 40,
      cyclomatic: 9,
      cycle: 2,
    });
  });

  it("scores classic = revisions x lines", () => {
    expect(Object.fromEntries(report.rows.map((one) => [one.model, one.scores.classic]))).toEqual({
      [FILE.order]: 400,
      [FILE.stock]: 360,
      [FILE.bin]: 300,
      [FILE.pricing]: 80,
      [FILE.app]: 5,
    });
    expect([HIST.order, HIST.stock, HIST.bin, HIST.pricing, HIST.app].map((path) => row(path).ranks.classic)).toEqual([1, 2, 3, 4, 5]);
  });

  it("scores branchy = revisions x cyclomatic, and ranks no file it could not measure", () => {
    expect([HIST.order, HIST.stock, HIST.pricing, HIST.app].map((path) => row(path).scores.branchy)).toEqual([90, 48, 36, 1]);
    expect([HIST.order, HIST.stock, HIST.pricing, HIST.app].map((path) => row(path).ranks.branchy)).toEqual([1, 2, 3, 4]);
    // Bin has 30 revisions and no measured operation: unmeasured is written null, never 0.
    expect(row(HIST.bin)).toMatchObject({ cyclomatic: null, scores: { branchy: 0 }, ranks: { branchy: null } });
  });

  it("scores tangled = revisions for a file in a cycle, nothing for the others", () => {
    expect(row(HIST.order)).toMatchObject({ scores: { tangled: 10 }, ranks: { tangled: 1 } });
    expect(row(HIST.pricing)).toMatchObject({ scores: { tangled: 4 }, ranks: { tangled: 2 } });
    expect(row(HIST.bin)).toMatchObject({ scores: { tangled: 0 }, ranks: { tangled: null } });
  });

  it("scores fragile = revisions x fix density, which is the fixes", () => {
    expect([HIST.pricing, HIST.order, HIST.bin].map((path) => row(path).scores.fragile)).toEqual([3, 2, 1]);
    expect([HIST.pricing, HIST.order, HIST.bin].map((path) => row(path).ranks.fragile)).toEqual([1, 2, 3]);
    expect(row(HIST.stock).ranks.fragile).toBeNull();
  });

  it("orders the rows by the family asked for, the unranked last by revisions", () => {
    expect(report.rank).toBe("branchy");
    expect(report.rows.map((one) => one.path)).toEqual([HIST.order, HIST.stock, HIST.pricing, HIST.app, HIST.bin]);
    expect(joinedHotspots(ACTIVITY, measures, join, { rank: "classic" }).rows.map((one) => one.path)).toEqual([
      HIST.order,
      HIST.stock,
      HIST.bin,
      HIST.pricing,
      HIST.app,
    ]);
    expect(joinedHotspots(ACTIVITY, measures, join, { rank: "fragile" }).rows.map((one) => one.path)).toEqual([
      HIST.pricing,
      HIST.order,
      HIST.bin,
      HIST.stock,
      HIST.app,
    ]);
    expect(joinedHotspots(ACTIVITY, measures, join, { rank: "tangled" }).rows.map((one) => one.path)).toEqual([
      HIST.order,
      HIST.pricing,
      HIST.bin,
      HIST.stock,
      HIST.app,
    ]);
  });

  it("breaks a tie on the score by revisions, then by path: the same bytes on every run", () => {
    const tied = [activity("src/com/x/order/Pricing.java", 10, 0), activity("src/com/x/order/Order.java", 10, 0)];
    const flat = new Map([
      [FILE.order, { sloc: 7, cyclomatic: 3, cycle: 0 }],
      [FILE.pricing, { sloc: 7, cyclomatic: 3, cycle: 0 }],
    ]);
    const tiedJoin = joinOnPaths(flat.keys(), tied.map((one) => one.path));
    const rows = joinedHotspots(tied, flat, tiedJoin).rows;
    expect(rows.map((one) => one.model)).toEqual([FILE.order, FILE.pricing]);
    expect(rows.map((one) => one.ranks.branchy)).toEqual([1, 2]);
  });

  it("is serializable as it stands: no undefined, no Set", () => {
    const text = JSON.stringify(report);
    expect(JSON.parse(text)).toEqual(report);
  });
});

describe("crossModuleShare: how often a commit crosses a top-level directory of the model", () => {
  /**
   * The model's files share `com/x`; below it: `order`, `stock`, and App.java
   * in the directory itself. Six commits:
   *
   *   Order + Pricing            one directory
   *   Order + Stock              CROSSES
   *   README                     touches no file of the model: not counted
   *   App + Bin + README         CROSSES (the root directory counts as one)
   *   Stock                      one directory
   *   Order + Pricing + Stock + Bin    sweeping at a limit of 3: skipped
   */
  const changesets = [
    [HIST.order, HIST.pricing],
    [HIST.order, HIST.stock],
    ["README.md"],
    [HIST.app, HIST.bin, "README.md"],
    [HIST.stock],
    [HIST.order, HIST.pricing, HIST.stock, HIST.bin],
  ];

  it("counts by hand: 2 of 4", () => {
    expect(crossModuleShare(changesets, join, { maxChangesetSize: 3 })).toEqual({
      root: "com/x",
      modules: [".", "order", "stock"],
      commits: 4,
      crossing: 2,
      share: 0.5,
      skipped: 1,
    });
  });

  it("counts the sweeping commit when the limit lets it through", () => {
    expect(crossModuleShare(changesets, join)).toMatchObject({ commits: 5, crossing: 3, skipped: 0 });
  });

  it("answers 0, not NaN, when no commit touches the model", () => {
    expect(crossModuleShare([["README.md"]], join)).toMatchObject({ commits: 0, crossing: 0, share: 0 });
  });

  it("has one module and nothing to cross when the model is one directory", () => {
    const flat = joinOnPaths(["a/A.java", "a/B.java"], ["src/a/A.java", "src/a/B.java"]);
    expect(crossModuleShare([["src/a/A.java", "src/a/B.java"]], flat)).toEqual({
      root: "a",
      modules: ["."],
      commits: 1,
      crossing: 0,
      share: 0,
      skipped: 0,
    });
  });
});
