import { fileURLToPath } from "node:url";
import { PROFILES, TRAIT_NAMES, readModelFileSync, type Entity, type TraitName } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, ROLES, roleOf, structuralSlots, type Role } from "../src/weight.js";

/**
 * The role of the entity carrying a name decides the weight of its words
 * (PLAN.md §20.1). It comes from TRAITS, never from the kind: a kind is a
 * profile's word, a trait is the metamodel's — the navigator's rule.
 */

function entity(id: string, traits: readonly TraitName[], extra: Record<string, unknown> = {}): Entity {
  return { id, kind: "anything", traits: [...traits], ...extra } as Entity;
}

const NO_SLOTS = structuralSlots([]);

describe("the roles and their default weights", () => {
  it("are a closed set, from the outermost container in", () => {
    expect(ROLES).toEqual(["module", "type", "operation", "attribute", "parameter", "local", "other"]);
  });

  it("weigh a named concept most and an incidental name least", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      module: 8,
      type: 8,
      operation: 3,
      attribute: 4,
      parameter: 1,
      local: 1,
      other: 1,
    });
    expect(Object.keys(DEFAULT_WEIGHTS).sort()).toEqual([...ROLES].sort());
  });
});

describe("roleOf", () => {
  it("reads the traits in a fixed order: module, type, operation, structural", () => {
    expect(roleOf(entity("a", ["TNamed", "TModule"]), NO_SLOTS)).toBe("module");
    expect(roleOf(entity("a", ["TNamed", "TModule", "TType"]), NO_SLOTS)).toBe("module");
    // A C# delegate is a type that can be invoked.
    expect(roleOf(entity("a", ["TNamed", "TType", "TInvocable", "TWithParameters"]), NO_SLOTS)).toBe("type");
    // A Clojure fn-var: TNamed + TStructural + TInvocable (invariant 1).
    expect(roleOf(entity("a", ["TNamed", "TStructural", "TInvocable"]), NO_SLOTS)).toBe("operation");
    expect(roleOf(entity("a", ["TNamed", "TStructural"]), NO_SLOTS)).toBe("attribute");
    expect(roleOf(entity("a", ["TNamed"]), NO_SLOTS)).toBe("other");
  });

  it("tells a parameter and a local from an attribute by who lists them", () => {
    const op = entity("op", ["TNamed", "TInvocable", "TWithParameters", "TWithLocalVariables"], {
      parameters: ["p"],
      localVariables: ["l"],
    });
    const slots = structuralSlots([op]);
    expect(roleOf(entity("p", ["TNamed", "TStructural"]), slots)).toBe("parameter");
    expect(roleOf(entity("l", ["TNamed", "TStructural"]), slots)).toBe("local");
    expect(roleOf(entity("f", ["TNamed", "TStructural"]), slots)).toBe("attribute");
  });

  it("never reads the kind", () => {
    const traits = fc.subarray([...TRAIT_NAMES]);
    fc.assert(
      fc.property(traits, fc.string(), fc.string(), (picked, a, b) => {
        const one = { ...entity("x", picked), kind: a || "a" } as Entity;
        const two = { ...entity("x", picked), kind: b || "b" } as Entity;
        expect(roleOf(one, NO_SLOTS)).toBe(roleOf(two, NO_SLOTS));
      }),
    );
  });
});

describe("the shipped profiles", () => {
  // Every kind's role, read from its required traits — slots aside, which only
  // a model decides. The `other` row is the honest one: a kind no role trait
  // describes still has a name, and its words still count.
  const roles = new Map<string, Role>();
  for (const [lang, profile] of Object.entries(PROFILES)) {
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      roles.set(`${lang}:${kind}`, roleOf(entity(kind, spec.required), NO_SLOTS));
    }
  }
  const having = (role: Role): readonly string[] =>
    [...roles].filter(([, r]) => r === role).map(([key]) => key).sort();

  it("give no role trait to five kinds, three of them named", () => {
    expect(having("other")).toEqual([
      "clj:implBlock",
      "php:codeFile",
      "python:decorator",
      "rust:impl",
      "ts:namespace",
    ]);
  });

  it("make every file kind a module except PHP's code file", () => {
    for (const [lang, profile] of Object.entries(PROFILES)) {
      for (const kind of profile.lexicon?.fileKinds ?? []) {
        expect(roles.get(`${lang}:${kind}`), `${lang}:${kind}`).toBe(kind === "codeFile" ? "other" : "module");
      }
    }
  });

  it("make a delegate a type and a Clojure function an operation", () => {
    expect(roles.get("csharp:delegate")).toBe("type");
    expect(roles.get("clj:function")).toBe("operation");
    expect(roles.get("clj:multimethod")).toBe("operation");
    expect(roles.get("ex:module")).toBe("type");
    expect(roles.get("ex:file")).toBe("module");
  });
});

describe("the fixtures", () => {
  const FIXTURES = ["java", "csharp", "typescript", "elixir", "ruby"] as const;

  it.each(FIXTURES)("%s: every parameter and local variable is found by its parent's list", (fixture) => {
    const model = readModelFileSync(
      fileURLToPath(new URL(`../../../fixtures/${fixture}/expected/model.jsonl`, import.meta.url)),
    );
    const slots = structuralSlots(model.entities);
    const roles = (kind: string): Map<string, Role> =>
      new Map(model.entities.filter((e) => e.kind === kind).map((e) => [e.id, roleOf(e, slots)]));
    const unlisted = [...roles("parameter")].filter(([, role]) => role !== "parameter").map(([id]) => id);
    // The C# indexer's parameter is a child of its `property`, and the C#
    // profile gives a property no TWithParameters: the model lists it nowhere,
    // so it weighs as an attribute. A gap in the model, not guessed around
    // from the kind — pinned so that its fix shows here.
    expect(unlisted).toEqual(
      fixture === "csharp" ? ["csharp:Acme.Order/Basket.Item(System.Int32)#param:index"] : [],
    );
    expect([...new Set(roles("localVariable").values())]).toEqual(
      model.entities.some((e) => e.kind === "localVariable") ? ["local"] : [],
    );
    // TypeScript's namespace is the one fixture kind without a role trait.
    const other = model.entities.filter((e) => roleOf(e, slots) === "other").map((e) => `${model.lang}:${e.kind}`);
    expect([...new Set(other)]).toEqual(fixture === "typescript" ? ["ts:namespace"] : []);
  });
});
