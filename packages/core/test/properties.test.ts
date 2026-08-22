import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Entity } from "../src/entity.js";
import { Edge, isSelfReference } from "../src/edges.js";
import { Model, SCHEMA_VERSION, parseModel } from "../src/model.js";
import { PROVENANCES } from "../src/primitives.js";
import { EDGE_KINDS, TRAIT_NAMES, type TraitName } from "../src/names.js";
import {
  NaturalKey,
  compareNaturalKeys,
  duplicateNaturalKeys,
  naturalKeyIssues,
  naturalKeysEqual,
  renderId,
  sortByNaturalKey,
  parseRenderedId,
} from "../src/identity.js";
import { decodeModel, encodeModel } from "../src/jsonl.js";
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
      "TWithLocalVariables",
      "TWithParameters",
    ]);
    // `children` is absent BY DECISION (MM-2), not by omission: it is the exact
    // inverse of `parent`, so storing it would violate invariant 4 twice over.
    expect(Object.values(ENTITY_REFERENCE_KEYS).map((spec) => spec.key)).not.toContain("children");
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

/**
 * Structured identity (MM-1). The whole point of promoting identity from an
 * opaque string to a tuple is that uniqueness becomes checkable component-wise;
 * these properties say the tuple and its display projection never disagree.
 */
