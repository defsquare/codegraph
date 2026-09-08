---
title: Querying the model with SQL
linkTitle: SQL
weight: 6
---

**What you will build.** A SQLite store of the gson model, two views that turn
its surrogates into ids you recognise, and four queries that answer questions no
built-in report answers — including one the recursive-CTE machinery makes almost
trivial.

**What you need.** The `gson.jsonl` from
[Your first code city](/docs/tutorials/first-city/) — gson at tag
**`gson-parent-2.14.0`** — plus Node 22 or newer, which you already installed to
run codegraph.

**How long.** About 20 minutes.

## 1. Build the store

```bash
cd ~/codegraph-tutorial
codegraph import gson.jsonl
```

```text
gson.jsonl: 0.24 s, 1.7 MB jsonl -> 2.2 MB db
imported gson.jsonl -> gson.db
  3594 entities (175 stubs), 8997 edges, 85 files, lang java

OK — the store is ready. Run `codegraph analyze` against the model as usual.
```

`model.db` is a **workbench**, not a contract. The `.jsonl` beside it is the
artefact — schema-validated, diffable, language-agnostic — and the database is a
derived, disposable cache of it that exists so you can ask your own questions
without writing a program. Delete it and the next command rebuilds it.

You may already have `gson.db`: `analyze`, `navigator` and `city` build it on
first use and reuse it afterwards.

## 2. Get a SQL client

If you have `sqlite3`, `datasette` or `duckdb`, point it at `gson.db` and skip to
step 3. If you do not, Node 22 ships a SQLite driver, so twelve lines get you a
runner with no new dependency. Save this as `cgsql.mjs`:

```js
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const [dbPath, ...sqlFiles] = process.argv.slice(2);
const store = new DatabaseSync(dbPath, { readOnly: true });
for (const file of sqlFiles) {
  const statements = readFileSync(file, "utf8").split(/;\s*\n/).map((s) => s.trim());
  for (const sql of statements.filter(Boolean)) {
    const rows = store.prepare(sql).all();
    if (rows.length > 0) console.table(rows);
  }
}
```

It opens the store read-only, runs each `.sql` file you name in order, and prints
whatever comes back. Nothing you do from here can hurt anything.

## 3. Paste the two views first

Ids in the store are integers — the surrogates the `.jsonl` used, so nothing was
renumbered on the way in. Two views turn them into the ids you recognise and the
names you can read. Save this as `views.sql`:

```sql
CREATE TEMP VIEW node AS
SELECT e.id AS ref,
       (SELECT value FROM meta WHERE key = 'lang') || ':' || m.symbol
         || CASE WHEN e.id = e.module_id THEN '' ELSE '/' || e.symbol END
         || CASE WHEN e.disambiguator IS NULL THEN '' ELSE '#' || e.disambiguator END AS id,
       k.name AS kind, e.name AS name, e.is_stub IS 1 AS is_stub,
       e.module_id AS module_ref, e.parent_id AS parent_ref, e.trait_set_id AS trait_set_id
  FROM entity e JOIN entity m ON m.id = e.module_id JOIN kind k ON k.id = e.kind_id;

CREATE TEMP VIEW dep AS
SELECT x.id AS ref, x.from_id AS from_ref, x.to_id AS to_ref,
       ek.name AS kind, p.name AS provenance, f.path AS file, x.anchor_start AS line
  FROM edge x JOIN edge_kind ek ON ek.id = x.kind_id
       JOIN provenance p ON p.id = x.provenance_id
       JOIN file f ON f.id = x.anchor_file_id;
```

Two details in there are worth the pause.

`is_stub IS 1`, not `= 1`. An entity that cannot be a stub has `NULL` in that
column, and `= 1` would make every comparison `NULL` and quietly drop every
method from your results.

`node.id` reproduces codegraph's own rendered id exactly. That rendering is a
*display projection* of the natural key `(lang, module, symbol, disambiguator)`
— codegraph never parses it back, and neither should you.

Every query below assumes these views. Pass `views.sql` first each time.

## 4. Orient yourself

`corpus.sql`:

```sql
SELECT (SELECT value FROM meta WHERE key = 'lang')     AS lang,
       (SELECT count(*) FROM entity)                   AS entities,
       (SELECT count(*) FROM entity WHERE is_stub = 1) AS stubs,
       (SELECT count(*) FROM edge)                     AS edges,
       (SELECT count(*) FROM file)                     AS files;
```

```bash
node --no-warnings cgsql.mjs gson.db views.sql corpus.sql
```

```text
┌─────────┬────────┬──────────┬───────┬───────┬───────┐
│ (index) │ lang   │ entities │ stubs │ edges │ files │
├─────────┼────────┼──────────┼───────┼───────┼───────┤
│ 0       │ 'java' │ 3594     │ 175   │ 8997  │ 85    │
└─────────┴────────┴──────────┴───────┴───────┴───────┘
```

The same numbers `validate` printed. Good — the store is a faithful cache.

{{< callout type="info" >}}
`--no-warnings` only silences Node's notice that its SQLite driver is
experimental. Drop it and you get one extra line on stderr.
{{< /callout >}}

