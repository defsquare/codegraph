import { z } from "zod";
import { Edge } from "./edges.js";
import { Entity } from "./entity.js";

/** Version of the interchange contract carried by every model.json. */
export const SCHEMA_VERSION = "1.0.0";

/**
 * Provenance of the model itself. Loose on purpose: extractor-specific flags
 * (`noClasspath`, tool revisions…) must survive a parse round-trip untouched.
 */
export const ExtractorInfo = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type ExtractorInfo = z.infer<typeof ExtractorInfo>;

/**
 * The interchange file (METAMODEL.md §8): one JSON document per extraction run.
 * Graph closure (every `from`/`to`/`parent`/`children` id resolving) is NOT
 * checked here — stubs are legitimate targets and closure is an analyzer-side
 * property over the union of models.
 */
export const Model = z.object({
  schemaVersion: z.string().min(1),
  lang: z.string().min(1),
  extractor: ExtractorInfo,
  root: z.string(),
  entities: z.array(Entity),
  edges: z.array(Edge),
});
export type Model = z.infer<typeof Model>;

/** Parse a model.json payload, throwing a human-readable aggregate on failure. */
export function parseModel(input: unknown): Model {
  const result = Model.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid model.json:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
