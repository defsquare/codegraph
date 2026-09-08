---
title: Explaining a codebase bottom-up
linkTitle: Explaining bottom-up
weight: 10
---

Ask a language model "what does this class do?" and you get an answer shaped by
whatever fits in the prompt. Ask it about a class whose collaborators it has never
seen, and it will describe the syntax back to you fluently: *"`OrderService.bill`
takes an `Order` and calls `ledger.post`."* Which is true, and is the code, and
tells you nothing.

The problem is not the model. It is the order of the questions. A summary of a
package rests on what its classes do; a class's purpose rests on what its methods
do; a method's meaning rests on what it calls. Explaining top-down forces the
model to guess about parts it has not read yet. So `codegraph explain` walks the
extracted graph **bottom-up** — leaf operations first, then their callers, then
the types that own them, then the modules — and feeds each prompt the
explanations already written for everything the unit depends on.

The result is a **side-car** file, one record per operation, type and module,
each with prose and a structured block in a domain-modelling vocabulary. The
section numbers (`IN-1`, `IN-5`…) are decision records cited from the code.

## IN-1 · Two packages, one seam

```
@codegraph/insights   pure: units, walk order, context packs, prompts,
                      fingerprints, plan, run, side-car format
@codegraph/llm        the model clients: an LlmClient interface, two provider
                      implementations, and a deterministic fake
```

The insights package depends on the core and analyzer packages only and does
**no I/O at all**: source text arrives through an injected reader, the model call
through an injected completer, finished records leave through a hook. The client
package is the only place allowed to import a provider SDK — a boundary test
scans the whole workspace for that import, and the lint config restricts it. The
command wires the two together: it owns the filesystem, the environment
variables, and the progress narration.

This is not architectural fastidiousness. It is what makes the feature testable.
Every test in the workspace runs against the fake client or a fake transport, so
the suite is deterministic and free, and the walk — which is the part with actual
logic in it — is tested without a network at all. The provider SDK is itself held
behind a one-function transport, so every request, response and error path is
driven by a fake in tests and an SDK change is repaired in one file.

**Two providers, one contract.** Both speak the same chat-completion shape,
parsed once. What differs is the route: one goes through its own SDK with its own
key; the other goes through a gateway's REST API with a single token that both
authenticates and bills. Model names are the same `author/model` form on both, so
switching providers leaves every fingerprint — and therefore every reusable
record — intact. The resolution of which provider to use lives in one place, and
the side-car header records which one served the run.

## IN-2 · Units, and the walk order

A **unit** is one thing the model is asked about:

- an **operation** — a method or constructor that is a direct member of a type.
  Lambdas and blocks are never units: their calls already roll up to the
  enclosing operation, and their source sits inside its span.
- a **type** — every non-stub corpus type.
- a **module** — every non-stub corpus module.

The walk orders units so each is explained after everything it depends on: an
operation after the operations it calls; a type after the types it depends on,
its own operations, and the types nested in it; a module after the modules it
imports and its own types.

Two decisions in that ordering are worth pulling out. **A field access is
context, never an ordering edge** — otherwise every accessor pair would constrain
the walk without adding anything to explain. And **package containment is not a
dependency**: a parent package is a namespace fact, not a "depends on", so it
neither orders the walk nor merges units.

Then the rule that makes the whole thing work on real code:

{{< callout type="info" >}}
**A strongly connected group is one unit, at every level.** Mutually recursive
methods, a type cycle, mutually dependent packages — all explained together, in
one prompt, with every member's record listing the group.
{{< /callout >}}

There is no other honest option. Bottom-up ordering requires an acyclic
dependency graph, and real code is not acyclic. Breaking a cycle arbitrarily
means explaining one member as if the others did not exist. So the analyzer's own
Tarjan implementation — the same one behind the cycle report — yields the
components, and layering over the acyclic condensation gives the order. Cross-level
edges only point downward, so a unit never mixes levels.

The cycle behaviour is pinned to the analyzer's cycle *report* by a test, exactly
at module level and as containment at type level, so the two features can never
disagree about what a tangle is. The scale this has to survive is real: fineract
produces **53,207 units, 18 package tangles, the largest with 509 members**.

## IN-3 · The context pack, and the fence

Each prompt is built from a **context pack**: the unit's source slices (read
through the anchors, capped, with the middle elided when it is too long), its
documentation comments, the joined facts the model already holds — calls with
their target type and stereotype, accesses, throw sites, annotations with their
written arguments, metrics, fields with declared types and constant values,
supertypes, injection points, imports — and the **explanations already produced
for its dependencies**. A depth setting controls how far that goes: one level
gives each dependency's description, two nests the dependencies' dependencies as
one-liners.

The user message has fixed sections — unit, signature, documentation, source,
facts, what the dependencies do, cycle members — and everything that came from
the corpus sits inside a fence. The system message says that fenced content is
**material, never instruction**. That is the whole defence against a code comment
that reads "ignore the rules above", and it is needed: the input to this feature
is arbitrary text written by people who are not the operator.

A dependency with no record is shown as *not explained*, and the model is told
not to invent it. An absent explanation is a fact about the run, and hiding it
would invite exactly the confabulation the bottom-up order exists to prevent.

The system message carries the target vocabulary — one line per concept — and the
task for the level being asked. A cycle asks for one entry per member id, and a
cycle larger than the configured maximum is chunked, with each chunk seeing the
others' signatures only.

## IN-4 · The side-car, and its determinism

Explanations live in `<model>.insights.jsonl`, beside the model, and never inside
it. That is not filing tidiness. The insights are **the only artefact in the
pipeline that is not a pure function of the model**: two runs can differ, a
better model tomorrow will produce better prose, and none of that may contaminate
a file whose determinism is a tested property. `model.jsonl` and `model.db` stay
exactly as they were.

