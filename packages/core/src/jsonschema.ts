import { z } from "zod";
import { TRAIT_NAMES, type TraitName } from "./names.js";
import { MARKER_TRAITS, TRAITS } from "./traits.js";
import { Model, SCHEMA_VERSION } from "./model.js";

export type JsonSchema = { [key: string]: unknown };

/**
 * One JSON Schema conditional per key-contributing trait:
 * "if `traits` contains T, then T's keys are required and well-typed".
 *
 * Zod refinements do not survive `z.toJSONSchema`, so the rule the `Entity`
 * schema enforces in TypeScript is re-stated here in the published contract.
 * Both are generated from the same `TRAITS` table, so they cannot drift: a new
 * trait, or a changed key type, changes both at once.
 *
 * Marker traits are skipped by construction — they contribute no keys, so a
 * conditional for them would be vacuous (METAMODEL.md §3).
 */
export function traitConditionals(): JsonSchema[] {
  const conditionals: JsonSchema[] = [];

  for (const trait of TRAIT_NAMES satisfies readonly TraitName[]) {
    if (MARKER_TRAITS.has(trait)) continue;

    // Only `properties` and `required` are lifted: the trait schema's own
    // `additionalProperties: false` describes the trait in isolation, and
    // applying it to the entity would forbid every OTHER trait's keys.
    const traitSchema = z.toJSONSchema(TRAITS[trait], { target: "draft-2020-12" }) as {
      properties?: JsonSchema;
      required?: string[];
    };

    const then: JsonSchema = { properties: traitSchema.properties ?? {} };
    if (traitSchema.required !== undefined && traitSchema.required.length > 0) {
      then["required"] = traitSchema.required;
    }

    conditionals.push({
      // `required: ["traits"]` keeps the `if` from passing vacuously on an
      // entity that omits `traits` altogether.
      if: { required: ["traits"], properties: { traits: { contains: { const: trait } } } },
      then,
    });
  }

  return conditionals;
}

/**
 * The published cross-language contract: everything the metamodel requires of a
 * `model.json`, expressed so a Java, Go or .NET extractor can self-validate
 * with no access to this TypeScript source.
 */
export function modelJsonSchema(): JsonSchema {
  const generated = z.toJSONSchema(Model, { target: "draft-2020-12" }) as unknown as JsonSchema & {
    properties: { entities: { items: JsonSchema } };
  };

  generated.properties.entities.items = {
    ...generated.properties.entities.items,
    allOf: traitConditionals(),
  };

  return {
    ...generated,
    $id: `https://codegraph.dev/schemas/model-${SCHEMA_VERSION}.schema.json`,
    title: `Codegraph model.json (interchange contract ${SCHEMA_VERSION})`,
    description:
      "One extraction run: entities (nodes composed of traits) and edges (outgoing only, " +
      "each carrying provenance and an anchor). Generated from @codegraph/core — edit the " +
      "Zod schemas and re-run `pnpm run gen:schemas`, never this file.",
  };
}
