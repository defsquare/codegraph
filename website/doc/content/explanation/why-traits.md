---
title: Why traits, not a class hierarchy
linkTitle: Why traits
weight: 1
---

Every tool that models code has to answer one question before it can answer any
other: *what kind of thing is this?* A Java class, a Go method with a receiver, a
Clojure var holding a function, a Rust `impl` block, a lambda with no name. The
usual answer is a class hierarchy — `Entity` at the root, `NamedEntity` below it,
`Type` and `Behavioural` below that, and every language's constructs slotted into
the branches. It is the answer almost every code metamodel has given, and it is
the answer codegraph deliberately did not give.

Codegraph's entity is a flat record: `{id, kind, traits[], …the keys those traits
contribute}`. There is no hierarchy at all, and there is no plan to add one. This
page is about why, what it buys, and what it costs.

## The entity that breaks the tree

The case that settles the argument is small enough to fit in one line of Clojure:

```clojure
(defn bill [order] …)
```

That `def` creates a **var** — a named, mutable container — whose current value
happens to be a function. So the entity is, at the same time:

- **named** (`bill` is its symbol in the namespace),
- **a value holder** (it is a var; other code can read it, `alter-var-root` can
  rewrite it, and a reference to it is an *access* to a place, not a call),
- **invocable** (it has a parameter list and other code calls it).

Now try to place it in a tree. Under `Function`, and you lose the fact that it is
a storage location that can be read and rebound — the access edges have nowhere
to attach. Under `Variable`, and you lose the signature and every invocation
edge. Introduce `FunctionVariable` inheriting from both, and you have chosen
multiple inheritance, which is the same diamond problem one level up; the next
language brings a construct that needs a different pair, and the lattice grows
faster than the corpus does.

In codegraph the same var is written directly:

```json
{"kind": "function", "traits": ["TNamed", "TStructural", "TInvocable"], …}
```

`TNamed` contributes `name`, `TStructural` marks it a legal target of `access`
edges, `TInvocable` contributes `signature`. Nothing is lost and nothing is
fabricated. Composition is commutative and associative, so there is no ordering
question and no linearization rule to learn.

That single example is the design's motivating case, and it is written into
[the metamodel reference](/reference/metamodel/traits/) as such. It is worth
noticing that it is not exotic: a Python function object assigned to a name, a
JavaScript `const f = () => …`, a Go variable of function type, and a Java field
holding a lambda are all the same shape. Hierarchies handle these by picking a
winner and dropping the loser's edges.

## A trait is a micro-capability, and some contribute nothing

A trait is a named partial schema. It contributes zero or more attributes to any
entity that declares it, and it is the smallest unit the vocabulary has:
`TNamed` brings `name`; `TSourceAnchor` brings `anchor`; `TInvocable` brings
`signature`; `TMetrics` brings the open `metrics` map.

Several traits contribute **no** attributes at all — `TWithInvocations`,
`TWithAccesses`, `TWithInheritances`. They are markers: they say the entity is
*capable* of a relation whose data lives in the edge list. This is a deliberate
split. Edges are stored once, in the outgoing direction only, with their own
provenance and anchor; duplicating them as an array on the entity would mean two
places to keep in agreement and one of them eventually wrong. So a trait can be
a pure capability declaration, and the profile is still able to say "this
language's methods may invoke, its fields may not".

The corollary is that a trait's *absence* is information. `TWithInheritances` is
absent from the Go and Rust profiles because those languages have no inheritance
— that absence is a fact about the language, not a gap in the model.

## What FamixNG got right

The idea is not ours. It is [FamixNG](/explanation/prior-art/)'s, from the
Moose platform in Pharo: describe entities by composing traits rather than by
subclassing, so a language's constructs are assembled from capabilities instead
of being forced into a taxonomy designed around some other language's idea of a
class. FamixNG's authors reached that design by trying to extend a Java-shaped
Famix metamodel to languages that are not Java-shaped, which is exactly the wall
we would have hit.

What codegraph does differently is where the traits live. In Moose the metamodel
is generated Pharo code — classes, traits and all — and analysis happens in the
same image. Codegraph's traits are **data**: one Zod schema per trait in
`@codegraph/core`, from which the TypeScript type, the runtime validator, and
the published JSON Schema all fall out of one definition. That is what lets an
extractor written in Java, Go or C# conform to the model without importing a
line of it, and it is why the trait vocabulary is closed and canonical — names
like `TNamed` and `TAttachedTo` are never aliased or renamed locally, because a
name is the only thing an extractor in another language shares with us.

## Profiles are data, and that is the real payoff

A **language profile** states what a given language's extractor may produce: per
entity kind, which traits are required and which are optional, plus the edge
kinds the language can emit and a `notes` list for its documented blind spots.
Validation is one rule:

> `required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind)`

Strict equality was rejected — it breaks the moment an entity has a comment and
another does not. A free subset was rejected too — it hides extractor bugs by
accepting anything. The subset-with-a-floor rule is the useful middle.

The property that makes profiles worth the name is that **a profile can be
specified without being implemented**. Codegraph ships nine language profiles
and one extractor. The eight unimplemented profiles are not aspirational
comments; they are validated data, and writing them is how the trait vocabulary
got tested against languages nobody has extracted yet. The same trick reappears
one level up in framework semantics: a Micronaut profile validates with nothing
behind it, because a framework table is data too.

There is a performance consequence that reads like an accident and is not.
Because validity depends only on the pair `(kind, trait set)` and never on the
entity carrying it, a reader can decide each distinct pair once and reuse the
verdict. On apache/fineract that is a few dozen pairs across 240,910 entities.
The model's own shape handed the reader its cache key.

## Containment is not attachment

One more distinction the trait vocabulary makes that a hierarchy tends to blur.
*Where an entity is written* and *what it semantically belongs to* are two
different relations, and codegraph keeps both:

- `TChildOf` / `TWithChildren` — lexical containment. The stored direction is
  upward (`parent`); `children` is its inverse and is derived, never stored.
- `TAttachedTo` — semantic attachment.

They diverge exactly where languages get interesting. A Go method with receiver
`(o *Order)` is a *child* of the file or package where it is written and
*attached* to `Order`. So are C# extension methods, Rust `impl` blocks, and
Clojure `extend-type`. A model with only one containment relation must pick one
and lie about the other; the fold that produces a type-level dependency graph
would then either lose the method or attribute it to the wrong type.

## What it costs

Being honest about the trade: a flat, trait-composed entity is less convenient
than a typed class. Consumer code cannot switch on a subclass; it asks
`hasTrait(entity, "TType")`. There is no compiler-checked exhaustiveness over
entity shapes, so the profile validator has to do work a type system would
otherwise do for free. And the vocabulary has to be governed — a trait invented
locally, or a canonical name aliased for convenience, silently forks the
contract for every other extractor.

The rule that keeps that cost bounded is that consumers select on **traits**,
never on `kind` strings. A `kind` is per-profile vocabulary — `class`, `struct`,
`var`, `defmethod` — and code that switches on it stops working the day a tenth
language lands. The navigator's tree is built this way on purpose: modules are
whatever carries `TModule`, types whatever carries `TType`, operations whatever
carries `TInvocable`.

## Where this shows up

- [Reference: traits](/reference/metamodel/traits/) — the full vocabulary, with
  the attributes each trait contributes.
- [Reference: profiles](/reference/metamodel/profiles/) and the
  [nine shipped profiles](/reference/profiles/) — the validation rule and the
  per-kind tables.
- [How to write an extractor](/how-to/write-an-extractor/) — conforming to the
  contract from another language, and the profile check that gates it.
- [Prior art](/explanation/prior-art/) — Moose and FamixNG, and what codegraph
  took from them.
