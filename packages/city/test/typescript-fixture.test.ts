import { describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import { typescriptGraph } from "./fixture.js";

/**
 * The city over the compiler-API snapshot: districts are FILES (the module is
 * the file), buildings are every kind the TypeScript profile marks TType —
 * class, abstract class, interface, type alias, enum — and stubs stand as
 * unmeasured buildings, exactly as the Java and C# cities treat them. The
 * transform knows no language.
 */
describe("the city over the typescript fixture", () => {
  const city = buildCity(typescriptGraph());

  it("makes a district of every module, files and the corpus-declared ambient module alike", () => {
    const names = new Map(city.districts.map((d) => [d.id, d]));
    expect(names.has("ts:packages%2Forder%2Fsrc%2Forder.ts")).toBe(true);
    expect(names.has("ts:legacy-lib")).toBe(true);
    expect(names.get("ts:packages%2Forder%2Fsrc%2Forder.ts")?.parent).toBeUndefined();
  });

  it("makes a building of every type kind, aliases and const enums included", () => {
    const kinds = new Map(city.buildings.map((b) => [b.id, b.kind]));
    expect(kinds.get("ts:packages%2Forder%2Fsrc%2Fmoney.ts/Money")).toBe("class");
    expect(kinds.get("ts:packages%2Forder%2Fsrc%2Fmoney.ts/Cents")).toBe("typeAlias");
    expect(kinds.get("ts:packages%2Forder%2Fsrc%2Fchannel.ts/Priority")).toBe("enum");
    expect(kinds.get("ts:packages%2Forder%2Fsrc%2Fabstract-order.ts/AbstractOrder")).toBe("abstractClass");
    expect(kinds.get("ts:packages%2Forder%2Fsrc%2Fpriceable.ts/Priceable")).toBe("interface");
    expect(kinds.get("ts:legacy%2Facme.ts/Acme.Order.Registry")).toBe("class");
    // Members, locals, parameters and arrows are not buildings.
    expect([...kinds.keys()].some((id) => id.includes("#") || /\.[a-z]/.test(id.split("/").at(-1) ?? ""))).toBe(false);
  });

  it("draws arrows for the folded dependencies and marks stubs", () => {
    expect(city.arrows.length).toBeGreaterThan(10);
    const stubs = city.buildings.filter((b) => b.isStub).map((b) => b.id);
    expect(stubs).toContain("ts:<lib>/Error");
    expect(stubs).toContain("ts:<unresolved>/LedgerClient");
  });
});
