---
title: "serve"
weight: 5
---

Serve the navigator with the code city as a tab, over this model.

One page, built from one graph under one view: the **Navigate** tab (tree and per-node incoming/outgoing dependencies), the **City** tab (the 3D city, full-width; a selected building offers *Open in navigator*, which reveals that type on Navigate), then **Graph**, **Cycles** and **Coupling**. The server hands out `/navigator.json` and `/city.json` — each exactly the file [`navigator`](/docs/reference/cli/navigator/) and [`city --layout`](/docs/reference/cli/city/) would have written — beside the built frontend. Stdout stays empty; the process runs until Ctrl-C.

## Synopsis

```
codegraph serve [model.jsonl...] [--name STR] [--height METRIC] [--height-scale <linear|sqrt|log>] [--footprint METRIC] [--footprint-scale <linear|sqrt|log>] [--carry M1,M2] [--framework <spring>] [--port N] [--host ADDR] [--internal-only] [--declared-only] [--no-cache]
codegraph serve --app [--data-dir DIR] [--extractors FILE] [--port N] [--host ADDR] [city flags…]
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
| `--app` | The desktop app's daemon: no model on argv; bind 127.0.0.1:0 under a per-launch token, print one JSON line {port, token} on stdout, open folders through POST /jobs, exit when stdin closes. | — |
| `--data-dir DIR` | With --app: where models, their model.db caches, the page's artifacts and the recents live. | the OS application-data directory, `codegraph/` under it |
| `--extractors FILE` | With --app: the extractor registry, a JSON list of { name, path, extensions[], launch?, env? } — the daemon runs an entry, never a language. | — (only model.jsonl files open) |
| `-h, --help` | Show this help. | — |

## The app daemon (`--app`)

The same page, served the way the desktop app needs it — and the development
loop for that app: run it from a checkout and open the URL in a browser.

- **A capability URL, not an open port.** The daemon binds `127.0.0.1:0`
  (unless `--host`/`--port` say otherwise), prints exactly one line on stdout,
  `{"port":N,"token":"…"}`, and serves everything under `/<token>/`. Outside
  the token every route is `404`; a request whose `Origin` header is not the
  page's own is `403`.
- **Routes.** The page and its assets; `app` (the registered extractors and
  the current project); `recent`; `navigator.json` and `city.json` (the
  current project's artifacts, `404` until one is open); `POST jobs` with
  `{"src": "<folder or model.jsonl>", "extractor"?: "<name>"}` → `202` with
  the job, `409` while another runs, `422` when several extractors claim the
  folder (`candidates`, most files first — the page asks, never guesses),
  when none does (`seen` extensions), when the name is unknown or the file is
  not a `model.jsonl`, `404` for a path that is not there; `jobs/current`, a
  server-sent event stream that replays the current job's events to a
  subscriber and then streams the rest — `started`, `phase` (`detect`,
  `extract`, `build`), `progress` (the extractor's own stderr lines), `done`,
  `failed` (exit code and the last stderr lines) — or `idle` when nothing
  has run.
- **The registry** (`--extractors FILE`) is data: `[{ "name": "java", "path":
  "/…/codegraph-java", "extensions": [".java"], "launch": "exec" }, …]`.
  `launch` is `exec`, `java` (a jar) or `node` (a script) and is inferred from
  the path when absent; `env` adds variables to the process. Detection is a
  census of the folder's file extensions (dot-directories and `node_modules`
  skipped) against every entry's `extensions`.
- **`--data-dir`** holds one directory per opened folder — its `model.jsonl`,
  the `model.db` cache built beside it, `navigator.json`, `city.json` and a
  `project.json` — plus `recent.json`. Reopening a folder whose claimed files
  have the same paths, sizes and mtimes skips the extractor; the build is
  skipped too when the city flags have not changed.
- **It dies with its parent:** stdin EOF and SIGTERM both close the server
  and kill a running extractor.

```console
$ codegraph serve --app --data-dir /tmp/codegraph-data --extractors registry.json
{"port":40467,"token":"99ef68e1619647f1b30e2ce25fea99e8"}
```

(the line above is stdout; stderr narrates each job: `job: detect — 16 files
for java`, `job: extract — running java on …`, `job: build — …`, `job: done —
src: 137 nodes, 131 dependency rows`.)

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
