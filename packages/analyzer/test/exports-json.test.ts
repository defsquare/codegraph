import { describe, expect, it } from "vitest";
import {
  ARTEFACT_GENERATOR,
  FOLDED_GRAPH_ARTEFACT_KIND,
  couplingToJson,
  cyclesToJson,
  foldedGraphToJson,
  toJsonString,
} from "../src/exports/json.js";
import { foldGraph } from "../src/fold.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import {
  ADVERSARIAL_IDS,
  couplingRow,
  couplingTable,
  cycleEdge,
  cycleReport,
  foldedEdge,
  foldedNode,
  makeFolded,
  scc,
} from "./exports-fixture.js";
import { javaGraph } from "./fixture.js";

describe("foldedGraphToJson", () => {
  const graph = javaGraph();

  it("says what it is and refuses to look like a model.json", () => {
    const artefact = foldedGraphToJson(foldGraph(graph, { level: "module" }));
    expect(artefact.kind).toBe(FOLDED_GRAPH_ARTEFACT_KIND);
    expect(artefact.generatedBy).toBe(ARTEFACT_GENERATOR);
    // `schemaVersion` is the interchange format's marker. Analysis output that
    // carries one is claiming to be extractor output, and it is not.
    expect("schemaVersion" in artefact).toBe(false);
    expect("entities" in artefact).toBe(false);
    expect("extractor" in artefact).toBe(false);
  });

  it("carries the level and the view it was computed under", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const artefact = foldedGraphToJson(foldGraph(graph, { level: "type", view }));
    expect(artefact.level).toBe("type");
    expect(artefact.view).toEqual({
      name: "internalOnly+declaredOnly",
      filters: ["internalOnly", "declaredOnly"],
    });
  });

  it("turns every Set into a sorted array", () => {
    const artefact = foldedGraphToJson(foldGraph(graph, { level: "module" }));
    for (const edge of artefact.edges) {
      expect(edge.kinds).toEqual([...edge.kinds].sort());
      expect(edge.provenances).toEqual([...edge.provenances].sort());
      expect(Array.isArray(edge.kinds)).toBe(true);
    }
    const selfLoop = artefact.edges.find(
      (edge) => edge.from === "java:com.acme.order" && edge.selfLoop,
    );
    expect(selfLoop?.kinds).toEqual([
      "access",
      "annotationUse",
      "inheritance",
      "interfaceImplementation",
      "invocation",
      "reference",
      "throws",
    ]);
  });

  it("preserves the measured fixture shape and its diagnostics", () => {
    const module = foldedGraphToJson(foldGraph(graph, { level: "module" }));
    expect(module.nodes).toHaveLength(10);
    expect(module.edges).toHaveLength(14);
    // The five edges reaching the two Spoon-fabricated phantoms, which have no
    // honest module. Dropped and counted, never folded onto themselves.
    expect(module.diagnostics.droppedEdges).toBe(5);

    const type = foldedGraphToJson(foldGraph(graph, { level: "type" }));
    expect(type.nodes).toHaveLength(39);
    expect(type.diagnostics.foldedEdges + type.diagnostics.droppedEdges).toBe(188);
    // Packages have no containing TYPE — the corpus's three plus the seven
    // external modules external types now hang off. Reported, never hidden.
    expect(type.diagnostics.unfoldableEntities).toEqual([
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
  });

  it("keeps the derived import edge distinguishable from the declared ones", () => {
    const artefact = foldedGraphToJson(foldGraph(graph, { level: "module", edgeKinds: ["import"] }));
    const derived = artefact.edges.find((edge) => edge.to === "java:com.megacorp.ledger");
    expect(derived?.provenances).toEqual(["derived"]);
    expect(artefact.edges.filter((edge) => edge.provenances.includes("declared"))).not.toHaveLength(
      0,
    );
  });

  it("omits an absent node name rather than carrying an undefined key", () => {
    const artefact = foldedGraphToJson(
      makeFolded([foldedNode("a", { name: undefined }), foldedNode("b")], []),
    );
    expect("name" in (artefact.nodes[0] as object)).toBe(false);
    expect(artefact.nodes[1]?.name).toBe("b");
  });

  it("contains no inverse index (CLAUDE.md invariant 4)", () => {
    const text = toJsonString(foldedGraphToJson(foldGraph(graph, { level: "type" })));
    for (const forbidden of ["callers", "importers", "subtypes", "implementers", "accessors", "incoming"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("round-trips through JSON.parse", () => {
    const artefact = foldedGraphToJson(foldGraph(graph, { level: "type" }));
    expect(JSON.parse(toJsonString(artefact))).toEqual(artefact);
  });

  it("survives adversarial ids, which JSON escaping handles natively", () => {
    const artefact = foldedGraphToJson(
      makeFolded(
        [foldedNode(ADVERSARIAL_IDS.quote), foldedNode(ADVERSARIAL_IDS.newline)],
        [foldedEdge(ADVERSARIAL_IDS.quote, ADVERSARIAL_IDS.newline, { count: 2 })],
      ),
    );
    expect(JSON.parse(toJsonString(artefact))).toEqual(artefact);
    const parsed = JSON.parse(toJsonString(artefact)) as typeof artefact;
    expect(parsed.edges[0]?.to).toBe(ADVERSARIAL_IDS.newline);
  });

  it("is byte-identical across runs", () => {
    const once = toJsonString(foldedGraphToJson(foldGraph(graph, { level: "type" })));
    const twice = toJsonString(foldedGraphToJson(foldGraph(javaGraph(), { level: "type" })));
    expect(once).toBe(twice);
  });

  it("detaches its arrays from the live folded graph", () => {
    const folded = foldGraph(graph, { level: "module" });
    const artefact = foldedGraphToJson(folded);
    expect(artefact.nodes).not.toBe(folded.nodes);
    expect(artefact.diagnostics.unfoldableEntities).not.toBe(
      folded.diagnostics.unfoldableEntities,
    );
  });
});

describe("couplingToJson and cyclesToJson", () => {
  const table = couplingTable([
    couplingRow("java:a/A", { fanOut: 2, fanIn: 1 }),
    couplingRow("java:b/B", { name: undefined, isStub: true }),
  ]);
  const report = cycleReport([scc(["java:a/A", "java:b/B"], 3, 11)], ["java:c/C"], "module");

  it("round-trip through JSON.parse", () => {
    expect(JSON.parse(toJsonString(couplingToJson(table)))).toEqual(couplingToJson(table));
    expect(JSON.parse(toJsonString(cyclesToJson(report)))).toEqual(cyclesToJson(report));
  });

  it("keeps the level and the view — a coupling number without its view is not a fact", () => {
    expect(couplingToJson(table).level).toBe("type");
    expect(couplingToJson(table).view.name).toBe("all");
    expect(cyclesToJson(report).level).toBe("module");
  });

  it("detaches from the source tables", () => {
    expect(couplingToJson(table).rows).not.toBe(table.rows);
    expect(cyclesToJson(report).components[0]?.members).not.toBe(report.components[0]?.members);
    expect(cyclesToJson(report).selfLoops).not.toBe(report.selfLoops);
  });

  it("cannot be mistaken for a model: no entities, no lang, no schemaVersion", () => {
    for (const value of [couplingToJson(table), cyclesToJson(report)]) {
      expect("schemaVersion" in value).toBe(false);
      expect("entities" in value).toBe(false);
      expect("lang" in value).toBe(false);
    }
  });

  it("carries each component's edges through, with the evidence intact", () => {
    // EXPORT HONESTY (decision 7). `StronglyConnectedComponent.edges` is what
    // makes a reported cycle actionable AND auditable: `count` is the cost of
    // cutting a link and `provenances`/`allDeclared` say whether the link is a
    // declared fact or an extractor inference. A copy that kept only
    // members/size/weight would still typecheck and still round-trip, and would
    // quietly publish cycles stripped of their evidence — so the copy is
    // asserted field by field, not just for presence.
    const cut = cycleEdge("java:a/A", "java:b/B", { count: 4, kinds: ["invocation"] });
    const inferred = cycleEdge("java:b/B", "java:a/A", {
      count: 1,
      provenances: ["derived"],
      allDeclared: false,
    });
    const loop = cycleEdge("java:a/A", "java:a/A", { count: 6 });
    const withEdges = cycleReport([scc(["java:a/A", "java:b/B"], 3, 11, [cut, inferred, loop])]);

    const json = cyclesToJson(withEdges);
    const edges = json.components[0]!.edges;
    expect(edges).toEqual([cut, inferred, loop]);
    // Detached: mutating the export must not reach the live report.
    expect(edges).not.toBe(withEdges.components[0]!.edges);
    expect(edges[0]!.kinds).not.toBe(cut.kinds);
    expect(edges[1]!.provenances).not.toBe(inferred.provenances);
    // A fact and an inference stay distinguishable after serialization, and
    // arrays (not Sets) mean JSON.stringify loses neither.
    const parsed = JSON.parse(toJsonString(json)) as typeof json;
    const round = parsed.components[0]!.edges;
    expect(round[0]).toMatchObject({ allDeclared: true, provenances: ["declared"] });
    expect(round[1]).toMatchObject({ allDeclared: false, provenances: ["derived"] });
    expect(round[2]).toMatchObject({ selfLoop: true, count: 6 });
  });

  it("carries the feedback set and the tangle metric, detached", () => {
    // The cut is the report's actionable recommendation — an export that
    // dropped it would publish a tangle score with no way to audit it.
    const heavy = cycleEdge("java:a/A", "java:b/B", { count: 4 });
    const cut = cycleEdge("java:b/B", "java:a/A", { count: 1 });
    const withCut = cycleReport([scc(["java:a/A", "java:b/B"], 2, 5, [heavy, cut], [cut])]);

    const json = cyclesToJson(withCut);
    const component = json.components[0]!;
    expect(component.feedbackEdges).toEqual([cut]);
    expect(component.feedbackEdges).not.toBe(withCut.components[0]!.feedbackEdges);
    expect(component.feedbackEdges[0]).not.toBe(cut);
    expect(component.feedbackWeight).toBe(1);
    expect(component.tangleMetric).toBe(1 / 5);
    expect(json.tangle).toEqual({
      feedbackEdgeCount: 1,
      feedbackWeight: 1,
      cyclicWeight: 5,
      metric: 1 / 5,
    });
    expect(json.tangle).not.toBe(withCut.tangle);
  });
});

describe("toJsonString", () => {
  it("indents by two and ends with exactly one newline", () => {
    const text = toJsonString({ a: 1 });
    expect(text).toBe('{\n  "a": 1\n}\n');
    expect(toJsonString({ a: 1 }, { indent: 0 })).toBe('{"a":1}\n');
  });

  it("renders a stray Set as a sorted array instead of {}", () => {
    // Someone stringifying a raw FoldedGraph must not silently lose the kinds
    // and provenances that make an edge auditable.
    const text = toJsonString({ kinds: new Set(["reference", "access", "invocation"]) });
    expect(JSON.parse(text)).toEqual({ kinds: ["access", "invocation", "reference"] });
  });

  it("is byte-identical for the same value", () => {
    const value = foldedGraphToJson(makeFolded([foldedNode("a")], []));
    expect(toJsonString(value)).toBe(toJsonString(value));
  });
});
