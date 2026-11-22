import { describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import { pythonGraph } from "./fixture.js";

const PKG = "python:src%2Facme_order%2F";

/**
 * The city over the Ruff-parser snapshot: districts are FILES (the module is
 * the file, a package its `__init__.py`, and no package holds its submodules),
 * buildings are every `class` — nested, written in a function, or made by a
 * call — and what the corpus does not declare stands as unmeasured stub
 * buildings below `<builtins>`, a `<stdlib>` module or a `<site>` one, each
 * named as the import writes it. The transform knows no language.
 */
describe("the city over the python fixture", () => {
  const city = buildCity(pythonGraph());

  it("makes a flat district of every file that declares a class, named by its path", () => {
    const districts = new Map(city.districts.map((d) => [d.id, d]));
    for (const district of city.districts) expect(district.parent, district.id).toBeUndefined();
    expect(districts.get(`${PKG}orders%2Forder.py`)?.name).toBe("src/acme_order/orders/order.py");
    expect(districts.get(`${PKG}pricing%2F__init__.py`)?.name).toBe("src/acme_order/pricing/__init__.py");
    // A file that declares no class (variables, functions, imports) is no district.
    expect(districts.has(`${PKG}settings.py`)).toBe(false);
    expect(districts.has(`${PKG}retry.py`)).toBe(false);
    // A stub module is named as the import writes it.
    expect(districts.get("python:<site>%2Fdjango.db")?.name).toBe("django.db");
    expect(districts.get("python:<site>%2Fdjango.db")?.isStub).toBe(true);
  });

  it("makes a building of every class, wherever it is written and however it is made", () => {
    const buildings = new Map(city.buildings.map((b) => [b.id, b]));
    for (const building of city.buildings) expect(building.kind, building.id).toBe("class");
    const inOrder = city.buildings.filter((b) => b.district === `${PKG}orders%2Forder.py`).map((b) => b.id);
    expect(inOrder.sort()).toEqual([`${PKG}orders%2Forder.py/Order`, `${PKG}orders%2Forder.py/Order.Line`]);
    // A class written in a function, and classes a call makes, stand in their file's district.
    expect(buildings.get(`${PKG}factory.py/make.Local`)?.district).toBe(`${PKG}factory.py`);
    expect(buildings.get(`${PKG}money.py/Amount`)?.district).toBe(`${PKG}money.py`);
    expect(buildings.get(`${PKG}records.py/Totals`)?.district).toBe(`${PKG}records.py`);
    // A class's methods, its property's accessors included, and its attributes are its own.
    const order = buildings.get(`${PKG}orders%2Forder.py/Order`);
    expect(order?.attributes.map((a) => a.name)).toEqual(["currency", "lines", "reference"]);
    expect(order?.operations.length).toBe(4);
  });

  it("measures every corpus building and no stub, and marks stubs", () => {
    for (const building of city.buildings) {
      expect(building.metrics["loc"] === null, building.id).toBe(building.isStub);
    }
    const stubs = city.buildings.filter((b) => b.isStub).map((b) => b.id);
    expect(stubs).toContain("python:<builtins>/Exception");
    expect(stubs).toContain("python:<stdlib>%2Fenum/Enum");
    expect(stubs).toContain("python:<site>%2Fdjango.db/models.Model");
    // A relative import to a file that is not there: a stub, never a corpus building.
    expect(stubs).toContain(`${PKG}pricing%2Fmissing.py/Seasonal`);
  });

  it("draws an arrow per folded dependency, inferred exactly when an edge is not declared", () => {
    expect(city.arrows.length).toBeGreaterThan(10);
    for (const arrow of city.arrows) {
      expect(arrow.inferred, `${arrow.from} → ${arrow.to}`).toBe(arrow.provenances.some((p) => p !== "declared"));
    }
    const arrow = (from: string, to: string) => city.arrows.find((a) => a.from === from && a.to === to);
    expect(arrow(`${PKG}orders%2Forder.py/Order`, `${PKG}orders%2Fbase.py/Base`)?.inferred).toBe(false);
    // A base read through an alias, and the base a `namedtuple(…)` call gives: inferences.
    expect(arrow(`${PKG}aliases.py/Ledger`, `${PKG}orders%2Fbase.py/Auditable`)?.provenances).toEqual(["derived"]);
    expect(arrow(`${PKG}money.py/Amount`, "python:<builtins>/tuple")?.provenances).toEqual(["generated"]);
  });
});
