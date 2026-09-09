import { describe, expect, it } from "vitest";
import { internalOnly } from "@codegraph/analyzer";
import {
  buildNavigator,
  navigatorToJsonString,
  NAVIGATOR_ARTEFACT_KIND,
  type NavigatorModel,
  type NavNode,
} from "../src/index.js";
import { edge, field, graphOf, local, method, param, pkg, stubType, type } from "./fixture.js";

/**
 * The toy corpus, exercising every tree and role rule at once:
 *
 *   package p
 *     package p.q          (parent: p — declared nesting)
 *       class C            { method n(); field g }
 *     class A              { class B (nested); method m(x: C) { local v: C }; field f: C }
 */
function toyGraph(view?: typeof internalOnly) {
  const entities = [
    pkg("p"),
    pkg("p.q", false, "p"),
    type("A", "p"),
    type("B", "A"),
    type("C", "p.q"),
    method("m", "A", { parameters: ["x"], localVariables: ["v"] }),
    param("x", "x", "m", "C"),
    local("v", "v", "m", "C"),
    field("f", "A", { declaredType: "C" }),
    method("n", "C"),
    field("g", "C"),
  ];
  const edges = [
    edge("reference", "x", "C"), // parameter type
    edge("reference", "v", "C"), // local variable type
    edge("reference", "f", "C"), // field type
    edge("invocation", "m", "n"),
    edge("access", "m", "g", "declared", { isRead: true, isWrite: true }),
    edge("invocation", "n", "n2"), // dangling target: dropped by includesEdge
  ];
  const graph = graphOf(entities, edges);
  return buildNavigator(graph, view === undefined ? {} : { view });
}

function nodeByName(model: NavigatorModel, name: string): NavNode {
  const node = model.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`no node named ${name}`);
  return node;
}

function indexByName(model: NavigatorModel, name: string): number {
  return model.nodes.indexOf(nodeByName(model, name));
}

describe("the tree", () => {
  it("nests modules by the declared parent, types under modules, members under types", () => {
    const model = toyGraph();
    const p = nodeByName(model, "p");
    const q = nodeByName(model, "p.q");
    const a = nodeByName(model, "A");
    const b = nodeByName(model, "B");
    const c = nodeByName(model, "C");

    expect(model.roots).toEqual([indexByName(model, "p")]);
    expect(q.parent).toBe(indexByName(model, "p"));
    expect(a.parent).toBe(indexByName(model, "p"));
    expect(b.parent).toBe(indexByName(model, "A"));
    expect(c.parent).toBe(indexByName(model, "p.q"));
    expect(p.category).toBe("module");
    expect(a.category).toBe("type");

    // Children sorted by (category, name): modules first, then types, then members.
    expect(p.children.map((child) => model.nodes[child]?.name)).toEqual(["p.q", "A"]);
    expect(a.children.map((child) => model.nodes[child]?.name)).toEqual(["B", "m", "f"]);
  });

  it("excludes parameters and locals from the tree, keeps operations and attributes", () => {
    const model = toyGraph();
    const names = model.nodes.map((node) => node.name);
    expect(names).toContain("m");
    expect(names).toContain("f");
    expect(names).not.toContain("x");
    expect(names).not.toContain("v");
    expect(nodeByName(model, "m").category).toBe("operation");
    expect(nodeByName(model, "f").category).toBe("attribute");
  });

  it("assigns preorder indexes: a parent always precedes its children", () => {
    const model = toyGraph();
    for (const [index, node] of model.nodes.entries()) {
      if (node.parent !== undefined) expect(node.parent).toBeLessThan(index);
      for (const child of node.children) expect(child).toBeGreaterThan(index);
    }
  });

  it("carries the entity id on types and modules — the nodes another artifact can address", () => {
    const model = toyGraph();
    // The city's buildings and districts name these same ids; a member has
    // no building, so it carries none and the artifact does not grow for it.
    expect(nodeByName(model, "p").id).toBe(pkg("p").id);
    expect(nodeByName(model, "A").id).toBe(type("A", "p").id);
    expect(nodeByName(model, "m").id).toBeUndefined();
    expect(nodeByName(model, "f").id).toBeUndefined();
  });

  it("resolves declaredType to a node index", () => {
    const model = toyGraph();
    expect(nodeByName(model, "f").declaredType).toBe(indexByName(model, "C"));
  });
});

