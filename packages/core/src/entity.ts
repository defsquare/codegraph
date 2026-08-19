import { z } from "zod";
import { TraitName } from "./names.js";
import { EntityId, Space } from "./primitives.js";
import { TRAITS } from "./traits.js";

/**
 * The single node concept (METAMODEL.md §2): an id, a profile-defined kind, and
 * a sum of traits — never a class hierarchy. Loose is mandatory: every declared
 * trait contributes its own keys and they must survive parsing.
 *
 * The trait-key rule of METAMODEL.md §2 ("every declared trait's keys are
 * present and well-typed") is enforced HERE rather than only in the
 * profile-aware `validateEntity`, because it is profile-INDEPENDENT: `TNamed`
 * contributes `name` in every language. Keeping it here is what lets
 * `schemas/model.schema.json` state the same rule (see `jsonschema.ts`) and so
 * lets a non-TypeScript extractor self-validate against the published contract
 * alone. What stays profile-aware in `validateEntity`: which kinds exist and
 * which trait compositions they license.
 */
export const Entity = z
  .looseObject({
    id: EntityId,
    kind: z.string().min(1),
    traits: z.array(TraitName),
    space: z.array(Space).optional(),
  })
  .check((ctx) => {
    for (const trait of ctx.value.traits) {
      const result = TRAITS[trait].safeParse(ctx.value);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        ctx.issues.push({
          code: "custom",
          message: `trait ${trait}: ${issue.message}`,
          input: ctx.value,
          path: issue.path,
        });
      }
    }
  });
export type Entity = z.infer<typeof Entity>;

/** Only `TType` contributes `isStub`; an entity not declaring it is never a stub. */
export function isStubEntity(e: Entity): boolean {
  return e.traits.includes("TType") && (e as Record<string, unknown>)["isStub"] === true;
}
