---
title: CLI
linkTitle: CLI
weight: 1
---

`codegraph` is one command with fourteen sub-commands. Every sub-command prints its own options with `codegraph <command> --help`; the pages below are that output, with the conventions the commands share stated once here.

```
codegraph <command> [options]

global options:
  -h, --help      Show this help.
  -v, --version   Print the codegraph version.
```

## Conventions

**Models load as a union.** Every analysis command takes one or more `model.jsonl` paths and loads them as a single graph, so multi-language analysis is a longer argument list. With no path, a command reads this directory's `<current-dir>-codegraph.jsonl` — what the extractor writes here. `import` is the exception: each path becomes its own store, never a union.

**stdout is the artifact; stderr is everything human.** Warnings, fold diagnostics and summaries never touch stdout, so a redirect always yields a clean file. There is no ANSI colour, and identical inputs give byte-identical output.

**Two views on every graph.** `--internal-only` drops stub (external) entities and every edge touching one. `--declared-only` keeps only `declared` facts and drops derived and dynamic-candidate edges. Every report names the view it was computed under.

**`--json`** prints the same information as a machine-readable object on stdout.

**A sibling `model.db`** — the SQLite analysis store — is built on first use and reused afterwards. `--no-cache` reads the JSONL directly; it is accepted by `analyze`, `export`, `navigator`, `domain-facts` and `explain`.

**Exit codes** distinguish a broken tool from a broken model: `0` success, `1` an internal bug, `2` a usage error, `3` findings. See [Exit codes](/reference/exit-codes/).

## Commands

| Command | What it does |
|---|---|
| [`validate`](/reference/cli/validate/) | Check models against their language profile and the graph invariants. |
| [`analyze`](/reference/cli/analyze/) | Report dependencies, cycles, coupling or framework wiring over the loaded models. |
| [`import`](/reference/cli/import/) | Build the SQLite analysis store (`model.db`) beside a `model.jsonl`. |
| [`export`](/reference/cli/export/) | Write the folded graph as DOT, JSON, CSV or PlantUML. |
| [`city`](/reference/cli/city/) | Write the code city: modules as districts, types as buildings. |
| [`navigator`](/reference/cli/navigator/) | Explore the model: a searchable tree with per-node dependency detail. |
| [`domain-facts`](/reference/cli/domain-facts/) | Write per-type domain dossiers: joined facts for domain extraction. |
| [`explain`](/reference/cli/explain/) | Explain every operation, type and module with an LLM, bottom-up, into a side-car. |
| [`scm`](/reference/cli/scm/) | Mine a repository's history into a deterministic `history.jsonl`. |
| [`snapshots`](/reference/cli/snapshots/) | Extract a repo at sampled revisions into a temporal store (`model.db`). |
| [`history`](/reference/cli/history/) | Report churn, hotspots and authorship over a mined `history.jsonl`. |
| [`timeline`](/reference/cli/timeline/) | Report an entity's life across the revisions of a temporal store. |
| [`replay`](/reference/cli/replay/) | Build the entity-level city replay of a temporal store. |
| [`profiles`](/reference/cli/profiles/) | Print the language profiles core ships. |

## Reports and formats

`analyze --report` takes one of:

| Report | What it answers |
|---|---|
| `deps` | who depends on whom, with the number of base edges folded into each arrow |
| `cycles` | strongly connected components, each with its tangle score and minimum feedback set; exit `3` when any exist |
| `coupling` | afferent and efferent coupling (Ca/Ce) and instability, per module or type |
| `wiring` | framework injection points and their corpus candidates (`--framework spring`); an inference, labelled as one |

`export --format` takes one of `dot`, `json`, `csv`, `plantuml`. In DOT and PlantUML a solid edge means every folded base edge is `declared` and a dashed one contains an inference; stub nodes are dashed and grey (`<<stub>>` in PlantUML). At `--level module` the PlantUML element is `package`, at `--level type` it is `class`.

`history --report` takes one of `summary`, `hotspots`, `authors`, `coupling`, `hidden`, `deadweight`. The last two join a model (`--model`).

## Ports

| Command | Default port | Default host |
|---|---|---|
| `city --serve` | `4177` | `0.0.0.0` |
| `history --serve` | `4177` | `0.0.0.0` |
| `replay --serve` | `4177` | `0.0.0.0` |
| `navigator --serve` | `4178` | `0.0.0.0` |

`0.0.0.0` is every interface. `--host 127.0.0.1` keeps the page on the local machine; `--port 0` picks a free port.
