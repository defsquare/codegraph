# Insights — design record

`codegraph explain model.jsonl --src DIR` walks the extracted graph bottom-up
— leaf operations first, then their callers, then the types that own them,
then the modules — and asks a model to explain every unit in natural language,
feeding each prompt the explanations already written for what the unit depends
on. The result is a **side-car** file, `<model>.insights.jsonl`, that carries
one record per operation, type and module: a prose description and a
structured block in the vocabulary of the Specy domain metamodel. The side-car
is what a later domain-extraction step (a Specy skill) reads instead of the
source; it never touches `model.jsonl` or `model.db`.

The city answers *what does this codebase look like*; the navigator *what
depends on what*. The insights answer *what does it mean* — and they are the
only artefact in the pipeline that is not a pure function of the model, which
is why they live beside it.

---

## IN-1 · Two packages, one seam

    @codegraph/insights   pure: units, walk order, context packs, prompts,
                          fingerprints, plan, run, side-car format
    @codegraph/llm        the model clients: LlmClient + OpenRouter (SDK) +
                          Cloudflare AI Gateway (REST, plain fetch) + a fake

`insights` depends on `core` and `analyzer` only and does no I/O: source text
arrives through an injected reader, the model call through an injected
`Completer`, finished records leave through a hook. `llm` is the **only
package allowed to import the provider SDK** — `packages/llm/test/boundary.test.ts`
scans the workspace for the import, and `eslint.config.js` restricts it. The
CLI wires the two: it owns the filesystem, the environment variable
(`OPENROUTER_API_KEY`) and the progress narration.

The provider SDK is itself held behind a one-function `OpenRouterTransport`,
so every request/response/error path is driven by a fake transport in tests,
and an SDK change is repaired in one file.

**Two providers, one contract.** Both speak OpenAI's chat-completion shape,
parsed once in `chat.ts`. What differs: OpenRouter goes through its SDK
(camel-cased request and reply, its own API key per request); Cloudflare AI
Gateway goes through the AI REST API on `api.cloudflare.com` with plain
`fetch` (snake_case wire, one Cloudflare API token that both authenticates
and bills through Unified Billing or a stored provider key, an optional
`cf-aig-gateway-id`). Model names are the same `author/model` form on both,
so switching the route leaves every fingerprint — and every reusable record
— intact. `providers.ts` resolves `--provider auto|openrouter|cloudflare`
from the environment in one place: the single configured provider wins;
with both configured OpenRouter stays the default and the choice is printed.
The side-car header records the provider that served the run.

## IN-2 · Units and the walk order

A **unit** is one thing the model is asked about:

- an **operation**: a method or constructor that is a direct member of a
  type. Lambdas and blocks are never units — their calls already roll up to
  the enclosing operation in the domain-facts dossier, and their source sits
  inside its span;
- a **type**: every non-stub corpus type the dossier covers;
- a **module**: every non-stub corpus module.

The walk orders units so each is explained after everything it depends on:

- operation → the operation units it calls (corpus calls only; a field access
  is context, never an ordering edge);
