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

Since M21 the question is a parameter: `codegraph walk` runs the same engine
with a task of the user's — a prompt, or a `codegraph.walk/1` definition — over
the units a selection picks, into a store of its own; `explain` is that engine
with its own question built in (IN-9).

---

## IN-1 · Two packages, one seam

    @codegraph/insights   pure: units, walk order, context packs, prompts,
                          fingerprints, plan, run, side-car format, the
                          walk seam (WalkSpec), definitions, selection,
                          the store port and its SQLite adapter
    @codegraph/llm        the port, LlmClient, and its adapters: OpenRouter
                          (SDK), Cloudflare AI Gateway (REST, plain fetch),
                          Claude Code headless (a subprocess) + a fake

`insights` depends on `core` and `analyzer` only and does no I/O: source text
arrives through an injected reader, the model call through an injected
`Completer`, finished records leave through a hook. `llm` is the **only
package allowed to import the provider SDK** — `packages/llm/test/boundary.test.ts`
scans the workspace for the import, and `eslint.config.js` restricts it. The
CLI wires the two: it owns the filesystem, the environment (the keys,
`CLAUDE_CODE_PATH`, `PATH`) and the progress narration.

The provider SDK is itself held behind a one-function `OpenRouterTransport`,
so every request/response/error path is driven by a fake transport in tests,
and an SDK change is repaired in one file.

**One port, three adapters.** `LlmClient` (`client.ts`) is the port: one
structured completion in, parsed JSON out, one error type with `retryable`
decided once. Nothing above it — the run's `Completer`, the CLI's
`completerFor`, the store, the side-car — knows which adapter answered.
The two key adapters speak OpenAI's chat-completion shape, parsed once in
`chat.ts`: OpenRouter goes through its SDK (camel-cased request and reply,
its own API key per request); Cloudflare AI Gateway goes through the AI REST
API on `api.cloudflare.com` with plain `fetch` (snake_case wire, one
Cloudflare API token that both authenticates and bills through Unified
Billing or a stored provider key, an optional `cf-aig-gateway-id`). Model
names are the same `author/model` form on both, so switching the route
leaves every fingerprint — and every reusable record — intact.

