import { z } from "zod";

/**
 * Opaque entity identity, written `<lang>:<module>/<symbol>[#<disambiguator>]`.
 * That shape is documentation for extractor authors, not a contract: consumers
 * compare ids for equality and never parse them.
 */
export const EntityId = z.string().min(1);
export type EntityId = z.infer<typeof EntityId>;

/**
 * Evidence: where in the source a fact was observed. `file` is relative to the
 * model's `root`; `span` is `[startLine, endLine]`, 1-based and inclusive.
 * Anchors on edges are what make every dependency claim auditable.
 */
export const SourceAnchor = z.object({
  file: z.string().min(1),
  span: z.tuple([z.int().min(1), z.int().min(1)]),
});
export type SourceAnchor = z.infer<typeof SourceAnchor>;

/** How we know a fact exists. Facts and inferences are never mixed. */
export const PROVENANCES = ["declared", "derived", "dynamic-candidate", "generated"] as const;
export const Provenance = z.enum(PROVENANCES);
export type Provenance = (typeof PROVENANCES)[number];

/**
 * TypeScript-family declaration space. A `type`-space entity is erased at
 * runtime; a TS class occupies both. Only meaningful in profiles declaring it.
 */
export const SPACES = ["type", "value"] as const;
export const Space = z.enum(SPACES);
export type Space = (typeof SPACES)[number];
