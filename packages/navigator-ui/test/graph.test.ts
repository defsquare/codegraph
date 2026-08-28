import { describe, expect, it } from "vitest";
import type { DepRow, NavigatorModel, NavNode } from "@codegraph/navigator";
import { corpusHueScheme, graphDisplay, hueKeyOf, hueOf } from "../src/model/graph.js";
import { artifact } from "./fixture.js";

/**
 * A two-module artifact for the aggregation rules the one-module fixture
 * cannot exercise: module-level rollup, stub filtering, the fan-in floor and
 * the node cap.
 *
 *   p (module)  A (type, fanIn 0)   B (type, fanIn 2)
 *   q (module)  C (type, fanIn 1)   X (stub type)
 */
function twoModules(): NavigatorModel {
  const nodes: NavNode[] = [
    { name: "p", kind: "package", category: "module", isStub: false, children: [1, 2] },
    {
      name: "A", kind: "class", category: "type", isStub: false, parent: 0, children: [],
      metrics: { fanIn: 0, fanOut: 2, instability: 1 },
    },
    {
      name: "B", kind: "class", category: "type", isStub: false, parent: 0, children: [],
      metrics: { fanIn: 2, fanOut: 1, instability: 1 / 3 },
    },
    { name: "q", kind: "package", category: "module", isStub: false, children: [4, 5] },
    {
      name: "C", kind: "class", category: "type", isStub: false, parent: 3, children: [],
      metrics: { fanIn: 1, fanOut: 1, instability: 0.5 },
    },
    { name: "X", kind: "class", category: "type", isStub: true, parent: 3, children: [] },
  ];
  const deps: DepRow[] = [
    { role: "typeReference", from: 1, to: 2, provenance: "declared", anchor: [0, 1, 1] },
    { role: "invokes", from: 1, to: 4, provenance: "declared", anchor: [0, 2, 2] },
    { role: "typeReference", from: 4, to: 2, provenance: "derived", anchor: [0, 3, 3] },
    { role: "typeReference", from: 2, to: 5, provenance: "declared", anchor: [0, 4, 4] },
    { role: "import", from: 0, to: 3, provenance: "declared", anchor: [0, 5, 5] },
  ];
  return {
    kind: "codegraph.navigator/1",
    generatedBy: "@codegraph/navigator",
    view: { name: "all", filters: [] },
    corpus: { name: "toy2", roots: ["toy2"] },
    files: ["A.java"],
    nodes,
    roots: [0, 3],
    deps,
    diagnostics: { selfDeps: 0, droppedDeps: 0 },
  };
}

const names = (model: NavigatorModel, display: { nodes: readonly { node: number }[] }) =>
  display.nodes.map((entry) => model.nodes[entry.node]?.name).sort();

describe("types mode", () => {
  it("aggregates the fixture's three rows into one weighted link", () => {
    const model = artifact();
    const display = graphDisplay(model, { mode: "types", hideExternals: false, minFanIn: 0 });
    expect(names(model, display)).toEqual(["A", "C"]);
    expect(display.edges).toHaveLength(1);
    expect(display.edges[0]?.count).toBe(3);
    // One of the three rows is derived, so the link is not all-declared.
    expect(display.edges[0]?.allDeclared).toBe(false);
  });

  it("hangs each type under its module and colors by module membership", () => {
    const model = twoModules();
    const display = graphDisplay(model, { mode: "types", hideExternals: false, minFanIn: 0 });
    const byNode = new Map(display.nodes.map((entry) => [entry.node, entry]));
    expect(byNode.get(1)?.module).toBe(0);
    expect(byNode.get(4)?.module).toBe(3);
    // Same module, same hue slot; different modules may differ.
    expect(byNode.get(1)?.hue).toBe(byNode.get(2)?.hue);
  });

  it("drops stubs — and their links — when externals are hidden", () => {
    const model = twoModules();
    const shown = graphDisplay(model, { mode: "types", hideExternals: false, minFanIn: 0 });
    expect(names(model, shown)).toContain("X");
    const hidden = graphDisplay(model, { mode: "types", hideExternals: true, minFanIn: 0 });
    expect(names(model, hidden)).not.toContain("X");
    expect(hidden.edges.every((edge) => edge.to !== 5 && edge.from !== 5)).toBe(true);
  });

  it("applies the fan-in floor to both endpoints", () => {
    const model = twoModules();
    const display = graphDisplay(model, { mode: "types", hideExternals: true, minFanIn: 1 });
    // A (fanIn 0) is out; B–C survive with the links between them.
    expect(names(model, display)).toEqual(["B", "C"]);
    expect(display.edges).toHaveLength(1);
  });

  it("caps deterministically by fan-in and says so", () => {
    const model = twoModules();
    const display = graphDisplay(model, { mode: "types", hideExternals: true, minFanIn: 0, cap: 2 });
    expect(display.truncated).toBe(true);
    expect(display.totalNodes).toBe(3);
    expect(names(model, display)).toEqual(["B", "C"]);
  });
});

