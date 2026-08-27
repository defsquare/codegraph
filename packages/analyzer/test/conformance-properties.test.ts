import {
  PROFILES,
  PROVENANCES,
  SCHEMA_VERSION,
  getProfile,
  isStubEntity,
  parseModel,
  validateModel,
  type Edge,
  type Entity,
  type EntityId,
  type Model,
  type Profile,
  type Provenance,
  type TraitName,
} from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import { isClean, loadModels, type ModelUnion } from "../src/load.js";
import { compareIds } from "../src/order.js";

/**
 * PLAN.md §8, generative half: the conformance checker is exercised against
 * models GENERATED from a real profile rather than against the one committed
 * fixture.
 *
 * The shape of the test matters as much as the invariants it names. A checker
 * that always reports something passes "detects a dangling edge"; a checker
 * that never reports anything passes "a valid model is clean". Only the pair —
 * one targeted mutation at a time, each producing a finding the clean model
 * does not produce, and each producing a DIFFERENT finding code — proves the
 * checker discriminates between invariants instead of merely having an opinion.
 *
 * THE CONTRACT CODED AGAINST (`../src/conformance.ts`, written in parallel):
 *   checkConformance(union: ModelUnion, options?) -> ConformanceReport
 *   - the report exposes its findings as an array: `report.findings`
 *     (a report that IS an array is accepted too);
 *   - every finding carries a string `code` — consumers match on codes, never
 *     on messages, exactly as `ValidationIssue`/`ProfileIssue` already do;
 *   - a conformant union yields ZERO findings;
 *   - the call is pure and deterministic.
 * If that module does not exist yet this file fails to import, which is the
 * intended outcome: a property that cannot run must not report success.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A generated corpus is a STAR: one root entity that needs no parent, and n
 * leaves whose every entity-level reference (`parent`, `attachedTo`,
 * `declaredType`) points at that root, with the root's `children` naming them
 * back. Closure holds by construction and containment cannot cycle, so the only
 * way a generated model fails a check is a bug in the generator or in the
 * checker — never an artefact of the shape being generated.
 */
interface EntitySeed {
  readonly kind: string;
  /** How many of the kind's optional traits to add, on top of all required ones. */
  readonly optionals: number;
  /** Only observable on kinds carrying TType/TModule; the traits that own `isStub`. */
  readonly stub: boolean;
}

interface EdgeSeed {
  readonly kindIndex: number;
  readonly from: number;
  /** Distance to the target, always >= 1, so `from !== to` holds by construction. */
  readonly hop: number;
  readonly provenanceIndex: number;
  readonly write: boolean;
}

function shippedProfiles(): readonly Profile[] {
  return [...Object.values(PROFILES)].sort((a, b) => compareIds(a.lang, b.lang));
}

/**
 * Kinds that can be a corpus root: they require neither a parent, an
 * attachment, nor a declared type, so nothing about them has to point anywhere.
 * Every shipped profile has at least one (a package, module, namespace or
 * crate) — a language whose every kind demanded a parent could not have a root,
 * which is itself worth pinning.
 */
function rootKinds(profile: Profile): readonly string[] {
  const rootless: readonly TraitName[] = ["TChildOf", "TAttachedTo", "TTypedEntity"];
  return Object.keys(profile.kinds)
    .filter((kind) => {
      const spec = profile.kinds[kind];
      return spec !== undefined && !spec.required.some((trait) => rootless.includes(trait));
    })
    .sort(compareIds);
}

function requiredOf(profile: Profile, kind: string): readonly TraitName[] {
  return profile.kinds[kind]?.required ?? [];
}

function anchorAt(index: number): { file: string; span: [number, number] } {
  return { file: `E${index}.src`, span: [1 + index, 2 + index] };
}

interface TraitContext {
  readonly index: number;
  readonly isStub: boolean;
  readonly rootId: EntityId;
  /** Non-empty on the root only: the leaves it contains. */
  readonly childIds: readonly EntityId[];
}

/**
 * The keys one trait contributes, populated (METAMODEL.md §3). Exhaustive over
 * `TraitName` on purpose: a new referencing trait must be taught to the
 * generator here, or the compiler refuses the file.
 */
