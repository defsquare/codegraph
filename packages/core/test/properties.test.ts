import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Entity } from "../src/entity.js";
import { Edge, isSelfReference } from "../src/edges.js";
import { Model, SCHEMA_VERSION, parseModel } from "../src/model.js";
import { PROVENANCES } from "../src/primitives.js";
import { EDGE_KINDS, TRAIT_NAMES, type TraitName } from "../src/names.js";
import { MARKER_TRAITS } from "../src/traits.js";
import { ENTITY_REFERENCE_KEYS, selfReferences, unknownReferences } from "../src/integrity.js";
import { validateEntity, validateModel, type Profile } from "../src/profile.js";
import { PROFILES } from "../src/profiles/index.js";

/**
 * PLAN.md §8. These are the invariants the metamodel claims to hold for ANY
 * conforming model, so they are stated generatively rather than as examples.
 * Closure and self-reference are exercised here against core's own helpers;
 * the analyzer (M3) runs the same helpers over the union of models.
 */

const profiles = Object.values(PROFILES);

const idArb = fc
  .tuple(fc.constantFrom(...profiles.map((p) => p.lang)), fc.string({ minLength: 1, maxLength: 12 }))
  .map(([lang, sym]) => `${lang}:m/${sym}`);

const anchorArb = fc
  .tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 200 }))
  .map(([file, start, len]) => ({ file, span: [start, start + len] as [number, number] }));

const textArb = fc.string({ minLength: 1, maxLength: 20 });

/** The keys each trait contributes, generated so a valid entity is built by construction. */
function traitKeys(trait: TraitName, ids: fc.Arbitrary<string>): Record<string, fc.Arbitrary<unknown>> {
  switch (trait) {
    case "TNamed":
      return { name: textArb };
    case "TSourceAnchor":
      return { anchor: anchorArb };
    case "TComment":
      return { comments: fc.array(fc.string(), { maxLength: 3 }) };
    case "TWithChildren":
      return { children: fc.array(ids, { maxLength: 4 }) };
    case "TChildOf":
      return { parent: ids };
    case "TAttachedTo":
      return { attachedTo: ids };
    case "TModule":
      return { definedIn: fc.array(textArb, { maxLength: 3 }), isStub: fc.boolean() };
    case "TType":
      return { isStub: fc.boolean() };
    case "TTypedEntity":
      // Optional even when declared — the generator must exercise both.
      return { declaredType: fc.option(ids, { nil: undefined }) };
    case "TInvocable":
      return { signature: textArb };
    case "TWithParameters":
      return { parameters: fc.array(ids, { maxLength: 4 }) };
    case "TWithLocalVariables":
      return { localVariables: fc.array(ids, { maxLength: 4 }) };
    default:
      return {}; // markers contribute nothing
  }
}

/**
 * An arbitrary entity licensed by `profile`: a declared kind, its full required
 * trait set plus any subset of the optional ones, and exactly the keys those
 * traits contribute.
 */
function entityArb(profile: Profile, ids: fc.Arbitrary<string> = idArb): fc.Arbitrary<unknown> {
  const kinds = Object.keys(profile.kinds);
  return fc.constantFrom(...kinds).chain((kind) => {
    const spec = profile.kinds[kind]!;
    const spaces = profile.space?.[kind];
    return fc
      .tuple(
        ids,
        fc.subarray([...spec.optional]),
        spaces === undefined
          ? fc.constant(undefined)
          : fc.option(fc.subarray([...spaces], { minLength: 1 }), { nil: undefined }),
      )
      .chain(([id, extra, space]) => {
        const traits = [...spec.required, ...extra];
        const shape: Record<string, fc.Arbitrary<unknown>> = {};
        for (const trait of traits) Object.assign(shape, traitKeys(trait, ids));
        return fc.record(shape).map((keys) => {
          const entity: Record<string, unknown> = { id, kind, traits, ...keys };
          if (space !== undefined) entity["space"] = space;
          // fc.record emits explicit `undefined` for optional keys; JSON drops
          // them, so drop them here too and keep the value JSON-faithful.
          for (const [k, v] of Object.entries(entity)) if (v === undefined) delete entity[k];
          return entity;
        });
      });
  });
}

/** An arbitrary edge of a kind the profile licenses, pointing at ids it knows. */
function edgeArb(profile: Profile, ids: fc.Arbitrary<string>): fc.Arbitrary<unknown> {
  return fc
    .tuple(
      fc.constantFrom(...profile.edges),
      ids,
      ids,
      fc.constantFrom(...PROVENANCES),
      anchorArb,
      fc.option(fc.array(ids, { minLength: 1, maxLength: 3 }), { nil: undefined }),
      fc.option(textArb, { nil: undefined }),
      fc.boolean(),
      fc.boolean(),
    )
    .map(([kind, from, to, provenance, anchor, candidates, sourceFile, isRead, isWrite]) => {
      const edge: Record<string, unknown> = { edge: kind, from, to, provenance, anchor };
      if (candidates !== undefined) edge["candidates"] = candidates;
      if (sourceFile !== undefined) edge["sourceFile"] = sourceFile;
      if (kind === "access") {
        edge["isRead"] = isRead;
        edge["isWrite"] = isWrite;
      }
      return edge;
    });
}