describe("modules mode", () => {
  it("rolls type rows and import rows up to module pairs", () => {
    const model = twoModules();
    const display = graphDisplay(model, { mode: "modules", hideExternals: false, minFanIn: 0 });
    expect(names(model, display)).toEqual(["p", "q"]);
    const pq = display.edges.find((edge) => edge.from === 0 && edge.to === 3);
    const qp = display.edges.find((edge) => edge.from === 3 && edge.to === 0);
    // p->q: A->C, B->X and the import row; q->p: C->B (derived).
    expect(pq?.count).toBe(3);
    expect(qp?.count).toBe(1);
    expect(qp?.allDeclared).toBe(false);
  });

  it("drops intra-module rows — cohesion, not a dependency", () => {
    const model = artifact();
    const display = graphDisplay(model, { mode: "modules", hideExternals: false, minFanIn: 0 });
    expect(display.nodes).toEqual([]);
    expect(display.edges).toEqual([]);
  });
});

describe("hue grouping", () => {
  it("groups externals by vendor: two dotted segments", () => {
    expect(hueKeyOf("org.springframework.batch.core")).toBe("org.springframework");
    expect(
      hueOf(hueKeyOf("org.springframework.batch.core")) ===
        hueOf(hueKeyOf("org.springframework.web.client")),
    ).toBe(true);
    expect(hueKeyOf("bddf-blpm-domain")).toBe("bddf-blpm-domain");
  });

  it("groups corpus modules by functional area under the common prefix", () => {
    const scheme = { prefix: "com.acme.shop", depth: 1 };
    expect(hueKeyOf("com.acme.shop.domain.order", scheme)).toBe("com.acme.shop.domain");
    expect(hueKeyOf("com.acme.shop.infra.rest.client", scheme)).toBe("com.acme.shop.infra");
    // An external is untouched by the corpus prefix.
    expect(hueKeyOf("org.springframework.web.client", scheme)).toBe("org.springframework");
  });

  it("adapts the depth to the smallest that separates the corpus", () => {
    const modules = (names: readonly string[]): NavigatorModel => ({
      ...twoModules(),
      nodes: names.map((name) => ({
        name, kind: "package", category: "module" as const, isStub: false, children: [],
      })),
    });
    // Depth 1 already yields the two areas this corpus has.
    expect(corpusHueScheme(modules(["com.acme.a", "com.acme.b"]))).toEqual({
      prefix: "com.acme",
      depth: 1,
    });
    // The common prefix absorbs "app"; depth 1 below it separates the five areas.
    expect(
      corpusHueScheme(
        modules([
          "com.acme.app.web",
          "com.acme.app.domain",
          "com.acme.app.infra",
          "com.acme.app.batch",
          "com.acme.app.jobs",
        ]),
      ),
    ).toEqual({ prefix: "com.acme.app", depth: 1 });
    // Undotted maven-style names: no prefix, vendor rule everywhere.
    expect(corpusHueScheme(twoModules())).toEqual({ prefix: "", depth: 2 });
  });
});
