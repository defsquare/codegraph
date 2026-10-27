import { describe, expect, it } from "vitest";
import { EDGE_KINDS, TRAIT_NAMES } from "../src/names.js";
import { SPACES } from "../src/primitives.js";
import { Entity } from "../src/entity.js";
import { parseModel, SCHEMA_VERSION } from "../src/model.js";
import { ProfileSchema, validateEntity, validateModel, validateProfile, type Profile } from "../src/profile.js";
import {
  PROFILES,
  clojureProfile,
  elixirProfile,
  getProfile,
  rubyProfile,
  typescriptProfile,
} from "../src/profiles/index.js";

// Profiles are data; this suite is the check that the data stays inside the
// canonical vocabularies and keeps saying what each language actually is.
const profiles: readonly [string, Profile][] = Object.entries(PROFILES).sort(([a], [b]) =>
  a.localeCompare(b),
);

// The lang id is the EntityId prefix (METAMODEL.md §1.1), so it is part of the
// published contract: changing one invalidates every id an extractor emitted.
const EXPECTED_LANGS = [
  "clj",
  "csharp",
  "ex",
  "go",
  "java",
  "js",
  "php",
  "python",
  "rb",
  "rust",
  "ts",
] as const;

describe("the eleven shipped profiles", () => {
  it("registers exactly eleven profiles under unique langs", () => {
    expect(profiles).toHaveLength(11);
    expect(profiles.map(([lang]) => lang)).toEqual([...EXPECTED_LANGS].sort());
  });

  it("keys the registry by each profile's own lang", () => {
    for (const [lang, profile] of profiles) {
      expect(profile.lang).toBe(lang);
      expect(getProfile(lang)).toBe(profile);
    }
  });

  it("resolves nothing for an unknown lang, including Object.prototype names", () => {
    expect(getProfile("cobol")).toBeUndefined();
    expect(getProfile("constructor")).toBeUndefined();
    expect(getProfile("toString")).toBeUndefined();
  });

  it.each(profiles)("%s is valid against the canonical vocabularies", (_lang, profile) => {
    expect(validateProfile(profile)).toEqual([]);
  });

  it.each(profiles)("%s declares at least one kind and one edge kind", (_lang, profile) => {
    expect(Object.keys(profile.kinds).length).toBeGreaterThan(0);
    expect(profile.edges.length).toBeGreaterThan(0);
  });

  it.each(profiles)("%s uses only canonical trait names", (_lang, profile) => {
    const known = new Set<string>(TRAIT_NAMES);
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      for (const trait of [...spec.required, ...spec.optional]) {
        expect(known, `${profile.lang}.${kind}: ${trait}`).toContain(trait);
      }
    }
  });

  it.each(profiles)("%s uses only canonical edge kinds", (_lang, profile) => {
    const known = new Set<string>(EDGE_KINDS);
    for (const edge of profile.edges) {
      expect(known, `${profile.lang}: ${edge}`).toContain(edge);
    }
  });

  it.each(profiles)("%s never lists a trait as both required and optional", (_lang, profile) => {
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      const required = new Set<string>(spec.required);
      const overlap = spec.optional.filter((trait) => required.has(trait));
      expect(overlap, `${profile.lang}.${kind}`).toEqual([]);
    }
  });

  it.each(profiles)("%s lists no duplicate traits or edge kinds", (_lang, profile) => {
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      expect(new Set(spec.required).size, `${profile.lang}.${kind}.required`).toBe(
        spec.required.length,
      );
      expect(new Set(spec.optional).size, `${profile.lang}.${kind}.optional`).toBe(
        spec.optional.length,
      );
    }
    expect(new Set(profile.edges).size, `${profile.lang}.edges`).toBe(profile.edges.length);
  });

  it.each(profiles)("%s documents its static-analysis blind spots", (_lang, profile) => {
    expect(profile.notes?.length ?? 0).toBeGreaterThan(0);
  });
});