function traitKeys(trait: TraitName, ctx: TraitContext): Record<string, unknown> {
  switch (trait) {
    case "TNamed":
      return { name: `E${ctx.index}` };
    case "TSourceAnchor":
      return { anchor: anchorAt(ctx.index) };
    case "TComment":
      return { comments: [`doc for E${ctx.index}`] };
    case "TWithChildren":
      return { children: [...ctx.childIds] };
    case "TChildOf":
      return { parent: ctx.rootId };
    case "TAttachedTo":
      return { attachedTo: ctx.rootId };
    case "TModule":
      // A stub module is degraded exactly as a stub type is (METAMODEL.md §6):
      // it stands for something outside the corpus, so it is defined nowhere.
      return { definedIn: ctx.isStub ? [] : [`E${ctx.index}.src`], isStub: ctx.isStub };
    case "TType":
      return { isStub: ctx.isStub };
    case "TTypedEntity":
      return { declaredType: ctx.rootId };
    case "TInvocable":
      return { signature: `E${ctx.index}()` };
    case "TWithParameters":
      return { parameters: [] };
    case "TWithLocalVariables":
      return { localVariables: [] };
    // Measures (§3.8): open keys, finite values. Generated deterministically
    // from the index so a corpus stays reproducible.
    case "TMetrics":
      return { metrics: { sloc: ctx.index + 1, cyclomatic: 1 } };
    // Marker traits contribute no keys: what they declare lives in `edges[]`.
    case "TWithInheritances":
    case "TWithImplements":
    case "TWithInvocations":
    case "TStructural":
    case "TWithAccesses":
      return {};
  }
}

function buildEntities(
  profile: Profile,
  rootKind: string,
  seeds: readonly EntitySeed[],
): readonly Entity[] {
  const id = (index: number): EntityId => `${profile.lang}:generated/E${index}`;
  const rootId = id(0);
  const kinds = [rootKind, ...seeds.map((seed) => seed.kind)];
  const childIds = kinds.slice(1).map((_, i) => id(i + 1));

  return kinds.map((kind, index) => {
    const spec = profile.kinds[kind];
    if (spec === undefined) throw new Error(`profile ${profile.lang} does not declare kind ${kind}`);
    const seed = index === 0 ? undefined : seeds[index - 1];
    // The root takes exactly its required traits: an optional trait could add a
    // reference key, and the root is the one entity with nowhere to point.
    const optionals = seed === undefined ? 0 : Math.min(seed.optionals, spec.optional.length);
    const traits: TraitName[] = [...spec.required, ...spec.optional.slice(0, optionals)];
    const ctx: TraitContext = {
      index,
      isStub: seed?.stub ?? false,
      rootId,
      childIds: index === 0 ? childIds : [],
    };

    const entity: Record<string, unknown> = { id: id(index), kind, traits };
    for (const trait of traits) Object.assign(entity, traitKeys(trait, ctx));
    return entity as Entity;
  });
}

function buildEdges(
  profile: Profile,
  ids: readonly EntityId[],
  seeds: readonly EdgeSeed[],
): readonly Edge[] {
  return seeds.map((seed, index) => {
    const fromIndex = seed.from % ids.length;
    const toIndex = (fromIndex + 1 + (seed.hop % (ids.length - 1))) % ids.length;
    const from = ids[fromIndex] ?? "";
    const to = ids[toIndex] ?? "";
    const kind = profile.edges[seed.kindIndex % profile.edges.length] ?? "reference";
    // Edge 0 is pinned uncertain so every generated corpus exercises the
    // candidates path — and so the "empty a candidates array" mutation always
    // has a populated array to empty.
    const provenance: Provenance =
      index === 0
        ? "dynamic-candidate"
        : (PROVENANCES[seed.provenanceIndex % PROVENANCES.length] ?? "declared");

    const edge: Record<string, unknown> = {
      edge: kind,
      from,
      to,
      provenance,
      anchor: anchorAt(index),
    };
    // `candidates` non-empty iff dispatch was uncertain (PLAN.md §8).
    if (provenance === "dynamic-candidate") edge["candidates"] = [to];
    if (kind === "access") {
      edge["isRead"] = !seed.write;
      edge["isWrite"] = seed.write;
    }
    return edge as Edge;
  });
}

