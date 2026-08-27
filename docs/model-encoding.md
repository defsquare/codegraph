# Model v2 — physical encodings (JSONL interchange + SQLite analysis store)

Status: **§2 (JSONL) shipped as M6; §3 (SQLite) planned as M7** (PLAN.md §9.2–9.3). Companion doc:
[`model-metamodel.md`](model-metamodel.md) — the format-independent
metamodel changes (structured identity MM-1, `children` removal MM-2,
referential vocabularies MM-3/MM-4). This doc assumes those and decides only
how bytes hit disk.

## 1. The problem being solved

Fineract: `model.json` is 559.5MB — over Node's string ceiling
(`0x1fffffe8` ≈ 512MB), so the analyzer cannot read it at all. Byte profile
(240,910 entities / 782,031 edges):

| Payload | Size |
|---|---|
| edge `from`/`to` id strings | 185.8MB |
| edge `anchor.file` paths | 90.3MB |
| entity `id` strings | 47.5MB |
| entity `parent` refs | 40.8MB |
| entity `anchor.file` paths | 26.8MB |
| `traits` arrays (a few dozen distinct sets) | 19.2MB |
| `children` arrays (inverse of `parent`) | 11.6MB |
| `kind` strings (12 distinct values) | 3.0MB |

≈ 76% is repeated strings with tiny value sets. And there are two distinct
performance problems hiding in "performance is crap":

1. **Transport/parse**: one monolithic JSON document → fixed by streaming +
   interning (JSONL, §2).
2. **Repeated analysis**: every CLI invocation re-parses and re-derives
   everything from scratch; the future viz needs random access, not a full
   load → fixed by a queryable store (SQLite, §3).

One format cannot be best at both. Proposal: **two artifacts, two roles.**

```
extractor ──(writes)──▶ model.jsonl        the CONTRACT: schema-validated,
                            │              diffable, language-agnostic
              codegraph import (once)
                            ▼
                        model.db           the WORKBENCH: SQLite, indexed,
                            │              incremental, random-access
        analyze / export / metrics / viz
```

`model.db` is a derived, disposable cache — regenerable from the `.jsonl` at
any time, never committed, never the interchange contract.

## 2. Interchange encoding: `model.jsonl`

One JSON record per line, record type in leading key `"t"`. Section order is
contractual (single-pass streaming): `header → files → entities → edges → eof`.

```jsonc
{"t":"header","schemaVersion":"1.0.0","lang":"java",
 "extractor":{"name":"codegraph-spoon","version":"0.2.0","noClasspath":true},
 "root":"/home/jeremie/fineract",
 // optional (M10a): where the analyzed root lives in a hosted repository.
 "repository":{"remote":"https://github.com/apache/fineract",
               "commit":"4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1",
               "root":"fineract-provider/src/main/java"},
 "dict":{
   "kinds":["package","class","interface","enum","record","annotation",
            "method","constructor","attribute","parameter","localVariable","lambda"],
   "traits":["TNamed","TSourceAnchor","TWithChildren","TChildOf","TType","..."],
   "edges":["import","inheritance","interfaceImplementation","invocation",
            "access","reference","embedding","traitUsage","fileInclude"],
   "provenance":["declared","derived","dynamic-candidate","generated"]}}
{"t":"f","i":0,"path":"custom/acme/.../AcmeNoopJobTaskletTest.java"}
{"t":"e","i":1102,"k":6,"tr":[0,5,9,12,14,17,20,3,1],"m":37,"s":"OrderService.bill",
 "d":"(com.acme.order.Order)","signature":"bill(com.acme.order.Order)",
 "declaredType":9241,"parent":1099,"anchor":[12,15,22]}   // [fileIdx, start, end]
{"t":"x","k":3,"f":1102,"o":8804,"p":0,"anchor":[12,19,19],"candidates":[8804]}
{"t":"x","k":4,"f":1102,"o":1101,"p":0,"anchor":[12,20,20],"isRead":false,"isWrite":true}
{"t":"eof","counts":{"files":4213,"entities":240910,"edges":782031}}
```

Rules:

