import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel } from "../src/index.js";
import { typescriptGraph } from "./fixture.js";

/** Real compiler-API output over fixtures/typescript/src — the rules survive a third language's shapes. */
function model(): NavigatorModel {
  return buildNavigator(typescriptGraph());
}

describe("navigator over the typescript fixture", () => {
  it("roots every file as a module named by its path, and hoists a namespace's types to their file", () => {
    const built = model();
    const order = built.nodes.find((node) => node.name === "packages/order/src/order.ts");
    expect(order).toBeDefined();
    expect(order?.parent).toBeUndefined();
    // A `namespace` is a child entity, not a module: the tree shows its types under the FILE.
    const registry = built.nodes.find((node) => node.name === "Registry" && node.category === "type");
    expect(built.nodes[registry?.parent ?? -1]?.name).toBe("legacy/acme.ts");
    const unresolved = built.nodes.find((node) => node.name === "<unresolved>");
    expect(unresolved?.isStub).toBe(true);
  });

  it("flattens arrows and function expressions as operations of their containing type or module", () => {
    const built = model();
    const notifications = built.nodes.find((node) => node.name === "packages/order/src/notifications.ts");
    expect(notifications).toBeDefined();
    const operations = built.nodes.filter((node) => node.parent === built.nodes.indexOf(notifications!) && node.category === "operation");
    expect(operations.length).toBeGreaterThan(4);
  });

  it("classifies the TypeScript edge kinds into the shared role vocabulary", () => {
    const roles = new Set(model().deps.map((dep) => dep.role));
    for (const role of ["import", "extends", "implements", "invokes", "reads", "writes", "returnType", "parameterType", "fieldType", "typeReference"]) {
      expect(roles, role).toContain(role);
    }
  });
});
