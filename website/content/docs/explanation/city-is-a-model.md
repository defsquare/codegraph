---
title: The city is a model before it is a picture
linkTitle: The city is a model
weight: 7
---

The code city is the most visible thing codegraph does: packages become
districts, classes become buildings sized by real metrics, dependencies become
arcs drawn roof to roof. It is also the part most likely to be mistaken for
decoration, so it is worth being precise about what it is. The city is a
**second model** — data, in its own vocabulary, produced by a pure function of
the analyzer's graph. The renderer is a separate thing downstream that draws that
data and adds no meaning of its own.

The section numbers (`CM-1`, `CR-3`…) are decision records, cited from the code
and from other pages, and kept as they are.

## CM-1 · A city is a second model, not a picture

The transform produces data and stops. It does not position anything, does not
choose colours, does not emit geometry, and does not import Three.js. Three
consequences follow, and they are the reason the package exists at all:

- **It is testable without a renderer.** Every claim in the artefact is a number
  or an id a test can assert on. A bug in "how tall is `OrderService`" is caught
  by a unit test, not by squinting at a screenshot.
- **The renderer becomes replaceable.** One renderer draws it in WebGL; a second
  (an SVG plan, a print layout, a diff view) would read exactly the same thing.
  Nothing that matters lives inside the renderer.
- **The boundary is enforceable.** The city model sits beside the analyzer under
  a no-DOM, no-Three.js lint rule. The renderer is the only package allowed to
  depend on Three.js.

**Why a package and not a folder in the analyzer.** The analyzer's vocabulary is
entities, edges, folds, views and metrics. Districts and buildings are a
*different* vocabulary, and mixing them would invite analyzer code to start
reasoning in city terms. The dependency runs one way: city → analyzer → core.

## CM-2 · The mapping, and who decides it

```
module (TModule)   ->  DISTRICT   the landscape a building stands on
type   (TType)     ->  BUILDING   dimensions from configurable metrics
type dependency    ->  ARROW      drawn roof to roof, weighted by count
```

The city does **not** select these itself — [the analyzer's
fold](/docs/explanation/analysis-pipeline/) does. Buildings are the nodes of the
type-level fold; a building's district is the containment chain walked to the
nearest module ancestor; arrows are that same fold's edges. So membership follows
the model's own containment, never a parsed name, and the city inherits the
fold's guarantees for free: aggregation, view filtering, deterministic order, and
diagnostics for whatever could not be folded.

Conventions that belong to the whole drawing are stated once rather than per
element — arrows attach at the roof, height is the vertical axis, the ground is a
horizontal plane. A renderer needs to be told that exactly once, and is entitled
to refuse a city whose conventions it does not implement.

## CM-3 · One flat, sorted, JSON-shaped tree

The artefact is districts, buildings, arrows, plus a `bindings` block, a view
descriptor, conventions and diagnostics. No classes, no cycles, no `Map`s: it
must survive serialization unchanged and arrive intact in a browser. A few
choices in its shape are worth naming.

**Buildings reference their district, and districts list their buildings.** Both
directions are stored *in the artefact* even though one is derivable. This is not
a violation of the no-serialized-inverses rule — that rule governs the
interchange model, whose consumers must be able to re-derive. A renderer walks
both ways every frame, and a JSON consumer in a browser should not have to build
an index before drawing.

**Each building carries the raw measurement next to the dimension it produced.**
A height of `17.596` means nothing on its own; `loc: 24` beside it is what a
tooltip, a legend and a bug report need. A `null` there means "the model does not
say", which is a different claim from zero.

**`bindings` is the legend, in machine form** — channel, metric name, unit,
description, scale, output range, observed domain, and how many buildings could
not be measured. A renderer can print an honest legend without knowing anything
about codegraph.

**Flags a renderer must not re-derive are precomputed.** `inferred` (any base
edge that is not `declared`), `crossDistrict`, and `feedback` (the arrow is in
the minimum feedback set of its strongly connected component at its own fold
level) are computed once, in the model, so the renderer cannot get the rule
wrong. Module-level arrows between districts are carried too, from the fold at
module level under the same view — precisely so that no renderer re-derives
module facts by aggregating type arrows, which would get stub folding and view
rules wrong.

Later additions followed the same discipline. A framework **role** on a building
is opt-in and legended as an inference. A field's declared constant **value** is
carried as text, and the city evaluates nothing. **Repository facts** — remote,
commit, repo-relative root — are carried so a renderer can build a permalink, but
the city projects no URL: a blob template belongs to one host, and the artefact
states facts. The repository is present only when every model in the union states
the *same* one, because a building carries no model of origin and half a city
linked to the wrong repository is the alternative.

## CM-4 · Metric sources are a registry, not an enum

A metric source is a name, a unit, a description and a function over one
building's context — the folded node, the type entity, every base entity that
folded into it, and its coupling row. The built-ins cover lines of code, member
counts, methods, fields, fan-in, fan-out, degree, and a constant.

