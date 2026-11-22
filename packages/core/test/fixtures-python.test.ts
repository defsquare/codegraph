import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { pythonProfile } from "../src/profiles/python.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M22a ACCEPTANCE GATE — the Java, C#, TypeScript, Elixir and Ruby gates,
 * replayed for the sixth extractor, the first whose parser is not the
 * language's own. The extractor's cargo suite pins the snapshot and the CLI;
 * what only this side can say is that the composition is one the Python
 * PROFILE licenses — data the extractor never imports — and that two
 * independent encoders, one in Rust and one here, write the same bytes.
 */

const SNAPSHOT = fileURLToPath(new URL("../../../fixtures/python/expected/model.jsonl", import.meta.url));

const PKG = "python:src%2Facme_order%2F";
const ORDER = `${PKG}orders%2Forder.py/Order`;

function loadSnapshot(): Model {
  return parseModel(readModelFileSync(SNAPSHOT));
}

type Bag = Record<string, unknown>;

function entity(model: Model, id: string): Bag {
  const found = model.entities.find((candidate) => candidate.id === id);
  expect(found, id).toBeDefined();
  return found as unknown as Bag;
}

function hasEdge(model: Model, edge: string, from: string, to: string, provenance = "declared"): boolean {
  return model.edges.some((e) => e.edge === edge && e.from === from && e.to === to && e.provenance === provenance);
}