The third adapter, **Claude Code headless** (`claude-code.ts`, PLAN.md §21),
is a subprocess: one `claude -p --output-format json` process per call, so
`--concurrency N` is N processes. It runs with `--safe-mode`, not `--bare`:
`--bare` restricts authentication to an API key and drops the subscription
login this adapter exists for, while `--safe-mode` keeps the login and
disables every customization (CLAUDE.md, hooks, plugins, MCP servers, output
styles); the default persona is replaced by `--system-prompt` and tools are
off (`--tools ""`), so the model can only answer. The user prompt goes
through stdin — a context pack with source can exceed Linux's 128 KB
per-argument limit — while the system prompt and the `--json-schema` ride as
arguments. The result JSON is read into the port's response:
`structured_output` is the parsed answer (fenced text through the shared
`extractJson` when a version lacks it), `usage` gives the tokens (input,
cache creation and cache read summed as what was sent), `total_cost_usd`
the cost (list price; a subscription is billed by its plan). The fingerprint
carries the slug as requested (`sonnet`), the record's `model` the id that
served (`modelUsage`'s key, `claude-sonnet-5-5`): a new Sonnet behind the
alias does not re-explain what was explained, a full id in `--model` does.
`--max-tokens` has no counterpart on the CLI and is noted, then
ignored. Like the SDK behind `OpenRouterTransport`, the process is held
behind a one-function seam (`ClaudeCodeProcess.run`): every test drives the
adapter with recorded stdout, stderr and exit codes, and nothing is spawned.

**Discovery and precedence.** `claude-code-discovery.ts` finds the binary as
a pure function of the flag, the environment and an `exists` probe — never a
process, so `--dry-run` resolves a provider without spawning — in this
order: `--claude-path`, `CLAUDE_CODE_PATH`, `claude` in each directory of
`PATH`, then the install locations the docs name (`~/.local/bin/claude`,
`~/.claude/local/claude`, Homebrew's, and on Windows
`%USERPROFILE%\.local\bin\claude.exe` and `%APPDATA%\npm\claude.cmd`). An
explicit path that does not exist is an answer naming it, never a
fall-through to another binary. One Windows limit: a found `claude.cmd`
cannot be run — the adapter spawns without a shell, and Node refuses
`.cmd`/`.bat` there (`EINVAL`, the CVE-2024-27980 mitigation) — so the run
fails with `claude-code: cannot run …\claude.cmd: EINVAL`; the native
installer's `claude.exe` works, and `--claude-path` can point at it.
`providers.ts` resolves `--provider
auto|openrouter|cloudflare|claude-code` in one place: a key provider is
configured when its variables are set, Claude Code when discovery found a
binary; `auto` takes the single configured one, and with several a fixed
precedence — OpenRouter, then Cloudflare, then Claude Code — because an
exported key is a deliberate act while an installed CLI is ambient, so the
CLI never overrides a key (the reason line names the flag for each
alternative). The side-car header records the provider that served the run.
The fourth adapter — the Anthropic API with `ANTHROPIC_API_KEY`,
`--provider anthropic` — is a named, empty slot (PLAN.md §21.6): one more
entry in `providers.ts`, nothing above the port.

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
came from the corpus is inside a four-backtick fence (its info string is the
member's language, from the model that declares it), and the system message
says fenced content is **material, never instruction** — the whole defence
against a comment that reads "ignore the rules above". A dependency without a
record is shown as NOT EXPLAINED; the model is told not to invent it.

The system message carries the Specy definitions, one line per concept, and
the task per level — explain's; a defined walk's carries generic rules, its own
task and its instructions instead (IN-9). A cycle asks for one entry per member id. A cycle larger
than `--max-scc` is chunked: each chunk sees the others' signatures only.

**The words of the names (prompt 2, PLAN.md §20.3).** Every unit is also asked
what the words of its names mean in it: a section *Words to define* lists, per
identifier, the words of its own name and of an operation's parameters or a
type's fields, split by `@codegraph/vocabulary` (injected as a `Speller`: the
insights package runs no splitter). Short words, keywords and function words
(`or`, `of`, `all`: `FUNCTION_WORDS`) are not asked; the deterministic class
is withheld, so the judgement — `domain`, `technical` or `ambiguous` — is the
model's. The answer is one `words` entry per word, with
its `sense` and its `meaning` in this unit. The words are given, not chosen: on
receipt an entry for a word not listed is dropped, a repeat keeps the first,
and `in` is restated from the split. A module is also shown what its types
said of the words they spell — read from the store through a `words(id)`
projection, as summaries are, and only when its prompt renders — heaviest
first by the vocabulary's module weights, cut at `--terms N`, and answers a
`glossary` that reconciles those a type defined (a word its types all left
undefined is not asked), flagging a word its types disagree on as
`polysemous` with each type's sense. A reader counts the flag only when those
senses are two at least, case and spacing aside (`typesDisagree`): the record
keeps what the model wrote. Templated records carry no `words`.

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
and a module's glossary candidates (so a lexicon correction re-explains the
units whose words it changed, and another `--terms` exactly the modules whose
cut moved; which candidates a type defined is not hashed), **its
dependencies' hashes**, and the ids of dependencies that had no record.
Merkle-style: change one leaf's source and exactly its transitive dependents
and containers change; nothing else does. The explanation text is
deliberately **not** hashed — a non-deterministic answer must never cascade
re-runs.

**Two hashes per unit.** A unit's *chain* is its fingerprint without the
words, over its dependencies' chains; it is never stored. A dependent hashes a
dependency's chain — except a module, which hashes its types' whole
fingerprints, because its prompt reconciles their word entries into its
glossary. A caller sees a callee's summary and concept, a type its
operations', never their words, so a words-only change re-explains the units
whose words moved and the modules above those types, and nothing else. On
Spring PetClinic, the function-word correction would cost 10 calls stamped
this way, against 53 when every dependent hashed its dependencies' whole
fingerprints (the fold before 2026-11). A record stamped under that fold is
still reused while its stamp matches — a match there means every transitive
input is unchanged, words included — so no store is re-explained for the
switch; it moves to the new stamp when it is next re-explained.