- type → the types it depends on (the analyzer's type dependency graph), its
  operation units, and the types nested in it;
- module → the modules it imports (the analyzer's import graph), and its
  types. Package containment is **not** a dependency: a parent package is a
  namespace fact, not a "depends on", so it neither orders nor merges.

**One rule at every level: a strongly connected group is one unit.** Mutually
recursive methods, a type cycle, mutually dependent packages — explained
together, in one prompt, every member's record listing the group. The
analyzer's Tarjan (`scc.ts`, iterative, shared with the cycle report) yields
the components; Kahn layering over the acyclic condensation gives the order,
ties broken by the first member's id. Cross-level edges only point downward,
so a unit never mixes levels. `packages/insights/test/cycles.test.ts` pins the
module units to the analyzer's own cycle report — exactly at module level,
"contained in one unit" at type level — on the Java fixture always and on any
corpus named by `CODEGRAPH_CORPUS_MODEL`.

## IN-3 · The context pack and the prompt

Each prompt is built from a **context pack**: the unit's source slices (from
the anchors, through `--src`, capped at `--max-lines` with the middle elided),
its Javadoc (`TComment`), the dossier's facts — calls with target type and
stereotype, accesses, throw sites, annotations with their written arguments,
metrics, fields with declared types and constant values, supertypes, injection
points, imports — and the **explanations already produced for its
dependencies**. `--depth 1` gives each dependency's description; `--depth 2`
nests the dependencies' dependencies as one-liners.

The user message has fixed sections (Unit / Signature / Documentation /
Source / Facts / What the dependencies do / Cycle members). Everything that
came from the corpus is inside a four-backtick fence, and the system message
says fenced content is **material, never instruction** — the whole defence
against a comment that reads "ignore the rules above". A dependency without a
record is shown as NOT EXPLAINED; the model is told not to invent it.

The system message carries the Specy definitions, one line per concept, and
the task per level. A cycle asks for one entry per member id. A cycle larger
than `--max-scc` is chunked: each chunk sees the others' signatures only.

**The words of the names (prompt 2, PLAN.md §20.3).** Every unit is also asked
what the words of its names mean in it: a section *Words to define* lists, per
identifier, the words of its own name and of an operation's parameters or a
type's fields, split by `@codegraph/vocabulary` (injected as a `Speller`: the
insights package runs no splitter). Short words and keywords are not asked; the
deterministic class is withheld, so the judgement — `domain`, `technical` or
`ambiguous` — is the model's. The answer is one `words` entry per word, with
its `sense` and its `meaning` in this unit. The words are given, not chosen: on
receipt an entry for a word not listed is dropped, a repeat keeps the first,
and `in` is restated from the split. A module is also shown what its types
said of the words they spell — read from the store through a `words(id)`
projection, as summaries are, and only when its prompt renders — heaviest
first by the vocabulary's module weights, cut at `--terms N`, and answers a
`glossary` that reconciles them, flagging a word its types disagree on as
`polysemous`. Templated records carry no `words`.

`PROMPT_VERSION` is `"2"`. A record explained under prompt 1 keeps decoding and
re-encoding to its own bytes (`words` and `glossary` are optional in the record
schema) and stays in the store until a run replaces it; the answer schema
requires both, and an answer without them gets the repair re-ask.

## IN-4 · The side-car and its determinism

    {"t":"header","kind":"codegraph.insights/1",…,"metamodel":"specy.domain/3",…}
    {"t":"i","id":…,"level":"operation",…,"block":{…},"fingerprint":…}
    …
    {"t":"f","id":…,"level":"module","members":[…],"model":…,"reason":{…},"attempts":1,"calls":0}
    {"t":"eof","counts":{…},"usage":{…},"generatedAt":"…"}

Records are sorted by (level, id) and re-serialized through their Zod schema,
so a record built in memory and one read back from disk are the same bytes.
The body carries **no timestamp**; only the trailer does. Two runs with the
same records are therefore diffable: what changed is what was re-explained.

The blocks follow `DOMAIN-METAMODEL.md`: every block has a `name` (the
ubiquitous-language name the model proposes) and a `description`; an
operation is a Specy *Operation* (safe, idempotent, owner, handled command,
emitted events, pre/postconditions, invariants enforced, SPIs used); a type
names the *concept* it realizes (entity, aggregate, valueType, enum,
repository, the three services, event kinds, interface roles…) with fields,
invariants and their enforcement, a state machine, relations; a module is a
Specy *Module* (APIs, SPIs, dependsOn, concepts, a bounded-context hint,
ubiquitous language, and for a package cycle a shared-kernel hint). The
vocabulary is restated as literals in `ddd.ts` with the source cited; the
header names the version.

Strict structured output needs every property required and no extras, so
"optional" is `.nullable()`, no numeric constraints are emitted, and
`confidence` is clamped on receipt. `schema.test.ts` asserts the generated
JSON Schema is strict-compatible.

### The side-car is an export: the store is `<model>.insights.db` (M16a)

`explain` does not work against that file. It works against a SQLite store
beside it, `<model>.insights.db` (PLAN.md §17), and writes the side-car **once,
atomically, when a run ends** — `[...store.export()]`, the same bytes the
encoder above produces. `decode → import → export` is the identity for any
decodable side-car: a fast-check property in `store.test.ts`, and checked on
BroadleafCommerce's 28 206 records (47.5 MB in, 47.5 MB out, `cmp`-equal; the
store is 57 MB).

