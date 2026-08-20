import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { ENTITY_REFERENCE_KEYS } from "../src/integrity.js";
import { TRAIT_NAMES, type TraitName } from "../src/names.js";
import { TRAITS } from "../src/traits.js";
import { EdgeRec, EntityRec, WIRE_TRAITS } from "../src/wire.js";

/**
 * `WIRE_TRAITS` is the in-memory `TRAITS` table with references interned. Two
 * tables saying the same thing drift unless something holds them together;
 * this file is that something.
 */

const wireKeys = (trait: TraitName): string[] => Object.keys(WIRE_TRAITS[trait].shape).sort();
const memoryKeys = (trait: TraitName): string[] => Object.keys(TRAITS[trait].shape).sort();

describe("the wire trait table mirrors the in-memory one", () => {
  it("declares the same traits", () => {
    expect(Object.keys(WIRE_TRAITS).sort()).toEqual([...TRAIT_NAMES].sort());
  });

  it("contributes the same keys, trait for trait", () => {
    for (const trait of TRAIT_NAMES) {
      expect(wireKeys(trait), trait).toEqual(memoryKeys(trait));
    }
  });

  /** The whole point of the encoding: an id in memory is an integer on the wire. */
  it("turns every entity reference into a surrogate", () => {
    for (const [trait, spec] of Object.entries(ENTITY_REFERENCE_KEYS)) {
      const shape = WIRE_TRAITS[trait as TraitName].shape as Record<string, z.ZodType>;
      const field = shape[spec.key];
      expect(field, `${trait}.${spec.key}`).toBeDefined();
      const sample = spec.many ? [0, 1] : 0;
      expect(field!.safeParse(sample).success, `${trait}.${spec.key} accepts surrogates`).toBe(true);
      const asIds = spec.many ? ["x:m/A"] : "x:m/A";
      expect(field!.safeParse(asIds).success, `${trait}.${spec.key} rejects rendered ids`).toBe(
        false,
      );
    }
  });

  it("interns paths too — anchors and definedIn are file references", () => {
    expect(WIRE_TRAITS.TSourceAnchor.shape.anchor.safeParse([0, 1, 2]).success).toBe(true);
    expect(
      WIRE_TRAITS.TSourceAnchor.shape.anchor.safeParse({ file: "A.java", span: [1, 2] }).success,
    ).toBe(false);
    expect(WIRE_TRAITS.TModule.shape.definedIn.safeParse([0, 3]).success).toBe(true);
    expect(WIRE_TRAITS.TModule.shape.definedIn.safeParse(["A.java"]).success).toBe(false);
  });

  it("keeps a span 1-based and a reference non-negative", () => {
    expect(WIRE_TRAITS.TSourceAnchor.shape.anchor.safeParse([0, 0, 2]).success).toBe(false);
    expect(WIRE_TRAITS.TChildOf.shape.parent.safeParse(-1).success).toBe(false);
    expect(WIRE_TRAITS.TChildOf.shape.parent.safeParse(1.5).success).toBe(false);
  });

  it("gives TWithChildren no key at all (MM-2)", () => {
    expect(wireKeys("TWithChildren")).toEqual([]);
  });
});

describe("the entity record types every key a trait can contribute", () => {
  it("has a property for each, so nothing rides through unchecked", () => {
    const properties = Object.keys(EntityRec.shape);
    for (const trait of TRAIT_NAMES) {
      for (const key of wireKeys(trait)) expect(properties, `${trait}.${key}`).toContain(key);
    }
  });

  it("rejects a trait key of the wrong wire type", () => {
    const base = { t: "e", i: 0, k: 0, tr: [0], m: 0, s: "A" };
    expect(EntityRec.safeParse({ ...base, parent: "x:m/A" }).success).toBe(false);
    expect(EntityRec.safeParse({ ...base, parent: 0 }).success).toBe(true);
    expect(EntityRec.safeParse({ ...base, anchor: { file: "A", span: [1, 2] } }).success).toBe(false);
  });

  it("lets an unknown key through — an extractor may annotate its output", () => {
    const parsed = EntityRec.safeParse({ t: "e", i: 0, k: 0, tr: [], m: 0, s: "A", vendor: 42 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as Record<string, unknown>)["vendor"]).toBe(42);
  });
});

describe("the edge record", () => {
  const base = { t: "x", k: 0, f: 1, o: 2, p: 0, anchor: [0, 1, 1] };

  it("accepts the minimum an edge must carry", () => {
    expect(EdgeRec.safeParse(base).success).toBe(true);
  });

  it("refuses an edge with no evidence or no provenance", () => {
    const { anchor: _anchor, ...noAnchor } = base;
    const { p: _p, ...noProvenance } = base;
    expect(EdgeRec.safeParse(noAnchor).success).toBe(false);
    expect(EdgeRec.safeParse(noProvenance).success).toBe(false);
  });

  it("takes candidates and sourceFile as references, never as strings", () => {
    expect(EdgeRec.safeParse({ ...base, candidates: [3, 4] }).success).toBe(true);
    expect(EdgeRec.safeParse({ ...base, candidates: ["x:m/A"] }).success).toBe(false);
    expect(EdgeRec.safeParse({ ...base, sourceFile: 2 }).success).toBe(true);
    expect(EdgeRec.safeParse({ ...base, sourceFile: "A.java" }).success).toBe(false);
  });
});
