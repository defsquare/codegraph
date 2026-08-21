/**
 * THE ANALYSIS STORE'S SCHEMA (docs/model-encoding.md §3.1, PLAN.md §9.3).
 *
 * `model.db` is a DERIVED, DISPOSABLE cache of one `.jsonl` model. The `.jsonl`
 * is the contract — schema-validated, diffable, language-agnostic, committed as
 * fixtures; the database is the workbench. It is regenerable at any time, never
 * committed, and never the interchange. Migration is REGENERATION: on a
 * `dbVersion` mismatch the importer drops the file and re-reads the model,
 * because there is nothing in here that the model does not already say.
 *
 * ── The shape follows the M6 wire, not the pre-M6 sketch ──────────────────
 *
 * IDS ARE THE MODEL'S OWN NUMBERS. `entity.id` is the JSONL surrogate; every
 * dictionary id is that vocabulary's index in the header. Nothing is renumbered
 * on the way in, so importing is a copy and hydrating is a lookup — and a bug
 * that renumbered the corpus would be visible as a changed id rather than as a
 * silently repointed edge. Surrogates are file-scoped and are NOT identity
 * (MM-1): identity is the natural key `(lang, module, symbol, disambiguator?)`,
 * carried here as `module_id`/`symbol`/`disambiguator` with `lang` in `meta`.
 *
 * NULL MEANS "THE KEY WAS ABSENT", and that is lossless rather than lax: which
 * keys an entity carries is decided by its TRAIT SET, so `signature IS NULL`
 * and "this entity has no TInvocable" are the same statement, and re-encoding
 * puts back exactly the keys that were there. The one exception is
 * `declared_type_id`, which `TTypedEntity` makes optional even when present —
 * NULL covers both cases and re-encodes as absent either way, which is correct.
 *
 * THE STORE CACHES WHAT THE READER ACCEPTS — it does not add a second, stricter
 * gate. So there is no UNIQUE index on the natural key and no
 * `CHECK (to_id <> from_id)`, both of which the pre-M6 sketch had: duplicate
 * identities and self-edges are CONFORMANCE findings, reported by
 * `codegraph validate`, and a store that refused to cache them would make
 * `import` fail on exactly the models `validate` exists to describe. This is
 * the same rule step 3 settled for the record stream: two gates on one format
 * drift, and the drift is invisible until a file one accepts and the other
 * refuses reaches a user.
 *
 * ── Trait sets are interned (MM-4) ────────────────────────────────────────
 *
 * The sketch had an `entity_trait(entity_id, trait_id)` join table. Measured on
 * the two real corpora:
 *
 *   | | commons-lang | fineract |
 *   | entities            | 15 338 | 241 101 |
 *   | DISTINCT trait sets |     15 |      18 |
 *
 * So that table would carry ~1.3M rows on fineract to say 18 different things.
 * `trait_set` interns the set and `entity` points at it, which is not merely
 * smaller: MM-4 states profile validity is a function of `(kind, trait set)`,
 * and core's validator already memoizes on exactly that key. The interned id IS
 * that key, so the storage mirrors the model's own idea rather than flattening
 * it. `trait_set_member` keeps `ord` so the ROUND TRIP is exact — the wire
 * writes an entity's traits in its own order, and interning the ordered
 * sequence costs nothing at 18 sets.
 *
 * ── Invariant 4, in a relational store ────────────────────────────────────
 *
 * The model data here is outgoing facts only. `edge_to` and `entity_parent` are
 * INDEXES over those facts — the database's version of "derived in memory by
 * the analyzer", not serialized inverse data. No TABLE may hold an inverse:
 * `schema.test.ts` reads `sqlite_master` and enforces that, because the
 * difference between an index and a table is exactly the difference between
 * deriving a fact and storing it twice.
 *
 * ── One thing the REFERENCES clauses do not do ────────────────────────────
 *
 * They are not enforced, and that is a decision rather than a default: SQLite's
 * own default for `PRAGMA foreign_keys` is OFF, and Node's SQLite builtin
 * overrides it to ON. Inheriting either would make the store's integrity model
 * depend on which library loaded it, so `STORE_OPEN_OPTIONS` states it.
 *
 * Off, because enforcement would COST correctness here, not buy it. Entity
 * records legitimately reference entities that sort later — `parent_id` and
 * `declared_type_id` point forward all the time — so immediate constraints
 * would reject a valid model unless the importer sorted its inserts around
 * them. And closure is already the record reader's guarantee: a model whose
 * references resolve to nothing does not get this far.
 *
 * The clauses still earn their place. They say what points at what, and
 * `PRAGMA foreign_key_check` audits a suspect cache against them whether or not
 * enforcement is on — which `PRAGMA foreign_keys = ON` would not do, since that
 * only governs new writes.
 */

