---
title: "domain-facts"
weight: 7
---

Write per-type domain dossiers: joined facts for domain extraction.

## Synopsis

```
codegraph domain-facts [model.jsonl...] [--framework <spring>] [--internal-only] [--declared-only] [--no-cache] [--out FILE]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--framework <spring>` | Classify types and entry points by a framework's own vocabulary and attach DI candidates to each dossier. An inference from written annotations; absent means the dossiers say nothing about roles. | — |
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
$ codegraph domain-facts fixtures/java/expected/model.jsonl --out /tmp/domain-facts.json
cache: fixtures/java/expected/model.db
wrote 100827 bytes to /tmp/domain-facts.json (domain facts, view all, 19 type dossiers, 58 operations).
```

## See also

[domain-facts.json](/reference/artifacts/domain-facts/) · [CLI conventions](/reference/cli/)
