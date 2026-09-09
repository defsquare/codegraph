---
title: "navigator"
weight: 7
---

Write the navigator model: the browsable tree with one classified row per dependency.

This writes the artifact. To browse it, [`codegraph serve`](/docs/reference/cli/serve/) hosts the page (with the city as a tab).

## Synopsis

```
codegraph navigator [model.jsonl...] [--name STR] [--internal-only] [--declared-only] [--no-cache] [--out FILE]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--name STR` | Display name for the corpus in the page header; defaults to the basename of each model's root. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `--out FILE` | Write the artifact to this file instead of stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean; the artifact is still written.

## Example

```console
$ codegraph navigator fixtures/java/expected/model.jsonl --out /tmp/navigator.json
cache: fixtures/java/expected/model.db
wrote 36469 bytes to /tmp/navigator.json (navigator, view all, 137 nodes, 131 dependency rows).
```

## See also

[`serve`](/docs/reference/cli/serve/) · [navigator.json](/docs/reference/artifacts/navigator-json/) · [CLI conventions](/docs/reference/cli/)