A re-run plans `reuse` for every unit whose members' records match; `--force`
overrides. Because a missing dependency is part of the fingerprint, a
dependent explained while its callee had failed or was out of scope is redone
once the callee exists.

## IN-6 · Budget controls

`--dry-run` prints the plan — every unit in walk order with its status, the
calls it will make, the estimated prompt tokens per level — and makes no call;
it needs no key. `--estimate` prints only the volume: calls, input and output
tokens per level, and a cost when `--price-in`/`--price-out` (USD per million
tokens) are given. Input is the rendered prompts at four characters per token,
plus what the transport adds to every prompt — nothing on the key providers;
on Claude Code its scaffolding (1 850 tokens a call) and the response schema,
which it sends as prompt (fitted on the Java fixture, where operations then
land within 1 % of what was billed);
output is a measured figure per block asked for (operation 470, type 530,
module 530 tokens), plus 120 per word and 125 per glossary entry asked to
define — fitted on a live prompt-2 run of gpt-5.6-luna over Spring PetClinic,
reasoning tokens included (PLAN.md §20.3) — so a cycle call counts once per
member. Those figures are explain's; a defined walk's are its own, measured on
one live run (IN-9). Repair re-asks and rate-limit retries
are not counted, and records already in the side-car are not re-sent. A real
run shows that same estimate on stderr and asks for confirmation before the
first call; `--yes` skips the question, and with no terminal to ask on the run
is a usage error rather than an unasked spend. A run that plans no call never
asks. `--max-calls N` stops planning calls after N, so what runs is
always a dependency-consistent prefix. `--scope IDS` restricts calls to the
units whose member, nearest type or nearest module is one of the ids — a
sub-package is not reached through its parent package, nor a nested type
through the type around it; dependencies outside scope are reused when already
explained and never called. It is `--include id:` for each id, one case of the
selection `--include`, `--exclude`, `--levels` and `--closure` express (IN-9). `--concurrency N` runs N calls in flight
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
`attempts + 1`, and a run that did not attempt the unit (`--scope` or any
selection, `--max-calls`) carries it over unchanged. The trailer's `failed` is the number
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

## IN-9 · The walk, generalized: `codegraph walk` (M21)

`explain` asks ONE question — what is this, in the Specy vocabulary? — of EVERY
unit. The machinery under it asks nothing about the question: units, the
SCC-condensed order, context packs, Merkle fingerprints, the plan before the
spend, the store, the retry. So that machinery stays where it is and learns
nothing new; what `explain` hard-coded moves behind one seam, and a question of
the user's is data compiled into it (PLAN.md §22).

### The seam: what the engine asks of a walk

`WalkSpec` (`spec.ts`) is everything `plan.ts`, `run.ts`, `context.ts`,
`prompt.ts`, `records.ts` and `fingerprint.ts` used to reach for by name;
`order.ts`, `units.ts` and `source.ts` do not see it (a boundary test holds
that the walk builders name no selection).

| the engine needs | `explain` gives (`explain-spec.ts`, unchanged) | a definition gives (`definition.ts`) |
|---|---|---|
| the system message per level and shape | the common rules, the Specy vocabulary, the task per level | the generic rules, `prompt.task[level]`, `prompt.instructions` |
| extra lines in a member's section | the words to define, a module's glossary words | the entity instructions that select this member |
| the answer schema per level and shape | the Specy blocks | the field grammar, compiled |
| what is kept of an answer | confidence clamped, words restated | confidence clamped |
| a block with no call | the templates of IN-7 | none: a trivial member is skipped (`trivial: "skip"`, the default) or asked |
| what a dependent quotes | `description` and the concept label | `description`, and `label: value` when `answer.label` names a field of that level |
| completion tokens per block, for the estimate | the fitted constants of IN-6 | one measured figure per level, nothing per field (below) |
| what else the fingerprint hashes | nothing | `version`, the system message's digest, the answer schema's digest, the label, the member's instructions |

