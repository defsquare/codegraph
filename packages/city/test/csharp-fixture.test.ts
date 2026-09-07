import { describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import { csharpGraph } from "./fixture.js";

/**
 * The city over the Roslyn snapshot: districts are namespaces, buildings are
 * every kind the C# profile marks TType — class, interface, struct, enum,
 * record, delegate — and stubs stand as unmeasured buildings, exactly as the
 * Java city treats them. The transform knows no language.
 */
describe("the city over the csharp fixture", () => {
  const city = buildCity(csharpGraph());

  it("makes a district of every namespace, nested where the model declares a parent", () => {
    const names = new Map(city.districts.map((d) => [d.id, d]));
    expect(names.has("csharp:Acme.Order")).toBe(true);
    expect(names.get("csharp:Acme.Order.Legacy")?.parent).toBe("csharp:Acme.Order");
    expect(names.get("csharp:Acme.Order.Adapter")?.parent).toBeUndefined();
  });

  it("makes a building of every type kind, records, structs and delegates included", () => {
    const kinds = new Map(city.buildings.map((b) => [b.id, b.kind]));
    expect(kinds.get("csharp:Acme.Order/Money")).toBe("record");
    expect(kinds.get("csharp:Acme.Order/Channel")).toBe("enum");
    expect(kinds.get("csharp:Acme.Order/ShipmentHandler")).toBe("delegate");
    expect(kinds.get("csharp:Acme.Order/IPriceable")).toBe("interface");
    expect(kinds.get("csharp:Acme.Order/Basket.Line.Discount")).toBe("class");
    // Members, locals and lambdas are not buildings.
    expect([...kinds.keys()].some((id) => id.includes("#") || id.includes("("))).toBe(false);
  });

  it("draws arrows for the folded dependencies and marks stubs", () => {
    expect(city.arrows.length).toBeGreaterThan(50);
    const stubs = city.buildings.filter((b) => b.isStub).map((b) => b.id);
    expect(stubs).toContain("csharp:System/String");
    expect(stubs).toContain("csharp:<unresolved>/LedgerClient");
  });
});
