/**
 * `model.jsonl` → `model.db` (PLAN.md §9.3, docs/model-encoding.md §3).
 *
 * THE IMPORTER NEVER HOLDS THE CORPUS. It is driven by core's validated record
 * stream, writing rows as records go by, so importing fineract costs the memory
 * of one record rather than of 241 101 entities. That is the whole reason step
 * 3 split `RecordReader` out of `ModelDecoder`: measured there, streaming and
 * validating peaks at 140MB where materializing a `Model` peaks at 555MB.
 *
 * ATOMICITY COMES FROM THE RENAME, NOT FROM THE JOURNAL. The rows go into a
 * temporary file beside the target and it is renamed into place only after the
 * transaction commits; a killed import leaves a `.tmp-<pid>` that nothing reads,
 * never a plausible-looking `model.db` holding half a corpus. That is the same
 * hazard step 3 found in the text format — a truncated file that every line of
 * still parses — one level up, and it is why the bulk-load pragmas below are
 * safe: with no reader able to see the file before COMMIT, a journal would only
 * be protecting a temporary we are about to delete anyway.
 *
 * NOTHING IS RENUMBERED. Entity ids are the model's surrogates, dictionary ids
 * are the header's own indices, file ids are the file records' indices. So the
 * import is a copy, and `readStoreRecords` below is its exact inverse — which
 * is how the round trip is stated as a test rather than hoped for.
 */

import { closeSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ModelBuilder,
  readModelRecordsSync,
  type EdgeRec,
  type EntityRec,
  type FileRec,
  type HeaderRec,
  type Model,
  type ModelRecord,
  type WireAnchor,
} from "@codegraph/core";

import {
  DB_VERSION,
  EDGE_KEY_STORAGE,
  ENTITY_KEY_STORAGE,
  SCHEMA_INDEXES_SQL,
  SCHEMA_TABLES_SQL,
  STORE_OPEN_OPTIONS,
} from "./schema.js";
import { loadSqlite, type SqliteDatabase, type SqliteValue } from "./sqlite.js";

/** Keys the schema has a home for. Anything else is an extractor's own. */
const TYPED_ENTITY_KEYS = new Set<string>(["t", ...Object.keys(ENTITY_KEY_STORAGE)]);
const TYPED_EDGE_KEYS = new Set<string>(["t", ...Object.keys(EDGE_KEY_STORAGE)]);

export interface ImportResult {
  /** The database that now exists. */
  path: string;
  counts: { files: number; entities: number; edges: number };
  /** Size of the written database, for reporting against the source. */
  bytes: number;
}

/** `foo.jsonl` → `foo.db`. Any other extension just gains `.db`. */
export function storePathFor(jsonlPath: string): string {
  const name = basename(jsonlPath);
  const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return join(dirname(jsonlPath), `${stem}.db`);
}

/**
 * Bulk-load settings, applied to the temporary file only.
 *
 * `journal_mode = OFF` removes rollback, and that is deliberate rather than
 * reckless: the transaction's only job here is to be fast, because failure is
 * handled by deleting a file nobody has seen. `synchronous = OFF` follows for
 * the same reason — durability of a cache that is regenerated on any doubt is
 * not a property worth paying for on every page.
 */
const BULK_PRAGMAS = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;
`;

function bool(value: boolean | undefined): SqliteValue {
  return value === undefined ? null : value ? 1 : 0;
}

function json(value: unknown): SqliteValue {
  return value === undefined ? null : JSON.stringify(value);
}

/** The keys core does not type, as a JSON object — or NULL when there are none. */
function extraOf(record: Record<string, unknown>, typed: Set<string>): SqliteValue {
  let extra: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    if (typed.has(key)) continue;
    extra ??= {};
    extra[key] = record[key];
  }
  return extra === undefined ? null : JSON.stringify(extra);
}

/**
 * Read `jsonlPath` and write a database beside it (or at `dbPath`).
 *
 * @throws whatever the record reader throws for a malformed model — the store
 * adds no gate of its own, so a file `codegraph validate` can describe is a
 * file this can cache.
 */
export function importModel(jsonlPath: string, dbPath = storePathFor(jsonlPath)): ImportResult {
  const temporary = `${dbPath}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });

  const db = loadSqlite().open(temporary, STORE_OPEN_OPTIONS);
  let committed = false;
  try {
    db.exec(BULK_PRAGMAS);
    // Tables first, indexes last: building each B-tree once from data already
    // in surrogate order beats maintaining seventeen of them across a million
    // inserts. `createSchema` applies both, so the result is the same schema.
    db.exec(SCHEMA_TABLES_SQL);
    db.exec("BEGIN");
    const counts = writeRecords(db, jsonlPath);
    db.exec(SCHEMA_INDEXES_SQL);
    db.exec("COMMIT");
    committed = true;
    db.close();

    // Only now does a reader have anything to find under the real name.
    renameSync(temporary, dbPath);
    return { path: dbPath, counts, bytes: statSync(dbPath).size };
  } finally {
    if (!committed) {
      try {
        db.close();
      } catch {
        // Already closed, or never opened far enough to matter.
      }
      rmSync(temporary, { force: true });
    }
  }
}