/**
 * A whole conforming model. Ids are drawn from one unique pool and every entity
 * takes a distinct one, so the model is closed and free of id conflicts by
 * construction — which is what makes the closure property meaningful when it
 * later runs on real extractor output.
 */
function modelArb(profile: Profile): fc.Arbitrary<unknown> {
  return fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 8 })
    .chain((symbols) => {
      const pool = symbols.map((s) => `${profile.lang}:m/${s}`);
      const ids = fc.constantFrom(...pool);
      return fc
        .tuple(
          fc.tuple(...pool.map(() => entityArb(profile, ids))),
          fc.array(edgeArb(profile, ids), { maxLength: 8 }),
          textArb,
          textArb,
        )
        .map(([entities, edges, name, root]) => ({
          schemaVersion: SCHEMA_VERSION,
          lang: profile.lang,
          extractor: { name, version: "0.0.0" },
          root,
          // Give each generated entity a distinct id from the pool.
          entities: entities.map((e, i) => ({ ...(e as object), id: pool[i]! })),
          edges,
        }));
    });
}

describe.each(profiles.map((p) => [p.lang, p] as const))(
  "%s — generated entities always satisfy their own profile",
  (_lang, profile) => {
    it("passes validateEntity and the Entity schema", () => {
      fc.assert(
        fc.property(entityArb(profile), (raw) => {
          const parsed = Entity.parse(raw);
          expect(validateEntity(profile, parsed)).toEqual([]);
        }),
        { numRuns: 120 },
      );
    });

    // The mirror image: the locked rule is only worth something if it also
    // says no. Adding any trait the kind does not license must be caught.
    it("rejects any trait outside required ∪ optional (the upper bound)", () => {
      fc.assert(
        fc.property(entityArb(profile), fc.constantFrom(...TRAIT_NAMES), (raw, intruder) => {
          const entity = raw as Record<string, unknown>;
          const kind = entity["kind"] as string;
          const spec = profile.kinds[kind]!;
          fc.pre(![...spec.required, ...spec.optional].includes(intruder));

          const traits = [...(entity["traits"] as TraitName[]), intruder];
          const codes = validateEntity(profile, { ...entity, traits } as never).map((i) => i.code);
          expect(codes).toContain("trait-not-allowed");
        }),
        { numRuns: 150 },
      );
    });

    // And the trait-key rule: dropping a key a declared trait contributes must
    // fail the Entity schema, in every profile, for every key-bearing trait.
    it("rejects a declared trait whose contributed key is missing", () => {
      fc.assert(
        fc.property(entityArb(profile), fc.nat(), (raw, pick) => {
          const entity = raw as Record<string, unknown>;
          const bearing = (entity["traits"] as TraitName[]).filter((t) => !MARKER_TRAITS.has(t));
          fc.pre(bearing.length > 0);

          const trait = bearing[pick % bearing.length]!;
          const keys = Object.keys(traitKeys(trait, idArb));
          // TTypedEntity's key is legitimately optional — nothing to drop.
          fc.pre(trait !== "TTypedEntity" && keys.length > 0);

          const stripped = { ...entity };
          for (const key of keys) delete stripped[key];
          expect(Entity.safeParse(stripped).success, `${trait} without ${keys.join(",")}`).toBe(
            false,
          );
        }),
        { numRuns: 150 },
      );
    });
  },
);

