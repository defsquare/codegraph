import { z } from "zod";
import { NamedArgument } from "./literal.js";
import { EntityId, Provenance, SourceAnchor } from "./primitives.js";

/**
 * Attributes carried by every edge kind (METAMODEL.md §4).
 * `provenance` and `anchor` are required and never defaulted: an edge without
 * evidence, or whose fact/inference status is unknown, is not representable.
 * `candidates` is populated only when resolution was ambiguous; `sourceFile`
 * disambiguates which declaration site produced the edge (C# partial classes,
 * TS declaration merging).
 */
const edgeBase = {
  from: EntityId,
  to: EntityId,
  provenance: Provenance,
  anchor: SourceAnchor,
  candidates: z.array(EntityId).optional(),
  sourceFile: z.string().min(1).optional(),
};

/** Module → Module. The first-class cross-language comparison layer. */
export const ImportEdge = z.object({ edge: z.literal("import"), ...edgeBase });

/** Type → Type. Multiple inheritance is N edges (Python). */
export const InheritanceEdge = z.object({ edge: z.literal("inheritance"), ...edgeBase });

/** Type → interface/trait/protocol; `declared` (Java) or `derived` (Go, TS structural). */
export const InterfaceImplementationEdge = z.object({
  edge: z.literal("interfaceImplementation"),
  ...edgeBase,
});

/** Invocable → Invocable. Uncertain dispatch: `dynamic-candidate` + `candidates`. */
export const InvocationEdge = z.object({ edge: z.literal("invocation"), ...edgeBase });

/** Invocable → Structural. Both flags are required: a read-modify-write sets both. */
export const AccessEdge = z.object({
  edge: z.literal("access"),
  ...edgeBase,
  isRead: z.boolean(),
  isWrite: z.boolean(),
});

/** Entity → Type: type usage that is none of the other kinds (generics, casts, annotations). */
export const ReferenceEdge = z.object({ edge: z.literal("reference"), ...edgeBase });

/** Type → Type. Go `struct { Base }` — method promotion, neither inheritance nor attribute. */
export const EmbeddingEdge = z.object({ edge: z.literal("embedding"), ...edgeBase });

/** Type → PHP trait. Never flattened into the using class. */
export const TraitUsageEdge = z.object({ edge: z.literal("traitUsage"), ...edgeBase });

/** CodeFile → CodeFile. PHP `include`/`require`, the only file-to-file dependency. */
export const FileIncludeEdge = z.object({ edge: z.literal("fileInclude"), ...edgeBase });

/**
 * Entity → annotation Type: a written annotation, with its arguments
 * (METAMODEL.md §4, §1.6). A dedicated kind rather than a plain `reference`
 * for two reasons: it carries the VALUES, and it lets a consumer select
 * annotation usages without guessing from the target's kind — which a stub
 * target, the usual case for a framework annotation, cannot answer.
 *
 * `arguments` is required and may be empty: `@Override` writes no argument,
 * which is a fact about the source, not a gap in the extraction.
 */
export const AnnotationUseEdge = z.object({
  edge: z.literal("annotationUse"),
  ...edgeBase,
  arguments: z.array(NamedArgument),
});

/**
 * The single relationship concept, discriminated on `edge` (METAMODEL.md §4).
 * Only `access` and `annotationUse` contribute extra keys. Graph-level rules — closure and
 * `from !== to` — are properties checked by the analyzer, not by this parser.
 */
export const Edge = z.discriminatedUnion("edge", [
  ImportEdge,
  InheritanceEdge,
  InterfaceImplementationEdge,
  InvocationEdge,
  AccessEdge,
  ReferenceEdge,
  EmbeddingEdge,
  TraitUsageEdge,
  FileIncludeEdge,
  AnnotationUseEdge,
]);
export type Edge = z.infer<typeof Edge>;

/** Self-references are forbidden by the metamodel; the property suite uses this. */
export function isSelfReference(e: Edge): boolean {
  return e.from === e.to;
}
