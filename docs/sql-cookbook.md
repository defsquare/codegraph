# Querying `model.db` — a SQL cookbook

`model.db` is the **workbench**. The `.jsonl` beside it is the contract —
schema-validated, diffable, language-agnostic — and the database is a derived,
disposable cache of it that exists so you can ask your own questions without
writing a program.

Every query on this page is executed against the committed Java fixture by
`packages/cli/test/sql-cookbook.test.ts`, so none of them can rot into
plausible-looking SQL that no longer runs. Three of them are checked against
`codegraph`'s own answer, not just for syntax.

## Getting a store

```sh
codegraph import model.jsonl                  # writes model.db beside it
codegraph analyze model.jsonl --report deps   # builds it on demand, then reuses it
```

Then open it with anything that speaks SQLite:

```sh
sqlite3 model.db
datasette model.db
duckdb -c "ATTACH 'model.db' AS cg (TYPE sqlite); SELECT count(*) FROM cg.entity;"
```

Nothing you do here can hurt anything. Delete the file and the next command
rebuilds it; `*.db` is gitignored for the same reason.

## Orientation

Five facts are worth knowing before you write a query.

**Ids are integers, and they are the model's own.** `entity.id` is the
surrogate the `.jsonl` used, so nothing was renumbered on the way in. They are
positions in one file, **not identity** — never carry one between models, and
never store one anywhere.

**Identity is the natural key.** `(lang, module, symbol, disambiguator)`, with
`lang` in `meta` and the rest on `entity`. The rendered `java:pkg/Type#sig`
form you see in reports is a projection of that, reconstructed by the `node`
view below.

**Vocabularies are interned.** `kind`, `trait`, `edge_kind`, `provenance` and
`file` are small tables of names; every row references them by id.

**Trait sets are interned too.** An entity points at a `trait_set`, not at a
list of traits — 15 distinct sets across a 15 338-entity corpus, 18 across a
241 101-entity one. Asking "which entities carry `TInvocable`" means asking
which *sets* carry it, which is a handful of rows.

**Only outgoing facts are stored.** There is one `edge` table, in the direction
the model states. `edge_to` and `entity_parent` are *indexes* over those facts,
not tables of inverse data — so `who imports me` is a `GROUP BY`, and it can
never disagree with `who do I import`.

## Paste this first

Two views turn surrogates into the ids you recognise and the names you can read.
They cost nothing, they work on a read-only database, and every recipe below
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

`node.id` reproduces `renderId` exactly — the cookbook test asserts that the
167 ids it renders are the 167 the analyzer produces, in the same order.

## The corpus at a glance

```sql
SELECT (SELECT value FROM meta WHERE key = 'lang')     AS lang,
       (SELECT count(*) FROM entity)                   AS entities,
       (SELECT count(*) FROM entity WHERE is_stub = 1) AS stubs,
       (SELECT count(*) FROM edge)                     AS edges,
       (SELECT count(*) FROM file)                     AS files;
```

## Fan-in and fan-out

The user-facing win: what does everything depend on, and what depends on too
much.

```sql
SELECT n.id, count(*) AS fan_in
  FROM dep d JOIN node n ON n.ref = d.to_ref
 GROUP BY d.to_ref
 ORDER BY fan_in DESC, n.id
 LIMIT 20;
```

On apache/commons-lang that is `java.lang/String` with 3 021, then
`java.lang/Object` with 802 — which is the first thing the shape of the answer
should tell you: **stubs count.** An import of an external type is a real
dependency, and dropping it silently understates coupling. Filter them out
deliberately, not by accident:

```sql
SELECT n.id, count(*) AS fan_in
  FROM dep d
  JOIN node n ON n.ref = d.to_ref
  JOIN node f ON f.ref = d.from_ref
 WHERE n.is_stub = 0 AND f.is_stub = 0
 GROUP BY d.to_ref
 ORDER BY fan_in DESC, n.id
 LIMIT 20;
```

Fan-out is the same query the other way round, and counts *distinct* targets —
calling one method thirty times is one dependency:

```sql
SELECT n.id, count(DISTINCT d.to_ref) AS fan_out
  FROM dep d JOIN node n ON n.ref = d.from_ref
 GROUP BY d.from_ref
 ORDER BY fan_out DESC, n.id
 LIMIT 20;
```

## Facts only, and inferences named

An analysis that must not mix facts with inferences filters on provenance
(CLAUDE.md invariant 2). `declared` is what the extractor saw; everything else
is something it worked out.

```sql
SELECT d.kind, count(*) AS n
  FROM dep d
 WHERE d.provenance = 'declared'
 GROUP BY d.kind
 ORDER BY n DESC, d.kind;
```

The complement is worth running at least once on any corpus, because it tells
you how much of your dependency graph is inference:

```sql
SELECT d.provenance, d.kind, count(*) AS n
  FROM dep d
 WHERE d.provenance <> 'declared'
 GROUP BY d.provenance, d.kind
 ORDER BY n DESC, d.provenance, d.kind;
```

## Entities carrying a trait

Traits are the metamodel's vocabulary of capability, and this is where the
interned trait set pays off: the `IN` list is a handful of ids however large the
corpus is.

```sql
SELECT n.kind, count(*) AS n
  FROM node n
 WHERE n.trait_set_id IN (
         SELECT m.trait_set_id
           FROM trait_set_member m
           JOIN trait t ON t.id = m.trait_id
          WHERE t.name = 'TInvocable')
 GROUP BY n.kind
 ORDER BY n DESC, n.kind;
```

Swap `TInvocable` for `TWithParameters`, `TAttachedTo`, `TStructural` — see
`METAMODEL.md` for what each one means.