/** Everything between BEGIN and COMMIT. Split out to keep the file lifecycle above readable. */
function writeRecords(db: SqliteDatabase, jsonlPath: string): ImportResult["counts"] {
  const insert = {
    meta: db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)"),
    kind: db.prepare("INSERT INTO kind(id, name) VALUES (?, ?)"),
    trait: db.prepare("INSERT INTO trait(id, name) VALUES (?, ?)"),
    edgeKind: db.prepare("INSERT INTO edge_kind(id, name) VALUES (?, ?)"),
    provenance: db.prepare("INSERT INTO provenance(id, name) VALUES (?, ?)"),
    file: db.prepare("INSERT INTO file(id, path) VALUES (?, ?)"),
    traitSet: db.prepare("INSERT INTO trait_set(id) VALUES (?)"),
    traitSetMember: db.prepare(
      "INSERT INTO trait_set_member(trait_set_id, ord, trait_id) VALUES (?, ?, ?)",
    ),
    entity: db.prepare(
      `INSERT INTO entity(id, kind_id, trait_set_id, module_id, symbol, disambiguator,
                          name, signature, parent_id, attached_to_id, declared_type_id,
                          is_stub, anchor_file_id, anchor_start, anchor_end, space, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    comment: db.prepare("INSERT INTO entity_comment(entity_id, ord, text) VALUES (?, ?, ?)"),
    definedIn: db.prepare("INSERT INTO entity_defined_in(entity_id, ord, file_id) VALUES (?, ?, ?)"),
    parameter: db.prepare(
      "INSERT INTO entity_parameter(entity_id, ord, parameter_id) VALUES (?, ?, ?)",
    ),
    localVariable: db.prepare(
      "INSERT INTO entity_local_variable(entity_id, ord, variable_id) VALUES (?, ?, ?)",
    ),
    edge: db.prepare(
      `INSERT INTO edge(id, kind_id, from_id, to_id, provenance_id,
                        anchor_file_id, anchor_start, anchor_end,
                        is_read, is_write, source_file_id, candidate_count, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    candidate: db.prepare(
      "INSERT INTO edge_candidate(edge_id, ord, candidate_id) VALUES (?, ?, ?)",
    ),
  };

  /**
   * Trait sets, interned as they are met (MM-4). The key is the ORDERED
   * sequence, so an entity's `tr` array comes back exactly as written; there
   * are 15–18 distinct sets across both real corpora, so the map stays tiny
   * however large the corpus is.
   */
  const traitSets = new Map<string, number>();
  const traitSetOf = (traits: readonly number[]): number => {
    const key = traits.join(",");
    let id = traitSets.get(key);
    if (id !== undefined) return id;
    id = traitSets.size;
    traitSets.set(key, id);
    insert.traitSet.run(id);
    traits.forEach((trait, ord) => insert.traitSetMember.run(id as number, ord, trait));
    return id;
  };

  let files = 0;
  let entities = 0;
  let edges = 0;

  for (const record of readModelRecordsSync(jsonlPath)) {
    switch (record.t) {
      case "header":
        writeHeader(insert, record, jsonlPath);
        break;

      case "f":
        insert.file.run(record.i, record.path);
        files += 1;
        break;

      case "e": {
        const anchor: WireAnchor | [null, null, null] = record.anchor ?? [null, null, null];
        insert.entity.run(
          record.i,
          record.k,
          traitSetOf(record.tr),
          record.m,
          record.s,
          record.d ?? null,
          record.name ?? null,
          record.signature ?? null,
          record.parent ?? null,
          record.attachedTo ?? null,
          record.declaredType ?? null,
          bool(record.isStub),
          anchor[0],
          anchor[1],
          anchor[2],
          json(record.space),
          extraOf(record, TYPED_ENTITY_KEYS),
        );
        record.comments?.forEach((text, ord) => insert.comment.run(record.i, ord, text));
        record.definedIn?.forEach((file, ord) => insert.definedIn.run(record.i, ord, file));
        record.parameters?.forEach((ref, ord) => insert.parameter.run(record.i, ord, ref));
        record.localVariables?.forEach((ref, ord) => insert.localVariable.run(record.i, ord, ref));
        entities += 1;
        break;
      }

      case "x": {
        // Edges have no wire id; their position IS their identity here, which
        // keeps `readStoreRecords` able to hand them back in the order the
        // model stated them.
        const id = edges;
        insert.edge.run(
          id,
          record.k,
          record.f,
          record.o,
          record.p,
          record.anchor[0],
          record.anchor[1],
          record.anchor[2],
          bool(record.isRead),
          bool(record.isWrite),
          record.sourceFile ?? null,
          record.candidates === undefined ? null : record.candidates.length,
          extraOf(record, TYPED_EDGE_KEYS),
        );
        record.candidates?.forEach((ref, ord) => insert.candidate.run(id, ord, ref));
        edges += 1;
        break;
      }

      case "eof":
        insert.meta.run("files", String(record.counts.files));
        insert.meta.run("entities", String(record.counts.entities));
        insert.meta.run("edges", String(record.counts.edges));
        break;
    }
  }

  return { files, entities, edges };
}

type Inserts = Record<string, ReturnType<SqliteDatabase["prepare"]>>;

/** The header's dictionaries become rows; the rest becomes `meta`. */
function writeHeader(insert: Inserts, header: HeaderRec, jsonlPath: string): void {
  header.dict.kinds.forEach((name, id) => insert.kind!.run(id, name));
  header.dict.traits.forEach((name, id) => insert.trait!.run(id, name));
  header.dict.edges.forEach((name, id) => insert.edgeKind!.run(id, name));
  header.dict.provenance.forEach((name, id) => insert.provenance!.run(id, name));

  const source = statSync(jsonlPath);
  const meta: [string, string][] = [
    ["dbVersion", String(DB_VERSION)],
    ["schemaVersion", header.schemaVersion],
    ["lang", header.lang],
    ["root", header.root],
    ["extractor", JSON.stringify(header.extractor)],
    ["sourcePath", jsonlPath],
    ["sourceBytes", String(source.size)],
    ["sourceMtimeMs", String(source.mtimeMs)],
  ];
  for (const [key, value] of meta) insert.meta!.run(key, value);
}

// ────────────────────────────────────────────────────────────────────────────
// The inverse
// ────────────────────────────────────────────────────────────────────────────

/**
 * Yield the wire records back out of a store, in section order.
 *
 * This is the importer read backwards, and it exists so that "the cache loses
 * nothing" is a TEST rather than a claim: `[...readStoreRecords(db)]` must equal
 * `[...readModelRecordsSync(path)]`, record for record. Rows are streamed with
 * `iterate()`, never `all()`, so reading a corpus back costs no more than
 * writing it did.
 *
 * ORDER COMES FROM THE SURROGATE, never from the engine. Every query below
 * sorts by the id the importer assigned — the canonical order the model was
 * written in. `fixtures/unicode` exists because SQLite's BINARY collation would
 * order the same ids differently, and a renumbered corpus is a repointed one.
 */
export function* readStoreRecords(db: SqliteDatabase): Generator<ModelRecord> {
  const meta = new Map<string, string>();
  for (const row of db.prepare("SELECT key, value FROM meta").iterate()) {
    meta.set(row.key as string, row.value as string);
  }

  const names = (table: string): string[] =>
    [...db.prepare(`SELECT name FROM ${table} ORDER BY id`).iterate()].map(
      (row) => row.name as string,
    );

  yield {
    t: "header",
    schemaVersion: meta.get("schemaVersion") ?? "",
    lang: meta.get("lang") ?? "",
    extractor: JSON.parse(meta.get("extractor") ?? "{}") as HeaderRec["extractor"],
    root: meta.get("root") ?? "",
    dict: {
      kinds: names("kind"),
      traits: names("trait") as HeaderRec["dict"]["traits"],
      edges: names("edge_kind") as HeaderRec["dict"]["edges"],
      provenance: names("provenance") as HeaderRec["dict"]["provenance"],
    },
  };

  for (const row of db.prepare("SELECT id, path FROM file ORDER BY id").iterate()) {
    yield { t: "f", i: row.id as number, path: row.path as string } satisfies FileRec;
  }

  const traitSets = groupOrdered(
    db,
    "SELECT trait_set_id AS owner, trait_id AS value FROM trait_set_member ORDER BY trait_set_id, ord",
  );
  const comments = groupOrdered(
    db,
    "SELECT entity_id AS owner, text AS value FROM entity_comment ORDER BY entity_id, ord",
  );
  const definedIn = groupOrdered(
    db,
    "SELECT entity_id AS owner, file_id AS value FROM entity_defined_in ORDER BY entity_id, ord",
  );
  const parameters = groupOrdered(
    db,
    "SELECT entity_id AS owner, parameter_id AS value FROM entity_parameter ORDER BY entity_id, ord",
  );
  const locals = groupOrdered(
    db,
    "SELECT entity_id AS owner, variable_id AS value FROM entity_local_variable ORDER BY entity_id, ord",
  );

  /**
   * WHICH ARRAY-VALUED KEYS AN ENTITY CARRIES COMES FROM ITS TRAIT SET, never
   * from whether rows exist. `comments: []` writes no rows to `entity_comment`
   * and neither does an entity with no `TComment` — so row count cannot tell an
   * EMPTY array from an ABSENT key, and the fixture contains a stub module with
   * an empty `definedIn` that proves it.
   *
   * The trait set is the answer because it is the same thing the wire uses:
   * `TComment` contributes `comments`, so carrying the trait IS carrying the
   * key.
   */
  const traitNames = new Map<number, string>();
  for (const row of db.prepare("SELECT id, name FROM trait").iterate()) {
    traitNames.set(row.id as number, row.name as string);
  }
  /** Per trait set: the ids an entity writes as `tr`, and the names to test. */
  const traitSetInfo = new Map<number, TraitSetInfo>();
  for (const [setId, traits] of traitSets) {
    traitSetInfo.set(setId, {
      ids: traits as number[],
      names: new Set(traits.map((id) => traitNames.get(id as number) ?? "")),
    });
  }

  for (const row of rowsAsArrays(db, `SELECT ${ENTITY_COLUMNS} FROM entity ORDER BY id`)) {
    const traits = traitSetInfo.get(row[2] as number) ?? EMPTY_TRAIT_SET;
    yield entityRecordOf(row, traits, comments, definedIn, parameters, locals);
  }

  const candidates = groupOrdered(
    db,
    "SELECT edge_id AS owner, candidate_id AS value FROM edge_candidate ORDER BY edge_id, ord",
  );
  for (const row of rowsAsArrays(db, `SELECT ${EDGE_COLUMNS} FROM edge ORDER BY id`)) {
    yield edgeRecordOf(row, candidates);
  }

  yield {
    t: "eof",
    counts: {
      files: Number(meta.get("files") ?? 0),
      entities: Number(meta.get("entities") ?? 0),
      edges: Number(meta.get("edges") ?? 0),
    },
  };
}

/**
 * Collect an ordered child table into `owner → values`. Every such table is
 * tiny next to the corpus — 60k parameter cells against 241k entities on
 * fineract — so holding them costs far less than a correlated query per row.
 */
function groupOrdered(db: SqliteDatabase, sql: string): Map<number, unknown[]> {
  const out = new Map<number, unknown[]>();
  for (const [owner, value] of rowsAsArrays(db, sql)) {
    let list = out.get(owner as number);
    if (list === undefined) out.set(owner as number, (list = []));
    list.push(value);
  }
  return out;
}

/**
 * Positional rows. Every caller writes its column list out, so a position is
 * as legible as a name here — and 2.6× cheaper across a million rows (see
 * `SqliteStatement.setReturnArrays`).
 */
function rowsAsArrays(db: SqliteDatabase, sql: string): IterableIterator<SqliteValue[]> {
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  return statement.iterate() as unknown as IterableIterator<SqliteValue[]>;
}

/** The trait that contributes each array-valued key (mirrors `WIRE_TRAITS`). */
const LIST_KEY_TRAIT = {
  comments: "TComment",
  definedIn: "TModule",
  parameters: "TWithParameters",
  localVariables: "TWithLocalVariables",
} as const;

/** A trait set, in both forms an entity record needs it. */
interface TraitSetInfo {
  /** The dictionary ids, in the order the wire wrote them. */
  readonly ids: readonly number[];
  /** The same, by name, for deciding which array-valued keys are present. */
  readonly names: ReadonlySet<string>;
}

const EMPTY_TRAIT_SET: TraitSetInfo = { ids: [], names: new Set() };

/**
 * The column lists the positional readers index into. Written out rather than
 * `SELECT *` for two reasons: positions must not depend on DDL column order,
 * and the destructuring below is only readable if the order is stated next to
 * it.
 */
const ENTITY_COLUMNS =
  "id, kind_id, trait_set_id, module_id, symbol, disambiguator, name, signature, " +
  "parent_id, attached_to_id, declared_type_id, is_stub, " +
  "anchor_file_id, anchor_start, anchor_end, space, extra";

const EDGE_COLUMNS =
  "id, kind_id, from_id, to_id, provenance_id, anchor_file_id, anchor_start, anchor_end, " +
  "is_read, is_write, source_file_id, candidate_count, extra";

/** NULL means the key was absent; anything else is a value the wire carried. */
function put(record: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) record[key] = value;
}