function buildModel(
  profile: Profile,
  rootKind: string,
  entitySeeds: readonly EntitySeed[],
  edgeSeeds: readonly EdgeSeed[],
): Model {
  const entities = buildEntities(profile, rootKind, entitySeeds);
  return {
    schemaVersion: SCHEMA_VERSION,
    lang: profile.lang,
    extractor: { name: "conformance-properties", version: "0.0.0" },
    root: "generated",
    entities: [...entities],
    edges: [...buildEdges(profile, entities.map((entity) => entity.id), edgeSeeds)],
  };
}

function entitySeedArbitrary(profile: Profile): fc.Arbitrary<EntitySeed> {
  return fc.record({
    kind: fc.constantFrom(...Object.keys(profile.kinds).sort(compareIds)),
    optionals: fc.nat({ max: 4 }),
    stub: fc.boolean(),
  });
}

const edgeSeedArbitrary: fc.Arbitrary<EdgeSeed> = fc.record({
  kindIndex: fc.nat({ max: 8 }),
  from: fc.nat({ max: 5 }),
  hop: fc.nat({ max: 5 }),
  provenanceIndex: fc.nat({ max: PROVENANCES.length - 1 }),
  write: fc.boolean(),
});

/**
 * A model that is valid by construction: profile-conformant entities, closed
 * references, no self-edge, provenance everywhere, an anchor on every edge.
 * Small (2-5 entities, 1-5 edges) so a counterexample is readable after
 * shrinking.
 */
function modelArbitrary(): fc.Arbitrary<Model> {
  return fc.constantFrom(...shippedProfiles()).chain((profile) =>
    fc
      .record({
        rootKind: fc.constantFrom(...rootKinds(profile)),
        entitySeeds: fc.array(entitySeedArbitrary(profile), { minLength: 1, maxLength: 4 }),
        edgeSeeds: fc.array(edgeSeedArbitrary, { minLength: 1, maxLength: 5 }),
      })
      .map(({ rootKind, entitySeeds, edgeSeeds }) =>
        buildModel(profile, rootKind, entitySeeds, edgeSeeds),
      ),
  );
}

/**
 * A union assembled directly, not through `loadModels`. Corruptions like a
 * zeroed span are rejected by `parseModel`, and a checker that only ever sees
 * payloads the schema already blessed is never asked to hold the line itself —
 * so the corrupted model has to reach `checkConformance` intact.
 */
function unionOf(models: readonly Model[]): ModelUnion {
  return {
    models,
    sources: models.map((model, index) => ({
      index,
      label: `generated[${index}].json`,
      lang: model.lang,
    })),
    entities: models.flatMap((model) => model.entities),
    edges: models.flatMap((model) => model.edges),
    langs: [...new Set(models.map((model) => model.lang))].sort(compareIds),
  };
}

// ---------------------------------------------------------------------------
// Reading a report without assuming more of its shape than the contract states
// ---------------------------------------------------------------------------

function findingsOf(report: unknown): readonly unknown[] {
  if (Array.isArray(report)) return report;
  if (typeof report === "object" && report !== null) {
    const findings: unknown = (report as { findings?: unknown }).findings;
    if (Array.isArray(findings)) return findings;
  }
  throw new Error(
    "ConformanceReport must expose its findings as an array (`report.findings`, or the report itself)",
  );
}

/** Every string and every `code` anywhere in the report, cycles and Sets included. */
function scan(report: unknown): { readonly strings: readonly string[]; readonly codes: readonly string[] } {
  const strings: string[] = [];
  const codes: string[] = [];
  const seen = new Set<object>();

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof Map) {
      for (const [key, value] of node) {
        visit(key);
        visit(value);
      }
      return;
    }
    if (node instanceof Set || Array.isArray(node)) {
      for (const item of node as Iterable<unknown>) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const code: unknown = record["code"];
    if (typeof code === "string") codes.push(code);
    for (const value of Object.values(record)) visit(value);
  };

  visit(report);
  return { strings, codes };
}

