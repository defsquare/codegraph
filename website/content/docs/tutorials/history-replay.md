---
title: Replaying a project's history
linkTitle: History replay
weight: 4
---

**What you will build.** Eighteen years of gson, mined into one deterministic
file, reported as hotspots and ownership, joined against the dependency model to
find coupling the source code cannot show you — and then replayed as a city
whose timeline you scrub commit by commit — then the same corpus re-extracted
at twelve points in its life, so the replay knows about classes and not just
files.

**What you need.**

- codegraph installed and built — see [Install](/docs/how-to/install/).
- `git`, and about 200 MB of disk for a full clone of gson.
- The `gson.jsonl` from [Your first code city](/docs/tutorials/first-city/), for the
  two reports that join history against structure. That model is gson at tag
  **`gson-parent-2.14.0`**.

**How long.** About 30 minutes, of which one is the twelve snapshot
extractions in step 8.

History is a dependency source cannot show you: two files that always change
together are coupled, whether or not either one mentions the other. Codegraph
keeps those facts in their own file and never merges them into the model — a
repository-scoped fact with a per-commit lifecycle does not belong in a
language-scoped structural contract.

## 1. Clone gson with its history

The clone you made for the first tutorial is shallow: it has one commit. Mining
needs the whole thing.

```bash
cd ~/codegraph-tutorial
git clone https://github.com/google/gson gson
```

## 2. Mine the history

```bash
codegraph scm gson --out gson-history.jsonl
```

```text
gson: mined in 0.88 s
mined gson -> gson-history.jsonl
  2091 commits by 202 authors, 801 file lineages, 10192 changes, 2008-09-01 .. 2026-08-27
```

One `git log` pass, under a second. The miner has no code intelligence at all —
it emits paths, authors, timestamps and line deltas, and everything smarter is
derived downstream. Rename chains are resolved while mining, so one path names
one file lineage across every rename it ever had; that is why it reports 801
*lineages* rather than 801 current files.

The output is deterministic: run it again and you get the same bytes.

## 3. Ask for the shape of the project's life

```bash
codegraph history gson-history.jsonl --report summary
```

```text
history of gson: 2091 commits by 202 authors over 801 files
  span:         2008-09-01 .. 2026-08-27 (6569 days)
  churn:        +406220 / -344006 (750226 lines)
  firefighting: 303 fixes (14.5% of commits), 5 reverts
  momentum:     1.43x (last 90 days vs lifetime rate)
```

`fixes` is counted by matching commit subjects, and it is labelled a heuristic
because that is what it is. Momentum above 1 means the project is committing
faster now than its lifetime average.

## 4. Find the hotspots

A hotspot is a file that changes constantly. It is where a design problem costs
you the most, because you keep paying for it.

```bash
codegraph history gson-history.jsonl --report hotspots --top 10
```

```text
hotspots of gson (top 10 of 801 files by revisions):
  REVISIONS  CHURN  FIXES  DENSITY  AUTHORS  PATH
        290   2507     20     0.07       23  gson/pom.xml
        248   2302     18     0.07       16  pom.xml
        245   5942     46     0.19       29  gson/src/main/java/com/google/gson/Gson.java
        146   4051     26     0.18       20  gson/src/main/java/com/google/gson/GsonBuilder.java
        111   7985     24     0.22       21  gson/src/main/java/com/google/gson/stream/JsonReader.java
        101   1140      0     0.00        6  proto/pom.xml
         95   5044     12     0.13       20  gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java
         88   3658     20     0.23        3  gson/src/main/java/com/google/gson/DefaultTypeAdapters.java
         85    545      0     0.00        4  metrics/pom.xml
         76    401      6     0.08       25  README.md
```

`Gson.java` and `JsonReader.java` are the same buildings that stood tallest in
[the city](/docs/tutorials/reading-the-city/). Big *and* churning is the combination
worth looking at.

Notice `DefaultTypeAdapters.java`: 88 revisions, and it is not in the model you
extracted at all — the file was deleted in November 2011. The miner reports the
repository's whole life, not the current checkout.

## 5. See who knows what

```bash
codegraph history gson-history.jsonl --report authors --top 8
```