describe("natural keys (MM-1)", () => {
  const NUL = "\u0000";

  // Drawn from an alphabet made of the separators themselves, then sanitized to
  // the component's own rules: random text would never produce a near-collision.
  const pieceArb = fc.oneof(
    // `a`/`b` together with `a.b`, `a/b`, `ab` make every separator collision
    // reachable: drop or weaken one and two distinct keys render identically.
    fc.constantFrom("a", "b", "a.b", "a/b", "ab", "a:b", "S.f(a.b.C)", "<unnamed>", "#", ""),
    fc.string({ maxLength: 4 }),
  );

  function strip(value: string, reserved: readonly string[]): string {
    return [...value].filter((char) => !reserved.includes(char)).join("");
  }

  const naturalKeyArb: fc.Arbitrary<NaturalKey> = fc
    .tuple(pieceArb, pieceArb, pieceArb, fc.option(pieceArb, { nil: undefined }))
    .map(([lang, module, symbol, disambiguator]) => {
      const cleaned = disambiguator === undefined ? undefined : strip(disambiguator, [NUL]);
      return {
        lang: strip(lang, [":", NUL]) || "java",
        module: strip(module, ["/", "#", NUL]) || "m",
        symbol: strip(symbol, ["#", NUL]),
        disambiguator: cleaned === undefined || cleaned === "" ? undefined : cleaned,
      };
    });

  it("generates only keys core considers well-formed", () => {
    fc.assert(
      fc.property(naturalKeyArb, (key) => {
        expect(naturalKeyIssues(key)).toEqual([]);
        expect(NaturalKey.safeParse(key).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("renders two keys alike exactly when they ARE alike", () => {
    fc.assert(
      fc.property(naturalKeyArb, naturalKeyArb, (a, b) => {
        expect(renderId(a) === renderId(b)).toBe(naturalKeysEqual(a, b));
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The migration statement: v1 asserts uniqueness of the rendered id, v2
   * asserts it of the key. This is what makes the second imply the first, so no
   * entity can vanish when M6 switches identity over to the tuple.
   */
  it("unique keys imply unique rendered ids", () => {
    fc.assert(
      fc.property(fc.array(naturalKeyArb, { maxLength: 40 }), (keys) => {
        fc.pre(duplicateNaturalKeys(keys).length === 0);
        expect(new Set(keys.map(renderId)).size).toBe(keys.length);
      }),
      { numRuns: 200 },
    );
  });

  it("reports duplicates exactly where component-wise comparison finds them", () => {
    fc.assert(
      fc.property(fc.array(naturalKeyArb, { maxLength: 25 }), (keys) => {
        // Deliberately naive O(n²) oracle: it uses only naturalKeysEqual, so it
        // cannot share a bug with the index-based grouping it is checking.
        const naive = keys
          .map((key, index) => ({ key, index }))
          .filter(({ key }) => keys.filter((other) => naturalKeysEqual(key, other)).length > 1)
          .map(({ index }) => index);

        const reported = duplicateNaturalKeys(keys)
          .flatMap((duplicate) => duplicate.positions)
          .sort((a, b) => a - b);
        expect(reported).toEqual(naive);
      }),
      { numRuns: 200 },
    );
  });

  it("orders keys totally, and agrees with equality", () => {
    fc.assert(
      fc.property(naturalKeyArb, naturalKeyArb, (a, b) => {
        const forward = compareNaturalKeys(a, b);
        // As a SUM, not as `-Math.sign(forward)`: `Object.is(0, -0)` is false,
        // so negating the sign of an equal pair produces `-0` and the assertion
        // fails on the sign of zero rather than on the order. This generator
        // draws components from a small alphabet, so it does produce equal
        // pairs — rarely enough that the seed decided whether the suite passed.
        expect(Math.sign(forward) + Math.sign(compareNaturalKeys(b, a))).toBe(0);
        expect(forward === 0).toBe(naturalKeysEqual(a, b));
      }),
      { numRuns: 400 },
    );
  });

  it("is transitive, so sorting is well defined", () => {
    fc.assert(
      fc.property(naturalKeyArb, naturalKeyArb, naturalKeyArb, (a, b, c) => {
        fc.pre(compareNaturalKeys(a, b) <= 0 && compareNaturalKeys(b, c) <= 0);
        expect(compareNaturalKeys(a, c)).toBeLessThanOrEqual(0);
      }),
      { numRuns: 400 },
    );
  });

  it("puts a model in canonical order regardless of the order it arrived in", () => {
    fc.assert(
      fc.property(
        fc.array(naturalKeyArb, { maxLength: 30 }),
        fc.array(fc.nat(), { maxLength: 30 }),
        (keys, seed) => {
          // A deterministic reshuffle: same multiset, different arrival order.
          const shuffled = keys
            .map((key, i) => ({ key, at: (seed[i] ?? i) % (keys.length + 1) }))
            .sort((x, y) => x.at - y.at)
            .map(({ key }) => key);
          const ordered = (input: NaturalKey[]) => sortByNaturalKey(input, (k) => k).map(renderId);
          expect(ordered(shuffled)).toEqual(ordered(keys));
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * The JSONL encoding (M6), generatively. The concrete tests pin the contract on
 * one real corpus; these say the same things for models nobody wrote by hand.
 */
describe("the JSONL interchange round-trips (M6)", () => {
  /**
   * Ids are RENDERED from generated keys rather than assembled as strings: a
   * hand-built string like `l:m/#d` is not in renderId's image, and the encoder
   * rightly refuses it. What the format must round-trip is what core can emit.
   */
  const symbolArb = fc.constantFrom("T", "T.m()", "T.m(int)", "T.Inner", "T.f", "a.b.C", "T.m(a.b.C)");
  const disambiguatorArb = fc.option(fc.constantFrom("F.java:1", "F.java:2", "param:x", "local:t:9"), {
    nil: undefined,
  });

  const MODULES = ["m", "m.x", "<unnamed>"] as const;

  /** A model whose entities are keyed properly: one module entity per module. */
  function jsonlModelArb(lang: string): fc.Arbitrary<Model> {
    const memberArb = fc
      .tuple(fc.constantFrom(...MODULES), symbolArb, disambiguatorArb)
      .map(([module, symbol, disambiguator]) => ({ lang, module, symbol, disambiguator }));

    return fc.array(memberArb, { maxLength: 25 }).map((members) => {
      const keys = new Map<string, NaturalKey>();
      for (const module of MODULES) keys.set(renderId({ lang, module, symbol: "" }), { lang, module, symbol: "" });
      for (const key of members) keys.set(renderId(key), key);

      const ids = [...keys.keys()];
      const entities = ids.map((id, index) => {
        const isModule = keys.get(id)!.symbol === "";
        return isModule
          ? { id, kind: "package", traits: ["TNamed", "TModule"], name: "m", definedIn: ["A.java"], isStub: false }
          : {
              id,
              kind: "class",
              traits: ["TNamed", "TChildOf", "TSourceAnchor", "TType"],
              name: `n${index}`,
              parent: renderId({ lang, module: keys.get(id)!.module, symbol: "" }),
              anchor: { file: `F${index % 3}.java`, span: [index + 1, index + 2] },
              isStub: index % 5 === 0,
            };
      });

      const members2 = ids.filter((id) => keys.get(id)!.symbol !== "");
      const edges = members2.slice(0, -1).map((from, index) => ({
        edge: "reference" as const,
        from,
        to: members2[index + 1]!,
        provenance: index % 2 === 0 ? ("declared" as const) : ("derived" as const),
        anchor: { file: `F${index % 3}.java`, span: [index + 1, index + 1] },
      }));

      return parseModel({
        schemaVersion: SCHEMA_VERSION,
        lang,
        extractor: { name: "gen", version: "0.0.0" },
        root: "/corpus",
        entities,
        edges,
      });
    });
  }

  const modelsArb = fc.constantFrom("java", "clj", "ts").chain((lang) => jsonlModelArb(lang));

  it("preserves every entity and edge", () => {
    fc.assert(
      fc.property(modelsArb, (model) => {
        const back = decodeModel([...encodeModel(model)]);
        expect(back.entities.map((e) => e.id).sort()).toEqual(model.entities.map((e) => e.id).sort());
        expect(back.edges.length).toBe(model.edges.length);
        const before = new Map(model.entities.map((e) => [e.id, e]));
        for (const entity of back.entities) expect(entity).toEqual(before.get(entity.id));
      }),
      { numRuns: 120 },
    );
  });

  it("writes no rendered id — identity travels as (m, s, d)", () => {
    fc.assert(
      fc.property(modelsArb, (model) => {
        const text = [...encodeModel(model)].join("\n");
        for (const entity of model.entities) expect(text).not.toContain(entity.id);
      }),
      { numRuns: 80 },
    );
  });

  it("is byte-identical for the same model, whatever order it arrived in", () => {
    fc.assert(
      fc.property(modelsArb, (model) => {
        const once = [...encodeModel(model)].join("\n");
        // Entities AND edges: canonical order must be imposed on both, or two
        // extractor runs that visit the corpus differently produce different
        // bytes for one model.
        const reversed: Model = {
          ...model,
          entities: [...model.entities].reverse(),
          edges: [...model.edges].reverse(),
        };
        expect([...encodeModel(reversed)].join("\n")).toBe(once);
      }),
      { numRuns: 80 },
    );
  });

  /** Every proper prefix is a truncated file, and none may decode as complete. */
  it("refuses every truncation", () => {
    fc.assert(
      fc.property(modelsArb, fc.nat(), (model, cut) => {
        const all = [...encodeModel(model)];
        const at = cut % all.length;
        expect(() => decodeModel(all.slice(0, at))).toThrow();
      }),
      { numRuns: 120 },
    );
  });

  it("assigns surrogates in canonical natural-key order", () => {
    fc.assert(
      fc.property(modelsArb, (model) => {
        const back = decodeModel([...encodeModel(model)]);
        const keys = back.entities.map((entity) => parseRenderedId(entity.id));
        for (let i = 1; i < keys.length; i += 1) {
          expect(compareNaturalKeys(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
        }
      }),
      { numRuns: 80 },
    );
  });
});
