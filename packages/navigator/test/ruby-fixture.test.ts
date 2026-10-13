import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel } from "../src/index.js";
import { rubyGraph } from "./fixture.js";

/** Real Prism output over fixtures/ruby/src — the rules survive a fifth language's shapes. */
function model(): NavigatorModel {
  return buildNavigator(rubyGraph());
}

describe("navigator over the ruby fixture", () => {
  it("roots every file as a module named by its path, with its classes as types below", () => {
    const built = model();
    const order = built.nodes.find((node) => node.name === "lib/acme_order/order.rb");
    expect(order).toBeDefined();
    expect(order?.parent).toBeUndefined();
    const type = built.nodes.find((node) => node.name === "AcmeOrder::Order" && node.id?.includes("order.rb"));
    expect(type?.category).toBe("type");
    expect(built.nodes[type?.parent ?? -1]?.name).toBe("lib/acme_order/order.rb");
    // A type written inside a declared type is below it.
    const line = built.nodes.find((node) => node.name === "AcmeOrder::Order::Line");
    expect(built.nodes[line?.parent ?? -1]?.name).toBe("AcmeOrder::Order");
    expect(built.nodes.find((node) => node.name === "<ruby>")?.isStub).toBe(true);
    expect(built.nodes.find((node) => node.name === "<gems>")?.isStub).toBe(true);
  });

  it("lists a class's methods as operations and its fields and constants as attributes", () => {
    const built = model();
    const type = built.nodes.find((node) => node.name === "AcmeOrder::Order" && node.id?.includes("order.rb"));
    const index = built.nodes.indexOf(type!);
    const members = built.nodes.filter((node) => node.parent === index);
    const named = (category: string): string[] =>
      members.filter((node) => node.category === category).map((node) => node.name);
    expect(named("operation")).toContain("total");
    // `def self.call` and `def call` are two operations.
    expect(named("operation").filter((name) => name === "call")).toHaveLength(2);
    expect(named("attribute")).toContain("@lines");
    expect(named("attribute")).toContain("AcmeOrder::Order::MAX_LINES");
  });

  it("classifies the Ruby edge kinds into the shared role vocabulary", () => {
    const roles = new Set(model().deps.map((dep) => dep.role));
    for (const role of ["import", "extends", "usesTrait", "invokes", "reads", "writes", "typeReference"]) {
      expect(roles, role).toContain(role);
    }
  });
});
