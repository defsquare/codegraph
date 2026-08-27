import { z } from "zod";

/**
 * The closed, canonical trait vocabulary (METAMODEL.md §3). Never renamed,
 * never aliased per language — a profile selects from this list, it cannot
 * extend it.
 */
export const TRAIT_NAMES = [
  // base
  "TNamed",
  "TSourceAnchor",
  "TComment",
  // containment and attachment
  "TWithChildren",
  "TChildOf",
  "TAttachedTo",
  // modularity
  "TModule",
  // types
  "TType",
  "TWithInheritances",
  "TWithImplements",
  "TTypedEntity",
  // behavior
  "TInvocable",
  "TWithParameters",
  "TWithLocalVariables",
  "TWithInvocations",
  // structure
  "TStructural",
  "TWithAccesses",
  // measures (METAMODEL.md §3.8)
  "TMetrics",
  // values (METAMODEL.md §3.6, §1.6)
  "TWithValue",
] as const;

export const TraitName = z.enum(TRAIT_NAMES);
export type TraitName = (typeof TRAIT_NAMES)[number];

/** The closed edge-kind vocabulary (METAMODEL.md §4). */
export const EDGE_KINDS = [
  "import",
  "inheritance",
  "interfaceImplementation",
  "invocation",
  "access",
  "reference",
  "embedding",
  "traitUsage",
  "fileInclude",
  // A written annotation, with its arguments (METAMODEL.md §4, §1.6).
  "annotationUse",
] as const;

export const EdgeKind = z.enum(EDGE_KINDS);
export type EdgeKind = (typeof EDGE_KINDS)[number];
