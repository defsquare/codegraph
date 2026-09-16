import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel } from "../src/index.js";
import { elixirGraph } from "./fixture.js";

/** Real parser-as-library output over fixtures/elixir/src — the rules survive a fourth language's shapes. */
function model(): NavigatorModel {
  return buildNavigator(elixirGraph());
}

describe("navigator over the elixir fixture", () => {
  it("roots every file as a module named by its path, with its defmodules as types below", () => {
    const built = model();
    const order = built.nodes.find((node) => node.name === "lib/acme_order/order.ex");
    expect(order).toBeDefined();
    expect(order?.parent).toBeUndefined();
    const type = built.nodes.find((node) => node.name === "AcmeOrder.Order" && node.category === "type");
    expect(built.nodes[type?.parent ?? -1]?.name).toBe("lib/acme_order/order.ex");
    const otp = built.nodes.find((node) => node.name === "<otp>");
    expect(otp?.isStub).toBe(true);
  });

  it("lists a defmodule's functions as operations and its fields and attributes as attributes", () => {
    const built = model();
    const type = built.nodes.find((node) => node.name === "AcmeOrder.Order" && node.category === "type");
    const index = built.nodes.indexOf(type!);
    const members = built.nodes.filter((node) => node.parent === index);
    expect(members.filter((node) => node.category === "operation").map((node) => node.name)).toContain("total");
    expect(members.filter((node) => node.category === "attribute").map((node) => node.name)).toContain("lines");
    expect(members.filter((node) => node.category === "attribute").map((node) => node.name)).toContain("@max_lines");
  });

  it("classifies the Elixir edge kinds into the shared role vocabulary", () => {
    const roles = new Set(model().deps.map((dep) => dep.role));
    for (const role of ["import", "implements", "invokes", "reads", "writes", "typeReference"]) {
      expect(roles, role).toContain(role);
    }
  });
});