The store is **not a cache**, and every rule `model.db` lives by is inverted
for it, for one reason — nothing it holds can be recomputed from the model:

| | `model.db` | `<model>.insights.db` |
|---|---|---|
| version mismatch | deleted, rebuilt | migrated (a ladder on `PRAGMA user_version`); a NEWER store is refused and its bytes left alone |
| a SQLite file that is not ours | rebuilt over | refused (`PRAGMA application_id`) |
| cannot be opened / no SQLite | silently read the `.jsonl` | a usage error naming the file — a second write path is how paid work gets lost |
| staleness | size + mtime of the model | per record: the fingerprint (IN-5) |

The envelope is columns (`id`, `level`, `fingerprint`, the natural key,
usage); `block`, `metadata`, `scc` and a failure's `reason` stay JSON text,
exactly as the side-car spells them — the block's shape moves with
`PROMPT_VERSION`, and tables per field would make every prompt change a
migration. `concept` and `confidence` are generated columns over the block, so
`SELECT id FROM insight WHERE concept = 'aggregate'` is an index lookup. Three
things the port's tests pin because SQLite would otherwise get them wrong
silently: **order is decided in JS** (the side-car sorts ids by UTF-16 code
units, SQLite by UTF-8 bytes — they disagree above U+FFFF); a **column string
holding U+0000 is refused** (`node:sqlite` reads TEXT back only up to it, so an
id would come back shorter); and the tables are **rowid tables** (`WITHOUT
ROWID` keeps kilobyte-wide rows in interior pages: 96 MB against 57 MB on
Broadleaf, for no faster read).

**Version 2: the words, projected (M19c).** `insight_word` holds one row per
entry of a block's `words`: the entry as JSON text, without its `meaning` (a
sentence, read from the block when an answer shows it), with `word`, `concern`,
`sense` and `confidence` as generated columns over it, indexed on `word` and
on `id`. "Every entity that defines `order`" is then an index lookup, where it
would otherwise scan every block. A record's rows are written with it, in the
same transaction, after the rows of the record it replaces are deleted, and
`--import` rebuilds the table from the blocks. Nothing is exported from it: the
block stays the one copy that counts, so `decode → import → export` is
untouched. Migration 1 creates the table and projects the words a version-1
block already holds. A build that asked prompt 2 while its store was still at
version 1 wrote some. It is the first rung of the ladder to run on a real file,
and its tests start from one the version-1 build wrote
(`packages/insights/test/fixtures/store-v1.sql`): the records, failures, ledger
and export stamp come through intact, the export is the same bytes, a reader
refuses the file untouched, and a migration that fails leaves it at version 1.

A `run` table is the one thing the store holds that the side-car does not: one
row per run — when, which models and provider, counts, usage, why it aborted.
The trailer only ever knew the last run. It is declared losable: delete the
`.db`, and the next run re-imports the side-car with everything that was paid
for and none of the ledger.

