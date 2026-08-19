import { z } from "zod";
import { PROVENANCES } from "./primitives.js";
import { EDGE_KINDS, EdgeKind, TRAIT_NAMES, TraitName } from "./names.js";
import { TRAITS } from "./traits.js";
import type { Entity } from "./entity.js";
import type { Model } from "./model.js";

/**
 * A language profile is DATA (METAMODEL.md §5): the contract stating what a
 * language's extractor may produce. It must be specifiable without being
 * implemented — no behaviour lives here, only licit kinds, trait compositions
 * and edge kinds.
 */
export interface Profile {
  readonly lang: string;
  readonly kinds: Readonly<
    Record<string, { readonly required: readonly TraitName[]; readonly optional: readonly TraitName[] }>
  >;
  readonly edges: readonly EdgeKind[];
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

/**
 * Validates one entity against its profile. Never throws: issues accumulate so
 * a whole model can be reported in a single pass.
 */
export function validateEntity(profile: Profile, entity: Entity): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const spec = profile.kinds[entity.kind];

  if (spec === undefined) {
    // Without a kind spec the trait rules below are unenforceable, so stop here.
    issues.push({
      code: "unknown-kind",
      path: entity.id,
      message: `kind "${entity.kind}" is not declared by profile "${profile.lang}"`,
    });
    return issues;
  }

  // THE LOCKED RULE (METAMODEL.md §5, PLAN.md §4.4):
  //   required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind).
  // Strict equality is rejected — too brittle for genuinely optional traits like
  // TComment/TSourceAnchor. An unrestricted subset is rejected too — it would
  // silently absorb extractor bugs (a trait no profile ever licensed).
  const declared = new Set<string>(entity.traits);
  for (const required of spec.required) {
    if (!declared.has(required)) {
      issues.push({
        code: "missing-required-trait",
        path: entity.id,
        message: `kind "${entity.kind}" requires trait ${required}`,
      });
    }
  }

  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  for (const trait of entity.traits) {
    if (!allowed.has(trait)) {
      issues.push({
        code: "trait-not-allowed",
        path: entity.id,
        message: `trait ${trait} is not licensed for kind "${entity.kind}" by profile "${profile.lang}"`,
      });
    }
  }

  // Each declared trait must be able to parse the keys it contributes.
  for (const trait of entity.traits) {
    const schema = TRAITS[trait];
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