The last row is the compatibility rule: the fingerprint's optional `walk` input
is omitted by the built-in explain, so its canonical JSON — and every
fingerprint ever stored — is unchanged. The golden suite
(`packages/cli/test/golden/explain/`) pins explain's plan, every rendered
prompt, every fingerprint and chain and a fake-completer side-car on the five
fixtures; on the paid Spring PetClinic store the `explain --dry-run --json` plan
is byte-identical before and after M21.

### The definition (`codegraph.walk/1`)

A definition is data, checked with no model read: `parseWalkDefinition` →
`compileDefinition` → `CompiledWalk` (name, version, digest, selection,
context, answer schemas, system messages) → `spec(env)`, the one part that
needs the walk's graph (entity instructions select members under its view).

```json
{
  "kind": "codegraph.walk/1",
  "name": "audit",
  "version": "1",
  "levels": ["operation", "type"],
  "select": { "edge": { "kind": "annotationUse", "to": { "name": "Audited" } } },
  "closure": "containers",
  "prompt": {
    "task": {
      "operation": "@Audited marks a method whose calls must reach the audit log. Say what a call of this operation would record, and whether anything in its source or its callees sends it to a log at all.",
      "type": "Say which of this type's operations are audited, and whether its state can change outside them."
    },
    "instructions": "Answer in English. Quote the annotation's value when it matters.",
    "entities": [
      { "select": { "name": "Reporting" }, "instructions": "Reporting runs monthly: say what max returns on an empty list." }
    ]
  },
  "answer": {
    "label": "logged",
    "fields": {
      "operation": { "logged": { "enum": ["yes", "no", "unclear"] }, "recorded": "string[]" },
      "type": { "unaudited": { "list": { "operation": "string", "why": "string" } } }
    }
  }
}
```

