---
title: "analyze"
weight: 2
---

Report dependencies, cycles, coupling or framework wiring over the loaded models.

## Synopsis

```
codegraph analyze [model.jsonl...] [--report <deps|cycles|coupling|wiring>] [--level <type|module>] [--internal-only] [--declared-only] [--no-cache] [--top N] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--report <deps\|cycles\|coupling\|wiring>` | Which analysis to run. | `deps` |
| `--level <type\|module>` | Fold the graph to this level before reporting. | `module` |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `--top N` | Show only the N highest-ranked rows. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean, and — for `--report cycles` — whenever any strongly connected component exists. A CI job gating on cycles checks for exactly this code.

## Example

```console
$ codegraph analyze fixtures/java/expected/model.jsonl --report cycles --level type
cache: fixtures/java/expected/model.db
fold(type): 177 base edges aggregated into 78; 11 dropped (an endpoint has no type container in this view); 10 entities unplaceable.
2 dependency cycle(s) at type level under view all — exiting 3 (findings).
codegraph analyze — cycles
models: fixtures/java/expected/model.jsonl
level:  type
view:   all (nothing filtered — stubs and inferred edges included)
layer:  every edge kind folded to type level

cycles: 2 strongly connected components, ranked by component size descending, ties by weight then first member
tangle: 40.0% overall — feedback weight 2 of 5 cyclic references (minimum feedback set)
self-dependencies after folding: 12
```

Trimmed after the summary block; the component listing follows.

## See also

[Exit codes](/docs/reference/exit-codes/) · [model.db](/docs/reference/model-db/) · [CLI conventions](/docs/reference/cli/)