describe("dependency rows", () => {
  it("classifies reference roles from the source entity, attributed to the carrying member", () => {
    const model = toyGraph();
    const a = indexByName(model, "A");
    const c = indexByName(model, "C");
    const m = indexByName(model, "m");
    const f = indexByName(model, "f");

    const between = model.deps.filter((dep) => dep.from === a && dep.to === c);
    const roles = between.map((dep) => dep.role).sort();
    expect(roles).toEqual(["fieldType", "invokes", "localVariableType", "parameterType", "reads", "writes"]);

    const parameter = between.find((dep) => dep.role === "parameterType");
    expect(parameter?.member).toBe(m);
    expect(parameter?.detail).toBe("parameter #1 (x)");
    const localRow = between.find((dep) => dep.role === "localVariableType");
    expect(localRow?.member).toBe(m);
    expect(localRow?.detail).toBe("local variable v");
    expect(between.find((dep) => dep.role === "fieldType")?.member).toBe(f);
  });

  it("carries the target member: invoked operation, accessed attribute", () => {
    const model = toyGraph();
    const n = indexByName(model, "n");
    const g = indexByName(model, "g");
    expect(model.deps.find((dep) => dep.role === "invokes")?.toMember).toBe(n);
    expect(model.deps.find((dep) => dep.role === "reads")?.toMember).toBe(g);
  });

  it("emits BOTH rows for a compound access — a read and a write, same anchor", () => {
    const model = toyGraph();
    const reads = model.deps.find((dep) => dep.role === "reads");
    const writes = model.deps.find((dep) => dep.role === "writes");
    expect(reads).toBeDefined();
    expect(writes).toBeDefined();
    expect(reads?.anchor).toEqual(writes?.anchor);
  });

  it("never contains a self dependency; owners are always types or modules", () => {
    const model = toyGraph();
    for (const dep of model.deps) {
      expect(dep.from).not.toBe(dep.to);
      expect(["type", "module"]).toContain(model.nodes[dep.from]?.category);
      expect(["type", "module"]).toContain(model.nodes[dep.to]?.category);
    }
  });

  it("counts an intra-type edge as internal cohesion, not a dependency", () => {
    const entities = [pkg("p"), type("A", "p"), method("m1", "A"), method("m2", "A")];
    const model = buildNavigator(graphOf(entities, [edge("invocation", "m1", "m2")]));
    expect(model.deps).toHaveLength(0);
    expect(model.diagnostics.selfDeps).toBe(1);
  });
});

describe("views, metrics, closure", () => {
  it("drops stub nodes and their edges under internalOnly", () => {
    const entities = [pkg("p"), type("A", "p"), pkg("ext", true), stubType("S", "ext")];
    const edges = [edge("reference", "A", "S")];
    const full = buildNavigator(graphOf(entities, edges));
    const internal = buildNavigator(graphOf(entities, edges), { view: internalOnly });
    expect(full.nodes.map((node) => node.name)).toContain("S");
    expect(full.deps).toHaveLength(1);
    expect(internal.nodes.map((node) => node.name)).not.toContain("S");
    expect(internal.deps).toHaveLength(0);
    expect(internal.view.name).toBe("internalOnly");
  });

  it("agrees with coupling(): distinct counterparts, self excluded", () => {
    const model = toyGraph();
    expect(nodeByName(model, "A").metrics).toEqual({ fanIn: 0, fanOut: 1, instability: 1 });
    expect(nodeByName(model, "C").metrics).toEqual({ fanIn: 1, fanOut: 0, instability: 0 });
  });

  it("closes every index: parents, children, roots, deps, anchors, declaredType", () => {
    const model = toyGraph();
    const inNodes = (index: number) => index >= 0 && index < model.nodes.length;
    const inFiles = (index: number) => index >= 0 && index < model.files.length;
    for (const root of model.roots) expect(inNodes(root)).toBe(true);
    for (const node of model.nodes) {
      if (node.parent !== undefined) expect(inNodes(node.parent)).toBe(true);
      if (node.declaredType !== undefined) expect(inNodes(node.declaredType)).toBe(true);
      if (node.anchor !== undefined) expect(inFiles(node.anchor[0])).toBe(true);
      for (const child of node.children) expect(inNodes(child)).toBe(true);
    }
    for (const dep of model.deps) {
      expect(inNodes(dep.from)).toBe(true);
      expect(inNodes(dep.to)).toBe(true);
      if (dep.member !== undefined) expect(inNodes(dep.member)).toBe(true);
      if (dep.toMember !== undefined) expect(inNodes(dep.toMember)).toBe(true);
      expect(inFiles(dep.anchor[0])).toBe(true);
    }
  });
});

describe("the artefact", () => {
  it("is deterministic: two builds are byte-identical", () => {
    expect(navigatorToJsonString(toyGraph())).toBe(navigatorToJsonString(toyGraph()));
  });

  it("carries the derived-artefact markers and no schemaVersion", () => {
    const text = navigatorToJsonString(toyGraph());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["kind"]).toBe(NAVIGATOR_ARTEFACT_KIND);
    expect(parsed["generatedBy"]).toBe("@codegraph/navigator");
    expect("schemaVersion" in parsed).toBe(false);
  });

  it("is compact by default, pretty on request", () => {
    const model = toyGraph();
    expect(navigatorToJsonString(model)).not.toContain("\n");
    expect(navigatorToJsonString(model, { pretty: true }).endsWith("\n")).toBe(true);
  });
});
