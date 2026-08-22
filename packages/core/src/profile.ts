import { z } from "zod";
import { PROVENANCES, SPACES, Space } from "./primitives.js";
import { EDGE_KINDS, EdgeKind, TRAIT_NAMES, TraitName } from "./names.js";
import { TRAITS } from "./traits.js";
import { isStubEntity, type Entity } from "./entity.js";
import type { Model } from "./model.js";

/** The licit trait composition for one entity kind (METAMODEL.md §5). */
export interface KindSpec {
  readonly required: readonly TraitName[];
  readonly optional: readonly TraitName[];
}

/**
 * A language profile is DATA (METAMODEL.md §5): the contract stating what a
 * language's extractor may produce. It must be specifiable without being
 * implemented — no behaviour lives here, only licit kinds, trait compositions
 * and edge kinds.
 */
export interface Profile {
  readonly lang: string;
  readonly kinds: Readonly<Record<string, KindSpec>>;
  readonly edges: readonly EdgeKind[];
  /**
   * Declaration spaces per kind (METAMODEL.md §1.4), listing the spaces a kind
   * MAY occupy — the entity states which it actually does. Absent for every
   * language without a type/value split; only TypeScript declares it, and that
   * absence is what makes `Entity.space` on a non-TS entity an error.
   */
  readonly space?: Readonly<Record<string, readonly Space[]>> | undefined;
  /** Documented static-analysis blind spots (reflection, macros, dynamic require…). */
  readonly notes?: readonly string[] | undefined;
}

/** Zod mirror of {@link Profile}, for validating profile data loaded from JSON. */
export const ProfileSchema = z.object({
  lang: z.string().min(1),
  kinds: z.record(
    z.string(),
    z.object({
      required: z.array(TraitName),
      optional: z.array(TraitName),
    }),
  ),
  edges: z.array(EdgeKind),
  space: z.record(z.string(), z.array(Space)).optional(),
  notes: z.array(z.string()).optional(),
});

