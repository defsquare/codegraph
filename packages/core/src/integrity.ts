import type { TraitName } from "./names.js";
import type { Entity } from "./entity.js";
import type { Edge } from "./edges.js";
import { argumentReferences, literalReferences, type Literal } from "./literal.js";
import type { Model } from "./model.js";

/**
 * Graph-level integrity (CLAUDE.md invariants 4 and 10). These are helpers, not
 * a stage of the pipeline: they are profile-independent and structural, so they
 * live in core, and the analyzer (M3) calls them over the union of models
 * rather than reimplementing them.
 *
 * Deliberately NOT part of `parseModel`/`validateModel`: closure only holds
 * over a whole corpus, and a single model.json may legitimately reference ids
 * declared by another model in the union.
 */

/**
 * The trait keys whose values are EntityIds — the outgoing references an entity
 * can make (METAMODEL.md §3). Pinned by a test against the §3 tables so a new
 * referencing trait cannot be added without teaching closure about it.
 *
 * Note what is absent: there is no `callers`, `subtypes`, `importers` — nor
 * `children`, the inverse of `parent` (MM-2). All inverse views are derived in
 * memory by the analyzer and never serialized (CLAUDE.md invariant 4), so
 * closure never has to walk one.
 */
export const ENTITY_REFERENCE_KEYS = {
  TChildOf: { key: "parent", many: false },
  TAttachedTo: { key: "attachedTo", many: false },
  TTypedEntity: { key: "declaredType", many: false },
  TWithParameters: { key: "parameters", many: true },
  TWithLocalVariables: { key: "localVariables", many: true },
} as const satisfies Partial<Record<TraitName, { key: string; many: boolean }>>;

/** One dangling reference: where it was written and which id failed to resolve. */
export interface UnknownReference {
  readonly path: string;
  readonly id: string;
}

/**
 * `TWithValue` is deliberately NOT in the table above: its references are a
 * TREE (an array of annotations, each with arguments, each possibly a class
 * literal — §1.6), not a key holding an id. Closure still reaches every one of
 * them, through `literalReferences`, which is why this is stated here rather
 * than left to a reader to notice.
 */
function valueReferences(entity: Entity, index: number): UnknownReference[] {
  if (!entity.traits.includes("TWithValue")) return [];
  const value = (entity as unknown as Record<string, unknown>)["value"];
  if (value === undefined) return [];
  return literalReferences(value as Literal, `entities[${index}].value`);
}

function entityReferences(entity: Entity, index: number): UnknownReference[] {
  const out: UnknownReference[] = [];
  const bag = entity as unknown as Record<string, unknown>;
  const declared = new Set<string>(entity.traits);

  for (const [trait, spec] of Object.entries(ENTITY_REFERENCE_KEYS)) {
    if (!declared.has(trait)) continue;
    const value = bag[spec.key];
    if (spec.many) {
      if (!Array.isArray(value)) continue;
      value.forEach((id, i) => {
        if (typeof id === "string") out.push({ path: `entities[${index}].${spec.key}[${i}]`, id });
      });
    } else if (typeof value === "string") {
      out.push({ path: `entities[${index}].${spec.key}`, id: value });
    }
  }

  return out;
}

function edgeReferences(edge: Edge, index: number): UnknownReference[] {
  const out: UnknownReference[] = [
    { path: `edges[${index}].from`, id: edge.from },
    { path: `edges[${index}].to`, id: edge.to },
  ];
  edge.candidates?.forEach((id, i) => out.push({ path: `edges[${index}].candidates[${i}]`, id }));
  // An annotation use's arguments carry ids too (§1.6): a class literal, an
  // enum constant's type, a nested annotation's type.
  if (edge.edge === "annotationUse") {
    out.push(...argumentReferences(edge.arguments, `edges[${index}].arguments`));
  }
  return out;
}

/**
 * Every id a model points at: edge endpoints and candidates, plus the
 * containment, attachment and type references entities declare.
 */
export function references(model: Model): UnknownReference[] {
  const out: UnknownReference[] = [];
  model.entities.forEach((entity, i) => {
    out.push(...entityReferences(entity, i));
    out.push(...valueReferences(entity, i));
  });
  model.edges.forEach((edge, i) => out.push(...edgeReferences(edge, i)));
  return out;
}

/**
 * Graph closure (CLAUDE.md invariant 10): every reference must resolve to a
 * declared entity. Stubs count as known — they ARE declared entities, merely
 * degraded ones (METAMODEL.md §6). `known` supplies ids declared by sibling
 * models when checking one model of a multi-language union.
 */
export function unknownReferences(
  model: Model,
  known: Iterable<string> = [],
): UnknownReference[] {
  const declared = new Set<string>(known);
  for (const entity of model.entities) declared.add(entity.id);
  return references(model).filter((ref) => !declared.has(ref.id));
}

/** Edges whose `from` equals its `to` — forbidden by METAMODEL.md §4. */
export function selfReferences(model: Model): { readonly path: string; readonly edge: Edge }[] {
  const out: { path: string; edge: Edge }[] = [];
  model.edges.forEach((edge, index) => {
    if (edge.from === edge.to) out.push({ path: `edges[${index}]`, edge });
  });
  return out;
}