- **Surrogate keys**: entities carry a dense `0..n-1` int `"i"`, assigned in
  canonical natural-key order (MM-5), hence deterministic. Every
  `EntityId`-typed field in v1 (`from`/`to` → `f`/`o`, `parent`,
  `declaredType`, `parameters`, `candidates`, …) becomes an int; the `TRAITS`
  table already knows which fields those are, so transform and validation are
  mechanical. **Surrogates are file-scoped and never stable across runs** —
  identity is MM-1's structured key, period.
- **Natural key on the wire**: `m` (int ref to module entity) + `s` + `d` —
  the MM-1 tuple; `lang` from the header. No rendered id string anywhere.
- **Interning**: bounded vocabularies as header dictionaries (indices are
  model-declared, so extending `core`'s vocabulary never renumbers old
  files); the one unbounded table — file paths (`f`) — as one record per
  line so no line grows with corpus size. Traits ride inline on each entity
  as an int array (`"tr"`) into `dict.traits`.
- **Considered and dropped: trait-*set* interning** (a `ts` record per
  distinct trait combination, entities referencing it). Inline int arrays
  already shrink the 19.2MB of trait strings to ~4–5MB; set indirection
  would save only ~4MB more on a ~90MB file, while adding a record type, a
  dedup pass to every extractor, and entity lines unreadable without a
  lookup. The validate-once-per-set win (MM-4) needs no wire support — the
  reader memoizes verdicts keyed on `(kind, sorted trait list)`.
- **Trailer `eof` record** carries counts: friendlier to pure streaming
  writers (Jackson never rewinds) and makes a truncated/killed run
  detectable — v1 couldn't detect truncation at all.
- Edges come after all entities; closure is checked streaming
  (`ref < entities count`).
- Validation: one Zod schema per record type discriminated on `t`;
  `parseModel` becomes streaming `readModel(path)` enforcing section order,
  closure, natural-key uniqueness, and eof counts; profile verdicts memoized
  per `(kind, sorted trait list)` (MM-4). `schemas/` publishes one
  JSON Schema per record type + a prose container contract (JSON Schema
  cannot express a JSONL container) — still sufficient for a non-TS
  extractor to self-validate line-by-line.

Estimated effect (Fineract): edges ~380MB → ~50MB, entities ~180MB → ~35MB,
tables ~1MB. **Total ≈ 85–95MB (~6×)**, gzip stacks ~5× on top, and no
whole-file string ever exists in either direction.

**Measured (M6): 559.5MB → 127.4MB (4.4×)** — 240 929 entities / 782 032 edges,
94 s to extract, 12 s for any CLI command. Short of the estimate, which assumed
a larger share of the bytes were id strings than actually were; commons-lang
came in at 2.5× (17.1MB → 6.9MB) for the same reason. The ratio was never the
point: v1's model could not be read at ALL — one JSON document is one JavaScript
string, and 559.5MB is past the ~512MB ceiling — and this one can.

### Why JSONL stays the contract (vs. extractors writing SQLite directly)

- "Extractors contain no metamodel intelligence" — emitting flat,
  schema-validated lines keeps the bar at "any language that can print JSON."
  Asking every future extractor (Go, .NET, …) to build a correctly indexed
  relational DB moves intelligence into extractors.
- Fixtures and extractor cross-validation (oracle/subset comparison) need
  line-diffable, canonically ordered text; binary DB files in git are a
  regression for both.
- Byte-level determinism is achievable for JSONL and essentially not for
  SQLite files (page allocation varies); determinism is a tested property.

## 3. Analysis store: `model.db` (SQLite)

Built once by `codegraph import model.jsonl` (or auto-built and cached by the
first `analyze`). All subsequent commands — and the future code city — read
the DB. This is where "better data manipulation" lives.

### 3.1 Schema