// These are claims about the languages themselves. They must fail loudly if a
// later edit "tidies" a profile into saying something the language does not do.
describe("structural claims that must not silently regress", () => {
  it("Go has no inheritance — neither the edge kind nor the trait", () => {
    const go = PROFILES["go"];
    expect(go).toBeDefined();
    expect(go?.edges).not.toContain("inheritance");
    for (const spec of Object.values(go?.kinds ?? {})) {
      expect([...spec.required, ...spec.optional]).not.toContain("TWithInheritances");
    }
  });

  it("Go carries composition as embedding and attaches methods to their receiver", () => {
    const go = PROFILES["go"];
    expect(go?.edges).toContain("embedding");
    expect(go?.kinds["method"]?.required).toContain("TAttachedTo");
    expect(go?.kinds["method"]?.required).toContain("TChildOf");
  });

  it("Rust has no inheritance — neither the edge kind nor the trait", () => {
    const rust = PROFILES["rust"];
    expect(rust).toBeDefined();
    expect(rust?.edges).not.toContain("inheritance");
    for (const spec of Object.values(rust?.kinds ?? {})) {
      expect([...spec.required, ...spec.optional]).not.toContain("TWithInheritances");
    }
  });

  it("Rust reifies the impl block: attached, anonymous, owning its methods (METAMODEL §7)", () => {
    const impl = PROFILES["rust"]?.kinds["impl"];
    expect(impl).toBeDefined();
    expect(impl?.required).toContain("TAttachedTo");
    expect(impl?.required).toContain("TWithChildren");
    expect(impl?.required).toContain("TSourceAnchor");
    expect([...(impl?.required ?? []), ...(impl?.optional ?? [])]).not.toContain("TNamed");
  });

  it("Clojure licenses the composition no hierarchy can express (METAMODEL §3.7)", () => {
    const clj = PROFILES["clj"];
    expect(clj).toBeDefined();
    const wanted = ["TNamed", "TStructural", "TInvocable"];
    // required ⊆ {TNamed,TStructural,TInvocable} ⊆ required ∪ optional.
    const licensing = Object.entries(clj?.kinds ?? {}).filter(([, spec]) => {
      const allowed = new Set<string>([...spec.required, ...spec.optional]);
      return (
        spec.required.every((trait) => wanted.includes(trait)) &&
        wanted.every((trait) => allowed.has(trait))
      );
    });
    expect(licensing.length).toBeGreaterThan(0);
  });

  // The declaration above says the profile ALLOWS the composition. This runs it:
  // a real fn-var entity, parsed by the Entity schema and validated against the
  // shipped Clojure profile. It is the acceptance case of the whole trait design
  // (METAMODEL §3.7, PLAN Phase 1 deliverable) and must never regress to a
  // profile-shape assertion.
  it("validates a real Clojure fn-var as TNamed + TStructural + TInvocable", () => {
    const clj = clojureProfile;
    const fnVar = Entity.parse({
      id: "clj:acme.order/bill",
      kind: "function",
      traits: ["TNamed", "TStructural", "TInvocable"],
      name: "bill",
      signature: "([order] [order opts])",
    });

    expect(validateEntity(clj, fnVar)).toEqual([]);

    // Named, value holder and invocable at once — and the trait set is exactly
    // the kind's required set, so nothing optional is propping it up.
    expect([...clj.kinds["function"]!.required].sort()).toEqual([
      "TInvocable",
      "TNamed",
      "TStructural",
    ]);

    // Dropping any one of the three breaks it: all three are load-bearing.
    for (const dropped of ["TNamed", "TStructural", "TInvocable"] as const) {
      const partial = {
        ...fnVar,
        traits: fnVar.traits.filter((t) => t !== dropped),
      } as unknown as Entity;
      expect(
        validateEntity(clj, partial).map((i) => i.code),
        `dropping ${dropped}`,
      ).toEqual(["missing-required-trait"]);
    }
  });

  it("carries the fn-var through a full model round-trip under its own profile", () => {
    const model = parseModel({
      schemaVersion: SCHEMA_VERSION,
      lang: "clj",
      extractor: { name: "clj-kondo-adapter", version: "0.0.0" },
      root: "/corpus",
      entities: [
        {
          id: "clj:acme.order/bill",
          kind: "function",
          traits: ["TNamed", "TStructural", "TInvocable"],
          name: "bill",
          signature: "([order])",
        },
        {
          id: "clj:acme.tax/apply-tax",
          kind: "function",
          traits: ["TNamed", "TStructural", "TInvocable"],
          name: "apply-tax",
          signature: "([amount])",
        },
      ],
      edges: [
        {
          edge: "invocation",
          from: "clj:acme.order/bill",
          to: "clj:acme.tax/apply-tax",
          provenance: "declared",
          anchor: { file: "src/acme/order.clj", span: [12, 12] },
        },
      ],
    });
    expect(validateModel(model, clojureProfile)).toEqual([]);
  });

  /**
   * C# profile v2 (PLAN §13.2): the corrections M12 forces on a profile that
   * predates M6 (executable containment) and M10 (measures, values,
   * annotation usage, throw sites). Each claim below is one the extractor
   * emits against, so relaxing any of them silently un-licenses real output.
   */
  describe("C# profile v2 licenses what the Roslyn extractor emits", () => {
    const cs = PROFILES["csharp"]!;
    const allowed = (kind: string): Set<string> =>
      new Set([...(cs.kinds[kind]?.required ?? []), ...(cs.kinds[kind]?.optional ?? [])]);

    it("licenses executable containment (M6): every kind holding parameters or locals is a container", () => {
      for (const kind of ["method", "constructor", "lambda", "delegate", "property"]) {
        expect(cs.kinds[kind]?.required, `csharp.${kind}`).toContain("TWithChildren");
      }
    });

    it("carries measures on every type and invocable (M10b)", () => {
      for (const kind of ["class", "interface", "struct", "record", "enum", "delegate", "method", "constructor", "lambda", "property"]) {
        expect(allowed(kind), `csharp.${kind}`).toContain("TMetrics");
      }
    });

    it("opens the value door on constants and defaults (M10c)", () => {
      expect(allowed("field")).toContain("TWithValue");
      expect(allowed("parameter")).toContain("TWithValue");
    });

    it("names attributes as annotationUse and throw sites as throws", () => {
      expect(cs.edges).toContain("annotationUse");
      expect(cs.edges).toContain("throws");
    });

    it("has an event kind: a value-shaped member with its own declaration site", () => {
      expect([...(cs.kinds["event"]?.required ?? [])].sort()).toEqual(
        ["TChildOf", "TNamed", "TSourceAnchor", "TStructural", "TTypedEntity"],
      );
    });

    it("disambiguates nameless invocables by column, and drops dynamic call sites (notes)", () => {
      const notes = cs.notes?.join("\n") ?? "";
      expect(notes).toMatch(/column/);
      expect(notes).toMatch(/dynamic/);
      expect(notes).not.toMatch(/candidates list/);
    });
  });

  /**
   * TypeScript profile v2 (PLAN §14.2): the corrections M13 forces on a
   * profile that predates M6, M10 and M12. Each claim is one the compiler-API
   * extractor emits against, so relaxing any of them un-licenses real output.
   */
  describe("TypeScript profile v2 licenses what the compiler-API extractor emits", () => {
    const ts = typescriptProfile;
    const allowed = (kind: string): Set<string> =>
      new Set([...(ts.kinds[kind]?.required ?? []), ...(ts.kinds[kind]?.optional ?? [])]);

    it("has a constructor kind: invocable, a container, unnamed and untyped", () => {
      const ctor = ts.kinds["constructor"];
      expect(ctor).toBeDefined();
      expect(ctor?.required).toContain("TInvocable");
      expect(ctor?.required).toContain("TWithChildren");
      expect(allowed("constructor")).not.toContain("TNamed");
      expect(allowed("constructor")).not.toContain("TTypedEntity");
      expect(ts.space?.["constructor"]).toEqual(["value"]);
    });

    it("licenses executable containment (M6): every kind holding parameters or locals is a container", () => {
      for (const kind of ["function", "method", "constructor", "arrowFunction"]) {
        expect(ts.kinds[kind]?.required, `ts.${kind}`).toContain("TWithChildren");
        expect(ts.kinds[kind]?.required, `ts.${kind}`).toContain("TWithLocalVariables");
      }
    });

    it("lets a module body invoke, access and hold locals: top-level statements are code", () => {
      for (const trait of ["TWithInvocations", "TWithAccesses", "TWithLocalVariables"]) {
        expect(allowed("module"), trait).toContain(trait);
      }
    });

    it("carries measures on every type and invocable (M10b)", () => {
      for (const kind of ["class", "abstractClass", "interface", "typeAlias", "enum", "function", "method", "constructor", "arrowFunction", "module", "namespace"]) {
        expect(allowed(kind), `ts.${kind}`).toContain("TMetrics");
      }
    });

    it("opens the value door on constants, members and defaults (M10c)", () => {
      expect(allowed("variable")).toContain("TWithValue");
      expect(allowed("property")).toContain("TWithValue");
      expect(allowed("parameter")).toContain("TWithValue");
    });

    it("names decorators as annotationUse and throw sites as throws", () => {
      expect(ts.edges).toContain("annotationUse");
      expect(ts.edges).toContain("throws");
    });

    it("keeps a namespace a child entity, never a module of its own", () => {
      expect(allowed("namespace")).not.toContain("TModule");
      expect(ts.kinds["namespace"]?.required).toContain("TChildOf");
    });

    it("documents the id scheme: percent-encoded keys, per-file merging, column disambiguators, dropped any-receivers", () => {
      const notes = ts.notes?.join("\n") ?? "";
      expect(notes).toMatch(/%2F/);
      expect(notes).toMatch(/PER DECLARING FILE/);
      expect(notes).toMatch(/line:column/);
      expect(notes).toMatch(/dropped and COUNTED/);
      expect(notes).not.toMatch(/one namespace id may span files/);
    });
  });

  // `fileInclude` exists because PHP's module is the namespace, so a file-to-file
  // dependency needs endpoints of its own; a language whose module IS the file
  // (Ruby's `require`) says the same thing with `import`. `traitUsage` is the
  // mixin relation, never flattened: PHP's `use TraitX;` and Ruby's
  // `include`/`extend`/`prepend`, and nothing else.
  it("PHP alone has fileInclude; traitUsage belongs to the mixin languages, PHP and Ruby", () => {
    for (const [lang, profile] of profiles) {
      expect(profile.edges.includes("fileInclude"), `${lang}.fileInclude`).toBe(lang === "php");
      expect(profile.edges.includes("traitUsage"), `${lang}.traitUsage`).toBe(lang === "php" || lang === "rb");
    }
    expect(PROFILES["php"]?.kinds["codeFile"]).toBeDefined();
    expect(PROFILES["rb"]?.kinds["codeFile"]).toBeUndefined();
  });

  // Every language has external types (JDK, npm, crates.io, Composer…), so
  // every profile must be able to hold the canonical degraded stub of
  // METAMODEL §6 / PLAN §5.2 — otherwise that language cannot be extracted.
  it.each(profiles)("%s can represent the canonical TNamed+TType stub", (_lang, profile) => {
    const holders = Object.entries(profile.kinds).filter(([, spec]) => {
      const allowed = new Set<string>([...spec.required, ...spec.optional]);
      return allowed.has("TNamed") && allowed.has("TType");
    });
    expect(holders.length, `${profile.lang} has no kind licensing TNamed+TType`).toBeGreaterThan(0);

    for (const [kind] of holders) {
      const stub = {
        id: `${profile.lang}:external/Thing`,
        kind,
        traits: ["TNamed", "TType"],
        name: "Thing",
        isStub: true,
      } as unknown as Entity;
      expect(validateEntity(profile, stub), `${profile.lang}.${kind}`).toEqual([]);
    }
  });

  it("TypeScript is the only profile declaring declaration spaces (METAMODEL §1.4)", () => {
    for (const [lang, profile] of profiles) {
      if (lang === "ts") expect(profile.space, "ts must declare space").toBeDefined();
      else expect(profile.space, `${lang} must not declare space`).toBeUndefined();
    }
  });

  it("TypeScript's space map covers every kind, with type-only types", () => {
    const space = typescriptProfile.space ?? {};
    const known = new Set<string>(SPACES);
    for (const kind of Object.keys(typescriptProfile.kinds)) {
      const spaces = space[kind];
      expect(spaces, `ts.${kind} has no space`).toBeDefined();
      expect(spaces?.length ?? 0).toBeGreaterThan(0);
      for (const s of spaces ?? []) expect(known).toContain(s);
    }
    // The erasure claim: interfaces and type aliases leave nothing at runtime.
    expect(space["interface"]).toEqual(["type"]);
    expect(space["typeAlias"]).toEqual(["type"]);
    expect(space["class"]).toEqual(["type", "value"]);
    expect(space["function"]).toEqual(["value"]);
    // An interface's members are type-space; a class's are values.
    expect(space["method"]).toEqual(["type", "value"]);
    expect(space["property"]).toEqual(["type", "value"]);
  });

  it("TypeScript's kinds are a strict superset of JavaScript's", () => {
    const js = Object.keys(PROFILES["js"]?.kinds ?? {});
    const ts = new Set(Object.keys(typescriptProfile.kinds));
    expect(js.length).toBeGreaterThan(0);
    for (const kind of js) expect(ts, `ts is missing js kind ${kind}`).toContain(kind);
    expect(ts.size).toBeGreaterThan(js.length);
  });

  /**
   * Elixir profile (PLAN §16.2): the module is the file and a `defmodule` is
   * a `module` kind carrying TType, so every claim the parser-as-library
   * extractor emits against is pinned here as data.
   */
  describe("Elixir profile licenses what the parser extractor emits", () => {
    const ex = elixirProfile;

    it("makes the file the module and the defmodule a type below it", () => {
      expect(ex.kinds["file"]?.required).toEqual(["TNamed", "TModule", "TWithChildren"]);
      expect(ex.kinds["module"]?.required).toContain("TType");
      expect(ex.kinds["module"]?.required).toContain("TChildOf");
      expect(ex.kinds["module"]?.required).not.toContain("TModule");
      // A defimpl block is attached to the type it implements for.
      expect(ex.kinds["module"]?.optional).toContain("TAttachedTo");
      expect(ex.kinds["module"]?.optional).toContain("TWithImplements");
    });

    it("has neither inheritance nor embedding, and every invocable is a container", () => {
      expect(ex.edges).not.toContain("inheritance");
      expect(ex.edges).not.toContain("embedding");
      for (const kind of Object.values(ex.kinds)) {
        expect(kind.required).not.toContain("TWithInheritances");
        expect(kind.optional).not.toContain("TWithInheritances");
      }
      for (const kind of ["function", "macro", "callback"]) {
        expect(ex.kinds[kind]?.required, kind).toContain("TWithChildren");
        expect(ex.kinds[kind]?.required, kind).toContain("TWithParameters");
      }
      // A callback has no body: no invocations, no accesses.
      expect(ex.kinds["callback"]?.required).not.toContain("TWithInvocations");
      expect(ex.kinds["function"]?.required).toContain("TWithInvocations");
    });

    it("validates a defmodule, its arity-keyed function and an external stub under <otp>", () => {
      const model = parseModel({
        schemaVersion: SCHEMA_VERSION,
        lang: "ex",
        extractor: { name: "codegraph-elixir", version: "0.0.0" },
        root: "fixtures/elixir/src",
        entities: [
          {
            id: "ex:lib%2Forder.ex",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"],
            name: "lib/order.ex",
            definedIn: ["lib/order.ex"],
            isStub: false,
            anchor: { file: "lib/order.ex", span: [1, 9] },
          },
          {
            id: "ex:lib%2Forder.ex/Acme%2EOrder",
            kind: "module",
            traits: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor", "TWithImplements"],
            name: "Acme.Order",
            isStub: false,
            parent: "ex:lib%2Forder.ex",
            anchor: { file: "lib/order.ex", span: [1, 9] },
          },
          {
            id: "ex:lib%2Forder.ex/Acme%2EOrder.total#2",
            kind: "function",
            traits: [
              "TNamed",
              "TInvocable",
              "TWithChildren",
              "TWithParameters",
              "TWithInvocations",
              "TWithAccesses",
              "TChildOf",
              "TSourceAnchor",
            ],
            name: "total",
            signature: "total/2",
            parameters: [],
            parent: "ex:lib%2Forder.ex/Acme%2EOrder",
            anchor: { file: "lib/order.ex", span: [4, 8] },
          },
          {
            id: "ex:<otp>",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren"],
            name: "<otp>",
            definedIn: [],
            isStub: true,
          },
          {
            id: "ex:<otp>/GenServer",
            kind: "module",
            traits: ["TNamed", "TType", "TChildOf"],
            name: "GenServer",
            isStub: true,
            parent: "ex:<otp>",
          },
        ],
        edges: [
          {
            edge: "import",
            from: "ex:lib%2Forder.ex",
            to: "ex:<otp>/GenServer",
            provenance: "declared",
            anchor: { file: "lib/order.ex", span: [2, 2] },
          },
          {
            edge: "interfaceImplementation",
            from: "ex:lib%2Forder.ex/Acme%2EOrder",
            to: "ex:<otp>/GenServer",
            provenance: "declared",
            anchor: { file: "lib/order.ex", span: [3, 3] },
          },
        ],
      });
      expect(validateModel(model, ex).map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
    });

    it("refuses a defmodule that claims to be a module of its own", () => {
      const rogue = Entity.parse({
        id: "ex:lib%2Forder.ex/Acme%2EOrder",
        kind: "module",
        traits: ["TNamed", "TType", "TModule", "TWithChildren", "TChildOf", "TSourceAnchor"],
        name: "Acme.Order",
        definedIn: ["lib/order.ex"],
        isStub: false,
        parent: "ex:lib%2Forder.ex",
        anchor: { file: "lib/order.ex", span: [1, 9] },
      });
      expect(validateEntity(ex, rogue).map((i) => i.code)).toEqual(["trait-not-allowed"]);
    });
  });

  /**
   * Ruby profile (PLAN §19.2): the module is the file, `class` and `module`
   * are types below it, mixins are `traitUsage`, and a `require` is an
   * `import` — every claim the Prism extractor emits against, pinned as data.
   */
  describe("Ruby profile licenses what the Prism extractor emits", () => {
    const rb = rubyProfile;
    const allowed = (kind: string): Set<string> =>
      new Set([...(rb.kinds[kind]?.required ?? []), ...(rb.kinds[kind]?.optional ?? [])]);

    it("makes the file the module, and a class or a module a type below it", () => {
      expect(rb.kinds["file"]?.required).toEqual(["TNamed", "TModule", "TWithChildren"]);
      for (const kind of ["class", "module"]) {
        expect(rb.kinds[kind]?.required, kind).toContain("TType");
        expect(rb.kinds[kind]?.required, kind).toContain("TChildOf");
        expect(allowed(kind), kind).not.toContain("TModule");
      }
    });

    it("gives inheritance to classes only: a Ruby module mixes in, it never inherits", () => {
      expect(rb.edges).toContain("inheritance");
      expect(rb.kinds["class"]?.required).toContain("TWithInheritances");
      expect(allowed("module")).not.toContain("TWithInheritances");
    });

    it("lets a reopening name the declaration it belongs to", () => {
      // Containment is where a body is written; attachment is the type it is a body OF.
      for (const kind of ["class", "module"]) expect(allowed(kind), kind).toContain("TAttachedTo");
      expect(rb.notes?.join("\n") ?? "").toMatch(/attachedTo/);
    });

    it("says mixins with traitUsage and has no interface to implement", () => {
      expect(rb.edges).toContain("traitUsage");
      expect(rb.edges).not.toContain("interfaceImplementation");
      expect(rb.edges).not.toContain("fileInclude");
      for (const kind of Object.keys(rb.kinds)) expect(allowed(kind), kind).not.toContain("TWithImplements");
    });

    it("lets a file and a type body run code: top-level statements and class macros are calls", () => {
      for (const kind of ["file", "class", "module"]) {
        expect(allowed(kind), kind).toContain("TWithInvocations");
        expect(allowed(kind), kind).toContain("TWithAccesses");
      }
    });

    it("makes a method a container of its parameters, a parameter nameable but not always named", () => {
      expect(rb.kinds["method"]?.required).toContain("TWithChildren");
      expect(rb.kinds["method"]?.required).toContain("TWithParameters");
      // `def each(*, &)`: anonymous rest and block parameters are legal Ruby.
      expect(rb.kinds["parameter"]?.required).not.toContain("TNamed");
      expect(allowed("parameter")).toContain("TNamed");
    });

    it("documents the id scheme, the wrapper rule and the stated ceiling", () => {
      const notes = rb.notes?.join("\n") ?? "";
      expect(notes).toMatch(/%2F/);
      expect(notes).toMatch(/PER DECLARING FILE/);
      expect(notes).toMatch(/wrapper/);
      expect(notes).toMatch(/<ruby>/);
      expect(notes).toMatch(/<gems>/);
      expect(notes).toMatch(/dropped and counted/);
    });

    it("validates a class, its mixin, a singleton method and the stubs they point at", () => {
      const model = parseModel({
        schemaVersion: SCHEMA_VERSION,
        lang: "rb",
        extractor: { name: "codegraph-ruby", version: "0.0.0" },
        root: "fixtures/ruby/src",
        entities: [
          {
            id: "rb:lib%2Facme%2Forder.rb",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"],
            name: "lib/acme/order.rb",
            definedIn: ["lib/acme/order.rb"],
            isStub: false,
            anchor: { file: "lib/acme/order.rb", span: [1, 12] },
          },
          {
            id: "rb:lib%2Facme%2Fpriceable.rb",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"],
            name: "lib/acme/priceable.rb",
            definedIn: ["lib/acme/priceable.rb"],
            isStub: false,
            anchor: { file: "lib/acme/priceable.rb", span: [1, 5] },
          },
          {
            id: "rb:lib%2Facme%2Fpriceable.rb/Acme::Priceable",
            kind: "module",
            traits: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
            name: "Acme::Priceable",
            isStub: false,
            parent: "rb:lib%2Facme%2Fpriceable.rb",
            anchor: { file: "lib/acme/priceable.rb", span: [2, 4] },
          },
          {
            id: "rb:lib%2Facme%2Forder.rb/Acme::Order",
            kind: "class",
            traits: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
            name: "Acme::Order",
            isStub: false,
            parent: "rb:lib%2Facme%2Forder.rb",
            anchor: { file: "lib/acme/order.rb", span: [3, 11] },
          },
          {
            id: "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self",
            kind: "method",
            traits: [
              "TNamed",
              "TInvocable",
              "TWithChildren",
              "TWithParameters",
              "TWithInvocations",
              "TWithAccesses",
              "TChildOf",
              "TSourceAnchor",
            ],
            name: "call",
            signature: "self.call(*)",
            parameters: ["rb:lib%2Facme%2Forder.rb/Acme::Order.call#self#param:1"],
            parent: "rb:lib%2Facme%2Forder.rb/Acme::Order",
            anchor: { file: "lib/acme/order.rb", span: [6, 8] },
          },
          {
            id: "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self#param:1",
            kind: "parameter",
            traits: ["TStructural", "TChildOf", "TSourceAnchor"],
            parent: "rb:lib%2Facme%2Forder.rb/Acme::Order.call#self",
            anchor: { file: "lib/acme/order.rb", span: [6, 6] },
          },
          {
            id: "rb:<ruby>",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren"],
            name: "<ruby>",
            definedIn: [],
            isStub: true,
          },
          {
            id: "rb:<ruby>/StandardError",
            kind: "class",
            traits: ["TNamed", "TType", "TChildOf"],
            name: "StandardError",
            isStub: true,
            parent: "rb:<ruby>",
          },
          {
            id: "rb:<gems>%2Fbigdecimal",
            kind: "file",
            traits: ["TNamed", "TModule", "TWithChildren"],
            name: "bigdecimal",
            definedIn: [],
            isStub: true,
          },
        ],
        edges: [
          {
            edge: "import",
            from: "rb:lib%2Facme%2Forder.rb",
            to: "rb:<gems>%2Fbigdecimal",
            provenance: "declared",
            anchor: { file: "lib/acme/order.rb", span: [1, 1] },
          },
          {
            // Nothing requires priceable.rb: the constant reference is the import (Zeitwerk).
            edge: "import",
            from: "rb:lib%2Facme%2Forder.rb",
            to: "rb:lib%2Facme%2Fpriceable.rb",
            provenance: "derived",
            anchor: { file: "lib/acme/order.rb", span: [4, 4] },
          },
          {
            edge: "inheritance",
            from: "rb:lib%2Facme%2Forder.rb/Acme::Order",
            to: "rb:<ruby>/StandardError",
            provenance: "declared",
            anchor: { file: "lib/acme/order.rb", span: [3, 3] },
          },
          {
            edge: "traitUsage",
            from: "rb:lib%2Facme%2Forder.rb/Acme::Order",
            to: "rb:lib%2Facme%2Fpriceable.rb/Acme::Priceable",
            provenance: "declared",
            anchor: { file: "lib/acme/order.rb", span: [4, 4] },
          },
        ],
      });
      expect(validateModel(model, rb).map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
    });

    it("refuses a Ruby module that claims a superclass, and a class that claims to be a module of its own", () => {
      const inheriting = Entity.parse({
        id: "rb:lib%2Fa.rb/Acme::Priceable",
        kind: "module",
        traits: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
        name: "Acme::Priceable",
        isStub: false,
        parent: "rb:lib%2Fa.rb",
        anchor: { file: "lib/a.rb", span: [1, 3] },
      });
      expect(validateEntity(rb, inheriting).map((i) => i.code)).toEqual(["trait-not-allowed"]);
      const rogue = Entity.parse({
        id: "rb:lib%2Fa.rb/Acme::Order",
        kind: "class",
        traits: ["TNamed", "TType", "TModule", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
        name: "Acme::Order",
        definedIn: ["lib/a.rb"],
        isStub: false,
        parent: "rb:lib%2Fa.rb",
        anchor: { file: "lib/a.rb", span: [1, 3] },
      });
      expect(validateEntity(rb, rogue).map((i) => i.code)).toEqual(["trait-not-allowed"]);
    });
  });
});

/**
 * The lexicon (PLAN.md §20.1): what the vocabulary splitter must know about a
 * language and cannot derive. Every claim below is about the LANGUAGE — its
 * specification's reserved words, the names its runtime dictates — so a later
 * edit that "tidies" a list into something the language does not say fails here.
 */
describe("the lexicon of every shipped profile", () => {
  const lexiconOf = (lang: string) => {
    const lexicon = getProfile(lang)?.lexicon;
    if (lexicon === undefined) throw new Error(`no lexicon for ${lang}`);
    return lexicon;
  };

  it.each(profiles)("%s has a lexicon with its reserved words", (_lang, profile) => {
    expect(profile.lexicon?.keywords.length ?? 0).toBeGreaterThan(0);
  });

  it.each(profiles)("%s parses through ProfileSchema unchanged", (_lang, profile) => {
    expect(ProfileSchema.parse(profile)).toEqual(profile);
  });

  it("lists the conventional names the plan names, per language", () => {
    expect(lexiconOf("java").conventional).toEqual(expect.arrayContaining(["toString", "equals", "hashCode", "main"]));
    expect(lexiconOf("rb").conventional).toEqual(expect.arrayContaining(["initialize", "to_s", "inspect", "<=>"]));
    expect(lexiconOf("ts").conventional).toEqual(expect.arrayContaining(["constructor"]));
    expect(lexiconOf("ex").conventional).toEqual(expect.arrayContaining(["__using__", "start_link", "init", "handle_call"]));
    expect(lexiconOf("csharp").conventional).toEqual(
      expect.arrayContaining(["Equals", "GetHashCode", "ToString", "Dispose", "Main"]),
    );
    expect(lexiconOf("python").conventional).toEqual(expect.arrayContaining(["__init__", "self", "cls"]));
  });

  // A contextual keyword is a legal identifier, and often a domain word: listing
  // it would tag every `record`, `event` handler or `match` in the corpus as syntax.
  it("lists reserved words only, never contextual ones", () => {
    const contextual: Readonly<Record<string, readonly string[]>> = {
      java: ["record", "var", "yield", "sealed", "permits", "module", "when", "to"],
      csharp: ["var", "async", "await", "record", "value", "get", "set", "where", "from", "select"],
      ts: ["type", "namespace", "module", "declare", "readonly", "of", "get", "set", "async"],
      js: ["of", "get", "set", "async", "from"],
      python: ["match", "case", "type", "_"],
      rust: ["union", "macro_rules", "default"],
      php: ["enum"],
    };
    for (const [lang, words] of Object.entries(contextual)) {
      const keywords = new Set(lexiconOf(lang).keywords);
      for (const word of words) expect(keywords.has(word), `${lang} lists ${word}`).toBe(false);
    }
  });

  it("knows which languages reserve which words", () => {
    // `type` is reserved by Go and Rust; to Java and TypeScript it is an identifier.
    expect(lexiconOf("go").keywords).toContain("type");
    expect(lexiconOf("rust").keywords).toContain("type");
    expect(lexiconOf("java").keywords).not.toContain("type");
    expect(lexiconOf("ts").keywords).not.toContain("type");
    // Rust reserves both spellings of the receiver; Ruby spells its block ends.
    expect(lexiconOf("rust").keywords).toEqual(expect.arrayContaining(["self", "Self"]));
    expect(lexiconOf("rb").keywords).toEqual(expect.arrayContaining(["end", "begin", "BEGIN", "END"]));
    expect(lexiconOf("ex").keywords).toEqual(expect.arrayContaining(["do", "end", "fn", "when"]));
  });

  it("strips the interface marker in C# alone", () => {
    for (const [lang, profile] of profiles) {
      expect(profile.lexicon?.interfacePrefix === true, lang).toBe(lang === "csharp");
    }
  });

  // A file kind's name is a path whose extension is not a word. Elixir's
  // `module` is a dotted name (`AcmeOrder.Registry`), not a file: declaring it
  // would drop `.Registry` as an extension.
  it("declares exactly the kinds whose name is a file path", () => {
    const fileKinds = Object.fromEntries(
      profiles.flatMap(([lang, profile]) => (profile.lexicon?.fileKinds === undefined ? [] : [[lang, profile.lexicon.fileKinds]])),
    );
    expect(fileKinds).toEqual({
      ex: ["file"],
      js: ["module"],
      php: ["codeFile"],
      rb: ["file"],
      ts: ["module"],
    });
  });

  // A kind is qualified when the LANGUAGE names it by a path: a Java package is
  // `com.acme.order`, a Ruby class `AcmeOrder::Order::Line`, an Elixir module
  // `AcmeOrder.Pricing`. Go's package and Rust's module are named by one
  // identifier (`package order`, `mod line`), their paths being something else.
  it("declares exactly the kinds a language names by a qualified path", () => {
    const qualified = Object.fromEntries(
      profiles.flatMap(([lang, profile]) => (profile.lexicon?.qualified === undefined ? [] : [[lang, profile.lexicon.qualified]])),
    );
    expect(qualified).toEqual({
      clj: { namespace: "." },
      csharp: { namespace: "." },
      ex: { file: "/", module: ".", protocol: "." },
      java: { package: "." },
      js: { module: "/" },
      php: { codeFile: "/", namespace: "\\" },
      python: { module: "." },
      rb: { file: "/", class: "::", module: "::", constant: "::" },
      ts: { module: "/" },
    });
  });

  it("qualifies every file kind by its directories", () => {
    for (const [lang, profile] of profiles) {
      for (const kind of profile.lexicon?.fileKinds ?? []) expect(profile.lexicon?.qualified?.[kind], `${lang}:${kind}`).toBe("/");
    }
  });
});