## Modules

What is in each module:

```sql
SELECT m.id AS module, count(*) AS members
  FROM node n JOIN node m ON m.ref = n.module_ref
 GROUP BY n.module_ref
 ORDER BY members DESC, module
 LIMIT 20;
```

The module→module import graph — the one layer comparable across every
language (invariant 9):

```sql
SELECT a.id AS from_module, b.id AS to_module, count(*) AS weight
  FROM dep d
  JOIN node ef ON ef.ref = d.from_ref
  JOIN node et ON et.ref = d.to_ref
  JOIN node a  ON a.ref  = ef.module_ref
  JOIN node b  ON b.ref  = et.module_ref
 WHERE d.kind = 'import' AND a.ref <> b.ref
 GROUP BY a.ref, b.ref
 ORDER BY weight DESC, from_module, to_module
 LIMIT 20;
```

> **`module_ref` is not quite the fold.** `codegraph` folds an entity by walking
> its `parent` chain to the nearest ancestor carrying `TModule`; `module_id` is
> the module component of its natural key. On both real corpora these agree for
> every entity that resolves at all — but they answer different questions, and
> they differ in one case that matters: the walk can end with **no container**,
> while `module_id` always points somewhere. The Java fixture has 2 such
> entities. Grouping by `module_ref` therefore places entities the fold reports
> as unplaceable. When you need the fold's answer exactly, ask
> `codegraph analyze --report deps`.

## Reachability

A recursive CTE, and the reason a graph in a database is worth having.
Everything reachable from a starting point:

```sql
WITH RECURSIVE reach(ref) AS (
  SELECT ref FROM node WHERE id = 'java:com.acme.order/Order'
  UNION
  SELECT d.to_ref FROM dep d JOIN reach r ON d.from_ref = r.ref
)
SELECT n.id
  FROM reach JOIN node n ON n.ref = reach.ref
 ORDER BY n.id;
```

`UNION`, never `UNION ALL`: the second deduplicates and therefore terminates on
a cyclic graph, which real corpora are.

## Cycles between modules

```sql
WITH RECURSIVE
  mod_edge(a, b) AS (
    SELECT DISTINCT ef.module_ref, et.module_ref
      FROM dep d
      JOIN node ef ON ef.ref = d.from_ref
      JOIN node et ON et.ref = d.to_ref
     WHERE ef.module_ref <> et.module_ref),
  walk(start, at) AS (
    SELECT a, b FROM mod_edge
    UNION
    SELECT w.start, e.b FROM walk w JOIN mod_edge e ON e.a = w.at)
SELECT n.id AS module_in_a_cycle
  FROM walk w JOIN node n ON n.ref = w.start
 WHERE w.start = w.at
 ORDER BY module_in_a_cycle;
```

On apache/commons-lang this returns the same 13 modules that
`codegraph analyze --report cycles --level module` reports as one strongly
connected component — the cookbook test asserts that agreement rather than
trusting it.

It finds *which* modules are in a cycle, not the components themselves; for
ranked SCCs with weights and the edges that close each loop, use the command.

## Evidence

Every entity and edge carries an anchor, so "where is this written" is a join:

```sql
SELECT n.id, f.path, e.anchor_start AS line
  FROM node n
  JOIN entity e ON e.id = n.ref
  JOIN file   f ON f.id = e.anchor_file_id
 WHERE n.kind = 'class'
 ORDER BY f.path, line
 LIMIT 20;
```

Which files carry the most:

```sql
SELECT f.path, count(*) AS entities
  FROM entity e JOIN file f ON f.id = e.anchor_file_id
 GROUP BY f.id
 ORDER BY entities DESC, f.path
 LIMIT 20;
```

## Uncertain dispatch

An edge with candidates is one the extractor could not resolve to a single
target. A high count is a place where static analysis ran out of information —
worth looking at before trusting a call graph through it.

```sql
SELECT n.id AS edge_from, d.kind, count(*) AS candidates
  FROM edge_candidate c
  JOIN edge x ON x.id = c.edge_id
  JOIN dep  d ON d.ref = x.id
  JOIN node n ON n.ref = x.from_id
 GROUP BY c.edge_id
 ORDER BY candidates DESC, edge_from
 LIMIT 20;
```

## Four rules

**Sorting belongs to the model, never to the engine.** Codegraph orders ids by
UTF-16 code unit; SQLite's `BINARY` collation orders by UTF-8 byte. They agree
across the Basic Multilingual Plane and *invert* above it — see
`fixtures/unicode/README.md`, which exists entirely to pin this. If your query
feeds something that cares about order, sort it in your own code with the same
comparison, or `ORDER BY` the surrogate, which the importer wrote in canonical
order.

**Never store a surrogate.** It is a position in one file. It is not stable
across runs, it means nothing in another model, and writing one into a
spreadsheet is how a number outlives its meaning.

**Provenance or it did not happen.** A count that mixes `declared` with
`derived` is not a measurement of the code, it is a measurement of the code plus
the extractor's guesses. Say which you meant.

**The store is a cache, not a source.** Nothing but the importer writes to it.
If you want a derived table, make it a `TEMP` one — the next `codegraph` run may
regenerate the file underneath you, and it will not ask.

## When SQL is the wrong tool

Ask `codegraph` when you need:

- **the fold, exactly** — the parent-chain walk, its view semantics, and the
  unplaceable-entity report;
- **ranked SCCs**, with weights and the edges closing each cycle;
- **coupling tables** that state the level and view they were computed under,
  because a coupling number without its view is not a fact;
- **anything you intend to commit** — the `.jsonl` and the analyzer's exports
  are the reproducible artefacts; a query result is a look, not a record.
