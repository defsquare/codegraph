---
title: "validate"
weight: 1
---

Check models against their language profile and the graph invariants.

## Synopsis

```
codegraph validate <model.jsonl...> [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). | — |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when any model has findings, or when the load itself was not clean.

## Example

```console
$ codegraph validate fixtures/java/expected/model.jsonl
checked 1 model — 179 entities (27 stubs), 188 edges, lang java
  fixtures/java/expected/model.jsonl

OK — every model conforms: closure, no self-reference, provenance, candidates, profile, anchors, ids.
```

## See also

[Exit codes](/docs/reference/exit-codes/) · [model.jsonl](/docs/reference/model-jsonl/) · [CLI conventions](/docs/reference/cli/)