```text
authors of gson (202):
  COMMITS   CHURN  FILES  OWNS  FIXES  AUTHOR
      557  263087    540   356     85  Inderjeet Singh <inder123@gmail.com>
      278  282605    419   208     42  Jesse Wilson <jesse@swank.ca>
      232    1468     18     0      0  dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>
      231   62911    411    98     42  Marcono1234 <Marcono1234@users.noreply.github.com>
      207   77241    307    47     40  Joel Leitch <joel.leitch@gmail.com>
      125    8957    173    17     16  Éamonn McManus <emcmanus@google.com>
       67    2309     41    15      5  inder123 <inder123@gmail.com>
       51    2021     57     5      1  Inderjeet Singh <inder@peel.com>
```

`OWNS` is the number of files where that author wrote the most lines. The **bus
factor: 2** at the bottom is the smallest number of owners covering more than
half the files.

Identity is the `Name <email>` pair, with `.mailmap` applied when the repository
has one. gson does not fully normalise its authors, which is why
`Inderjeet Singh <inder123@gmail.com>`, `inder123 <inder123@gmail.com>` and
`Inderjeet Singh <inder@peel.com>` appear as three rows. That is the repository
speaking, not the tool guessing.

## 6. Join history against structure

These two reports need both graphs, and they are the reason it is worth holding
both.

**Hidden coupling** — files that change together although no path in the
declared dependency graph connects them, in either direction:

```bash
codegraph history gson-history.jsonl --report hidden --model gson.jsonl --top 8
```

```text
note: 53 sweeping commits skipped for coupling (changesets over 30 files couple nothing meaningfully).
note: 403 co-changed pairs lie outside the model (docs, config…).
hidden coupling of gson (top 3 of 3 co-changed pairs with NO path in the declared graph):
  SUPPORT   CONF  PAIR
        8  72.7%  gson/src/main/java/com/google/gson/JsonDeserializer.java + gson/src/main/java/com/google/gson/JsonSerializer.java
        7  63.6%  gson/src/main/java/com/google/gson/JsonDeserializationContext.java + gson/src/main/java/com/google/gson/JsonSerializationContext.java
        5  71.4%  gson/src/main/java/com/google/gson/annotations/Since.java + gson/src/main/java/com/google/gson/annotations/Until.java
```

Three pairs of twins. `JsonSerializer` and `JsonDeserializer` are mirror
interfaces that reference nothing of each other; `Since` and `Until` are mirror
annotations. Nothing in the source links them, and every time one changes the
other does. That is a design fact a dependency graph alone cannot state.

`SUPPORT` is how many commits contain both; `CONF` is that support over the
rarer file's own revisions. Tune both with `--min-support` and
`--min-confidence`.

**Dead weight** — the opposite: declared dependencies that history never
exercised together.

```bash
codegraph history gson-history.jsonl --report deadweight --model gson.jsonl --top 8
```

```text
dead weight of gson (top 8 of 112 declared file dependencies that never co-change):
  EDGES  REV-FROM  REV-TO  DEPENDENCY
     44        35       4  com/google/gson/internal/bind/JsonTreeReader.java -> com/google/gson/stream/JsonToken.java
     35         2      45  com/google/gson/internal/bind/JavaTimeTypeAdapters.java -> com/google/gson/TypeAdapter.java
     31        95       4  com/google/gson/internal/bind/TypeAdapters.java -> com/google/gson/stream/JsonToken.java
     30        95       5  com/google/gson/internal/bind/TypeAdapters.java -> com/google/gson/JsonSyntaxException.java
     21       245       5  com/google/gson/Gson.java -> com/google/gson/JsonSyntaxException.java
     20       245       5  com/google/gson/Gson.java -> com/google/gson/JsonIOException.java
     15        40       4  com/google/gson/internal/ConstructorConstructor.java -> com/google/gson/internal/ObjectConstructor.java
     12        26       8  com/google/gson/internal/bind/JsonAdapterAnnotationTypeAdapterFactory.java -> com/google/gson/TypeAdapterFactory.java
```

Read this as good news. `JsonToken` and `TypeAdapter` are heavily depended upon
and almost never change — stable interfaces, exactly what an interface is for.
Dead weight is a place to look, not a verdict.

{{< callout type="info" >}}
The two graphs are joined by path **suffix**, because a model root sits below a
repository root. Here the model was extracted from `gson/src/main/java` and the
history is repository-wide. An ambiguous suffix joins nothing and is counted
rather than guessed.
{{< /callout >}}

## 7. Replay the files

```bash
codegraph history gson-history.jsonl --serve --host 127.0.0.1
```

