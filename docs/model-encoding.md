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

### 3.1 Schema sketch

```sql
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT);        -- schemaVersion, lang, extractor, root
CREATE TABLE kind      (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE trait     (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE provenance(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE edge_kind (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE file      (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL);

CREATE TABLE entity (
  id            INTEGER PRIMARY KEY,             -- the JSONL surrogate, imported verbatim
  kind_id       INTEGER NOT NULL REFERENCES kind,
  module_id     INTEGER REFERENCES entity,       -- natural key (MM-1); NULL for root modules
  symbol        TEXT    NOT NULL,
  disambiguator TEXT,
  name          TEXT, signature TEXT,
  parent_id     INTEGER REFERENCES entity,
  declared_type_id INTEGER REFERENCES entity,
  is_stub       INTEGER NOT NULL DEFAULT 0,
  file_id       INTEGER REFERENCES file,
  span_start    INTEGER, span_end INTEGER,
  extra         TEXT                              -- JSON: rare trait keys (parameters, localVariables, …)
);
CREATE UNIQUE INDEX entity_natural_key ON entity(module_id, symbol, ifnull(disambiguator,''));
CREATE TABLE entity_trait(entity_id INTEGER NOT NULL REFERENCES entity,
                          trait_id  INTEGER NOT NULL REFERENCES trait,
                          PRIMARY KEY (entity_id, trait_id)) WITHOUT ROWID;
CREATE INDEX entity_trait_by_trait ON entity_trait(trait_id);  -- "all TInvocable entities"

CREATE TABLE edge (
  id INTEGER PRIMARY KEY,
  kind_id       INTEGER NOT NULL REFERENCES edge_kind,
  from_id       INTEGER NOT NULL REFERENCES entity,
  to_id         INTEGER NOT NULL REFERENCES entity CHECK (to_id <> from_id),
  provenance_id INTEGER NOT NULL REFERENCES provenance,
  file_id       INTEGER REFERENCES file, span_start INTEGER, span_end INTEGER,
  is_read INTEGER, is_write INTEGER,              -- access edges only
  source_file_id INTEGER REFERENCES file
);
CREATE TABLE edge_candidate(edge_id INTEGER NOT NULL REFERENCES edge,
                            entity_id INTEGER NOT NULL REFERENCES entity,
                            PRIMARY KEY (edge_id, entity_id)) WITHOUT ROWID;

CREATE INDEX edge_from ON edge(from_id, kind_id);
CREATE INDEX edge_to   ON edge(to_id,   kind_id);   -- the derived inverse index, as a DB index
CREATE INDEX entity_parent ON entity(parent_id);    -- derived children index
CREATE INDEX entity_file   ON entity(file_id);
```

Invariant-4 note: the *model data* still contains outgoing facts only;
`edge_to` / `entity_parent` are storage-level indexes over those facts —
the DB equivalent of "derived in memory by the analyzer," not serialized
inverse data. Rare trait keys ride in an `extra` JSON column (SQLite's
`json_*` functions reach into it) rather than 20 sparse columns.

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
- **Amortized cost**: import once (~seconds for 90MB JSONL), then every
  `analyze`/`export` run opens instantly and touches only what it queries —
  instead of re-parsing 559MB (or even 90MB) per invocation.
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

- [ ] `core`: record-type Zod schemas (`Header`, `FileRec`, `EntityRec`,
      `EdgeRec`, `Eof`); streaming `readModel`/`writeModel`;
      `gen:schemas` emits per-record JSON Schemas + container contract README.
- [ ] `extractors/java`: Jackson streaming JSONL writer (removes its current
      whole-document buffering); canonical sort before surrogate assignment.
- [ ] Property suite: reformulated over surrogates + natural keys; add
      truncation detection (eof counts) and line-level schema conformance.
- [ ] `analyzer`: `importModel(jsonlPath) → model.db` (single transaction,
      prepared statements); DB-backed graph facade behind the existing API.
- [ ] `cli`: `codegraph import`; `analyze`/`export`/PlantUML read `model.db`,
      auto-importing when given a `.jsonl`.
- [ ] Regenerate fixtures; delete v1 path.

## 5. Open questions

1. Confirm the two-artifact split (JSONL contract + SQLite cache) vs.
   SQLite-only. SQLite-only is defensible but sacrifices diffable fixtures,
   byte-determinism as a tested property, and the any-language extractor bar.
2. `node:sqlite` vs `better-sqlite3` — decide at implementation time on
   Node 22's actual API surface.
3. Does `codegraph analyze foo.jsonl` auto-build `foo.db` next to it
   (recommended: yes, with a `--no-cache` escape hatch)?
4. `.jsonl.gz` support in `readModel` — cheap follow-up, not part of M6.
