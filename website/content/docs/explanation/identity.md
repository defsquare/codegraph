---
title: Identity is a key, not a string
linkTitle: Identity
weight: 5
---

Before a tool can say that `A` depends on `B`, it has to be able to say that this
`B` and that `B` are the same `B`. Identity sounds like a detail and it is
actually the load-bearing decision of the whole model: it decides whether an edge
lands on the right node, whether two overloads stay two entities, whether the
same class in two snapshots of a repository is recognised as one thing over time,
and whether a union of models from different languages can be formed at all.

Codegraph's answer is stated as a metamodel decision, cited from the code, and
short enough to quote whole.

## MM-1 · Identity is the structured key, not an opaque string

> **Identity is the structured key `(lang, module, symbol, disambiguator?)`.**
> Consumers compare it component-wise and never parse a rendered string. A
> rendered id — `java:com.acme.order/OrderService.bill(com.acme.order.Order)` — is
> a display-only projection.

| Component | Role |
|---|---|
| `lang` | the language id, frozen per profile (`java`, `ts`, `clj`, …) |
| `module` | the owning module. A **module names itself here**, with an empty `symbol` |
| `symbol` | the path below the module — dots for nesting; empty only for a module |
| `disambiguator` | optional: `file:line:column` for anonymous entities, `param:` / `local:` markers for sub-members; absent when the symbol is already unique |

Uniqueness is over the union: no two entities share
`(lang, module, symbol, disambiguator)`. The key is also *multi-declaration
tolerant* — one key may legitimately be declared in several places, which is what
TypeScript declaration merging and C# partial classes do.

## Why the rendered form exists at all, and why nothing parses it

A structured key is awkward to print. So core renders one, as
`<lang>:<module>[/<symbol>][#<disambiguator>]`, and that string is what appears
in a report, on a navigator row, in a `--scope` argument and in a DOT label. It
is a projection for humans.

The rule that everything else follows from is that **nothing parses it back**.
Not the analyzer, not the city, not the navigator. This is not fastidiousness; it
is a direct consequence of [extracting without a
build](/docs/explanation/extracting-without-compiling/). An id *looks* like it names
its package — `java:a.b/C.m()` seems to say the package is `a.b` — but which part
of a name is a package is the extractor's private business, and in noClasspath
mode a plausible-looking package may be one Spoon invented.

So every consumer that needs containment walks the model's own `parent` chain
instead. The analyzer's fold to type or module level is a memoized ancestor walk.
The navigator nests `com.acme.order.adapter` under `com.acme.order` because the
extractor emitted that parent relation, and puts `java.lang` at the root because
nothing said otherwise. The city's districts come from the same walk. In each
case a string split would have been shorter to write and would have been an
inference dressed as a fact.

## Rendering has to be injective, or entities silently merge

If the rendered id is a projection, it has to be a *lossless* one — otherwise two
distinct keys can render as the same string, and downstream one entity quietly
absorbs the other, with no error anywhere.

That is why `/` and `#` are **reserved** in the key's components: a `module` may
contain neither, a `symbol` may not contain `#`, and a present `disambiguator` is
non-empty. Under those rules rendering is injective. Core's `renderId` validates
and throws rather than emitting a lossy id.

This failure mode is not hypothetical; it was found one level down first. The
reference corpus contains two overloads whose parameter types have identical
simple names in different packages:

```java
void archive(java.util.List<Order> orders)          { … }
void archive(com.acme.order.legacy.List orders)     { … }
```

Under simple names both render `OrderService.archive(List)`, collapse into one
id, and one method disappears from the model — no diagnostic, just a smaller
graph. Ids therefore use **erased fully-qualified names** in the parameter list.
The separator reservation is the same bug caught one level up: a collision
between two keys, prevented by construction rather than detected afterwards.

The column in an anonymous entity's disambiguator is load-bearing for the same
reason. A single line can start several nameless entities — the fixture has two
lambdas beginning on the same line, which is not a typo — and without the column
they collapse into one id. Worse, a nested one then becomes its own parent.

## Why a module names itself

The one component that surprises people is `module`: a package's own key names
*itself* there, with an empty symbol, rather than naming its parent package.

The alternative was tried and rejected for two reasons. It renders the package
`java:com.acme.order` as `java:com.acme/order`, breaking the id shape everything
already displays. And it needs a parent for every module — including the stub
package `java:java.util`, whose parent is a module called `java` that no corpus
declares and that we would therefore have to fabricate. Fabricating containers to
satisfy a scheme is exactly what the [stub
discipline](/docs/explanation/extracting-without-compiling/) exists to prevent, so the
scheme changed instead.

## Canonical order belongs to the model

Sorting is part of identity's job. The canonical order is sort by natural key,
component by component, with a missing disambiguator ordering before any present
one — and it is deliberately **not** the same as sorting rendered ids as strings,
where `/` and `.` are ordinary characters with their own collation.

That order belongs to the *model*, not to any encoding, because it is what makes
two things possible: a snapshot diff that a human can review, and extractor
cross-validation, where one extractor's edge set is checked against a richer
one's. Both compare files line by line, and both are meaningless if the line
order is incidental. Every encoding then decides how the order manifests
physically — the line format assigns its integer surrogates in exactly this
order, which is why they come out deterministic.

## What a surrogate is not

The interchange spells references as dense integers, and the SQLite store keeps
those same integers as its row ids. It is worth being explicit: **a surrogate is
not identity**. It is file-scoped, it is not stable across runs, and it never
crosses a file boundary. Two models of the same corpus extracted a minute apart
may number their entities differently and still describe exactly the same
entities, because sameness is the key.

The rule cuts the other way too. Anything that joins across files — a
multi-language union, checking whether an id is corpus-declared, comparing two
revisions of a repository — joins on the natural key tuple, never on a number and
never on a rendered string.

## The dividend nobody planned for

Making identity a key was a correctness decision. It turned out to be what made
the time axis affordable.

"The same entity in two snapshots" is normally a research problem — diff
heuristics, similarity matching, name tracking. Here it is key equality, for
free, for every named entity. A class that survives fifty-five release tags is
the same key at all fifty-five. That is what `codegraph timeline` reads, and
what lets the replay freeze one layout over the union of every key that ever
existed.

The limits are stated rather than hidden. A renamed symbol is a **death plus a
birth**, because a different name is a different key and rename matching is
heuristic machinery we chose not to build until a corpus proves it necessary.
Anonymous entities are not tracked over time at all: their disambiguator is a
file position, and any edit above them shifts it.

## Where this shows up

- [Reference: identity](/docs/reference/metamodel/identity/) — the key, the rendering
  rules, canonical order.
- [Reference: the model.jsonl format](/docs/reference/model-jsonl/) — how the key and
  its surrogates appear on the wire.
- [Why the interchange is a line-based file](/docs/explanation/why-jsonl/) — where the
  surrogates came from.
- [How to compare two snapshots](/docs/how-to/compare-snapshots/) and the
  [history replay tutorial](/docs/tutorials/history-replay/) — key equality over time.
- [Time as structure](/docs/explanation/time-as-structure/) — lineage, and what it
  cannot follow.