## 5. Ask what everything depends on

`fanin.sql` — most depended-upon types, corpus-to-corpus only:

```sql
SELECT n.id, count(*) AS fan_in
  FROM dep d
  JOIN node n ON n.ref = d.to_ref
  JOIN node f ON f.ref = d.from_ref
 WHERE n.is_stub = 0 AND f.is_stub = 0
 GROUP BY d.to_ref
 ORDER BY fan_in DESC, n.id
 LIMIT 10;
```

```text
┌─────────┬────────────────────────────────────────────────────┬────────┐
│ (index) │ id                                                 │ fan_in │
├─────────┼────────────────────────────────────────────────────┼────────┤
│ 0       │ 'java:com.google.gson/TypeAdapter'                 │ 241    │
│ 1       │ 'java:com.google.gson'                             │ 124    │
│ 2       │ 'java:com.google.gson/TypeAdapterFactory'          │ 112    │
│ 3       │ 'java:com.google.gson.stream/JsonWriter'           │ 97     │
│ 4       │ 'java:com.google.gson.stream/JsonReader'           │ 93     │
│ 5       │ 'java:com.google.gson/JsonElement'                 │ 84     │
│ 6       │ 'java:com.google.gson.stream'                      │ 78     │
│ 7       │ 'java:com.google.gson.stream/JsonReader.pos'       │ 68     │
│ 8       │ 'java:com.google.gson.internal/LinkedTreeMap.Node' │ 59     │
│ 9       │ 'java:com.google.gson.reflect/TypeToken'           │ 53     │
└─────────┴────────────────────────────────────────────────────┴────────┘
```

`TypeAdapter` is gson's centre of gravity, which is what the
[navigator](/docs/tutorials/navigator/) showed one row at a time.

Both stub filters are deliberate. Drop them and `java.lang/String` and
`java.lang/Object` come first — because **an import of an external type is a
real dependency**, and dropping it silently understates coupling. Filter stubs
on purpose, never by accident.

## 6. Separate the facts from the inferences

This is the query worth running once on any corpus you inherit, because it tells
you how much of your dependency graph is inference rather than fact.
`provenance.sql`:

```sql
SELECT d.provenance, d.kind, count(*) AS n
  FROM dep d
 GROUP BY d.provenance, d.kind
 ORDER BY n DESC, d.provenance, d.kind;
```

```text
┌─────────┬─────────────────────┬───────────────────────────┬──────┐
│ (index) │ provenance          │ kind                      │ n    │
├─────────┼─────────────────────┼───────────────────────────┼──────┤
│ 0       │ 'declared'          │ 'reference'               │ 2998 │
│ 1       │ 'declared'          │ 'invocation'              │ 2240 │
│ 2       │ 'declared'          │ 'access'                  │ 1756 │
│ 3       │ 'declared'          │ 'import'                  │ 666  │
│ 4       │ 'declared'          │ 'annotationUse'           │ 591  │
│ 5       │ 'dynamic-candidate' │ 'invocation'              │ 431  │
│ 6       │ 'declared'          │ 'throws'                  │ 235  │
│ 7       │ 'declared'          │ 'inheritance'             │ 40   │
│ 8       │ 'declared'          │ 'interfaceImplementation' │ 28   │
│ 9       │ 'derived'           │ 'import'                  │ 12   │
└─────────┴─────────────────────┴───────────────────────────┴──────┘
```

443 of 8997 edges are not facts. Add `WHERE d.provenance = 'declared'` to any
query above and you have the facts-only view — the same thing the CLI's
`--declared-only` switch gives you.

Where do the inferences land? `inferred.sql`:

```sql
SELECT n.id AS target, d.provenance, d.kind, count(*) AS n
  FROM dep d JOIN node n ON n.ref = d.to_ref
 WHERE d.provenance <> 'declared'
 GROUP BY d.to_ref, d.provenance, d.kind
 ORDER BY n DESC, target
 LIMIT 5;
```

```text
┌─────────┬──────────────────────────────────────────────────────────────────────────────────────────────┬─────────────────────┬──────────────┬────┐
│ (index) │ target                                                                                       │ provenance          │ kind         │ n  │
├─────────┼──────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼──────────────┼────┤
│ 0       │ 'java:com.google.gson.stream/JsonReader.peek()'                                              │ 'dynamic-candidate' │ 'invocation' │ 51 │
│ 1       │ 'java:com.google.gson.stream/JsonReader.nextNull()'                                          │ 'dynamic-candidate' │ 'invocation' │ 34 │
│ 2       │ 'java:com.google.gson/TypeAdapter.read(com.google.gson.stream.JsonReader)'                   │ 'dynamic-candidate' │ 'invocation' │ 29 │
│ 3       │ 'java:com.google.gson/TypeAdapter.write(com.google.gson.stream.JsonWriter,java.lang.Object)' │ 'dynamic-candidate' │ 'invocation' │ 28 │
│ 4       │ 'java:com.google.gson.stream/JsonWriter.nullValue()'                                         │ 'dynamic-candidate' │ 'invocation' │ 26 │
└─────────┴──────────────────────────────────────────────────────────────────────────────────────────────┴─────────────────────┴──────────────┴────┘
```

