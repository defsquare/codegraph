import { z } from "zod";
import { TraitName } from "./names.js";
import { EntityId, Space } from "./primitives.js";

/**
 * The single node concept (METAMODEL.md §2): an id, a profile-defined kind, and
 * a sum of traits — never a class hierarchy. Loose is mandatory: every declared
 * trait contributes its own keys and they must survive parsing; those keys are
 * validated per trait by `traitSchemaFor` / the owning language profile.
 */
export const Entity = z.looseObject({
  id: EntityId,
  kind: z.string().min(1),
  traits: z.array(TraitName),
  space: z.array(Space).optional(),
});
export type Entity = z.infer<typeof Entity>;

/** Only `TType` contributes `isStub`; an entity not declaring it is never a stub. */
export function isStubEntity(e: Entity): boolean {
  return e.traits.includes("TType") && (e as Record<string, unknown>)["isStub"] === true;
}