**Frozen and implemented** in `packages/analyzer/src/store/schema.ts`, which is
the authority; this section says *why* it looks the way it does. The DDL is
snapshotted through `sqlite_master` by `store-schema.test.ts`, so a change here
is a reviewable diff rather than a surprise at the next import.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- Interned vocabularies (MM-3). id = the header dictionary's own index.
CREATE TABLE kind       (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE trait      (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE edge_kind  (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE provenance (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE file       (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);

-- Trait sets, interned (MM-4). `ord` keeps the round trip exact.
CREATE TABLE trait_set (id INTEGER PRIMARY KEY);
CREATE TABLE trait_set_member (trait_set_id INTEGER NOT NULL REFERENCES trait_set,
                               ord INTEGER NOT NULL,
                               trait_id INTEGER NOT NULL REFERENCES trait,
                               PRIMARY KEY (trait_set_id, ord)) WITHOUT ROWID;

CREATE TABLE entity (
  id               INTEGER PRIMARY KEY,             -- the JSONL surrogate, verbatim
  kind_id          INTEGER NOT NULL REFERENCES kind,
  trait_set_id     INTEGER NOT NULL REFERENCES trait_set,
  module_id        INTEGER NOT NULL REFERENCES entity,   -- a module names ITSELF
  symbol           TEXT NOT NULL, disambiguator TEXT,    -- with lang, the natural key
  name TEXT, signature TEXT,
  parent_id INTEGER REFERENCES entity, attached_to_id INTEGER REFERENCES entity,
  declared_type_id INTEGER REFERENCES entity,
  is_stub INTEGER,
  anchor_file_id INTEGER REFERENCES file, anchor_start INTEGER, anchor_end INTEGER,
  space TEXT,                                       -- JSON array; no extractor emits it yet
  extra TEXT                                        -- JSON: keys core does not type
);

-- The array-valued keys, ordered so they re-encode exactly as written.
CREATE TABLE entity_comment       (entity_id, ord, text,         PRIMARY KEY (entity_id, ord)) WITHOUT ROWID;
CREATE TABLE entity_defined_in    (entity_id, ord, file_id,      PRIMARY KEY (entity_id, ord)) WITHOUT ROWID;
CREATE TABLE entity_parameter     (entity_id, ord, parameter_id, PRIMARY KEY (entity_id, ord)) WITHOUT ROWID;
CREATE TABLE entity_local_variable(entity_id, ord, variable_id,  PRIMARY KEY (entity_id, ord)) WITHOUT ROWID;

CREATE TABLE edge (
  id INTEGER PRIMARY KEY,                           -- position in the edge section
  kind_id INTEGER NOT NULL REFERENCES edge_kind,
  from_id INTEGER NOT NULL REFERENCES entity,
  to_id   INTEGER NOT NULL REFERENCES entity,
  provenance_id INTEGER NOT NULL REFERENCES provenance,
  anchor_file_id INTEGER NOT NULL REFERENCES file,
  anchor_start INTEGER NOT NULL, anchor_end INTEGER NOT NULL,
  is_read INTEGER, is_write INTEGER,                -- access edges only
  source_file_id INTEGER REFERENCES file,
  extra TEXT
);
CREATE TABLE edge_candidate (edge_id, ord, candidate_id, PRIMARY KEY (edge_id, ord)) WITHOUT ROWID;

CREATE INDEX entity_natural_key ON entity(module_id, symbol, disambiguator);  -- NOT unique
CREATE INDEX entity_parent ON entity(parent_id);    -- the derived children index
CREATE INDEX edge_from ON edge(from_id, kind_id);
CREATE INDEX edge_to   ON edge(to_id, kind_id);     -- the derived inverse index
-- plus entity_kind, entity_trait_set, entity_anchor_file, edge_provenance,
--      trait_set_member_by_trait, and one per reference-list target column.
```

**Ids are the model's own numbers.** `entity.id` is the JSONL surrogate and
every dictionary id is that vocabulary's header index, so importing is a copy
and hydrating is a lookup. Nothing is renumbered on the way in — and a bug that
renumbered the corpus would show up as a changed id rather than as a silently
repointed edge. Surrogates remain file-scoped and are never identity (MM-1).

**NULL means the key was absent**, which is lossless rather than lax: which keys
an entity carries is decided by its trait set, so `signature IS NULL` and "this
entity has no `TInvocable`" are the same statement. Re-encoding therefore puts
back exactly the keys that were there.

**Trait sets are interned, not joined.** An `entity_trait(entity_id, trait_id)`
table would carry roughly 1.3M rows on fineract to say 18 different things:

| | commons-lang | fineract |
|---|---|---|
| entities | 15 338 | 241 101 |
| **distinct trait sets** | **15** | **18** |

Size is the smaller half of the argument. MM-4 states that profile validity is a
function of `(kind, trait set)`, and core's validator already memoizes on
exactly that key — so the interned id *is* that key, and the storage mirrors the
model's own idea instead of flattening it.

**The store caches what the reader accepts.** No UNIQUE index on the natural key
and no `CHECK (to_id <> from_id)`, both of which an earlier sketch of this
section had. Duplicate identities and self-edges are *conformance findings* that
`codegraph validate` exists to report; a store that refused to cache them would
make `import` fail on precisely the models the report is about. This is the rule
the record stream already follows: two gates on one format drift, and the drift
stays invisible until a file one accepts and the other refuses reaches a user.

**Invariant 4, in a relational store.** The model data is outgoing facts only.
`edge_to` and `entity_parent` are INDEXES over those facts — the database's
version of "derived in memory by the analyzer", storing no fact the model did
not already state and unable to go stale against it. No table may hold an
inverse, and `store-schema.test.ts` reads `sqlite_master` to enforce that.

**The REFERENCES clauses are not enforced**, and that is stated rather than
inherited: SQLite's default for `PRAGMA foreign_keys` is OFF while Node's SQLite
builtin overrides it to ON, so the store sets it explicitly. Off, because entity
records legitimately reference entities that sort later (`parent`,
`declaredType`), so immediate constraints would reject valid models — and
closure is already the record reader's guarantee. The clauses still say what
points at what, and `PRAGMA foreign_key_check` audits an existing cache against
them regardless of the setting.

**Rare and unknown keys** ride in an `extra` JSON column (SQLite's `json_*`
functions reach into it) rather than in 20 sparse columns. Records are loose by
design, so an extractor-specific key must survive a round trip rather than be
silently stripped. Both corpora currently produce none.

**Nothing drifts silently from `core`.** `ENTITY_KEY_STORAGE` / `EDGE_KEY_STORAGE`
map every key the wire can carry to the column or table that holds it, and the
test checks that mapping against `WIRE_TRAITS` *and* against the live schema. So
adding a trait key to `core` fails the store until someone decides where it goes.

### 3.2 What this buys

- **Ad-hoc manipulation** — the user-facing win:
  ```sql
  -- fan-in top 20
  SELECT e.symbol, COUNT(*) n FROM edge x JOIN entity e ON e.id = x.to_id
  GROUP BY x.to_id ORDER BY n DESC LIMIT 20;
  -- facts-only view (invariant 2) is a WHERE clause
  ... WHERE x.provenance_id = (SELECT id FROM provenance WHERE name='declared');
  -- reachability / cycles via recursive CTEs
  WITH RECURSIVE reach(id) AS (VALUES(?) UNION SELECT to_id FROM edge JOIN reach ON from_id=reach.id) ...
  ```
  Plus the whole ecosystem: `sqlite3` CLI, Datasette, DBeaver, DuckDB attach.
- **Amortized cost**: import once, then every `analyze`/`export` run opens
  instantly and touches only what it queries. Measured on apache/fineract
  (241 101 entities / 782 046 edges), and the numbers matter more than the
  slogan:

  | | time | peak RSS |
  |---|---|---|
  | `importModel` (once) | 9.0 s | 289 MB |
  | read the whole model from `.jsonl` | 6.4 s | 701 MB |
  | hydrate the whole model from `.db` | 3.6 s | 592 MB |
  | **fan-in top 20, in SQL** | **0.04 s** | — |
  | **one module's entities** | **< 0.01 s** | — |

  **The win is not hydrating faster — it is not hydrating at all.** Full
  hydration beats the text reader by 1.8×, which is worth having and makes the
  fallback path honest, but it is the wrong number to design around: the same
  question answered in SQL costs 0.04s against 6.4s, because it never
  materializes a row it does not need. A DB-backed analyzer that begins by
  rebuilding the entire `Model` has bought a 1.8× constant; one that pushes the
  question down has bought two orders of magnitude. (Getting hydration from
  7.6s to 3.6s was itself a row-shape decision: `setReturnArrays(true)` on the
  bulk queries, since naming a column costs a property per row and there are a
  million of them.)
- **Viz-shaped access**: the 3D city can query level-of-detail slices
  (`WHERE module_id IN (...)`), stream neighborhoods on camera moves, and
  never hold 1M rows in JS objects. This was the weakest point of
  JSONL-only: the city would re-load and re-index the world on every launch.
- **Incremental re-extraction** (future): entities and edges are addressable
  by `file_id` — re-extract one changed file, `DELETE WHERE file_id = ?`,
  re-insert. Impossible with an append-only text format.
- **Cross-language later**: one DB per model; `ATTACH` several and join on
  natural keys for the import-graph intersection layer (invariant 9).
- **Runtime**: Node ≥ 22 ships `node:sqlite` (no native-dep build);
  `better-sqlite3` is the fallback if we hit its limits. Precedent: this is
  exactly the Sourcetrail/Understand/CodeQL shape — code index as embedded DB.

### 3.3 Costs, stated honestly

- A schema + import layer to build and migrate (`meta` carries a
  `dbVersion`; on mismatch, re-import from JSONL — migration = regeneration,
  no ALTER dance, because the DB is a cache).
- Two representations of the model in the codebase. Contained by rule:
  **`core` remains the single owner of vocabulary and validation; the DB
  schema is generated/checked against `core`'s tables, and nothing writes
  `model.db` except the importer.**
- Analyzer refactor: current in-memory graph/index code either becomes the
  import layer's consumer or is partially replaced by SQL queries. Proposal:
  keep the in-memory analyzer API, back it by the DB (load-on-demand),
  migrate metrics to SQL opportunistically — not a big-bang rewrite.

## 4. Migration & task list (encoding track)

Clean break **in place** — `schemaVersion` stays `"1.0.0"`: the format is
entirely internal for now, so there is no consumer to version against; the
contract changes under the same number and old files are regenerated. No
old-format reader. Fixture snapshots regenerate to `.jsonl`; `model.db` is
never committed. (First external consumer, whenever one exists, is the
moment versioning starts meaning something.)

- [x] `core`: record-type Zod schemas (`Header`, `FileRec`, `EntityRec`,
      `EdgeRec`, `Eof`); streaming `readModelRecordsSync`/`writeModelFile`;
      `gen:schemas` emits per-record JSON Schemas + container contract README.
- [x] `extractors/java`: Jackson streaming JSONL writer (removes its former
      whole-document buffering); canonical sort before surrogate assignment.
- [x] Property suite: reformulated over surrogates + natural keys; truncation
      detection (eof counts) and line-level schema conformance.
- [x] `analyzer`: `importModel(jsonlPath) → model.db` (single transaction,
      prepared statements) and its exact inverse `readStoreRecords`; the fold,
      the import layer and every diagnostic answered in SQL behind the existing
      API, with `foldFromStore` REFUSING any view it cannot translate rather
      than approximating it.
- [x] `cli`: `codegraph import`; `analyze`/`export` auto-build and reuse a
      sibling `model.db`, with `--no-cache`.
- [x] Regenerate fixtures; delete v1 path.

Everything above is measured in PLAN.md §9.3, which carries the definition of
done and the numbers behind it. `docs/sql-cookbook.md` is the user-facing half:
how to query the store yourself, and the four rules a query must respect.

## 5. Open questions

1. ~~Confirm the two-artifact split (JSONL contract + SQLite cache) vs.
   SQLite-only.~~ — **settled by building it**: the split held up. The
   `.jsonl` stayed the thing fixtures diff, property tests run against and
   extractors must conform to; the `.db` is regenerated on demand and
   gitignored. Nothing in M7 needed the store to be authoritative, and the
   round trip through it is a test precisely because it is not.
2. ~~`node:sqlite` vs `better-sqlite3`~~ — **settled**: the builtin, loaded at
   one site (`analyzer/src/store/sqlite.ts`) behind an interface written from
   the store's needs, so a fallback is a matter of satisfying one type at one
   place. Node 22.5+ has everything the store uses, `iterate()` included.
3. ~~Does `codegraph analyze foo.jsonl` auto-build `foo.db` next to it?~~ —
   **settled**: yes, with `--no-cache`. Staleness is size and mtime rather
   than a content hash, because hashing 133 MB costs more than the parse the
   cache exists to avoid; a `dbVersion` mismatch, a corrupt file or an
   unwritable directory all mean "read the `.jsonl`", never "fail".
4. `.jsonl.gz` support in `readModel` — cheap follow-up, not part of M6.
