import { declaredOnly, internalOnly } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { buildNavigator, type NavigatorModel, type NavNode } from "../src/index.js";
import { pythonGraph } from "./fixture.js";

/** Real Ruff-parser output over fixtures/python/src — the rules survive a sixth language's shapes. */
function model(options: Parameters<typeof buildNavigator>[1] = {}): NavigatorModel {
  return buildNavigator(pythonGraph(), options);
}

const byId = (built: NavigatorModel, id: string): NavNode | undefined => built.nodes.find((node) => node.id === id);

function childrenOf(built: NavigatorModel, node: NavNode | undefined, category: string): string[] {
  return (node?.children ?? [])
    .map((index) => built.nodes[index] as NavNode)
    .filter((child) => child.category === category)
    .map((child) => child.name);
}

describe("navigator over the python fixture", () => {
  it("roots every file as a module named by its path — packages hold no submodules — with its classes below", () => {
    const built = model();
    for (const root of built.roots) expect(built.nodes[root]?.category).toBe("module");
    const order = built.nodes.find((node) => node.name === "src/acme_order/orders/order.py");
    expect(order?.parent).toBeUndefined();
    const pricing = built.nodes.find((node) => node.name === "src/acme_order/pricing/__init__.py");
    expect(pricing?.parent).toBeUndefined();
    expect(childrenOf(built, pricing, "module")).toEqual([]);
    // A class written inside a class is below it.
    const type = byId(built, "python:src%2Facme_order%2Forders%2Forder.py/Order");
    expect(type?.category).toBe("type");
    expect(built.nodes[type?.parent ?? -1]?.name).toBe("src/acme_order/orders/order.py");
    expect(childrenOf(built, type, "type")).toEqual(["Line"]);
    // What the corpus does not declare: stub roots, named as the import writes them.
    expect(built.nodes.find((node) => node.name === "<builtins>")?.isStub).toBe(true);
    expect(byId(built, "python:<site>%2Fdjango.db")?.name).toBe("django.db");
    expect(byId(built, "python:<site>%2Fdjango.db")?.isStub).toBe(true);
  });

  it("lists a module's functions and variables, and a class's methods and attributes, as its members", () => {
    const built = model();
    const settings = built.nodes.find((node) => node.name === "src/acme_order/settings.py");
    expect(childrenOf(built, settings, "operation")).toEqual(["bump"]);
    expect(childrenOf(built, settings, "attribute")).toEqual(["DEBUG", "DEFAULT_CURRENCY", "HOOKS", "counter"]);
    const order = byId(built, "python:src%2Facme_order%2Forders%2Forder.py/Order");
    // A property, its setter and its deleter are three operations of one name.
    expect(childrenOf(built, order, "operation")).toEqual(["__init__", "total", "total", "total"]);
    // `self.x = …` in a method is an attribute of the class.
    expect(childrenOf(built, order, "attribute")).toEqual(["currency", "lines", "reference"]);
  });

  it("classifies the Python edge kinds into the shared role vocabulary, inferences kept apart", () => {
    const built = model();
    const roles = new Set(built.deps.map((dep) => dep.role));
    for (const role of ["import", "extends", "invokes", "reads", "typeReference", "returnType"]) {
      expect(roles, role).toContain(role);
    }
    for (const dep of built.deps) expect(["declared", "derived", "generated"]).toContain(dep.provenance);
    // `self.repository = Repository()` in `__init__` is a fact; `self.repository.save()` in
    // `run` reads an attribute only ever assigned that class: an inference, on rows of its own.
    const service = built.nodes.findIndex((node) => node.id === "python:src%2Facme_order%2Fservices.py/Service");
    const repository = built.nodes.findIndex((node) => node.id === "python:src%2Facme_order%2Frepository.py/Repository");
    const rows = built.deps.filter((dep) => dep.from === service && dep.to === repository);
    const via = (member: string) => rows.filter((row) => built.nodes[row.member ?? -1]?.name === member);
    expect(via("__init__").map((row) => row.provenance)).toEqual(["declared"]);
    expect(via("run").length).toBeGreaterThan(0);
    for (const row of via("run")) expect(row.provenance).toBe("derived");
    // A base a `namedtuple(…)` call gives: a generated row.
    const amount = built.nodes.findIndex((node) => node.id === "python:src%2Facme_order%2Fmoney.py/Amount");
    expect(built.deps.find((dep) => dep.from === amount)?.provenance).toBe("generated");
  });

  it("keeps facts alone under declaredOnly and drops every stub under internalOnly", () => {
    const declared = model({ view: declaredOnly });
    for (const dep of declared.deps) expect(dep.provenance).toBe("declared");
    expect(declared.deps.length).toBeLessThan(model().deps.length);
    const internal = model({ view: internalOnly });
    for (const node of internal.nodes) expect(node.isStub, node.name).toBe(false);
    expect(internal.nodes.some((node) => node.id === "python:src%2Facme_order%2Forders%2Forder.py/Order")).toBe(true);
  });
});
