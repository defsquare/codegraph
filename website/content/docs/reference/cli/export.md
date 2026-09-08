---
title: "export"
weight: 4
---

Write the folded graph as DOT, JSON, CSV or PlantUML.

## Synopsis

```
codegraph export <model.jsonl...> --format <dot|json|csv|plantuml> [--level <type|module>] [--internal-only] [--declared-only] [--no-cache] [--out FILE]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). | — |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--format <dot\|json\|csv\|plantuml>` | Output format. | *required* |
| `--level <type\|module>` | Fold the graph to this level before reporting. | `module` |
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
$ codegraph export fixtures/java/expected/model.jsonl --format csv --level module --internal-only
cache: fixtures/java/expected/model.db
from,to,count,kinds,provenances,selfLoop,level,view
java:com.acme.order,java:com.acme.order,98,access;annotationUse;inheritance;interfaceImplementation;invocation;reference;throws,declared,true,module,internalOnly
java:com.acme.order,java:com.acme.order.legacy,2,invocation;reference,declared,false,module,internalOnly
java:com.acme.order.adapter,java:com.acme.order.adapter,1,access,declared,true,module,internalOnly
java:com.acme.order.legacy,java:com.acme.order.legacy,6,access;reference,declared,true,module,internalOnly
```

## See also

[Provenance](/docs/reference/metamodel/provenance/) · [Stubs](/docs/reference/metamodel/stubs/) · [CLI conventions](/docs/reference/cli/)
