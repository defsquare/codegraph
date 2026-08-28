import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel } from "../src/index.js";
import { edge, graphOf, pkg, type } from "./fixture.js";

/**
 * The reports section: cycle/tangle facts computed by the ANALYZER on the Node
 * side and mapped to node indexes — the renderer displays them, it never runs
 * Tarjan itself (CLAUDE.md hard boundary).
 *
 * Toy corpus with one cycle at each level:
 *
 *   module m1 <-> m2 (imports both ways)
 *   type   X (in m1) <-> Y (in m2), plus X -> Z (in m1, acyclic)
 */
function cyclicModel(): NavigatorModel {
  const entities = [
    pkg("m1"),
    pkg("m2"),
    type("X", "m1"),
    type("Z", "m1"),
    type("Y", "m2"),
  ];
  const edges = [
    edge("import", "m1", "m2"),
    edge("import", "m2", "m1"),
    edge("reference", "X", "Y"),
    edge("reference", "Y", "X", "derived"),
    edge("reference", "X", "Z"),
  ];
  return buildNavigator(graphOf(entities, edges));
}

function indexByName(model: NavigatorModel, name: string): number {
  const index = model.nodes.findIndex((node) => node.name === name);
  if (index < 0) throw new Error(`no node named ${name}`);
  return index;
}

describe("reports.cycles", () => {
  it("carries one report per level, module first", () => {
    const model = cyclicModel();
    expect(model.reports?.cycles.map((report) => report.level)).toEqual(["module", "type"]);
  });

  it("maps the module cycle onto node indexes", () => {
    const model = cyclicModel();
    const report = model.reports?.cycles.find((candidate) => candidate.level === "module");
    expect(report?.components).toHaveLength(1);
    const component = report?.components[0];
    expect(component?.members.map((member) => model.nodes[member]?.name).sort()).toEqual([
      "m1",
      "m2",
    ]);
    // Two links hold the cycle; the minimal cut severs exactly one of them.
    expect(component?.edges).toHaveLength(2);
    expect(component?.edges.filter((cycleEdge) => cycleEdge.feedback)).toHaveLength(1);
    expect(component?.weight).toBe(2);
    expect(component?.feedbackWeight).toBe(1);
    expect(component?.tangleMetric).toBeCloseTo(0.5);
    expect(report?.tangle.metric).toBeCloseTo(0.5);
  });

  it("maps the type cycle, provenance kept per link", () => {
    const model = cyclicModel();
    const report = model.reports?.cycles.find((candidate) => candidate.level === "type");
    expect(report?.components).toHaveLength(1);
    const component = report?.components[0];
    expect(component?.members.map((member) => model.nodes[member]?.name).sort()).toEqual([
      "X",
      "Y",
    ]);
    const x = indexByName(model, "X");
    const y = indexByName(model, "Y");
    const declared = component?.edges.find((cycleEdge) => cycleEdge.from === x);
    const inferred = component?.edges.find((cycleEdge) => cycleEdge.from === y);
    expect(declared?.to).toBe(y);
    expect(declared?.allDeclared).toBe(true);
    expect(inferred?.allDeclared).toBe(false);
    expect(inferred?.provenances).toEqual(["derived"]);
  });

  it("closes every index: members and edge endpoints are type/module nodes", () => {
    const model = cyclicModel();
    for (const report of model.reports?.cycles ?? []) {
      const wanted = report.level === "module" ? "module" : "type";
      for (const component of report.components) {
        const members = new Set(component.members);
        for (const member of component.members) {
          expect(model.nodes[member]?.category).toBe(wanted);
        }
        for (const cycleEdge of component.edges) {
          expect(members.has(cycleEdge.from)).toBe(true);
          expect(members.has(cycleEdge.to)).toBe(true);
        }
      }
    }
  });

  it("reports empty components — not a missing section — on an acyclic corpus", () => {
    const model = buildNavigator(
      graphOf([pkg("m1"), type("X", "m1"), type("Z", "m1")], [edge("reference", "X", "Z")]),
    );
    expect(model.reports?.cycles.map((report) => report.components)).toEqual([[], []]);
    for (const report of model.reports?.cycles ?? []) {
      expect(report.tangle.metric).toBe(0);
    }
  });
});

describe("metrics.instability", () => {
  it("carries the analyzer's I = Ce / (Ca + Ce), never NaN", () => {
    const model = cyclicModel();
    const x = model.nodes[indexByName(model, "X")];
    // X depends on Y and Z (Ce = 2), Y depends on X (Ca = 1).
    expect(x?.metrics).toEqual({ fanIn: 1, fanOut: 2, instability: 2 / 3 });
    const z = model.nodes[indexByName(model, "Z")];
    expect(z?.metrics).toEqual({ fanIn: 1, fanOut: 0, instability: 0 });
  });
});