**A source may answer "I do not know."** It returns nothing, never a substitute
zero. A stub type has no anchor, so it has no line count, and a zero there would
be a measurement nobody took.

**The open forms are the extensibility.** A measure lives in the entity's metrics
map, whose keys are deliberately open, and two forms read it by name: the type's
own measure, or that measure summed over everything that folded into the
building. The summed form is what complexity needs, because complexity is
measured per invocable and a building is a type — which is how
`--height sum:cyclomatic --footprint loc` became a working city with a
one-function change. Summing returns *nothing* rather than zero when no member
carries the key, for the reason above.

The city will **not** invent a measure by re-parsing source it cannot see. Only
the extractor measures. And an unknown metric name throws, naming what exists,
rather than falling back to a default — a silent fallback would put a documented
metric's name on a different metric's numbers.

## CM-5 · Scales, channels, and an order that is not negotiable

| Channel | Default metric | Default scale | Reading |
|---|---|---|---|
| `height` | `loc` | `linear` | a tower twice as tall holds twice the source |
| `footprint` | `members` | `sqrt` | the metric maps onto the SIDE, so base AREA is proportional to it |

The square root on the footprint is the one non-obvious default. Mapping a metric
linearly onto the side length would make area grow with its square, and a city
plan invites the reader to compare *areas*. Both are overridable, and whichever
was used ships in the bindings.

Two details in the scales exist because the naive version lies. The logarithmic
scale is `log1p`, not `log`, because metrics legitimately reach zero — a type
nobody depends on has fan-in 0 — and `log(0)` would render a *measured* zero at
the floor, indistinguishable from unmeasured. And **a degenerate domain maps to
the middle of the range**: when every building measures the same, flooring them
all would read as "everything is minimal" when the truth is "everything is
equal".

The order of operations is fixed, because a dimension is relative to a domain and
the domain has to exist first: place, then measure everything, then compute each
channel's domain and map. Doing the last two in one pass would need the domain
before it is known, which is how "the first building is always the tallest" bugs
happen.

## CM-6 · Honesty rules, made mechanical

These are the project's visualization rules turned into code paths rather than
review comments:

- **Unmeasured is a third state, not zero.** A building with no value for a
  channel's metric is floored at the channel *minimum*, recorded as `null`, and
  counted in both the binding and the diagnostics; the command warns on stderr.
  Without this, "shortest" and "unknown" are the same picture.
- **A type with no module is left out**, and listed. Inventing a `(none)`
  district would stand buildings on ground the model never described.
- **A district with no building does not exist.** Districts are collected from
  the buildings actually placed, so a module the view excluded leaves no empty
  plot claiming a module is there.
- **Type-level self-dependencies are not arrows.** A method calling a sibling of
  its own class is real cohesion but not a dependency between two roofs.
- **Inferred stays marked**, and **the view travels with the city**.

## CM-7 · Cost, and the one index that matters

Everything is linear in the model. The choice that matters is how a building
learns its members: walking descendants per building would be quadratic on a real
corpus, so one pass over every id, bucketed by the memoized containing type,
gives every building its members in linear time.

Measured on **apache/fineract** (2,466 files, 77,644 entities, 227,154 edges, a
38 MB model): the internal-only city is **579 districts, 3,537 buildings, 6,012
arrows** in **3.2 s** wall clock end to end, including reading and validating the
model. The transform itself is a small fraction of that; loading dominates.

## CM-8 · What the model deliberately leaves out

**Placement was not part of it.** The first slice answered "how big is each
thing", not "where does it stand", and handed the layout pass one number per
district: the total base area its buildings occupy. Publishing a model with no
coordinates is what kept that pass replaceable — including trying several packers
and comparing them on the same city. The layout now exists as a separate,
opt-in step that adds positions and bounds and has nothing in the model to undo.

**District nesting** was absent at first for a reason worth repeating: Java
packages carried no parent in the model, and nesting `com.acme.order.legacy`
under `com.acme.order` would have split a *name*, which is the inference the
identity rule forbids. It landed only once the extractor emitted package
containment walked structurally over Spoon's package tree — a package's parent is
the nearest ancestor package that itself holds corpus types, so a pure namespace
prefix like `com` or `org.apache` is never invented.

**Colour** is still reserved. The raw metrics on each building are what a colour
channel will bind to, and adding a colour field before the renderer had to make
that choice would have frozen it early.

## CR-1 · The artifact is the boundary, and a guard enforces it

The renderer's only input is the serialized city. It never reads a `model.jsonl`,
never imports the analyzer, and its browser bundle contains **no code** from
core, the analyzer or the city model: every import of the city package is
type-only, and the one shared literal — the artifact's `kind` — is restated in
the guard with a test asserting it equals the package's own constant.

That is not an accident of bundling; it is the point. The renderer could be
handed to someone with no checkout and a `city.json`, and it would work.

The guard refuses, naming the command that produces the right file: non-JSON (a
model file is line-based, so it fails here first); JSON whose kind is wrong; a
city built without the layout pass — inventing positions in the renderer would be
a second, undeclared packer; and an artifact declaring conventions this renderer
does not implement. Refusing beats silently misdrawing.

