---
title: "query"
weight: 3
---

Run one read-only SQL statement over a model's store, with the node and dep views.

## Synopsis

```
codegraph query <model.jsonl> [sql] [--file FILE] [--param NAME=VALUE] [--param-file NAME=FILE] [--limit N] [--all] [--csv] [--json] [--views]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl>` | The model to query, through its store (model.db, built beside it when missing or stale) — or a model.db itself. | — |
| `[sql]` | The statement, quoted: ONE statement beginning with SELECT, WITH, VALUES or EXPLAIN. The views node (one row per entity, with its rendered id) and dep (one row per edge, names resolved) are there. | — |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--file FILE` | Read the statement from this file instead of the command line. | — |
| `--param NAME=VALUE` | Bind :NAME in the statement to VALUE — bound, never pasted into the text, so an id needs no escaping. Repeat it per parameter. A whole or decimal number is bound as a number, anything else as text. | — |
| `--param-file NAME=FILE` | Bind :NAME to the whole text of FILE, as text: a result saved with --json, a list. json_each(:NAME, '$.rows') then reads the saved rows, so one statement builds on another's file. | — |
| `--limit N` | Print at most N rows; how many there were is said on stderr. | `50` |
| `--all` | Print every row. | — |
| `--csv` | Print the rows as CSV: a header line, then one line per row. | — |
| `--json` | Print a codegraph.queryResult/1 document: columns, rows (one array per row), total, truncated. | — |
| `--views` | Print the SQL that creates node and dep, for another SQLite client, and exit. Takes no model and no other option. | — |
| `-h, --help` | Show this help. | — |

## It never writes

The store is opened read-only, and the text must be one statement that reads.
Both rules are needed: a read-only SQLite handle refuses every write to the
store and still executes `VACUUM INTO 'file'`, which writes a copy of the
database wherever the text says. A second statement after a `;` is refused
too, where SQLite would have run the first and ignored the rest without a
word.

A parameter the statement names and nobody gave is an error. SQLite would
bind NULL, return no row, and "no row" would read as "there are none".

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`2` for every refused statement, with SQLite's own message when SQLite
refused it. `3` when the file given is not a model the reader accepts.

## Example

```console
$ codegraph query fixtures/java/expected/model.jsonl \
    "SELECT kind, count(*) AS n FROM node WHERE is_stub = 0 GROUP BY kind ORDER BY n DESC, kind" --limit 5
cache: fixtures/java/expected/model.db
kind          n
-----------  --
method       43
parameter    35
attribute    21
constructor  19
class        14
5 of 12 rows shown — --all prints every row, --limit N another count.
```

```console
$ codegraph query fixtures/java/expected/model.jsonl \
    "SELECT kind FROM node WHERE id = :id" --param id='java:com.acme.order/Order.discount(int)' --json
cache: fixtures/java/expected/model.db
{
  "kind": "codegraph.queryResult/1",
  "columns": ["kind"],
  "rows": [
    ["method"]
  ],
  "total": 1,
  "truncated": false
}
1 row.
```

A statement can read the rows another one saved. `--param-file` binds the
whole text of a file; `json_each` turns the saved rows back into rows:

```console
$ codegraph query model.jsonl "SELECT kind, count(*) AS n FROM node WHERE is_stub = 0 GROUP BY kind ORDER BY n DESC, kind" --limit 3 --json > kinds.json
$ codegraph query model.jsonl \
    "SELECT json_extract(r.value, '$[0]') AS kind, json_extract(r.value, '$[1]') AS n FROM json_each(:saved, '$.rows') r" \
    --param-file saved=kinds.json
cache: model.db
kind        n
---------  --
method     43
parameter  35
attribute  21
3 rows.
```

[Step 4 of the discovery walk](/docs/discover/stimuli/) is built this way: the
inventory of entry points is saved once, and the chains, the groups and the
residue each read that file.

## See also

[Query model.db](/docs/how-to/query-model-db/) · [model.db](/docs/reference/model-db/) · [`import`](/docs/reference/cli/import/) · [CLI conventions](/docs/reference/cli/)
