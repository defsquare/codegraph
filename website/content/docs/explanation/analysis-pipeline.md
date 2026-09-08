---
title: The analysis pipeline
linkTitle: Analysis pipeline
weight: 6
---

Everything codegraph says about a codebase — a coupling table, a cycle report, a
DOT graph, a city, a navigator artifact — is produced by one pipeline, and every
stage of it is a pure function of the previous one. This page explains why it is
built that way, what each stage is for, and the handful of decisions that look
like implementation detail and are really the design.

The section numbers (`AN-1`, `AN-5`…) are decision records. The code cites them
back, and so do other pages here, so they are kept as they are.

## AN-1 · One pipeline, each stage a pure function of the last

```
loadModels(inputs)                 -> LoadResult { union, diagnostics }
  buildGraph(union)                -> CodeGraph        (entity map + derived inverse indexes)
    view: internalOnly | declaredOnly | composeViews(...)   (a predicate pair, no copy)
      foldGraph(graph, {level, view}) -> FoldedGraph   (aggregated weighted edges)
        queries: importGraph | typeDependencyGraph | neighboursOf
        metrics: coupling(folded) | cycles(folded)
          exports: toDot | toPlantUml | foldedGraphToCsv | foldedGraphToJson
```

Everything here is **pure computation**. Nothing mutates a model, writes back
into one, or performs I/O — the CLI reads files and prints, the analyzer only
computes. It runs in plain Node with no DOM and never imports Three.js, which is
what lets the same code serve the command line, the property suite, and the two
frontends through their model packages.

**A result always carries the view and level it was computed under.** A folded
graph, a coupling table, a cycle report and every export repeat them, because a
coupling number without its view is not a fact: filter the stubs out and every
number changes. That single rule is why so much of the pipeline is shaped around
views rather than around filtered copies.

## AN-2 · Load: two failure classes, treated differently

Loading takes one payload or many and produces a union plus diagnostics. The
useful decision here is that two kinds of wrongness get opposite treatment.

- **Schema errors are fatal.** A payload that is not a model cannot be analyzed
  at all, so parsing throws, named after the input it came from. A collect mode
  exists for batch runs that must report on every file rather than die on the
  first.
- **Profile violations are collected.** A model that breaks its language profile
  is still a graph, and refusing to look at it helps nobody. They come back
  bucketed by code, so a caller can gate on one specific violation.

Also diagnosed and never thrown: dangling references, self-edges, duplicate ids,
and languages with no profile in the registry — the last are analyzed anyway,
just not validated.

**The union is a concatenation, not a merge.** Ids are globally unique thanks to
the language prefix, so multi-language and multi-file unions concatenate without
renaming anything.