describe("JSON round-trip is stable (PLAN §8)", () => {
  it("parse → serialize → parse is a fixed point for every profile", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...profiles).chain((p) => modelArb(p)),
        (raw) => {
          const once = parseModel(raw);
          const twice = parseModel(JSON.parse(JSON.stringify(once)));
          expect(twice).toEqual(once);
          // Serialization is deterministic: same input, byte-identical output.
          expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a generated model always re-parses from its own JSON text", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...profiles).chain((p) => modelArb(p)),
        (raw) => {
          const text = JSON.stringify(raw);
          expect(Model.safeParse(JSON.parse(text)).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("provenance (METAMODEL §1.3)", () => {
  // Transcribed from METAMODEL §1.3, NOT read from PROVENANCES: asserting
  // against the same constant the generator draws from would be tautological
  // and a fifth value could be added without a single test failing.
  const THE_FOUR = ["declared", "derived", "dynamic-candidate", "generated"] as const;

  it("is exactly the four values of METAMODEL §1.3 — no more, no fewer", () => {
    expect([...PROVENANCES]).toEqual([...THE_FOUR]);
  });

  it("is always one of the four values on a parsed edge", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...profiles).chain((p) => modelArb(p)),
        (raw) => {
          for (const edge of parseModel(raw).edges) {
            expect(THE_FOUR).toContain(edge.provenance);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects any value outside the four, on every edge kind", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EDGE_KINDS),
        fc.string(),
        anchorArb,
        (kind, provenance, anchor) => {
          fc.pre(!(THE_FOUR as readonly string[]).includes(provenance));
          const edge: Record<string, unknown> = {
            edge: kind,
            from: "a:m/x",
            to: "a:m/y",
            provenance,
            anchor,
          };
          if (kind === "access") {
            edge["isRead"] = true;
            edge["isWrite"] = false;
          }
          expect(Edge.safeParse(edge).success).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is never defaulted: omitting it fails on every edge kind", () => {
    for (const kind of EDGE_KINDS) {
      const edge: Record<string, unknown> = {
        edge: kind,
        from: "a:m/x",
        to: "a:m/y",
        anchor: { file: "a", span: [1, 1] },
        ...(kind === "access" ? { isRead: true, isWrite: false } : {}),
      };
      expect(Edge.safeParse(edge).success, `${kind} without provenance`).toBe(false);
      expect(
        Edge.safeParse({ ...edge, provenance: "declared" }).success,
        `${kind} with provenance`,
      ).toBe(true);
    }
  });

  it("is never defaulted for the anchor either — every claim carries evidence", () => {
    for (const kind of EDGE_KINDS) {
      const edge: Record<string, unknown> = {
        edge: kind,
        from: "a:m/x",
        to: "a:m/y",
        provenance: "declared",
        ...(kind === "access" ? { isRead: true, isWrite: false } : {}),
      };
      expect(Edge.safeParse(edge).success, `${kind} without anchor`).toBe(false);
    }
  });
});

describe("graph integrity helpers (CLAUDE.md 4 and 10)", () => {
  it("a model built from its own id pool is closed", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...profiles).chain((p) => modelArb(p)),
        (raw) => {
          expect(unknownReferences(parseModel(raw))).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("reports exactly the references that leave the corpus, stubs counting as known", () => {
    const model = parseModel({
      schemaVersion: SCHEMA_VERSION,
      lang: "java",
      extractor: { name: "t", version: "0" },
      root: "/c",
      entities: [
        {
          id: "java:a/A",
          kind: "class",
          traits: ["TNamed", "TType", "TChildOf"],
          name: "A",
          isStub: false,
          parent: "java:a/Missing",
        },
        { id: "java:jdk/String", kind: "class", traits: ["TNamed", "TType"], name: "String", isStub: true },
      ],
      edges: [
        {
          edge: "reference",
          from: "java:a/A",
          to: "java:jdk/String",
          provenance: "declared",
          anchor: { file: "A.java", span: [1, 1] },
        },
      ],
    });
    // The stub target resolves; only the dangling parent is reported.
    expect(unknownReferences(model)).toEqual([
      { path: "entities[0].parent", id: "java:a/Missing" },
    ]);
    // …and it stops being a hole once a sibling model declares it.
    expect(unknownReferences(model, ["java:a/Missing"])).toEqual([]);
  });

  it("flags self-references without the parser rejecting them", () => {
    fc.assert(
      fc.property(idArb, fc.constantFrom(...EDGE_KINDS), anchorArb, (id, kind, anchor) => {
        const raw: Record<string, unknown> = {
          edge: kind,
          from: id,
          to: id,
          provenance: "declared",
          anchor,
          ...(kind === "access" ? { isRead: true, isWrite: false } : {}),
        };
        const edge = Edge.parse(raw);
        expect(isSelfReference(edge)).toBe(true);
        const model = parseModel({
          schemaVersion: SCHEMA_VERSION,
          lang: "java",
          extractor: { name: "t", version: "0" },
          root: "/c",
          entities: [{ id, kind: "class", traits: [] }],
          edges: [raw],
        });
        expect(selfReferences(model)).toHaveLength(1);
      }),
      { numRuns: 60 },
    );
  });

  it("knows every EntityId-valued trait key, and no inverse-index key", () => {
    // METAMODEL §3, transcribed: the traits whose keys are EntityIds.
    expect(Object.keys(ENTITY_REFERENCE_KEYS).sort()).toEqual([
      "TAttachedTo",
      "TChildOf",
      "TTypedEntity",
      "TWithChildren",
      "TWithLocalVariables",
      "TWithParameters",
    ]);
    // CLAUDE.md invariant 4: inverse views are derived, never stored — so no
    // trait may contribute one. Guards against a "convenient" future addition.
    const forbidden = ["callers", "incoming", "subtypes", "importers", "accessors", "implementers"];
    for (const trait of TRAIT_NAMES) {
      const keys = MARKER_TRAITS.has(trait) ? [] : Object.values(ENTITY_REFERENCE_KEYS).map((s) => s.key);
      for (const key of keys) expect(forbidden).not.toContain(key);
    }
  });
});

describe("profile validity holds for whole generated models (PLAN §8)", () => {
  it("validateModel finds nothing to report on a model built from its profile", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...profiles).chain((p) => fc.tuple(fc.constant(p), modelArb(p))),
        ([profile, raw]) => {
          expect(validateModel(parseModel(raw), profile)).toEqual([]);
        },
      ),
      { numRuns: 120 },
    );
  });
});
