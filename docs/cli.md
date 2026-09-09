# `codegraph` — command reference

Every command prints its own options with `codegraph <command> --help`; this
page is the same information in one place, with the conventions the commands
share. Task-oriented walkthroughs live in the [README](../README.md).

## Conventions every command follows

- **Models load as a union.** Every analysis command takes one or more
  `model.jsonl` paths and loads them as a single graph, so multi-language
  analysis is just a longer argument list. With no path at all, a command
  standing in a directory the extractor has run on reads that directory's
  `<current-dir>-codegraph.jsonl`.
- **stdout is the artifact; stderr is everything human.** Warnings, fold
  diagnostics and summaries never touch stdout, so a redirect always yields a
  clean file. There is no ANSI colour, and identical inputs give byte-identical
  output.
- **Two views on every graph.** `--internal-only` drops stub (external)
  entities and every edge touching one; `--declared-only` keeps only `declared`
  facts and drops derived and dynamic-candidate edges. Every report names the
  view it was computed under, because a coupling number without its view is
  not a fact.
- **Exit codes** distinguish a broken tool from a broken model: `0` success,
  `1` an internal bug in codegraph, `2` a usage error, `3` findings (the tool
  worked; the input did not). A CI job gating on model quality checks for `3`.
- **`--json`** prints the same information as a machine-readable object.
- **A sibling `model.db`** (the SQLite analysis store) is built on first use and
  reused afterwards by `analyze`, `export`, `navigator`, `domain-facts` and
  `explain`; on those, `--no-cache` reads the JSONL directly.

## Synopsis

```
codegraph validate model.jsonl [--json]

codegraph analyze  [model.jsonl] [--report deps|cycles|coupling|wiring]   # default: deps
                   [--level module|type] [--internal-only] [--declared-only]
                   [--json] [--top N]

codegraph export   model.jsonl --format dot|json|csv|plantuml
                   [--level module|type] [--internal-only] [--declared-only]
                   [--out FILE]

codegraph import   model.jsonl [--out FILE] [--at SHA [--time T]] [--json]
                   # build the SQLite analysis store (model.db) beside a model;
                   # --at appends the model as a snapshot of the TEMPORAL store

codegraph serve    [model.jsonl] [--port N] [--host ADDR] [--name STR]
                   [--height METRIC] [--height-scale linear|sqrt|log]
                   [--footprint METRIC] [--footprint-scale linear|sqrt|log]
                   [--carry M1,M2] [--framework spring]
                   [--internal-only] [--declared-only] [--no-cache]
                   # one page: the navigator, with the 3D city as a tab

codegraph city     [model.jsonl] [--layout] [--out FILE]
                   [--height METRIC] [--height-scale linear|sqrt|log]
                   [--footprint METRIC] [--footprint-scale linear|sqrt|log]
                   [--carry M1,M2] [--name STR] [--framework spring]
                   [--internal-only] [--declared-only]

codegraph navigator [model.jsonl] [--out FILE]
                   [--name STR] [--internal-only] [--declared-only]

codegraph domain-facts [model.jsonl] [--framework spring] [--out FILE]
                   [--internal-only] [--declared-only]

codegraph explain  [model.jsonl] [--src DIR] [--out FILE] [--dry-run]
                   [--estimate [--price-in USD --price-out USD]]
                   [--provider auto|openrouter|cloudflare]
                   [--model SLUG] [--rollup-model SLUG] [--depth N]
                   [--max-calls N] [--scope IDS] [--concurrency N]
                   [--max-lines N] [--max-scc N] [--force] [--json]
                   [--framework spring] [--internal-only] [--declared-only]

codegraph scm      [repo] [--since DATE] [--out FILE] [--json]

codegraph snapshots [repo] --jar FILE (--every N | --tags)
                   [--store FILE] [--src DIR] [--json]

codegraph history  [history.jsonl] [--top N] [--json]
                   [--report summary|hotspots|authors|coupling|hidden|deadweight]
                   [--min-support N] [--min-confidence PCT] [--model FILE]
                   [--serve [--port N] [--host ADDR]] [--city FILE]

codegraph timeline java:com.acme/Basket [--store FILE] [--json]

codegraph replay   [--store FILE] [--name STR] [--history FILE] [--out FILE]
                   [--serve [--port N] [--host ADDR]]

codegraph profiles [--lang java] [--json]
```

## Commands

### `validate`
Checks one or more models against their language profile and the graph
invariants: closure (no reference to an unknown id), no self-reference,
provenance vocabulary, the `candidates` rule, anchors, and conflicting
redeclaration. Exit `3` means the model has findings. This is the conformance
gate an extractor must pass; the same check runs in the property suite and CI.

### `analyze`
Reports over the loaded graph, folded to `--level module` (default) or `type`:

| `--report` | What it answers |
|---|---|
| `deps` | who depends on whom, with the number of base edges folded into each arrow |
| `cycles` | strongly connected components, each with its Structure101-style tangle score and the minimum feedback set — the cheapest cut that leaves the graph acyclic; exit `3` when any exist |
| `coupling` | afferent/efferent coupling (Ca/Ce), instability, per module or type |
| `wiring` | framework injection points and their corpus candidates, from the Spring profile; an inference, labelled as one |