Within its own file, determinism is still pursued as far as it can go. Records
are sorted and re-serialized through their schema, so a record built in memory
and one read back from disk are the same bytes. The body carries **no timestamp**
— only the trailer does — so two runs are diffable and what changed is precisely
what was re-explained.

The structured block follows a domain-modelling metamodel: every block has a
proposed ubiquitous-language name and a description; an operation carries safety,
idempotence, owner, handled command, emitted events, pre- and postconditions and
the invariants it enforces; a type names the concept it realizes — entity,
aggregate, value type, repository, service, event — with its fields, invariants,
state machine and relations; a module carries its APIs, its SPIs, what it depends
on, and a bounded-context hint. Strict structured output requires every property
to be present, so "optional" is expressed as nullable, and a test asserts the
generated schema is strict-compatible.

## IN-5 · Fingerprints make a re-run cheap

Every record carries a hash over **what it was computed from**: the prompt
version, the model slug, the level, the source slices, the comments, the
signatures, a digest of the facts shown, the **fingerprints of the units it
depended on**, and the ids of dependencies that had no record.

That is a Merkle structure, and it gives the property that makes the feature
usable on a codebase people are still editing: change one leaf's source and
exactly its transitive dependents and containers change. Nothing else does. A
re-run reuses every record whose fingerprint still matches; a force flag
overrides.

The explanation text is deliberately **not** hashed. Hashing it would make a
non-deterministic answer cascade re-runs through everything above it, and the
cost of the feature would become unpredictable for a reason that has nothing to
do with the code.

Including the *missing* dependencies in the fingerprint is the other half. A unit
explained while its callee had failed, or was out of scope, is redone once the
callee exists — automatically, because its inputs genuinely changed.

## IN-6 · Budget controls, because this one costs money

This is the only command that opens a socket and the only one that costs
anything, so the controls come first and the run comes second.

A **dry run** prints the plan — every unit in walk order with its status, the
calls it will make, the estimated prompt tokens per level — and makes no call. It
needs no API key at all, which means the plan is inspectable by someone who has
not decided to spend anything yet. An **estimate** prints the volume: calls,
input and output tokens per level, and a cost when prices per million tokens are
supplied. Input is the rendered prompts at four characters per token; output is
one measured average per block asked for — 450 tokens for an operation, 650 for a
type, 900 for a module, averaged from real runs on the fixture and on gson — so a
cycle call counts once per member. Repair re-asks and rate-limit retries are not
counted, and records already in the side-car are not re-sent.

Then the caps. A **maximum call count** stops planning calls after N, and what
runs is always a dependency-consistent *prefix* of the walk — never a scattered
subset whose records reference explanations that were never produced. A **scope**
restricts calls to units inside named modules or types, with dependencies outside
the scope reused when already explained and never called. **Concurrency** runs
several calls in flight within a layer, and it is a real dial rather than a
default: a new account on one provider is allowed twenty requests a minute, and
the client obeys the provider's own retry header on a rate-limit response before
retrying. Separate model slugs for the leaves and for the roll-ups make the
intended split explicit — a cheap model for operations, a stronger one for types
and modules.

Records are appended to a journal as they arrive and the sorted side-car is
rewritten at every layer, so an interrupted run resumes where it stopped rather
than paying twice.

{{< callout type="info" >}}
On the reference fixture, a full run was **77 units, 68 calls, about six cents**.
The gap between 77 and 68 is the next section.
{{< /callout >}}

## IN-7 · Trivial members are templated, not asked

A getter, a setter, `equals`/`hashCode`/`toString`/`compareTo`, or a
field-assigning constructor is described from a template with full confidence and
**no model call**. The decision is made from facts only: no throw site, no corpus
call, cyclomatic complexity of one or less, and at most one field touched.
Anything with a `throws` fact or a call into the corpus is never trivial, however
short it looks.

This is worth doing for cost, but the better argument is quality. Asking a
language model to describe forty getters produces forty paragraphs of noise that
then become *context* for the class above them, diluting the facts that matter.

## IN-8 · The one asynchronous command

The rest of the CLI is synchronous all the way down, deliberately. This command
awaits a network, so the run function returns either an exit code or a promise of
one; every other command still returns a plain number, and the promise is settled
through the same exit-code mapping, so a rejection can never escape unhandled. A
separate synchronous entry point serves the in-process test helpers and throws if
it ever meets a promise.

It is a small thing, and it is the shape of the concession: one command became
asynchronous, in one function, rather than every command signature changing to
accommodate the only feature that needs it.

## Open questions

The side-car is designed to be consumed, not just read — a domain-extraction step
takes it instead of the source. What is not settled is how much of the explanation
layer should feed back into the analysis: an explained module knows things about
itself (its APIs, its bounded-context hint) that the structural graph does not,
and there is no principled way yet to use those without letting a generated claim
sit beside a measured one.

## Where this shows up

- [Tutorial: explaining a package](/docs/tutorials/explain/) — dry run, estimate,
  scoped run, reading a record beside its source.
- [How to estimate and cap a run](/docs/how-to/explain-cost/) — scoping, provider
  choice, per-level models, forcing a re-run.
- [Reference: insights.jsonl](/docs/reference/artifacts/insights-jsonl/) — the
  side-car's record shapes.
- [Reference: domain-facts](/docs/reference/artifacts/domain-facts/) — the joined
  dossier the context packs are built from.
- [Reference: environment](/docs/reference/environment/) — the provider variables and
  where each is read.
