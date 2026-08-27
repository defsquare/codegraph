# City model — the design (`@codegraph/city`)

Status: **shipped as the first city slice** (`packages/city`, `codegraph city`).
Companion docs: [`model-metamodel.md`](model-metamodel.md) and
[`model-encoding.md`](model-encoding.md) describe the *interchange* model this
one is derived from; `CLAUDE.md` holds the visualization rules the renderer
must obey.

This doc records the choices — the data structures, the algorithms, the entry
points, and what was deliberately left out. Layout and 2D bin packing are
**not** part of this slice; CM-8 states the contract they will consume.

---

## CM-1 A city is a second MODEL, not a picture

The transform produces data, in its own vocabulary, and stops there. It does
not position anything, does not choose colours, does not emit geometry, and
does not import Three.js.

Three consequences, and they are the reason the package exists at all:

- **It is testable without a renderer.** Every claim in the artefact is a
  number or an id that a test can assert on. A bug in "how tall is
  `OrderService`" is caught by a unit test, not by squinting at a screenshot.
- **The renderer becomes replaceable.** `packages/viz` reads this and draws it;
  a second renderer (SVG, a print plan, a diff view) reads the same thing.
  Nothing that matters lives inside the renderer.
- **The boundary is enforceable.** `city` sits beside `analyzer` under the
  no-DOM, no-`three` ESLint rule; `viz` is still the only package allowed to
  depend on `three`.

**Why a package and not a folder in `analyzer`.** The analyzer's vocabulary is
entities, edges, folds, views and metrics. Districts and buildings are a
*different* vocabulary, and mixing them would invite analyzer code to reason in
city terms. The dependency runs one way: `city` → `analyzer` → `core`.

## CM-2 The mapping, and who decides it

```
module (TModule)   ->  DISTRICT   the landscape a building stands on
type   (TType)     ->  BUILDING   dimensions from configurable metrics
type dependency    ->  ARROW      drawn roof to roof, weighted by count
```

The city does **not** select these itself — the analyzer's fold does, and that
matters:

- Buildings are the nodes of `foldGraph(graph, { level: "type", view })`.
- A building's district is `folder.containingModule(id)` — the `TChildOf` chain
  walked to the nearest `TModule` ancestor, memoized.
- Arrows are the folded edges of that same graph.

So membership follows the model's own containment, never a parsed name or id
(CLAUDE.md invariant 7). The city inherits the fold's guarantees for free:
aggregation, view filtering, deterministic order, and the diagnostics for what
could not be folded.

**Arrows attach at the roof.** That is stated once, in
`CityModel.conventions.arrowAttachment: "roof"`, rather than repeated per
arrow: it is a property of the whole drawing, and a renderer needs to be told
it exactly once. `heightAxis: "y"` and `groundPlane: "xz"` are declared beside
it for the same reason.

## CM-3 Data structures

One flat, sorted, JSON-shaped tree. No classes, no cycles, no `Map`s in the
artefact — it must survive `JSON.stringify` unchanged and arrive intact in a
browser.

```ts
CityModel {
  kind: "codegraph.city/1"      // an artefact, never a model.jsonl
  generatedBy: "@codegraph/city"
  view: ViewDescriptor          // a city without its view is not a fact
  conventions: { arrowAttachment: "roof", heightAxis: "y",
                 groundPlane: "xz", units: "city" }
  bindings:   ResolvedBinding[] // channel -> metric, scale, range, domain, misses
  districts:  District[]        // sorted by id
  buildings:  Building[]        // sorted by id
  arrows:     Arrow[]           // sorted by (from, to)
  diagnostics: CityDiagnostics
}

District { id, name, kind, isStub, parent?, buildings: EntityId[], footprintDemand }
Building { id, name, kind, isStub, district,
            height, footprint: { width, depth },
            source?: { file, span? },   // the anchor, for source links (M10a)
            metrics: Record<string, number | null> }
Arrow    { from, to, count, kinds[], provenances[], inferred, crossDistrict, feedback }
```