/** The targets of one kind of edge leaving one entity, sorted by code unit. */
function targets(model: Model, edge: string, from: string): string[] {
  return model.edges
    .filter((e) => e.edge === edge && e.from === from)
    .map((e) => e.to)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("fixtures/python/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the Python profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), pythonProfile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    expect(unknownReferences(loadSnapshot()).map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges, and only provenances the profile's notes license", () => {
    const model = loadSnapshot();
    expect(selfReferences(model).map((s) => s.path)).toEqual([]);
    // The extractor writes facts and its own counted inferences: a `dynamic-candidate` comes
    // only from a run-time trace, and Protocol conformance is the analyzer's.
    for (const e of model.edges) {
      expect(["declared", "derived", "generated"], `${e.edge} ${e.from}`).toContain(e.provenance);
      expect(e.edge, e.from).not.toBe("interfaceImplementation");
      expect(pythonProfile.edges, e.edge).toContain(e.edge);
    }
  });

  it("names the extractor, the parser's tag and the typeshed commit the stubs were decided by", () => {
    const header = JSON.parse(readFileSync(SNAPSHOT, "utf8").split("\n")[0] as string) as {
      lang: string;
      root: string;
      extractor: Record<string, unknown>;
    };
    expect(header.lang).toBe("python");
    expect(header.root).toBe("fixtures/python/src");
    expect(header.extractor["name"]).toBe("codegraph-python");
    expect(header.extractor["ruff"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(header.extractor["typeshed"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("makes the FILE the module, keyed and named by its path, parent of none (PLAN §23.3)", () => {
    const model = loadSnapshot();
    const order = entity(model, `${PKG}orders%2Forder.py`);
    expect(order["kind"]).toBe("module");
    expect(order["name"]).toBe("src/acme_order/orders/order.py");
    expect(order["definedIn"]).toEqual(["src/acme_order/orders/order.py"]);
    // A package is its __init__.py, a module like the others.
    expect(entity(model, `${PKG}__init__.py`)["kind"]).toBe("module");
    for (const e of model.entities) {
      if (e.kind === "module") expect((e as unknown as Bag)["parent"], e.id).toBeUndefined();
      else expect((e as unknown as Bag)["definedIn"], e.id).toBeUndefined();
    }
    // A `#` in a file name is escaped in the key, and the name keeps it.
    expect(entity(model, `${PKG}promo%232024.py`)["name"]).toBe("src/acme_order/promo#2024.py");
    // Nothing installed, cached or hidden is corpus; what a repository vendors is.
    for (const absent of ["FromTheEnvironment", "FromADotDirectory", "FromTheCache", "FromSitePackages"]) {
      expect(model.entities.some((e) => (e as unknown as Bag)["name"] === absent), absent).toBe(false);
    }
    expect(entity(model, `${PKG}_vendor%2Ftinyjson.py/TinyJson`)["kind"]).toBe("class");
    // A stub is a module of its own: beside its source no import names it, alone it answers one.
    expect(entity(model, `${PKG}pricing%2Fdiscounts.pyi/Discount`)["kind"]).toBe("class");
    expect(model.edges.some((e) => e.edge === "import" && e.to === `${PKG}pricing%2Fdiscounts.pyi`)).toBe(false);
    expect(hasEdge(model, "import", `${PKG}payments.py`, `${PKG}_speedups.pyi`)).toBe(true);
    // A script with no extension is Python by its shebang; a shell script beside it is not.
    expect(hasEdge(model, "import", "python:bin%2Facme-report", `${PKG}__init__.py`)).toBe(true);
    expect(model.entities.some((e) => e.id.includes("setup"))).toBe(false);
  });

  it("keys classes, functions and methods by their nesting, and accessors by the word after the dot", () => {
    const model = loadSnapshot();
    expect(entity(model, `${ORDER}.Line`)["parent"]).toBe(ORDER);
    expect(entity(model, `${ORDER}.Line.__init__`)["kind"]).toBe("method");
    const factory = `${PKG}factory.py`;
    expect(entity(model, `${factory}/make.Local`)["parent"]).toBe(`${factory}/make`);
    expect(entity(model, `${factory}/make.Local.describe`)["kind"]).toBe("method");
    // A def in a method is a function; a def in a def too.
    expect(entity(model, `${factory}/make.Local.describe.label`)["kind"]).toBe("function");
    expect(entity(model, `${factory}/outer.inner`)["kind"]).toBe("function");
    // A property and its accessors: three methods, one name.
    for (const id of [`${ORDER}.total`, `${ORDER}.total#setter`, `${ORDER}.total#deleter`]) {
      const accessor = entity(model, id);
      expect(accessor["kind"], id).toBe("method");
      expect(accessor["name"], id).toBe("total");
    }
    expect(entity(model, `${ORDER}.total#setter#param:value`)["kind"]).toBe("parameter");
    // No arity, no `static` mark: Python has no overloading.
    for (const e of model.entities) {
      if (e.kind === "method" || e.kind === "function") expect(e.id, e.id).not.toMatch(/#(?!setter$|deleter$|getter$)/);
    }
  });

  it("gives every invocable its parameters in order, every shape named", () => {
    const model = loadSnapshot();
    const quote = entity(model, `${PKG}orders%2Forder.py/quote`);
    expect(quote["signature"]).toBe("quote(order, rate=…, /, rounding=…, *extra, exact, mode=…, **flags)");
    expect(quote["parameters"]).toEqual(
      ["order", "rate", "rounding", "extra", "exact", "mode", "flags"].map((name) => `${PKG}orders%2Forder.py/quote#param:${name}`),
    );
    expect(entity(model, `${PKG}orders%2Forder.py/merge`)["signature"]).toBe("merge(*, first, second)");
    const flags = entity(model, `${PKG}orders%2Forder.py/quote#param:flags`);
    expect(flags["name"]).toBe("flags");
    expect(SourceAnchor.parse(flags["anchor"]).span).toEqual([29, 29]);
  });

  it("measures every corpus module, class and invocable, and comments what a docstring or a # block explains", () => {
    const model = loadSnapshot();
    for (const e of model.entities) {
      const bag = e as unknown as Bag;
      const metrics = bag["metrics"] as Record<string, number> | undefined;
      if (isStubEntity(e) || !["module", "class", "function", "method"].includes(e.kind)) {
        expect(metrics, e.id).toBeUndefined();
        continue;
      }
      expect(metrics?.["sloc"], e.id).toBeGreaterThanOrEqual(0);
      const invocable = e.kind === "function" || e.kind === "method";
      expect(metrics?.["cyclomatic"] !== undefined, e.id).toBe(invocable);
      if (invocable) expect(metrics?.["cyclomatic"], e.id).toBeGreaterThanOrEqual(1);
    }
    // A docstring; else the `#` block above, directives left out.
    expect(entity(model, `${PKG}packing.py`)["comments"]).toEqual(["Bases read through star imports."]);
    expect(entity(model, `${PKG}packing.py/Parcel`)["comments"]).toEqual(["`Box` is in shapes.__all__: the star binds it."]);
    expect(entity(model, `${PKG}shapes.py/Crate`)["comments"]).toEqual(["A crate: not in `__all__`."]);
  });

  it("makes a module binding a variable and a class binding an attribute, with the literal it is written as", () => {
    const model = loadSnapshot();
    const variable = entity(model, `${PKG}shapes.py/__all__`);
    expect(variable["kind"]).toBe("variable");
    expect(variable["value"]).toEqual({ k: "array", items: [{ k: "string", v: "Box" }] });
    const post = entity(model, `${PKG}shipping.py/Carrier.POST`);
    expect([post["kind"], post["parent"], post["value"]]).toEqual(["attribute", `${PKG}shipping.py/Carrier`, { k: "string", v: "post" }]);
    // `self.reference = reference` in `__init__`: an attribute of the class, and a parameter is no value.
    const reference = entity(model, `${ORDER}.reference`);
    expect([reference["kind"], reference["parent"], reference["value"]]).toEqual(["attribute", ORDER, undefined]);
    // An import holds the name an `except ImportError` fallback rebinds: no variable.
    expect(model.entities.some((e) => e.id === `${PKG}compat.py/JSONDecodeError`)).toBe(false);
    // A function's local is flow: no variable is below an invocable.
    for (const e of model.entities.filter((candidate) => candidate.kind === "variable")) {
      expect(entity(model, (e as unknown as Bag)["parent"] as string)["kind"], e.id).toBe("module");
    }
  });

  it("writes every site's edge from the body that RUNS it, an access with its direction and no other edge with one", () => {
    const model = loadSnapshot();
    const kinds = new Map(model.entities.map((e) => [e.id, e.kind]));
    for (const e of model.edges) {
      if (!["invocation", "access", "reference", "throws"].includes(e.edge)) continue;
      // An initializer's calls and reads are its module's, its class's or its method's — never the binding's.
      expect(["module", "class", "function", "method"], `${e.edge} ${e.from}`).toContain(kinds.get(e.from));
      const bag = e as unknown as Bag;
      expect(bag["isRead"] !== undefined || bag["isWrite"] !== undefined, `${e.edge} ${e.from}`).toBe(e.edge === "access");
    }
    // A decorator's use leaves what it decorates; an annotation's type is a class.
    for (const e of model.edges.filter((candidate) => candidate.edge === "annotationUse")) {
      expect(["class", "function", "method"], e.from).toContain(kinds.get(e.from));
    }
    for (const e of model.entities) {
      const declared = (e as unknown as Bag)["declaredType"] as string | undefined;
      if (declared !== undefined) expect(kinds.get(declared), `${e.id} → ${declared}`).toBe("class");
    }
    expect(entity(model, `${PKG}pricing%2Frules.py/Rule.applies_to#param:order`)["declaredType"]).toBe(ORDER);
    // A property is read as an attribute; `self.assertEqual` is the one library class that could answer.
    expect(hasEdge(model, "access", "python:bin%2Facme-report/main", `${ORDER}.total`)).toBe(true);
    const test = "python:tests%2Ftest_orders.py/TestOrder.test_total";
    expect(hasEdge(model, "invocation", test, "python:<stdlib>%2Funittest/TestCase", "derived")).toBe(true);
    // A module or a class whose own code calls says so.
    const sources = new Set(model.edges.filter((e) => e.edge === "invocation").map((e) => e.from));
    for (const e of model.entities.filter((candidate) => candidate.kind === "module" && sources.has(candidate.id))) {
      expect(e.traits, e.id).toContain("TWithInvocations");
    }
  });

  it("makes a def written twice ONE entity anchored at the first, and an NFKC twin one name", () => {
    const model = loadSnapshot();
    const dataDir = model.entities.filter((e) => e.id === `${PKG}compat.py/data_dir`);
    expect(dataDir.length).toBe(1);
    expect(SourceAnchor.parse((dataDir[0] as unknown as Bag)["anchor"]).span).toEqual([14, 15]);
    // `def ﬁnd` (U+FB01) and `def find` are one name, as the language reads them.
    const finds = model.entities.filter((e) => e.id.startsWith(`${PKG}unicode_names.py/`) && e.kind === "function");
    expect(finds.map((e) => e.id)).toEqual([`${PKG}unicode_names.py/find`]);
    expect(entity(model, `${PKG}unicode_names.py/Café`)["kind"]).toBe("class");
  });

  it("reads Python 2, a broken file, Latin-1, a BOM and a Mac's line endings", () => {
    const model = loadSnapshot();
    const legacy = `${PKG}legacy%2F`;
    expect(entity(model, `${legacy}report.py/Report.render`)["kind"]).toBe("method");
    expect(entity(model, `${legacy}report.py/LegacyError`)["kind"]).toBe("class");
    expect(entity(model, `${legacy}broken.py/Broken.unclosed`)["kind"]).toBe("method");
    expect(entity(model, `${legacy}broken.py/after`)["kind"]).toBe("function");
    // Decoded from Latin-1 by its cookie: the name is the text Python reads.
    expect(entity(model, `${legacy}latin.py/Tarif.réduire`)["name"]).toBe("réduire");
    expect(entity(model, `${legacy}bom.py/Marked`)["kind"]).toBe("class");
    // Lone `\r` ends a line: the method on the file's sixth line is anchored there.
    expect(SourceAnchor.parse(entity(model, `${legacy}mac.py/Classic.second`)["anchor"]).span).toEqual([6, 7]);
  });

  it("carries the evidence the stub discipline exists to prove (PLAN §23.4)", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const builtins = byId.get("python:<builtins>");
    expect(builtins && isStubEntity(builtins)).toBe(true);
    // Only `<builtins>` is a reserved entity: a `<stdlib>` or `<site>` module is one per dotted name.
    expect(byId.has("python:<stdlib>")).toBe(false);
    expect(byId.has("python:<site>")).toBe(false);
    for (const [id, parent] of [
      ["python:<builtins>/Exception", "python:<builtins>"],
      ["python:<stdlib>%2Fenum/Enum", "python:<stdlib>%2Fenum"],
      ["python:<stdlib>%2Fcollections.abc/Mapping", "python:<stdlib>%2Fcollections.abc"],
      ["python:<site>%2Fdjango.db/models.Model", "python:<site>%2Fdjango.db"],
      ["python:<site>%2Fsqlalchemy.orm/DeclarativeBase", "python:<site>%2Fsqlalchemy.orm"],
    ] as const) {
      const stub = entity(model, id);
      expect(stub["kind"], id).toBe("class");
      expect(stub["isStub"], id).toBe(true);
      expect(stub["parent"], id).toBe(parent);
      expect(entity(model, parent)["definedIn"], parent).toEqual([]);
    }
    // A corpus module named like a standard one is the corpus's, never a stub.
    expect(byId.has("python:<stdlib>%2Fqueue")).toBe(false);
    expect(hasEdge(model, "import", "python:tests%2Ftest_queue.py", "python:tests%2Fqueue.py")).toBe(true);
    // Resolvability is not membership: no corpus declaration is a stub, no stub has an anchor.
    for (const e of model.entities) {
      if (isStubEntity(e)) expect((e as unknown as Bag)["anchor"], e.id).toBeUndefined();
      else expect(e.id, e.id).not.toMatch(/^python:<(builtins|stdlib|site)>/);
    }
    // A relative import to a file that is not there: a stub keyed by the path it would have.
    const missing = entity(model, `${PKG}pricing%2Fmissing.py`);
    expect(missing["isStub"]).toBe(true);
    expect(missing["name"]).toBe("src/acme_order/pricing/missing.py");
  });

  it("writes imports module to module, as Python finds them", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    for (const edge of model.edges.filter((e) => e.edge === "import")) {
      expect(byId.get(edge.from)?.kind, edge.from).toBe("module");
      expect(byId.get(edge.to)?.kind, edge.to).toBe("module");
    }
    const tests = "python:tests%2Ftest_orders.py";
    // `from acme_order import Order, errors`: the package that binds `Order`, the submodule `errors` is.
    expect(targets(model, "import", tests)).toEqual([
      "python:<stdlib>%2Funittest",
      "python:src%2Facme%2F__init__.py",
      `${PKG}__init__.py`,
      `${PKG}errors.py`,
      "python:tests%2Fconftest.py",
    ]);
    // `from . import discounts` and `from ..orders import Order`: path arithmetic.
    const rules = `${PKG}pricing%2Frules.py`;
    expect(hasEdge(model, "import", rules, `${PKG}pricing%2Fdiscounts.py`)).toBe(true);
    expect(hasEdge(model, "import", rules, `${PKG}orders%2F__init__.py`)).toBe(true);
    // A namespace package is crossed, never an entity; Python 2's sibling import is answered.
    expect(hasEdge(model, "import", `${PKG}payments.py`, "python:src%2Facme_plugins%2Fstripe.py")).toBe(true);
    expect(hasEdge(model, "import", `${PKG}legacy%2Freport.py`, `${PKG}legacy%2Fhelpers.py`)).toBe(true);
    // `from collections import abc` names the submodule; `import simplejson as json` a third party.
    expect(hasEdge(model, "import", `${PKG}shipping.py`, "python:<stdlib>%2Fcollections.abc")).toBe(true);
    expect(hasEdge(model, "import", `${PKG}compat.py`, "python:<site>%2Fsimplejson")).toBe(true);
    expect(hasEdge(model, "import", `${PKG}compat.py`, "python:<stdlib>%2Fjson")).toBe(true);
  });

  it("follows a re-export chain to the declaration, and anchors each base where it is written", () => {
    const model = loadSnapshot();
    // tests/test_orders.py imports acme_order/__init__.py; the base is the class in orders/order.py.
    expect(hasEdge(model, "inheritance", "python:tests%2Ftest_orders.py/SpecialOrder", ORDER)).toBe(true);
    expect(targets(model, "inheritance", ORDER)).toEqual([
      `${PKG}orders%2Fbase.py/Auditable`,
      `${PKG}orders%2Fbase.py/Base`,
    ]);
    // A diamond: one edge per base.
    const discounts = `${PKG}pricing%2Fdiscounts.py`;
    expect(targets(model, "inheritance", `${discounts}/Combo`)).toEqual([`${discounts}/Fixed`, `${discounts}/Percent`]);
    // A class in a function inherits through the function's module.
    expect(hasEdge(model, "inheritance", `${PKG}factory.py/make.Local`, `${PKG}orders%2Fbase.py/Base`)).toBe(true);
    // A name bound twice: the first binding that names a declaration.
    expect(hasEdge(model, "inheritance", `${PKG}compat.py/DecodeError`, "python:<site>%2Fsimplejson/JSONDecodeError")).toBe(
      true,
    );
    const edge = model.edges.find((e) => e.edge === "inheritance" && e.from === `${PKG}shipping.py/Zones`);
    expect(edge?.anchor).toEqual({ file: "src/acme_order/shipping.py", span: [22, 22] });
    // A star import binds `__all__`; a name only an unknown module's star could bind is attributed
    // to it — derived, since no line names its module — and with two such modules, no guess.
    const packing = `${PKG}packing.py`;
    expect(hasEdge(model, "inheritance", `${packing}/Parcel`, `${PKG}shapes.py/Box`)).toBe(true);
    expect(hasEdge(model, "inheritance", `${packing}/Pallet`, "python:<site>%2Fpallets.lib/Crate", "derived")).toBe(true);
    expect(hasEdge(model, "inheritance", `${packing}/Pallet`, "python:<site>%2Fpallets.lib/Crate", "declared")).toBe(false);
    expect(targets(model, "inheritance", `${PKG}two_stars.py/Mixed`)).toEqual([]);
    // A package importing its own submodule: the name is that module, not the package.
    const pricing = `${PKG}pricing%2F`;
    expect(hasEdge(model, "import", `${pricing}__init__.py`, `${pricing}discounts.py`)).toBe(true);
    expect(hasEdge(model, "inheritance", `${pricing}__init__.py/DefaultDiscount`, `${pricing}discounts.py/Discount`)).toBe(true);
    // A computed base, a parameter, a base nothing binds, a loop and a tie leave no edge.
    for (const from of [
      `${PKG}shipping.py/Dynamic`,
      `${PKG}factory.py/wrap.Wrapped`,
      `${PKG}shipping.py/Orphan`,
      `${PKG}cycle_a.py/Spent`,
      "python:tests%2Ftest_tie.py/Tied",
    ]) {
      expect(targets(model, "inheritance", from), from).toEqual([]);
    }
  });
});
