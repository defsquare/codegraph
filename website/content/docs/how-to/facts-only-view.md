---
title: Get a facts-only or internal-only answer
linkTitle: Facts-only view
weight: 4
---

Two switches change every number codegraph reports, and every report says which
were on. Use them when the answer has to be about what the source literally
says, or about your own code only.

**Before you start:** a `model.jsonl`.

## The two switches

| Switch | Drops | Ask for it when |
|---|---|---|
| `--declared-only` | every edge whose provenance is not `declared` — derived and dynamic-candidate inferences | you are counting facts, not codegraph's guesses |
| `--internal-only` | stub (external) entities and every edge touching one | you are measuring your corpus, not the JDK and its libraries |

They compose, and both are accepted by `analyze`, `export`, `city`,
`navigator`, `domain-facts` and `explain`.

## Ask for facts only

```bash
codegraph analyze model.jsonl --report deps --declared-only
```

On the reference fixture the default view reports six module dependencies and
this one reports four. The two that vanish are the imports of
`com.megacorp.ledger`, which the extractor derived rather than read:

```text
  java:com.acme.order         ~> java:com.megacorp.ledger   weight=2  kinds=import  provenance=derived
```

`~>` in a text report — and a dashed line in DOT or PlantUML — means the
aggregated arrow contains at least one inference. `->` means every base edge
under it is `declared`.

## Ask for your own code only

```bash
codegraph analyze model.jsonl --report deps --internal-only
```

```text
view:   internalOnly (internalOnly)

nodes: 3
edges: 0 aggregated dependencies
…
dependencies
  none — no dependency survives internalOnly at module level.
```

An empty answer here is a fact, not a failure: the fixture's packages import
nothing from each other. An edge survives a view only if **both** endpoints do,
so dropping stubs drops every edge into one.

Note that the node list still shows stubs under `--declared-only` alone. That
switch filters edges by provenance; it says nothing about whether a node is
external.

## Read the view stamp

Every result names its projection. Combine the switches and the stamp records
the trail:

```bash
codegraph analyze model.jsonl --report coupling --level type --internal-only --declared-only --top 5
```

```text
level:  type
view:   internalOnly+declaredOnly (internalOnly, declaredOnly)
```

The stamp reaches every rendering, not just the terminal:

- DOT — a `// view:` line in the header comment;
- PlantUML — the diagram `title`;
- CSV — a `view` column on every row, because a comment line would be read as
  data;
- JSON and `city.json` — a `view` object with `name` and `filters`;
- `--json` on any report — the same object.

{{< callout type="info" >}}
A coupling number without its view is not a fact. Filter the stubs out and every
Ca, Ce and instability changes — which is why the switches are never remembered
between runs and never default to on.
{{< /callout >}}

## Related

- [Facts and inferences never mix](/docs/explanation/facts-vs-inferences/)
- [`codegraph analyze`](/docs/reference/cli/analyze/)
- [Provenance reference](/docs/reference/metamodel/provenance/)
- [Stubs reference](/docs/reference/metamodel/stubs/)
