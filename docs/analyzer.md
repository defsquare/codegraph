# Analyzer — the design (`@codegraph/analyzer`)

Status: **shipped as M3/M4**, extended since (conformance gate, PlantUML export,
decoded-model load path). Companion docs:
[`model-metamodel.md`](model-metamodel.md) and
[`model-encoding.md`](model-encoding.md) for the model this consumes,
[`city-model.md`](city-model.md) for the first consumer downstream of it.

This doc records the choices — the pipeline, the data structures, the
algorithms and their costs, the entry points, and the rules that are not
negotiable. `AN-n` are decision records; the code cites them back.

---

## AN-1 One pipeline, each stage a pure function of the last

```
loadModels(inputs)                 -> LoadResult { union, diagnostics }
  buildGraph(union)                -> CodeGraph        (entity map + derived inverse indexes)
    view: internalOnly | declaredOnly | composeViews(...)   (a predicate pair, no copy)
      foldGraph(graph, {level, view}) -> FoldedGraph   (aggregated weighted edges)
        queries: importGraph | typeDependencyGraph | neighboursOf
        metrics: coupling(folded) | cycles(folded)
          exports: toDot | toPlantUml | foldedGraphToCsv | foldedGraphToJson
```

Everything is **pure computation**. Nothing mutates a model, writes back into
one, or performs I/O — the CLI reads files and prints; the analyzer only
computes. It runs in plain Node with no DOM and never imports Three.js, which
is what lets the same code serve the CLI, the property suite, and (through
`@codegraph/city`) the renderer.

**A result always carries the view and level it was computed under.** A folded
graph, a coupling table, a cycle report and every export repeat them, because a
coupling number without its view is not a fact — filter the stubs out and every
number changes.

## AN-2 Stage 1 — load: two failure classes, treated differently

`loadModels(inputs, options)` takes one payload or many and produces a
`ModelUnion` plus `LoadDiagnostics`.

- **Schema errors are fatal.** A payload that is not a `Model` cannot be
  analyzed at all, so `parseModel` throws, wrapped as `ModelLoadError` naming
  the input. `onSchemaError: "collect"` exists for batch runs that must report
  on every file rather than die on the first.
- **Profile violations are collected.** A model that breaks its language
  profile is still a graph, and refusing to look at it helps nobody. They come
  back as `ProfileIssue[]`, bucketed by code in `profileIssueCounts` so a caller
  can gate on a specific code.

Also diagnosed, never thrown: dangling references, self-edges, duplicate ids
(conflicting or not), and langs with no profile in core's registry — the last
are analyzed anyway, just not validated.

**The union is a concatenation, not a merge.** Ids are globally unique thanks to
the `lang:` prefix, so multi-language and multi-file unions concatenate without
renaming. `models` keeps the inputs as they are; `entities`/`edges` are flat
views over them in input order.

