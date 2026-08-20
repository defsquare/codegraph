import {
  javaProfile,
  selfReferences,
  unknownReferences,
  validateModel,
  type Entity,
  type EntityId,
} from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { escapeDot, toDot } from "../src/exports/dot.js";
import { foldedGraphToJson, toJsonString } from "../src/exports/json.js";
import { foldGraph, type FoldedEdge, type FoldedGraph } from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { isClean, loadModels } from "../src/load.js";
import { coupling, type CouplingRow } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { dependenciesOf, dependentsOf, importGraph, typeDependencyGraph } from "../src/queries.js";
import { composeViews, declaredOnly, identityView, internalOnly, projectView } from "../src/views.js";
import {
  dotAttributeTokens,
  dotEdgeStatements,
  dotEdgeStatementsByPair,
  dotIsWellFormed,
  dotNodeStatements,
  dotQuotedSpans,
  dotStatements,
  pairKey,
  parseCsv,
} from "./analysis-support.js";
import { edge, javaFixture, javaGraph, pkg, toyModel, type } from "./fixture.js";

/**
 * THE M2/M3 CONTRACT, end to end, over the committed Spoon snapshot:
 *
 *   loadModels -> buildGraph -> view -> foldGraph -> queries/metrics -> exports
 *
 * Every number below was MEASURED against `fixtures/java/expected/model.jsonl`,
 * not assumed. This is the first place a disagreement between the extractor and
 * the analyzer surfaces: if the extractor's output shifts, the failures land
 * here with the stage that noticed, rather than as a silent metric drift.
 */

const ENTITIES = 167;
const EDGES = 175;
const STUBS = 26;
/** 75 of the 175 edges touch a stub; the internal-only corpus keeps 100. */
const INTERNAL_EDGES = 100;
/** Exactly two edges are the extractor's inference, both module→module imports. */
const DECLARED_EDGES = 173;

const ORDER = "java:com.acme.order";
const ADAPTER = "java:com.acme.order.adapter";
const LEGACY = "java:com.acme.order.legacy";
const LEDGER = "java:com.megacorp.ledger";

describe("stage 1 — load is clean on real extractor output", () => {
  const model = javaFixture();
  const { union, diagnostics } = loadModels(model, {
    sources: ["fixtures/java/expected/model.json"],
  });

  it("parses the snapshot into a single-language union", () => {
    expect(union.models).toHaveLength(1);
    expect(union.langs).toEqual(["java"]);
    expect(union.entities).toHaveLength(ENTITIES);
    expect(union.edges).toHaveLength(EDGES);
    expect(union.sources[0]).toEqual({
      index: 0,
      label: "fixtures/java/expected/model.json",
      lang: "java",
    });
  });

  it("reports ZERO diagnostics — no schema, profile, closure or duplicate problem", () => {
    expect(diagnostics.schemaErrors).toEqual([]);
    expect(diagnostics.unknownProfiles).toEqual([]);
    expect(diagnostics.profileIssues).toEqual([]);
    expect(diagnostics.profileIssueCounts).toEqual({});
    expect(diagnostics.danglingReferences).toEqual([]);
    expect(diagnostics.selfEdges).toEqual([]);
    expect(diagnostics.duplicateIds).toEqual([]);
    expect(isClean(diagnostics)).toBe(true);
  });

  it("agrees with core's own integrity helpers, which own these rules", () => {
    // Closure and self-reference are core's definitions (CLAUDE.md invariants 4
    // and 10). The analyzer must not have a second, drifting opinion.
    expect(unknownReferences(model)).toEqual([]);
    expect(selfReferences(model)).toEqual([]);
    expect(validateModel(model, javaProfile)).toEqual([]);
  });
});

describe("stage 2 — the indexed graph", () => {
  const graph = javaGraph();

  it("indexes every declared entity, stubs included", () => {
    expect(graph.ids()).toHaveLength(ENTITIES);
    expect(graph.edges).toHaveLength(EDGES);
    expect(graph.ids().filter((id) => graph.isStub(id))).toHaveLength(STUBS);
  });

  it("derives inverse indexes the model never stored", () => {
    // The model stores OUTGOING edges only (invariant 4), so every inverse view
    // must be reconstructible — and must cover the whole edge set, not a sample.
    expect(graph.importersOf(LEDGER)).toEqual([ORDER, ADAPTER]);
    const total = (of: (id: EntityId) => readonly EntityId[]): number =>
      graph.ids().reduce((sum, id) => sum + of(id).length, 0);
    expect(total((id) => graph.subtypesOf(id))).toBe(3);
    expect(total((id) => graph.implementersOf(id))).toBe(3);
    expect(total((id) => graph.importersOf(id))).toBe(6);
    for (const id of graph.ids()) {
      for (const caller of graph.callersOf(id)) expect(graph.has(caller)).toBe(true);
    }
  });
});

