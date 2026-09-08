---
title: Extracting without compiling
linkTitle: No build required
weight: 3
---

The codebases most worth understanding are the ones nobody can build. A system
whose build depends on an internal artifact repository that was decommissioned, a
module whose parent POM references a plugin version that no longer resolves, a
branch nobody has compiled since the person who knew how to left — these are
exactly the codebases where a structural map earns its keep, and they are the
ones almost every analysis tool refuses.

The refusal is not laziness. A compiler-based analyzer gets its type resolution
for free: `foo.bar()` resolves because the compiler already knows what `foo` is.
Give up the build and you give up that. Codegraph gives it up anyway, and this
page is about what replaces it and what it costs.

## Sources in, no classpath

The Java extractor runs [Spoon](https://spoon.gforge.inria.fr/) in **noClasspath
mode**: it parses `.java` files and builds a model from them alone, with no jars,
no compiled dependencies and no build execution. You point it at a source root
and it emits a model. Nothing about the corpus's build health is consulted,
because nothing about it is needed.

The reference fixture makes the point concretely: it is a small order-management
corpus that **does not compile on purpose**. `javac` reports twelve errors across
two files, every one of them a `cannot find symbol` or `package does not exist`
for a type the corpus deliberately never declares — an external library that is
not on the classpath, and two types used without an import and declared nowhere.
Fixing those errors would make the fixture useless, because a corpus that
compiles cleanly cannot exercise the behaviour that matters.

The same property paid off somewhere unplanned. Replaying a project's history
means extracting old revisions, and old revisions frequently do not build: the
dependencies have moved, the JDK has moved, the plugins have moved. Because
extraction never builds anything, a 2008 tag extracts exactly as readily as
today's head. The [time replay](/docs/explanation/time-as-structure/) is only
affordable because of a decision made for a different reason.

## What replaces resolution: the stub

When the extractor meets a reference it cannot resolve to a corpus declaration,
it has three options. It can drop the reference — which silently truncates the
graph and is the worst of the three, because the reader cannot tell the
difference between "nothing here" and "we gave up". It can invent an entity —
which puts a fabrication in the model. Or it can record a **stub**.

A stub is not a separate node type. It is an ordinary entity with `isStub: true`,
degraded: a name, a type or module trait, no children, no anchor. Its edges are
kept in full. `LedgerAdapter extends LedgerClient` where `LedgerClient` is an
external library type still produces an `inheritance` edge; the endpoint simply
says "this is outside the corpus". The internal-only view is then a filter, not
a re-extraction — `--internal-only` drops stubs and every edge touching one,
uniformly, and the same model serves both readings.

Exactly two things are stubbable, because exactly two traits contribute
`isStub`: a **type** and a **module**. A module stub exists because the import
graph is module-level, so `import java.util.List` needs an endpoint for the
*package* `java:java.util`, which no corpus file declares. Its `definedIn: []` is
what makes it external. Without it, the one layer comparable across every
language could never satisfy graph closure.

A **member** — a method, a field — is deliberately *not* stubbable. An external
member folds up to its declaring type's stub, and an id that cannot be closed is
reported and dropped rather than fabricated. This is the boundary the whole stub
mechanism exists to defend: manufacturing a class named `bill(Order)` to close a
dangling endpoint is precisely the failure mode that would poison every metric
downstream. Primitives and `void` are not entities either, for the same reason —
a phantom class named `int` with a fan-in of hundreds would distort every
coupling number in the model.

## Why a name prefix lies

Here is the trap, and it is one every prefix-based tool falls into. Spoon in
noClasspath mode does not fail on an unresolvable reference — it **invents a
plausible fully-qualified name** by applying the ordinary resolution rules to
what it can see. A type used without an import gets the enclosing file's package
attached to it.

So the fixture's `OrderService.bill` uses a type `Invoice` that is imported
nowhere and declared nowhere, and Spoon reports it as
`com.acme.order.Invoice` — inside the corpus's own package. `LedgerAdapter`, in a
different package, does the same and yields `com.acme.order.adapter.AuditTrail`.
The invention follows the enclosing file, so there is no single prefix that
catches it.

A membership rule of the obvious shape — *is it internal? does its name start
with `com.acme`?* — classifies both of those inventions as corpus types. It
launders a static-analysis artefact into a fact, and it does so most often in
exactly the corpora codegraph is for, because unresolvable references are what
those corpora have a lot of.

{{< callout type="info" >}}
**Membership is decided by a whitelist of corpus-declared ids, built in a first
pass — never by a package or name prefix.** The rule is stated in the metamodel,
restated as an analyzer invariant, and pinned by the fixture: `Invoice` is a
stub, and it lives in `com.acme.order`.
{{< /callout >}}

The same rule constrains what a stub may carry. A stub type may declare a parent
— the external **module** it belongs to — because otherwise it could not be
folded to module level at all. But a stub's parent must itself be a stub:
attributing an external type to a *corpus* module would make it read as internal
to every module-level analysis. Where the parent cannot honestly be named — a
fabrication invented inside the corpus's own package, or a primitive, which has
no module — the stub stays parentless and is reported as unplaceable rather than
being filed somewhere convenient.

## The resolution rate, and what it actually measures

On the reference fixture, resolution is **94.1%**. It is a real number and it is
the wrong number to optimise, which is worth explaining because the temptation
to chase it is strong.

Two measurements on real corpora make the point. On **apache/commons-lang** —
263 files, 133,478 type references — resolution is **100.0%**, producing 15,338
entities of which 261 are stubs, and 24,631 edges, in 6.6 seconds. On
**spring-petclinic** — 30 files, 2,189 references — it is **77.8%**, with 487
unresolved.

Neither number says anything about the extractor's quality. commons-lang is
self-contained and depends on nothing but the JDK, which resolves against the
runner's own classpath; the corpus has almost no external dependency surface, so
it cannot fail to resolve. petclinic's 487 failures are Spring and Jakarta types
whose jars are simply absent — `jakarta.persistence`, `org.springframework.web`,
`org.springframework.data`. A jar that is not there cannot be resolved by any
extractor, so 77.8% is a structural floor for that corpus, not a defect.

**The rate measures a corpus's dependency surface, not the tool.** That
realisation also corrected the metric itself: every one of commons-lang's
originally "unresolved" references turned out to be `<nulltype>`, Spoon's static
type for the `null` literal — a pseudo-type that can never have a declaration.
The old figure was measuring how many `return null;` statements the project
contains. It is now excluded from the denominator, alongside type variables, for
the same stated reason.

For the same reason the test suite does not pin the rate. It keeps a deliberately
low floor and asserts that unresolved references exist at all, because a test
that demanded a high number would eventually pressure someone into deleting the
unresolvable half of a corpus to make it green. What *is* asserted, hard, is the
stub discipline: closure, no fabricated members, the whitelist rule.

## What you give up

Being straight about the trade-off:

- **Some references really are lost.** Around 6% on the reference corpus. A stub
  is honest, but it is still a gap — you can see that `LedgerAdapter` extends
  something external, and not what that something does.
- **Point the extractor at one source root.** A repository that splits one
  package across several roots — main and test, or several modules — confuses
  noClasspath resolution, because Spoon's view of "what else is here" is what
  drives the invention rules.
- **Resolution is corpus-wide.** The stub whitelist depends on every
  corpus-declared id, which is why incremental per-commit extraction is deferred:
  a model built from one changed file could not decide membership correctly.
- **Framework behaviour is invisible to extraction.** A Spring corpus without its
  jars declares none of the framework's types, so every annotation is a stub.
  That is handled a layer up, by [inference kept explicitly
  apart](/docs/explanation/facts-vs-inferences/) from the facts — and the framework
  matcher is stub-tolerant precisely because this is the normal case.

What you get in return is that the tool runs. On the codebase you inherited, at
the revision you inherited it at, without an afternoon spent resurrecting a build.

## Where this shows up

- [How to extract a Java repository](/docs/how-to/extract-java/) — choosing a source
  root, multi-module repositories, reading the diagnose summary.
- [Reference: stubs](/docs/reference/metamodel/stubs/) — the two stubbable things and
  the rules a stub obeys.
- [Reference: the Java extractor](/docs/reference/java-extractor/) — flags, the
  profile mapping, what resolves and what does not.
- [How to get a facts-only view](/docs/how-to/facts-only-view/) — `--internal-only`
  and what it removes.
- [Tutorial: your first code city](/docs/tutorials/first-city/) — extraction to
  picture in ten minutes.
