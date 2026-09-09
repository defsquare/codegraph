---
title: "city"
weight: 6
---

Write the code city: modules as districts, types as buildings.

This writes the artifact. To look at it, [`codegraph serve`](/docs/reference/cli/serve/) hosts the page (the City tab, beside the navigator) and takes the same channel flags.

## Synopsis

```
codegraph city [model.jsonl...] [--height METRIC] [--height-scale <linear|sqrt|log>] [--footprint METRIC] [--footprint-scale <linear|sqrt|log>] [--carry M1,M2] [--name STR] [--framework <spring>] [--layout] [--internal-only] [--declared-only] [--out FILE]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--height METRIC` | Metric driving building height. Built in: degree, fanIn, fanOut, fields, loc, members, methods, one. Open forms: attribute:<key>, sum:<key>. | `loc` |
| `--height-scale <linear\|sqrt\|log>` | How height follows its metric. | `linear` |
| `--footprint METRIC` | Metric driving building footprint. Built in: degree, fanIn, fanOut, fields, loc, members, methods, one. Open forms: attribute:<key>, sum:<key>. | `members` |
| `--footprint-scale <linear\|sqrt\|log>` | How the footprint SIDE follows its metric; sqrt makes the AREA proportional. | `sqrt` |
| `--carry M1,M2` | Extra metrics to measure onto every building, comma-separated, bound to nothing. | — |
| `--name STR` | Display name for the corpus in the page header; defaults to the basename of each model's root. | — |
| `--framework <spring>` | Classify types by a framework's own vocabulary (service, repository, controller…) and offer it as a color channel. An inference from written annotations; absent means the city says nothing about roles. | — |
| `--layout` | Lay the city out: positions on buildings, bounds on districts, by recursive shelf packing. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--out FILE` | Write the artifact to this file instead of stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean; the city is still built and the diagnostics say what it left out.

## Example

```console
$ codegraph city fixtures/java/expected/model.jsonl --layout --out /tmp/city.json
warning: 2 types left out — the model gives them no module, so there is no district to stand them in.
warning: 2 arrows dropped — an endpoint is not a building in this view.
warning: height is unmeasured on 18 buildings (metric loc) — those are drawn at the channel minimum, not at zero.
wrote 64904 bytes to /tmp/city.json (city, view all, 10 districts, 37 buildings, 64 arrows, height=loc, footprint=members, laid out).
```

## See also

[`serve`](/docs/reference/cli/serve/) · [City metrics](/docs/reference/city-metrics/) · [city.json](/docs/reference/artifacts/city-json/) · [CLI conventions](/docs/reference/cli/)
