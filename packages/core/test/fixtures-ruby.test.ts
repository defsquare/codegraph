import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { rubyProfile } from "../src/profiles/ruby.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M18 ACCEPTANCE GATE — the Java, C#, TypeScript and Elixir gates,
 * replayed for the fifth real extractor, the first written in a language that
 * is not the one it reads. The extractor's own cargo suite pins the snapshot
 * and its evidence; what only this side can say is that the composition is one
 * the Ruby PROFILE licenses — data the extractor never imports — and the
 * strongest statement: two independent encoders, one in Rust and one here,
 * write the same bytes.
 */

const SNAPSHOT = fileURLToPath(new URL("../../../fixtures/ruby/expected/model.jsonl", import.meta.url));

const LIB = "rb:lib%2Facme_order%2F";
const ORDER = `${LIB}order.rb/AcmeOrder::Order`;
const MONEY = `${LIB}money.rb/AcmeOrder::Money`;
const RECORD = `${LIB}record.rb/AcmeOrder::Record`;

function loadSnapshot(): Model {
  return parseModel(readModelFileSync(SNAPSHOT));
}

type Bag = Record<string, unknown>;

function entity(model: Model, id: string): Bag {
  const found = model.entities.find((candidate) => candidate.id === id);
  expect(found, id).toBeDefined();
  return found as unknown as Bag;
}

/** Code-unit order, like every sort of the model — never the locale's. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasEdge(model: Model, edge: string, from: string, to: string, provenance = "declared"): boolean {
  return model.edges.some((e) => e.edge === edge && e.from === from && e.to === to && e.provenance === provenance);
}

/** The edges of one kind leaving one entity, as `to@line`, in source order. */
function outgoing(model: Model, edge: string, from: string): string[] {
  return model.edges
    .filter((e) => e.edge === edge && e.from === from)
    .sort((a, b) => a.anchor.span[0] - b.anchor.span[0] || byCodeUnit(a.to, b.to))
    .map((e) => `${e.to}@${e.anchor.span[0]}`);
}