describe("stage 3 — views project without copying", () => {
  const graph = javaGraph();

  it("measures the fixture under each view", () => {
    expect(projectView(graph, identityView).edges).toHaveLength(EDGES);
    expect(projectView(graph, internalOnly).edges).toHaveLength(INTERNAL_EDGES);
    expect(projectView(graph, declaredOnly).edges).toHaveLength(DECLARED_EDGES);
    // Both derived edges target the external module `com.megacorp.ledger`, so
    // internalOnly already implies declaredOnly on THIS corpus. That is a fact
    // about the fixture, not a law: a derived edge between two internal nodes
    // would break the coincidence, which is why both filters exist.
    expect(projectView(graph, composeViews(internalOnly, declaredOnly)).edges).toHaveLength(
      INTERNAL_EDGES,
    );
  });
});

describe("stage 4/5 — folding and the queries built on it", () => {
  const graph = javaGraph();

  it("typeDependencyGraph is the type-level fold of every edge kind", () => {
    const query = typeDependencyGraph(graph);
    const folded = foldGraph(graph, { level: "type" });
    expect(query.level).toBe("type");
    expect(query.view).toEqual({ name: "all", filters: [] });
    expect(query.nodes).toEqual(folded.nodes);
    expect(query.edges).toEqual(folded.edges);

    expect(query.nodes).toHaveLength(36);
    expect(query.edges).toHaveLength(71);
    // The three corpus-declared packages carry TModule but not TType, so they
    // have no containing type. Reported, never hidden — and the 10 import edges
    // they own are the ones dropped.
    // Packages have no containing TYPE — the corpus's three plus the seven
    // external modules external types now hang off. Reported, never hidden.
    expect(query.diagnostics.unfoldableEntities).toEqual([
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
    expect(query.diagnostics.droppedEdges).toBe(10);
    expect(query.diagnostics.foldedEdges).toBe(165);
    expect(query.diagnostics.foldedEdges + query.diagnostics.droppedEdges).toBe(EDGES);
  });

  it("typeDependencyGraph honours the view it is given", () => {
    const query = typeDependencyGraph(graph, internalOnly);
    expect(query.view.name).toBe("internalOnly");
    expect(query.nodes).toHaveLength(17);
    expect(query.edges).toHaveLength(36);
    expect(query.nodes.every((node) => !node.isStub)).toBe(true);
  });

  it("importGraph is the module-level fold of import edges only", () => {
    const query = importGraph(graph);
    const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
    expect(query.level).toBe("module");
    expect(query.nodes).toEqual(folded.nodes);
    expect(query.edges).toEqual(folded.edges);

    // 10 base import edges aggregate to 6 module pairs; nothing is dropped,
    // because an import is already written between two modules.
    expect(query.diagnostics.droppedEdges).toBe(0);
    expect(query.diagnostics.foldedEdges).toBe(10);
    expect(query.edges.reduce((sum, e) => sum + e.count, 0)).toBe(10);
    expect(
      query.edges.map((e) => [e.from, e.to, e.count, [...e.provenances].sort()] as const),
    ).toEqual([
      [ORDER, LEDGER, 1, ["derived"]],
      [ORDER, "java:java.lang.annotation", 2, ["declared"]],
      [ORDER, "java:java.time", 1, ["declared"]],
      [ORDER, "java:java.util", 4, ["declared"]],
      [ORDER, "java:java.util.function", 1, ["declared"]],
      [ADAPTER, LEDGER, 1, ["derived"]],
    ]);
  });

  it("declaredOnly removes the inferred module import, keeping the facts", () => {
    const all = importGraph(graph);
    const facts = importGraph(graph, declaredOnly);
    expect(facts.view.name).toBe("declaredOnly");
    expect(facts.edges.some((e) => e.to === LEDGER)).toBe(false);
    expect(all.edges.some((e) => e.to === LEDGER)).toBe(true);
    expect(facts.edges.every((e) => [...e.provenances].every((p) => p === "declared"))).toBe(true);
    expect(facts.diagnostics.foldedEdges).toBe(8);
  });

  it("every import target in this corpus is external, so internalOnly empties it", () => {
    // Not a degenerate test: it pins the honest reading of invariant 6. The
    // fixture imports nothing but JDK and third-party packages, so the
    // internal-only import graph is genuinely empty. Dropping the filter to
    // make the picture look busier would be a lie.
    const internal = importGraph(graph, internalOnly);
    expect(internal.edges).toEqual([]);
    expect(internal.nodes.map((n) => n.id)).toEqual([ADAPTER, ORDER, LEGACY].sort());
  });

  it("dependenciesOf and dependentsOf read the folded graph, sorted", () => {
    const imports = importGraph(graph);
    expect(dependenciesOf(imports, ORDER)).toEqual([
      LEDGER,
      "java:java.lang.annotation",
      "java:java.time",
      "java:java.util",
      "java:java.util.function",
    ]);
    expect(dependentsOf(imports, LEDGER)).toEqual([ADAPTER, ORDER].sort());
    expect(dependenciesOf(imports, LEDGER)).toEqual([]);
    expect(dependenciesOf(imports, "java:not.a.node" as EntityId)).toEqual([]);
    expect(dependentsOf(imports, "java:not.a.node" as EntityId)).toEqual([]);
  });
});

describe("stage 6 — coupling, stated with its view and level", () => {
  const graph = javaGraph();
  const view = composeViews(internalOnly, declaredOnly);
  const folded = foldGraph(graph, { level: "module", view });

  it("measures the three internal modules exactly", () => {
    const table = coupling(folded);
    expect(table.level).toBe("module");
    expect(table.view).toEqual({ name: "internalOnly+declaredOnly", filters: ["internalOnly", "declaredOnly"] });
    expect(table.rows.map((r) => r.id)).toEqual([ORDER, ADAPTER, LEGACY]);

    const by = (id: string) => table.rows.find((r) => r.id === id)!;
    // The only non-self module dependency in the corpus: order -> legacy.
    expect(by(ORDER)).toMatchObject({ fanOut: 1, fanIn: 0, ce: 1, ca: 0, instability: 1 });
    expect(by(LEGACY)).toMatchObject({ fanOut: 0, fanIn: 1, ce: 0, ca: 1, instability: 0 });
    // THE NaN GUARD, on real data: `adapter` has only a folding self-loop, so
    // Ca + Ce === 0. Instability is undefined there and MUST read 0, never NaN
    // — a NaN silently poisons every downstream sort and CSV.
    expect(by(ADAPTER)).toMatchObject({ fanOut: 0, fanIn: 0, ce: 0, ca: 0, instability: 0 });
    expect(Number.isNaN(by(ADAPTER).instability)).toBe(false);
  });

  it("counts self-loops only when asked, and never confuses them with fan-out", () => {
    const strict = coupling(folded);
    const loose = coupling(folded, { includeSelfLoops: true });
    const adapterStrict = strict.rows.find((r) => r.id === ADAPTER)!;
    const adapterLoose = loose.rows.find((r) => r.id === ADAPTER)!;
    expect(adapterStrict.fanOut).toBe(0);
    // With self-loops counted, `adapter` depends on exactly one node: itself.
    expect(adapterLoose.fanOut).toBe(1);
    expect(adapterLoose.fanIn).toBe(1);
    expect(adapterLoose.instability).toBeCloseTo(0.5, 10);
  });

  it("conserves weight: the edge counts are the fold's, not the fan-out's", () => {
    // fanOut counts DISTINCT nodes; outgoingEdgeCount sums FoldedEdge.count.
    // The two are constantly confused, so both are asserted against the fold.
    //
    // THE CONSERVATION LAW IS STATED PER SELF-LOOP MODE, because a coupling
    // row's four counters all obey `includeSelfLoops` together (a row reading
    // "fanOut 0, outgoing weight 6" would be incoherent). So:
    //  - includeSelfLoops: true  — every base edge the fold produced is counted
    //    exactly once from each end, so the sums hit `foldedEdges` on the nose.
    //    This is the anti-double-counting guard, and it is exact.
    //  - the default        — the same law restricted to non-self folded edges.
    // Asserting only one of the two would leave the other free to drift.
    const sum = (rows: readonly CouplingRow[], key: "outgoingEdgeCount" | "incomingEdgeCount") =>
      rows.reduce((s, r) => s + r[key], 0);
    const weightOf = (keep: (e: FoldedEdge) => boolean) =>
      folded.edges.filter(keep).reduce((s, e) => s + e.count, 0);

    const loose = coupling(folded, { includeSelfLoops: true });
    expect(sum(loose.rows, "outgoingEdgeCount")).toBe(folded.diagnostics.foldedEdges);
    expect(sum(loose.rows, "incomingEdgeCount")).toBe(folded.diagnostics.foldedEdges);

    const table = coupling(folded);
    const nonSelfWeight = weightOf((e) => !e.selfLoop);
    expect(sum(table.rows, "outgoingEdgeCount")).toBe(nonSelfWeight);
    expect(sum(table.rows, "incomingEdgeCount")).toBe(nonSelfWeight);
    // The fixture really does exercise the gap — most module-level weight is
    // intra-package, so the two readings must not accidentally coincide here.
    expect(nonSelfWeight).toBeLessThan(folded.diagnostics.foldedEdges);

    for (const row of table.rows) {
      expect(row.ce).toBe(row.fanOut);
      expect(row.ca).toBe(row.fanIn);
      expect(row.outgoingEdgeCount).toBeGreaterThanOrEqual(row.fanOut);
      expect(row.incomingEdgeCount).toBeGreaterThanOrEqual(row.fanIn);
    }
  });

  it("gives every folded node a row, isolated ones included", () => {
    const types = foldGraph(graph, { level: "type", view: internalOnly });
    const table = coupling(types);
    expect(table.rows.map((r) => r.id)).toEqual(types.nodes.map((n) => n.id));
    // `Basket.Line.Discount` participates in no folded edge at all.
    const isolated = table.rows.find((r) => r.id === "java:com.acme.order/Basket.Line.Discount")!;
    expect(isolated).toMatchObject({ fanIn: 0, fanOut: 0, instability: 0 });
  });
});

describe("stage 6 — cycles", () => {
  const graph = javaGraph();

  it("finds the fixture's two genuine type-level cycles", () => {
    const report = cycles(foldGraph(graph, { level: "type" }));
    expect(report.level).toBe("type");
    expect(report.components.map((c) => c.members)).toEqual([
      ["java:com.acme.order/Basket", "java:com.acme.order/Basket.Cursor"],
      ["java:com.acme.order/Money", "java:com.acme.order/Priceable"],
    ]);
    for (const component of report.components) {
      expect(component.size).toBe(component.members.length);
      expect(component.internalEdgeCount).toBeGreaterThanOrEqual(2);
      expect(component.weight).toBeGreaterThanOrEqual(component.internalEdgeCount);
    }
  });

  it("separates folding self-loops from architectural cycles", () => {
    const report = cycles(foldGraph(graph, { level: "type" }));
    // 11 types contain a method that calls or reads a sibling of the same type.
    // That is not a cycle between components and must not be reported as one.
    expect(report.selfLoops).toHaveLength(11);
    expect(report.selfLoops).toContain("java:com.acme.order/Order");
    expect(report.components.every((c) => c.size > 1)).toBe(true);
  });

  it("survives every view unchanged, because both cycles are internal facts", () => {
    const internal = cycles(foldGraph(graph, { level: "type", view: internalOnly }));
    const facts = cycles(
      foldGraph(graph, { level: "type", view: composeViews(internalOnly, declaredOnly) }),
    );
    expect(internal.components.map((c) => c.members)).toEqual(
      facts.components.map((c) => c.members),
    );
    expect(facts.view.name).toBe("internalOnly+declaredOnly");
  });

  it("reports no module-level cycle in this corpus", () => {
    const report = cycles(foldGraph(graph, { level: "module", view: internalOnly }));
    expect(report.components).toEqual([]);
    expect(report.selfLoops).toEqual([ORDER, ADAPTER, LEGACY].sort());
  });
});

describe("stage 7 — exports render the model honestly", () => {
  const graph = javaGraph();
  // Lazy: a seam that still throws must fail ITS test, not the whole file's
  // collection, so the passing stages stay visible while slices land.
  let cached: FoldedGraph | undefined;
  const imports = (): FoldedGraph => (cached ??= importGraph(graph));

  it("emits well-formed DOT with one statement per folded edge", () => {
    const dot = toDot(imports());
    expect(dotIsWellFormed(dot)).toBe(true);
    // The header is a leading COMMENT by default, so the graph keyword is the
    // first statement rather than the first byte.
    expect(dotStatements(dot)[0]?.startsWith("digraph")).toBe(true);
    expect(toDot(imports(), { header: false }).startsWith("digraph")).toBe(true);

    // "Never draw a relationship the model does not contain" is asserted with
    // the legend OFF, because the legend's key deliberately DOES contain
    // synthetic nodes and edges — they explain the notation, they are not
    // corpus facts. Counting them here would either hide a genuinely invented
    // corpus edge behind the legend's constant or force this number to track
    // the legend's layout.
    const bare = toDot(imports(), { legend: false });
    expect(dotEdgeStatements(bare)).toHaveLength(imports().edges.length);
    expect(dotNodeStatements(bare).size).toBe(imports().nodes.length);

    // With the legend on, every EXTRA statement must belong to the legend
    // cluster and none may collide with a corpus id — so the reader can never
    // mistake a key entry for a dependency.
    const corpusIds = new Set(imports().nodes.map((n) => n.id));
    const legendNodes = [...dotNodeStatements(dot).keys()].filter((id) => !corpusIds.has(id));
    expect(legendNodes).toHaveLength(dotNodeStatements(dot).size - corpusIds.size);
    for (const id of legendNodes) expect(corpusIds.has(id)).toBe(false);
    expect(dotEdgeStatements(dot).length).toBeGreaterThan(imports().edges.length);
  });

  it("distinguishes an inference from a fact", () => {
    const dot = toDot(imports());
    const byPair = dotEdgeStatementsByPair(dot);
    // Two edges of weight 1 leaving the SAME module: one derived, one declared.
    // Weight and source are controlled, so provenance is the ONLY difference
    // left. Identical attributes would render the inference as a fact — exactly
    // what CLAUDE.md forbids.
    const derived = byPair.get(pairKey(ORDER, LEDGER));
    const declared = byPair.get(pairKey(ORDER, "java:java.time"));
    expect(derived, "no DOT statement for the derived module import").toBeDefined();
    expect(declared, "no DOT statement for the declared module import").toBeDefined();
    const derivedTokens = new Set(dotAttributeTokens(derived!));
    const declaredTokens = new Set(dotAttributeTokens(declared!));
    expect([...derivedTokens].some((t) => !declaredTokens.has(t))).toBe(true);
  });

  it("distinguishes a stub from a corpus entity", () => {
    const dot = toDot(imports());
    const nodeStatements = dotNodeStatements(dot);
    const tokensFor = (id: string): Set<string> => {
      const statement = nodeStatements.get(id);
      expect(statement, `no DOT node statement for ${id}`).toBeDefined();
      return new Set(dotAttributeTokens(statement!));
    };
    const stubTokens = imports()
      .nodes.filter((n) => n.isStub)
      .map((n) => tokensFor(n.id));
    const realTokens = imports()
      .nodes.filter((n) => !n.isStub)
      .map((n) => tokensFor(n.id));
    // The import graph is module-level, so its stubs are the seven external
    // MODULES — not all 26 stubs, which would mean classes had leaked in.
    expect(stubTokens.length).toBe(7);
    for (const node of imports().nodes) {
      expect(graph.entity(node.id)?.traits).toContain("TModule");
    }
    expect(realTokens.length).toBe(3);
    const realUnion = new Set(realTokens.flatMap((s) => [...s]));
    // Some attribute marks EVERY stub and NO corpus entity: a degraded external
    // node must never be readable as a thing the corpus actually declares.
    const marker = [...stubTokens[0]!].filter(
      (token) => stubTokens.every((s) => s.has(token)) && !realUnion.has(token),
    );
    expect(marker.length).toBeGreaterThan(0);
  });

  it("escapes ids that would otherwise break the DOT grammar", () => {
    // EntityId is any non-empty string (core: z.string().min(1)), so a quote or
    // a backslash is a legal id and must not be able to split the document.
    expect(escapeDot('a"b')).not.toBe('"a"b"');
    for (const value of ['a"b', "a\\b", 'both " and \\', "plain"]) {
      const quoted = escapeDot(value);
      expect(dotIsWellFormed(`digraph g { ${quoted} -> ${quoted}; }`)).toBe(true);
      expect(dotQuotedSpans(`x=${quoted}`)).toEqual([value]);
    }
    const dot = toDot(hostileGraph());
    expect(dotIsWellFormed(dot)).toBe(true);
    expect(dotQuotedSpans(dot)).toContain(HOSTILE_ID);
  });

  it("emits CSV whose every row has the header's arity", () => {
    const csv = foldedGraphToCsv(imports());
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(imports().edges.length + 1);
    const width = rows[0]!.length;
    expect(width).toBeGreaterThanOrEqual(6);
    for (const row of rows) expect(row).toHaveLength(width);
    expect(parseCsv(foldedGraphToCsv(imports(), { header: false }))).toHaveLength(
      imports().edges.length,
    );
    const semi = parseCsv(foldedGraphToCsv(imports(), { delimiter: ";" }), ";");
    expect(semi.map((r) => r.length)).toEqual(rows.map((r) => r.length));
  });

  it("carries provenance and isStub into the CSV, so a spreadsheet can still tell", () => {
    const rows = parseCsv(foldedGraphToCsv(imports()));
    const header = rows[0]!.map((h) => h.toLowerCase());
    expect(header).toContain("provenances");
    expect(rows.some((r) => r.some((f) => f.includes("derived")))).toBe(true);
    const coupled = parseCsv(couplingToCsv(coupling(imports())));
    expect(coupled[0]!.map((h) => h.toLowerCase())).toContain("isstub");
    expect(coupled).toHaveLength(imports().nodes.length + 1);
    const report = cycles(foldGraph(graph, { level: "type" }));
    const cycled = parseCsv(cyclesToCsv(report));
    // ONE ROW PER MEMBER, for components AND self-loops — a self-loop is a
    // reported cycle too, so omitting those rows would make the CSV disagree
    // with the report it renders. The count is derived from the report rather
    // than hard-coded, so this stays a statement about the rendering (nothing
    // dropped, nothing invented) instead of a restatement of the fixture.
    const members = report.components.reduce((s, c) => s + c.members.length, 0);
    expect(cycled).toHaveLength(1 + members + report.selfLoops.length);
    expect(members).toBe(4); // the fixture's two genuine 2-cycles
    expect(report.selfLoops).toHaveLength(11);
    const label = (row: string[]) => row[0]!;
    const body = cycled.slice(1);
    expect(body.filter((r) => label(r) === "selfLoop")).toHaveLength(report.selfLoops.length);
    expect(body.filter((r) => label(r).startsWith("scc:"))).toHaveLength(members);
  });

  it("emits JSON with sets flattened to sorted arrays and no Set left behind", () => {
    const json = foldedGraphToJson(imports());
    expect(json.level).toBe("module");
    expect(json.nodes).toHaveLength(imports().nodes.length);
    expect(json.edges).toHaveLength(imports().edges.length);
    for (const edge of json.edges) {
      expect(Array.isArray(edge.kinds)).toBe(true);
      expect(edge.kinds).toEqual([...edge.kinds].sort());
      expect(edge.provenances).toEqual([...edge.provenances].sort());
    }
    const text = toJsonString(json);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(json)));
    expect(text).not.toContain('"kinds":{}');
  });
});

const HOSTILE_ID = 'java:weird/He said "hi" \\ here';

/** A type-level fold whose stub id contains both a quote and a backslash. */
function hostileGraph(): FoldedGraph {
  const model = toyModel(
    [
      { id: HOSTILE_ID, kind: "class", traits: ["TNamed", "TType"], name: HOSTILE_ID, isStub: true },
      pkg("java:p", ["java:p/Ok"]),
      type("java:p/Ok", "java:p"),
    ] as Entity[],
    [edge("reference", "java:p/Ok", HOSTILE_ID)],
  );
  return foldGraph(buildGraph(loadModels(model).union), { level: "type" });
}