```text
city visualizer at http://localhost:4177/ — Ctrl-C to stop.
```

Open <http://localhost:4177/>. This is the same viewer as the code city, showing
a different city: **buildings are files, districts are directories**, and there
is a timeline along the bottom with one tick per commit — 801 buildings and 2091
ticks.

Press play, or drag the scrubber. Buildings rise as files grow and sink as they
shrink; a vacant plot is a file whose time has not come, or has passed. The
layout is computed once over every file that ever existed and then frozen, so
nothing ever moves — only grows. An early, sparse city is the honest picture of
a project in 2008, not a rendering defect.

Height is the running sum of the file's line deltas at the current commit;
footprint is the largest it ever reached, so the plot is frozen at the file's
peak.

<!-- screenshot: the file-level replay mid-timeline, around 2015 — directory plates, file buildings at varying heights, the scrubber and commit label along the bottom -->

Now use the **Colors** selector in the header:

- **Time** — a file that changed at the scrubbed tick glows ember and cools over
  the following ticks; untouched files fade toward grey as they age. Old code
  pales; it never disappears.
- **Owner** — every building wears its file's dominant author's hue, mined from
  the history you just produced. 796 of the 801 files have a recorded owner;
  the rest stay neutral grey rather than being assigned a colour they have not
  earned. `Gson.java` is 29.7% Inderjeet Singh's lines, and wears his hue.
- **Plain** — the palette alone.

Click a building and its **co-change partners** appear as **dashed magenta**
arcs: files that change together in the mined history. There are 425 such pairs
in this history. They are dashed, and magenta, and a different *kind* of line
from a dependency arrow, because they are an inference from history and never a
dependency. The city does not lie about which is which.

<!-- screenshot: the replay with Colors set to Owner, one file selected, its dashed magenta co-change arcs fanning out, the details panel naming the owner and share -->

`Ctrl-C` stops the server. To keep the artifact instead:

```bash
codegraph history gson-history.jsonl --city history-city.json
```

```text
wrote 1851246 bytes to history-city.json (replay city: 801 files, 2091 ticks).
```

## 8. Sample the structure itself

Everything above came from `git log` alone: files, authors, line counts. Now
re-extract the *model* at sampled revisions, so the replay knows about classes
rather than files.

`codegraph snapshots` drives it: a throwaway `git worktree` per revision, the
extractor jar run inside it, one frame appended to a temporal store. Your main
checkout is never touched. Sample either every Nth first-parent commit or the
commits the tags point at:

```bash
JAR=~/src/codegraph/extractors/java/target/codegraph-java.jar

codegraph snapshots gson --jar "$JAR" --every 200 --src gson/src/main/java --store gson-time.db
```

```text
[1/12] 57d1f32 -> 2287 entities, 3623 edges in 9.1 s
[2/12] e9a2a1d -> 2624 entities, 4370 edges in 6.4 s
[3/12] debd330 -> 2357 entities, 4387 edges in 4.5 s
[4/12] 60e6ed9 -> 2885 entities, 5498 edges in 5.7 s
[5/12] a3ca4e1 -> 2190 entities, 4525 edges in 4.1 s
[6/12] f418528 -> 2693 entities, 5258 edges in 5.0 s
[7/12] 3063136 -> 2958 entities, 5722 edges in 5.0 s
[8/12] 121bced -> 3154 entities, 6134 edges in 5.6 s
[9/12] bfbbd0d -> 3372 entities, 6674 edges in 5.7 s
[10/12] 71865b4 -> 3466 entities, 6961 edges in 5.0 s
[11/12] abfef5e -> 3597 entities, 7285 edges in 5.1 s
[12/12] b3f4ca2 -> 3635 entities, 7425 edges in 5.2 s
snapshotted gson -> gson-time.db
  12 imported, 0 skipped, 0 failed
  the store holds 12 revisions

OK — walk an entity with `codegraph timeline <id> --store gson-time.db`.
```

Twelve frames, about a minute. Every one of them extracted without a build,
which is what makes this affordable at all: a 2009 checkout of gson does not
compile against anything you have installed, and it does not need to.

{{< callout type="info" >}}
`--every 200` is the setting to learn with. The interesting run is
`--tags`, which snapshots the commit behind every release — 55 frames on gson,
and correspondingly longer. Either way the run is **resumable**: revisions
already in the store are skipped, so an interrupted run continues where it
stopped, and a source root that moved over the years is handled by composing two
runs with different `--src`.
{{< /callout >}}

