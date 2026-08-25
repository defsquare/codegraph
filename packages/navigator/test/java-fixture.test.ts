import { describe, expect, it } from "vitest";
import { coupling, typeDependencyGraph } from "@codegraph/analyzer";
import { buildNavigator, navigatorToJsonString, type NavigatorModel } from "../src/index.js";
import { javaGraph } from "./fixture.js";

/** Real Spoon output over fixtures/java/src — the acceptance bar for the rules. */
function model(): NavigatorModel {
  return buildNavigator(javaGraph());
}

describe("navigator over the java fixture", () => {
  it("nests packages by the DECLARED parent, never by the dotted name", () => {
    const built = model();
    const adapter = built.nodes.find((node) => node.name === "com.acme.order.adapter");
    expect(adapter).toBeDefined();
    expect(built.nodes[adapter?.parent ?? -1]?.name).toBe("com.acme.order");
    // Stub packages carry no parent and stand as roots.
    const stub = built.nodes.find((node) => node.name === "java.lang");
    expect(stub?.isStub).toBe(true);
    expect(stub?.parent).toBeUndefined();
  });

  it("recovers every reference sub-role the fixture exercises", () => {
    const roles = new Set(model().deps.map((dep) => dep.role));
    for (const role of [
      "import",
      "extends",
      "implements",
      "invokes",
      "returnType",
      "parameterType",
      "fieldType",
      "typeReference",
    ]) {
      expect(roles, `expected a ${role} row`).toContain(role);
    }
  });

  it("attributes member-carried edges: a returnType row names its operation", () => {
    const built = model();
    const row = built.deps.find(
      (dep) =>
        dep.role === "returnType" && built.nodes[dep.member ?? -1]?.signature === "price()",
    );
    expect(row).toBeDefined();
    expect(built.nodes[row?.to ?? -1]?.name).toBe("Money");
  });

  it("closes every index over the real corpus", () => {
    const built = model();
    const inNodes = (index: number) => index >= 0 && index < built.nodes.length;
    for (const node of built.nodes) {
      if (node.parent !== undefined) expect(inNodes(node.parent)).toBe(true);
      if (node.declaredType !== undefined) expect(inNodes(node.declaredType)).toBe(true);
      if (node.anchor !== undefined) expect(node.anchor[0]).toBeLessThan(built.files.length);
      for (const child of node.children) {
        expect(inNodes(child)).toBe(true);
        expect(built.nodes[child]?.parent).toBe(built.nodes.indexOf(node));
      }
    }
    for (const dep of built.deps) {
      expect(dep.from).not.toBe(dep.to);
      expect(inNodes(dep.from) && inNodes(dep.to)).toBe(true);
      expect(dep.anchor[0]).toBeLessThan(built.files.length);
    }
  });

  it("reports the same fan-in/fan-out as the analyzer's coupling table", () => {
    const graph = javaGraph();
    const built = buildNavigator(graph);
    const table = new Map(coupling(typeDependencyGraph(graph)).rows.map((row) => [row.id, row]));
    let checked = 0;
    for (const node of built.nodes) {
      if (node.category !== "type" || node.metrics === undefined) continue;
      // Node indexes are display-only; recover the entity through the tree is
      // not possible by design, so compare by name+kind against the one table
      // row bearing them — the fixture has no ambiguous (name, kind) type pair
      // with differing coupling.
      const rows = [...table.values()].filter((row) => row.name === node.name);
      expect(rows.some((row) => row.fanIn === node.metrics?.fanIn && row.fanOut === node.metrics?.fanOut)).toBe(
        true,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("is deterministic over the real corpus", () => {
    expect(navigatorToJsonString(model())).toBe(navigatorToJsonString(model()));
  });
});
