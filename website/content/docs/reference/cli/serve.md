---
title: "serve"
weight: 5
---

Serve the navigator with the code city as a tab, over this model.

One page, built from one graph under one view: the **Navigate** tab (tree and per-node incoming/outgoing dependencies), the **City** tab (the 3D city, full-width; a selected building offers *Open in navigator*, which reveals that type on Navigate), then **Graph**, **Cycles** and **Coupling**. The server hands out `/navigator.json` and `/city.json` — each exactly the file [`navigator`](/docs/reference/cli/navigator/) and [`city --layout`](/docs/reference/cli/city/) would have written — beside the built frontend. Stdout stays empty; the process runs until Ctrl-C.

## Synopsis

```
codegraph serve [model.jsonl...] [--name STR] [--height METRIC] [--height-scale <linear|sqrt|log>] [--footprint METRIC] [--footprint-scale <linear|sqrt|log>] [--carry M1,M2] [--framework <spring>] [--port N] [--host ADDR] [--internal-only] [--declared-only] [--no-cache]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--name STR` | Display name for the corpus in the page header; defaults to the basename of each model's root. | — |
| `--height METRIC` | Metric driving building height. Built in: degree, fanIn, fanOut, fields, loc, members, methods, one. Open forms: attribute:<key>, sum:<key>. | `loc` |
| `--height-scale <linear\|sqrt\|log>` | How height follows its metric. | `linear` |
| `--footprint METRIC` | Metric driving building footprint. Built in: degree, fanIn, fanOut, fields, loc, members, methods, one. Open forms: attribute:<key>, sum:<key>. | `members` |
| `--footprint-scale <linear\|sqrt\|log>` | How the footprint SIDE follows its metric; sqrt makes the AREA proportional. | `sqrt` |
| `--carry M1,M2` | Extra metrics to measure onto every building, comma-separated, bound to nothing. | — |
| `--framework <spring>` | Classify types by a framework's own vocabulary (service, repository, controller…) and offer it as a color channel. An inference from written annotations; absent means the city says nothing about roles. | — |
| `--port N` | Port to listen on; 0 picks a free one (announced on stderr). | `4177` |
| `--host ADDR` | Address to bind. 0.0.0.0 is every interface, so the page is reachable from other machines; 127.0.0.1 keeps it to this one. | `0.0.0.0` |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean; the page is still served and one warning says so, followed by each artifact's own caveats.

## Example

```console
$ codegraph serve fixtures/java/expected/model.jsonl --host 127.0.0.1
cache: not used — disabled by --no-cache. Reading the model.
warning: 2 types left out — the model gives them no module, so there is no district to stand them in.
warning: 2 arrows dropped — an endpoint is not a building in this view.
warning: height is unmeasured on 18 buildings (metric loc) — those are drawn at the channel minimum, not at zero.
codegraph at http://localhost:4177/ — Ctrl-C to stop.
```

Bound to every interface, the last line reads `codegraph at http://localhost:4177/ (every interface — reachable from other machines) — Ctrl-C to stop.` It never prints `http://0.0.0.0:4177/`.

## See also

[City metrics](/docs/reference/city-metrics/) · [city.json](/docs/reference/artifacts/city-json/) · [navigator.json](/docs/reference/artifacts/navigator-json/) · [Serve on a network](/docs/how-to/serve-network/) · [CLI conventions](/docs/reference/cli/)