Every one is a virtual call whose target codegraph could not narrow to a single
method. That is the honest shape of a call graph through an abstract API, and it
is labelled rather than smoothed over.

## 7. Ask a question no report answers

Reachability. This is what a graph in a database is for. `reach.sql` — every
module reachable from `com.google.gson.internal.sql`, at any depth:

```sql
WITH RECURSIVE
  mod_edge(a, b) AS (
    SELECT DISTINCT ef.module_ref, et.module_ref
      FROM dep d
      JOIN node ef ON ef.ref = d.from_ref
      JOIN node et ON et.ref = d.to_ref
     WHERE ef.module_ref <> et.module_ref),
  reach(ref) AS (
    SELECT ref FROM node WHERE id = 'java:com.google.gson.internal.sql'
    UNION
    SELECT e.b FROM mod_edge e JOIN reach r ON e.a = r.ref)
SELECT n.id AS reachable_module, n.is_stub AS external
  FROM reach JOIN node n ON n.ref = reach.ref
 ORDER BY n.id;
```

```text
┌─────────┬───────────────────────────────────────────┬──────────┐
│ (index) │ reachable_module                          │ external │
├─────────┼───────────────────────────────────────────┼──────────┤
│ 0       │ 'java:<unnamed>'                          │ 1        │
│ 1       │ 'java:com.google.errorprone.annotations'  │ 1        │
│ 2       │ 'java:com.google.gson'                    │ 0        │
│ 3       │ 'java:com.google.gson.annotations'        │ 0        │
│ 4       │ 'java:com.google.gson.internal'           │ 0        │
│ 5       │ 'java:com.google.gson.internal.bind'      │ 0        │
│ 6       │ 'java:com.google.gson.internal.bind.util' │ 0        │
│ 7       │ 'java:com.google.gson.internal.reflect'   │ 0        │
│ 8       │ 'java:com.google.gson.internal.sql'       │ 0        │
│ 9       │ 'java:com.google.gson.reflect'            │ 0        │
│ 10      │ 'java:com.google.gson.stream'             │ 0        │
│ 11      │ 'java:java.io'                            │ 1        │
│ 12      │ 'java:java.lang'                          │ 1        │
│ 13      │ 'java:java.lang.annotation'               │ 1        │
│ 14      │ 'java:java.lang.reflect'                  │ 1        │
│ 15      │ 'java:java.math'                          │ 1        │
│ 16      │ 'java:java.net'                           │ 1        │
│ 17      │ 'java:java.sql'                           │ 1        │
│ 18      │ 'java:java.text'                          │ 1        │
│ 19      │ 'java:java.time'                          │ 1        │
│ 20      │ 'java:java.util'                          │ 1        │
│ 21      │ 'java:java.util.concurrent'               │ 1        │
│ 22      │ 'java:java.util.concurrent.atomic'        │ 1        │
│ 23      │ 'java:java.util.regex'                    │ 1        │
└─────────┴───────────────────────────────────────────┴──────────┘
```

A small optional package pulls in every other gson package and thirteen JDK
ones. Note that it reaches *itself* — that is the eight-module cycle the
[city's Tangles toggle](/docs/tutorials/reading-the-city/) drew in red.

`UNION`, never `UNION ALL`: the second deduplicates, and that is what makes the
query terminate on a cyclic graph, which real corpora are.

## 8. Four rules to leave with

**Sorting belongs to the model, never to the engine.** Codegraph orders ids by
UTF-16 code unit; SQLite orders by UTF-8 byte. They agree across the Basic
Multilingual Plane and *invert* above it. If your query feeds something that
cares about order, sort it yourself, or `ORDER BY` the surrogate.

**Never store a surrogate.** It is a position in one file. It is not stable
across runs and it means nothing in another model.

**Provenance or it did not happen.** A count that mixes `declared` with
`derived` measures the code plus the extractor's guesses. Say which you meant.

**The store is a cache, not a source.** Nothing but the importer writes to it.
Make derived tables `TEMP` — the next `codegraph` run may regenerate the file
underneath you, and it will not ask.

Ask `codegraph` instead of SQL when you need the fold exactly, ranked strongly
connected components with the edges closing each cycle, coupling tables that
state their level and view, or anything you intend to commit. A query result is
a look; the `.jsonl` and the analyzer's exports are the record.

## What you have now

- `gson.db` — the whole model in a file any SQLite tool can open.
- Two views that make it readable, and four queries you can adapt.
- A measured answer to "how much of this dependency graph is inference?" — 443
  edges of 8997, all of them named.

## Where to go next

- [Read `model.db` from your own tool](/docs/how-to/query-model-db/) — the tables to
  start from, for a program rather than a session.
- [The `model.db` schema](/docs/reference/model-db/) — table by table.
- [Facts and inferences](/docs/explanation/facts-vs-inferences/) — why provenance is
  a value in the model and not a comment in a report.
