---
title: Why the interchange is a line-based file
linkTitle: Why JSONL
weight: 4
---

Codegraph's extractors and its analyzer meet at exactly one place: a file called
`model.jsonl`, one JSON record per line. That file is the contract — the only
thing an extractor in any language has to get right, and the only thing the
analyzer is allowed to assume. This page is about why it has that shape, which is
a question with a very concrete answer: because the shape it had before stopped
working on a real corpus, in a way that could not be tuned around.

## The corpus that broke the format

The first format was one JSON document: a single object with an entity array and
an edge array, pretty-printed and diffable. It was pleasant to read and it worked
on everything we tried, until apache/fineract.

Fineract's model was **559.5 MB**. Node cannot read it. Not "reads it slowly" —
cannot: a JSON document has to become one JavaScript string before it can be
parsed, and V8's maximum string length is `0x1fffffe8`, roughly 512 MB. The
analyzer could not open its own output. No amount of streaming JSON parsing helps
if the file must first exist as a string, and no amount of memory helps either.

Profiling where those bytes went was more interesting than the failure itself.
For 240,910 entities and 782,031 edges:

| Payload | Size |
|---|---|
| edge `from`/`to` id strings | 185.8 MB |
| edge `anchor.file` paths | 90.3 MB |
| entity `id` strings | 47.5 MB |
| entity `parent` refs | 40.8 MB |
| entity `anchor.file` paths | 26.8 MB |
| `traits` arrays (a few dozen distinct sets) | 19.2 MB |
| `children` arrays (the inverse of `parent`) | 11.6 MB |
| `kind` strings (12 distinct values) | 3.0 MB |

Roughly **76% of the file was repeated strings drawn from tiny value sets**. Every
edge spelled both of its endpoints out in full as
`java:org.apache.fineract.portfolio.loanaccount.domain/Loan.…`. Every entity
repeated its file path. Twelve distinct `kind` values occupied three megabytes.

That profile is also a diagnosis. The file was not big because the corpus was
big; it was big because the encoding was spending its bytes restating things it
had already said.

## Two different problems wearing one complaint

"Performance is bad" was hiding two problems that want opposite solutions.

**Transport and parse.** One monolithic document, read all at once, in both
directions. The fix is streaming plus interning — never hold the whole thing as
one value, never spell a bounded vocabulary out more than once.

**Repeated analysis.** Every command re-parses the file and re-derives every
index from scratch, and a visualizer wants random access to a neighbourhood, not
a full load. The fix is a queryable store.

One format cannot be best at both, and trying to make it so is how formats become
unpleasant. So there are **two artifacts with two roles**:

```
extractor ──(writes)──▶ model.jsonl        the CONTRACT: schema-validated,
                            │              diffable, language-agnostic
              codegraph import (once)
                            ▼
                        model.db           the WORKBENCH: SQLite, indexed,
                            │              random-access
        analyze / export / metrics / city
```

`model.db` is a derived, disposable cache. It is regenerable from the `.jsonl` at
any time, never committed, and never the contract. That subordination is the
whole point: the store can be redesigned, migrated by regeneration, or thrown
away without anything downstream of the interchange noticing.

## What the line format does

The rules are few, and each one is doing a specific job.

**One JSON record per line, with the record type in a leading `"t"` key, and a
contractual section order:** `header → files → entities → edges → eof`. The order
is what makes a single pass sufficient — a reader that has seen the header knows
the dictionaries, and one that has seen every entity can check an edge's
endpoints as it reads them.

**Surrogate keys.** Entities carry a dense integer `i`, assigned in canonical
natural-key order. Every field that used to hold a rendered id — an edge's
endpoints, `parent`, `declaredType`, `parameters`, `candidates` — becomes an
integer. This is where the 185.8 MB of endpoint strings went.

Surrogates are **file-scoped and never stable across runs**. They are an encoding
device, not identity; [identity is the structured natural
key](/docs/explanation/identity/), and the natural key travels on the wire too, as the
module reference plus symbol plus disambiguator.

**Interning for bounded vocabularies.** Kinds, trait names, edge kinds and
provenance values are closed sets owned by the core package, so the header
carries a dictionary and records carry indices into it. The dictionaries are
*model-declared*, which matters more than it sounds: extending the core
vocabulary never renumbers an existing file. The one unbounded table — file paths
— gets a record per line rather than a header block, so no single line grows with
the size of the corpus.