## 9. Walk one class through time

```bash
codegraph timeline java:com.google.gson/Gson --store gson-time.db
```

```text
timeline of java:com.google.gson/Gson (12 of 12 revisions in gson-time.db)
  appeared:  57d1f32 (2008-09-01)
  present:   still in the latest revision
  REVISION  DATE         LOC  KIND
  57d1f32   2008-09-01   331  class
  e9a2a1d   2009-09-29   453  class
  debd330   2010-11-14   520  class
  60e6ed9   2011-08-03   494  class
  a3ca4e1   2011-12-16   760  class
  f418528   2014-08-09   810  class
  3063136   2017-03-20   887  class
  121bced   2021-10-31   967  class
  bfbbd0d   2023-02-28  1244  class
  71865b4   2024-04-01  1385  class
  abfef5e   2026-05-06  1131  class
  b3f4ca2   2026-08-27  1133  class
```

`Gson` is in all twelve frames and quadrupled in size. Now one that is not:

```bash
codegraph timeline java:com.google.gson/MappedObjectConstructor --store gson-time.db
```

```text
timeline of java:com.google.gson/MappedObjectConstructor (4 of 12 revisions in gson-time.db)
  appeared:  57d1f32 (2008-09-01)
  last seen: 60e6ed9 (2011-08-03) — gone since
  REVISION  DATE        LOC  KIND
  57d1f32   2008-09-01   73  class
  e9a2a1d   2009-09-29   76  class
  debd330   2010-11-14   76  class
  60e6ed9   2011-08-03   44  class
```

A class born in 2008 and gone by the end of 2011. Matching an entity across
snapshots costs nothing here because identity is a natural key — the same class
in two frames is key equality, not a diff heuristic. Lifespans are derived at
query time and never stored; a rename is a death plus a birth, and that
restriction is documented rather than silently smoothed over.

## 10. Replay the structure

```bash
codegraph replay --store gson-time.db --name gson --history gson-history.jsonl --serve --host 127.0.0.1
```

```text
joined gson-history.jsonl: 165 of 185 store files matched, 165 owned, 143 co-change pairs.
replay city of gson-time.db: 9 districts, 293 buildings, 12 revisions on the timeline.
city visualizer at http://localhost:4177/ — Ctrl-C to stop.
```

Same viewer again, third city. Buildings are now **types**, districts are
**modules**, and the timeline has 12 ticks instead of 2091 — one per sampled
revision.

Districts here are flat, not nested as they were in the code city. Package
containment across a decade of snapshots would have to be inferred from names,
and inferring it is exactly what codegraph will not do.

Scrub from the left. The 2008 city is one sparse district; buildings rise as
types grow, and a type that was deleted sinks to nothing and leaves its plot
vacant — `MappedObjectConstructor` stands for the first four ticks and its
ground is empty for the remaining eight. The layout was
computed once over every type that ever existed and then frozen, so nothing ever
moves.

The **Colors** selector, the owner mode and the dashed magenta co-change arcs
work exactly as they did on the file replay, fed by the same
`--history` join.

<!-- screenshot: the entity-level replay scrubbed to an early tick — flat module plates, a sparse 2009 city of type buildings, vacant plots where later types will stand, the 12-tick timeline along the bottom -->

`Ctrl-C` stops the server. `--out FILE` writes the artifact instead of serving
it.

## What you have now

- `gson-history.jsonl` — 2091 commits, 202 authors, 801 file lineages, mined
  deterministically from one `git log` pass.
- `gson-time.db` — the same corpus extracted at twelve revisions between 2008
  and 2026, keyed so one class is one class across all of them.
- Hotspots, ownership and a bus factor for a codebase you did not write.
- Two facts you could not have got from the source: three pairs of files that
  always change together with nothing linking them, and 112 declared
  dependencies that history never exercised.
- Two cities whose timelines scrub eighteen years — one of files, one of types —
  colourable by time or by author.

## Where to go next

- [Find hidden coupling and dead weight](/docs/how-to/history-joins/) — tuning
  `--min-support` and `--min-confidence` on your own repository.
- [Sample a repository into a temporal store](/docs/how-to/temporal-store/) — the
  `snapshots` workflow, resuming, and composing runs.
- [Time as structure](/docs/explanation/time-as-structure/) — why history is a
  dependency source cannot show, and how the replay is designed.