Two later additions to the shape (details in CM-8's nesting note):

- **`District.parent`** — the nearest ancestor module that is itself a district,
  when the model declares module containment. Absent for roots and for models
  without containment.
- **`corpus.repository` and `Building.source`** (M10a) — the header's
  repository facts (`remote`, `commit`, repo-relative `root`, `provider?`) and
  each building's anchor (`file`, `span?`), carried so a renderer can project a
  permalink. The city projects NO url: a blob template belongs to one host, and
  the artefact states facts (METAMODEL §8a/§9). `repository` is present only
  when every model in the union that states one states the SAME one — a
  building carries no model of origin, so half a city linked to the wrong
  repository is the alternative. A replay city has the file but no span (the
  history keys entities to files) and links at the scrubbed tick's sha.
- **`CityModel.districtArrows`** — module-level dependencies between districts,
  from the analyzer's fold at `level: "module"` under the same view: the
  fan-in/fan-out a landscape view renders. Same `Arrow` shape; kept in the
  artifact so no renderer re-derives module facts by aggregating type arrows
  (it would get stub folding and view rules wrong). Self-dependencies and
  arrows whose endpoint is no district are counted in
  `diagnostics.selfDistrictArrows` / `droppedDistrictArrows`.

Choices worth naming:

- **Buildings reference their district by id, and districts list their
  buildings.** Both directions are stored *in the artefact* even though one is
  derivable. This is not a violation of invariant 4 (no serialized inverse
  indexes) — that rule governs the interchange model, whose consumers must be
  able to re-derive. A renderer walks both ways per frame, and a JSON consumer
  in a browser should not have to build an index before drawing.
- **`metrics` carries the RAW measurement next to the dimension it produced.**
  A height of `17.596` means nothing on its own; `loc: 24` beside it is what a
  tooltip, a legend and a bug report need. `null` means "the model does not
  say" (CM-6).
- **`bindings` is the artefact's legend, in machine form.** Channel, metric
  name, unit, description, scale, output range, observed domain, and how many
  buildings could not be measured. A renderer can print an honest legend
  without knowing anything about codegraph.
- **`kinds` and `provenances` are sorted arrays, not `Set`s.** `Set` does not
  survive `JSON.stringify`, and sorting is what makes two runs byte-identical.
- **`inferred` is precomputed** from the provenance set (`true` when any base
  edge is not `declared`) so the renderer cannot get the rule wrong; the raw
  set stays for anyone who wants the detail.
- **`crossDistrict`** is precomputed for the same reason: it is the flag a
  layout uses to decide which arrows must survive district packing.
- **`feedback`** — the arrow is in the minimum feedback set of its strongly
  connected component at its own fold level (the analyzer's `cycles()` tangle
  cut, computed per level in `buildCity`). Precomputed so a renderer draws the
  recommendation without re-deriving graph facts. A boolean "in tangle"
  metric CHANNEL for buildings/districts is deliberately deferred: height and
  footprint are continuous channels and a membership bit would mislead there;
  the open metric-source registry (CM-4) can host one later.

## CM-4 Metric sources: a registry, not an enum

A `MetricSource` is `{ name, unit, describe, value(context) }`. The context is
everything a source may read about one building:

```ts
MetricContext { graph, node, entity, members, coupling }
```

- `node` — the folded type node (carries `members`, the fold count).
- `entity` — the type entity itself, or `undefined` when an edge referenced an
  id nothing declares.
- `members` — every base entity that folded into the building: the type, its
  methods, fields, parameters and locals.
- `coupling` — the type-level coupling row (fan-in/fan-out under this view).

Built-ins: `loc`, `members`, `methods`, `fields`, `fanIn`, `fanOut`, `degree`,
`one`.

**A source may answer "I do not know."** `value` returns `undefined`, never a
substitute zero — a stub type has no anchor, so it has no line count, and a
zero there would be a measurement nobody took. CM-6 covers what happens next.

**The open forms are the extensibility, and they are how cyclomatic complexity
arrives.** A measure lives in the entity's `TMetrics` map (METAMODEL.md §3.8),
whose keys are deliberately open, and either form reads it by name:

| Form | Reads |
|---|---|
| `attribute:<key>` | the type's own measure |
| `sum:<key>` | that measure summed over everything that folded into the building |

`sum:` is the form complexity wants, because complexity is measured per
invocable and a building is a type. Since M10b the Java extractor emits `sloc`
and `cyclomatic`, so `--height sum:cyclomatic --footprint loc` is a working
city; for an extractor that emits neither it reports "unmeasured", which is the
truth. This package will **not** invent a measure by re-parsing source it
cannot see — only the extractor measures. (A top-level numeric key of the same
name is still read, since an entity is a *loose* object, but it is
uncontractual: the map wins.)

`sum:` returns `undefined` — not `0` — when *no* member carries the key:
"nothing measured this" and "everything measured zero" are different
statements, and only the second is a fact about the code.

**An unknown name throws** (`UnknownMetricError`, naming what exists) rather
than falling back to a default. A silent fallback would put a documented
metric's name on a different metric's numbers.

## CM-5 Scales, channels, and the order of operations

Two channels are bound today:

| Channel | Default metric | Default scale | Reading |
|---|---|---|---|
| `height` | `loc` | `linear` | a tower twice as tall holds twice the source |
| `footprint` | `members` | `sqrt` | the metric maps onto the SIDE, so base AREA is proportional to it |

`sqrt` on the footprint is the one non-obvious default: mapping a metric
linearly onto the side length would make area grow with its square, and a city
plan invites the reader to compare areas. Both are overridable per channel
(`--footprint-scale linear` if you want the other reading), and whichever was
used ships in `bindings`.

**Scales.** `linear`, `sqrt`, `log`. `log` is `log1p`, not `log`: metrics
legitimately reach 0 (a type nobody depends on has fan-in 0) and `log(0)` is
`-Infinity`, which would silently render a *measured* zero at the range floor.
Negative inputs are clamped to 0 — no built-in produces one, and an
extractor-supplied key that does is outside this transform's competence.

**A degenerate domain maps to the MIDDLE of the range.** When every building
measures the same, identical inputs must render identically; flooring them all
would read as "everything is minimal" when the truth is "everything is equal".

**Dimensions are rounded to 3 decimals**, so two runs serialize byte-identically
without anyone downstream reasoning about floating-point associativity.

**The order is not negotiable** — a dimension is relative to a domain, so the
domain must exist first:

1. **Place.** Fold to type level, resolve each building's district.
2. **Measure.** Ask every source for every building. No dimension exists yet.
3. **Scale.** Compute each channel's domain over the measured values, then map.

Doing 2 and 3 in one pass would need the domain before it is known, which is
how "the first building is always the tallest" bugs happen.

## CM-6 Honesty rules the transform enforces

These are the CLAUDE.md visualization rules made mechanical:

- **Unmeasured is a third state, not zero.** A building whose metric is
  `undefined` is floored at the channel *minimum*, recorded as `null` in
  `metrics`, and counted in both `bindings[].unmeasured` and
  `diagnostics.unmeasured`. The CLI additionally warns on stderr. Without this,
  "shortest" and "unknown" are the same picture.
- **A type with no module is left out**, and listed in
  `diagnostics.unplacedBuildings`. Inventing a `(none)` district would stand
  buildings on ground the model never described.
- **A district with no building does not exist.** Districts are collected from
  the placed buildings, so a module the view excluded leaves no empty plot
  claiming a module is there.
- **Type-level self-dependencies are not arrows.** A method calling a sibling
  of its own class is real cohesion but not a dependency between two roofs; it
  is dropped and counted in `diagnostics.selfArrows`.
- **Inferred stays marked.** `inferred: true` for any arrow whose base edges are
  not all `declared` — the renderer must keep those visually distinct.
- **The view travels with the city.** Every artefact repeats the
  `ViewDescriptor` it was built under.

## CM-7 Algorithms and cost

Everything is linear in the model, with one deliberate index:

| Step | Work | Note |
|---|---|---|
| fold to type level | O(V + E) | analyzer, memoized container walk |
| coupling table | O(V + E) | analyzer; indexed by id into a `Map` |
| `groupMembers` | O(V) | **one** pass over all ids, bucketing by `containingType` |
| measure | O(V × sources) | sources are O(1) or O(members) |
| domains | O(V) per channel | |
| dimensions | O(V) | |
| arrows | O(E) | |

`groupMembers` is the choice that matters: `members` is needed per building
(for `methods`, `fields`, `sum:<key>`), and walking descendants per building
would be quadratic on a real corpus. One pass over `graph.ids()`, bucketed by
the memoized `containingType`, gives every building its members in linear time.

Measured on **apache/fineract** (`fineract-provider/src/main/java`: 2 466 files,
77 644 entities, 227 154 edges, a 38 MB `model.jsonl`): `codegraph city
--internal-only` produces **579 districts, 3 537 buildings, 6 012 arrows** in
**3.2 s wall clock** end to end, including reading and validating the model.
The transform itself is a small fraction of that; loading dominates.

## CM-8 What is deliberately absent

**Placement.** No building has a position; no district has bounds. This slice
answers "how big is each thing", not "where does it stand". The handoff to the
layout pass is one number per district:

> `District.footprintDemand` — the total base area its buildings occupy, in
> city units². A district must be at least this big before packing and padding.

A layout pass therefore adds `position` to buildings and `bounds` to districts,
consuming `footprintDemand` and `footprint`, and has **nothing here to undo**.
Publishing a model with no coordinates is what keeps that pass replaceable —
including trying several packers and comparing them on the same city.

*(That pass now exists: `layoutCity` in `layout.ts`, CLI `--layout` — recursive
shelf packing, readability over density, algorithm and parameters declared in
the artefact's `layout` block. `buildCity` itself is unchanged: placement stays
opt-in and separate. With nesting, a child district packs INSIDE its parent as
one more rectangle among the parent's own buildings — sizing bottom-up over
the district tree, placement top-down; a missing or cyclic `parent` demotes
the district to a root rather than failing.)*

Also absent, and why:

- **Colour.** A palette is a rendering decision, and the raw `metrics` on each
  building are what a colour channel will bind to. Adding a `color` field now
  would freeze a choice the renderer has not yet had to make.
- **District nesting.** *Landed, exactly the way this note said it would.*
  Originally districts were flat because Java packages carried no parent in
  the model, and nesting `com.acme.order.legacy` under `com.acme.order` would
  have split a *name* — the inference invariant 7 forbids. The Java extractor
  now emits package containment walked STRUCTURALLY on Spoon's package tree
  (`TChildOf`, optional on `package` in the profile): a package's parent is
  the nearest ancestor package that itself holds corpus types, so a pure
  namespace prefix (`com`, `org.apache`) is never invented, and stub packages
  stay flat. `District.parent` is that chain projected onto the city — the
  nearest ancestor that is also a district — and the layout packs children
  inside their parent (see CM-10.1).
- **Geometry.** No meshes, no vertices, no units in metres. `units: "city"`
  says the numbers are ratios within a range and nothing else.

## CM-9 Entry points

**Library** — `@codegraph/city`:

```ts
buildCity(graph: CodeGraph, options?: CityOptions): CityModel
cityToJsonString(city: CityModel, options?): string

// plus the registry, for a caller with its own measurement
resolveMetric(name | MetricSource): MetricSource
metricNames(): readonly string[]
METRIC_SOURCES, METRIC_PREFIXES, SCALES
```

`buildCity` is pure: it reads the graph and allocates a result. `CityOptions`
carries the view, the two channel bindings (`metric`, `scale`, `min`, `max`),
`carry` (extra metrics measured onto every building but bound to no channel),
and `edgeKinds`.

**CLI** — `codegraph city <model.jsonl...>`:

```
--height METRIC          --height-scale linear|sqrt|log
--footprint METRIC       --footprint-scale linear|sqrt|log
--carry M1,M2            --internal-only  --declared-only  --out FILE
```

The command resolves flags, loads models and moves bytes; the transform stays
in the package (decision 7). It follows the CLI's existing contracts: stdout
carries the artefact and nothing else, warnings and the `--out` confirmation go
to stderr, exit `3` when the load was not clean, and an unknown metric or scale
becomes a **usage error (exit 2)** naming what exists — not an internal error,
because the user typed it.

The metric help text is generated from the registry, so a source added in the
package cannot go unmentioned in `--help`, and a name in `--help` cannot outlive
its source.

**Downstream** — `packages/viz` (shipped; see
[`city-render.md`](city-render.md)) reads a laid-out city artifact and renders
it with Three.js. It does not re-derive graph facts, and respects
`conventions` and `bindings` rather than inventing its own mapping.

## CM-10 Open questions for the next slices

1. **Layout / 2D bin packing.** *Landed*: `layoutCity` packs buildings within
   each district, then districts within the ground plane — recursive shelf
   packing, area-descending order for stability, a `sqrt(total area)` strip
   target for near-square aspect, declared gaps for streets/sidewalks/avenues.
   Still open: whether `crossDistrict` arrow weight should pull coupled
   districts together (a force step after packing), and padding as a function
   of district size rather than a constant.
2. **Colour binding.** Most likely `kind` (categorical) with provenance or
   staleness as a second channel. Needs the same "state the metric" discipline
   `bindings` already gives dimensions.
3. ~~**Complexity from the extractor.**~~ Done (M10b): the Java extractor emits
   `cyclomatic` per invocable and `sloc` per type and invocable in the
   `TMetrics` map, and `sum:cyclomatic` became a first-class height with a
   one-function change here — reading the map instead of only a loose key.
4. **Scale beyond fineract.** 3 537 buildings render comfortably; a corpus ten
   times bigger will want the renderer to instance meshes (already a CLAUDE.md
   rule) and may want the city model itself to support a level-of-detail view —
   e.g. districts only, buildings folded away.
5. **Diffing two cities.** The artefact is deterministic and id-keyed, so a
   diff is possible today; what is not decided is how a renderer should show
   "this building grew".