import { WIRE_TRAITS, type TraitName } from "@codegraph/core";
import type { SqliteDatabase, SqliteOpenOptions } from "./sqlite.js";

/**
 * How the store opens a database — stated, never inherited. See the note on
 * REFERENCES above: the two libraries disagree about the default, and the
 * import path needs forward references to work.
 */
export const STORE_OPEN_OPTIONS: SqliteOpenOptions = { enableForeignKeyConstraints: false };

/**
 * Bumped whenever the DDL below changes in any way a reader could notice.
 * On mismatch the importer regenerates — there is no ALTER path, by design.
 */
export const DB_VERSION = 1;

/**
 * `meta` keys the importer writes. Values are TEXT; anything structured is
 * JSON, so `extractor` survives whole (it is a loose object in core and may
 * carry extractor-specific keys).
 *
 * The three `source*` keys are what a later step will decide staleness with —
 * size and mtime rather than a content hash, since hashing 127MB costs more
 * than the parse the cache exists to avoid. Reserved here; the POLICY is step
 * 8's, and is still open (PLAN.md §9.3).
 */
export const META_KEYS = [
  "dbVersion",
  "schemaVersion",
  "lang",
  "root",
  "extractor",
  "sourcePath",
  "sourceBytes",
  "sourceMtimeMs",
  "entities",
  "edges",
  "files",
] as const;
export type MetaKey = (typeof META_KEYS)[number];

/** Where one wire key lives: a table, and the column(s) that carry it. */
type KeyStorage = Record<string, { readonly table: string; readonly columns: readonly string[] }>;

/**
 * Where each key an entity record can carry is kept. This table is not
 * documentation — `schema.test.ts` checks it against `WIRE_TRAITS` key for key,
 * so adding a trait key to core fails the store until someone decides where it
 * lives. That is the "the DB schema is checked against core's tables" rule of
 * docs/model-encoding.md §3.3, made mechanical.
 */
export const ENTITY_KEY_STORAGE = {
  // Identity and classification (EntityRec's own keys, not trait-contributed).
  i: { table: "entity", columns: ["id"] },
  k: { table: "entity", columns: ["kind_id"] },
  tr: { table: "trait_set_member", columns: ["trait_id"] },
  m: { table: "entity", columns: ["module_id"] },
  s: { table: "entity", columns: ["symbol"] },
  d: { table: "entity", columns: ["disambiguator"] },
  space: { table: "entity", columns: ["space"] },

  // Trait-contributed keys.
  name: { table: "entity", columns: ["name"] },
  anchor: { table: "entity", columns: ["anchor_file_id", "anchor_start", "anchor_end"] },
  comments: { table: "entity_comment", columns: ["text"] },
  parent: { table: "entity", columns: ["parent_id"] },
  attachedTo: { table: "entity", columns: ["attached_to_id"] },
  definedIn: { table: "entity_defined_in", columns: ["file_id"] },
  isStub: { table: "entity", columns: ["is_stub"] },
  declaredType: { table: "entity", columns: ["declared_type_id"] },
  signature: { table: "entity", columns: ["signature"] },
  parameters: { table: "entity_parameter", columns: ["parameter_id"] },
  localVariables: { table: "entity_local_variable", columns: ["variable_id"] },
} as const satisfies KeyStorage;

/** The same, for edge records. */
export const EDGE_KEY_STORAGE = {
  k: { table: "edge", columns: ["kind_id"] },
  f: { table: "edge", columns: ["from_id"] },
  o: { table: "edge", columns: ["to_id"] },
  p: { table: "edge", columns: ["provenance_id"] },
  anchor: { table: "edge", columns: ["anchor_file_id", "anchor_start", "anchor_end"] },
  candidates: { table: "edge_candidate", columns: ["candidate_id"] },
  isRead: { table: "edge", columns: ["is_read"] },
  isWrite: { table: "edge", columns: ["is_write"] },
  sourceFile: { table: "edge", columns: ["source_file_id"] },
} as const satisfies KeyStorage;

/**
 * Every key `WIRE_TRAITS` contributes, flattened. The store must account for
 * each of them; `schema.test.ts` compares this against `ENTITY_KEY_STORAGE`.
 */
