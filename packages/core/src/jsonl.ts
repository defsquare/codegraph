import { z } from "zod";
import type { Edge } from "./edges.js";
import type { Entity } from "./entity.js";
import { ENTITY_REFERENCE_KEYS } from "./integrity.js";
import { type NaturalKey, compareNaturalKeys, naturalKeyIndex, parseRenderedId, renderId } from "./identity.js";
import type { EdgeKind, TraitName } from "./names.js";
import type { Model } from "./model.js";
import type { Provenance, SourceAnchor } from "./primitives.js";
import {
  EdgeRec,
  EntityRec,
  EofRec,
  FileRec,
  HeaderRec,
  WIRE_TRAITS,
  type ModelRecord,
  type WireAnchor,
} from "./wire.js";

/**
 * The JSONL codec (docs/model-encoding.md §2) — pure: strings in, model out,
 * no I/O. `jsonl-file.ts` adds the two lines of Node needed to reach a disk.
 *
 * The decoder never holds the whole file as one string, which is the point:
 * v1's 559.5MB fineract `model.json` was over Node's ~512MB string ceiling and
 * could not be read at all, at any speed.
 */

/** Keys whose values are file paths rather than entity references. */
const PATH_KEYS = { definedIn: "many" } as const;

/** The key order every entity record is written in — determinism is a property. */
const ENTITY_KEY_ORDER = [
  "name",
  "signature",
  "declaredType",
  "isStub",
  "parent",
  "attachedTo",
  "parameters",
  "localVariables",
  "definedIn",
  "comments",
  "space",
  "anchor",
] as const;

const EDGE_KEY_ORDER = ["candidates", "isRead", "isWrite", "sourceFile", "anchor"] as const;

/** The record's own fields — everything else on a line is an extension key. */
const ENTITY_RECORD_KEYS: readonly string[] = ["t", "i", "k", "tr", "m", "s", "d"];
const EDGE_RECORD_KEYS: readonly string[] = [
  "t",
  "k",
  "f",
  "o",
  "p",
  "anchor",
  "candidates",
  "isRead",
  "isWrite",
  "sourceFile",
];

/** Which trait keys hold entity references, from the one table that knows. */
const REF_KEYS = new Map<string, boolean>(
  Object.values(ENTITY_REFERENCE_KEYS).map((spec) => [spec.key, spec.many]),
);

export class JsonlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "JsonlError";
  }
}

// ---------------------------------------------------------------- encoding

interface Indexed {
  readonly entity: Entity;
  readonly key: NaturalKey;
}

