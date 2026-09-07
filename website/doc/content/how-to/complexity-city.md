---
title: Build a complexity city
linkTitle: Complexity city
weight: 6
---

The default city is sized by lines of code and member count. To make complexity
the thing you see, bind it to the height channel and move size to the footprint.

**Before you start:** a `model.jsonl` from an extractor that emits measures. The
Java extractor emits `sloc` per type and invocable and `cyclomatic` per
invocable.

## Bind the channels

```bash
codegraph city model.jsonl --height sum:cyclomatic --footprint loc --serve
```

`--serve` lays the city out and opens the viewer on port 4177. To keep the
artifact instead:

```bash
codegraph city model.jsonl --height sum:cyclomatic --footprint loc \
  --internal-only --out complexity-city.json
```

Two metric families are available:

| Form | Reads |
|---|---|
| `degree`, `fanIn`, `fanOut`, `fields`, `loc`, `members`, `methods`, `one` | built-ins computed from the graph and the anchors |
| `attribute:<key>` | the type's own measure with that key |
| `sum:<key>` | that measure summed over everything that folded into the building |

**Complexity wants `sum:`.** Cyclomatic complexity is measured per invocable and
a building is a type, so `attribute:cyclomatic` would find nothing on the type
itself while `sum:cyclomatic` adds up its methods.

An unknown name is refused rather than silently replaced:

```text
codegraph: unknown metric source: complexity. Known sources: loc, members, methods, fields, fanIn, fanOut, degree, one; or attribute:<key> / sum:<key>.
```

## Choose the scales

```bash
codegraph city model.jsonl --height sum:cyclomatic --height-scale sqrt \
  --footprint loc --footprint-scale sqrt --internal-only --out city.json
```

- `--height-scale` defaults to `linear`: a tower twice as tall holds twice the
  measure. Switch to `sqrt` or `log` when one outlier flattens everything else.
- `--footprint-scale` defaults to `sqrt`, and that default is the one to leave
  alone: the metric maps onto the *side*, so `sqrt` makes the base **area**
  proportional to it, which is what a reader comparing plans assumes.
- `log` is `log1p`, so a measured zero renders as zero rather than at negative
  infinity.

Whichever you used is recorded in the artifact:

```json
{ "channel": "height", "metric": "sum:cyclomatic", "unit": "cyclomatic",
  "scale": "sqrt", "range": { "min": 1, "max": 40 },
  "domain": { "min": 1, "max": 12 }, "unmeasured": 0 }
```

## Carry the numbers you want to read but not see

`--carry` measures extra metrics onto every building without binding them to a
channel. They show up in the details panel and in `building.metrics`.

```bash
codegraph city model.jsonl --height sum:cyclomatic --footprint loc \
  --carry members,fanIn --internal-only --out city.json
```

```json
"metrics": { "fanIn": 0, "loc": 10, "members": 5, "sum:cyclomatic": 2 }
```

## Read the unmeasured warning

A building the metric could not measure is drawn at the channel minimum and
counted, never faked to zero:

```text
warning: height is unmeasured on 18 buildings (metric sum:cyclomatic) — those are drawn at the channel minimum, not at zero.
```

**If that number is large, then check what the buildings are.** Stubs carry no
measures at all, so `--internal-only` usually removes the whole warning. If it
survives on corpus types, the extractor did not measure them.

{{< callout type="info" >}}
Codegraph will not invent a measure by re-parsing source it cannot see. Only the
extractor measures; the city reads what the model carries and says "unmeasured"
when there is nothing there.
{{< /callout >}}

## Related

- [Reading a city](/tutorials/reading-the-city/)
- [City metrics reference](/reference/city-metrics/)
- [`codegraph city`](/reference/cli/city/)
- [The city is a model](/explanation/city-is-a-model/)
