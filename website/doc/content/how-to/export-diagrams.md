---
title: Export the graph as a diagram or a table
linkTitle: Export diagrams
weight: 5
---

`codegraph export` writes the folded dependency graph in four formats. Two are
diagrams you render with an external tool; two are data you feed to something
else.

**Before you start:** a `model.jsonl`. Graphviz for DOT, a PlantUML jar or the
`plantuml` command for PlantUML.

## Choose the format and the level

```bash
codegraph export model.jsonl --format dot      --level module --out graph.dot
codegraph export model.jsonl --format plantuml --level module --out modules.puml
codegraph export model.jsonl --format csv      --level type    --out types.csv
codegraph export model.jsonl --format json     --level type    --out types.json
```

`--format` is required; `--level` is `module` (the default) or `type`. Without
`--out` the artifact goes to `stdout`, which is safe to redirect — every
warning, fold diagnostic and summary goes to `stderr`.

`--internal-only` and `--declared-only` work here exactly as in `analyze`; see
[Get a facts-only answer](/how-to/facts-only-view/).

## Render DOT

```bash
codegraph export model.jsonl --format dot --level type --internal-only --out types.dot
dot -Tsvg types.dot -o types.svg
```

The file starts with the header it was produced under, so a diagram checked into
a repository still says what it is:

```text
// codegraph — rendering of a FOLDED ANALYSIS GRAPH. Not a model.jsonl.
// level: type
// view: internalOnly
// nodes: 19, edges: 39
// base edges folded: 107, dropped: 0, unfoldable entities: 3
// encoding: solid edge = declared fact; dashed edge = contains an inference;
//           edge label and penwidth = aggregated base-edge count;
//           dashed node = stub (external, not corpus-declared).
```

`penwidth` is the aggregated count *bucketed* (1 / 2–4 / 5–16 / 17+) so two runs
render identically on any platform. Node shape is deliberately not a channel —
entity kind varies by language, so it rides in the tooltip.

## Render PlantUML

```bash
codegraph export model.jsonl --format plantuml --level module --out modules.puml
plantuml -tsvg modules.puml
```

The element follows the fold level: `package` at module level, `class` at type
level — a module-level node carries `TModule`, not `TType`, and drawing it as a
class would assert a type the model never declared. The diagram carries its own
legend:

```text
package "com.megacorp.ledger" as java_com_megacorp_ledger <<stub>> #line.dashed {
}
java_com_acme_order --> java_java_util : 15
java_com_acme_order ..> java_com_megacorp_ledger : 8
legend
  how to read this diagram
  ==
  a box | one module of the model; nothing below module level is drawn
  A --> B : n | n base edges, all provenance declared
  A ..> B : n | at least one base edge is an inference (derived / dynamic-candidate / generated)
  <<stub>> | external entity, not corpus-declared
end legend
```

So: **solid** is a declared fact, **dotted** contains an inference, `<<stub>>`
is an entity your corpus does not declare.

## Export data

CSV is RFC 4180 with a header row, and carries the level and view per row:

```text
from,to,count,kinds,provenances,selfLoop,level,view
java:com.acme.order,java:com.acme.order.legacy,2,invocation;reference,declared,false,module,all
java:com.acme.order,java:com.megacorp.ledger,8,access;import;invocation;reference,declared;derived,false,module,all
```

JSON says what it is and does not pretend to be interchange:

```json
{
  "kind": "codegraph.foldedGraph/1",
  "generatedBy": "@codegraph/analyzer",
  "level": "type",
  "view": { "name": "internalOnly", "filters": ["internalOnly"] },
  "nodes": [ … ],
```

{{< callout type="warning" >}}
None of these is a model. `model.jsonl` is the interchange contract; an export is
a rendering of one folded view of it, and it cannot be read back.
{{< /callout >}}

**If a diagram looks smaller than you expected**, read the `dropped` and
`unfoldable entities` counts in the header and the `stderr` warning. Entities
with no container at the chosen level are reported, never silently omitted.

## Related

- [`codegraph export`](/reference/cli/export/)
- [Get a facts-only or internal-only answer](/how-to/facts-only-view/)
- [The analysis pipeline](/explanation/analysis-pipeline/)
