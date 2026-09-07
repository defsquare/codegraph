---
title: Prior art
weight: 13
---

Nothing in codegraph is new in the way that matters. The trait-based metamodel,
the city metaphor, the tangle report, the animated history, the hotspot and
co-change analyses — each of these was invented by somebody else, most of them
more than fifteen years ago, and several of them by people who wrote papers we
have read. What codegraph does is put them behind one contract, on a model that
does not require a build, with facts and inferences kept apart.

This page credits the work and says, for each, what we took and where we differ.
Where we were unsure of a fact about someone else's tool, we have said less
rather than guessed.

## Moose and FamixNG

[Moose](https://modularmoose.org/) is a platform for software and data analysis,
built in Pharo (Smalltalk) and developed since the mid-1990s in an academic
consortium around the University of Bern and INRIA. You import a codebase into a
model, then query, visualize and mine it inside the environment. **Famix** is its
family of code metamodels; **FamixNG** is the redesign that composes entity
descriptions from **traits** — small named capabilities — rather than from a
single inheritance hierarchy, explicitly to escape the multiple-inheritance
problems that a taxonomy runs into once it has to cover more than one language.
Metamodels are declared in a generator and the entity code is generated from that
declaration.

**What codegraph took.** The central idea, unchanged: an entity is a composition
of capabilities, not a position in a tree. Our
[trait vocabulary](/explanation/why-traits/) is FamixNG's idea reimplemented, and
the Clojure function var that motivates our whole design is the same kind of
argument FamixNG's authors make.

**Where it differs.** Moose's metamodel is generated Pharo code, and analysis
happens in the same image. Ours is **data** — one schema per trait, from which
the type, the validator and a published JSON Schema all fall out — so an
extractor written in any language can conform without importing a line of ours.
That is a smaller and less capable system than Moose by design: Moose is an
environment, codegraph is a contract plus a pipeline.

## CodeCity

[CodeCity](https://wettel.github.io/codecity.html), by Richard Wettel and
Michele Lanza at the University of Lugano, is where the code city comes from:
classes are buildings, packages are the districts they stand in, and the
buildings' dimensions carry metrics — in the canonical assignment, number of
methods as height, number of attributes as base size, lines of code as colour. It
was built in VisualWorks Smalltalk on top of Moose, rendering through OpenGL, and
it was accompanied by empirical work on whether the metaphor actually helps
people answer questions about a codebase. Its last release was in 2009.

**What codegraph took.** The metaphor and the discipline behind it — that a
visual channel is a *binding to a metric*, declared and legible, not a stylistic
choice. Our [city model](/explanation/city-is-a-model/) makes that literal: the
artefact carries a machine-readable legend naming the metric, unit, scale and
observed domain for every channel, and the renderer generates its legend from it.

**Where it differs.** Three things. Our channels are **configurable** — height
and footprint are metric names you pass on the command line, including measures
the extractor emits, such as cyclomatic complexity. Our arcs are
**provenance-aware**: a declared dependency and an inferred one are visibly
different lines, which matters because we produce inferences and CodeCity's
input did not. And we have a **time axis**: the same city replays across a
repository's history on a frozen layout.

## Structure101

[Structure101](https://www.sonarsource.com/structure101/), from Headway Software,
was a commercial architecture tool built around organising a codebase's
dependency structure: the **Levelized Structure Map**, which arranges items so
that dependencies flow one way and makes the ones that do not stand out;
**tangles**, the cyclically dependent groups; and an excessive-structural-complexity
metric over them. Sonar acquired it in October 2024 and it is no longer sold as a
separate product.

**What codegraph took.** The framing of a cycle report. A list of the classes in
a cycle tells you a problem exists and nothing about what to do; Structure101's
insight was to name the *offending dependencies* — the smallest set whose removal
breaks the tangle. Our cycle report computes a minimum feedback arc set per
strongly connected component, prices each candidate edge by the number of base
references someone would actually have to change, and reports the ratio as a
tangle score. That the exact problem is NP-hard is stated, and the heuristic is
tested for the properties it can guarantee — remove the set and the component is
acyclic; re-add any single member and a cycle returns — rather than for
optimality it cannot.

**Where it differs.** Structure101 was an interactive, commercial workbench with
build-time enforcement. Codegraph's cycle report is a command that prints a table
or JSON and exits with a findings code, meant to be read by a person or gated on
in a pipeline.

## Gource

[Gource](https://gource.io/), by Andrew Caudwell, animates a repository's
history: directories are branches of a tree, files are leaves, and contributors
move around the tree touching the files they touched, at the time they touched
them. It reads logs from the common version-control systems and renders in
OpenGL. It is GPL-licensed and actively maintained.

**What codegraph took.** The conviction that history is something you should be
able to *watch*, and the sequencing lesson: our file-level replay shipped before
any extractor touched the time axis, precisely because everything Gource shows
comes from `git log` alone — which forced the genuinely hard problem, layout
stability, onto cheap data first.

**Where it differs.** Gource visualizes the repository's *file tree*. Our replay
visualizes the *model*: buildings are types, and a type's presence across
revisions is decided by key equality rather than by a path. The layout is
computed once over the union of every key that ever existed and then frozen, so
buildings rise and sink in place — [a decision explained
here](/explanation/time-as-structure/) — where Gource's tree grows organically.
Gource is also, frankly, more beautiful.

## Adam Tornhill: *Your Code as a Crime Scene*, Code Maat, CodeScene

Adam Tornhill's *Your Code as a Crime Scene* (Pragmatic Bookshelf, first edition
2014, second edition 2024) makes the argument this project's history features
rest on: version-control data is an under-used source of design information, and
forensic techniques applied to it find things static analysis cannot. **Code
Maat** is the open-source command-line miner accompanying the book — written in
Clojure, GPL-licensed — with analyses for author contribution, logical coupling,
code age, churn and ownership. **CodeScene**, from CodeScene AB, is the
commercial product that grew out of that work, adding hotspot prioritisation,
knowledge-distribution and bus-factor risk, and its own code-health metric.

**What codegraph took.** The analyses, by name: hotspots, logical coupling with
support and confidence thresholds, ownership and truck factor. We are
downstream of that thinking and say so.

**Where it differs.** Codegraph holds a *structural* model and a *history* model
at once, which lets it ask the two cross-graph questions: **hidden coupling**
(files that co-change with no path between them in the declared graph) and **dead
weight** (declared dependencies history has never exercised). Those are joins
between two graphs rather than analyses of one. The history facts also stay in
their own artifact and never merge into the structural model — [the provenance
set does not get a fifth value](/explanation/facts-vs-inferences/).

## Sourcetrail

[Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail), from Coati Software,
was an interactive source explorer: it indexed a codebase and gave three linked
views — a search, a graph of symbols and their relations, and a code view showing
every location of the selected symbol. It supported C/C++, Java and Python, with
an SDK for writing indexers for other languages, and it kept its index in an
embedded SQLite database. It was open-sourced under the GPL in 2019, and
discontinued in 2021; the repository is archived.

**What codegraph took.** Two things. The **shape of the index** — a code model as
an embedded SQLite database is the precedent our `model.db` follows, and it is
what makes "fan-in of this type" a query rather than a full load. And the
**question the navigator answers**: what depends on this symbol, and where
exactly. Our [navigator](/explanation/navigator/) is a browser page over a
precomputed artifact rather than a desktop application, but the interaction it is
imitating is Sourcetrail's.

**Where it differs.** Sourcetrail's indexers used compiler front ends, so a
project generally needed to be buildable or at least to have a compilation
database. Codegraph's Java extraction [needs no
build](/explanation/extracting-without-compiling/), and its store is a
regenerable cache rather than the artifact of record.

## jQAssistant

[jQAssistant](https://jqassistant.org/), from buschmais, scans a software project
into an embedded Neo4j graph and lets you query and constrain it in Cypher. Rules
come in two flavours — *concepts*, which enrich the graph with derived
information, and *constraints*, which detect violations — and they live in rule
files that a build can execute. Beyond Java classes it scans Maven descriptors,
git history, XML and more. It is GPL-licensed and actively maintained.

**What codegraph took.** The premise that a code model is worth putting in a
queryable database that the user, not the tool, gets to interrogate. Our SQLite
store exists for that reason, and the [SQL cookbook](/tutorials/sql/) is aimed at
the same user.

**Where it differs.** Two substantial ways. jQAssistant's Java scanner reads
**compiled bytecode**, so a project has to build; ours reads source. And its
graph is a property graph the user shapes with concepts, where ours is a fixed,
schema-validated metamodel with a closed vocabulary — less flexible on purpose,
because the vocabulary is a cross-language contract several extractors have to
share. jQAssistant is also an *enforcement* tool in a way codegraph is not: it
ships rule execution as a first-class build step.

## ArchUnit

[ArchUnit](https://www.archunit.org/) is a Java library for checking a
codebase's architecture from within ordinary unit tests: layering rules, package
dependency rules, slicing, cycle checks. It imports classes by analysing
**bytecode**, needs no special runner, and is Apache-licensed and actively
maintained by TNG Technology Consulting.

**What codegraph took.** Honestly, nothing structural — it is here because it
occupies the adjacent space and the difference is worth stating plainly.

**Where it differs.** ArchUnit is for a codebase whose architecture you *know*
and want to keep: you write the rule, and the test fails when someone breaks it.
Codegraph is for a codebase whose architecture you **do not know** and have to
discover — often one that does not compile, which puts it outside what a
bytecode-based tool can reach at all. The two are complementary rather than
competing: the natural pipeline is to discover a structure with one and pin it
with the other. Codegraph deliberately does not enforce rules, and its
[cycle report exit code](/reference/exit-codes/) is the closest it gets.

## Also

Two more, from outside this comparison. **Spoon** (INRIA) is the Java source
model that makes classpath-free extraction possible at all; the Java extractor is
a thin mapping over it, and its noClasspath mode is why codegraph works on legacy
that does not build. **Specy** supplies the domain vocabulary the
[explanations](/explanation/explaining-bottom-up/) are written in, so an
explanation names entities, aggregates, value types and events rather than
inventing its own terms.

## Where this shows up

- [Why traits](/explanation/why-traits/) — the FamixNG lineage in detail.
- [The city is a model](/explanation/city-is-a-model/) — the CodeCity metaphor,
  with declared bindings.
- [Time as structure](/explanation/time-as-structure/) — Gource and Tornhill,
  applied.
- [The analysis pipeline](/explanation/analysis-pipeline/) — the tangle metric and
  the feedback arc set.
- [How to query model.db](/how-to/query-model-db/) and the
  [SQL tutorial](/tutorials/sql/) — the queryable-index idea.
- [Tutorial: finding what depends on a class](/tutorials/navigator/).