/** The closed set of validation codes. Consumers match on these, not on messages. */
export const VALIDATION_CODES = [
  "unknown-kind",
  "missing-required-trait",
  "trait-not-allowed",
  "trait-keys-invalid",
  "unknown-trait",
  "unknown-edge-kind",
  "edge-kind-not-allowed",
  "missing-provenance",
  "duplicate-entity-id",
  "profile-lang-mismatch",
  "required-optional-overlap",
  "space-not-allowed",
  "unknown-space-kind",
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export type ValidationIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

type ZodIssueLike = { readonly path: readonly PropertyKey[]; readonly message: string };

/** Flattens Zod issues into one line; the trait's own key paths stay visible. */
function formatIssues(issues: readonly ZodIssueLike[]): string {
  return issues
    .map((issue) => {
      const at = issue.path.map(String).join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}

/** A verdict without its subject: the same issues, whatever entity carries them. */
export type IssueTemplate = { readonly code: ValidationCode; readonly message: string };

export interface CompositionVerdict {
  /** An unknown kind makes the trait rules unenforceable — stop after it. */
  readonly terminal: boolean;
  readonly issues: readonly IssueTemplate[];
}

/**
 * MM-4: profile validity is a function of `(kind, trait set)` — nothing about
 * the entity carrying them enters into it, so each distinct composition is
 * decided once and the verdict shared. Fineract: a few dozen distinct pairs
 * across 240 910 entities. Reader-side only; trait sets are deliberately not a
 * wire concept (docs/model-encoding.md).
 *
 * `isStub` joins the key because it is the one entity-level fact the rule reads
 * (the lower bound is waived for stubs, METAMODEL.md §6). Keyed per profile in
 * a WeakMap so a throwaway profile in a test cannot leak.
 */
const COMPOSITION_VERDICTS = new WeakMap<Profile, Map<string, CompositionVerdict>>();

/**
 * Injective: traits come from the closed vocabulary (no NUL), the count is
 * prefixed, and `kind` — the one free-form component — comes last, so a NUL
 * inside it cannot fake a field boundary.
 */
function compositionCacheKey(kind: string, sortedTraits: readonly string[], isStub: boolean): string {
  const sep = "\u0000";
  return `${isStub ? "1" : "0"}${sep}${sortedTraits.length}${sep}${sortedTraits.join(sep)}${sep}${kind}`;
}

/**
 * The verdict for one `(kind, trait set, isStub)`, memoized per profile.
 *
 * Exported because the SQLite analysis store validates BY COMPOSITION rather
 * than by entity: it interns trait sets, so `SELECT DISTINCT kind_id,
 * trait_set_id, is_stub` is a few dozen rows over any corpus, and each verdict
 * is decided once here — by the same function `validateEntity` calls, so a
 * store-derived diagnosis cannot judge a composition differently than an
 * in-memory one.
 */
export function entityCompositionVerdict(
  profile: Profile,
  kind: string,
  traits: readonly string[],
  isStub: boolean,
): CompositionVerdict {
  const sorted = [...traits].sort();
  const cacheKey = compositionCacheKey(kind, sorted, isStub);
  let perProfile = COMPOSITION_VERDICTS.get(profile);
  if (perProfile === undefined) {
    perProfile = new Map<string, CompositionVerdict>();
    COMPOSITION_VERDICTS.set(profile, perProfile);
  }
  const cached = perProfile.get(cacheKey);
  if (cached !== undefined) return cached;

  const verdict = judgeComposition(profile, kind, sorted, isStub);
  perProfile.set(cacheKey, verdict);
  return verdict;
}

/** The `(kind, trait set)` rules themselves — called once per distinct pair. */
function judgeComposition(
  profile: Profile,
  kind: string,
  sortedTraits: readonly string[],
  isStub: boolean,
): CompositionVerdict {
  // Own-property lookup only: kind names like `constructor` and `toString`
  // (Java/C# do declare a `constructor` kind) would otherwise resolve to
  // Object.prototype members on any profile that does NOT declare them.
  const spec = Object.hasOwn(profile.kinds, kind) ? profile.kinds[kind] : undefined;

  if (spec === undefined) {
    return {
      terminal: true,
      issues: [
        {
          code: "unknown-kind",
          message: `kind "${kind}" is not declared by profile "${profile.lang}"`,
        },
      ],
    };
  }

  const issues: IssueTemplate[] = [];

  // THE LOCKED RULE (METAMODEL.md §5, PLAN.md §4.4):
  //   required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind).
  // Strict equality is rejected — too brittle for genuinely optional traits like
  // TComment/TSourceAnchor. An unrestricted subset is rejected too — it would
  // silently absorb extractor bugs (a trait no profile ever licensed).
  //
  // A stub is exempt from the lower bound only (METAMODEL.md §6): it stands for
  // a type OUTSIDE the corpus, so it is degraded by construction — no children,
  // no parent, no anchor, usually just TNamed + TType (PLAN.md §5.2). Demanding
  // the full composition of a declared type would make stubs unrepresentable.
  // The upper bound still applies: a stub may not carry unlicensed traits.
  const declared = new Set<string>(sortedTraits);
  if (!isStub) {
    for (const required of spec.required) {
      if (!declared.has(required)) {
        issues.push({
          code: "missing-required-trait",
          message: `kind "${kind}" requires trait ${required}`,
        });
      }
    }
  }

  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  for (const trait of sortedTraits) {
    if (!allowed.has(trait)) {
      issues.push({
        code: "trait-not-allowed",
        message: `trait ${trait} is not licensed for kind "${kind}" by profile "${profile.lang}"`,
      });
    }
  }

  return { terminal: false, issues };
}

/**
 * Validates one entity against its profile. Never throws: issues accumulate so
 * a whole model can be reported in a single pass.
 *
 * Two halves, per MM-4: the `(kind, trait set)` verdict is memoized, while the
 * checks that read the entity's own VALUES — declaration spaces and every
 * trait's contributed keys — necessarily run per entity.
 */
export function validateEntity(profile: Profile, entity: Entity): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const verdict = entityCompositionVerdict(profile, entity.kind, entity.traits, isStubEntity(entity));
  for (const issue of verdict.issues) {
    issues.push({ code: issue.code, path: entity.id, message: issue.message });
  }
  if (verdict.terminal) return issues;

  // The type/value split is TypeScript-family only (METAMODEL.md §1.4): a
  // profile that does not declare `space` licenses no space at all.
  if (entity.space !== undefined) {
    const licensed =
      profile.space !== undefined && Object.hasOwn(profile.space, entity.kind)
        ? new Set<string>(profile.space[entity.kind])
        : new Set<string>();
    for (const space of entity.space) {
      if (!licensed.has(space)) {
        issues.push({
          code: "space-not-allowed",
          path: entity.id,
          message: `space "${space}" is not licensed for kind "${entity.kind}" by profile "${profile.lang}"`,
        });
      }
    }
  }

  // Each declared trait must be able to parse the keys it contributes.
  for (const trait of entity.traits) {
    const schema = Object.hasOwn(TRAITS, trait) ? TRAITS[trait] : undefined;
    if (!schema) {
      issues.push({
        code: "unknown-trait",
        path: entity.id,
        message: `trait ${trait} is not part of the canonical vocabulary`,
      });
      continue;
    }
    const parsed = schema.safeParse(entity);
    if (!parsed.success) {
      issues.push({
        code: "trait-keys-invalid",
        path: entity.id,
        message: `trait ${trait}: ${formatIssues(parsed.error.issues)}`,
      });
    }
  }

  return issues;
}

/**
 * Two entities may legally share an id — one id can be declared in several
 * places (TypeScript declaration merging, C# partial classes, METAMODEL.md
 * §1.1). Only a disagreement on kind or trait set is a real conflict.
 */
function sameDeclaration(a: Entity, b: Entity): boolean {
  if (a.kind !== b.kind) return false;
  const left = [...new Set<string>(a.traits)].sort();
  const right = [...new Set<string>(b.traits)].sort();
  return left.length === right.length && left.every((trait, i) => trait === right[i]);
}

/**
 * Validates a whole model against the profile it claims to conform to.
 * Graph closure (every from/to/parent/child id resolves) is deliberately NOT
 * checked here: stubs are legitimate targets and closure is an analyzer-side
 * property (PLAN.md §4.5).
 */
export function validateModel(model: Model, profile: Profile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (model.lang !== profile.lang) {
    issues.push({
      code: "profile-lang-mismatch",
      path: "lang",
      message: `model declares lang "${model.lang}" but was validated against profile "${profile.lang}"`,
    });
  }

  const firstById = new Map<string, Entity>();
  const reported = new Set<string>();
  for (const entity of model.entities) {
    for (const issue of validateEntity(profile, entity)) issues.push(issue);

    const first = firstById.get(entity.id);
    if (first === undefined) {
      firstById.set(entity.id, entity);
    } else if (!reported.has(entity.id) && !sameDeclaration(first, entity)) {
      reported.add(entity.id);
      issues.push({
        code: "duplicate-entity-id",
        path: entity.id,
        message: `id redeclared with a different kind or trait set ("${first.kind}" vs "${entity.kind}")`,
      });
    }
  }

  const licensed = new Set<string>(profile.edges);
  const provenances: readonly string[] = PROVENANCES;
  model.edges.forEach((edge, index) => {
    const path = `edges[${index}]`;

    // The Zod schema already guarantees provenance; assert it for hand-built objects.
    const provenance: unknown = edge.provenance;
    if (typeof provenance !== "string" || !provenances.includes(provenance)) {
      issues.push({
        code: "missing-provenance",
        path,
        message: `edge ${edge.from} -> ${edge.to} has no valid provenance`,
      });
    }

    if (!licensed.has(edge.edge)) {
      issues.push({
        code: "edge-kind-not-allowed",
        path,
        message: `edge kind "${edge.edge}" is not emitted by profile "${profile.lang}"`,
      });
    }
  });

  return issues;
}

/** Checks a profile against the canonical vocabularies before it is ever used. */
export function validateProfile(profile: Profile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTraits = new Set<string>(TRAIT_NAMES);
  const knownEdges = new Set<string>(EDGE_KINDS);

  for (const [kind, spec] of Object.entries(profile.kinds)) {
    for (const trait of spec.required) {
      if (!knownTraits.has(trait)) {
        issues.push({
          code: "unknown-trait",
          path: `kinds.${kind}.required`,
          message: `${trait} is not part of the canonical trait vocabulary`,
        });
      }
    }
    for (const trait of spec.optional) {
      if (!knownTraits.has(trait)) {
        issues.push({
          code: "unknown-trait",
          path: `kinds.${kind}.optional`,
          message: `${trait} is not part of the canonical trait vocabulary`,
        });
      }
    }

    // A trait cannot be both required and optional: the subset rule would read
    // it two ways at once.
    const required = new Set<string>(spec.required);
    for (const trait of spec.optional) {
      if (required.has(trait)) {
        issues.push({
          code: "required-optional-overlap",
          path: `kinds.${kind}`,
          message: `${trait} is declared both required and optional`,
        });
      }
    }
  }

  // A space entry for a kind the profile never declares licenses nothing.
  if (profile.space !== undefined) {
    const knownSpaces = new Set<string>(SPACES);
    for (const [kind, spaces] of Object.entries(profile.space)) {
      if (!Object.hasOwn(profile.kinds, kind)) {
        issues.push({
          code: "unknown-space-kind",
          path: `space.${kind}`,
          message: `space is declared for kind "${kind}", which the profile does not define`,
        });
      }
      for (const space of spaces) {
        if (!knownSpaces.has(space)) {
          issues.push({
            code: "unknown-space-kind",
            path: `space.${kind}`,
            message: `${space} is not a declaration space`,
          });
        }
      }
    }
  }

  for (const edge of profile.edges) {
    if (!knownEdges.has(edge)) {
      issues.push({
        code: "unknown-edge-kind",
        path: "edges",
        message: `${edge} is not part of the canonical edge vocabulary`,
      });
    }
  }

  return issues;
}
