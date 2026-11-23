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
  reused afterwards by `analyze`, `export`, `navigator`, `vocabulary`,
  `domain-facts`, `serve`, `explain` and `walk`; on those, `--no-cache` reads
  the JSONL directly.

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

codegraph query    model.jsonl ["SELECT …"] [--file FILE] [--param NAME=VALUE]… [--param-file NAME=FILE]…
                   [--limit N | --all] [--json | --csv]
                   # ONE read-only SQL statement over the store, with the node
                   # and dep views; no sqlite3 needed
codegraph query    --views          # the SQL of the two views, for another client

codegraph serve    [model.jsonl] [--port N] [--host ADDR] [--name STR]
                   [--height METRIC] [--height-scale linear|sqrt|log]
                   [--footprint METRIC] [--footprint-scale linear|sqrt|log]
                   [--carry M1,M2] [--framework spring] [--history-metrics FILE]
                   [--internal-only] [--declared-only] [--no-cache]
                   # one page: the navigator, with the 3D city as a tab
codegraph serve    --app [--data-dir DIR] [--extractors FILE] [--port N] [--host ADDR]
                   [city flags as above]
                   # the desktop app's daemon: no model on argv, folders open
                   # through POST /jobs under a per-launch token; exits with stdin

codegraph city     [model.jsonl] [--layout] [--out FILE]
                   [--height METRIC] [--height-scale linear|sqrt|log]
                   [--footprint METRIC] [--footprint-scale linear|sqrt|log]
                   [--carry M1,M2] [--name STR] [--framework spring]
                   [--history-metrics FILE] [--internal-only] [--declared-only]

codegraph navigator [model.jsonl] [--out FILE]
                   [--name STR] [--internal-only] [--declared-only]

codegraph vocabulary [model.jsonl] [--level corpus|module|type] [--scope ID]
                   [--top N] [--class domain|technical|keyword|short|all]
                   [--weights KEY=N,…] [--technical FILE] [--drift FILE]
                   [--drift-insights [--insights FILE]]
                   [--out FILE] [--svg FILE] [--json] [--internal-only]
                   [--declared-only]

codegraph domain-facts [model.jsonl] [--framework spring] [--out FILE]
                   [--internal-only] [--declared-only]

codegraph explain  [model.jsonl] [--src DIR] [--out FILE] [--dry-run]
                   [--estimate [--price-in USD --price-out USD]]
                   [--provider auto|openrouter|cloudflare|claude-code]
                   [--claude-path FILE]
                   [--model SLUG] [--rollup-model SLUG] [--depth N]
                   [--max-calls N] [--max-tokens N] [--scope IDS]
                   [--include SEL]... [--exclude SEL]... [--levels LEVELS]
                   [--closure none|dependencies|containers|all]
                   [--instructions TEXT|@FILE] [--walk FILE]
                   [--concurrency N]
                   [--max-lines N] [--max-scc N] [--terms N] [--force] [--retry-failed]
                   [--export | --import FILE] [--yes] [--json]
                   [--framework spring] [--internal-only] [--declared-only]

codegraph walk     [model.jsonl] [--walk FILE|explain] [--prompt TEXT | --prompt-file FILE]
                   [--instructions TEXT|@FILE] [--name N]
                   [--include SEL]... [--exclude SEL]... [--levels LEVELS]
                   [--closure none|dependencies|containers|all]
                   [every run flag of explain but --scope and --terms]
codegraph walk     --print-definition [explain]
                   # a codegraph.walk/1 file to start from; no model read

codegraph insights [model.jsonl] [--store FILE] [--walk N] [--json]
                   [--id ID | --failures | --runs |
                    --word WORD | --glossary MODULE_ID | --polysemy | --concerns |
                    --level operation|type|module --concept NAME
                    --min-confidence X --max-confidence X --limit N]

codegraph scm      [repo] [--since DATE] [--out FILE] [--json]

codegraph snapshots [repo] --jar FILE (--every N | --tags)
                   [--store FILE] [--src DIR] [--json]

codegraph history  [history.jsonl] [--top N] [--json]
                   [--report summary|hotspots|authors|coupling|hidden|deadweight]
                   [--min-support N] [--min-confidence PCT] [--model FILE]
                   [--rank classic|branchy|tangled|fragile]
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