function bag(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Sorted distinct values — a dictionary is deterministic or the file is not. */
function dictOf<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/**
 * Model → JSONL lines, in canonical order. Yields line by line so a writer
 * never materializes the document; the caller decides where the bytes go.
 */
export function* encodeModel(model: Model): Generator<string> {
  // The encoder decodes rendered ids into keys — one of the two callers
  // `parseRenderedId` licenses. References are rendered ids too, so a
  // caller-supplied key function could only disagree with them.
  const keyOfId = (id: string): NaturalKey => parseRenderedId(id);

  // 1. Canonical order (MM-1) — this IS the surrogate assignment.
  const indexed: Indexed[] = model.entities.map((entity) => ({ entity, key: keyOfId(entity.id) }));
  indexed.sort((a, b) => compareNaturalKeys(a.key, b.key));

  // 2. Natural-key uniqueness (METAMODEL §8a). Within ONE model this is an
  //    error: two records claiming one identity make every reference to it
  //    ambiguous. Redeclaration across a UNION of models stays legal and is the
  //    analyzer's business (first declaration wins), not the encoder's.
  const surrogateOf = new Map<string, number>();
  indexed.forEach(({ key }, index) => {
    const at = naturalKeyIndex(key);
    if (surrogateOf.has(at)) {
      throw new JsonlError(`duplicate natural key: ${renderId(key)}`, 0);
    }
    surrogateOf.set(at, index);
  });

  // 3. Modules, by path: every entity's `m` points at the module entity whose
  //    own symbol is empty (MM-1 — a module names itself).
  // The module is the entity whose symbol is empty AND undisambiguated; taking
  // any empty-symbol entity would let a disambiguated oddity shadow the real
  // module. Canonical order puts the module first, so first-wins is belt too.
  const moduleSurrogate = new Map<string, number>();
  indexed.forEach(({ key }, index) => {
    if (key.symbol !== "" || key.disambiguator !== undefined) return;
    if (!moduleSurrogate.has(key.module)) moduleSurrogate.set(key.module, index);
  });

  const refOf = (id: string, from: string): number => {
    const surrogate = surrogateOf.get(naturalKeyIndex(keyOfId(id)));
    if (surrogate === undefined) {
      throw new JsonlError(`${from} references an entity this model does not declare: ${id}`, 0);
    }
    return surrogate;
  };

  // 4. File table: every path any record can name, interned once.
  const paths = new Set<string>();
  const noteAnchor = (anchor: unknown): void => {
    const file = (anchor as SourceAnchor | undefined)?.file;
    if (typeof file === "string") paths.add(file);
  };
  for (const { entity } of indexed) {
    noteAnchor(bag(entity)["anchor"]);
    const definedIn = bag(entity)["definedIn"];
    if (Array.isArray(definedIn)) for (const path of definedIn) if (typeof path === "string") paths.add(path);
  }
  for (const edge of model.edges) {
    noteAnchor(edge.anchor);
    if (typeof edge.sourceFile === "string") paths.add(edge.sourceFile);
  }
  const files = [...paths].sort();
  const fileIndex = new Map(files.map((path, index) => [path, index]));
  const fileRef = (path: string): number => {
    const index = fileIndex.get(path);
    if (index === undefined) throw new JsonlError(`unknown path: ${path}`, 0);
    return index;
  };
  const wireAnchor = (anchor: SourceAnchor): WireAnchor => [
    fileRef(anchor.file),
    anchor.span[0],
    anchor.span[1],
  ];

  // 5. Dictionaries (MM-3): what this model actually uses, sorted.
  const dict = {
    kinds: dictOf(indexed.map(({ entity }) => entity.kind)),
    traits: dictOf(indexed.flatMap(({ entity }) => entity.traits)),
    edges: dictOf(model.edges.map((edge) => edge.edge)),
    provenance: dictOf(model.edges.map((edge) => edge.provenance)),
  };
  const kindRef = new Map(dict.kinds.map((kind, index) => [kind, index]));
  const traitRef = new Map(dict.traits.map((trait, index) => [trait, index]));
  const edgeKindRef = new Map(dict.edges.map((kind, index) => [kind, index]));
  const provenanceRef = new Map(dict.provenance.map((value, index) => [value, index]));

  const header: HeaderRec = {
    t: "header",
    schemaVersion: model.schemaVersion,
    lang: model.lang,
    extractor: model.extractor,
    root: model.root,
    ...(model.repository === undefined ? {} : { repository: model.repository }),
    dict,
  };
  yield JSON.stringify(header);

  for (const [index, path] of files.entries()) {
    yield JSON.stringify({ t: "f", i: index, path } satisfies FileRec);
  }

  for (const [index, { entity, key }] of indexed.entries()) {
    const moduleIndex = moduleSurrogate.get(key.module);
    if (moduleIndex === undefined) {
      throw new JsonlError(
        `entity ${entity.id} names module "${key.module}", which declares no module entity`,
        0,
      );
    }
    const record: Record<string, unknown> = {
      t: "e",
      i: index,
      k: kindRef.get(entity.kind),
      tr: entity.traits.map((trait) => traitRef.get(trait)),
      m: moduleIndex,
      // A module writes its own path in the symbol slot (it names itself, so
      // nothing else carries the path); everything else writes its path below
      // the module — which may legitimately be empty for a disambiguated
      // entity attached straight to a module, e.g. a top-level lambda.
      s: index === moduleIndex ? key.module : key.symbol,
    };
    if (key.disambiguator !== undefined) record["d"] = key.disambiguator;

    const source = bag(entity);
    for (const wireKey of ENTITY_KEY_ORDER) {
      const value = source[wireKey];
      if (value === undefined) continue;
      record[wireKey] = encodeValue(wireKey, value, entity.id, refOf, fileRef);
    }
    // Keys no trait contributes ride through untouched — an extractor's own
    // annotation must survive a round-trip rather than be silently dropped.
    for (const extra of Object.keys(source).sort()) {
      if (extra === "id" || extra === "kind" || extra === "traits") continue;
      // MM-2: `children` is the inverse of `parent`. A v1-era model still
      // carrying it is not carrying an extension — the key is dropped, not
      // passed through, or the format would re-serialize the index it removed.
      if (extra === "children") continue;
      if ((ENTITY_KEY_ORDER as readonly string[]).includes(extra)) continue;
      record[extra] = source[extra];
    }
    yield JSON.stringify(record);
  }

  const edges = [...model.edges]
    .map((edge) => ({
      edge,
      f: refOf(edge.from, `edge ${edge.edge}`),
      o: refOf(edge.to, `edge ${edge.edge}`),
    }))
    .sort(
      (a, b) =>
        a.f - b.f ||
        a.o - b.o ||
        compareText(a.edge.edge, b.edge.edge) ||
        fileRef(a.edge.anchor.file) - fileRef(b.edge.anchor.file) ||
        a.edge.anchor.span[0] - b.edge.anchor.span[0] ||
        a.edge.anchor.span[1] - b.edge.anchor.span[1] ||
        compareText(a.edge.provenance, b.edge.provenance),
    );

  for (const { edge, f, o } of edges) {
    const record: Record<string, unknown> = {
      t: "x",
      k: edgeKindRef.get(edge.edge),
      f,
      o,
      p: provenanceRef.get(edge.provenance),
    };
    const source = bag(edge);
    for (const wireKey of EDGE_KEY_ORDER) {
      const value = source[wireKey];
      if (value === undefined) continue;
      if (wireKey === "anchor") record["anchor"] = wireAnchor(value as SourceAnchor);
      else if (wireKey === "sourceFile") record["sourceFile"] = fileRef(value as string);
      else if (wireKey === "candidates")
        record["candidates"] = (value as string[]).map((id) => refOf(id, "edge candidates"));
      else record[wireKey] = value;
    }
    yield JSON.stringify(record);
  }

  yield JSON.stringify({
    t: "eof",
    counts: { files: files.length, entities: indexed.length, edges: edges.length },
  } satisfies EofRec);

  function encodeValue(
    key: string,
    value: unknown,
    owner: string,
    ref: (id: string, from: string) => number,
    file: (path: string) => number,
  ): unknown {
    if (key === "anchor") return wireAnchor(value as SourceAnchor);
    if (key in PATH_KEYS) return (value as string[]).map(file);
    const many = REF_KEYS.get(key);
    if (many === undefined) return value;
    return many
      ? (value as string[]).map((id) => ref(id, `${owner}.${key}`))
      : ref(value as string, `${owner}.${key}`);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- decoding

/**
 * THE WIRE VALIDATOR — everything that makes a sequence of lines a conforming
 * model file, and nothing about what a model MEANS.
 *
 * Split out from {@link ModelDecoder} because two consumers need it and only
 * one of them wants a `Model`: the reader materializes entities and edges with
 * rendered ids, while the analysis-store importer writes rows straight to disk
 * and must never hold the corpus in memory. Both must enforce the identical
 * contract, so it is written once, here — an importer that re-implemented the
 * wire would accept a truncated file the reader refuses, and core would no
 * longer own the vocabulary (CLAUDE.md).
 *
 * What it decides, all of schemas/README.md except what needs a whole model:
 * per-record schema, section order, dense surrogates, dictionary bounds, the
 * trait-key rule, file and edge reference bounds, and the eof counts.
 */
export class RecordReader {
  #line = 0;
  #section = -1;
  #header?: HeaderRec;
  #files = 0;
  #entities = 0;
  #edges = 0;
  #eof?: EofRec;
  /**
   * The largest entity reference an ENTITY record made, and where. Entity
   * references may legitimately point forward (`declaredType` at an entity that
   * sorts later), so they can only be decided once the count is final — but
   * remembering the largest costs nothing, where remembering every record would
   * cost the corpus.
   */
  #maxEntityRef = -1;
  #maxEntityRefAt = "";

  /** The header, once seen. */
  get header(): HeaderRec | undefined {
    return this.#header;
  }

  /** Records accepted so far, by section. */
  get counts(): { files: number; entities: number; edges: number } {
    return { files: this.#files, entities: this.#entities, edges: this.#edges };
  }

  get line(): number {
    return this.#line;
  }

  /**
   * Validates one line. Returns the typed record, or `undefined` for a blank
   * line. Throws {@link JsonlError} — naming the line — for anything else.
   */
  accept(text: string): ModelRecord | undefined {
    this.#line += 1;
    const trimmed = text.trim();
    if (trimmed === "") return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new JsonlError(
        `not JSON: ${error instanceof Error ? error.message : String(error)}`,
        this.#line,
      );
    }
    const tag = (parsed as { t?: unknown }).t;
    if (typeof tag !== "string") throw new JsonlError("record has no `t` tag", this.#line);

    switch (tag) {
      case "header":
        return this.#acceptHeader(parsed);
      case "f":
        return this.#acceptFile(parsed);
      case "e":
        return this.#acceptEntity(parsed);
      case "x":
        return this.#acceptEdge(parsed);
      case "eof":
        return this.#acceptEof(parsed);
      default:
        throw new JsonlError(`unknown record type ${JSON.stringify(tag)}`, this.#line);
    }
  }

  /** The whole-file properties: the trailer exists, and it tells the truth. */
  finish(): EofRec {
    const header = this.#header;
    if (header === undefined) throw new JsonlError("empty file: no header record", 0);
    if (this.#eof === undefined) {
      throw new JsonlError("no eof record — the file is truncated, or the writer died mid-run", 0);
    }
    const counts = this.#eof.counts;
    const actual = this.counts;
    for (const section of ["files", "entities", "edges"] as const) {
      if (counts[section] !== actual[section]) {
        throw new JsonlError(
          `eof declares ${counts[section]} ${section} but the file carries ${actual[section]}`,
          0,
        );
      }
    }
    // Closure for the references that were allowed to point forward.
    if (this.#maxEntityRef >= this.#entities) {
      throw new JsonlError(
        `${this.#maxEntityRefAt} ${this.#maxEntityRef} resolves to no entity (closure)`,
        0,
      );
    }
    return this.#eof;
  }

  /** Section order is contractual: one pass, no rewinding, no lookahead. */
  #enter(section: number, tag: string): void {
    if (section < this.#section) {
      throw new JsonlError(`"${tag}" record after the section it belongs to closed`, this.#line);
    }
    this.#section = section;
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      // The prettified block starts on its own line: a renderer that indents a
      // multi-line message then keeps every "✖ reason / → at path" pair intact.
      throw new JsonlError(`invalid ${what}:\n${z.prettifyError(result.error)}`, this.#line);
    }
    return result.data;
  }

  #acceptHeader(value: unknown): HeaderRec {
    if (this.#header !== undefined) throw new JsonlError("a second header record", this.#line);
    if (this.#line !== 1) throw new JsonlError("the header must be the first record", this.#line);
    this.#enter(0, "header");
    const header = this.#parse(HeaderRec, value, "header");

    // MM-3: a vocabulary is a referential SET, and records address it by index.
    // A repeated entry makes two indices name one thing, so `kind → id` stops
    // being a function and any store that interns the dictionary — the SQLite
    // analysis store does — either loses a row or invents a name collision.
    // Cheap to state here, and it belongs here: it is a property of the file.
    for (const [vocabulary, entries] of Object.entries(header.dict)) {
      const seen = new Set<string>();
      for (const entry of entries as string[]) {
        if (seen.has(entry)) {
          throw new JsonlError(
            `header dictionary \`${vocabulary}\` repeats ${JSON.stringify(entry)} — a vocabulary is a set`,
            this.#line,
          );
        }
        seen.add(entry);
      }
    }

    this.#header = header;
    return this.#header;
  }

  #need(): HeaderRec {
    if (this.#header === undefined) {
      throw new JsonlError("record before the header", this.#line);
    }
    return this.#header;
  }

  #acceptFile(value: unknown): FileRec {
    this.#need();
    this.#enter(1, "f");
    const record = this.#parse(FileRec, value, "file record");
    if (record.i !== this.#files) {
      throw new JsonlError(
        `file index ${record.i} out of order — expected ${this.#files}`,
        this.#line,
      );
    }
    this.#files += 1;
    return record;
  }

  #acceptEntity(value: unknown): EntityRec {
    const header = this.#need();
    this.#enter(2, "e");
    const record = this.#parse(EntityRec, value, "entity record");
    if (record.i !== this.#entities) {
      throw new JsonlError(
        `entity surrogate ${record.i} out of order — expected ${this.#entities}`,
        this.#line,
      );
    }
    // The module reference must already be defined: canonical order puts a
    // module before everything inside it, so this can never need lookahead.
    if (record.m > record.i) {
      throw new JsonlError(
        `entity ${record.i} names module ${record.m}, which is declared later`,
        this.#line,
      );
    }
    this.#entities += 1;

    // The trait-key rule (METAMODEL §2) over WIRE shapes — resolved through the
    // header's dictionary, which is why no per-record JSON Schema can state it.
    const traits = record.tr.map((ref) => this.#fromDict(header.dict.traits, ref, "trait"));
    this.#fromDict(header.dict.kinds, record.k, "kind");
    for (const trait of traits) {
      const result = WIRE_TRAITS[trait].safeParse(record);
      if (!result.success) {
        throw new JsonlError(
          `entity ${record.i} declares ${trait}:\n${z.prettifyError(result.error)}`,
          this.#line,
        );
      }
    }

    // File references are decidable now; entity references may point forward.
    if (record.anchor !== undefined) this.#requireFile(record.anchor[0]);
    if (record.definedIn !== undefined) for (const ref of record.definedIn) this.#requireFile(ref);
    for (const [key, spec] of REF_KEYS) {
      const value_ = (record as Record<string, unknown>)[key];
      if (value_ === undefined) continue;
      const refs = spec ? (value_ as number[]) : [value_ as number];
      for (const ref of refs) this.#noteEntityRef(ref, `entity ${record.i} ${key}`);
    }
    this.#noteEntityRef(record.m, `entity ${record.i} module`);
    return record;
  }

  #acceptEdge(value: unknown): EdgeRec {
    const header = this.#need();
    this.#enter(3, "x");
    const record = this.#parse(EdgeRec, value, "edge record");
    this.#fromDict(header.dict.edges, record.k, "edge kind");
    this.#fromDict(header.dict.provenance, record.p, "provenance");
    // Edges follow every entity, so their references are decidable on arrival.
    this.#requireEntity(record.f, "edge from");
    this.#requireEntity(record.o, "edge to");
    if (record.candidates !== undefined) {
      for (const ref of record.candidates) this.#requireEntity(ref, "edge candidate");
    }
    this.#requireFile(record.anchor[0]);
    if (record.sourceFile !== undefined) this.#requireFile(record.sourceFile);
    this.#edges += 1;
    return record;
  }

  #acceptEof(value: unknown): EofRec {
    this.#need();
    if (this.#eof !== undefined) throw new JsonlError("a second eof record", this.#line);
    this.#enter(4, "eof");
    this.#eof = this.#parse(EofRec, value, "eof record");
    return this.#eof;
  }

  #fromDict<T extends string>(dict: readonly T[], index: number, what: string): T {
    const value = dict[index];
    if (value === undefined) {
      throw new JsonlError(`${what} ${index} is not in the header dictionary`, this.#line);
    }
    return value;
  }

  /** Closure, checked as a reference resolves: a surrogate names a known row. */
  #requireEntity(ref: number, what: string): void {
    if (ref >= this.#entities) {
      throw new JsonlError(`${what} ${ref} resolves to no entity (closure)`, this.#line);
    }
  }

  #noteEntityRef(ref: number, what: string): void {
    if (ref > this.#maxEntityRef) {
      this.#maxEntityRef = ref;
      this.#maxEntityRefAt = what;
    }
  }

  #requireFile(ref: number): void {
    if (ref >= this.#files) {
      throw new JsonlError(`file reference ${ref} resolves to no path`, this.#line);
    }
  }
}

/**
 * Feed lines in, get a model out. Incremental so a reader can stream a file of
 * any size; `finish()` is where the whole-file properties (eof counts, closure)
 * are decided.
 *
 * Validation is {@link RecordReader}'s; this class only turns validated records
 * into entities and edges — surrogates back into rendered ids, file references
 * back into paths, dictionary indices back into names.
 */
export class ModelDecoder {
  readonly #reader = new RecordReader();
  readonly #builder = new ModelBuilder();

  push(text: string): void {
    const record = this.#reader.accept(text);
    if (record !== undefined) this.#builder.add(record);
  }

  finish(): Model {
    this.#reader.finish();
    return this.#builder.finish();
  }

  /** The natural keys, by surrogate — what an importer needs and a reader checks. */
  get keys(): readonly NaturalKey[] {
    return this.#builder.keys;
  }
}

/**
 * Validated records in, a `Model` out. No validation of its own: it trusts
 * {@link RecordReader}, which is the only place the wire contract is stated.
 */
export class ModelBuilder {
  #header_?: HeaderRec;
  #files: string[] = [];
  #records: EntityRec[] = [];
  #edges: Edge[] = [];
  /** Rendered id per surrogate — built once, then SHARED by every reference. */
  #ids: string[] = [];
  #keys: NaturalKey[] = [];
  #entities: Entity[] = [];
  #done = false;

  add(record: ModelRecord): void {
    switch (record.t) {
      case "header":
        this.#header_ = record;
        return;
      case "f":
        this.#files.push(record.path);
        return;
      case "e":
        return this.#addEntity(record);
      case "x":
        return this.#addEdge(record);
      default:
        return;
    }
  }

  #addEntity(record: EntityRec): void {
    this.#records.push(record);
    const modulePath = record.m === record.i ? record.s : this.#records[record.m]!.s;
    const key: NaturalKey = {
      lang: this.#header().lang,
      module: modulePath,
      symbol: record.m === record.i ? "" : record.s,
      disambiguator: record.d,
    };
    this.#keys.push(key);
    this.#ids.push(renderId(key));
  }

  #addEdge(record: EdgeRec): void {
    const header = this.#header();
    const edge: Record<string, unknown> = {
      edge: header.dict.edges[record.k] satisfies EdgeKind | undefined as EdgeKind,
      from: this.#id(record.f),
      to: this.#id(record.o),
      provenance: header.dict.provenance[record.p] satisfies Provenance | undefined as Provenance,
      anchor: this.#anchor(record.anchor),
    };
    if (record.candidates !== undefined) {
      edge["candidates"] = record.candidates.map((ref) => this.#id(ref));
    }
    if (record.isRead !== undefined) edge["isRead"] = record.isRead;
    if (record.isWrite !== undefined) edge["isWrite"] = record.isWrite;
    if (record.sourceFile !== undefined) edge["sourceFile"] = this.#path(record.sourceFile);
    for (const [extra, extraValue] of Object.entries(record)) {
      if (EDGE_RECORD_KEYS.includes(extra)) continue;
      edge[extra] = extraValue;
    }
    this.#edges.push(edge as unknown as Edge);
  }

  #header(): HeaderRec {
    if (this.#header_ === undefined) throw new JsonlError("record before the header", 0);
    return this.#header_;
  }

  #id(ref: number): string {
    const id = this.#ids[ref];
    if (id === undefined) {
      throw new JsonlError(`reference ${ref} resolves to no entity (closure)`, 0);
    }
    return id;
  }

  #path(ref: number): string {
    const path = this.#files[ref];
    if (path === undefined) {
      throw new JsonlError(`file reference ${ref} resolves to no path`, 0);
    }
    return path;
  }

  #anchor(anchor: WireAnchor): SourceAnchor {
    return { file: this.#path(anchor[0]), span: [anchor[1], anchor[2]] };
  }

  /**
   * Resolves entity references and decides the whole-file properties. Entity
   * refs are resolved HERE, not on arrival: `declaredType` may legitimately
   * point at an entity that sorts later.
   */
  finish(): Model {
    if (this.#done) throw new JsonlError("finish() was already called on this decoder", 0);
    this.#done = true;
    const header = this.#header();

    for (const [index, record] of this.#records.entries()) {
      const traits = record.tr.map((ref) => header.dict.traits[ref] as TraitName);
      const entity: Record<string, unknown> = {
        id: this.#ids[index]!,
        kind: header.dict.kinds[record.k] as string,
        traits,
      };
      for (const key of ENTITY_KEY_ORDER) {
        const value = (record as Record<string, unknown>)[key];
        if (value === undefined) continue;
        entity[key] = this.#decodeValue(key, value);
      }
      for (const [extra, value] of Object.entries(record)) {
        if (ENTITY_RECORD_KEYS.includes(extra)) continue;
        if ((ENTITY_KEY_ORDER as readonly string[]).includes(extra)) continue;
        entity[extra] = value;
      }
      this.#entities.push(entity as unknown as Entity);
    }

    return {
      schemaVersion: header.schemaVersion,
      lang: header.lang,
      extractor: header.extractor,
      root: header.root,
      ...(header.repository === undefined ? {} : { repository: header.repository }),
      entities: this.#entities,
      edges: this.#edges,
    };
  }

  /** The natural keys, by surrogate — what an importer needs and a reader checks. */
  get keys(): readonly NaturalKey[] {
    return this.#keys;
  }

  #decodeValue(key: string, value: unknown): unknown {
    if (key === "anchor") return this.#anchor(value as WireAnchor);
    if (key in PATH_KEYS) return (value as number[]).map((ref) => this.#path(ref));
    const many = REF_KEYS.get(key);
    if (many === undefined) return value;
    return many ? (value as number[]).map((ref) => this.#id(ref)) : this.#id(value as number);
  }
}

/** Whole-input convenience: lines in, validated model out. */
export function decodeModel(lines: Iterable<string>): Model {
  const decoder = new ModelDecoder();
  for (const line of lines) decoder.push(line);
  return decoder.finish();
}

/**
 * Lines in, VALIDATED RECORDS out — the wire without the model. Every rule of
 * schemas/README.md that a single pass can decide is enforced as the records go
 * by, and the trailer is checked when the input ends.
 */
export function* decodeRecords(lines: Iterable<string>): Generator<ModelRecord> {
  const reader = new RecordReader();
  for (const line of lines) {
    const record = reader.accept(line);
    if (record !== undefined) yield record;
  }
  reader.finish();
}

/** Model → one JSONL document. For tests and small models; large ones stream. */
export function encodeModelToString(model: Model): string {
  let out = "";
  for (const line of encodeModel(model)) out += `${line}\n`;
  return out;
}
