import { z } from "zod";
import { EdgeKind, TraitName } from "./names.js";
import { Provenance, Space } from "./primitives.js";
import { ExtractorInfo, Repository } from "./model.js";

/**
 * The JSONL interchange records (docs/model-encoding.md §2). One JSON object
 * per line, discriminated on `t`; the section order
 * `header → files → entities → edges → eof` is contractual and enforced by the
 * reader, not by these schemas — JSON Schema cannot describe a container.
 *
 * Three ideas do all the work:
 *
 * 1. **Surrogates.** Every intra-model reference is a dense `0..n-1` integer
 *    index into the entity section, assigned in canonical natural-key order.
 *    Surrogates are file-scoped and NEVER identity (MM-1): they are not stable
 *    across runs and never cross a file boundary.
 * 2. **Header dictionaries.** The closed vocabularies (MM-3) ride once in the
 *    header; records reference them by index. Indices are model-declared, so
 *    extending core's vocabulary never renumbers an existing file.
 * 3. **A file table.** The one unbounded string set — paths — is interned as
 *    one record per line, so no line grows with corpus size.
 */

/** A reference to an entity: its surrogate index. */
export const Ref = z.int().min(0);

/** A reference into the header dictionary that the field's name selects. */
export const DictRef = z.int().min(0);

/** A reference into the file table. */
export const FileRef = z.int().min(0);

/**
 * `[fileRef, startLine, endLine]` — SourceAnchor with its path interned.
 * The tuple form is deliberate: on fineract, anchors outnumber entities 4:1 and
 * `{"file":…,"span":[…]}` spends 20 bytes per anchor on key names alone.
 */
export const WireAnchor = z.tuple([FileRef, z.int().min(1), z.int().min(1)]);
export type WireAnchor = z.infer<typeof WireAnchor>;

/**
 * The wire form of each trait's contributed keys — the mirror of `TRAITS`, with
 * every EntityId replaced by a surrogate and every path by a file reference.
 * `wire.test.ts` pins the correspondence key-for-key, so the two tables cannot
 * drift apart.
 */
export const WIRE_TRAITS = {
  TNamed: z.object({ name: z.string().min(1) }),
  TSourceAnchor: z.object({ anchor: WireAnchor }),
  TComment: z.object({ comments: z.array(z.string()) }),

  // MM-2: no `children` key. The trait remains a declaration that this entity
  // is a container; the inverse of `parent` is derived by the analyzer.
  TWithChildren: z.object({}),
  TChildOf: z.object({ parent: Ref }),
  TAttachedTo: z.object({ attachedTo: Ref }),

  TModule: z.object({ definedIn: z.array(FileRef), isStub: z.boolean() }),

  TType: z.object({ isStub: z.boolean() }),
  TWithInheritances: z.object({}),
  TWithImplements: z.object({}),
  TTypedEntity: z.object({ declaredType: Ref.optional() }),

  TInvocable: z.object({ signature: z.string() }),
  TWithParameters: z.object({ parameters: z.array(Ref) }),
  TWithLocalVariables: z.object({ localVariables: z.array(Ref) }),
  TWithInvocations: z.object({}),

  TStructural: z.object({}),
  TWithAccesses: z.object({}),
} satisfies Record<TraitName, z.ZodObject>;

/** The vocabularies a model declares, by the indices its records use (MM-3). */
export const WireDict = z.object({
  kinds: z.array(z.string().min(1)),
  traits: z.array(TraitName),
  edges: z.array(EdgeKind),
  provenance: z.array(Provenance),
});
export type WireDict = z.infer<typeof WireDict>;

/** First line of the file: everything a reader needs before record one. */
export const HeaderRec = z.object({
  t: z.literal("header"),
  schemaVersion: z.string().min(1),
  lang: z.string().min(1),
  extractor: ExtractorInfo,
  root: z.string(),
  /** Optional (METAMODEL §8a): a model that does not know its repository says nothing. */
  repository: Repository.optional(),
  dict: WireDict,
});
export type HeaderRec = z.infer<typeof HeaderRec>;

/** One interned path. `i` is its own index — dense, ascending, gap-free. */
export const FileRec = z.object({
  t: z.literal("f"),
  i: FileRef,
  path: z.string().min(1),
});
export type FileRec = z.infer<typeof FileRec>;

/**
 * One entity. `i` is its surrogate and equals its position in the section;
 * `m`/`s`/`d` are the natural key (MM-1) with `lang` taken from the header, so
 * no rendered id string appears in the file at all.
 *
 * Loose, like v1's `Entity`: an extractor-specific key must survive a
 * round-trip rather than be silently stripped. Every key a trait can contribute
 * IS typed here, so only presence — which the header's dict decides — is left
 * to the reader.
 */
export const EntityRec = z.looseObject({
  t: z.literal("e"),
  i: Ref,
  k: DictRef,
  tr: z.array(DictRef),
  /** Surrogate of the owning module. A module names ITSELF here (MM-1). */
  m: Ref,
  s: z.string(),
  d: z.string().min(1).optional(),

  name: z.string().min(1).optional(),
  anchor: WireAnchor.optional(),
  comments: z.array(z.string()).optional(),
  parent: Ref.optional(),
  attachedTo: Ref.optional(),
  definedIn: z.array(FileRef).optional(),
  isStub: z.boolean().optional(),
  declaredType: Ref.optional(),
  signature: z.string().optional(),
  parameters: z.array(Ref).optional(),
  localVariables: z.array(Ref).optional(),
  space: z.array(Space).optional(),
});
export type EntityRec = z.infer<typeof EntityRec>;

/**
 * One edge: kind, from, to, provenance, anchor. Outgoing direction only
 * (CLAUDE.md invariant 4) — there is no inverse record type and never will be.
 */
export const EdgeRec = z.looseObject({
  t: z.literal("x"),
  k: DictRef,
  f: Ref,
  o: Ref,
  p: DictRef,
  anchor: WireAnchor,
  candidates: z.array(Ref).optional(),
  isRead: z.boolean().optional(),
  isWrite: z.boolean().optional(),
  sourceFile: FileRef.optional(),
});
export type EdgeRec = z.infer<typeof EdgeRec>;

/**
 * The trailer. Counts make a truncated run DETECTABLE — v1 could not tell a
 * complete document from a killed one — and a trailer rather than a header
 * field is what lets a streaming writer never rewind.
 */
export const EofRec = z.object({
  t: z.literal("eof"),
  counts: z.object({
    files: z.int().min(0),
    entities: z.int().min(0),
    edges: z.int().min(0),
  }),
});
export type EofRec = z.infer<typeof EofRec>;

export const ModelRecord = z.discriminatedUnion("t", [
  HeaderRec,
  FileRec,
  EntityRec,
  EdgeRec,
  EofRec,
]);
export type ModelRecord = z.infer<typeof ModelRecord>;

/** The record schemas by their `t` tag — what `gen:schemas` publishes. */
export const RECORD_SCHEMAS = {
  header: HeaderRec,
  f: FileRec,
  e: EntityRec,
  x: EdgeRec,
  eof: EofRec,
} as const;

export type RecordTag = keyof typeof RECORD_SCHEMAS;

/** Section order (docs/model-encoding.md §2) — contractual, single-pass. */
export const SECTION_ORDER = ["header", "f", "e", "x", "eof"] as const satisfies readonly RecordTag[];