**Two entry points, one shared half.** `loadModels` is for a payload nobody has
validated (raw JSON, a hand-built test model). `loadDecodedModels` skips the
Zod pass for payloads `readModelFileSync` already validated line by line —
measured on apache/fineract, that second pass cost **2.6 s of an 11.7 s
command** and could only ever agree. What is *not* skipped, because none of it
is redundant: profile validation, closure over the union (one model may
reference another's ids), self-edges, cross-model redeclaration.
`load-equivalence.test.ts` pins that the two agree on every fixture and every
deliberately-broken model.

**`push(...array)` is banned here.** A spread passes one argument per element,
and a real corpus overflows the call stack long before it exhausts memory —
fineract (240 929 entities across the whole corpus) failed with `Maximum call
stack size exceeded`, reported as an internal error, because that is exactly
what it was. Element-by-element loops, always.

## AN-3 Stage 2 — `CodeGraph`: the model indexed, inverses derived

```ts
CodeGraph {
  union, entities: ReadonlyMap<EntityId, Entity>, edges: readonly Edge[]
  entity(id) has(id) ids() isStub(id)
  outgoing(id) incoming(id) outgoingOfKind(id, kind) incomingOfKind(id, kind)
  parentOf(id) childrenOf(id)                      // containment, as written
  callersOf(id) accessorsOf(id) subtypesOf(id)
  implementersOf(id) importersOf(id)               // derived inverses
}
```

**The model stores outgoing edges only (invariant 4); every inverse is built
here, in memory, on every run, and may never reach disk.** `childrenOf` is the
inverse of the stored `parent`; callers, accessors, subtypes, implementers and
importers are the inverses of the five edge kinds that have a meaningful
direction. If one of these maps can be serialized, that is a bug, not an
optimization.

**Built in two passes — O(V) over entities, O(E) over edges** — rather than
scanning per query. Sets become sorted frozen arrays once, at the end, so every
accessor returns deterministically ordered data and no caller can mutate an
internal.

**First declaration wins** for a redeclared id; the load diagnostics say whether
the duplicates agreed. Disagreement is a conformance error, not a silent
overwrite.

## AN-4 Stage 3 — views are predicate pairs, not copies

```ts
View { descriptor: ViewDescriptor, entity: EntityPredicate, edge: EdgePredicate }
```

Building a view allocates the pair and nothing else: no clone of the model, no
filtered copy of 240 000 entities. `identityView`, `internalOnly`,
`declaredOnly`, `provenanceOnly(...)` compose through `composeViews`, and the
descriptor records the whole trail (`internalOnly+declaredOnly`) so every
downstream result can name its projection.

**An edge survives only if both endpoints survive the entity filter.** A
projection may not contain an edge to a node it excludes, and an edge whose
endpoint the graph never declares is not projectable either. That rule lives in
`includesEdge`, in one place, so no stage can forget it.

**Membership is the entity's own `isStub` flag** — a corpus-declared whitelist —
never a package or id prefix (invariant 6). Spoon in `noClasspath` mode invents
plausible FQNs, so a prefix test would classify invented names as internal.

`projectView` materializes a view as arrays for callers that genuinely need
lists; nothing in the pipeline uses it as an intermediate.

## AN-5 Stage 4 — folding, the load-bearing primitive

Every query, metric and export is a function of a `FoldedGraph`. Folding walks
the **containment** chain (`parent`, `TChildOf`) to the nearest ancestor
carrying the level's trait — `TType` for type level, `TModule` for module level
— and **never parses an id** (invariant 7): `java:a.b/C.m()` looks like it names
its package, but that is the extractor's private business.

```ts
FoldedNode { id, kind, name, isStub, members }
FoldedEdge { from, to, count, kinds, provenances, selfLoop }
FoldedGraph { level, view, nodes[], edges[], diagnostics, node(), outgoing(), incoming() }
```

Choices:

- **Memoization is not an optimization, it is the algorithm.** On a
  15 000-entity model an unmemoized ancestor walk is quadratic. `createFolder`
  caches every node on a resolved path, so total work is O(V) per level, and
  `folderFor` keeps one folder per graph in a `WeakMap` so the memo survives
  across stages that each fold.
- **Aggregation keeps the weight and what it aggregated.** Folding 24 600 base
  edges to type level produces many parallel edges between one pair; collapsing
  them to a bare pair would discard exactly what makes the result auditable, so
  `count`, `kinds` and `provenances` are kept (a caller can still ask whether a
  dependency is a fact or an inference).
- **Endpoints are carried, never packed into a map key.** The accumulator is a
  nested `Map<from, Map<to, …>>` because an id is an opaque string that may
  contain any character — a packed `${from}<NUL>${to}` key would make
  correctness depend on a separator never appearing inside an id.
- **A folding self-loop is kept and flagged**, not dropped. Two methods of one
  class calling each other is real cohesion at type level and is *not* the
  forbidden `from === to` of the stored model. Callers wanting a strict
  dependency graph filter on `selfLoop`; `dropSelfLoops` exists for those that
  want it gone at the source.
- **Unfoldable is reported, not swallowed.** An entity whose container is
  missing *or excluded by the view* is listed in
  `diagnostics.unfoldableEntities`, and edges lost that way are counted in
  `droppedEdges`. A silently smaller graph is how a wrong number gets believed.

## AN-6 Stage 5 — queries

- **`importGraph(graph, view)`** — the module→module layer, the only one
  comparable across every language (invariant 9), so one code path serves every
  extractor. Endpoints are normally already modules and folding is the identity;
  when one is not, it folds to its containing module and the case is reported in
  `importDiagnostics.nonModuleEndpoints`. That is a fact about the extractor —
  it wrote the import layer below module granularity — not noise to swallow.
  Stub modules are kept when the view permits: an import of an external module
  is a real dependency, and dropping it understates efferent coupling.
- **`typeDependencyGraph(graph, view)`** — every edge kind folded to the
  containing type, with `kinds`/`provenances` surviving.
- **`dependenciesOf` / `dependentsOf`** — distinct neighbours, self-loop
  excluded (a node is not its own dependency), which keeps them equal to the
  default `fanOut`/`fanIn`.
- **`neighboursOf(graph, id)`** — METAMODEL §9's derived concepts for one
  entity: parent, children, callers, accessors, subtypes, implementers,
  importers. Every list is an inverse index rebuilt in memory and never written
  anywhere.

## AN-7 Stage 6 — metrics

**Coupling** (`coupling(folded)`), per node: `fanOut`/`fanIn` as **distinct
node** counts, `ce`/`ca`, instability `I = Ce / (Ca + Ce)`, and the summed base
edge weights `outgoingEdgeCount`/`incomingEdgeCount`.

- Instability is **0, not `NaN`**, when nothing touches the node: `NaN` would
  propagate silently through every sort, CSV cell and JSON payload, and `I = 0`
  ("maximally stable") is the honest reading of an isolated node.
- **Self-loops are excluded by default.** Counting them would give every
  cohesive class `Ce ≥ 1` and `Ca ≥ 1`, so instability could never reach its
  endpoints and "depends on nothing" would become inexpressible. Callers
  measuring cohesion opt in, and the flag then applies to all four counters so a
  row stays internally consistent.

**Cycles** (`cycles(folded)`): Tarjan strongly connected components,
**iterative, with an explicit frame stack — never recursion**. The textbook
formulation recurses once per node on the DFS path, and a folded graph of
15 000 nodes (the order commons-lang folds to) exhausts V8's call stack. The
failure appears only on real corpora, as an inscrutable
`Maximum call stack size exceeded` thrown from inside a metric; the deep-chain
cases in `cycles.test.ts` fail loudly if anyone "simplifies" it back.

A component reports more than its members: `internalEdgeCount`, `weight` (base
edges holding it together) and the `CycleEdge[]` themselves — because a bare
list of ids says a problem exists and nothing about how to break it. Each link
carries `count` (the cost of cutting it), its kinds, its provenances and
`allDeclared`, so a user can attack an inferred link before a declared one.

## AN-8 Stage 7 — exports: renderings, and honest ones

`toDot`, `toPlantUml`, `foldedGraphToCsv` / `couplingToCsv` / `cyclesToCsv`,
`foldedGraphToJson` (+ coupling/cycle JSON). Rules they share:

- **Every visual channel maps to one documented fact.** Solid vs dashed edge is
  `declared` vs inference; the label is the aggregated `count`; DOT's `penwidth`
  is that count *bucketed* (1 / 2–4 / 5–16 / 17+) so two runs are byte-identical
  on every platform; a dashed node is a stub. Shape is deliberately not a
  channel — entity `kind` varies per language, so it goes in the tooltip rather
  than being mapped to an arbitrary glyph.
- **PlantUML's element follows the fold level**: `package` at module level,
  `class` at type level, because a module-level node carries `TModule`, not
  `TType`. Drawing it as a class would assert a type the model never declared.
- **The level and the view reach the rendered image**, not just a comment —
  DOT's header, PlantUML's `title`, and a column per CSV row (a comment line
  would be read as data by a conforming parser, and `header: false` would drop
  it entirely).
- **An artefact says what it is**: the JSON export carries
  `kind: "codegraph.foldedGraph/1"` and `generatedBy`, and deliberately **no**
  `schemaVersion` — that key marks interchange output, and this is not one.
- **Escaping is correctness, not cosmetics.** Ids may contain quotes,
  backslashes, newlines and `<`; each exporter's escape is injective, so two
  different ids can never render as one label. CSV quoting is RFC 4180 with LF
  records; PlantUML uses its own `<U+XXXX>` form.
- **Sets become sorted arrays** everywhere, because `JSON.stringify(new Set())`
  is `{}` and because sorting is what makes runs comparable.

## AN-9 The conformance gate

`checkConformance(union, options)` is the acceptance gate of PLAN.md §8, and it lives
here rather than in the CLI because it is pure computation over a `ModelUnion` —
the CLI formats what it returns, and the property suite, a CI job and a future
health panel must all get the same answer.

It **composes** what already exists rather than restating it: closure and
self-reference from core's `unknownReferences`/`selfReferences`, profile
validity from core's `validateModel`. What it adds is what nothing checked
before — the `candidates` rule, edge anchor well-formedness, and union-wide
conflicting redeclaration.

- Rules: `closure`, `self-reference`, `provenance`, `candidates`, `profile`,
  `anchor`, `duplicate-id`. Each finding names exactly one, because an extractor
  author fixes a *rule*, not a list of unrelated messages.
- **It never throws on a finding.** The report is the product: `ok`, the
  findings, exact `counts`, and the subject. Only `error` severity flips `ok`,
  so a `warning` can be added later without turning green corpora red.
- `maxPerRule` truncates the findings list (one systemic extractor bug otherwise
  buries every other rule under 20 000 identical lines) while counts stay exact
  and `counts.suppressed` says how many were dropped.
- `known` lets one model of a corpus be checked while its siblings are not
  loaded, without closure failing on legitimate cross-model references.

## AN-10 Determinism, and where it is owned

Byte-identical output for identical input is a contract, not a nicety: it makes
snapshots reviewable, diffs meaningful and CI stable.

`order.ts` owns it — `compareIds` (UTF-16 code units, locale-independent),
`sortIds`, `sortedUnique`, `comparePairs`. Every derived index, folded graph,
metric table and export is sorted with those, so `Map`/`Set` iteration order
never decides what a user sees. Sorting happens **once, at the boundary of the
stage that produces the data**: Tarjan returns raw components and `cycles`
sorts them, so determinism has a single owner per stage rather than being
re-applied defensively downstream.

## AN-11 Cost, measured

| Stage | Cost |
|---|---|
| load + unify | O(V + E) |
| `buildGraph` | O(V + E), two passes |
| view | O(1) to build; O(1) per predicate call |
| fold | O(V + E) with the memoized folder |
| coupling | O(V + E) |
| cycles (Tarjan) | O(V + E) |
| exports | O(V + E) |

On **apache/fineract** (`fineract-provider/src/main/java`: 77 644 entities,
227 154 edges, a 38 MB `model.jsonl`), whole commands run end to end in about
**3.1 s** — `analyze --report coupling` 3.08 s, `analyze --report cycles --level
type --internal-only` 3.15 s. Reading and validating the model dominates;
every graph stage after it is a fraction of a second.

## AN-12 Entry points

The package's `index.ts` re-exports each stage in pipeline order — that file is
the map of the package, and it is deliberately a list of stages rather than a
flat bag of helpers.

```ts
// stage 1
loadModels(inputs, options) · loadDecodedModels(models, options) · isClean(diagnostics)
// gate
checkConformance(union, options)
// stage 2
buildGraph(union) · sortedEntities(graph) · entityName(entity) · hasTrait(entity, trait)
// stage 3
identityView · internalOnly · declaredOnly · provenanceOnly(...) · composeViews(...) · projectView
// stage 4
foldGraph(graph, {level, view, edgeKinds, dropSelfLoops}) · folderFor(graph)
containingType(graph, id) · containingModule(graph, id)
// stage 5
importGraph(graph, view) · typeDependencyGraph(graph, view) · neighboursOf(graph, id)
dependenciesOf(folded, id) · dependentsOf(folded, id)
// stage 6
coupling(folded, options) · cycles(folded, options) · topByFanIn/topByFanOut(table, n)
// stage 7
toDot(folded, options) · toPlantUml(folded, options) · foldedGraphToCsv · couplingToCsv
cyclesToCsv · foldedGraphToJson · couplingToJson · cyclesToJson · toJsonString
```

Consumers: `@codegraph/cli` (every command), `@codegraph/city` (`buildGraph` →
`foldGraph` → `coupling`), and the property suite, which runs the invariants
against every extractor output.

## AN-13 Open questions

1. **A DB-backed facade (M7).** `codegraph import` builds a disposable
   `model.db` cache; the analyzer would gain a `CodeGraph` implementation
   reading it, so repeat runs skip parsing — which is the 3 s above, almost
   entirely. The interface is already the seam; nothing above stage 2 should
   need to change.
2. **Incremental folding.** Re-folding from scratch is cheap today. If a watch
   mode lands, the memoized folder is the obvious place to invalidate per
   changed file rather than per run.
3. **Cross-language analyses.** The import layer is comparable across languages
   already; deeper comparisons need the intersection of the profiles involved
   (invariant 9) and nothing here computes that intersection yet.
4. **Metric surface.** Coupling and cycles are in. Cohesion (LCOM-family),
   depth of inheritance and instability-vs-abstractness (the main sequence)
   would all be functions of a folded graph plus core traits — no new stage,
   just new files under `metrics/`.
