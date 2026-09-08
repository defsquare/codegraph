---
title: Time is part of the structure
linkTitle: Time as structure
weight: 9
---

A model extracted from source says what the code **is**. It cannot say what
happened to it, and some of the most useful things about a codebase are only
visible in what happened.

Two files that always change in the same commit are coupled. Nothing in the
source may connect them — no import, no call, no shared type — and yet whoever
edits one has to remember the other, every time, or something breaks. That is a
dependency in every sense that matters to a person doing the work, and a static
analyzer will never find it. Conversely, a declared dependency that has never
once been exercised by a change in ten years of history is structurally real and
practically inert.

Codegraph mines history for that reason. The lineage is explicit:
[Gource](/docs/explanation/prior-art/), for the idea that a repository's history is
something you *watch*, and Adam Tornhill's *Your Code as a Crime Scene* (Pragmatic
Bookshelf; first edition 2014, second 2024) for the analyses — hotspots, change
coupling, knowledge maps — and for the argument that version-control data is an
under-used source of design information.

## What history is asked

Four questions, each of which a `git log` can answer and a compiler cannot.

**Where is the work concentrated?** A *hotspot* is a file that changes a lot and
is large or complicated — the intersection of churn and size. It is the single
most actionable ranking in the set, because effort spent on a file nobody touches
returns nothing, however ugly it is.

**Who knows this code?** Ownership per file, and the aggregate: how much of the
system's knowledge sits with how few people. Codegraph reports ownership and
truck factor at file level from author attribution over added lines.