Two entry points share one half. One is for a payload nobody has validated; the
other skips the schema pass for payloads the record reader already validated line
by line. On fineract that second pass cost **2.6 s of an 11.7 s command** and
could only ever agree with the first. What is *not* skipped, because none of it
is redundant: profile validation, closure over the union (one model may reference
another's ids), self-edges, and cross-model redeclaration. A test pins that the
two paths agree on every fixture and every deliberately broken model.

{{< callout type="info" >}}
**`push(...array)` is banned in this package.** A spread passes one argument per
element, and a real corpus overflows the call stack long before it exhausts
memory: fineract, at 240,929 entities, failed with `Maximum call stack size
exceeded` — reported as an internal error, because that is exactly what it was.
Element-by-element loops, always.
{{< /callout >}}

## AN-3 · The graph: the model indexed, inverses derived

```ts
CodeGraph {
  union, entities, edges
  entity(id) has(id) ids() isStub(id)
  outgoing(id) incoming(id) outgoingOfKind(id, kind) incomingOfKind(id, kind)
  parentOf(id) childrenOf(id)                      // containment, as written
  callersOf(id) accessorsOf(id) subtypesOf(id)
  implementersOf(id) importersOf(id)               // derived inverses
}
```

**The model stores outgoing edges only; every inverse is built here, in memory,
on every run, and may never reach disk.** `childrenOf` is the inverse of the
stored `parent`; callers, accessors, subtypes, implementers and importers are the
inverses of the five edge kinds with a meaningful direction. If one of these maps
can be serialized, that is a bug, not an optimisation — a stored inverse is a
second copy of a fact, and second copies go stale.

The indexes are built in two passes, O(V) over entities and O(E) over edges,
rather than scanned per query. Sets become sorted frozen arrays once, at the end,
so every accessor returns deterministically ordered data that no caller can
mutate.

**First declaration wins** for a redeclared id, and the load diagnostics say
whether the duplicates agreed. Disagreement is a conformance error, not a silent
overwrite.

## AN-4 · Views are predicate pairs, not copies

A view is a descriptor plus an entity predicate plus an edge predicate. Building
one allocates that triple and nothing else: no clone of the model, no filtered
copy of 240,000 entities. `internalOnly`, `declaredOnly` and
`provenanceOnly(…)` compose, and the descriptor records the whole trail
(`internalOnly+declaredOnly`) so every downstream result can name its projection.

**An edge survives only if both endpoints survive the entity filter.** A
projection may not contain an edge to a node it excludes. That rule lives in one
function so no stage can forget it.

**Membership is the entity's own `isStub` flag** — a corpus-declared whitelist —
never a package or id prefix. Spoon in noClasspath mode invents plausible
fully-qualified names, so a prefix test would classify inventions as internal.
This is the same rule the [extraction side](/docs/explanation/extracting-without-compiling/)
enforces, restated where it could otherwise be quietly re-implemented.

## AN-5 · Folding is the load-bearing primitive

Every query, metric and export is a function of a folded graph. Folding walks the
**containment** chain to the nearest ancestor carrying the level's trait —
`TType` for type level, `TModule` for module level — and **never parses an id**.
`java:a.b/C.m()` looks like it names its package; that is the extractor's private
business.

Four choices are worth naming:

- **Memoization is not an optimisation, it is the algorithm.** On a
  15,000-entity model an unmemoized ancestor walk is quadratic. Caching every
  node on a resolved path makes total work linear per level, and one folder is
  kept per graph so the memo survives across stages that each fold.
- **Aggregation keeps the weight and what it aggregated.** Folding 24,600 base
  edges to type level produces many parallel edges between one pair. Collapsing
  them to a bare pair would discard exactly what makes the result auditable, so
  the count, the edge kinds and the provenances are all kept — which is how a
  folded edge can still answer whether a dependency is a fact or an inference.
- **A folding self-loop is kept and flagged**, not dropped. Two methods of one
  class calling each other is real cohesion at type level, and it is not the
  forbidden `from === to` of the stored model. Callers wanting a strict
  dependency graph filter on the flag.
- **Unfoldable is reported, not swallowed.** An entity whose container is missing
  *or excluded by the view* is listed in the diagnostics, and edges lost that way
  are counted. A silently smaller graph is how a wrong number gets believed.

## AN-6 · Queries

The **import graph** is the module-to-module layer — the only one comparable
across every language, so one code path serves every extractor. Endpoints are
normally already modules and folding is the identity; when one is not, it folds
to its containing module and the case is *reported*, because an extractor writing
the import layer below module granularity is a fact about that extractor, not
noise to swallow. Stub modules are kept when the view permits: an import of an
external module is a real dependency, and dropping it understates efferent
coupling.

The **type dependency graph** is every edge kind folded to the containing type,
with kinds and provenances surviving. **Neighbours** answers the derived
concepts for one entity — parent, children, callers, accessors, subtypes,
implementers, importers — every one an in-memory inverse index, never written
anywhere.

## AN-7 · Metrics, and the two places a number can lie

**Coupling** gives, per node: fan-out and fan-in as *distinct node* counts,
afferent and efferent coupling, instability `I = Ce / (Ca + Ce)`, and the summed
base edge weights.

Two decisions here exist because the obvious alternative produces a plausible
lie. Instability is **0, not `NaN`**, when nothing touches the node: a `NaN`
would propagate silently through every sort, every CSV cell and every JSON
payload, while "maximally stable" is the honest reading of an isolated node. And
**self-loops are excluded by default**, because counting them would give every
cohesive class `Ce ≥ 1` and `Ca ≥ 1` — instability could then never reach its
endpoints and "depends on nothing" would become inexpressible. Callers measuring
cohesion opt in, and the flag then applies to all four counters so a row stays
internally consistent.

**Cycles** are Tarjan strongly connected components, **iterative, with an
explicit frame stack — never recursion**. The textbook formulation recurses once
per node on the DFS path, and a folded graph of 15,000 nodes (the order
commons-lang folds to) exhausts V8's call stack. The failure appears only on real
corpora, as an inscrutable stack-overflow thrown from inside a metric; deep-chain
test cases fail loudly if anyone "simplifies" it back.

A component reports more than its members — internal edge count, the weight
holding it together, and the cycle edges themselves — because a bare list of ids
says a problem exists and nothing about how to break it. Each link carries the
count (the cost of cutting it), its kinds, its provenances, and whether all of it
is declared, so a user can attack an inferred link before a declared one.

**The tangle metric and the feedback set.** Each component additionally carries a
minimal weighted subset of its edges whose removal leaves it acyclic — what
Structure101 calls the offending dependencies — plus that subset's weight and the
ratio of the two, which the report rolls up as a tangle score. The decisions:

- The exact minimum feedback arc set is NP-hard. The heuristic is Eades–Lin–Smyth
  greedy, adapted to weights, followed by a **minimality pass** that re-admits,
  heaviest first, every candidate that no longer closes a cycle. Minimality is
  what makes a heuristic testable: removing the set yields a DAG, and re-adding
  any single member restores a cycle. Both are property-suite invariants,
  independent of optimality — which is the right thing to assert, since
  optimality is not available.
- Weights are the folded edge counts, so cutting a folded edge is priced at the
  number of base references someone would actually have to fix.
- **Self-loops are excluded from both sides of the metric.** It scores references
  *between* members; a folding-induced self-dependency is cohesion inside one
  member and is never cuttable.

## AN-8 · Exports are renderings, and honest ones

DOT, PlantUML, CSV and JSON share a set of rules:

- **Every visual channel maps to one documented fact.** Solid versus dashed is
  `declared` versus inference; the label is the aggregated count; DOT's line
  width is that count *bucketed* (1 / 2–4 / 5–16 / 17+) so two runs are
  byte-identical on every platform; a dashed node is a stub. Shape is
  deliberately *not* a channel — entity kind varies per language, so it goes in
  the tooltip rather than being mapped to an arbitrary glyph.
- **PlantUML's element follows the fold level**: `package` at module level,
  `class` at type level, because a module-level node carries `TModule` and not
  `TType`. Drawing it as a class would assert a type the model never declared.
- **The level and the view reach the rendered image**, not just a comment — DOT's
  header, PlantUML's title, a column per CSV row. A comment line would be read as
  data by a conforming CSV parser, and suppressing the header would drop it
  entirely.
- **An artefact says what it is.** The JSON export carries a `kind` and a
  `generatedBy`, and deliberately **no** `schemaVersion` — that key marks
  interchange output, and an export is not one.
- **Escaping is correctness, not cosmetics.** Ids may contain quotes,
  backslashes, newlines and angle brackets. Each exporter's escape is injective,
  so two different ids can never render as one label.
- **Sets become sorted arrays** everywhere, because a `Set` serializes to `{}`
  and because sorting is what makes two runs comparable.

## AN-9 · The conformance gate

The conformance check is the acceptance gate for any extractor, and it lives in
the analyzer rather than in the CLI because it is pure computation over a union:
the CLI formats what it returns, and the property suite, a CI job and a future
health panel must all get the same answer.

It **composes** what already exists — closure and self-reference from core,
profile validity from core's validator — and adds only what nothing else checked.
Its rules are named individually (`closure`, `self-reference`, `provenance`,
`candidates`, `profile`, `anchor`, `duplicate-id`) and each finding names exactly
one, because an extractor author fixes a *rule*, not a list of unrelated
messages.

It **never throws on a finding**: the report is the product. Only `error`
severity flips the verdict, so a warning can be added later without turning green
corpora red. Truncation keeps the findings list readable — one systemic extractor
bug would otherwise bury every other rule under 20,000 identical lines — while
the counts stay exact and say how many were dropped.

## AN-10 · Determinism, and where it is owned

Byte-identical output for identical input is a contract, not a nicety: it is what
makes snapshots reviewable, diffs meaningful and CI stable.

One module owns it — a locale-independent id comparison over UTF-16 code units, a
sort, a sorted-unique, a pair comparison. Every derived index, folded graph,
metric table and export is sorted with those, so `Map` and `Set` iteration order
never decides what a user sees. Sorting happens **once, at the boundary of the
stage that produces the data**: Tarjan returns raw components and the cycle stage
sorts them, so determinism has a single owner per stage rather than being
re-applied defensively downstream.

## AN-11 · Cost, measured

| Stage | Cost |
|---|---|
| load + unify | O(V + E) |
| build graph | O(V + E), two passes |
| view | O(1) to build; O(1) per predicate call |
| fold | O(V + E) with the memoized folder |
| coupling | O(V + E) |
| cycles (Tarjan) | O(V + E) |
| feedback arc set (per SCC) | O((V + E) log V) + O(&#124;F&#124;·(V + E)) minimality pass |
| exports | O(V + E) |

On **apache/fineract** (77,644 entities, 227,154 edges, a 38 MB model), whole
commands run end to end in about **3.1 s** — coupling in 3.08 s, type-level
cycles under the internal-only view in 3.15 s. Reading and validating the model
dominates; every graph stage after it is a fraction of a second. That ratio is
the reason the SQLite store exists, and the reason it is a cache rather than a
rewrite.

## AN-12 · Entry points

The package's index re-exports each stage in pipeline order — that file is
deliberately a *map of the stages* rather than a flat bag of helpers, so the
shape of the pipeline is visible from its public surface. The consumers are the
CLI (every command), the city model (graph → fold → coupling), the navigator
model, and the property suite that runs the invariants against every extractor
output. The per-command surface is in the [CLI reference](/docs/reference/cli/).

## AN-12b · Framework semantics, kept apart

The wiring pass answers a question the structural graph cannot: what the
*container* does. It reads two things the model already carries — annotation-use
edges with their written arguments, and the interface-implementation inverse
index — through a declarative table, and returns roles, injection points and
candidate edges. It returns them; it does not attach them. Every edge it produces
is `dynamic-candidate`. The full argument is in [facts and
inferences](/docs/explanation/facts-vs-inferences/); it is mentioned here because it
is a stage of this pipeline and obeys this pipeline's rules.

## Open questions

1. **A store-backed facade.** `codegraph import` builds a disposable `model.db`;
   the analyzer would gain a graph implementation reading it, so repeat runs skip
   parsing — which is nearly all of the 3 s above. The interface is already the
   seam; nothing above the graph stage should need to change.
2. **Incremental folding.** Re-folding from scratch is cheap today. If a watch
   mode lands, the memoized folder is the obvious place to invalidate per changed
   file rather than per run.
3. **Cross-language analyses.** The import layer is comparable across languages
   already; deeper comparisons need the intersection of the profiles involved,
   and nothing computes that intersection yet.
4. **Metric surface.** Coupling and cycles are in. Cohesion (the LCOM family),
   depth of inheritance, and instability against abstractness would all be
   functions of a folded graph plus core traits — no new stage, just new files.

## Where this shows up

- [Reference: the CLI](/docs/reference/cli/) and
  [`analyze`](/docs/reference/cli/analyze/) — the commands this pipeline serves.
- [How to get a facts-only view](/docs/how-to/facts-only-view/) — views, in practice.
- [How to gate a pipeline](/docs/how-to/ci-gate/) — the conformance gate and the
  cycle report's exit code.
- [How to export diagrams](/docs/how-to/export-diagrams/) — what solid, dashed and
  `<<stub>>` mean in a rendered graph.
- [Reference: exit codes](/docs/reference/exit-codes/) — the findings contract.
