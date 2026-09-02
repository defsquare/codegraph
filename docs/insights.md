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
    @codegraph/llm        the model client: LlmClient + OpenRouter + a fake

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

## IN-4 · The side-car and its determinism

    {"t":"header","kind":"codegraph.insights/1",…,"metamodel":"specy.domain/3",…}
    {"t":"i","id":…,"level":"operation",…,"block":{…},"fingerprint":…}
    …
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

## IN-5 · Fingerprints and incremental runs

Every record carries a sha256 over what it was computed from: the prompt
version, the model slug, the level, the source slices, the comments, the
signatures, a digest of the facts shown, the **fingerprints of the units it
depended on**, and the ids of dependencies that had no record. Merkle-style:
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
it needs no key. `--max-calls N` stops planning calls after N, so what runs is
always a dependency-consistent prefix. `--scope IDS` restricts calls to units
inside the named modules or types; dependencies outside scope are reused when
already explained and never called. `--concurrency N` runs N calls in flight
within a layer. `--model` and `--rollup-model` pick the leaf and the roll-up
model; a cheap model for operations and a stronger one for types and modules
is the intended split.

Records are appended to `<out>.journal` as they arrive and the sorted side-car
is rewritten at every layer, so an interrupted run resumes where it stopped.

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