function entityRecordOf(
  row: SqliteValue[],
  traits: TraitSetInfo,
  comments: Map<number, unknown[]>,
  definedIn: Map<number, unknown[]>,
  parameters: Map<number, unknown[]>,
  locals: Map<number, unknown[]>,
): EntityRec {
  const [id, kindId, , moduleId, symbol, disambiguator, name, signature,
         parentId, attachedToId, declaredTypeId, isStub,
         anchorFile, anchorStart, anchorEnd, space, extra] = row as [
    number, number, number, number, string, string | null, string | null, string | null,
    number | null, number | null, number | null, number | null,
    number | null, number | null, number | null, string | null, string | null,
  ];

  const record: Record<string, unknown> = {
    t: "e",
    i: id,
    k: kindId,
    tr: traits.ids,
    m: moduleId,
    s: symbol,
  };
  put(record, "d", disambiguator);
  put(record, "name", name);
  put(record, "signature", signature);
  put(record, "parent", parentId);
  put(record, "attachedTo", attachedToId);
  put(record, "declaredType", declaredTypeId);
  if (isStub !== null) record["isStub"] = isStub === 1;
  if (anchorFile !== null) record["anchor"] = [anchorFile, anchorStart, anchorEnd];

  // Presence from the trait set, contents from the rows — see above.
  const lists = { comments, definedIn, parameters, localVariables: locals };
  for (const [key, trait] of Object.entries(LIST_KEY_TRAIT)) {
    if (traits.names.has(trait)) record[key] = lists[key as keyof typeof lists].get(id) ?? [];
  }

  if (space !== null) record["space"] = JSON.parse(space) as unknown;
  if (extra !== null) Object.assign(record, JSON.parse(extra) as object);
  return record as unknown as EntityRec;
}