function mentions(report: unknown, needle: string): boolean {
  return scan(report).strings.some((text) => text.includes(needle));
}

/** The set of codes a report raised, canonicalized so two runs compare as one string. */
function codeSignature(report: unknown): string {
  return [...new Set(scan(report).codes)].sort(compareIds).join(" | ");
}

// ---------------------------------------------------------------------------
// One targeted mutation each — the discrimination harness
// ---------------------------------------------------------------------------

interface Corruption {
  readonly name: string;
  /** The invariant it breaks, for the failure message. */
  readonly invariant: string;
  readonly apply: (model: Model) => { readonly model: Model; readonly marker: string };
}

function firstEdge(model: Model): Edge {
  const edge = model.edges[0];
  if (edge === undefined) throw new Error("the generator must emit at least one edge");
  return edge;
}

const CORRUPTIONS: readonly Corruption[] = [
  {
    name: "a dangling edge target",
    invariant: "closure: no edge points at an unknown id (CLAUDE.md 10)",
    apply: (model) => {
      const broken = structuredClone(model);
      const marker = `${model.lang}:generated/PHANTOM#0`;
      firstEdge(broken).to = marker;
      return { model: broken, marker };
    },
  },
  {
    name: "a self-referencing edge",
    invariant: "from !== to on every edge (METAMODEL.md §4)",
    apply: (model) => {
      const broken = structuredClone(model);
      const edge = firstEdge(broken);
      edge.to = edge.from;
      return { model: broken, marker: edge.from };
    },
  },
  {
    name: "an emptied candidates array",
    invariant: "candidates are non-empty iff dispatch was uncertain (PLAN.md §8)",
    apply: (model) => {
      const broken = structuredClone(model);
      const edge = firstEdge(broken);
      edge.candidates = [];
      return { model: broken, marker: edge.from };
    },
  },
  {
    name: "a dropped required trait",
    invariant: "required ⊆ traits ⊆ required ∪ optional (METAMODEL.md §5)",
    apply: (model) => {
      const broken = structuredClone(model);
      const profile = getProfile(model.lang);
      if (profile === undefined) throw new Error(`no profile for ${model.lang}`);
      // Stubs are exempt from the lower bound (METAMODEL.md §6), so dropping a
      // required trait from one would be no violation at all.
      const victim = broken.entities.find(
        (entity) => !isStubEntity(entity) && requiredOf(profile, entity.kind).length > 0,
      );
      if (victim === undefined) throw new Error("the generator must emit a non-stub entity");
      const dropped = requiredOf(profile, victim.kind)[0];
      victim.traits = victim.traits.filter((trait) => trait !== dropped);
      return { model: broken, marker: victim.id };
    },
  },
  {
    name: "a zeroed anchor span",
    invariant: "evidence everywhere: every edge carries a real anchor (CLAUDE.md 3)",
    apply: (model) => {
      const broken = structuredClone(model);
      const edge = firstEdge(broken);
      edge.anchor = { file: edge.anchor.file, span: [0, 0] };
      return { model: broken, marker: edge.from };
    },
  },
];

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe("the generator itself produces conformant corpora", () => {
  it("gives every shipped profile a kind that can be a corpus root", () => {
    for (const profile of shippedProfiles()) {
      expect(rootKinds(profile), `profile ${profile.lang} has no rootable kind`).not.toEqual([]);
    }
  });

  it("emits models the real loader finds clean", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const { diagnostics } = loadModels(model, { sources: ["generated.json"] });
        expect(diagnostics.profileIssues).toEqual([]);
        expect(diagnostics.danglingReferences).toEqual([]);
        expect(diagnostics.selfEdges).toEqual([]);
        expect(isClean(diagnostics)).toBe(true);
      }),
    );
  });

  it("emits entities their own profile validates", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const profile = getProfile(model.lang);
        if (profile === undefined) throw new Error(`no profile for ${model.lang}`);
        expect(validateModel(model, profile)).toEqual([]);
      }),
    );
  });
});

