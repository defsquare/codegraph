import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel } from "../src/index.js";
import { csharpGraph } from "./fixture.js";

/** Real Roslyn output over fixtures/csharp/src — the rules survive a second language's shapes. */
function model(): NavigatorModel {
  return buildNavigator(csharpGraph());
}

describe("navigator over the csharp fixture", () => {
  it("nests namespaces by the DECLARED parent, never by the dotted name", () => {
    const built = model();
    const legacy = built.nodes.find((node) => node.name === "Acme.Order.Legacy");
    expect(legacy).toBeDefined();
    expect(built.nodes[legacy?.parent ?? -1]?.name).toBe("Acme.Order");
    // A dotted, non-nested declaration stands as a root; so does a stub namespace.
    const adapter = built.nodes.find((node) => node.name === "Acme.Order.Adapter");
    expect(adapter?.parent).toBeUndefined();
    const unresolved = built.nodes.find((node) => node.name === "<unresolved>");
    expect(unresolved?.isStub).toBe(true);
  });

  it("flattens local functions and lambdas as operations of their containing type", () => {
    const built = model();
    // `Money.Zero()` and the local function `Zero` inside `Notifications.FreeOf`
    // are two operations; the tree keeps every invocable FLAT under its type.
    const zeros = built.nodes.filter((node) => node.name === "Zero" && node.category === "operation");
    expect(zeros.map((node) => built.nodes[node.parent ?? -1]?.name).sort()).toEqual(["Money", "Notifications"]);
    const lambdas = built.nodes.filter((node) => built.nodes[node.parent ?? -1]?.name === "Notifications" && node.category === "operation");
    expect(lambdas.length).toBeGreaterThan(8);
  });

  it("classifies the C# edge kinds into the shared role vocabulary", () => {
    const roles = new Set(model().deps.map((dep) => dep.role));
    for (const role of ["import", "extends", "implements", "invokes", "reads", "returnType", "parameterType", "fieldType", "typeReference"]) {
      expect(roles, role).toContain(role);
    }
  });
});
