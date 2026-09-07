---
title: Finding what depends on a class
linkTitle: Navigator
weight: 3
---

**What you will build.** An answer to a question a 3D city cannot give you:
*exactly* what depends on `TypeAdapter`, through which member, and on which
line of which file.

**What you need.** The `gson.jsonl` you produced in
[Your first code city](/tutorials/first-city/), and codegraph on your `PATH`.
The model is gson at tag **`gson-parent-2.14.0`**.

**How long.** About 15 minutes.

## 1. Open the navigator

```bash
cd ~/codegraph-tutorial
codegraph navigator gson.jsonl --name gson --serve --host 127.0.0.1
```

```text
cache: gson.db
model navigator at http://localhost:4178/ — Ctrl-C to stop.
```

Open <http://localhost:4178/>.

{{< callout type="warning" >}}
`navigator --serve` binds **every interface** by default, so the page opens from
another machine without extra ceremony. `--host 127.0.0.1` keeps it on yours.
The server states the reach it actually has in the line it prints, so read that
line before you walk away from it.
{{< /callout >}}

The `cache: gson.db` line is codegraph building a SQLite store beside your model
so the next command does not re-parse the file. It is a disposable cache; delete
it any time. You will query it yourself in
[Querying the model with SQL](/tutorials/sql/).

The header shows what was loaded: **1,855 nodes · 6,236 dependencies**.

<!-- screenshot: the navigator on the Navigate tab — virtualized tree on the left with com.google.gson expanded, the dependency panel on the right, header stats and the four tabs across the top -->

## 2. Find the class

Type `TypeAdapter` in the search box (its placeholder reads *Search names and
signatures*). The tree filters as you type. Search is a plain substring scan
over every name and signature, capped at 200 results — and the cap is stated in
the UI rather than silently applied, so you always know when you are looking at
a slice.

Several things match: `TypeAdapter`, `TypeAdapterFactory`, `TypeAdapters`,
`ArrayTypeAdapter`, and more. Click the plain `TypeAdapter` — the class in
`com.google.gson`.

## 3. Read the fan-in

The right-hand panel splits into **Incoming** and **Outgoing**, each with its
total. For `TypeAdapter` you get **300 incoming** rows and **35 outgoing**.

Incoming is sectioned by what kind of dependency each row is, in a fixed
vocabulary order:

| Section | Rows |
|---|---|
| Inheritance | 18 |
| Invocations | 61 |
| Return type | 58 |
| Parameter type | 15 |
| Local variable type | 48 |
| Field type | 56 |
| Type reference | 44 |

That breakdown is the point of the navigator. "300 dependencies on
`TypeAdapter`" is a number; "18 of them extend it, 61 call it, 56 hold it in a
field" is a fact you can act on.

{{< callout type="info" >}}
The metamodel has nine edge kinds and **none of them is "type declaration"**. A
parameter's type, a return type, a local's type, a field's type, a cast and an
annotation are all `reference` edges stored on the *member*. The navigator
recovers which is which from the source entity, once, on the Node side — so the
sections you see agree with `codegraph analyze` rather than being a second
opinion about the same graph.
{{< /callout >}}

## 4. Read one row down to the line

Open the **Inheritance** section and find `ArrayTypeAdapter`. The row carries
four things:

- the **counterpart** — `ArrayTypeAdapter`, clickable, which selects it;
- the **member** of the selected node the edge lands on, or the member of the
  counterpart that carries it (prefixed `on` or `via`);
- a **provenance badge**, shown only when the row is *not* a declared fact;
- the **anchor** — `ArrayTypeAdapter.java:34`, with the full repository-relative
  path on hover.

Line 34 of `gson/src/main/java/com/google/gson/internal/bind/ArrayTypeAdapter.java`
is where that class extends `TypeAdapter`. No badge, so it is a declared fact:
the source literally says so.

Now open **Invocations** and find the two `ArrayTypeAdapter` rows:

```text
ArrayTypeAdapter  read(...)    via read    dynamic-candidate   ArrayTypeAdapter.java:75
ArrayTypeAdapter  write(...)   via write   dynamic-candidate   ArrayTypeAdapter.java:108
```

