import { describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import { rubyGraph } from "./fixture.js";

const LIB = "rb:lib%2Facme_order%2F";

/**
 * The city over the Prism snapshot: districts are FILES (the module is the
 * file), buildings are every `class` and `module` (the Ruby profile marks
 * both TType) — a reopening in another file a building of its own in that
 * file's district — and what the corpus does not declare stands as unmeasured
 * stub buildings below `<ruby>` and `<gems>`. The transform knows no language.
 */
describe("the city over the ruby fixture", () => {
  const city = buildCity(rubyGraph());

  it("makes a district of every corpus file that declares a type", () => {
    const districts = new Map(city.districts.map((d) => [d.id, d]));
    expect(districts.has(`${LIB}order.rb`)).toBe(true);
    expect(districts.get(`${LIB}order.rb`)?.parent).toBeUndefined();
    // A wrapper body declares nothing: errors.rb holds its three classes and no `AcmeOrder`.
    const inErrors = city.buildings.filter((b) => b.district === `${LIB}errors.rb`).map((b) => b.id);
    expect(inErrors.sort()).toEqual([
      `${LIB}errors.rb/AcmeOrder::Error`,
      `${LIB}errors.rb/AcmeOrder::NotFound`,
      `${LIB}errors.rb/AcmeOrder::TooManyLines`,
    ]);
  });

  it("makes a building of every class and module, nested and reopened ones alike", () => {
    const kinds = new Map(city.buildings.map((b) => [b.id, b.kind]));
    expect(kinds.get(`${LIB}order.rb/AcmeOrder::Order`)).toBe("class");
    expect(kinds.get(`${LIB}order.rb/AcmeOrder::Order::Line`)).toBe("class");
    expect(kinds.get(`${LIB}priceable.rb/AcmeOrder::Priceable`)).toBe("module");
    // `Point = Struct.new(…)` is a class; a reopening is a building where it is written.
    expect(kinds.get(`${LIB}point.rb/AcmeOrder::Point`)).toBe("class");
    expect(kinds.get(`${LIB}a_order_patch.rb/AcmeOrder::Order`)).toBe("class");
    // Methods, fields, constants and parameters are not buildings.
    for (const kind of kinds.values()) expect(["class", "module"]).toContain(kind);
  });

  it("draws arrows for the folded dependencies and marks stubs", () => {
    expect(city.arrows.length).toBeGreaterThan(10);
    const stubs = city.buildings.filter((b) => b.isStub).map((b) => b.id);
    expect(stubs).toContain("rb:<ruby>/StandardError");
    expect(stubs).toContain("rb:<gems>/ActiveRecord::Base");
    // A corpus body of a core class is a real building; the VM's `String` beside it is the stub.
    expect(stubs).toContain("rb:<ruby>/String");
    expect(stubs).not.toContain(`${LIB}core_ext%2Fstring.rb/String`);
  });
});