**The side-car's three encounters with the store.** *First contact*: a side-car
(or an older build's `.journal`) with no store beside it is read as before by
`--dry-run`/`--estimate`, which create nothing, and imported by the first run
that writes. *After every run*: the store records the exported file's size and
mtime. *An edit made outside* — a different size or mtime at the next run — is
**noticed, never obeyed**: a warning names the file and the remedy, the store
stays the working copy, and the run overwrites the file. `explain --import
FILE` is the one way a side-car overrides the store; it replaces paid-for
records, so it asks (or needs `--yes`). `explain --export` writes the side-car
from the store as it stands — after an interrupted run, or a deleted file —
and reads no model.

**What the walk reads of the store (M16b).** Not records — two narrower
questions, because they cost differently (`records.ts`). A *plan* asks
`fingerprint(id)` of every unit to decide `reuse`, and reads no block: one scan
of `(id, fingerprint)`, 7 MB on Broadleaf where the records are 68. A *prompt*
asks `summary(id)` of each dependency and part it quotes — the block's
`description` and the Specy word for it (`owned by aggregate`, the type's
concept, `context: Pricing`) — and only for a unit about to be sent: a
`DependencySummary`'s `summary`/`concept` are memoized getters, so building a
pack (which every plan does for every unit, its fingerprint needs the facts)
touches nothing. That is sound because the fingerprint hashes part *ids*, never
their text (IN-5). The store projects the summary in SQL (`block ->
'$.description'` — `->`, which keeps U+0000 as a JSON escape) and feeds the
same `conceptLabel` the in-memory path uses; a fast-check property pins the two
equal. The book keeps a summary once read: a popular callee is quoted by
thousands of callers, and re-reading a whole record per quote — the first cut —
was byte-identical and cost 1.5 GB and twice the time on Broadleaf.

A run `put`s each finished unit into the same book, and backed by the store
that put *is* the commit: `executeRun` holds no record, and a later unit's
prompt reads its dependencies back from where they were committed. The export
streams — ids sorted in JS, then 500 consecutive records at a time — so the
side-car never exists in memory. What this buys is bounded, and PLAN.md §17.3
says so with the numbers: the records were ~10 % of `explain`'s memory on
Broadleaf, the graph the rest.

**The store's readers (M16c).** A reader gets the store with `{ readOnly:
true }`: no migration, and SQLite itself refuses every write (`PRAGMA
query_only`). So a store an older build wrote is refused rather than read; the
refusal says that any `codegraph explain` on it migrates it, `--dry-run`
included, which calls no model. It is handed an ordinary connection rather than a read-only file
handle, because the latter — the first attempt — may not clean up after itself
and stranded `-wal`/`-shm` beside the model. What a reader asks never reads a
block: `query()` returns ROWS (envelope, description, and the same
`conceptLabel` a prompt quotes — one rule, whoever asks), `stats()` counts by
level, origin and type concept and sums the records' own usage (which survives
an import; the run ledger does not), `runs()` is the ledger, and
`answerInsight(store, id)` is the three-way answer every reader gives about one
id: *explained* (the record), *failed* (the unit's failure — matched by member,
so every member of a failed cycle is answered), or *unknown*. "No explanation"
is two different facts, and only one of them is silence.

Two readers answer about records (two more, `vocabulary --drift-insights` and
`serve`'s `/glossary.json`, about words: below). `codegraph insights` (cli.md) opens the store and nothing
else — not the model, not `explain.ts`, whose module graph is the provider SDK.
And `codegraph serve` answers `/insight.json?id=…`, its one route that is not an
artifact: tens of megabytes of prose do not belong in `navigator.json`, so a
selected node's explanation is looked up when asked for, over a reader opened on
first request (a store `explain` creates while the page is open is found). The
page restates the answer's `kind` as a literal pinned by a test, imports this
package not even for types, renders the block generically (its shape moves with
`PROMPT_VERSION`), asks once per id, and treats every absence — no store, no
such route, nobody asked — as nothing to show. What it does show wears the
page's inference colour and says who wrote it and how sure it claimed to be:
everything else on that page is extracted from source, and this is not.
Operations are not shown: a navigator member node carries no entity id, and
ids are never constructed.

**The words' readers (M19c).** `glossary.ts` rolls the records' `words` and
the modules' `glossary` up, over four more projections of the port:
`wordHits(word?)` (the `insight_word` index, joined to each record's envelope;
every entry with no word),
`glossaryEntries(word?)` (each module block's `glossary`, through `json_each`
over the module records alone), `concernRows()` (each module, word and concern
once) and `withoutWords()`. A record is placed in its module by its natural
key: core renders the module's id from the key's `lang` and `module`, and the
groups are compared through `naturalKeyIndex`. The id is never parsed; a record
without a key is placed nowhere, and still answered. The index holds what
`->>` made of a word, which for a lone surrogate (no identifier spells one; a
hand-edited side-car might) is not what the binding sends, so such a word is
looked for by a scan. Either way, what is returned is what equals the word
once parsed back from JSON. A record a model wrote under prompt 1 has no
`words`: `wordsAbsence(record)` says so (`prompt-1`, or `templated` for a record
no model wrote), and every report counts those records, since it cannot see
them. `codegraph insights --word`, `--glossary`, `--polysemy` and `--concerns`
print them (cli.md). On the synthetic store of Broadleaf's size,
`--word order` prints its 549 entries and 19 glossary entries in under half a
second, Node's start included.

One reader opens the store BESIDE the model: `codegraph vocabulary
--drift-insights` (cli.md). Only the model says which class the deterministic
rules give a word in an entity (the entity's language is the model's), so that
comparison cannot live in `insights`, which never opens the model. It reads
every entry through `wordHits()`, hands them to `@codegraph/vocabulary` in that
package's own shape (neither package imports the other), and sets the model's
concern beside the list's class, word by word, with the entities.

The page asks the same question of one word: `codegraph serve` answers
`/glossary.json?term=…&scope=…` with `answerGlossary(store, query, placement)`,
the entries of the entities under a module or a type, and the modules'
reconciliations. Which entities are under a scope is the model's (only the
model knows an operation's type), so the CLI hands in a `Placement` — each
kept entity's containing module and type, by the fold the vocabulary counts
with — and this package still opens no model. The route reads the store
`/insight.json` reads, through one reader. The kind (`codegraph.glossary/1`)
is restated by the page and pinned, and the page shows the entries in the
inference colour; the explanation panel reads a block's `words` and `glossary`
by name (`order (domain) — sense. Meaning. In Order · 0.90`), the one exception
to its generic rendering.

`@codegraph/insights` stays pure: `store.ts` is a port, and `store-sqlite.ts`
is handed an OPEN database, so the path, the file and `node:sqlite` itself
(one import site, in the analyzer's `store/sqlite.ts`) stay with the CLI.

## IN-5 · Fingerprints and incremental runs

Every record carries a sha256 over what it was computed from: the prompt
version, the model slug, the level, the source slices, the comments, the
signatures, a digest of the facts shown, the words its prompt asks to define
and a module's glossary words (so a lexicon correction re-explains exactly the
units whose words it changed, and another `--terms` exactly the modules whose
cut moved), the **fingerprints of the units it depended on**, and the ids of
dependencies that had no record. Merkle-style:
change one leaf's source and exactly its transitive dependents and containers
change; nothing else does. The explanation text is deliberately **not**
hashed — a non-deterministic answer must never cascade re-runs.

A re-run plans `reuse` for every unit whose members' records match; `--force`
overrides. Because a missing dependency is part of the fingerprint, a
dependent explained while its callee had failed or was out of scope is redone
once the callee exists.

## IN-6 · Budget controls

`--dry-run` prints the plan — every unit in walk order with its status, the
calls it will make, the estimated prompt tokens per level — and makes no call;
it needs no key. `--estimate` prints only the volume: calls, input and output
tokens per level, and a cost when `--price-in`/`--price-out` (USD per million
tokens) are given. Input is the rendered prompts at four characters per token;
output is one measured block average per block asked for (operation 450, type
650, module 900 tokens — averages from gpt-5.6-luna on the fixture and gson),
so a cycle call counts once per member. Repair re-asks and rate-limit retries
are not counted, and records already in the side-car are not re-sent. A real
run shows that same estimate on stderr and asks for confirmation before the
first call; `--yes` skips the question, and with no terminal to ask on the run
is a usage error rather than an unasked spend. A run that plans no call never
asks. `--max-calls N` stops planning calls after N, so what runs is
always a dependency-consistent prefix. `--scope IDS` restricts calls to units
inside the named modules or types; dependencies outside scope are reused when
already explained and never called. `--concurrency N` runs N calls in flight
within a layer; a rate-limited account (OpenRouter allows new accounts 20
requests a minute) is better served by `--concurrency 1`, and the client obeys
the provider's `Retry-After` on a 429 before retrying. `--model` and `--rollup-model` pick the leaf and the roll-up
model; a cheap model for operations and a stronger one for types and modules
is the intended split.

Every finished **unit** is one committed transaction in the store — all the
members of a cycle together, never half of one — so an interrupted run resumes
where it stopped. The store runs WAL with `synchronous = NORMAL`: a commit
survives the process dying (a kill, an OOM, Ctrl-C — what a long run meets)
without an fsync per unit; only a power cut can lose the last few commits,
never the file. At `FULL`, Broadleaf's 9 892 templated units cost 37 s of
fsync on a run that made no call. (Until M16a this was an append-only `<out>.journal` plus a
rewrite of the whole sorted side-car at every layer: 35 × 47 MB on Broadleaf.
A journal an older build left behind is merged once, on first contact.) A run
records its `pid`; the next run finding it unfinished asks whether that process
is alive — a live one is a usage error (two runs on one store pay twice for
the same units), a dead one is a note, its records and failures reused.

### Failures are records, and a retry reads them

A unit that was asked for and could not be explained used to be a line on
stderr and a count in the trailer — recognisable afterwards only by the record
it does not have. It now leaves a **failure record** (`t:"f"`) after the
insight records, sorted the same way: the unit id, the entities left without a
record (`members`; several for a cycle), the model asked, and the `reason` —
`kind` (`provider` when the call itself was refused or never answered,
`invalid-answer` when two answers in a row failed validation, `error`
otherwise), the provider's or validator's `message` verbatim, and the HTTP
`status` and the client's `retryable` verdict when there were any. `attempts`
counts consecutive failing runs; `calls`/`usage` say what the last attempt
spent for nothing. No timestamp: the body stays diffable. `insights` reads
`status`/`retryable` off the thrown error structurally, so it still imports no
client.

A failure record lives exactly as long as the gap it describes: a run that
explains the unit drops it, a run that fails again replaces it with
`attempts + 1`, and a run that did not attempt the unit (`--scope`,
`--max-calls`) carries it over unchanged. The trailer's `failed` is the number
of failure records in the body. In the store a failure is a row written **the
moment it happens** (`onFailure`), deleted in the same transaction that commits
its unit's records, and the table is replaced by what is still owed when the
run ends — so a run killed in the middle of a storm of refusals has already
said what was refused. (The journal never could: it carried records only, and a
killed run forgot its failures.)

`retryable` is about asking again *at once* (that is `withRetry`'s job, inside
one call). Whether a *later run* can succeed is the operator's call — a `402`
is `retryable: false` and entirely curable by adding credits — which is why the
retry is a command, not a loop: `--retry-failed` scopes the plan (`retryScope`)
to the failed units **plus their direct dependents**. Those were explained with
the failed unit shown as NOT EXPLAINED, and IN-5 makes them stale the moment it
exists; nothing further up moves, because a unit hashes its dependencies'
plan-time fingerprints, which a failure never changed. Everything else is
`reuse` or `skip-scope`. A plain re-run retries the same units too — it just
also picks up whatever else is owed (budget-skipped, changed source). The
retry must repeat the failed run's `--model`/`--depth`/`--max-lines`, which are
part of every fingerprint; a differing model or depth is noted on stderr, not
refused — retrying a context-length failure under a larger model is legitimate.

### A failure about the account aborts the run

A `401`, `402` or `403` (`FATAL_STATUSES`) is not about the unit that received
it: every later call would get the same answer. The first BroadleafCommerce
run showed what going on regardless costs — credits ran out in walk layer 17
and the remaining 604 units were each asked and each refused. So the run
aborts: calls in flight settle, no further call starts, templates and reuse
still happen, and the side-car is written as usual. The units never reached
are counted as skipped and reported as *not attempted* — they get **no**
failure record, because a failure record says a unit was asked for. That is
why the summary of an aborted run points at a plain re-run, which redoes the
failures and resumes the rest, rather than at `--retry-failed`, which would
miss what was never tried.

`--max-tokens N` is the other half of that lesson. With no `max_tokens` on the
request a provider assumes the model's whole output window (131 072 tokens on
the run above) and a prepaid account must be able to afford *that* for every
call — so a balance that would have paid for thousands more 1k-token blocks
refuses all of them. The cap is not part of the fingerprint: it changes what a
call may cost, not what it is asked. There is deliberately no default — models
differ in output window and in how much of it reasoning eats — and an answer
cut at the cap is reported as exactly that by `@codegraph/llm` (finish reason
`length`), not as broken JSON.

## IN-7 · Trivial members are templated

A getter, setter, `equals`/`hashCode`/`toString`/`compareTo`, or a
field-assigning constructor is described by a template, confidence 1, no
model call — decided from facts only: no throw site, no corpus call,
`cyclomatic ≤ 1`, and at most one field touched. Anything with a `throws`
fact or a corpus call is never trivial, however short.

## IN-8 · The one asynchronous command

The CLI is synchronous all the way down (core's `jsonl-file.ts` records why).
`explain` awaits the network, so `run` now returns `ExitCode | Promise<ExitCode>`:
every other command still returns a plain number, and the promise is settled
through the same exit-code mapping (`failure`), so a rejection can never escape
unhandled. `runSync` serves the in-process test helpers and throws if it meets
a promise.