Those carry a badge. `dynamic-candidate` means codegraph could not resolve the
call to a single target and recorded the candidates instead — a virtual call
through an abstract method. It is an inference, it is labelled as one, and it
is drawn in a colour no fact uses. Every rendering in codegraph keeps that line;
see [Facts and inferences](/explanation/facts-vs-inferences/).

Under **Local variable type** the same class appears twice more, this time with
a detail naming the variable:

```text
ArrayTypeAdapter  via create   local variable componentTypeAdapter   ArrayTypeAdapter.java:46
ArrayTypeAdapter  via create   local variable arrayAdapter           ArrayTypeAdapter.java:49
```

A local variable is not something you browse to, so it is not a tree node. It is
the *reason* a dependency exists, so it appears as the detail on the row it
explains.

<!-- screenshot: the Incoming panel for TypeAdapter — sections Inheritance / Invocations / Return type expanded, rows showing counterpart, via-member, a dynamic-candidate badge in violet, and file:line anchors -->

## 5. Read the colours

Four meanings carry a hue in the navigator and nothing else does:

- **cyan** — incoming;
- **amber** — outgoing;
- **violet** — an inference: any row whose provenance is not `declared`;
- the selection.

A stub — an external type — is drawn muted and italic rather than in a colour of
its own. It is a degraded fact, not a fifth category.

## 6. Use the other three tabs

The tabs across the top are **Navigate**, **Graph**, **Cycles** and
**Coupling**. Every row in the three report tabs leads back to Navigate, so a
finding is always one click from its evidence.

**Graph.** A force-directed dependency graph (Cytoscape with fcose). Two modes,
**Modules** and **Types**; node size follows fan-in, and labels appear by zoom
tier so the far view stays readable. The selection you made on Navigate is
carried over and focused, with incoming cyan and outgoing amber, as everywhere
else.

**Cycles.** The tab carries a count badge — **8** for this model. That is the
artifact's precomputed tangle report, at both levels: one strongly connected
component of 8 modules, and seven components at type level, the largest of 30
types. Nothing is recomputed in the browser; it is the same report
`codegraph analyze --report cycles` prints.

**Coupling.** A sortable table of Name, Fan-in (Ca), Fan-out (Ce) and
Instability, switchable between modules and types. Sort by fan-in at type level
and the top of the table is `Override`, `String`, `IOException` — external
types, because an import of an external type is a real dependency and dropping
it silently would understate coupling. Uncheck **Show externals** in the header
to drop them, and gson's own types surface: `JsonReader` (fan-in 35, fan-out 28,
instability 0.44), then `TypeAdapter` (**33 / 14 / 0.30**).

{{< callout type="info" >}}
Fan-in on the Coupling tab counts *distinct dependents* (33 types), while the
Incoming panel lists *every base edge* (300 rows). Both are true and they answer
different questions. A number without its definition is not a fact.
{{< /callout >}}

<!-- screenshot: the Coupling tab sorted by fan-in at type level, TypeAdapter first with 33 / 14 / 0.30 -->

## 7. Stop the server

`Ctrl-C`. As with the city, you can write the artifact to a file instead:

```bash
codegraph navigator gson.jsonl --name gson --out navigator.json
```

```text
cache: gson.db
wrote 1041132 bytes to navigator.json (navigator, view all, 1855 nodes, 6236 dependency rows).
```

That file is the frontend's only input.

## What you have now

- A way to go from "something depends on this" to the file and line that proves
  it, in three clicks.
- The habit of reading the provenance badge before believing a dependency.
- Four views over one model that cannot disagree with each other, because all
  four were computed once by the analyzer and only rendered in the browser.

## Where to go next

- [Replaying a project's history](/tutorials/history-replay/) — the dependency
  the source cannot show you: what changes together.
- [Querying the model with SQL](/tutorials/sql/) — ask the same questions
  yourself against `model.db`.
- [The navigator](/explanation/navigator/) — why there is one classified row per
  base edge, and how a reference's role is recovered.