function edgeRecordOf(row: SqliteValue[], candidates: Map<number, unknown[]>): EdgeRec {
  const [id, kindId, fromId, toId, provenanceId, anchorFile, anchorStart, anchorEnd,
         isRead, isWrite, sourceFileId, candidateCount, extra] = row as [
    number, number, number, number, number, number, number, number,
    number | null, number | null, number | null, number | null, string | null,
  ];

  const record: Record<string, unknown> = {
    t: "x",
    k: kindId,
    f: fromId,
    o: toId,
    p: provenanceId,
    anchor: [anchorFile, anchorStart, anchorEnd],
  };
  // Presence from the count column, contents from the rows: an empty
  // `candidates` array has no rows, and no trait would vouch for the key.
  if (candidateCount !== null) record["candidates"] = candidates.get(id) ?? [];
  if (isRead !== null) record["isRead"] = isRead === 1;
  if (isWrite !== null) record["isWrite"] = isWrite === 1;
  put(record, "sourceFile", sourceFileId);
  if (extra !== null) Object.assign(record, JSON.parse(extra) as object);
  return record as unknown as EdgeRec;
}

/**
 * The store's records, materialized. `ModelBuilder` is core's — the same one
 * `readModelFileSync` uses — so a model hydrated from the cache is built by
 * exactly the code that builds one from the file, and cannot diverge from it.
 */
export function hydrateModel(db: SqliteDatabase): Model {
  const builder = new ModelBuilder();
  for (const record of readStoreRecords(db)) builder.add(record);
  return builder.finish();
}

/** Open an existing store read-only. The file must exist. */
export function openStore(dbPath: string): SqliteDatabase {
  const fd = openSync(dbPath, "r");
  closeSync(fd); // A missing file must fail here, not inside SQLite.
  return loadSqlite().open(dbPath, { ...STORE_OPEN_OPTIONS, readOnly: true });
}