**What changes together?** Logical coupling: pairs of files that co-change, with
a *support* threshold (in at least N commits) and a *confidence* threshold
(support over the rarer file's revisions), plus a cap on changeset size so a
sweeping mechanical commit does not couple everything to everything.

**What does the code claim that history denies, and vice versa?** These are the
two cross-graph reports, and they are the ones only a tool holding both graphs at
once can ask:

- **Hidden coupling** — pairs that co-change but have *no path* between them in
  the declared graph, transitively, in either direction. A structural surprise:
  something binds these files that the source does not express.
- **Dead weight** — declared file dependencies that history has never once
  exercised together. Structure that exists and does not move.

On google/gson those reports produce results a maintainer can immediately
recognise: hidden coupling finds the `JsonSerializer`/`JsonDeserializer` twins
and the `Since`/`Until` twins, neither pair connected by any declared path; dead
weight finds the stable `JsonToken` and `TypeAdapter` interfaces, which everything
depends on and nothing changes with.

## Three principles, locked before any of it was built

**Evolution facts are a third artifact.** `history.jsonl` sits beside
`model.jsonl`: repository-scoped, language-agnostic, changing on every commit
while the structure does not. It never merges into the model file, and it never
grows a fifth provenance value. Repository facts with a per-commit lifecycle do
not belong in a language-scoped structural contract, and [the provenance
set](/docs/explanation/facts-vs-inferences/) only stays meaningful while it is small.
The join happens later, in the analyzer, on file paths.

**The miner has no code intelligence.** It is the extractor rule mirrored one
artifact over: one `git log` pass, parsed into commits and per-file line deltas,
with authors interned and paths interned exactly the way the model file interns
its vocabularies — deterministic, sorted, with a count trailer. Everything
smarter is derived downstream. The one place the miner does interpret is
labelled as such: `isFix` and `isRevert` are subject-line regex flags, and they
are documented as a heuristic rather than presented as a fact.

**Lineage is the natural key, exactly.** "The same entity in two snapshots" is
key equality, because [identity is a structured key](/docs/explanation/identity/) —
no diff heuristics, no similarity matching, nothing to tune. The cost is stated
rather than hidden: a **renamed symbol is a death plus a birth**, and anonymous
entities are not tracked over time at all, since their disambiguator is a file
position that any edit above them shifts. Rename matching is heuristic machinery
we deferred until a corpus proves it necessary.

One thing the miner *does* resolve, because not resolving it corrupts every
downstream metric, is rename chains: they are followed at mine time so one path
surrogate names one file lineage. The documented approximation is that a path
recreated after a deletion continues the same lineage — lineages are named by
paths.

## Snapshots: why sampling, and why a worktree

The structural half of the time axis needs models at more than one revision.
Extracting every commit is prohibitive and, more importantly, unnecessary:
fifty to two hundred frames give the replay its effect, and keyframes bound the
staleness of anything between them.

So `codegraph snapshots` samples — at tags, or every N commits — extracting each
revision in a throwaway `git worktree` and appending it to a temporal store. It
never mutates the main checkout, which matters because this runs against
somebody's working repository. It is **resumable**: revisions the store already
holds are skipped, so an interrupted run continues, and a frame that fails to
extract is reported and isolated rather than being fatal.

That resumability turned into an unexpected feature. gson moved its source root
between releases, so its full history needs two runs with different source roots
— and because the second run skips what the first already stored, composing them
costs nothing. The verification run holds **all 55 gson release tags, 2008 to
2025, in one store**, with the property suite green at every keyframe: closure,
profile validity and determinism hold at each one, unconditionally.

The store keeps revisions, interned entity keys, and per-revision entity and edge
versions. Lifespans — when a key appeared and when it disappeared — are derived
per key at query time. That is the no-serialized-inverses rule applied to the
time axis: a lifespan is an index over facts, not a fact.

Asking about one entity is then a query. `codegraph timeline` on gson's `Gson`
class spans all 55 releases from 1.0; `MappedObjectConstructor` dies after
gson-1.7.2, which is the 2.0 rewrite; `Excluder` is born at gson-2.1. None of
that required a heuristic — it is key presence, revision by revision.

Two costs are worth stating. Per-commit incremental extraction is deferred
because [Spoon's resolution is
corpus-wide](/docs/explanation/extracting-without-compiling/) — the stub whitelist
depends on all corpus-declared ids — so a model built from one changed file would
be approximate. And the exact birth commit of an entity (found by bisecting
between keyframes) is a query-time feature nobody has needed enough to build.

## The replay, and the one decision that makes it readable

A replay of a growing city has an obvious implementation and it does not work.
Lay out each frame as it comes, and the layout is different in every frame:
shelf packing is chaotic, one insertion reshuffles the block, and the viewer
spends the whole timeline re-finding where things went. The motion is real and
means nothing.

So the layout is computed **once, over the union of every key that ever
existed**, and every plot is frozen. Buildings animate in place — rising from
zero at birth, sinking at death — and land is simply vacant before its time. The
early frames of a project look sparse because the project *was* sparse; that is
the honest picture of a city that will grow, not a defect to pad out.
A readable replay needs positional stability more than it needs land density.

Presence gaps become explicit zero keyframes, so a type that disappears and comes
back scrubs honestly rather than interpolating across its absence. Modules are
flat districts in the replay: nesting a package hierarchy inferred from names is
exactly the inference the [identity rule](/docs/explanation/identity/) forbids, and the
replay has no structural package containment to lean on.

**Time colours** are two channels, each documented like any other. *Heat* is
change: a building glows when it changed at that tick, pre-decayed when a sampled
revision saw it unchanged, and the renderer keeps cooling between keyframes.
*Age* is desaturation toward gray by the fraction of the timeline the entity has
lived. On gson at the 2.14.0 tick, the recently touched core reads ember,
one-release-old changes read brick, and the untouched old core is gray. Both are
in the legend, and a toggle restores the plain palette — because a colour that
means "recently changed" must not be mistaken for a colour that means "type" the
moment someone opens a screenshot out of context.

**Ownership** is a second colour mode, offered only when a history was actually
joined, and unowned buildings go neutral rather than being given a claimed hue.
**Co-change arcs** are a different *kind* of line from dependency arrows —
dashed, magenta, shown for the selected building — because they are an inference
and the city never lies about which of its lines are facts.

The verification run on gson joined 55 release keyframes with a 2,088-commit
history, matching 170 of the store's 197 files. The join is by path **suffix**,
because model roots sit below repository roots; an ambiguous suffix joins nothing
and is counted, rather than being resolved by a guess. In that city,
`TypeAdapters` shows its dominant author with a 29% share of added lines and its
dashed co-change fan on selection.

## What is deliberately not here

- **Per-commit incremental extraction** — see above; keyframes bound the
  staleness.
- **Symbol rename lineage** — same-parent, similar-body matching would recover
  renames and would introduce a tunable heuristic into the one part of the model
  that is currently exact.
- **Lambda and anonymous-entity tracking** over time.
- **Author normalization via `.mailmap`.** Identity starts at the email address;
  the normalization lands when it bites.

Each of these is a place where the alternative was a heuristic, and each was
deferred on the same reasoning: an exact answer with a stated limitation is worth
more than an approximate answer whose error nobody can characterise.

## Where this shows up

- [Tutorial: replaying a project's history](/docs/tutorials/history-replay/) — mine,
  sample, scrub, switch to owner colours.
- [How to build a temporal store](/docs/how-to/temporal-store/) — sampling tags or
  every N commits, resuming, composing runs.
- [How to join history with a model](/docs/how-to/history-joins/) — hidden coupling
  and dead weight, and tuning support and confidence.
- [Reference: history.jsonl](/docs/reference/artifacts/history-jsonl/).
- [Identity is a key](/docs/explanation/identity/) — why lineage was nearly free.
- [Prior art](/docs/explanation/prior-art/) — Gource, Code Maat and CodeScene.
