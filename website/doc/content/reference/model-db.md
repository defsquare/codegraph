---
title: model.db
linkTitle: model.db
weight: 6
---

The SQLite analysis store: a **derived, disposable cache**, never the contract. Built by [`import`](/reference/cli/import/), or auto-built beside a `model.jsonl` on first use and reused afterwards; `--no-cache` bypasses it. Deleting it loses nothing.

The DDL below is `SCHEMA_TABLES_SQL` and `SCHEMA_INDEXES_SQL` in `packages/analyzer/src/store/schema.ts`, which is the authority; its exact text is snapshotted through `sqlite_master` by the store's schema test.

## Provenance of the cache

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

Rows written by the importer:

| `key` | Value |
|---|---|
| `dbVersion` | the store format's own version (`4` today) |
| `schemaVersion` | the header's interchange contract version |
| `lang` | the header's `lang` |
| `root` | the header's `root` |
| `extractor` | the header's `extractor` object, as JSON |
| `repository` | the header's `repository` object, as JSON — no row rather than a `null` row, so absence reads as absence |
| `sourcePath` | the `model.jsonl` this store was built from |
| `sourceBytes`, `sourceMtimeMs` | how the cache decides it is stale |
| `files`, `entities`, `edges` | the `eof` counts |

## Interned vocabularies

`id` is the header dictionary's own index.

```sql
CREATE TABLE kind       (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE trait      (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE edge_kind  (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE provenance (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

-- The one unbounded string set. id = the file record's own index.
CREATE TABLE file (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
```

## Trait sets

Interned rather than joined: an `entity_trait` table would carry roughly 1.3M rows on Fineract to say 18 different things (commons-lang: 15 338 entities, 15 distinct trait sets; Fineract: 241 101 entities, 18). `ord` keeps the round trip exact.

```sql
CREATE TABLE trait_set (id INTEGER PRIMARY KEY);
CREATE TABLE trait_set_member (
  trait_set_id INTEGER NOT NULL REFERENCES trait_set,
  ord          INTEGER NOT NULL,
  trait_id     INTEGER NOT NULL REFERENCES trait,
  PRIMARY KEY (trait_set_id, ord)
) WITHOUT ROWID;
```

Profile validity is a function of `(kind, trait set)`, and core's validator memoizes on exactly that key — so the interned id *is* that key.

## Entities

```sql
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
  value            TEXT,   -- JSON Literal, surrogates inside
  extra            TEXT
);
```

`entity.id` is the JSONL surrogate, verbatim. `module_id` points at the entity that *is* the module — a module names itself — so `(lang, symbol, disambiguator)` plus that row is the natural key. `space` is a JSON array; no extractor emits it yet.

The array-valued keys, ordered so they re-encode exactly as written:

```sql
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
```

The one map-valued key is rows, not a blob — the store exists to be queried and a measure is what one aggregates. There is no `ord`: a map has no ordinal, and the wire writes the map key-sorted, so `ORDER BY key` restores it.

```sql
CREATE TABLE entity_metric (
  entity_id INTEGER NOT NULL REFERENCES entity,
  key       TEXT    NOT NULL,
  value     REAL    NOT NULL,
  PRIMARY KEY (entity_id, key)
) WITHOUT ROWID;
```

A `Literal` is a tree and nothing queries inside one, so it stays a single JSON value on `entity.value` (and on `edge.arguments`). The ids inside it are the wire's own surrogates, so the blob round-trips byte for byte.

## Edges

Outgoing facts only.

```sql
CREATE TABLE edge (
  id             INTEGER PRIMARY KEY,
  kind_id        INTEGER NOT NULL REFERENCES edge_kind,
  from_id        INTEGER NOT NULL REFERENCES entity,
  to_id          INTEGER NOT NULL REFERENCES entity,
  provenance_id  INTEGER NOT NULL REFERENCES provenance,
  anchor_file_id INTEGER NOT NULL REFERENCES file,
  anchor_start   INTEGER NOT NULL,
  anchor_end     INTEGER NOT NULL,
  arguments      TEXT,    -- JSON NamedArgument[] (annotationUse)
  is_read        INTEGER,
  is_write       INTEGER,
  source_file_id INTEGER REFERENCES file,
  candidate_count INTEGER,
  extra          TEXT
);

CREATE TABLE edge_candidate (
  edge_id      INTEGER NOT NULL REFERENCES edge,
  ord          INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL REFERENCES entity,
  PRIMARY KEY (edge_id, ord)
) WITHOUT ROWID;
```

`edge.id` is the record's position in the edge section. `candidate_count` is `NULL` when the key was absent and `N` when it was present with `N` rows in `edge_candidate`: unlike the entity lists, `candidates` is contributed by no trait, so nothing else could tell an empty array from an absent one.

## The time axis