- **Defaults** (every key but `kind` is optional): `name` `adhoc`; `version`
  `1`; `levels` all three (a set); `select` everything; `exclude` nothing;
  `closure` `none`; `trivial` `skip`; `context` `{ depth: 1, maxLines: 200,
  source: true }`; `prompt.task` a neutral task per level ("Answer this walk's
  instructions about this operation… Where none applies, say what it does.");
  `prompt.instructions` none; `prompt.entities` none; `answer.fields` none.
  `codegraph walk --print-definition` prints the default with every key
  spelled.
- **Every block** is `answer`, the declared fields by name, `description`,
  `confidence` — the wire order, so the line that flows upward is written after
  the answer it summarizes, and a key-sorting formatter moves no fingerprint.
  The generic rules tell the model that `description` (at most 60 words) is
  what every dependent is shown of it: **what flows upward is `description`**.
- **The field grammar is closed**: `"string"`, `"number"`, `"boolean"`,
  `"string[]"`, `{ "enum": [...] }`, `{ "list": { field: scalar or enum } }`,
  each object form optionally `"nullable": true` (a nullable scalar is
  `{ "type": "string", "nullable": true }`). Compiled to Zod and strictified by
  the same `strictify` as explain's blocks: one definition gives the type, the
  validator and the strict schema. A list does not nest. Rejected: a
  user-supplied JSON Schema (strict output takes a narrow dialect, and the
  workspace has no validator for arbitrary schemas).
- **Reserved**: the walk names `explain` and `insights` (explain's walk and its
  store); the field names `description`, `answer`, `confidence` (every block's),
  `words`, `glossary` (explain's) and `concept` (the store's generated `concept`
  column reads `$.concept` of any block). Names match `[a-z][a-z0-9-]*`.
- **Refused, and why**: four backticks in any task or instruction text (the
  corpus fence: an instruction can then never open or close one, so "fenced =
  material" stays structural); `context.source: false` (the engine always shows
  source, and a file must not run as if it said `true`); `answer.builtin` (the
  Specy answer is not grammar a file may claim). Every fault carries its path —
  structure first, then values, every fault of a pass at once.
- **A task or fields for a level outside `levels` are kept**, digested and
  hashed for that level, so `--levels` never invalidates a file nor moves a
  fingerprint.
- **The digest** (`definitionDigest`) is the sha256 of the canonical resolved
  definition — defaults applied, keys sorted, text trimmed, the shortest
  spelling of each field type, `levels` as a set — so a spelled default and an
  omitted one digest the same. A CLI flag is folded into the JSON before it is
  parsed: its fault is reported at its key (`name (from --name): …`) and the
  digest is the effective definition's.
- **Rejected**: prompt templates with placeholders (the user message's layout is
  the engine's contract — fixed sections, corpus fenced, deterministic bytes);
  a different task per entity inside one walk (a cycle is one prompt with one
  answer schema; per-entity text is instructions, a different task is a second
  walk with a filter).

**Explain, customized.** `explain --instructions TEXT|@FILE` and `explain --walk
FILE` reach explain through `customizeExplain`. The file (`parseExplainFile`)
may set `select`, `exclude`, `levels`, `closure`, `context`,
`prompt.instructions` and `prompt.entities`, may restate the built-in (`name:
explain`, version `2`, `answer.builtin: specy.domain/3`), and is refused for
`prompt.task`, `answer.fields`, `answer.label`, `trivial`, another name or
version: the Specy blocks are what the readers, the glossary and the Specy
skill depend on. With nothing to carry, the customized spec IS the built-in
(the same object). A unit no instruction reaches, and every templated unit
(which sends no prompt), keeps explain's fingerprint. `codegraph walk
--print-definition explain` prints explain as a definition.

### Selectors and what a filter means bottom-up

Selectors live in `@codegraph/analyzer` (`selectors.ts`): the CLI defines no
predicate of its own, and `analyze`, `city` and the navigator can take them
later. A **term** is text, one per `--include`/`--exclude` flag: `id:ID`,
`kind:K`, `trait:T`, `lang:L`, `name:GLOB`, `module:GLOB`, `file:GLOB`,
`edge:KIND`, `edge:KIND>TERM` (it writes such an edge, to a match of TERM),
`edge-in:KIND`, `edge-in:KIND<TERM` (such an edge points at it — the analyzer's
derived inverse). **JSON** (`{ "id": … }`, `{ "edge": { "kind", "to" } }`,
`{ "edgeIn": { "kind", "from" } }`) is what a file holds, and alone composes
with `all`, `any`, `not`. The vocabulary is core's: an unknown kind, trait,
language or edge kind is an error listing the valid names, never a silent empty
match; `kind:` takes the union of the profiles' kinds and `lang:` the profile
codes (`java`, `csharp`, `ts`, `ex`, `rb`).

A glob matches the whole string, case-sensitively, with no escape (`*` is
always a wildcard; an exact name is `id:`); `*` stays in a segment, `**`
crosses. The separator is `/` for `file:` and, for `name:` and `module:`, the
one the profile's `lexicon.qualified` states for the kind (`.` for a Java
package, `/` for a TypeScript, Elixir or Ruby file module, `::` for a Ruby
constant) — so `module:com.acme.order*` does not reach a sub-package and
`module:com.acme.order**` does. A selector matches inside the view's
projection: `--declared-only` makes every `edge` term see facts only, with no
provenance syntax of its own, and `not` complements within the view. A term
matches the entity itself; nothing is folded.

**The walk is filter-blind.** It is built over the whole model whatever the
selection, so units, cycles and fingerprints never depend on it and a record
bought under one filter is reused by any later run whose inputs match. Building
it over the filtered entities only was rejected for exactly that reason.
`selection.ts` turns a `Selection` into the `inScope` predicate `planRun`
already took, under five rules, each a tested property:

1. **Nearest containers.** A member is selected when it, its NEAREST containing
   type or its nearest containing module matches an include (none: everything)
   and none of the three matches an exclude. Exclude always wins. Not
   transitive: `--scope java:com.acme.order` leaves its sub-packages' units
   unasked, and a nested type is not reached through the type around it.
2. **Levels.** A unit is asked only if its level is in `levels`.
3. **A cycle is one unit.** Include and exclude are both existential over its
   members: one selected member selects it, one excluded member leaves it
   unasked (asking it would ask the excluded member).
4. **Closure.** `dependencies` adds the selection's transitive unit
   dependencies, `containers` the type and module above a selected unit, `all`
   both — the LEAST set closed under its rule. It never adds a barred unit
   (outside `levels`, reached by an exclude, or a trivial member under
   `trivial: "skip"`), and `dependencies` does not walk through one (f → g → h
   with g excluded adds nothing: at depth 1 no asked prompt would quote h).
   `containers` reaches the module above an operation even when the type
   between them is barred; a parent package is not a container.
5. **Not selected is `skip-scope`**, the existing status: reused when a record
   with its fingerprint exists, never called, shown to dependents as NOT
   EXPLAINED, and part of their fingerprint through `missingDependencies`.

Templates are not filtered: under explain a trivial member is `template`
whatever the selection, and is counted apart. A selection moves a unit's
fingerprint only through `missingDependencies`: a unit keeps its fingerprint
exactly when nothing in its transitive dependency cone is `skip-scope`. The
plan prices the alternative (`priceSelection`): the direct dependencies of
asked units it leaves unwalked, by why, and what the next closure would add —
cold-plan figures, since on a warm store an added unit may be reused.

`--scope` is `--include id:` for each id, compiled under the walk's resolved
view, as every selector is. An `id:` matches nothing the view drops, so the two
can differ from the pre-M21 predicate only for a corpus member whose nearest
type or module is a stub under `--internal-only` — absent from the five
fixtures and from PetClinic, where the eleven `--scope` baselines are
byte-identical. `--scope` keeps its own unknown-id check; an `--include id:` is
an opaque token and is not checked.

### One store per walk

A walk named N writes `<model>.N.walk.db`, the working copy, and its export
`<model>.N.walk.jsonl`; `explain` keeps `<model>.insights.db` and
`.insights.jsonl`, kind `codegraph.insights/1`, its bytes untouched. One store
for every walk (a `walk` column in the primary key) was rejected: a migration
of paid-for stores, for files that did not exist yet. One store per walk needs
none: the block is already TEXT and the header already JSON in `meta`, so
`INSIGHTS_DB_VERSION` stays 2, and `concept` and `insight_word` are simply empty
on a walk's store.

- **The side-car's header kind is `codegraph.walkRecords/1`** — not
  `codegraph.walk/1`, the definition file's: two formats, two kinds — with
  `walk: { name, version, digest, answerDigest }`. `answerDigest` is the sha256
  of the three strict block schemas as sent, keys sorted. Record, failure and
  trailer lines are the existing envelopes; the block is validated by the
  walk's compiled schema (`walkRecords(compiled)`, a `RecordFormat`) instead of
  the Specy union. The file never carries a schema, only the identity the name
  check compares.
- **The store is not a cache, here too.** A store, side-car or run header of
  another walk's NAME is refused with its bytes untouched — at open
  (`migrate()`, before any write, readers included), on `importFile`,
  `beginRun`, the encoder, and line 1 of the decoder. A header with no `walk`
  key is explain's; an empty store is nobody's yet.
- **A changed answer is another walk.** The fingerprint hashes the answer
  schema, so new fields re-ask every unit anyway, and a store keeping both
  shapes would export a side-car no definition decodes: a store of the same
  name under another `answerDigest` is refused like another name's ("`--name
  OTHER` keeps both").
- **A changed definition is said, not refused.** Same name and answer, another
  `digest` (a task, instructions, version, selection): fingerprints decide what
  is asked again, and the run says so in words before any count — the first
  line of a dry run or an estimate, on stderr under `--json`, and before the
  confirmation's question: `note: the definition changed since this store was
  written: these N units are asked again and their records REPLACED; --name
  OTHER keeps both.` Declined, nothing is written (the store's sha256 is
  unchanged).
- **A customized explain** keeps its kind and its store and records `walk: {
  name: "explain", version: "2", digest }`, the digest over its instructions
  alone (a selection or a depth must not move a plain explain's header); a
  plain explain's header gains no key. An older build reads such a file as a
  plain explain and drops the key on export.
- **What a dependent quotes after a re-open** is a projection the spec declares
  (`WalkSpec.quoted`, the block paths its quote reads): the store answers it in
  SQL, memory builds the same projection through one builder, and explain's
  four paths are the ones its SQL always read.
- **Reads keep a block as stored.** A writer validates against the current
  schema; a read accepts any object block, so a record already paid for never
  becomes unreadable.
- `decode → import → export` is the identity for a walk's records as well — a
  fast-check property over arbitrary grammar-shaped blocks.

### The readers

A reader holds no definition. `walkReader(name)` compares the walk's name,
never its answer, and reads each block as stored, so a store written under
answer fields since changed stays readable; it writes nothing (a writable open,
the codec and its record schema all refuse). `sqliteStoreReader(db, walk?)`
picks the reader from the store's header. Explain's projections stay
explain's: the "owned by X" concept label and the "owed words" count apply to a
`codegraph.insights/1` store only.

- **`codegraph insights --walk N`** reads `<model>.N.walk.db`; `--store FILE`
  alone reads whichever walk's store its header names, and with `--walk N` the
  file must be N's. No flag, or `--walk explain`, is explain's output byte for
  byte. A walk's summary names the walk, its version and its definition digest;
  `--id` prints the block field by field. `--concept`, `--word`, `--glossary`,
  `--polysemy` and `--concerns` answer **none** — exit 0, the reason on stderr,
  under `--json` one `codegraph.insightsNone/1` document — rather than an empty
  table a consumer would read as "no such concept".
- **`codegraph serve --insights FILE`** chooses the reader the same way. A walk's
  `/insight.json` answer is `kind, id, status, walk, record`: the `walk` key is
  the discriminator, on every status, and never on explain's answers, whose
  keys are unchanged. `/glossary.json` answers `no-store` on a walk's store. A
  store with no header yet is re-opened on each request, so a walk that fills it
  later is not read through explain's schema.
- **The Navigate panel** renders a walk's block in the same inference frame as
  explain's: the badge "LLM answer", the walk's name, the model, the confidence;
  then the answer, every field by its declared name (a list item by item, a
  nested object indented, `false` shown, `—` for an empty value), then the
  description. The page restates the block's own keys (`WALK_BLOCK_KEYS`) as a
  literal pinned by a test and still imports nothing from this package.
  Explain's panel markup is byte-identical to the build before M21.

### Cost

Input is estimated as explain's is (IN-6). Output is
`WALK_COMPLETION_TOKENS_PER_BLOCK` per block asked for: operation 500, type
620, module 620. Operation and type are the means of one live run (PLAN.md
§22.6, step 8; 2026-11-22): Spring PetClinic, `--provider claude-code`, model
`sonnet`, depth 1, a walk that declares no answer field (its blocks carry
`answer`, `description` and `confidence` only), 83 calls, $0.9380. The 63
operation blocks averaged 499 tokens (273 to 802), the 20 type blocks 620 (307
to 1 177). No module was asked there, so a module takes the type's figure;
nothing measured a declared field, so a field adds nothing to the estimate,
though it adds to the answer. The estimate says all of this (`output ≈
measured on a live run: operation 500, type 620 tokens per block asked for
(sonnet through claude-code, on a walk that declares no field: declared fields
add to it; no module was measured, it takes the type's figure)`), and its JSON
carries the same sentence in `assumptions.completionTokens`.

On that run, the estimate made before it was 12.4 % above the billed input
(225 603 tokens estimated, 200 779 billed: operations 21.6 % above, types
7.0 % below) and, with the 500 per block it then used at every level, 5.3 %
below the billed output (41 500 against 43 814: operations 0.3 % above, types
19.3 % below). The figures now used are that run's means, so they reproduce
its output by construction (43 900 against 43 814); they say nothing yet about
another corpus, model or question. One run, on one corpus, with one model and
one question, is their whole basis.

### Not supported (PLAN.md §22.7)

Planning only the selection's dependency cone (a plan still builds a context
pack for every unit, to hash it); selectors over measures, roles or another
walk's results; a walk quoting another walk's descriptions; `context.source:
false` and `context.sections`; a task per entity subset; an answer schema
beyond the grammar; selectors on `analyze`, `city` and `navigator`; the Navigate
panel choosing among several walks' stores; the desktop app running a walk.