export function traitContributedKeys(): string[] {
  const keys = new Set<string>();
  for (const trait of Object.keys(WIRE_TRAITS) as TraitName[]) {
    for (const key of Object.keys(WIRE_TRAITS[trait].shape)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The DDL, verbatim and in one string so it runs as one statement batch. Its
 * exact text is snapshotted by `schema.test.ts` through `sqlite_master`, which
 * makes any change to this constant a reviewable diff rather than a surprise
 * at the next import.
 */
export const SCHEMA_SQL = `
-- ── Provenance of the cache itself ───────────────────────────────────────────
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- ── Interned vocabularies (MM-3). id = the header dictionary's own index ─────
CREATE TABLE kind       (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE trait      (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE edge_kind  (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE provenance (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

-- The one unbounded string set. id = the file record's own index.
CREATE TABLE file (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);

-- ── Trait sets, interned (MM-4) ──────────────────────────────────────────────
CREATE TABLE trait_set (id INTEGER PRIMARY KEY);
CREATE TABLE trait_set_member (
  trait_set_id INTEGER NOT NULL REFERENCES trait_set,
  ord          INTEGER NOT NULL,
  trait_id     INTEGER NOT NULL REFERENCES trait,
  PRIMARY KEY (trait_set_id, ord)
) WITHOUT ROWID;

-- ── Entities ─────────────────────────────────────────────────────────────────
CREATE TABLE entity (
  id               INTEGER PRIMARY KEY,
  kind_id          INTEGER NOT NULL REFERENCES kind,
  trait_set_id     INTEGER NOT NULL REFERENCES trait_set,
  module_id        INTEGER NOT NULL REFERENCES entity,
  symbol           TEXT    NOT NULL,
  disambiguator    TEXT,
  name             TEXT,
  signature        TEXT,
  parent_id        INTEGER REFERENCES entity,
  attached_to_id   INTEGER REFERENCES entity,
  declared_type_id INTEGER REFERENCES entity,
  is_stub          INTEGER,
  anchor_file_id   INTEGER REFERENCES file,
  anchor_start     INTEGER,
  anchor_end       INTEGER,
  space            TEXT,
  extra            TEXT
);

CREATE TABLE entity_comment (
  entity_id INTEGER NOT NULL REFERENCES entity,
  ord       INTEGER NOT NULL,
  text      TEXT    NOT NULL,
  PRIMARY KEY (entity_id, ord)
) WITHOUT ROWID;

CREATE TABLE entity_defined_in (
  entity_id INTEGER NOT NULL REFERENCES entity,
  ord       INTEGER NOT NULL,
  file_id   INTEGER NOT NULL REFERENCES file,
  PRIMARY KEY (entity_id, ord)
) WITHOUT ROWID;

CREATE TABLE entity_parameter (
  entity_id    INTEGER NOT NULL REFERENCES entity,
  ord          INTEGER NOT NULL,
  parameter_id INTEGER NOT NULL REFERENCES entity,
  PRIMARY KEY (entity_id, ord)
) WITHOUT ROWID;

CREATE TABLE entity_local_variable (
  entity_id   INTEGER NOT NULL REFERENCES entity,
  ord         INTEGER NOT NULL,
  variable_id INTEGER NOT NULL REFERENCES entity,
  PRIMARY KEY (entity_id, ord)
) WITHOUT ROWID;

-- ── Edges. Outgoing facts only (invariant 4) ─────────────────────────────────
CREATE TABLE edge (
  id             INTEGER PRIMARY KEY,
  kind_id        INTEGER NOT NULL REFERENCES edge_kind,
  from_id        INTEGER NOT NULL REFERENCES entity,
  to_id          INTEGER NOT NULL REFERENCES entity,
  provenance_id  INTEGER NOT NULL REFERENCES provenance,
  anchor_file_id INTEGER NOT NULL REFERENCES file,
  anchor_start   INTEGER NOT NULL,
  anchor_end     INTEGER NOT NULL,
  is_read        INTEGER,
  is_write       INTEGER,
  source_file_id INTEGER REFERENCES file,
  extra          TEXT
);

CREATE TABLE edge_candidate (
  edge_id      INTEGER NOT NULL REFERENCES edge,
  ord          INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL REFERENCES entity,
  PRIMARY KEY (edge_id, ord)
) WITHOUT ROWID;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Not unique: a repeated natural key is a conformance FINDING, not a read
-- error, and the store caches whatever the reader accepted.
CREATE INDEX entity_natural_key ON entity(module_id, symbol, disambiguator);
CREATE INDEX entity_parent      ON entity(parent_id);
CREATE INDEX entity_trait_set   ON entity(trait_set_id);
CREATE INDEX entity_anchor_file ON entity(anchor_file_id);
CREATE INDEX entity_kind        ON entity(kind_id);

CREATE INDEX edge_from ON edge(from_id, kind_id);
-- The derived inverse index, as an INDEX. Invariant 4 forbids storing the
-- inverse as data; it says nothing against the engine maintaining a lookup.
CREATE INDEX edge_to   ON edge(to_id, kind_id);
CREATE INDEX edge_provenance ON edge(provenance_id);

CREATE INDEX trait_set_member_by_trait ON trait_set_member(trait_id);
CREATE INDEX entity_parameter_target   ON entity_parameter(parameter_id);
CREATE INDEX entity_local_target       ON entity_local_variable(variable_id);
CREATE INDEX edge_candidate_target     ON edge_candidate(candidate_id);
`;

/** Create every table and index. The caller owns the transaction. */
export function createSchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
}
