---
title: City metrics
linkTitle: City metrics
weight: 7
---

What a building in the [code city](/reference/artifacts/city-json/) is measured by, how a measurement becomes a dimension, and what the legend says. Set with [`city --height` / `--footprint`](/reference/cli/city/).

## Built-in metric sources

A metric source is `{name, unit, describe, value(context)}`. `unit` and `describe` are the strings that reach the artifact's `bindings` block and the renderer's legend.

| Name | Unit | Definition |
|---|---|---|
| `loc` | source lines | Lines the type's own source anchor spans (end - start + 1). |
| `members` | entities | Base entities that folded into the building, the type included. |
| `methods` | methods | Members carrying `TInvocable` — methods, constructors and lambdas. |
| `fields` | fields | Members carrying `TStructural` whose container is the type itself. |
| `fanIn` | dependents | Distinct types that depend on this one, at type level, under the view. |
| `fanOut` | dependencies | Distinct types this one depends on, at type level, under the view. |
| `degree` | relations | fanIn + fanOut — how connected the type is, in either direction. |
| `one` | buildings | The constant 1 — a uniform city, for isolating one channel at a time. |

## Open forms

An extractor's own measures live in the entity's `TMetrics` map, whose keys are deliberately open. Two forms read that map by name:

| Form | Reads | Unit |
|---|---|---|
| `attribute:<key>` | the type's own measure | `<key>` |
| `sum:<key>` | that measure summed over everything that folded into the building | `<key>` |

`sum:` is the form complexity wants, because complexity is measured per invocable and a building is a type: `--height sum:cyclomatic --footprint loc` builds the complexity city. The [Java extractor](/reference/java-extractor/) emits `sloc` and `cyclomatic`.

The city will **not** invent a measure by re-parsing source it cannot see — only the extractor measures. A top-level numeric key of the same name is still read, since an entity is a loose object, but it is uncontractual: the map wins.

**An unknown name throws** (`UnknownMetricError`, naming what exists) rather than falling back to a default. A silent fallback would put a documented metric's name on a different metric's numbers.

## "I do not know" is an answer

A source returns `undefined`, never a substitute zero: a stub type has no anchor, so it has no line count, and a zero there would be a measurement nobody took. `sum:` likewise returns `undefined` — not `0` — when *no* member carries the key.

An unmeasured building is drawn at the **channel minimum**, counted in `bindings[].unmeasured` and in `diagnostics.unmeasured`, and reported on stderr:

```
warning: height is unmeasured on 18 buildings (metric loc) — those are drawn at the channel minimum, not at zero.
```

## Channels

| Channel | Default metric | Default scale | Default range | Reading |
|---|---|---|---|---|
| `height` | `loc` | `linear` | 1 – 40 | a tower twice as tall holds twice the source |
| `footprint` | `members` | `sqrt` | 2 – 20 | the metric maps onto the SIDE, so base AREA is proportional to it |

`sqrt` on the footprint is the one non-obvious default: mapping a metric linearly onto the side length would make area grow with its square, and a city plan invites the reader to compare areas. Both are overridable per channel with `--height-scale` / `--footprint-scale`, and whichever was used ships in `bindings`.

`--carry M1,M2` measures extra metrics onto every building without binding them to a channel; they appear in `Building.metrics` and nowhere else.

`--framework spring` adds a third, categorical channel: `Building.role`, with `CityModel.roles` as its legend. It is an inference from written annotations, and a building with no role stays neutral rather than being coloured "plain".

## Scales

`linear` · `sqrt` · `log`

`log` is `log1p`, not `log`: metrics legitimately reach 0 (a type nobody depends on has fan-in 0) and `log(0)` is `-Infinity`, which would silently render a *measured* zero at the range floor. Negative inputs are clamped to 0.

**A degenerate domain maps to the MIDDLE of the range.** When every building measures the same, identical inputs must render identically; flooring them all would read as "everything is minimal" when the truth is "everything is equal".

**Dimensions are rounded to 3 decimals**, so two runs serialize byte-identically.

## The order of operations

A dimension is relative to a domain, so the domain must exist first:

1. **Place.** Fold to type level, resolve each building's district.
2. **Measure.** Ask every source for every building. No dimension exists yet.
3. **Scale.** Compute each channel's domain over the measured values, then map.

## The legend, in machine form

`bindings` is the legend a renderer prints without knowing anything about codegraph. One entry per bound channel:

```json
{
  "channel": "height",
  "metric": "loc",
  "unit": "source lines",
  "describe": "Lines the type's own source anchor spans (end - start + 1).",
  "scale": "linear",
  "range": { "min": 1, "max": 40 },
  "domain": { "min": 4, "max": 51 },
  "unmeasured": 18
}
```

| Field | Meaning |
|---|---|
| `channel` | `height` or `footprint` |
| `metric` | the resolved name, open forms included |
| `unit` | what one unit of the value is |
| `describe` | the source's own one-line description |
| `scale` | how to read the mapping |
| `range` | the dimension given to the smallest and the largest measured value |
| `domain` | observed across the buildings that had a value; absent when none did |
| `unmeasured` | buildings the model could not measure on this channel |

`Building.metrics` carries the raw measurement next to the dimension it produced: a height of `17.596` means nothing on its own, and `loc: 24` beside it is what a tooltip, a legend and a bug report need. `null` means the model does not say.
