---
title: "timeline"
weight: 12
---

Report an entity's life across the revisions of a temporal store.

## Synopsis

```
codegraph timeline <id> [--store FILE] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<id>` | The entity id, rendered form: java:com.acme.order/Basket | — |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--store FILE` | The temporal model.db (built with `codegraph import --at`); defaults to the store beside this directory's default model. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` is not returned.

## Example

```console
$ codegraph timeline java:com.acme.order/Basket --store /tmp/temporal.db
timeline of java:com.acme.order/Basket (1 of 1 revisions in /tmp/temporal.db)
  appeared:  4b9d4a5 (2023-11-14)
  present:   still in the latest revision
  REVISION  DATE        LOC  KIND
  4b9d4a5   2023-11-14   51  class
```

## See also

[model.db](/reference/model-db/) · [CLI conventions](/reference/cli/)
