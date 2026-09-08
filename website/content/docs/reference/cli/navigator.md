---
title: "navigator"
weight: 6
---

Explore the model: a searchable tree with per-node dependency detail.

## Synopsis

```
codegraph navigator [model.jsonl...] [--name STR] [--serve] [--port N] [--host ADDR] [--internal-only] [--declared-only] [--no-cache] [--out FILE]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--name STR` | Display name for the corpus in the navigator header; defaults to the basename of each model's root. | — |
| `--serve` | Serve the navigator with this model loaded, on every interface unless --host says otherwise (stdout stays empty; Ctrl-C stops it). Needs the built navigator-ui app (pnpm -r build). | — |
| `--port N` | Port for --serve; 0 picks a free one. | `4178` |
| `--host ADDR` | Address --serve binds. 0.0.0.0 is every interface, so the page is reachable from other machines; 127.0.0.1 keeps it to this one. | `0.0.0.0` |
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

[navigator.json](/docs/reference/artifacts/navigator-json/) · [CLI conventions](/docs/reference/cli/)