Empty on a plain single-model cache; filled by [`import --at`](/reference/cli/import/) and [`snapshots`](/reference/cli/snapshots/). Snapshots are keyed by the **natural key**, never by surrogates: surrogates are file-scoped and two revisions number their entities independently. Names (`kind`, `provenance`) are stored as TEXT for the same reason — dictionary ids are the header's own indices and are not stable across revisions. Lifespans (appeared/disappeared) are derived at query time, never stored.

```sql
CREATE TABLE revision (
  id   INTEGER PRIMARY KEY,      -- import order; queries order by (time, id)
  sha  TEXT    NOT NULL UNIQUE,  -- SCM-native identity, never abbreviated
  time INTEGER                   -- commit time, unix seconds; NULL = not given
);

CREATE TABLE entity_key (
  id            INTEGER PRIMARY KEY,
  module        TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  disambiguator TEXT NOT NULL,
  UNIQUE (module, symbol, disambiguator)
);

CREATE TABLE entity_version (
  revision_id INTEGER NOT NULL REFERENCES revision,
  key_id      INTEGER NOT NULL REFERENCES entity_key,
  kind        TEXT    NOT NULL,
  is_stub     INTEGER NOT NULL,
  loc         INTEGER,           -- anchor span lines; NULL = unanchored
  file        TEXT,              -- anchor path; NULL = unanchored
  PRIMARY KEY (revision_id, key_id)
) WITHOUT ROWID;

CREATE TABLE edge_version (
  revision_id INTEGER NOT NULL REFERENCES revision,
  from_key    INTEGER NOT NULL REFERENCES entity_key,
  to_key      INTEGER NOT NULL REFERENCES entity_key,
  kind        TEXT    NOT NULL,
  provenance  TEXT    NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (revision_id, from_key, to_key, kind, provenance)
) WITHOUT ROWID;
```

`entity_key.disambiguator` uses `''` for "none": a `NULL` would defeat the `UNIQUE` (SQL NULLs are pairwise distinct), and `''` cannot collide because the component is never empty. `edge_version` aggregates `(from, to, kind, provenance)` with a count and drops anchors on purpose — the flat tables keep the latest snapshot's evidence; the time axis asks *whether* a dependency held, not where it stood.

The flat tables mirror the latest import; the revision tables accumulate.

## Indexes

The importer creates them after its inserts.

```sql
CREATE INDEX entity_natural_key ON entity(module_id, symbol, disambiguator);
CREATE INDEX entity_parent      ON entity(parent_id);
CREATE INDEX entity_trait_set   ON entity(trait_set_id);
CREATE INDEX entity_anchor_file ON entity(anchor_file_id);
CREATE INDEX entity_kind        ON entity(kind_id);

CREATE INDEX edge_from ON edge(from_id, kind_id);
CREATE INDEX edge_to   ON edge(to_id, kind_id);
CREATE INDEX edge_provenance ON edge(provenance_id);

CREATE INDEX trait_set_member_by_trait ON trait_set_member(trait_id);
CREATE INDEX entity_parameter_target   ON entity_parameter(parameter_id);
CREATE INDEX entity_local_target       ON entity_local_variable(variable_id);
CREATE INDEX edge_candidate_target     ON edge_candidate(candidate_id);
CREATE INDEX entity_metric_key         ON entity_metric(key);

CREATE INDEX entity_version_key ON entity_version(key_id, revision_id);
CREATE INDEX edge_version_keys  ON edge_version(from_key, to_key);
```

## Four rules for reading it

**Ids are the model's own numbers.** `entity.id` is the JSONL surrogate and every dictionary id is that vocabulary's header index, so importing is a copy and hydrating is a lookup. Nothing is renumbered on the way in. Surrogates remain file-scoped and are never identity.

**`NULL` means the key was absent**, which is lossless rather than lax: which keys an entity carries is decided by its trait set, so `signature IS NULL` and "this entity has no `TInvocable`" are the same statement.

**The store caches what the reader accepts.** There is no `UNIQUE` index on the natural key and no `CHECK (to_id <> from_id)`. Duplicate identities and self-edges are *conformance findings* that [`validate`](/reference/cli/validate/) exists to report; a store that refused to cache them would make `import` fail on precisely the models the report is about.

**No table holds an inverse.** `edge_to` and `entity_parent` are INDEXES over outgoing facts — the database's version of "derived in memory by the analyzer" — storing no fact the model did not already state.

The `REFERENCES` clauses are **not enforced**: SQLite's default for `PRAGMA foreign_keys` is OFF while Node's SQLite builtin overrides it to ON, so the store sets it explicitly. Off, because entity records legitimately reference entities that sort later (`parent`, `declaredType`), and closure is already the record reader's guarantee. The clauses still say what points at what, and `PRAGMA foreign_key_check` audits an existing cache against them regardless.

Rare and unknown keys ride in an `extra` JSON column rather than in sparse columns; records are loose by design, so an extractor-specific key survives a round trip.
