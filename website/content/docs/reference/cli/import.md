---
title: "import"
weight: 3
---

Build the SQLite analysis store (model.db) beside a model.jsonl.

## Synopsis

```
codegraph import <model.jsonl...> [--out FILE] [--at SHA] [--time T] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths. Each becomes its OWN store — never a union. | — |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--out FILE` | Write the store here instead of beside the model. One model only. | — |
| `--at SHA` | Append this model as the snapshot extracted at commit SHA — the temporal store: revisions accumulate, and the flat tables mirror the latest import. | — |
| `--time T` | Commit time for --at (unix seconds or an ISO date); queries order by it. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean; the store is still written.

## Example

```console
$ codegraph import fixtures/java/expected/model.jsonl
fixtures/java/expected/model.jsonl: 0.03 s, 0.0 MB jsonl -> 0.2 MB db
imported fixtures/java/expected/model.jsonl -> fixtures/java/expected/model.db
  179 entities (27 stubs), 188 edges, 16 files, lang java

OK — the store is ready. Run `codegraph analyze` against the model as usual.
```

## See also

[model.db](/docs/reference/model-db/) · [model.jsonl](/docs/reference/model-jsonl/) · [CLI conventions](/docs/reference/cli/)