### `query`
Runs one SQL statement over a model's store and prints its rows — the SQLite
that builds the store is in the binary, so no `sqlite3` is needed
([SQL cookbook](sql-cookbook.md) for the schema and the recipes). The model
comes first and is required; the statement follows it, quoted, or comes from
`--file`. A `model.db` is accepted in place of the model. The two helper
views, `node` (one row per entity, with the rendered id every report prints)
and `dep` (one row per edge, its names resolved), are created for every run;
`query --views` prints their SQL for another client.

```bash
codegraph query app.jsonl "SELECT kind, count(*) AS n FROM node GROUP BY kind ORDER BY n DESC"
codegraph query app.jsonl --file reach.sql --param id='java:com.acme.order/Order.discount(int)' --json
```

**It never writes**, and that is held twice: the store is opened read-only,
and the text must be ONE statement beginning with `SELECT`, `WITH`, `VALUES`
or `EXPLAIN`. The second rule is not redundant — a read-only SQLite handle
still executes `VACUUM INTO 'file'`, which writes a copy of the database
anywhere on disk — and a second statement after a `;` is refused rather than
silently ignored, which is what SQLite itself would do with it.

**Parameters are bound, never pasted into the text:** `--param NAME=VALUE`
binds `:NAME`, so an id with parentheses, commas or quotes needs no escaping.
A value that is a whole or decimal number is bound as a number, anything else
as text. A parameter the statement names and nobody gave is an error, not a
NULL: SQLite would bind NULL, return no row, and that would read as "there
are none".

**One statement builds on another's saved rows:** `--param-file NAME=FILE`
binds `:NAME` to the whole text of a file, always as text. With a result saved
by `--json`, `json_each(:NAME, '$.rows')` gives one row per saved row, each an
array: `json_extract(r.value, '$[0]')` is its first column. So a list of ids
is never retyped on a command line, and what a result was computed from is a
file that can be opened. One name is bound once: by `--param` or by
`--param-file`.

The rows go to stdout as an aligned table, as CSV (`--csv`) or as a
`codegraph.queryResult/1` document (`--json`: `columns`, `rows` as arrays,
`total`, `truncated`). At most 50 are printed unless `--limit N` or `--all`
says otherwise; which store answered and how many rows there were — "0 rows."
included — go to stderr. Every refusal, SQLite's own included, is a usage
error (exit 2) carrying SQLite's message; a file that is not a model is a
finding (exit 3), as everywhere.

### `serve`
Opens the model browser on port 4177 (every interface unless `--host` narrows
it): ONE page over the model, built from one graph under one view. Its tabs:
**Navigate** — a searchable, virtualized tree (modules → types → members) and,
for the selection, incoming and outgoing dependencies classified by role, with
the member that carries each, its provenance and its source anchor; **City** —
the 3D code city, full-width, where a selected building's panel offers *Open
in navigator* and lands on that type's Navigate entry with its dependencies;
**Graph** (Cytoscape), **Cycles** (the precomputed tangle report),
**Coupling** (ranked metrics) and **Vocabulary** — the words of the selected
scope's names (the corpus until a module or a type is selected; a member
shows its type) as the cloud `vocabulary --svg` draws, measured in the page's
font, and as a table of weight, occurrences, carriers and spread, with class
chips and a top-N slider. The city's channels are the `city` flags below, so
the page's city is exactly the artifact `city` would write. The server hands
out `/navigator.json`, `/city.json` and `/vocabulary.json` (the vocabulary
under its default weights and technical list); stdout stays empty.

Clicking a word on the Vocabulary tab lists **the names that carry it** in
that scope, heaviest first, each one click from its node in Navigate (a
member reveals its type). The artifact counts and never lists, so this is the
server's second lookup, `/carriers.json?term=WORD[&scope=ID][&class=CLASS][&limit=N]`,
answered from the model it holds: the row's weight, occurrences and carriers,
and the first `limit` (200) of them, whose weights add up to the row. An
unknown scope or term is `404`; a request with no term, a class that is none
or a text the scope speaks as two terms (`class` then chooses) is `400`.