**A trailing `eof` record carrying counts.** A header count would be friendlier
to a reader and hostile to a writer: a streaming writer like Jackson never
rewinds, and it does not know the counts when it starts. Putting them at the end
costs nothing and buys something the old format could not do at all — a run that
was killed halfway produces a file with no trailer, and truncation becomes
detectable instead of silent.

**Closure enforced by the encoding, not by a later check.** Because every
reference is a surrogate into a table the file itself declares, a dangling
reference is *unwritable*. It is not something the validator reports afterwards;
it is something that cannot be expressed. An extractor that cannot close a
reference drops it and says so in its diagnostics. This is the strongest form the
rule can take: the contract's most important invariant is enforced by the shape
of the contract.

**One thing deliberately not done: trait-set interning.** Traits ride inline on
each entity as an integer array. A dedicated record per distinct trait
combination was considered — there are only a few dozen distinct sets in a corpus
of a quarter-million entities — and rejected: inline integer arrays already
shrank 19.2 MB of trait strings to about 4–5 MB, and the indirection would have
saved perhaps 4 MB more on a 90 MB file while adding a record type, a dedup pass
to *every* extractor, and entity lines that cannot be read without a lookup. The
one genuine win of trait sets — validating each distinct `(kind, trait set)` pair
once — needs no wire support at all, because a reader can memoize it on its own.

## What it actually bought

The estimate was about 6×. The measurement was **559.5 MB → 127.4 MB, 4.4×**, on
240,929 entities and 782,032 edges: 94 seconds to extract, about 12 seconds for
any CLI command over it. commons-lang came in at 2.5× (17.1 MB → 6.9 MB). Both
fell short of the estimate for the same reason — we had assumed a larger share of
the bytes were id strings than actually were.

The ratio was never the point. **Fineract's v1 model could not be read at all**,
and this one can. A compression ratio is a nice-to-have; crossing back over a
hard platform limit is the deliverable.

## Why the contract is not just SQLite

If a store is faster to query, why keep a text file in front of it? Three
reasons, and they are the reasons the split has held.

**The extractor bar.** "Extractors contain no metamodel intelligence" is an
architectural rule, and it is only enforceable if conforming is easy. Emitting
flat, schema-validated lines keeps the bar at *any language that can print JSON*.
Asking a future Go or .NET extractor to build a correctly indexed relational
database moves intelligence back into extractors, one per language, where it will
diverge.

**Fixtures and cross-validation.** The Java extractor's output over the reference
corpus is committed, so any change in what it claims about known code shows up as
a reviewable diff. When a second extractor covers a language the first one does,
the richer one is the oracle and the other's edge set must be a subset of it.
Both of those need line-diffable, canonically ordered text. A binary database
file in git is a regression for both.

**Determinism.** Byte-identical output for identical input is a tested property
of the JSONL writer. It is essentially unachievable for a SQLite file, whose page
allocation varies for reasons no producer controls.

The store gets to be the fast thing precisely because it does not have to be any
of those things.

## Open questions

- **`.jsonl.gz` support in the reader.** Gzip stacks roughly 5× on top of the
  encoding's own saving, and the reader is already streaming, so this is a cheap
  follow-up rather than a design question. It was simply not part of the
  interchange milestone.
- **When versioning starts meaning something.** The format changed in place, with
  `schemaVersion` left at `1.0.0` and no old-format reader, because the format is
  internal today and bumping a version nobody consumes buys nothing. The first
  external consumer is the moment that stops being true.

## Where this shows up

- [Reference: the model.jsonl format](/docs/reference/model-jsonl/) — record types,
  section order, dictionaries, the per-record schemas.
- [How to write an extractor](/docs/how-to/write-an-extractor/) — conforming to the
  contract: record order, surrogates, the profile check.
- [Reference: model.db](/docs/reference/model-db/) and [how to query
  it](/docs/how-to/query-model-db/) — the workbench half of the split.
- [Tutorial: querying the model with SQL](/docs/tutorials/sql/).
- [Identity is a key](/docs/explanation/identity/) — why a surrogate is never identity.