describe("a model generated to be valid is conformant", () => {
  it("yields an empty report", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        expect(findingsOf(checkConformance(unionOf([model])))).toEqual([]);
      }),
    );
  });

  it("stays empty when several generated models are analyzed as one union", () => {
    fc.assert(
      fc.property(modelArbitrary(), modelArbitrary(), (a, b) => {
        // Ids are globally unique thanks to the lang prefix, so two corpora in
        // different languages concatenate without renaming; two in the SAME
        // language would legitimately collide, and that is not what this
        // property is about.
        fc.pre(a.lang !== b.lang);
        expect(findingsOf(checkConformance(unionOf([a, b])))).toEqual([]);
      }),
    );
  });
});

/**
 * The discrimination half. Each mutation is applied ALONE to a model that was
 * conformant a line earlier, so a report that appears can be attributed to it
 * and to nothing else.
 */
describe("each invariant is detected independently", () => {
  it.each(CORRUPTIONS.map((corruption) => [corruption.name, corruption] as const))(
    "reports %s",
    (_name, corruption) => {
      fc.assert(
        fc.property(modelArbitrary(), (model) => {
          const clean = checkConformance(unionOf([model]));
          expect(findingsOf(clean), "the unmutated model must be clean").toEqual([]);

          const { model: broken, marker } = corruption.apply(model);
          const report = checkConformance(unionOf([broken]));

          expect(
            findingsOf(report).length,
            `unreported — ${corruption.invariant}`,
          ).toBeGreaterThan(0);
          expect(
            scan(report).codes.length,
            "every finding must carry a string `code`; consumers match on codes, not messages",
          ).toBeGreaterThan(0);
          expect(
            mentions(report, marker),
            `the report must name ${marker}, or it cannot be acted on`,
          ).toBe(true);
        }),
        { numRuns: 50 },
      );
    },
  );

  it("gives each invariant a finding code of its own", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const signatures = new Map<string, string>();
        for (const corruption of CORRUPTIONS) {
          const { model: broken } = corruption.apply(model);
          signatures.set(corruption.name, codeSignature(checkConformance(unionOf([broken]))));
        }
        // Five distinct mutations, five distinct code sets. A checker that
        // answers "something is wrong" to all of them tells a user nothing
        // about which invariant they broke.
        expect(new Set(signatures.values()).size, `${[...signatures].map(([k, v]) => `${k} -> ${v}`).join("; ")}`).toBe(
          CORRUPTIONS.length,
        );
      }),
      { numRuns: 25 },
    );
  });
});

describe("JSON round-trip", () => {
  it("survives JSON -> parseModel -> JSON unchanged", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const text = JSON.stringify(model);
        const reparsed = parseModel(JSON.parse(text));
        expect(reparsed).toEqual(model);
        // Serializing the parse result must reproduce the bytes: a parser that
        // dropped an unknown-but-licit key would still pass the deep compare
        // above if the key were absent from both sides.
        expect(JSON.stringify(reparsed)).toBe(text);
      }),
    );
  });

  it("leaves the conformance verdict unchanged by a round-trip", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const direct = checkConformance(unionOf([model]));
        const roundTripped = checkConformance(
          unionOf([parseModel(JSON.parse(JSON.stringify(model)))]),
        );
        expect(roundTripped).toEqual(direct);
      }),
    );
  });
});

describe("determinism", () => {
  it("returns an identical report for the same union, twice", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const union = unionOf([model]);
        expect(checkConformance(union)).toEqual(checkConformance(union));
      }),
    );
  });

  it("returns an identical report for a corrupted union, twice", () => {
    fc.assert(
      fc.property(
        modelArbitrary(),
        fc.nat({ max: CORRUPTIONS.length - 1 }),
        (model, which) => {
          const corruption = CORRUPTIONS[which % CORRUPTIONS.length];
          if (corruption === undefined) throw new Error("no corruption to apply");
          const union = unionOf([corruption.apply(model).model]);
          expect(checkConformance(union)).toEqual(checkConformance(union));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("does not mutate the union it was given", () => {
    fc.assert(
      fc.property(modelArbitrary(), (model) => {
        const union = unionOf([model]);
        const before = JSON.stringify(union.models);
        checkConformance(union);
        expect(JSON.stringify(union.models)).toBe(before);
      }),
    );
  });
});