When `explain` has been run, a selected type or module also shows **what the
model wrote about it** — the description, the domain concept, the model and
its claimed confidence, and the structured block on demand — marked as an LLM
inference in the same colour and badge family as a `derived` dependency, never
as an extracted fact. That comes from the server's one route that is not an
artifact, `/insight.json?id=…`, looked up in `<model>.insights.db` beside the
first model (or `--insights FILE`) when asked for. With no store the route
answers 404 and the page looks exactly as it did.

`--insights FILE` may also name a walk's store (`<model>.N.walk.db`, written by
`walk`): the server reads whichever walk the store's header names, and the
panel shows that walk's answer in the same inference frame — the badge "LLM
answer", the walk's name, the model and its confidence, then the answer, every
declared field by its name, and the description. On a walk's store
`/insight.json` answers with one more key, `walk` (the walk's name), right
after `status` — on `explained`, `failed` and `unknown` alike, and never on
explain's answers, whose keys are unchanged — and `/glossary.json` answers
`no-store`. One store per page: explain's or one walk's.

Over the same store, a clicked word on the Vocabulary tab also shows **what
the explanations under that scope said it means**: each module's
reconciliation (and the types that disagree on it), then each explained
entity's entry — its concern, sense and confidence, and the identifiers the
word is in — in the same inference colour and badge, each one click from its
node (an operation reveals its type). That is the server's third lookup,
`/glossary.json?term=WORD[&scope=ID][&limit=N]`: the entries of the entities
the model folds under the scope, as the carriers are, from the store's word
index; the first `limit` (200) of each list, and their totals. An unknown
scope is `404`, and so is having no store (the tab then shows nothing); no
term, or a limit that is no whole number, is `400`. Navigate's explanation
panel shows the same words for a selected type or module, with their
meaning, in its structured block.

**`--app`** is the same page as the daemon behind the desktop app (and the
development loop for it: run it from a checkout, open the URL in a browser).
No model on argv. It binds `127.0.0.1:0` unless `--host`/`--port` say
otherwise, prints exactly one JSON line on stdout — `{"port":N,"token":"…"}`
— and serves every route under `/<token>/`: the page, `app` (the registry
and the current project), `recent`, `navigator.json`, `city.json`,
`vocabulary.json` (no `carriers.json` or `glossary.json`: the daemon holds no
model or store between jobs, and the tab shows the counts without the names),
`POST jobs` with `{"src": DIR-or-model.jsonl, "extractor"?: NAME}` and the
`jobs/current` event stream (`started`, `phase`, `progress` — the
extractor's own stderr lines — `done`, `failed`; `idle` when nothing runs).
Anything outside the token is `404`; a request whose `Origin` is not the
page's own is `403`. One job at a time (`409` while one runs); a folder
several registered extractors claim is a `422` question the page asks, never
a guess; a `model.jsonl` opens with no extractor at all. `--extractors FILE`
is the registry, a JSON list of `{ name, path, extensions: [".java"],
launch?: exec|java|node, env? }` — the daemon runs an entry under the
extractor command-line contract and never names a language; without it only
`model.jsonl` files open. `--data-dir DIR` (default: the OS application-data
directory, `codegraph/` under it) holds each opened folder's `model.jsonl`,
its `model.db` cache, the two artifacts and a `project.json`, plus
`recent.json`; reopening a folder whose claimed files have not changed (path,
size, mtime) skips the extractor, and the build too when the flags have not.
The process exits when stdin reaches EOF or on SIGTERM, killing a running
extractor — the shell holds stdin open and closes it on window close.

**The single-executable image.** `./build.sh --ts --sea` folds the CLI, the
daemon and both frontends into one Node single-executable,
`packages/cli/dist-sea/<rid>/codegraph`, for the platform that builds it —
the desktop app's backend and a `codegraph` that needs no Node installed.
Every command above works from it unchanged; `serve` and `serve --app` serve
the page from the image's own assets. A `.js` extractor (`snapshots
--extractor`, a registry entry with `launch: node`) then runs under the
`node` on PATH, since the image is not one. Its gates —
`scripts/sea-smoke.mjs`, run by `test.sh` and CI on every platform — are
`--version`, `analyze` byte-identical to the ESM build, `serve --app`
answering the page, `walk` (both `--print-definition`s and a dry run over the
Java fixture) answering as the ESM build does, and `insights --walk` reading a
walk's store (summary and `--id`) as the ESM build does.

### `city`
Writes the code-city artifact (`city.json`): modules as districts (nested when
the model declares package containment), types as buildings whose height and
footprint follow the chosen metrics, type dependencies as roof-to-roof arcs.
`--layout` adds placement (the viewer needs it). Built-in
metrics: `degree`, `fanIn`, `fanOut`, `fields`, `loc`, `members`, `methods`,
`one`; open forms `attribute:<key>` and `sum:<key>` reach any measure the
extractor emitted (`--height sum:cyclomatic` builds the complexity city).
With the change-history side-car `codegraph-metrics --history` writes beside
the model (or `--history-metrics FILE`), `history:<measure>` reads the type's
own blame and `history-file:<measure>` its file's history
(`--height history-file:churn_recent`; docs/metrics.md §4).
`vocabulary:<word>` is the word's weight in the names of the type and its
members — the Vocabulary tab's type scope, under the default weights — so
`--height vocabulary:order` shows where `order` lives. A type whose names
never say the word weighs 0; a stub, whose names the vocabulary never reads,
is unmeasured; a word no name in the view says is a usage error.
Unmeasured metrics are drawn at the channel minimum and labelled unmeasured.

### `navigator`
Writes the navigator artifact (`navigator.json`): the tree, one classified
dependency row per base edge, and the cycle/coupling reports. Type and module
nodes carry their entity id, which is how the city's buildings address them.

### `vocabulary`
The words the model's names are made of (never source): each `TNamed`
entity's name split into words, classed `domain`, `technical`, `keyword` or
`short`, and weighted by the role of what carries it. A type's or module's
name weighs 8, an attribute's 4, an operation's 3, a parameter's or local's
1, and the qualifier of a qualified name (`com.acme` of `com.acme.order`) 1.
No flag prints the corpus's 40 heaviest domain words; `--level module|type`
one block per scope, ranked by distinct terms (the cognitive-load report);
`--scope ID` one module or type, or an operation counted on demand.
`--weights` and `--technical FILE` change the scheme, and the header says
which one counted. `--drift FILE` compares with a glossary, one business term
per line: the terms no scope of `--level` says (exit `3`), the ones it says
and where, and the domain words no term contains. `--drift-insights` sets the
classes against what `explain` judged (M19c): it reads the insights store beside
the first model (`--insights FILE` names another), classes each word a model
defined as the list does in that entity's language, and lists the technical
words a model called domain somewhere, then the domain words it called
technical, the most judgements against first (`--top N` per list, 40 by
default), each with the judgements against it, surest first: confidence,
sense, and the identifiers in which entity (five per word, and how many more:
`--json` lists every one). With `--drift FILE` it adds the business terms against both: each
word's class and the model's concerns, and why the term drifts (`list`,
`model`). The judgements are inferences and never set the exit code; `--drift`
still exits `3` on a term the corpus never says. `--scope`, `--level`,
`--class` and `--svg` do not apply to it; records of entities the model or the
view does not have, and records explained under prompt 1, are counted on stderr.
`--json` gives `report: "drift-insights"`. `--out FILE` writes the
`vocabulary.json` artifact (`codegraph.vocabulary/1`) beside the report.
`--svg FILE` draws the cloud of the one scope reported — the corpus, or
`--scope`'s — from the words `--class` and `--top` pick: size on the square
root of the weight, colour by class and nothing else, a legend stating the
scope, weights, view and technical list, the same bytes on every run.
[`vocabulary-broadleaf.svg`](vocabulary-broadleaf.svg) is BroadleafCommerce's,
drawn with `--top 80`. One word across the city is the `city` metric
`vocabulary:<word>` (above):
[`vocabulary-city-broadleaf.png`](vocabulary-city-broadleaf.png) is
BroadleafCommerce's city with `--height vocabulary:order`. Design record: [vocabulary.md](vocabulary.md).

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
the side-car `<model>.insights.jsonl`; `model.jsonl` is never touched. The
working copy is a SQLite store beside it, `<model>.insights.db` — every
finished unit is committed as it arrives, so a killed run loses nothing it paid
for, and the side-car is that store's export, written when a run ends. The
store is **not a cache** (unlike `model.db` it is never rebuilt: a newer or
foreign one is a usage error, and there is no fallback without SQLite); a
side-car with no store beside it is imported by the first run that writes, and
one edited by hand is warned about and overwritten unless taken with
`--import FILE` (replaces the store's records; asks, or `--yes`). `--export`
writes the side-car from the store and stops — after an interrupted run, or a
deleted file. Neither flag reads the model or needs a key.
Mutually dependent units (a cycle) are explained as one unit. Re-runs redo
only what changed (Merkle fingerprints over inputs, never over explanation
text). The model calls go through one of three adapters of one port
(`LlmClient`, in `@codegraph/llm`): `--provider openrouter` needs
`OPENROUTER_API_KEY`; `--provider cloudflare` (AI Gateway) needs
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` [+ `CLOUDFLARE_AI_GATEWAY_ID`];
`--provider claude-code` needs an installed and logged-in Claude Code and no
key — it runs the CLI in headless mode (`claude -p`), one process per call, so
`--concurrency N` is N processes and `--max-tokens` does not apply (the CLI has
no output cap; the flag is noted and ignored). The binary is `--claude-path
FILE` (which implies `claude-code` under `auto`, and is refused with a key
provider), else `CLAUDE_CODE_PATH`, else `claude` on `PATH`, else the known
install locations; naming one that does not exist is an error, never a
fall-through.
On Windows, an npm-global `claude.cmd` is found but cannot run (the adapter
spawns without a shell, and Node refuses `.cmd`/`.bat` there: `EINVAL`); use
the native installer's `claude.exe` (`%USERPROFILE%\.local\bin\claude.exe`),
with `--claude-path` if needed.
`auto` (the default) takes the one that is configured, and with several
OpenRouter, then Cloudflare, then Claude Code: a key is deliberate, an
installed CLI is ambient. `--dry-run` and `--estimate` need none of it. A
fourth adapter, the Anthropic API with an API key, is a named slot for later
(PLAN.md §21.6). `--model SLUG` overrides the model for every unit; it defaults
per provider: `openai/gpt-5.6-luna` (`author/model` form) on OpenRouter and
Cloudflare, `sonnet` on Claude Code — an alias the CLI resolves to the latest
Sonnet. The fingerprint carries the slug as requested (`sonnet`), each
record's `model` the id that served (`claude-sonnet-5-5`): a new Sonnet
behind the alias does not re-explain what was explained; a full id in
`--model` does. The trailer's cost on Claude Code is the CLI's
`total_cost_usd` at list price — a subscription is billed by its plan.
`--rollup-model SLUG` overrides it again for types and modules. The slug is
part of each record's fingerprint, so a new model re-explains what it covers.
A run that makes model calls first prints its token estimate on
stderr and asks `[y/N]`; `--yes` (`-y`) skips the question, and without an
interactive terminal it is required. A unit that could not be explained exits
`3` and leaves a failure record (`t:"f"`: entity, reason, HTTP status) in the
side-car; `--retry-failed` redoes just those units and their direct
dependents. A `401`/`402`/`403` aborts the run instead of failing every
remaining unit the same way; `--max-tokens N` caps what one answer may cost,
which on a prepaid account is what keeps a low balance from refusing every call.
Each unit is also asked for the meaning of the words its names spell (`words`:
its own name, an operation's parameters, a type's fields, split as `vocabulary`
splits them), and a module reconciles what its types said into a `glossary`
of its heaviest `--terms N` words (default 60) that a type defined. Design record: [insights.md](insights.md).

`explain` is the built-in walk of the engine `walk` runs on (below), and takes
its selection and its instructions the same way, without changing its question,
its blocks or its store. `--include SEL` / `--exclude SEL` (repeatable, one
selector term each, any of them; exclude wins), `--levels a,b` and `--closure
none|dependencies|containers|all` choose the units asked; `--scope a,b` is
`--include id:a --include id:b` — a unit is explained when its member, its
nearest type or its nearest module is one of the ids, so a sub-package is not
reached through its parent (`--include 'module:com.acme.order**'` is the
sub-tree) — and keeps its own check that each id exists. `--instructions
TEXT|@FILE` appends a paragraph to every system message. `--walk FILE` reads a
`codegraph.walk/1` file that may set `select`, `exclude`, `levels`, `closure`,
`context`, `prompt.instructions` and `prompt.entities` (instructions for the
members a selector selects), and is refused for `prompt.task`, `answer`,
`trivial`, another name or version; a flag replaces the file's key. Trivial
members stay templated whatever the selection. A customized run keeps kind
`codegraph.insights/1` and `<model>.insights.db`; its header gains `walk: {
name: "explain", version: "2", digest }` (the digest over the instructions),
and a unit no instruction reaches keeps its fingerprint. When the store already
holds records and the customization changed, the plan's first line (stderr
under `--json`, and before the confirmation's question) says how many units are
asked again and their records replaced. The plan and the estimate print what a
selection leaves unwalked (`selection: N dependencies of the selection are not
walked (…); without a record, shown as NOT EXPLAINED`) and what the next `--closure` would add.
`--retry-failed` meets neither `--scope` nor a selection flag. Explain's JSON
kinds and their keys are unchanged.

### `walk`
Asks a question of the user's of every selected unit, bottom-up, on the engine
`explain` runs on — the same units, cycle-condensed order, context packs,
fingerprints, plan, confirmation, store discipline and retry. The question is
`--prompt TEXT` (or `--prompt-file FILE`: one task at every level) or a
`codegraph.walk/1` definition, `--walk FILE`: a task per level, instructions
for every prompt and for the members a selector selects, and the fields each
answer carries in a closed grammar (`"string"`, `"number"`, `"boolean"`,
`"string[]"`, `{ "enum": […] }`, `{ "list": { … } }`, each object form
optionally `"nullable": true`). Every answer also carries `answer`, a
`description` of at most 60 words — the line the units above it are shown —
and `confidence`. Neither flag: the default definition (name `adhoc`, a neutral
task). `walk --print-definition` prints it with every key spelled, and
`walk --print-definition explain` prints explain's; neither reads a model.

`--include SEL` / `--exclude SEL` take one selector term each, repeatable —
`id:ID`, `kind:K`, `trait:T`, `lang:L`, `name:GLOB`, `module:GLOB`,
`file:GLOB`, `edge:KIND[>TERM]`, `edge-in:KIND[<TERM]` — and a unit is asked
when its member, its nearest type or its nearest module matches an include and
none matches an exclude. `--levels` and `--closure` are as for `explain`; a
definition's `trivial` is `skip` by default, so trivial members are not asked
(and are shown NOT EXPLAINED to their dependents) unless it says `ask`. The
walk is built over the whole model whatever the selection. `--name N`,
`--instructions`, `--depth` and `--max-lines` replace the definition's keys;
every flag is folded into the definition before it is parsed, so a fault names
its flag (`name (from --name): …`) and the digest is the effective
definition's. `--walk explain` runs explain itself under walk's JSON kinds, on
explain's store; it refuses `--prompt`, `--prompt-file` and `--name`.
`--retry-failed` takes its selection from the failure records and refuses
every selection flag. Every other run flag is explain's (`--src`, `--out`,
`--provider`, `--claude-path`, `--model`, `--rollup-model`, `--max-calls`,
`--max-tokens`, `--concurrency`, `--max-scc`, the view flags, `--no-cache`,
`--dry-run`, `--estimate` and its prices, `--force`, `--export`, `--import`,
`--yes`, `--json`) through one shared option table.

A walk named N works against `<model>.N.walk.db` and exports
`<model>.N.walk.jsonl` (`--out FILE`: the side-car at FILE, the store beside it
with `.db`), header kind `codegraph.walkRecords/1` with `walk: { name, version,
digest, answerDigest }`. A store is opened only by the walk that wrote it: one
of another name, explain's included, is refused with its bytes untouched, and
so is one of this name written under other answer fields (`--name OTHER` keeps
both). A changed task, instructions, version or selection is not refused: the
first line of the plan, of the estimate and of the confirmation says `note: the
definition changed since this store was written: these N units are asked again
and their records REPLACED; --name OTHER keeps both.` — declined, nothing is
written. `--json` prints `codegraph.walkPlan/1` (`kind, walk, models, depth,
estimates, steps[, price]`), `codegraph.walkEstimate/1` (`kind, walk, models,
depth, units, layers, calls, promptTokens, completionTokens, byLevel,
byStatus[, priceIn, priceOut, cost], assumptions[, price]`) or
`codegraph.walkSummary/1` (`kind, walk, out, counts, usage, failures[,
aborted]`); `walk` is `{ name, version, digest }`, `price` the selection's
price per level. The output-token figure is measured, per block asked for:
operation 500, type 620 — the means of one live run (Spring PetClinic, `sonnet`
through Claude Code, a walk declaring no field); a module, never measured,
takes the type's figure, and a declared field adds nothing to the estimate,
though it adds to the answer. The estimate's `output ≈` line and
`assumptions.completionTokens` say so. Exit codes are explain's: `3` when a unit failed or the load was not
clean, `2` for every refusal. Reference: [insights.md](insights.md) IN-9.

### `insights`
Asks the insights store what `explain` — or a walk — has written, and opens
nothing else: not the model (its path only says *which* store; `--store FILE`
names one directly), not the side-car, no provider. `--walk N` reads the walk
N's store, `<model>.N.walk.db`; `--store FILE` alone reads whichever walk's
store the file's header names, and with `--walk N` the file must be N's
(another walk's store is refused, untouched). No flag, or `--walk explain`, is
explain's store and explain's output, byte for byte. Any question over tens of thousands
of records is an index lookup, a fraction of a second. One question per
invocation:

- no flag — the summary: records by level, explained vs templated, the models
  and provider, types by domain concept, what is owed, what these records cost
  (from their own usage, so it survives an import) and the run ledger's total;
- `--level operation|type|module`, `--concept NAME` (types: `aggregate`,
  `entity`, `valueType`, `repository`…), `--min-confidence X` /
  `--max-confidence X` (what deserves a second look), `--limit N` — a list,
  one tab-separated line per record: id, concept, confidence, the
  description's first line. Made for `cut`, `sort` and a spreadsheet;
- `--id ID` — one explanation whole: envelope, description, block. An id that
  was asked for and **failed** is answered with the reason, exit `3`; an id the
  store has never heard of is a usage error;
- `--word WORD` — every explained entity whose names spell the word (looked up
  lowercase, as `vocabulary` splits names), grouped by module: one
  tab-separated line per entry — the module, `glossary` or the entity's level,
  the id, the concern, the confidence, the sense, and the identifiers the word
  is in. Each module's own glossary entry comes first (its last cell lists the
  types' senses when the module flagged the word polysemous and they are two
  senses at least, case and spacing aside), then the module, its types, its
  operations. A record is placed by its natural key; one without a key is
  under `-`. The meaning is not shown: `--glossary` and `--id` show it;
- `--glossary MODULE_ID` — a module's glossary whole, one line per word: the
  word, the concern, sense and meaning the module reconciled from its types,
  and the types' senses where they disagree;
- `--polysemy` — the words a module flagged, its types giving two senses at
  least (a flag over one sense is not counted), and the words two modules'
  glossaries define differently (in concern or sense, case and spacing aside):
  every module's entry for each, side by side, the most senses first. No
  model call judges them across the corpus: a human does;
- `--concerns` — per module: how many distinct words its records define, and
  how many the model called `domain`, `technical` and `ambiguous` (a word two
  units judged differently counts under both), the most-worded module first;
- `--failures` — the units still owed, with the reason each failed;
- `--runs` — the ledger, oldest first: when, which models, what each run
  explained and spent.

On a walk's store the summary names the walk, its version and its definition
digest; a list prints id, level, confidence and the description's first line;
`--id` prints the block field by field in stored order (`answer:` first,
`description:` last, a list one `- item` per line, `—` for `null` or an empty
value); `--failures` and `--runs` are as above. The records are read as stored,
whatever answer fields the walk's definition declares today. `--concept`,
`--word`, `--glossary`, `--polysemy` and `--concerns` ask for what only explain
writes, and answer **none**: exit `0`, nothing on stdout, the reason on stderr
(`none: a walk's blocks carry no concept — the walk "N" answers its own fields;
…`), and under `--json` one document
`{"kind":"codegraph.insightsNone/1","walk":"N","asked":"--word","none":"a walk's blocks carry no words"}`.

`--json` makes each answer one kind-tagged document (`codegraph.insightsSummary/1`
— on a walk's store with `walk` right after `kind` —, `…List/1`, `…Word/1`,
`…Glossary/1`, `…Polysemy/1`, `…Concerns/1`, `…Failures/1`, `…Runs/1`,
`codegraph.insightsNone/1`; `--id --json` is the record exactly as the side-car
carries it).
A record a model explained under prompt 1 defines no words, so the word
answers cannot see it: they say on stderr how many such records there are,
the summary counts them, `--id` says so on the record, and `--glossary` on
such a module says why it has none. The next `explain` re-explains them. The command writes nothing: the store is opened as a
reader, a missing one is a usage error rather than a file that appears, and one
written by a newer codegraph — or a SQLite file that is not an insights store —
is named and left alone. One an older build wrote is refused and left alone too:
any `codegraph explain` on it migrates it, `--dry-run` included, which calls no
model.

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

`hotspots` and `summary` join a model too, but only when `--model` names one;
without it they are the history's own reports, whatever sits in the directory.

- `--report hotspots --model FILE` is effort times complexity. Each file the
  history and the model both know gains its source lines (`SLOC`, counted
  once: a nested type is inside the type around it), its cyclomatic complexity
  summed over its operations, the size of its dependency cycle (`CYCLE`, on
  declared dependencies folded to files; 0 when it is in none) and its rank in
  four families: `classic` (revisions × lines), `branchy` (revisions ×
  cyclomatic), `tangled` (revisions, for a file in a cycle), `fragile`
  (revisions × fix density, which is the fixes). `--rank` chooses the order
  (default `branchy`). A score of 0 is not ranked: `-` in the table, `null`
  in the JSON, as is a measure nothing in the file carries. Each row also
  says who holds the file WITHOUT A NAME: `ownerShare` (the main author's
  share of the lines added), `ownerRank` (that author's row in `--report
  authors`, from 1 — two files with one rank have one owner; the table prints
  both as `75% #2`) and, in the JSON, `ownerLastSeen`, the day that author
  last committed anywhere in the history. The names are `--report authors`'
  to give. stderr says how many
  history files found no counterpart in the model.
- `--report summary --model FILE` adds `cross-module`: of the commits that
  touch the model, the share that touch two or more of its top-level
  directories (the first path segment below the directory all its files
  share). Commits over 30 files are left out and counted on stderr.

A `--model` that is readable and is not a model is a finding, exit `3`, for
every report that reads one: no report is printed over an empty join.

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
trait sets an extractor must respect, the edge kinds, the lexicon the
vocabulary reads (reserved words, conventional names, technical words, file
kinds, qualified kinds and their separators), and the notes. `--lang L` prints one profile in full; `--json` prints
the data as `{kind: "codegraph.profiles/1", profiles[]}`.

## The Java extractor

```bash
cd extractors/java && ./mvnw -B package
java -jar target/codegraph-java.jar --src <dir> --out model.jsonl
java -jar target/codegraph-java.jar    # defaults: the current directory,
                                       # into <current-dir>-codegraph.jsonl
```

From the repo root, `./bin/codegraph-java` runs the same jar with the same
flags, on the first Java 17+ in `JAVA_HOME`, on `PATH` or under `~/.sdkman`.

Spoon runs in noClasspath mode, so the sources need not compile and no
dependency jars are needed. What cannot be resolved becomes a stub with its
edges kept, so the picture is honest about its gaps. `--src` is repeatable:
one run over several roots resolves across them, which two separate models
unioned afterwards cannot. What the resolver cannot take is the *same package*
declared under several roots at once (main and test sources of one module,
or one package split across modules): pass those roots one at a time, or
exclude the test root.
