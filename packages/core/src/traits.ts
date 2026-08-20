import { z } from "zod";
import type { TraitName } from "./names.js";
import { EntityId, SourceAnchor } from "./primitives.js";

/**
 * One partial schema per trait: exactly the keys that trait contributes to the
 * entity declaring it (METAMODEL.md §3). Traits compose commutatively — there
 * is no entity hierarchy — so every schema here validates keys, never a shape.
 */
export const TRAITS = {
  // base
  TNamed: z.object({ name: z.string().min(1) }),
  TSourceAnchor: z.object({ anchor: SourceAnchor }),
  TComment: z.object({ comments: z.array(z.string()) }),

  // containment (where it is written) — distinct from attachment (what it belongs to).
  // TWithChildren contributes NO key (MM-2): `children` is the exact inverse of
  // `parent`, and inverse indexes are derived in memory, never serialized
  // (CLAUDE.md invariant 4). The trait stays — it says "this is a container",
  // which METAMODEL §3.2's containment-vs-attachment split needs.
  TWithChildren: z.object({}),
  TChildOf: z.object({ parent: EntityId }),
  TAttachedTo: z.object({ attachedTo: EntityId }),

  // modularity
  // `isStub` mirrors TType's: the import graph is module-level (METAMODEL.md §9),
  // so an import of an external package needs a module node to point at or the
  // first-class import layer cannot close. A module the corpus never declares is
  // degraded exactly as an external type is — `definedIn: []` and `isStub: true`.
  TModule: z.object({ definedIn: z.array(z.string()), isStub: z.boolean() }),

  // types
  TType: z.object({ isStub: z.boolean() }),
  TWithInheritances: z.object({}),
  TWithImplements: z.object({}),
  // Optional even when the trait is declared: inferred types, `var`, dynamic languages.
  TTypedEntity: z.object({ declaredType: EntityId.optional() }),

  // behavior
  TInvocable: z.object({ signature: z.string() }),
  TWithParameters: z.object({ parameters: z.array(EntityId) }),
  TWithLocalVariables: z.object({ localVariables: z.array(EntityId) }),
  TWithInvocations: z.object({}),

  // structure
  TStructural: z.object({}),
  TWithAccesses: z.object({}),
} satisfies Record<TraitName, z.ZodObject>;

/**
 * Traits contributing no keys: the capability they declare is carried by
 * `edges[]` (stored outgoing-only) or is a pure classification (`TStructural`).
 */
const MARKER_TRAIT_NAMES = [
  "TWithChildren",
  "TWithInheritances",
  "TWithImplements",
  "TWithInvocations",
  "TStructural",
  "TWithAccesses",
] as const satisfies readonly TraitName[];

export const MARKER_TRAITS: ReadonlySet<TraitName> = new Set<TraitName>(MARKER_TRAIT_NAMES);

/**
 * Merge the listed traits' partial schemas into one schema for an entity's
 * trait-contributed keys. Loose on purpose: `id`/`kind`/`traits` and keys of
 * traits outside `traits` must survive parsing rather than be stripped.
 */
export function traitSchemaFor(traits: readonly TraitName[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const trait of traits) {
    Object.assign(shape, TRAITS[trait].shape);
  }
  return z.looseObject(shape);
}
