---
title: "1 · Structure and elements"
linkTitle: 1 · Structure
weight: 1
---

**The question.** What is here, how big is it (SLOC), how branchy is it
(cyclomatic complexity), and how tangled is it (strongly connected components)?
What is the volume of elements? What proportion does each module and class
take, and are there outliers in size or complexity?

Complexity is subjective, but three measures approach it from three sides:
**size** (lines of code), **branching** (cyclomatic complexity) and
**entanglement** (cycles between modules or types). None of the three alone
tells you where to look. Together they draw the terrain, and everything else
in this section is placed on it.

**Before you start:** the codegraph CLI and a JDK 17+ (Java) or the .NET 10
SDK (C#). Everything on this page is deterministic and runs in seconds.

## Extract the model

Extraction turns the source tree into one file, `model.jsonl`: one JSON record
per line describing the **nodes** (modules, classes, methods, fields…) and the
**edges** between them (imports, calls, field accesses, inheritance,
annotations…). No build is needed: the extractor reads sources alone, which is
what makes it usable on legacy code that no longer compiles.

Point `--src` at a source root, the directory where the package hierarchy
starts, not the repository root:

```bash
java -jar extractors/java/target/codegraph-java.jar \
  --src ~/src/app/src/main/java --out app.jsonl
```

```text
RESOLUTION SUMMARY
  type references : 636
  resolved        : 601
  unresolved      : 35
  resolution rate : 94.5%
  entities        : 179 (stubs: 27)
  edges           : 188 (self-edges dropped: 0)
```

Two lines matter. The **resolution rate** is the share of type references the
extractor could pin to a declaration without a classpath; 90% and above is
normal, and a sharp drop between two runs means a source root moved. **Stubs**
are the entities the code references but does not declare: the JDK, the
frameworks, the libraries, and any module you did not extract. They are kept,
with their edges, so the picture stays honest about what lies outside.

Then check the file. This is the same gate every extractor must pass:

```bash
codegraph validate app.jsonl
```

A multi-module repository is the one decision this step forces on you:
[Extract Java](/docs/how-to/extract-java/) explains when to extract everything
in one run (modules reference each other) and when to keep separate models.
The C# and TypeScript extractors take the same `--src`/`--out` flags and write
the same file format; each has its own reference page:
[Java](/docs/reference/java-extractor/), [C#](/docs/reference/csharp-extractor/),
[TypeScript](/docs/reference/typescript-extractor/).

{{< callout type="info" >}}
Extract `src/main` and `src/test` as two separate models, never in one run.
Test code has a different shape (many small methods, few dependencies) and
would blur every proportion below.
{{< /callout >}}

## Count what is there

The quickest way to ask your own questions is the SQLite store codegraph
builds beside the model. Build it once, open it, and paste the two helper views
from [Query model.db](/docs/how-to/query-model-db/#paste-these-two-views-first);
every query on this page and the next ones assumes them.

```bash
codegraph import app.jsonl        # writes app.db beside it
sqlite3 app.db
```

How many of each kind of element, stubs excluded:

```sql
SELECT k.name AS kind, count(*) AS n
  FROM entity e JOIN kind k ON k.id = e.kind_id
 WHERE e.is_stub IS NOT 1
 GROUP BY k.name ORDER BY n DESC;
```

| kind | n |
|---|---|
| method | 43 |
| parameter | 35 |
| attribute | 21 |
| constructor | 19 |
| class | 14 |
| package | 3 |
| interface | 2 |

This is the reference fixture, a deliberately small corpus. On a real system
expect thousands of methods and hundreds of types; the shape of the table is
what you read. A codebase with far more attributes than methods is data
carriers; one with many `lambda` rows is functional in style; a single
`package` row is a flat codebase with no module structure to speak of.

## Measure size and find the outliers

Size per module, with the share of the whole. Only type-level `sloc` is
summed, because the extractor also measures each method and adding both would
count every line twice:

```sql
WITH type_sloc AS (
  SELECT e.module_id, em.value AS sloc
    FROM entity_metric em
    JOIN entity e ON e.id = em.entity_id
    JOIN kind   k ON k.id = e.kind_id
   WHERE em.key = 'sloc'
     AND k.name IN ('class', 'interface', 'enum', 'record', 'annotation'))
SELECT m.symbol AS module,
       sum(t.sloc) AS sloc,
       count(*)    AS types,
       round(100.0 * sum(t.sloc) / (SELECT sum(sloc) FROM type_sloc), 1) AS pct
  FROM type_sloc t JOIN entity m ON m.id = t.module_id
 GROUP BY m.symbol ORDER BY sloc DESC;
```

The largest types, which is where an outlier shows up first:

```sql
SELECT n.id, em.value AS sloc
  FROM entity_metric em JOIN node n ON n.ref = em.entity_id
 WHERE em.key = 'sloc'
   AND n.kind IN ('class', 'interface', 'enum', 'record', 'annotation')
 ORDER BY em.value DESC, n.id
 LIMIT 20;
```

| id | sloc |
|---|---|
| `java:com.acme.order/Basket` | 34 |
| `java:com.acme.order/Batch` | 29 |
| `java:com.acme.order/Reporting` | 28 |

**How to read it.** Size follows a power law in every codebase: a handful of
types hold a large share of the lines. That is normal. What you are looking
for is the **break in the curve**: the point where the next type is several
times smaller than the one before. Everything above the break is a candidate
for the hotspot list of step 3. A 4,000-line class named `*Manager`, `*Util`
or `*Impl` is the usual suspect; a 4,000-line class of generated code is a
false alarm, and you should mark it as such now.

**Absent is not zero.** A type with no `sloc` row was not measured (a stub, or
a kind the extractor does not measure). The queries above skip it rather than
counting it as empty.

## Measure branching

Cyclomatic complexity is measured per method. Summed per type it says how much
decision logic a class carries; the maximum says whether one method carries
most of it:

```sql
SELECT p.id AS type,
       sum(em.value) AS cyclomatic,
       max(em.value) AS worst_method,
       count(*)      AS methods
  FROM entity_metric em
  JOIN node n ON n.ref = em.entity_id
  JOIN node p ON p.ref = n.parent_ref
 WHERE em.key = 'cyclomatic'
 GROUP BY p.ref ORDER BY cyclomatic DESC, p.id
 LIMIT 20;
```

| type | cyclomatic | worst_method | methods |
|---|---|---|---|
| `java:com.acme.order/Reporting` | 11 | 4 | 6 |
| `java:com.acme.order/Notifications` | 7 | 1 | 7 |
| `java:com.acme.order/Batch` | 5 | 1 | 5 |

**How to read it.** `Reporting` has one method at 4 and five simpler ones: a
type with one branchy centre. `Notifications` is at 7 across seven methods of
complexity 1: many small straight-line methods, probably dispatch or
notification glue. A type with `worst_method` above 15 has a method nobody can
test exhaustively, and that method is where bugs are fixed repeatedly (step 3
will confirm or deny). Compare this table with the size table: a type that is
high on both is the classic outlier; a type that is small but branchy is the
one lines of code would have hidden.

## Find the tangles

A **strongly connected component** is a set of modules (or types) that all
reach each other through dependencies. Inside it there is no safe order to
change, test or extract anything. This is the report to run first on any
codebase:

```bash
codegraph analyze app.jsonl --report cycles --level module --internal-only
```

```text
cycles: 2 strongly connected components, ranked by component size descending, ties by weight then first member
tangle: 40.0% overall — feedback weight 2 of 5 cyclic references (minimum feedback set)

cycle 1 — 2 nodes, 3 edges, weight 8, tangle 50.0%
  members:
    java:com.acme.order/Money
    java:com.acme.order/Priceable
  edges:
    java:com.acme.order/Money     -> java:com.acme.order/Priceable  weight=1  kinds=interfaceImplementation  provenance=declared
    java:com.acme.order/Priceable -> java:com.acme.order/Money      weight=1  kinds=reference  provenance=declared  [feedback]
```

`--internal-only` drops the stubs, so the cycles you see are between code you
own. Run it at `--level module` first (packages tangled with packages) and
then at `--level type`.

**How to read it.** Three numbers per cycle:

- **members** is how many modules are locked together. One cycle of 500
  packages is a ball of mud with a thin shell; ten cycles of two packages each
  are ten local mistakes.
- **weight** is how many base dependencies are involved: how strongly the
  members hold on to each other.
- the **minimum feedback set**, marked `[feedback]`, is the cheapest set of
  edges whose removal would make the group acyclic. It is the refactoring plan
  the graph itself proposes. The **tangle** percentage is the feedback weight
  over the cyclic weight: how much of the group is "the knot".

The command exits with code 3 when any cycle exists, which is what a CI gate
checks; see [Gate a CI pipeline](/docs/how-to/ci-gate/).

## Measure coupling

Coupling says what everything depends on, and what depends on everything:

```bash
codegraph analyze app.jsonl --report coupling --level type --internal-only --top 20
```

```text
  Ca = afferent (distinct nodes depending on this one) = fan-in
  Ce = efferent (distinct nodes this one depends on)   = fan-out
  I  = Ce / (Ca + Ce); 0 when nothing touches the node. Self-loops excluded.

  NODE                         FAN-IN  FAN-OUT  CA  CE      I
  java:com.acme.order.legacy        1        0   1   0  0.000
  java:com.acme.order               0        1   0   1  1.000
```

**How to read it.** High fan-in and low instability (`I` near 0) is a
**load-bearing wall**: many things depend on it and it depends on little, so it
is stable by construction and a change to it is expensive. High fan-in *and*
high instability is the dangerous kind: much depends on it and it depends on
much, so any change anywhere can reach it. High fan-out with low fan-in is a
top-level orchestrator, which is fine if it is thin.

## See it

Numbers rank; a picture shows proportion. Bind complexity to height and size
to footprint, and the outliers become towers:

```bash
codegraph serve app.jsonl --height sum:cyclomatic --footprint loc \
  --internal-only --host 127.0.0.1
```

Open the **City** tab at `http://localhost:4177`. Districts are modules,
buildings are types. Tall narrow buildings are branchy code in little space;
wide flat ones are data carriers or generated code; a district that is one
huge building is a god class. Click a building and the **Navigate** tab opens
it with its dependencies and their source lines.
[Build a complexity city](/docs/how-to/complexity-city/) covers the scales and
what an "unmeasured" warning means; [Reading a city](/docs/tutorials/reading-the-city/)
is the guided walk.

{{< callout type="warning" >}}
Terrain ranks nothing on its own. "Four thousand years of technical debt" is
the kind of number a size report produces, and it tells nobody what to do
first. What you found here becomes a priority only once step 3 says which of
it is actually worked on.
{{< /callout >}}

## Write down

- The resolution rate and the stub count, and the commit the model was
  extracted from (the model header carries it).
- The size and complexity tables, with the break in each curve marked and the
  generated or test code marked as such.
- The cycles report: how many components, the size of the largest, and its
  feedback set.
- The ten types with the highest fan-in. They are the ones you will read no
  matter what.

Next: [Boundaries and style](/docs/discover/boundaries/).

## Related

- [Extract Java](/docs/how-to/extract-java/)
- [Query model.db](/docs/how-to/query-model-db/)
- [`codegraph analyze`](/docs/reference/cli/analyze/)
- [City metrics reference](/docs/reference/city-metrics/)
- [Your first city](/docs/tutorials/first-city/)
