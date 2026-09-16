import { describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import { elixirGraph } from "./fixture.js";

/**
 * The city over the parser-as-library snapshot: districts are FILES (the
 * module is the file), buildings are every `defmodule` and `defprotocol`
 * (the Elixir profile marks both TType), and the external modules stand as
 * unmeasured stub buildings below the `<otp>` and `<deps>` districts. The
 * transform knows no language.
 */
describe("the city over the elixir fixture", () => {
  const city = buildCity(elixirGraph());

  it("makes a district of every corpus file, scripts included", () => {
    const names = new Map(city.districts.map((d) => [d.id, d]));
    expect(names.has("ex:lib%2Facme_order%2Forder.ex")).toBe(true);
    // A script file with no defmodule holds no building and so no district; mix.exs holds one.
    expect(names.has("ex:mix.exs")).toBe(true);
    expect(names.get("ex:lib%2Facme_order%2Forder.ex")?.parent).toBeUndefined();
  });

  it("makes a building of every defmodule, nested ones and defimpl modules alike", () => {
    const kinds = new Map(city.buildings.map((b) => [b.id, b.kind]));
    expect(kinds.get("ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder")).toBe("module");
    expect(kinds.get("ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable")).toBe("protocol");
    expect(kinds.get("ex:lib%2Facme_order%2Fnotifier.ex/AcmeOrder%2ENotifier%2ESms%2EGateway")).toBe("module");
    expect(kinds.get("ex:lib%2Facme_order%2Fmoney.ex/String%2EChars%2EAcmeOrder%2EMoney")).toBe("module");
    // Functions, fields, attributes and parameters are not buildings.
    expect([...kinds.keys()].some((id) => id.includes("#") || id.includes(".@"))).toBe(false);
  });

  it("draws arrows for the folded dependencies and marks stubs", () => {
    expect(city.arrows.length).toBeGreaterThan(10);
    const stubs = city.buildings.filter((b) => b.isStub).map((b) => b.id);
    expect(stubs).toContain("ex:<otp>/GenServer");
    expect(stubs).toContain("ex:<deps>/Ecto%2ESchema");
  });
});
