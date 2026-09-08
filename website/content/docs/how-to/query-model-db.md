---
title: Query model.db from your own tool
linkTitle: Query model.db
weight: 12
---

`model.db` is the workbench: a SQLite cache of one `model.jsonl`, indexed so you
can ask your own questions without writing a program. This guide gets you to a
useful query and states the four rules a query must respect.

**Before you start:** a `model.jsonl` and anything that speaks SQLite.

## Get a store

```bash
codegraph import model.jsonl                  # writes model.db beside it
codegraph analyze model.jsonl --report deps   # builds it on demand, then reuses it
```

```bash
sqlite3 model.db
datasette model.db
duckdb -c "ATTACH 'model.db' AS cg (TYPE sqlite); SELECT count(*) FROM cg.entity;"
```

Nothing you do here can hurt anything: delete the file and the next command
rebuilds it. `--out FILE` puts the store somewhere else; `--no-cache` on an
analysis command reads the JSONL directly and never touches a store.

## Paste these two views first

Rows reference entities by integer surrogate and vocabularies by id. These two
temp views turn both into the ids and names you recognise, and every recipe below
assumes them.

```sql
CREATE TEMP VIEW node AS
SELECT e.id                                          AS ref,
       (SELECT value FROM meta WHERE key = 'lang') || ':' || m.symbol
         || CASE WHEN e.id = e.module_id THEN '' ELSE '/' || e.symbol END
         || CASE WHEN e.disambiguator IS NULL THEN '' ELSE '#' || e.disambiguator END
                                                     AS id,
       k.name                                        AS kind,
       e.name                                        AS name,
       -- `IS 1`, not `= 1`: a non-stubbable entity has NULL here, and `= 1`
       -- would make every comparison NULL and quietly drop every method.
       e.is_stub IS 1                                AS is_stub,
       e.module_id                                   AS module_ref,
       e.parent_id                                   AS parent_ref,
       e.trait_set_id                                AS trait_set_id
  FROM entity e
  JOIN entity m ON m.id = e.module_id
  JOIN kind   k ON k.id = e.kind_id;
```

```sql
CREATE TEMP VIEW dep AS
SELECT x.id            AS ref,
       x.from_id       AS from_ref,
       x.to_id         AS to_ref,
       ek.name         AS kind,
       p.name          AS provenance,
       f.path          AS file,
       x.anchor_start  AS line
  FROM edge x
  JOIN edge_kind  ek ON ek.id = x.kind_id
  JOIN provenance p  ON p.id  = x.provenance_id
  JOIN file       f  ON f.id  = x.anchor_file_id;
```

## The tables to start from

| Table | Holds |
|---|---|
| `entity` | one row per entity: `kind_id`, `trait_set_id`, `module_id`, `symbol`, `disambiguator`, `parent_id`, `declared_type_id`, `is_stub`, the anchor |
| `edge` | one row per edge, in the direction the model states: `from_id`, `to_id`, `kind_id`, `provenance_id`, the anchor |
| `kind`, `trait`, `edge_kind`, `provenance`, `file` | the interned vocabularies; ids are the header dictionary's own indices |
| `trait_set`, `trait_set_member` | trait sets, interned — an entity points at a set, not at a list of traits |
| `entity_metric` | one row per (entity, measure), the values the extractor measured |
| `meta` | `lang`, `dbVersion`, and the store's own bookkeeping |

## Four queries that pay for themselves

The corpus at a glance:

```sql
SELECT (SELECT value FROM meta WHERE key = 'lang')     AS lang,
       (SELECT count(*) FROM entity)                   AS entities,
       (SELECT count(*) FROM entity WHERE is_stub = 1) AS stubs,
       (SELECT count(*) FROM edge)                     AS edges,
       (SELECT count(*) FROM file)                     AS files;
```

| lang | entities | stubs | edges | files |
|---|---|---|---|---|
| java | 179 | 27 | 188 | 16 |

Fan-in — what everything depends on. `edge_to` is an *index* over the stored
outgoing facts, so this is a `GROUP BY` and it can never disagree with the
outgoing direction:

```sql
SELECT n.id, count(*) AS fan_in
  FROM dep d JOIN node n ON n.ref = d.to_ref
 GROUP BY d.to_ref
 ORDER BY fan_in DESC, n.id
 LIMIT 5;
```

| id | fan_in |
|---|---|
| `java:com.acme.order/Money` | 16 |
| `java:java.lang/String` | 16 |
| `java:com.acme.order/Order` | 7 |
| `java:com.acme.order/Priceable` | 7 |
| `java:com.megacorp.ledger/LedgerClient` | 7 |

How much of the graph is inference — worth running once on any corpus:

```sql
SELECT d.provenance, d.kind, count(*) AS n
  FROM dep d
 WHERE d.provenance <> 'declared'
 GROUP BY d.provenance, d.kind
 ORDER BY n DESC, d.provenance, d.kind;
```

| provenance | kind | n |
|---|---|---|
| derived | import | 3 |

Three derived imports out of 188 edges: on this corpus almost everything is a
fact the extractor read.

The most complex invocables:

```sql
SELECT n.id, max(CASE WHEN em.key = 'cyclomatic' THEN em.value END) AS cc
  FROM entity_metric em
  JOIN node n ON n.ref = em.entity_id
 GROUP BY em.entity_id
HAVING cc IS NOT NULL
 ORDER BY cc DESC, n.id
 LIMIT 5;
```

| id | cc |
|---|---|
| `java:com.acme.order/Reporting.max(java.util.List)` | 4 |
| `java:com.acme.order/StockGuard.ensure(int)` | 3 |
| `java:com.acme.order.legacy/List.length()` | 2 |

**Absent is not zero.** An entity with no row for a key was not measured — a
stub, or a kind the extractor does not measure. `sum()` over a missing key
returns NULL, and turning that into `0` would state a fact about code nobody
read.

## Four rules

**Sorting belongs to the model, never to the engine.** Codegraph orders ids by
UTF-16 code unit; SQLite's `BINARY` collation orders by UTF-8 byte. They agree
across the Basic Multilingual Plane and invert above it. If your query feeds
something that cares about order, sort it in your own code with the same
comparison, or `ORDER BY` the surrogate, which the importer wrote in canonical
order.

**Never store a surrogate.** `entity.id` is a position in one file. It is not
stable across runs, it means nothing in another model, and writing one into a
spreadsheet is how a number outlives its meaning. Identity is the natural key —
`(lang, module, symbol, disambiguator)`, with `lang` in `meta` and the rest on
`entity`.

**Provenance or it did not happen.** A count that mixes `declared` with `derived`
is not a measurement of the code, it is a measurement of the code plus the
extractor's guesses. Say which you meant.

**The store is a cache, not a source.** Nothing but the importer writes to it. If
you want a derived table, make it a `TEMP` one — the next `codegraph` run may
regenerate the file underneath you, and it will not ask.

## When to ask codegraph instead

Use the CLI when you need the fold exactly (the parent-chain walk and its view
semantics), ranked strongly connected components with the edges closing each
cycle, coupling tables that state their level and view, or anything you intend to
commit. A query result is a look; the `.jsonl` and the analyzer's exports are the
reproducible artefacts.

## Related

- [Querying the model with SQL](/docs/tutorials/sql/)
- [`model.db` reference](/docs/reference/model-db/)
- [`codegraph import`](/docs/reference/cli/import/)
- [Identity is a natural key](/docs/explanation/identity/)
