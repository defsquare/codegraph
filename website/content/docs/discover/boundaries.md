---
title: "2 · Boundaries and style"
linkTitle: 2 · Boundaries
weight: 2
---

**The question.** What is the overall structure? How is the codebase cut, in
which architecture style (layered, hexagonal, modular monolith…), and do the
cuts hold? Which patterns are used, on which technology stack (language,
frameworks, libraries, tools)? How does the folder and package structure map
to that style? And around the system: which external systems call it
(inbound), which depend on it (downstream), which does it depend on to do its
job (outbound, upstream)? What are the data flows?

Part of this is a picture you draw from the model in a minute. Part of it is
a set of small queries you write for the codebase in front of you. And part of
it is reading, by you or by a language model, that the model informs but does
not replace. This page separates the three.

**Before you start:** the `app.jsonl` and `app.db` of step 1, with the two
helper views pasted, and Graphviz (`dot`) if you want the picture.

## Draw the module map

The module dependency graph is the one relation that exists in every
language, and it is the first thing to look at. Export it at module level,
internal only, and render it:

```bash
codegraph export app.jsonl --format dot --level module --internal-only > modules.dot
dot -Tsvg modules.dot -o modules.svg
```

Or as a PlantUML package diagram, which some teams prefer to paste into a wiki:

```bash
codegraph export app.jsonl --format plantuml --level module --internal-only > modules.puml
```

In both, a **solid** arrow means every folded dependency is a declared fact;
a **dashed** one contains an inference. Stubs, when you keep them, are dashed
and grey. The same graph as a table, with the number of base edges behind each
arrow and the kinds it folds:

```bash
codegraph export app.jsonl --format csv --level module --internal-only
```

```text
from,to,count,kinds,provenances,selfLoop,level,view
java:com.acme.order,java:com.acme.order.legacy,2,invocation;reference,declared,false,module,internalOnly
```

**How to read the picture.** Three shapes recur:

- **Deep and narrow**: a pipeline, each layer using the one below. Look for
  arrows that go *up*; each is a layering violation the code admits to.
- **Shallow and wide around one hub**: a star around a core module. The hub is
  the shared kernel, or the god package; step 1's coupling table says which.
- **One big knot at the top**: the tangle from step 1. Nothing inside it has
  a direction, and the "architecture" is whatever sits outside the knot.

## Name the style from the module names

Look at the names of the top-level modules and ask one question: are they
named after **technical roles** or after **business capabilities**?

| Module names look like | The cut is | What it implies |
|---|---|---|
| `controller`, `service`, `repository`, `dto`, `model`, `util` | **by layer** | every feature change crosses every module; step 3's cross-module co-change will be high |
| `orders`, `billing`, `catalog`, `shipping` | **by feature** (modular monolith, bounded contexts) | a change should stay inside one module; a dependency between two features is worth a look |
| `domain`, `application`, `infrastructure`, `adapters`, `ports` | **hexagonal / clean** | `domain` must depend on nothing outside itself; check it below |
| a mix of the above | mixed, the usual case | the boundary you want is the one the co-change says exists |

Then check that the folders match the modules. In Java a package is a folder,
so they agree by construction; the exception is a module split across two
source roots, which step 1's extraction choice already surfaced. In C# a
namespace and a folder can disagree, and a namespace spread over unrelated
folders is a finding in itself.

## Read the technology stack from the stubs

Everything the corpus references but does not declare is a stub, and the
modules the stubs live in are the **inventory of the outside world**: the
frameworks, the libraries, the I/O. Rank them by how often the corpus
references them:

```sql
SELECT m.symbol AS external_module, count(*) AS refs
  FROM dep d
  JOIN node n   ON n.ref = d.to_ref
  JOIN entity m ON m.id  = n.module_ref
 WHERE n.is_stub = 1
 GROUP BY m.symbol ORDER BY refs DESC
 LIMIT 40;
```

| external_module | refs |
|---|---|
| `java.lang` | 39 |
| `java.util` | 15 |
| `com.megacorp.ledger` | 10 |
| `java.time` | 3 |

**How to read it.** Skip the standard library and read the rest as a bill of
materials. `org.springframework.web` is Spring MVC; `jakarta.persistence` is
JPA, so there is a relational database; `org.apache.kafka` or `jakarta.jms` is
messaging; `org.hibernate` says which JPA; `com.fasterxml.jackson` says JSON;
a vendor package like `com.megacorp.ledger` above is an **external system the
corpus depends on** and belongs in the outbound list at the end of this page.
Copy the table into your notebook; it is the stack.

Which of your modules reach which external ones is the next question, and it
is the one that tests a hexagonal cut:

```sql
SELECT src.symbol AS module, ext.symbol AS reaches, count(*) AS refs
  FROM dep d
  JOIN node f   ON f.ref = d.from_ref
  JOIN entity src ON src.id = f.module_ref
  JOIN node t   ON t.ref = d.to_ref
  JOIN entity ext ON ext.id = t.module_ref
 WHERE t.is_stub = 1 AND f.is_stub IS NOT 1
 GROUP BY src.symbol, ext.symbol
 ORDER BY src.symbol, refs DESC;
```

A module called `domain` that reaches `jakarta.persistence` or
`org.springframework.web` is a violation the code admits to. Write each one
down with its count; small counts are one annotation that leaked, large ones
are a layer that never existed.

## Find the patterns from the annotations

