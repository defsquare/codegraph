import { describe, expect, it } from "vitest";
import { TRAIT_NAMES } from "../src/names.js";
import type { TraitName } from "../src/names.js";
import { MARKER_TRAITS, TRAITS, traitSchemaFor } from "../src/traits.js";

/** METAMODEL.md §3, transcribed. Kept literal so drift in TRAITS breaks a test. */
const EXPECTED_KEYS: Record<TraitName, readonly string[]> = {
  TNamed: ["name"],
  TSourceAnchor: ["anchor"],
  TComment: ["comments"],
  TWithChildren: ["children"],
  TChildOf: ["parent"],
  TAttachedTo: ["attachedTo"],
  TModule: ["definedIn", "isStub"],
  TType: ["isStub"],
  TWithInheritances: [],
  TWithImplements: [],
  TTypedEntity: ["declaredType"],
  TInvocable: ["signature"],
  TWithParameters: ["parameters"],
  TWithLocalVariables: ["localVariables"],
  TWithInvocations: [],
  TStructural: [],
  TWithAccesses: [],
};

describe("TRAITS", () => {
  it("covers the closed vocabulary exactly — no missing, no extra trait", () => {
    expect(Object.keys(TRAITS).sort()).toEqual([...TRAIT_NAMES].sort());
  });

  it("contributes exactly the keys METAMODEL.md §3 assigns to each trait", () => {
    for (const trait of TRAIT_NAMES) {
      expect(Object.keys(TRAITS[trait].shape).sort()).toEqual([...EXPECTED_KEYS[trait]].sort());
    }
  });

  it("gives marker traits no keys, and every other trait at least one", () => {
    for (const trait of TRAIT_NAMES) {
      const keyCount = Object.keys(TRAITS[trait].shape).length;
      if (MARKER_TRAITS.has(trait)) {
        expect(keyCount).toBe(0);
      } else {
        expect(keyCount).toBeGreaterThan(0);
      }
    }
  });

  it("accepts any entity for a marker trait — its data lives in edges", () => {
    for (const trait of MARKER_TRAITS) {
      expect(TRAITS[trait].safeParse({}).success).toBe(true);
    }
  });

  it("keeps declaredType optional even when TTypedEntity is declared", () => {
    expect(TRAITS.TTypedEntity.safeParse({}).success).toBe(true);
    expect(TRAITS.TTypedEntity.safeParse({ declaredType: "java:com.acme.billing/Invoice" }).success).toBe(
      true,
    );
    expect(TRAITS.TTypedEntity.safeParse({ declaredType: 42 }).success).toBe(false);
  });

  it("enforces the type of the keys it does contribute", () => {
    expect(TRAITS.TNamed.safeParse({ name: "" }).success).toBe(false);
    expect(TRAITS.TType.safeParse({ isStub: "true" }).success).toBe(false);
    expect(TRAITS.TWithParameters.safeParse({ parameters: "p" }).success).toBe(false);
    expect(TRAITS.TSourceAnchor.safeParse({ anchor: { file: "A.java", span: [1, 9] } }).success).toBe(
      true,
    );
  });
});

describe("traitSchemaFor", () => {
  it("requires the keys of every listed trait", () => {
    const schema = traitSchemaFor(["TNamed", "TInvocable"]);
    expect(schema.safeParse({ name: "bill", signature: "bill(com.acme.order.Order)" }).success).toBe(true);
    expect(schema.safeParse({ name: "bill" }).success).toBe(false);
    expect(schema.safeParse({ signature: "bill(com.acme.order.Order)" }).success).toBe(false);
  });

  it("constrains nothing for a marker-only composition", () => {
    expect(traitSchemaFor(["TStructural", "TWithAccesses"]).safeParse({ id: "x" }).success).toBe(true);
    expect(traitSchemaFor([]).safeParse({ id: "x" }).success).toBe(true);
  });

  it("preserves keys it does not own, so a whole entity survives parsing", () => {
    const entity = { id: "java:com.acme/Order", kind: "class", traits: ["TNamed"], name: "Order" };
    expect(traitSchemaFor(["TNamed"]).parse(entity)).toEqual(entity);
  });
});