describe("fixtures/ruby/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the Ruby profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), rubyProfile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    expect(unknownReferences(loadSnapshot()).map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges", () => {
    expect(selfReferences(loadSnapshot()).map((s) => s.path)).toEqual([]);
  });

  it("names the extractor, the parser and the table whose constants decided the stubs", () => {
    const header = JSON.parse(readFileSync(SNAPSHOT, "utf8").split("\n")[0] as string) as {
      lang: string;
      root: string;
      extractor: Record<string, unknown>;
    };
    expect(header.lang).toBe("rb");
    expect(header.root).toBe("fixtures/ruby/src");
    expect(header.extractor["name"]).toBe("codegraph-ruby");
    expect(header.extractor["prism"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(header.extractor["rbs"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("makes the FILE the module and a class a type below it, keys escaped (PLAN §19.3)", () => {
    const model = loadSnapshot();
    const file = entity(model, `${LIB}order.rb`);
    expect(file["kind"]).toBe("file");
    expect(file["name"]).toBe("lib/acme_order/order.rb");
    expect(file["definedIn"]).toEqual(["lib/acme_order/order.rb"]);
    const order = entity(model, ORDER);
    expect(order["kind"]).toBe("class");
    expect(order["name"]).toBe("AcmeOrder::Order");
    expect(order["traits"]).toContain("TType");
    expect(order["traits"]).not.toContain("TModule");
    // A `#` in a file name is escaped in the key, and the name keeps it.
    expect(entity(model, `${LIB}promo%232024.rb`)["name"]).toBe("lib/acme_order/promo#2024.rb");
    // Ruby by name (`Rakefile`, `.rake`, `.ru`) and by its own account (a `ruby` shebang).
    for (const id of ["rb:Rakefile", "rb:Gemfile", "rb:config.ru", "rb:lib%2Ftasks%2Forders.rake", "rb:bin%2Fconsole"]) {
      expect(entity(model, id)["kind"], id).toBe("file");
    }
    // A shell script beside it is not Ruby, and nothing under vendor/ is corpus.
    expect(model.entities.some((e) => e.id.includes("setup") || e.id.includes("Vendored"))).toBe(false);
    // Every file is its own module: the import layer is file-level.
    for (const e of model.entities) {
      if (e.kind !== "file") expect((e as unknown as Bag)["definedIn"], e.id).toBeUndefined();
    }
  });

  it("gives a wrapper body no entity: both spellings of a nested class are one key", () => {
    const model = loadSnapshot();
    // `module AcmeOrder; class Order` — written inside a wrapper, a child of the file.
    expect(entity(model, ORDER)["parent"]).toBe(`${LIB}order.rb`);
    // `class AcmeOrder::Base` — the compact spelling, the same shape of key.
    expect(entity(model, `${LIB}base.rb/AcmeOrder::Base`)["parent"]).toBe(`${LIB}base.rb`);
    // `AcmeOrder` is an entity only where a body has something of its own —
    // `Point = Struct.new(…)` declares a type, so point.rb's body is a wrapper too.
    const declaring = model.entities.filter((e) => (e as unknown as Bag)["name"] === "AcmeOrder").map((e) => e.id);
    expect(declaring).toEqual([`${LIB}version.rb/AcmeOrder`, "rb:lib%2Facme_order.rb/AcmeOrder"]);
    // An empty body IS a declaration.
    expect(entity(model, `${LIB}errors.rb/AcmeOrder::NotFound`)["kind"]).toBe("class");
    // A type written inside a declared type is its child.
    expect(entity(model, `${ORDER}::Line`)["parent"]).toBe(ORDER);
  });

  it("keeps one entity per declaring file and attaches a reopening to its primary declaration", () => {
    const model = loadSnapshot();
    // `a_order_patch.rb` sorts first; the body that writes a superclass is the primary.
    const patch = entity(model, `${LIB}a_order_patch.rb/AcmeOrder::Order`);
    expect(patch["attachedTo"]).toBe(ORDER);
    expect(patch["traits"]).toContain("TAttachedTo");
    expect(patch["isStub"]).toBe(false);
    expect(entity(model, ORDER)["attachedTo"]).toBeUndefined();
    expect(entity(model, `${LIB}version.rb/AcmeOrder`)["attachedTo"]).toBe("rb:lib%2Facme_order.rb/AcmeOrder");
    // A monkey patch of a core class: declared here, attached to the VM's.
    const string = entity(model, `${LIB}core_ext%2Fstring.rb/String`);
    expect(string["isStub"]).toBe(false);
    expect(string["attachedTo"]).toBe("rb:<ruby>/String");
    // …and a reference to `String` still names the VM's, not the patch.
    expect(hasEdge(model, "inheritance", `${LIB}label.rb/AcmeOrder::Label`, "rb:<ruby>/String")).toBe(true);
  });

  it("tells a singleton method from an instance method, and escapes the names Ruby allows", () => {
    const model = loadSnapshot();
    expect(entity(model, `${ORDER}.call`)["signature"]).toBe("call()");
    expect(entity(model, `${ORDER}.call#self`)["signature"]).toBe("self.call(*)");
    // A `def` inside `class << self` is a singleton method too.
    expect(entity(model, `${ORDER}.build#self`)["signature"]).toBe("self.build(reference, **options, &block)");
    // `def /` and `def %` are methods; their names are escaped in the key and kept in `name`.
    expect(entity(model, `${MONEY}.%2F`)["name"]).toBe("/");
    expect(entity(model, `${MONEY}.%25`)["name"]).toBe("%");
    expect(entity(model, `${MONEY}.<=>`)["name"]).toBe("<=>");
    // No arity in the key: Ruby has no overloading.
    for (const e of model.entities) {
      if (e.kind === "method") expect(e.id, e.id).not.toMatch(/#\d+$/);
    }
    // A top-level `def` belongs to its file.
    expect(entity(model, "rb:spec%2Facme_order%2Forder_spec.rb/build_order")["parent"]).toBe(
      "rb:spec%2Facme_order%2Forder_spec.rb",
    );
    // `define_method(:ping) { … }` writes a method as a `def` does.
    expect(entity(model, `${LIB}dynamic.rb/AcmeOrder::Dynamic::Ghost.ping`)["kind"]).toBe("method");
  });

  it("gives every method its parameters, named or by ordinal, with the default the source writes", () => {
    const model = loadSnapshot();
    const initialize = entity(model, `${ORDER}.initialize`);
    expect(initialize["signature"]).toBe(
      "initialize(reference, [lines], *rest, [currency:], [rounding:], **options, &block)",
    );
    expect(initialize["parameters"]).toEqual(
      ["reference", "lines", "rest", "currency", "rounding", "options", "block"].map(
        (name) => `${ORDER}.initialize#param:${name}`,
      ),
    );
    const lines = entity(model, `${ORDER}.initialize#param:lines`);
    expect(lines["kind"]).toBe("parameter");
    expect(lines["name"]).toBe("lines");
    expect(SourceAnchor.parse(lines["anchor"]).span).toEqual([37, 37]);
    expect(lines["value"]).toEqual({ k: "array", items: [] });
    // A symbol and a constant are constant-shaped: kept as the text written.
    expect(entity(model, `${ORDER}.initialize#param:rounding`)["value"]).toEqual({ k: "unevaluated", source: ":half_up" });
    expect(entity(model, `${ORDER}.initialize#param:currency`)["value"]).toEqual({
      k: "unevaluated",
      source: "DEFAULT_CURRENCY",
    });
    expect(entity(model, `${ORDER}::Line.initialize#param:qty`)["value"]).toEqual({ k: "number", v: "1" });
    expect(entity(model, `${ORDER}.initialize#param:reference`)["value"]).toBeUndefined();
    // `def self.call(*)`: an anonymous splat has no name, and its key is its position.
    const splat = entity(model, `${ORDER}.call#self#param:1`);
    expect(splat["name"]).toBeUndefined();
    expect(splat["traits"]).not.toContain("TNamed");
  });

  it("carries the evidence the stub discipline exists to prove (PLAN §19.4)", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    // The reserved modules exist only because something points below them.
    for (const reserved of ["rb:<ruby>", "rb:<gems>"]) {
      const module = byId.get(reserved);
      expect(module, reserved).toBeDefined();
      expect(isStubEntity(module!)).toBe(true);
      expect((module as unknown as Bag)["definedIn"]).toEqual([]);
    }
    // What the VM defines is below <ruby>, with the kind its table states.
    expect(byId.get("rb:<ruby>/StandardError")?.kind).toBe("class");
    expect(byId.get("rb:<ruby>/Comparable")?.kind).toBe("module");
    expect((byId.get("rb:<ruby>/Comparable") as unknown as Bag)["parent"]).toBe("rb:<ruby>");
    // A library is below <gems>: a class where a site inherits from it, a module otherwise.
    expect(byId.get("rb:<gems>/ActiveRecord::Base")?.kind).toBe("class");
    expect(byId.get("rb:<gems>/ActiveModel::Validations")?.kind).toBe("module");
    // The standard library is a library: `Forwardable` needs a `require`.
    expect(isStubEntity(byId.get("rb:<gems>/Forwardable")!)).toBe(true);
    expect(byId.has("rb:<ruby>/Forwardable")).toBe(false);
    // Resolvability is not membership: a corpus type is never a stub, a stub never has an anchor.
    expect(byId.has("rb:<gems>/AcmeOrder::Base")).toBe(false);
    for (const e of model.entities) {
      if (isStubEntity(e)) expect((e as unknown as Bag)["anchor"], e.id).toBeUndefined();
    }
    // A constant the corpus assigns is KNOWN: `class Odd < HANDLERS` is dropped, never stubbed.
    expect(byId.has("rb:<gems>/HANDLERS")).toBe(false);
    expect(model.edges.some((e) => e.from === `${LIB}dynamic.rb/AcmeOrder::Dynamic::Odd`)).toBe(false);
    // What the language uses but nothing depends on is no stub: `puts`, `raise` are Kernel's.
    expect(byId.has("rb:<ruby>/Kernel")).toBe(false);
  });

  it("writes superclasses and mixins as edges, resolved lexically", () => {
    const model = loadSnapshot();
    const base = `${LIB}base.rb/AcmeOrder::Base`;
    // `< Base` inside `module AcmeOrder` is `AcmeOrder::Base`, in another file.
    expect(hasEdge(model, "inheritance", ORDER, base)).toBe(true);
    // …and through two wrappers.
    expect(hasEdge(model, "inheritance", `${LIB}pricing%2Fstandard.rb/AcmeOrder::Pricing::Standard`, base)).toBe(true);
    // A sibling in the same file.
    expect(
      hasEdge(model, "inheritance", `${LIB}errors.rb/AcmeOrder::NotFound`, `${LIB}errors.rb/AcmeOrder::Error`),
    ).toBe(true);
    expect(hasEdge(model, "inheritance", `${LIB}errors.rb/AcmeOrder::Error`, "rb:<ruby>/StandardError")).toBe(true);
    // `include` and `extend` are one edge kind, never flattened.
    expect(hasEdge(model, "traitUsage", ORDER, `${LIB}priceable.rb/AcmeOrder::Priceable`)).toBe(true);
    expect(hasEdge(model, "traitUsage", ORDER, "rb:<gems>/Forwardable")).toBe(true);
    expect(hasEdge(model, "traitUsage", MONEY, "rb:<ruby>/Comparable")).toBe(true);
    // Every type edge is anchored at the line that writes it.
    const edge = model.edges.find((e) => e.edge === "traitUsage" && e.from === ORDER && e.to === "rb:<gems>/Forwardable");
    expect(edge?.anchor).toEqual({ file: "lib/acme_order/order.rb", span: [7, 7] });
  });

  it("makes a Struct a class whose members are fields — the inheritance GENERATED, not declared", () => {
    const model = loadSnapshot();
    // `class Money < Struct.new(:cents, :currency)`: the source writes no `< Struct`.
    expect(hasEdge(model, "inheritance", MONEY, "rb:<ruby>/Struct", "generated")).toBe(true);
    expect(hasEdge(model, "inheritance", MONEY, "rb:<ruby>/Struct", "declared")).toBe(false);
    expect(entity(model, `${MONEY}.@cents`)["kind"]).toBe("field");
    // `Point = Struct.new(:lat, :lng) do … end`: a class named by the constant, its block the body.
    const point = `${LIB}point.rb/AcmeOrder::Point`;
    expect(entity(model, point)["kind"]).toBe("class");
    expect(entity(model, point)["comments"]).toEqual(["A place, immutable."]);
    expect(hasEdge(model, "inheritance", point, "rb:<ruby>/Struct", "generated")).toBe(true);
    expect(entity(model, `${point}.to_s`)["parent"]).toBe(point);
    expect(outgoing(model, "access", `${point}.to_s`)).toEqual([`${point}.@lat@5`, `${point}.@lng@5`]);
    // `Loader = Class.new(Base)` writes its superclass: a declared fact, like `< Base`.
    const loader = `${LIB}dynamic.rb/AcmeOrder::Dynamic::Loader`;
    expect(hasEdge(model, "inheritance", loader, `${LIB}base.rb/AcmeOrder::Base`)).toBe(true);
    expect(hasEdge(model, "inheritance", `${LIB}dynamic.rb/AcmeOrder::Dynamic::Wrapped`, loader)).toBe(true);
    // The only generated edges are those the language defines.
    for (const e of model.edges) {
      if (e.provenance === "generated") expect(`${e.edge} -> ${e.to}`).toBe("inheritance -> rb:<ruby>/Struct");
    }
  });

  it("folds every require to the file: a path, a load root, or the feature as written", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const imports = model.edges.filter((e) => e.edge === "import");
    expect(imports.length).toBeGreaterThan(0);
    for (const edge of imports) {
      // Module → Module, always: the layer comparable across languages.
      expect(byId.get(edge.from)?.kind, edge.from).toBe("file");
      expect(byId.get(edge.to)?.kind, edge.to).toBe("file");
    }
    const entry = "rb:lib%2Facme_order.rb";
    // `require_relative` names a path.
    expect(hasEdge(model, "import", entry, `${LIB}order.rb`)).toBe(true);
    // `require "acme_order/version"` is answered by the `lib` load root; `require "spec_helper"` by `spec`.
    expect(hasEdge(model, "import", entry, `${LIB}version.rb`)).toBe(true);
    expect(hasEdge(model, "import", "rb:spec%2Facme_order%2Forder_spec.rb", "rb:spec%2Fspec_helper.rb")).toBe(true);
    expect(hasEdge(model, "import", "rb:config.ru", entry)).toBe(true);
    // `autoload :Reporting, "acme_order/reporting"` and `load "tasks/orders.rake"` name files too.
    expect(hasEdge(model, "import", entry, `${LIB}reporting.rb`)).toBe(true);
    expect(hasEdge(model, "import", "rb:Rakefile", "rb:lib%2Ftasks%2Forders.rake")).toBe(true);
    // `require File.join(__dir__, "version")` is the Ruby 1.8 spelling of require_relative.
    expect(hasEdge(model, "import", `${LIB}dynamic.rb`, `${LIB}version.rb`)).toBe(true);
    // A feature no corpus file answers: a stub module named as written, below <gems>.
    expect(hasEdge(model, "import", entry, "rb:<gems>%2Fbigdecimal")).toBe(true);
    const feature = entity(model, "rb:<gems>%2Frake%2Ftesttask");
    expect(feature["name"]).toBe("rake/testtask");
    expect(feature["isStub"]).toBe(true);
    // A `require_relative` to a file that is not there: a stub keyed by the path it names.
    const missing = entity(model, `${LIB}legacy%2Fmissing.rb`);
    expect(missing["isStub"]).toBe(true);
    expect(missing["definedIn"]).toEqual([]);
  });

  it("derives an import where a constant crosses files and nothing is required (PLAN §19.2)", () => {
    const model = loadSnapshot();
    const order = `${LIB}order.rb`;
    // order.rb requires none of these: the constant reference IS the import.
    for (const target of ["base.rb", "priceable.rb", "errors.rb", "money.rb", "pricing%2Fstandard.rb"]) {
      expect(hasEdge(model, "import", order, `${LIB}${target}`, "derived"), target).toBe(true);
    }
    const derived = model.edges.filter((e) => e.edge === "import" && e.provenance === "derived");
    // One per (file, target file), and never beside a written require of the same file.
    const pairs = derived.map((e) => `${e.from} -> ${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const edge of derived) {
      expect(hasEdge(model, "import", edge.from, edge.to, "declared"), `${edge.from} -> ${edge.to}`).toBe(false);
    }
  });

  it("makes a value constant an entity, and reading it an access (M18b)", () => {
    const model = loadSnapshot();
    const max = entity(model, `${ORDER}::MAX_LINES`);
    expect(max["kind"]).toBe("constant");
    expect(max["name"]).toBe("AcmeOrder::Order::MAX_LINES");
    expect(max["parent"]).toBe(ORDER);
    expect(max["value"]).toEqual({ k: "number", v: "100" });
    expect(max["comments"]).toEqual(["No order holds more lines than this."]);
    // `"EUR".freeze` is the string, frozen; `%i[…]` an array of what is written.
    expect(entity(model, `${ORDER}::DEFAULT_CURRENCY`)["value"]).toEqual({ k: "string", v: "EUR" });
    expect(entity(model, `${ORDER}::ROUNDINGS`)["value"]).toEqual({
      k: "array",
      items: [
        { k: "unevaluated", source: "half_up" },
        { k: "unevaluated", source: "half_even" },
      ],
    });
    const read = model.edges.find((e) => e.edge === "access" && e.from === `${ORDER}.add` && e.to === `${ORDER}::MAX_LINES`);
    expect(read).toMatchObject({ isRead: true, isWrite: false, provenance: "declared" });
    // Across files too: the gemspec reads the version.
    expect(hasEdge(model, "access", "rb:acme_order.gemspec", `${LIB}version.rb/AcmeOrder::VERSION`)).toBe(true);
  });

  it("makes an instance variable and the attr that exposes it ONE field (M18b)", () => {
    const model = loadSnapshot();
    const lines = entity(model, `${ORDER}.@lines`);
    expect(lines["kind"]).toBe("field");
    expect(lines["name"]).toBe("@lines");
    expect(lines["parent"]).toBe(ORDER);
    // Declared by `attr_reader :reference, :lines`: anchored there, not at its first assignment.
    expect(SourceAnchor.parse(lines["anchor"]).span).toEqual([14, 14]);
    // Never exposed: anchored where it is first written.
    expect(SourceAnchor.parse(entity(model, `${ORDER}.@pricing`)["anchor"]).span).toEqual([41, 41]);
    const accesses = model.edges
      .flatMap((e) => (e.edge === "access" && e.from === `${ORDER}.add` ? [e] : []))
      .sort((a, b) => a.anchor.span[0] - b.anchor.span[0] || byCodeUnit(a.to, b.to))
      .map((e) => `${e.to.replace(ORDER, "")}@${e.anchor.span[0]} ${e.isRead ? "r" : ""}${e.isWrite ? "w" : ""}`);
    expect(accesses).toEqual([
      // `lines.size`: an accessor call is an access, not an invocation.
      ".@lines@49 r",
      "::MAX_LINES@49 r",
      ".@lines@51 r",
      // `self.note = "changed"`
      ".@note@52 w",
    ]);
    // No accessor is an entity: `lines` and `note=` are not methods of the model.
    expect(model.entities.some((e) => e.id === `${ORDER}.lines` || e.id === `${ORDER}.note=`)).toBe(false);
  });

  it("lands a call on the method Ruby would find, and says how it knows (M18b)", () => {
    const model = loadSnapshot();
    // `new(*).call` in a class method: an instance of the class it is written in.
    expect(outgoing(model, "invocation", `${ORDER}.call#self`)).toEqual([`${ORDER}.call@27`, `${ORDER}.initialize@27`]);
    expect(outgoing(model, "invocation", `${ORDER}.call`)).toEqual([`${ORDER}.total@45`]);
    // `Money.zero(…)`: a singleton method, in another file — and the constant read beside it.
    expect(hasEdge(model, "invocation", `${ORDER}.total`, `${MONEY}.zero#self`)).toBe(true);
    expect(hasEdge(model, "reference", `${ORDER}.total`, MONEY)).toBe(true);
    // `@pricing.price_for(self)`: typed by the one thing `@pricing` is ever assigned — an inference.
    const standard = `${LIB}pricing%2Fstandard.rb/AcmeOrder::Pricing::Standard`;
    expect(hasEdge(model, "invocation", `${ORDER}.total`, `${standard}.price_for`, "derived")).toBe(true);
    expect(hasEdge(model, "invocation", `${ORDER}.total`, `${standard}.price_for`, "declared")).toBe(false);
    // `label = Label.new(…); label.shout`: a local typed by its assignment is derived too…
    const summary = `${LIB}reporting.rb/AcmeOrder::Reporting.summary`;
    const label = `${LIB}label.rb/AcmeOrder::Label`;
    expect(hasEdge(model, "invocation", summary, `${label}.shout`, "derived")).toBe(true);
    // …while `Label.new(…)` itself runs `initialize`: declared.
    expect(hasEdge(model, "invocation", summary, `${label}.initialize`)).toBe(true);
    // `super` reaches the superclass's method; `super` into the VM's reaches its stub.
    expect(
      hasEdge(
        model,
        "invocation",
        `${LIB}pricing%2Fpremium.rb/AcmeOrder::Pricing::Premium.price_for`,
        `${standard}.price_for`,
      ),
    ).toBe(true);
    expect(hasEdge(model, "invocation", `${label}.initialize`, "rb:<ruby>/String")).toBe(true);
    // `upcase` in a subclass of String is String's.
    expect(hasEdge(model, "invocation", `${label}.shout`, "rb:<ruby>/String")).toBe(true);
    // `"".blank?`: the corpus's own patch of String answers before the VM would.
    expect(
      hasEdge(model, "invocation", `${LIB}reporting.rb/AcmeOrder::Reporting.unnamed?`, `${LIB}core_ext%2Fstring.rb/String.blank?`),
    ).toBe(true);
    // `order = Order.new(…); order.note = "seen"`: an accessor on a typed local is an
    // access — a write, across types, and derived like the call it is not.
    const annotate = `${LIB}reporting.rb/AcmeOrder::Reporting.annotate`;
    const write = model.edges.find((e) => e.edge === "access" && e.from === annotate);
    expect(write).toMatchObject({ to: `${ORDER}.@note`, isRead: false, isWrite: true, provenance: "derived" });
    expect(hasEdge(model, "invocation", annotate, `${ORDER}.initialize`)).toBe(true);
    // `send(:ping)` with a literal name is a call like any other.
    const ghost = `${LIB}dynamic.rb/AcmeOrder::Dynamic::Ghost`;
    expect(hasEdge(model, "invocation", `${ghost}.pong`, `${ghost}.ping`)).toBe(true);
    expect(hasEdge(model, "invocation", `${ghost}.ping`, `${ghost}.pong`)).toBe(true);
  });

  it("attributes a call nothing known answers to the sole library ancestor — derived, never declared", () => {
    const model = loadSnapshot();
    const base = "rb:<gems>/ActiveRecord::Base";
    const ledger = `${LIB}ledger.rb/AcmeOrder::Ledger`;
    // `has_many`, `where`: ActiveRecord::Base is the one library above, and nothing is mixed in.
    expect(outgoing(model, "invocation", ledger)).toEqual([`${base}@4`]);
    expect(outgoing(model, "invocation", `${ledger}.current#self`)).toEqual([`${base}@9`]);
    for (const e of model.edges) {
      if (e.edge === "invocation" && e.to === base) expect(e.provenance, e.from).toBe("derived");
    }
    // A class body that calls says so.
    expect(entity(model, ledger)["traits"]).toContain("TWithInvocations");
    // `define_method` with a computed name gives the INSTANCES methods no key
    // can name: what an instance does not declare proves nothing, while what
    // the class itself answers is as known as before (M18c).
    expect(outgoing(model, "invocation", `${ledger}.close!`)).toEqual([]);
    // Every derived edge is an inference the profile names: an import no `require`
    // writes, or a call or an accessor on a receiver the extractor typed.
    for (const e of model.edges) {
      if (e.provenance === "derived") {
        expect(["import", "invocation", "access"], `${e.edge} ${e.from}`).toContain(e.edge);
      }
      expect(e.candidates, e.from).toBeUndefined();
    }
  });

  it("refuses the attribution as soon as a second library could answer, on either side (M18c)", () => {
    const model = loadSnapshot();
    // `validates` IS ActiveModel::Validations': its `included` hook extends
    // the class. A library's mixin is one more that could answer — `has_many`
    // and `where` on the class no less than `update!` on an instance.
    expect(outgoing(model, "invocation", RECORD)).toEqual([]);
    expect(outgoing(model, "invocation", `${RECORD}.recent#self`)).toEqual([]);
    expect(outgoing(model, "invocation", `${RECORD}.archive!`)).toEqual([]);
    expect(entity(model, RECORD)["traits"]).not.toContain("TWithInvocations");
  });

  it("finds the class methods an included hook gives the includer — derived (M18c)", () => {
    const model = loadSnapshot();
    const file = `${LIB}auditable.rb`;
    const invoice = `${LIB}invoice.rb/AcmeOrder::Invoice`;
    // `class_methods do … end` IS the body of the concern's ClassMethods module.
    const classMethods = entity(model, `${file}/AcmeOrder::Auditable::ClassMethods`);
    expect(classMethods["kind"]).toBe("module");
    expect(classMethods["anchor"]).toEqual({ file: "lib/acme_order/auditable.rb", span: [10, 14] });
    // The Rails way and the plain Ruby way (`base.extend(ClassMethods)`) land
    // alike. Invoice never writes `extend`: the call is bound through the hook.
    const audited = `${file}/AcmeOrder::Auditable::ClassMethods.audited`;
    const stamp = `${file}/AcmeOrder::Stamped::ClassMethods.stamp`;
    expect(outgoing(model, "invocation", invoice)).toEqual([`${audited}@7`, `${stamp}@8`]);
    expect(outgoing(model, "invocation", `${invoice}.build#self`)).toEqual([`${audited}@11`]);
    for (const e of model.edges) {
      if (e.to === audited || e.to === stamp) expect(e.provenance, e.from).toBe("derived");
    }
    // What an INSTANCE of the includer answers is what `include` says: declared.
    expect(hasEdge(model, "invocation", `${invoice}.settle`, `${file}/AcmeOrder::Auditable.audit!`)).toBe(true);
    // No mixin edge is invented: Invoice writes two includes, and has two.
    expect(outgoing(model, "traitUsage", invoice)).toEqual([
      `${file}/AcmeOrder::Auditable@4`,
      `${file}/AcmeOrder::Stamped@5`,
    ]);
    // What the hook itself names is read where it is written.
    expect(hasEdge(model, "reference", `${file}/AcmeOrder::Auditable`, "rb:<ruby>/Comparable")).toBe(true);
  });

  it("stubs a namespace whose body must be elsewhere (M18c)", () => {
    const model = loadSnapshot();
    const hook = `${LIB}railtie.rb/Rails::AcmeOrderHook`;
    // `class Rails::AcmeOrderHook` needs `Rails`. No file gives it a body, yet
    // `logger` is answered by no bare module: its body is a library's.
    expect(entity(model, hook)["isStub"]).toBe(false);
    const rails = entity(model, "rb:<gems>/Rails");
    expect(rails["isStub"]).toBe(true);
    expect(rails["kind"]).toBe("module");
    expect(hasEdge(model, "invocation", `${hook}.install`, "rb:<gems>/Rails")).toBe(true);
    expect(hasEdge(model, "reference", `${hook}.install`, "rb:<gems>/Rails")).toBe(true);
  });

  it("writes a raise as a throw site, beside the reference it also is (M18b)", () => {
    const model = loadSnapshot();
    const tooMany = `${LIB}errors.rb/AcmeOrder::TooManyLines`;
    const site = model.edges.find((e) => e.edge === "throws" && e.from === `${ORDER}.add`);
    expect(site?.to).toBe(tooMany);
    expect(site?.anchor.span).toEqual([49, 49]);
    // A throws edge never replaces the dependency.
    expect(hasEdge(model, "reference", `${ORDER}.add`, tooMany)).toBe(true);
    expect(
      hasEdge(model, "throws", `${LIB}priceable.rb/AcmeOrder::Priceable.price`, "rb:<ruby>/NotImplementedError"),
    ).toBe(true);
  });

  it("carries comments and measures (M18b)", () => {
    const model = loadSnapshot();
    const order = entity(model, ORDER);
    expect(order["comments"]).toEqual(["An order: its lines and what they add up to."]);
    expect(order["traits"]).toContain("TComment");
    const initialize = entity(model, `${ORDER}.initialize`);
    expect(initialize["comments"]).toEqual(["Builds an order, empty unless lines are given."]);
    expect(initialize["metrics"]).toEqual({ cyclomatic: 1, sloc: 6 });
    // `raise … if …`: one branch.
    expect(entity(model, `${ORDER}.add`)["metrics"]).toEqual({ cyclomatic: 2, sloc: 6 });
    // The file: every line that is code. A comment, a blank line are not.
    expect(entity(model, `${LIB}priceable.rb`)["metrics"]).toEqual({ sloc: 10 });
    for (const e of model.entities) {
      const bag = e as unknown as Bag;
      if (e.kind === "method") expect(bag["metrics"], e.id).toHaveProperty("cyclomatic");
      if (bag["metrics"] !== undefined) expect(bag["traits"], e.id).toContain("TMetrics");
      if (isStubEntity(e)) expect(bag["metrics"], e.id).toBeUndefined();
    }
  });

  it("extracts a file Prism recovered from syntax errors in", () => {
    const model = loadSnapshot();
    // `def export(format` never closes its parenthesis; the class and both methods are still there.
    const legacy = `${LIB}legacy%2Fbroken.rb/AcmeOrder::Legacy`;
    expect(entity(model, legacy)["kind"]).toBe("class");
    expect(entity(model, `${legacy}.export`)["kind"]).toBe("method");
    expect(entity(model, `${legacy}.import`)["kind"]).toBe("method");
  });

  it("writes every edge kind of the profile", () => {
    const model = loadSnapshot();
    const kinds = new Set(model.edges.map((e) => e.edge));
    for (const kind of rubyProfile.edges) expect(kinds, kind).toContain(kind);
    expect(new Set(model.edges.map((e) => e.provenance))).toEqual(new Set(["declared", "derived", "generated"]));
  });
});
