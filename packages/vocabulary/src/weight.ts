import type { Entity, EntityId } from "@codegraph/core";

/**
 * Roles and weights (PLAN.md §20.1). A word counts by the role of the entity
 * whose name carries it, and the role comes from the entity's traits, never
 * its kind. Weights are data: the artifact records the ones it was built
 * under, since a count without its scheme is not a fact.
 */

/** From the outermost container in; `other` is a named entity no role trait describes. */
export const ROLES = ["module", "type", "operation", "attribute", "parameter", "local", "other"] as const;
export type Role = (typeof ROLES)[number];
/** Every role, then the words of a name's qualifier, whatever its role (`AcmeOrder::` of `AcmeOrder::Order`). */
export const WEIGHT_KEYS = [...ROLES, "qualifier"] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];
export type Weights = Readonly<Record<WeightKey, number>>;

export const DEFAULT_WEIGHTS: Weights = Object.freeze({
  module: 8, // a concept the corpus names once and refers to everywhere
  type: 8,
  operation: 3, // what it does; the prefix is usually technical (get, find, build)
  attribute: 4, // what a type holds: nouns, usually domain
  parameter: 1, // incidental names
  local: 1,
  other: 1, // a TS namespace, a PHP code file: no trait says what it is
  qualifier: 1, // a container's words, spoken again by every name it qualifies
});

/** The structural entities some entity lists as its parameters or its locals. */
export interface Slots {
  readonly parameters: ReadonlySet<EntityId>;
  readonly locals: ReadonlySet<EntityId>;
}

export function structuralSlots(entities: Iterable<Entity>): Slots {
  const parameters = new Set<EntityId>();
  const locals = new Set<EntityId>();
  for (const entity of entities) {
    for (const id of idList(entity, "parameters")) parameters.add(id);
    for (const id of idList(entity, "localVariables")) locals.add(id);
  }
  return { parameters, locals };
}

/** First match wins: a C# delegate (TType + TInvocable) is a type. */
export function roleOf(entity: Entity, slots: Slots): Role {
  const { traits } = entity;
  if (traits.includes("TModule")) return "module";
  if (traits.includes("TType")) return "type";
  if (traits.includes("TInvocable")) return "operation";
  if (traits.includes("TStructural")) {
    if (slots.parameters.has(entity.id)) return "parameter";
    if (slots.locals.has(entity.id)) return "local";
    return "attribute";
  }
  return "other";
}

function idList(entity: Entity, key: "parameters" | "localVariables"): readonly EntityId[] {
  const value = (entity as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((id): id is EntityId => typeof id === "string") : [];
}
