---
title: Reading a city
linkTitle: Reading the city
weight: 2
---

**What you will build.** Nothing new — you will learn to read the city you
already have, until every shape and every colour on the screen has a meaning you
can name and check against the analyzer.

**What you need.** The `gson.jsonl` you produced in
[Your first code city](/docs/tutorials/first-city/), and codegraph on your `PATH`.
The model is gson at tag **`gson-parent-2.14.0`**.

**How long.** About 15 minutes.

Start the page again, open the **City** tab, and leave it beside the terminal:

```bash
cd ~/codegraph-tutorial
codegraph serve gson.jsonl --name gson --host 127.0.0.1
```

## 1. Read the legend before anything else

Click **Help** in the top right. Under the explanatory text there is a legend,
and the legend is not written by hand — it is generated from the artifact, so it
cannot claim a binding the city was not built with.

For this city it reads:

```text
view all              23 districts, 263 buildings, 1409 arrows
height = loc (linear) Lines the type's own source anchor spans (end - start + 1).
                      — 150 unmeasured, drawn at the minimum
footprint = members (sqrt)
                      Base entities that folded into the building, the type included.
```

Two things follow immediately.

- **Height is lines, footprint is member count.** Those are defaults, not laws.
  You choose them; see [Build a complexity city](/docs/how-to/complexity-city/).
- **150 of the 263 buildings have no line count.** They are the stubs. A stub is
  drawn at the channel minimum and said to be unmeasured. It is never drawn at
  zero, because a building of height zero would be a claim that the type has no
  code, and codegraph does not know that.

<!-- screenshot: the Help dialog open over the city, showing the concept text and the generated legend with its height/footprint bindings and swatches -->

## 2. Tell a stub from a type you own

Look at the district plates around the edge of the city: `java.lang`,
`java.util`, `java.time`, `java.lang.reflect`. Their buildings are drawn in a
washed-out pale of the building colour.

Those are external types. codegraph never read their source; it only saw them
being used. That is exactly what the pale colour says.

Now uncheck **Show externals** in the header. The stub districts and every
dependency touching one disappear, and you are left with the 113 buildings and
10 districts gson actually declares. Check it again to bring them back.

{{< callout type="info" >}}
Membership is decided by a whitelist of what the corpus declares — never by a
package-name prefix. In this corpus `com.google.errorprone.annotations` is an
external district even though it starts with `com.google`, and it is drawn as
one. Guessing from the name would have got that wrong.
{{< /callout >}}

## 3. Read the nesting

Uncheck **Show buildings**. The towers vanish and you are left with the module
landscape: plates alone.

Nesting is real geometry. A child district's plate stands *on* its parent's, one
thickness higher, and is tinted one step darker — so the package tree reads both
in outline and in elevation, even from straight above. In gson:

```text
com.google.gson
├── com.google.gson.annotations
├── com.google.gson.internal
│   ├── com.google.gson.internal.bind
│   │   └── com.google.gson.internal.bind.util
│   ├── com.google.gson.internal.reflect
│   └── com.google.gson.internal.sql
├── com.google.gson.reflect
└── com.google.gson.stream
```

The external `java.*` districts sit flat at the root, side by side, not nested
into a `java` tree. That is not a bug and not laziness: the model never declared
a parent for them, and inventing one by splitting a dotted name would be
inference dressed as fact. The city draws containment the model states, and
nothing else.

Check **Show buildings** again.

<!-- screenshot: the module landscape with buildings hidden — nested plates for com.google.gson and its sub-packages stepping up in elevation and darkening with depth, flat external plates around them -->

## 4. Make the dependencies appear

At rest there are no arcs. Click a building — say `Gson`, the tallest tower in
the `com.google.gson` plate.

The building turns violet, the rest fade, and its arcs light up:

- **orange** — fan-in: who depends on it;
- **blue** — fan-out: what it depends on.

The far end of each arc tints with the same hue, so you can read the neighbours
without following the line. **Show fan-in** and **Show fan-out** in the header
turn each direction off independently.

Now click a **district plate** instead. The card that opens lists the district's
buildings, its nested districts, and its fan-in and fan-out totals; the arcs are
module-level and attach at plate-top centres, lifted over the skyline so a
module dependency never slices through the towers standing between two plates.

An orbit drag that happens to end on a plate is not a click. The selection only
changes when the pointer went down and up in the same place.