## CR-2 · A pure scene model under the Three.js adapter

Turning the artifact into world-space data — boxes per building, plates per
district, sampled arcs per arrow, the legend — is plain computation with no
Three.js and no DOM, unit-tested in Node. Three.js appears in exactly one folder,
which uploads that scene once and raycasts on pointer events.

The split mirrors the model/renderer split one level down: "how tall, where,
which colour" are numbers a test asserts on, and a screenshot is only needed for
"did the GPU draw what the numbers say".

## CR-3 · Meaning controls appearance

Every visual channel maps to a declared source; the renderer adds no mapping of
its own.

| Channel | Source |
|---|---|
| height, footprint | the artifact's `bindings` (metric, scale, range) |
| building colour | corpus-declared type versus stub |
| type-arrow colour | the `inferred` flag — green declared fact, red inference |
| arrow opacity | aggregated edge count, log-scaled |
| plate elevation and tint | district nesting depth |
| district-arrow hue | direction relative to the SELECTED district — amber fan-in, blue fan-out |
| district-arrow saturation | provenance: an inferred module arrow desaturates toward gray but keeps its direction hue |
| tangle red | the artifact's `feedback` flag — the analyzer's cycle cut |

Everything in that table is in the legend, and the legend is *generated from the
artifact*, so it cannot claim a binding the city was not built with. The flags
are copied from the artifact and never recomputed, and a test pins that. An arrow
whose endpoint is not a building of this city is skipped rather than drawn from
nowhere. A `null` metric renders as "unmeasured", in words, because "shortest"
and "unknown" must not read the same.

## CR-4 · Per-frame paths allocate nothing

Draw calls are constant in city size: one instanced mesh for all buildings, one
for all district plates, one ground mesh, one line set for all arrows.
Everything is built once; the render loop is a controls update and a draw.

Arrow focus — hover a building and its arrows brighten while the rest fade — is
an in-place rewrite of the alpha channel of one shared vertex-colour buffer. No
allocation, still one draw call. Picking runs on pointer events, not per frame,
with a reused raycaster.

The arc itself is a quadratic Bezier whose apex clears the taller roof by a
margin proportional to the distance, so short hops stay low and long
dependencies fly over the skyline. The control height is solved from the desired
apex, so the guarantee holds between roofs of unequal height.

## CR-4b · What a click means

The same page is both the city and the module **landscape**: toggles strip the
view down to nested district plates, and nested modules are real geometry — a
child district's plate stands *on* its parent's, so the module tree reads in
outline and in elevation.

Selection is one thing at a time, on purpose. Hovering a building shows its raw
metrics and brightens its arrows; clicking locks it. Clicking a district plate
brightens it and draws its module-level arcs from the artifact's own
district arrows — amber into it, blue out of it — with a card showing its
buildings, nested districts and fan-in/fan-out totals. Those totals are sums over
city data, not graph facts re-derived in the browser. District arcs attach at
plate-top centres and are lifted over the skyline, so a module dependency never
slices through the towers standing between two plates. And an orbit drag that
happens to end on a plate is not a click: selection changes only when the pointer
pressed and released in place.

## CR-6 · Deliberately absent

- **Rendering knowledge in the CLI.** `codegraph city --serve` is byte movement,
  not rendering: a small server handing out the visualizer's prebuilt bundle plus
  the in-memory artifact. Three.js never enters the CLI's import graph.
- **Labels, minimaps, district captions.** Text in WebGL is a rabbit hole; the
  tooltip covers identification for now.
- **Colour as a metric channel**, until the model declares one.
- **Level of detail.** 3,500 buildings and 6,000 arrows fit comfortably in the
  constant-draw-call budget; revisit at ten times that.

## Open questions

1. **Layout refinements.** Whether cross-district arrow weight should pull
   coupled districts together — a force step after packing — and whether padding
   should scale with district size rather than being a constant.
2. **Colour binding.** Most likely entity kind as a categorical channel, with
   provenance or staleness as a second one. It needs the same "state the metric"
   discipline the dimensions already have.
3. **Scale beyond fineract.** A corpus ten times bigger may want the city model
   itself to support a level-of-detail view — districts only, buildings folded
   away.
4. **Diffing two cities.** The artefact is deterministic and id-keyed, so a diff
   is possible today; what is undecided is how a renderer should show "this
   building grew".

## Where this shows up

- [Tutorial: reading a city](/docs/tutorials/reading-the-city/) — districts, arcs,
  stub buildings, the legend.
- [How to build a complexity city](/docs/how-to/complexity-city/) — binding height to
  a measure the extractor emits.
- [Reference: city metrics](/docs/reference/city-metrics/) — the built-ins, the open
  forms, the scales.
- [Reference: city.json](/docs/reference/artifacts/city-json/) — the artefact's shape.
- [How to colour by Spring role](/docs/how-to/spring-roles/) — an opt-in inference,
  legended as one.