Frameworks write their roles into the code as annotations (Java) or
attributes (C#), and codegraph keeps every use as an `annotationUse` edge with
its written arguments. A census of annotation names is the fastest honest
fingerprint of the style:

```sql
SELECT a.name AS annotation, am.symbol AS declared_in, count(*) AS uses
  FROM edge x
  JOIN edge_kind ek ON ek.id = x.kind_id
  JOIN entity a     ON a.id  = x.to_id
  JOIN entity am    ON am.id = a.module_id
 WHERE ek.name = 'annotationUse'
 GROUP BY a.name, am.symbol ORDER BY uses DESC, a.name;
```

| annotation | declared_in | uses |
|---|---|---|
| `Override` | `java.lang` | 7 |
| `Audited` | `com.acme.order` | 2 |
| `Retention` | `java.lang.annotation` | 1 |

On a Spring codebase the same query returns `RestController`, `Service`,
`Repository`, `Entity`, `Transactional`, `Scheduled`, `KafkaListener`… and the
counts per module are the architecture fingerprint: a module that is 80%
controllers is the presentation layer whatever its name.

From there, one targeted query per pattern. The **REST controllers and their
routes**, arguments included, on a Spring codebase:

```sql
SELECT n.id AS annotated, a.name AS annotation, x.arguments
  FROM edge x
  JOIN edge_kind ek ON ek.id = x.kind_id
  JOIN entity a     ON a.id  = x.to_id
  JOIN node n       ON n.ref = x.from_id
 WHERE ek.name = 'annotationUse'
   AND a.name IN ('RestController', 'Controller', 'RequestMapping',
                  'GetMapping', 'PostMapping', 'PutMapping',
                  'DeleteMapping', 'PatchMapping')
 ORDER BY n.id;
```

`arguments` is a JSON array of the written values, so the path of a
`@GetMapping("/owners/{id}")` is in there as a string literal. Swap the name
list for `Entity`/`Table`/`Id` and you have the persistence model;
for `KafkaListener`/`JmsListener`/`RabbitListener` the message consumers;
for `Scheduled` the timers; for `[ApiController]`/`[HttpGet]` the ASP.NET
Core equivalents.

{{< callout type="info" >}}
These queries are three tables and a name list. If SQL is not your language,
hand a language model the two helper views, the
[table list](/docs/how-to/query-model-db/#the-tables-to-start-from) and the
question in plain words ("every method annotated with a Spring request mapping,
with the path"), and paste back what it writes. The model file is the contract;
the query is disposable.
{{< /callout >}}

For Spring there is also a ready-made reading. `--report wiring` lists the
roles it recognised, the entry points and the injection points, and
`--framework spring` colours the city by role:

```bash
codegraph analyze app.jsonl --report wiring
codegraph serve app.jsonl --framework spring --host 127.0.0.1
```

Both say, in their first line, that everything they print is an inference
from written annotations. See [Colour a Spring codebase by role](/docs/how-to/spring-roles/).

## Check that the cuts hold

You now have a claimed style (from the names and the annotations) and the
graph. Three checks say whether the claim survives:

1. **Direction.** In a layered or hexagonal cut, list the module pairs whose
   arrow points the wrong way (a lower layer using a higher one, `domain`
   reaching infrastructure). The CSV export and the stub-reach query above
   are the evidence.
2. **Cycles.** Step 1's cycle report, at module level. Two "features" in one
   strongly connected component are one feature with two names.
3. **Co-change.** Step 3 will tell you how often a commit touches more than
   one top-level module. Above roughly a third of commits, the cut is by
   layer in practice whatever the folders say; below it, the modules are
   real boundaries.

## The system's surroundings and data flows

This last part is reading, not a command, and it is worth saying clearly.

**Outbound: what the system depends on.** The stub inventory above gives you
the libraries; the vendor packages in it, the HTTP clients, the JDBC or JPA
references, the message producers are the **upstream systems** the codebase
needs to do its job. The model tells you *that* a call exists and *from
where*; what is at the other end (which database, which service, which queue
name) is in configuration files and string literals the model carries for
constants but does not interpret.

**Inbound: what calls the system.** The controllers, listeners and jobs the
annotation queries found are the doors. Step 4, [Stimuli and flows](/docs/discover/stimuli/),
inventories them properly and walks what each one reaches.

**Downstream: what depends on the system.** Nothing in the code says who
calls its API. That is a question for the people, the API gateway logs or the
contracts; the model can only list the surface being offered.

**Data flows.** A flow is a data shape plus a call chain. The call chain is
what step 4 computes. The shape is the fields of the types crossing the
boundary (the request and response DTOs, the entities, the message
payloads), and `domain-facts` writes them out pre-joined, one dossier per
type with fields, declared types and annotations:

```bash
codegraph domain-facts app.jsonl --framework spring --out app-facts.json
```

Hand that file and the call chain to a reader, human or model, and ask for the
flow in words. Codegraph does not draw a data-flow diagram today; it gives the
two halves the diagram is made of.

## Write down

- The module map, and the shape you recognised in it.
- The style you claim, and the evidence for it: module names, annotation
  census, the checks that held and the ones that failed.
- The stack, as the stub table.
- Outbound systems (vendor stubs, I/O libraries) and inbound doors
  (controllers, listeners, jobs), each with its module.

Next: [Activity](/docs/discover/activity/).

## Related

- [`codegraph export`](/docs/reference/cli/export/)
- [`codegraph domain-facts`](/docs/reference/cli/domain-facts/) and the
  [domain-facts.json artifact](/docs/reference/artifacts/domain-facts/)
- [Colour a Spring codebase by role](/docs/how-to/spring-roles/)
- [Stubs in the metamodel](/docs/reference/metamodel/stubs/)
- [Querying the model with SQL](/docs/tutorials/sql/)