<!-- screenshot: the Gson building selected — violet, arcs fanning out in orange and blue, neighbour buildings tinted by direction, the details panel showing its metrics, attributes and operations -->

## 5. Spot an inference

Saturation carries provenance. An arc whose folded edges are all `declared`
keeps its full hue; an arc that contains any non-declared edge collapses most of
the way toward grey while keeping its direction hue.

So a washed-out orange arc still means "something depends on this", and it also
means "part of that claim is an inference, not something the source literally
says". The picture cannot present an inference as a fact.

There is real inference in this model. Ask the analyzer where it is:

```bash
codegraph analyze gson.jsonl --report deps --level type --top 5
```

or, more directly, count the provenances in
[Querying the model with SQL](/docs/tutorials/sql/). In gson 2.14.0 exactly 443 of
8997 edges are not `declared`: 431 `dynamic-candidate` invocations (a virtual
call whose target codegraph resolved to a set of candidates) and 12 `derived`
imports.

## 6. Turn on the tangles

Check **Tangles** in the header. A set of arcs turns red — and they stay red
under a selection, because an offence outranks a direction hue.

Red here is not "bad dependency". It is the **minimum feedback set**: the
cheapest set of edges to cut that would leave the graph acyclic. The analyzer
computes it; the city only draws the flag it was given.

Check it against the command:

```bash
codegraph analyze gson.jsonl --report cycles
```

```text
1 dependency cycle(s) at module level under view all — exiting 3 (findings).
codegraph analyze — cycles
models: gson.jsonl
level:  module
view:   all (nothing filtered — stubs and inferred edges included)
layer:  every edge kind folded to module level

cycles: 1 strongly connected components, ranked by component size descending, ties by weight then first member
tangle: 12.5% overall — feedback weight 254 of 2025 cyclic references (minimum feedback set)
self-dependencies after folding: 8

  legend: '->' a declared fact · '~>' carries a derived or dynamic-candidate inference
  legend: '[feedback]' — minimum feedback set: cutting these edges leaves the graph acyclic

cycle 1 — 8 nodes, 36 edges, weight 4753, tangle 12.5%
  members:
    java:com.google.gson
    java:com.google.gson.annotations
    java:com.google.gson.internal
    java:com.google.gson.internal.bind
    java:com.google.gson.internal.reflect
    java:com.google.gson.internal.sql
    java:com.google.gson.reflect
    java:com.google.gson.stream
```

Eight of gson's ten packages are in one cycle. That is what the red arcs in the
city are pointing at.

{{< callout type="warning" >}}
`analyze --report cycles` exits `3` when it finds any. `3` means "the tool
worked; the input has findings" — it is not an error. That is the exit code a CI
job gates on; see [Gate a pipeline](/docs/how-to/ci-gate/).
{{< /callout >}}

## 7. Read the numbers behind a shape

Every card in the city shows raw metrics, not the scaled ones. Hover
`TypeAdapters` in `com.google.gson.internal.bind`: `loc` 1022, `members` 363.
It is the widest building in the city — 363 members — and not the tallest.
`JsonReader` in `com.google.gson.stream` is taller at 1681 lines with 209
members.

That difference is the point of binding two channels to two metrics: a wide,
short building is a type with many small members; a tall, narrow one is a type
with a few long ones.

## What you have now

You can name every channel on the screen and say where its value came from:

| What you see | What it means | Where it is declared |
|---|---|---|
| district plate | a module the model declares | the model's `parent` chain |
| plate elevation and tint | nesting depth | the district's parent chain |
| building height | `loc`, linear | the artifact's bindings, shown in the legend |
| building footprint | `members`, sqrt | the artifact's bindings |
| washed-out building | a stub — an external type | `isStub` on the building |
| orange / blue arc | fan-in / fan-out of the selection | the direction hue |
| desaturated arc | contains a non-`declared` edge | the artifact's `inferred` flag |
| red arc | in the minimum feedback set | the artifact's `feedback` flag |
| violet | the selection | — |

Stop the server with `Ctrl-C`.

## Where to go next

- [Finding what depends on a class](/docs/tutorials/navigator/) — the arcs, one row
  at a time, with the file and line behind each.
- [Facts and inferences](/docs/explanation/facts-vs-inferences/) — why provenance is
  a first-class value and why the two never mix.
- [The city is a model](/docs/explanation/city-is-a-model/) — why the renderer draws
  the artifact and never re-derives a graph fact.