### `export`
The folded graph as `dot`, `json`, `csv` or `plantuml`. Every rendering keeps
the fact/inference distinction visible: in DOT and PlantUML a solid edge means
every folded base edge is `declared`, a dashed one contains an inference; stub
nodes are dashed and grey (`<<stub>>` in PlantUML). At `--level module` the
PlantUML element is `package`; at `type` it is `class` — the element follows
what the node *is*, and the title carries level and view.

### `import`
Builds `model.db`, the SQLite analysis store, beside a `model.jsonl`. The store
is a derived, disposable cache — never the contract — that lets repeat runs
skip parsing and lets you query the graph yourself
([SQL cookbook](sql-cookbook.md)). With `--at SHA` the model is appended as a
snapshot: revisions accumulate in one store, keyed by the natural key across
time, and `timeline` and `replay` read them.

### `serve`
Opens the model browser on port 4177 (every interface unless `--host` narrows
it): ONE page over the model, built from one graph under one view. Its tabs:
**Navigate** — a searchable, virtualized tree (modules → types → members) and,
for the selection, incoming and outgoing dependencies classified by role, with
the member that carries each, its provenance and its source anchor; **City** —
the 3D code city, full-width, where a selected building's panel offers *Open
in navigator* and lands on that type's Navigate entry with its dependencies;
**Graph** (Cytoscape), **Cycles** (the precomputed tangle report) and
**Coupling** (ranked metrics). The city's channels are the `city` flags
below, so the page's city is exactly the artifact `city` would write. The
server hands out `/navigator.json` and `/city.json`; stdout stays empty.

### `city`
Writes the code-city artifact (`city.json`): modules as districts (nested when
the model declares package containment), types as buildings whose height and
footprint follow the chosen metrics, type dependencies as roof-to-roof arcs.
`--layout` adds placement (the viewer needs it). Built-in
metrics: `degree`, `fanIn`, `fanOut`, `fields`, `loc`, `members`, `methods`,
`one`; open forms `attribute:<key>` and `sum:<key>` reach any measure the
extractor emitted (`--height sum:cyclomatic` builds the complexity city).
Unmeasured metrics are drawn at the channel minimum and labelled unmeasured.

### `navigator`
Writes the navigator artifact (`navigator.json`): the tree, one classified
dependency row per base edge, and the cycle/coupling reports. Type and module
nodes carry their entity id, which is how the city's buildings address them.

### `domain-facts`
One JSON artifact (`codegraph.domainFacts/1`) with one dossier per corpus
type, every fact the model holds about it pre-joined: annotations with their
written arguments, fields joined to their declared types, operations with
their invocations, accesses and throw sites. `--framework spring` adds the one
inference layer (stereotypes, entry points, injection candidates), labelled as
such. Deterministic: two runs over one model are byte-identical.

### `explain`
Walks the graph bottom-up — leaf operations, then callers, then owning types,
then modules — and asks a language model to explain each unit, feeding every
prompt the explanations already written for the unit's dependencies. Output is
the side-car `<model>.insights.jsonl`; `model.jsonl` is never touched.
Mutually dependent units (a cycle) are explained as one unit. Re-runs redo
only what changed (Merkle fingerprints over inputs, never over explanation
text). Needs `OPENROUTER_API_KEY`, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` [+ `CLOUDFLARE_AI_GATEWAY_ID`], unless `--dry-run` or
`--estimate`. Design record: [insights.md](insights.md).

### `scm`
Mines a repository's git history into a deterministic `history.jsonl`:
repo-scoped, language-agnostic, one `git log` pass, rename chains resolved so
one surrogate names one file lineage. Author identity is the `Name <email>`
pair, `.mailmap` applied when present.

### `snapshots`
Extracts a repository at sampled revisions (`--every N` commits or `--tags`),
each in a throwaway `git worktree`, with the given extractor jar, and appends
each frame to the temporal store. Resumable: revisions already held are
skipped; failed frames are isolated and reported with exit `3`.

### `history`
Reports over a mined history: `summary`, `hotspots` (churn), `authors`,
`coupling` (co-change), and two joins with a model (`--model`): `hidden` —
co-change the declared graph cannot explain — and `deadweight` — declared
dependencies history never exercised. `--serve` opens the file-level city
replay, a Gource-style timeline over the commits.

### `timeline`
One entity's life across a temporal store: when it appeared, when it was last
seen, its LOC series per revision (derived at query time, never stored).

### `replay`
The temporal store as one laid-out city whose timeline scrubs the sampled
revisions: a frozen union layout, buildings rising at birth and sinking at
death, change heat and age as colour. `--history` joins ownership (an owner
colour mode) and co-change arcs, drawn dashed so they never pass for declared
facts.

### `profiles`
Prints the language profiles core ships — the per-kind required and optional
trait sets an extractor must respect.

## The Java extractor

```bash
cd extractors/java && ./mvnw -B package
java -jar target/codegraph-java.jar --src <dir> --out model.jsonl
java -jar target/codegraph-java.jar    # defaults: the current directory,
                                       # into <current-dir>-codegraph.jsonl
```

Spoon runs in noClasspath mode, so the sources need not compile and no
dependency jars are needed. What cannot be resolved becomes a stub with its
edges kept, so the picture is honest about its gaps. `--src` is repeatable:
one run over several roots resolves across them, which two separate models
unioned afterwards cannot. What the resolver cannot take is the *same package*
declared under several roots at once (main and test sources of one module,
or one package split across modules): pass those roots one at a time, or
exclude the test root.
