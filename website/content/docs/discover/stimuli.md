---
title: "4 · Stimuli and flows"
linkTitle: 4 · Stimuli
weight: 4
---

**The question.** What reacts to the outside world? Which elements of the code
are entry points from outside (a REST endpoint, a web controller, a message
listener, a command-line verb) or from time (a scheduled job), and what does
each reaction reach? What is the call chain behind each stimulus?

A system is a set of reactions. Listing its **stimuli** is listing its
interface in the words a domain expert would use: this command, that query,
this event it consumes, that timer. And walking from each stimulus inward
gives you the **slice** that runs when it fires: a use case, read from the
code. The two together are the best map a newcomer can have, because they
start from the outside, which is how the business sees the system.

**Before you start:** the model from step 1, and the annotation census from
step 2. Every block below is a query file run with
[`codegraph query`](/docs/reference/cli/query/); the statements are at
[the end of this page](#the-statements) and in
[`plugin/queries/`](https://github.com/defsquare/codegraph/tree/main/plugin/queries)
of the repository. `--param-file` hands one query the saved result of another.

{{< callout type="warning" >}}
What exists today: an inventory of entry points from a table of names you
give, the chain behind each of them, on facts and with candidates, and what
no chain touches. What does not exist yet: a command that does it in one
step, and a way to find a handler that is *passed* to the framework instead
of being marked for it (an Express route, an ASP.NET minimal API, a Phoenix
route). The page says where that bites.
{{< /callout >}}

## Inventory the entry points

Three detection layers, strongest first. One query runs all three and says
which one found each row.

**1. Framework annotations.** An annotation on a method is written in the
source: `@GetMapping`, `[HttpPost]`, `@Cron()`. For Spring, codegraph already
recognises a list of them:

```bash
codegraph analyze app.jsonl --report wiring
```

```text
framework: spring — every line below is DERIVED from annotations,
           never a declared fact; candidate targets are `dynamic-candidate`.

architectural roles (12 types):
  …
entry points: 7 (called from outside the corpus)
  …
```

For any framework, Spring included, the inventory below does the same with a
list of names you choose. The annotation census of step 2 shows which names
the code uses.

**2. Supertypes the framework calls.** A class implementing `Runnable`, `Job`
or `CommandLineRunner`, a controller extending `ActionController::Base`, is
called with no annotation on it. The census of the external types the code
extends, implements or mixes in shows which there are:

```bash
codegraph query app.jsonl --file supertypes.sql
```

| supertype | relation | types | example |
|---|---|---|---|
| `java:com.megacorp.ledger/LedgerClient` | inheritance | 1 | `java:com.acme.order.adapter/LedgerAdapter` |
| `java:java.lang/RuntimeException` | inheritance | 1 | `java:com.acme.order/EmptyBasketException` |

Read the list and keep the supertypes that mean "called from outside". The
entry points are then the operations of those types **that nothing in the
code calls**: the callbacks, not the helpers beside them.

**3. Operations nothing in the code calls.** The structural fallback, which
needs no framework knowledge at all. Such an operation is one of five things:
an entry point the two layers above missed, a reflection target (a getter a
template reads, a property a binder sets), a handler passed to the framework
as a value, dead code, or library API offered to others. Four kinds of
operation are left out, because each has a caller the model does not draw:

- a **constructor**: a container builds what it wires;
- an operation **written inside another** (a lambda, a local function): it
  runs with the one that holds it;
- an operation **called through a type above its own**: a call to
  `Priceable.price()` may run `Money.price()`. Same name, same number of
  parameters, in a type that extends or implements the called one;
- a **name the language itself calls** (`toString`, `equals`, Ruby's
  `initialize`): the `conventional` names of the
  [language profile](/docs/reference/profiles/).

### The stack table

The names are data, not code: a **stack table**, one JSON file. Each of its
maps gives a name and the kind of stimulus it stands for.

| Map | A key is | It finds |
|---|---|---|
| `annotations` | an annotation's name | whatever carries it |
| `supertypes` | the name of a type the framework calls | the uncalled operations of every type below it |
| `types` | a pattern on a type's name (`*Controller`) | the uncalled operations of the types it matches |
| `operations` | an operation's name (`main`, `perform`) | the uncalled operations of that name |
| `entries` | an id | that entity: what a person said is an entry point |
| `conventional` | (a list) the names the language calls | nothing: those are left out of layer 3 |

The kinds of stimulus are these eight. The last two are technical: they are
entry points, and rarely domain.

| Stimulus | What it is, in domain words | Annotations and supertypes to look for |
|---|---|---|
| `inbound command` | a request to change something | `PostMapping`, `PutMapping`, `DeleteMapping`, `[HttpPost]`, `CommandHandler`, a CLI verb |
| `inbound query` | a request to read something | `GetMapping`, `[HttpGet]`, GraphQL resolvers, `QueryHandler` |
| `inbound request` | a request, and the name does not say whether it reads or changes | `RequestMapping`, `[Route]`, a Rails or MVC controller action, `MessagePattern` |
| `external event` | something happened elsewhere | `KafkaListener`, `JmsListener`, `RabbitListener`, `SqsListener`, a webhook route |
| `internal event` | something happened here, and something else reacts | `EventListener`, `TransactionalEventListener`, `EventHandler`, a background job |
| `temporal` | time passed | `Scheduled`, `Cron`, Quartz `Job`, `TimerTask` |
| `lifecycle` | the process starts or stops | `main`, `ApplicationRunner`, `CommandLineRunner`, `PostConstruct`, `Bean` |
| `framework callback` | plumbing the framework calls | `Filter`, `Interceptor`, `Converter`, `HealthIndicator`, `InitBinder` |

Five tables ship with the plugin, in
[`plugin/references/stacks/`](https://github.com/defsquare/codegraph/tree/main/plugin/references/stacks).
Each was run on a real codebase and its rows read:

| Table | Language | Checked on | It found | It does not find |
|---|---|---|---|---|
| `spring.json` | Java | spring-petclinic `500158f` | 32 by annotation, the 32 of `--report wiring`; 6 by supertype; `main` | a property a template or a binder reaches (16 rows left unclassified) |
| `aspnet.json` | C# | dotnet/eShop `ab10e4c`, OrchardCore `045b6d1` | eShop: 14 by attribute, 44 by supertype. OrchardCore: 399 and 587 | a minimal API route (`MapGet("/items", GetAllItems)`): the handler is passed as a value |
| `nestjs.json` | TypeScript | the 39 sample apps of nestjs/nest `94df49d` | 130 by decorator, 33 by supertype | a decorator whose package resolves to source outside the roots: it is then filed as that file, not by name |
| `phoenix.json` | Elixir | plausible/analytics `418da46` | 170 by type name (`*Controller`, `Mix.Tasks.*`), 253 by operation name (`mount`, `handle_event`, `perform`), 11 by behaviour | which controller function is routed: the router's macros are not edges. `use` is not a supertype without a compiler trace |
| `rails.json` | Ruby | mastodon `v4.3.0` | 1 543 by supertype: controllers, Sidekiq workers, serializers, mailers, Thor commands | which controller method is an action and which a filter: the model has no visibility. A Rake task: a block, not an operation |

Any other framework is **not covered**: Jakarta EE and JAX-RS, Micronaut,
Quarkus, Azure Functions, Express, Fastify, Next.js, Sinatra, Grape, Hanami.
Build its table from the two censuses, and say it is yours.

### The inventory

Copy a table, add what the censuses and the people around you say, and run:

```bash
codegraph query app.jsonl --file entry-points.sql --param-file stack=stack.json
```

| entry_point | kind | layer | evidence | stimulus | calls | arguments |
|---|---|---|---|---|---|---|
| `java:com.acme.order/Order.discount(int)` | method | annotation | Audited | inbound command | 1 | `[{"name":"value","value":{"k":"unevaluated","source":"LedgerClient.AUDIT_TAG"}}]` |
| `java:com.acme.order/Reporting.max(java.util.List)` | method | annotation | Audited | inbound command | 1 | `[{"name":"value","value":{"k":"string","v":"monthly"}}]` |
| `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` | method | supertype | LedgerClient | external event | 1 | NULL |
| `java:com.acme.order/Notifications.notifyShipped(com.acme.order.Order)` | method | by hand | NULL | internal event | 1 | NULL |
| `java:com.acme.order/OrderService.bill(com.acme.order.Order)` | method | type name | `*Service` | inbound command | 3 | NULL |
| `java:com.acme.order/OrderService.archive(com.acme.order.legacy.List)` | method | type name | `*Service` | inbound command | 2 | NULL |
| `java:com.acme.order/OrderService.archive(java.util.List)` | method | type name | `*Service` | inbound command | 2 | NULL |
| `java:com.acme.order/Batch.running()` | method | no caller | NULL | temporal | 2 | NULL |
| `java:com.acme.order/Reporting.join(java.lang.String[])` | method | no caller | NULL | NULL | 3 | NULL |

That is the reference fixture, which uses no framework, with a table that
names what stands for one there:

```json
{
  "annotations":  { "Audited": "inbound command" },
  "supertypes":   { "LedgerClient": "external event" },
  "types":        { "*Service": "inbound command" },
  "operations":   { "running": "temporal" },
  "conventional": ["toString", "equals", "hashCode", "compareTo", "main"],
  "entries":      { "java:com.acme.order/Notifications.notifyShipped(com.acme.order.Order)": "internal event" }
}
```

**How to read it.**

- `layer` is the evidence: `annotation` and `supertype` are written in the
  source; `type name` is a convention you stated; `by hand` is what somebody
  said; `no caller` is the absence of an edge. A row found by two layers is
  shown under the stronger one.
- `stimulus` is the table's word. **`NULL` is unclassified**: found by
  layer 3, named by no table. Rank those by `calls`, the calls the operation
  makes: the ones that do something come first. An unclassified row is not an
  entry point until someone says so; write it in `entries`, or its type in
  `types`, and run again.
- A row whose `kind` is not an operation is a marker, not a stimulus: a
  `@RequestMapping` on a class is a path prefix, a `@ModelAttribute` on a
  parameter is a binding. It is listed because the annotation is there.
- An `entries` id that is not in the model comes back with `kind` `NULL`: a
  typo shows instead of vanishing.
- Zero rows for a map is "this table found none here", never "there are
  none".

Step 3 separates two of the five cases of layer 3: dead code is stable (no
revisions), an entry point is worked on.

Save the inventory (`--all --json > inventory.json`): the queries below read
it. The first one is the inventory **grouped by kind**, which is what you
write down:

```bash
codegraph query app.jsonl --file entry-point-kinds.sql --param-file inventory=inventory.json
```

| stimulus | layer | evidence | entry_points | example |
|---|---|---|---|---|
| external event | supertype | LedgerClient | 1 | `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` |
| inbound command | type name | `*Service` | 3 | `java:com.acme.order/OrderService.archive(com.acme.order.legacy.List)` |
| inbound command | annotation | Audited | 2 | `java:com.acme.order/Order.discount(int)` |
| internal event | by hand | NULL | 1 | `java:com.acme.order/Notifications.notifyShipped(com.acme.order.Order)` |
| temporal | no caller | NULL | 1 | `java:com.acme.order/Batch.running()` |
| unclassified | no caller | NULL | 24 | `java:com.acme.order.legacy/List.length()` |

## Walk what each stimulus reaches

From an entry point, follow the invocation and access edges forward. The
reachable set is everything that *can* run when the stimulus fires:

```bash
codegraph query app.jsonl --file reach.sql --param candidates=0 \
  --param id='java:com.acme.order/Order.discount(int)'
```

| id | external | depth |
|---|---|---|
| `java:com.acme.order/Order.discount(int)` | 0 | 0 |
| `java:com.acme.order/AbstractOrder.total` | 0 | 1 |
| `java:com.acme.order/Money.times(int)` | 0 | 1 |
| `java:com.megacorp.ledger/LedgerClient` | 1 | 1 |
| `java:com.acme.order/Money.<init>(long)` | 0 | 2 |
| `java:com.acme.order/Money.cents` | 0 | 2 |

**How to read it.** The rows with `external = 1` are the **exit points**: the
stubs the chain ends in. A database driver, an HTTP client, a message
producer, a clock; skip the language's own library. An entry point and its
exit points are one end-to-end flow: in domain words, a command, the
operations it triggers and the outside capabilities it needs.

Run it twice. With `candidates=0` you get the **facts-only lower bound**:
edges of provenance `declared`, and the operations written inside a reached
one. With `candidates=1` you add three things, each an inference:

- every edge the extractor wrote with another provenance (`derived`,
  `generated`, `dynamic-candidate`);
- the **candidates** a `dynamic-candidate` edge lists without choosing one: an
  Elixir protocol call and its implementations;
- **dispatch**: a call to an operation of a type may run the operation of the
  same name and the same number of parameters in any type of the code that
  extends or implements it.

A chain that doubles between the two runs goes through an interface whose
implementation is chosen at runtime, and a reader must know which one. On the
C# fixture, `MoneyExtensions.IsFree(IPriceable)` reaches 3 entities on facts
and 9 with the candidates: the three `Price()` behind `IPriceable`, and what
they reach. Where no type of the code implements the interface (a Spring Data
repository), the two runs are equal, and that says the implementation is not
in the source.

{{< callout type="info" >}}
The candidate targets of `--report wiring` are **not** in the store: that
report derives them in memory and prints them. The second run does not need
them: dispatch reaches every implementation in the code, where the wiring
report would keep the ones a `@Primary` or a `@Qualifier` selects. It is the
upper bound.
{{< /callout >}}

For a chain you want to *see* rather than list, the navigator does the same
walk by hand: open the entry point in the **Navigate** tab of
`codegraph serve`, and each row under fan-out opens the next hop with its
source line. Five hops in, you have read the use case.

## What the slices give you

One query walks the chain behind **every classified entry point** at once, and
folds what it reaches to types. It reads the saved inventory:

```bash
codegraph query app.jsonl --file chains.sql --param-file inventory=inventory.json --param candidates=0
```

| entry_point | type | external | depth | file |
|---|---|---|---|---|
| `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` | `java:com.acme.order.adapter/LedgerAdapter` | 0 | 0 | `com/acme/order/adapter/LedgerAdapter.java` |
| `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` | `java:com.acme.order.adapter/AuditTrail` | 1 | 1 | NULL |
| `java:com.acme.order/Batch.running()` | `java:com.acme.order/Batch` | 0 | 0 | `com/acme/order/Batch.java` |
| `java:com.acme.order/Batch.running()` | `java:com.acme.order/Money` | 0 | 1 | `com/acme/order/Money.java` |

The rows of one entry point, in this order, are **the reading order for the
use case**: its types, the nearest first, then its exit points. Save the
result (`--all --json > chains.json`); three cheap observations read it.

**Which chain to read first.** Rank the chains by how many step 3 hotspots
they pass through. `:hotspots` is the joined hotspot report as step 3 saved
it; its first ten rows count. Here two files stand for it:

```bash
codegraph query app.jsonl --file chain-ranking.sql --param-file chains=chains.json \
  --param hotspots='{"rows":[{"model":"com/acme/order/Money.java"},{"model":"com/acme/order/OrderService.java"}]}'
```

| entry_point | types | exits | depth | hotspots |
|---|---|---|---|---|
| `java:com.acme.order/Order.discount(int)` | 3 | 1 | 1 | 1 |
| `java:com.acme.order/Batch.running()` | 2 | 0 | 1 | 1 |
| `java:com.acme.order/OrderService.archive(com.acme.order.legacy.List)` | 2 | 1 | 1 | 1 |

The chain through the biggest, most-changed, most-tangled code is the one to
read first, and the one to explain first in step 5. Read a command, a query,
a request or an event before a `lifecycle` entry or a `framework callback` of
the same rank: a callback runs for every request and is nobody's use case.
With no history, pass `'{"rows":[]}'`: the column is then 0 everywhere, and
the order is by size.

**Use cases, grouped.** Entry points whose chains overlap heavily belong to
the same feature; groups with little overlap are candidate bounded contexts.
Two chains are put together when the types they share are at least `:min`
percent of all the types of the two; a group is whatever is near something
in it. The types that more than half the chains reach are left out of the
comparison: they would glue everything into one group.

```bash
codegraph query app.jsonl --file chain-groups.sql --param-file chains=chains.json --param min=50
```

| group_of | entry_points | entry_point | types |
|---|---|---|---|
| `java:com.acme.order/OrderService.archive(java.util.List)` | 2 | `java:com.acme.order/OrderService.archive(java.util.List)` | 2 |
| `java:com.acme.order/OrderService.archive(java.util.List)` | 2 | `java:com.acme.order/OrderService.bill(com.acme.order.Order)` | 2 |
| `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` | 1 | `java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)` | 1 |

A group is named after one of its members. Start at 50 and raise it when one
group swallows the rest. Group the facts-only chains: with candidates, every
chain that crosses a widely implemented interface reaches the same types.

**The shared kernel.** Types present in almost every chain are the shared
kernel or the cross-cutting plumbing, and step 5 will say which:

```bash
codegraph query app.jsonl --file shared-types.sql --param-file chains=chains.json
```

| type | chains | pct |
|---|---|---|
| `java:com.acme.order/AbstractOrder` | 3 | 37.5 |
| `java:com.acme.order/OrderService` | 3 | 37.5 |
| `java:com.acme.order/Money` | 2 | 25.0 |

**The residue.** What nothing that starts at an entry point touches. A chain
follows what *runs*; a type that is only mentioned (a parameter's type, an
exception thrown, a class extended) is used all the same. So the residue is
measured wider: from the types of the classified entry points, through
**every** edge between types, any kind, any provenance. What is left is
mentioned by nothing reachable.

```bash
codegraph query app.jsonl --file residue.sql --param-file inventory=inventory.json \
  --param activity='{"rows":[{"model":"com/acme/order/Basket.java","revisions":4}]}'
```

| type | kind | file | sloc | revisions |
|---|---|---|---|---|
| `java:com.acme.order/Basket` | class | `com/acme/order/Basket.java` | 34 | 4 |
| `java:com.acme.order/Basket.Line` | class | `com/acme/order/Basket.java` | 14 | 4 |
| `java:com.acme.order/Basket.Cursor` | class | `com/acme/order/Basket.java` | 6 | 4 |
| `java:com.acme.order/Basket.Line.Discount` | class | `com/acme/order/Basket.java` | 5 | 4 |
| `java:com.acme.order/StockGuard` | class | `com/acme/order/StockGuard.java` | 14 | 0 |
| `java:com.acme.order/EmptyBasketException` | class | `com/acme/order/EmptyBasketException.java` | 5 | 0 |

`:activity` is step 3's joined hotspot report, saved for every file:

```bash
codegraph history history.jsonl --report hotspots --model app.jsonl --top 100000 --json > activity.json
```

`revisions` is the file's, in the window step 3 mined. **Stable residue** (0)
is deletion material. **Actively changed residue** is a detection gap:
reflection, a framework the table does not know. Report it as a gap, not as
dead code. With no history (`'{"rows":[]}'`) the column is `NULL`: not
measured, which is not zero. The residue is only as good as the inventory: an
entry point the table missed takes everything behind it into the residue.

## Write down

- The entry-point inventory, grouped by kind, each with its module and the
  evidence it was found by (annotation, interface, zero callers).
- For the top chains: the list of types in depth order and the exit points.
- The residue, split into stable and active.

Next: [Meaning](/docs/discover/meaning/).

## The statements

One statement per file. A type is asked for by its trait (`TType`), an
operation by `TInvocable`, never by a list of kinds, so the same text runs on
every language.

### supertypes.sql

The external types the code extends, implements or mixes in, and how many of its types do. Parameters: none.

```sql
SELECT t.id AS supertype, d.kind AS relation,
       count(DISTINCT d.from_ref) AS types, min(n.id) AS example
  FROM dep d
  JOIN node t ON t.ref = d.to_ref
  JOIN node n ON n.ref = d.from_ref
 WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
   AND t.is_stub AND NOT n.is_stub
 GROUP BY t.ref, d.kind
 ORDER BY types DESC, supertype, relation
 LIMIT 40;
```

### entry-points.sql

The entry-point inventory, each row with the layer that found it: an annotation, a supertype, a name, no caller. Parameters: :stack — a stack table as JSON: annotations, supertypes, types, operations, conventional, entries.

```sql
WITH RECURSIVE
-- the stack table, read once
by_annotation(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.annotations')),
by_supertype(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.supertypes')),
by_type_name(pattern, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.types')),
by_name(name, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.operations')),
by_hand(id, stimulus) AS MATERIALIZED (
  SELECT key, value FROM json_each(:stack, '$.entries')),
conventional(name) AS MATERIALIZED (
  SELECT value FROM json_each(:stack, '$.conventional')),
operation AS (               -- what can be called, whatever its kind is named
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
above(type, super) AS (      -- a type, with every type above it
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
  UNION
  SELECT a.type, d.to_ref FROM above a JOIN dep d ON d.from_ref = a.super
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')),
called(ref) AS (             -- the target of a call, or one of its candidates
  SELECT to_ref FROM dep WHERE kind = 'invocation'
  UNION
  SELECT candidate_id FROM edge_candidate),
arity(ref, n) AS (
  SELECT entity_id, count(*) FROM entity_parameter GROUP BY entity_id),
overriding(ref) AS (         -- called through a type above its own: same name, same number of parameters
  SELECT o.id
    FROM called c
    JOIN entity s ON s.id = c.ref
    JOIN above a  ON a.super = s.parent_id
    JOIN entity o ON o.parent_id = a.type AND o.name = s.name
    LEFT JOIN arity sn ON sn.ref = s.id
    LEFT JOIN arity om ON om.ref = o.id
   WHERE coalesce(sn.n, 0) = coalesce(om.n, 0)),
uncalled(ref, type, name) AS MATERIALIZED (
  SELECT e.id, e.parent_id, e.name
    FROM entity e
    LEFT JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND e.is_stub IS NOT 1
     AND e.name IS NOT NULL
     AND e.kind_id NOT IN (SELECT id FROM kind WHERE name = 'constructor')
     -- a lambda or a local function runs with the operation it is written in
     AND (p.id IS NULL OR p.trait_set_id NOT IN (SELECT trait_set_id FROM operation))
     AND e.id NOT IN (SELECT ref FROM called)
     AND e.id NOT IN (SELECT ref FROM overriding)),
found(ref, id, layer, evidence, stimulus, arguments) AS MATERIALIZED (
  SELECT x.from_id, NULL, 'annotation', a.name, w.stimulus, x.arguments
    FROM by_annotation w
    JOIN entity a     ON a.name = w.name
    JOIN edge x       ON x.to_id = a.id
    JOIN edge_kind ek ON ek.id = x.kind_id AND ek.name = 'annotationUse'
  UNION ALL
  SELECT u.ref, NULL, 'supertype', s.name, w.stimulus, NULL
    FROM by_supertype w
    JOIN entity s   ON s.name = w.name
    JOIN above a    ON a.super = s.id
    JOIN uncalled u ON u.type = a.type
  UNION ALL
  SELECT n.ref, w.id, 'by hand', NULL, w.stimulus, NULL
    FROM by_hand w
    LEFT JOIN node n ON n.id = w.id
  UNION ALL
  SELECT u.ref, NULL, 'type name', w.pattern, w.stimulus, NULL
    FROM by_type_name w
    JOIN entity t   ON t.name GLOB w.pattern
    JOIN uncalled u ON u.type = t.id
  UNION ALL
  SELECT u.ref, NULL, 'no caller', NULL, w.stimulus, NULL
    FROM uncalled u
    LEFT JOIN by_name w ON w.name = u.name
   -- a name the language itself calls is not a stimulus, unless the table says so
   WHERE w.name IS NOT NULL
      OR u.name NOT IN (SELECT name FROM conventional))
SELECT coalesce(n.id, f.id) AS entry_point, n.kind, f.layer, f.evidence, f.stimulus,
       (SELECT count(*) FROM dep o
         WHERE o.from_ref = f.ref AND o.kind = 'invocation') AS calls,
       f.arguments
  FROM found f
  LEFT JOIN node n ON n.ref = f.ref
 WHERE f.layer = 'annotation'
    OR (f.layer = 'supertype'
        AND f.ref NOT IN (SELECT ref FROM found WHERE layer = 'annotation'))
    OR (f.layer = 'by hand'
        AND (f.ref IS NULL OR f.ref NOT IN (
              SELECT ref FROM found WHERE layer IN ('annotation', 'supertype'))))
    OR (f.layer = 'type name'
        AND f.ref NOT IN (SELECT ref FROM found
                           WHERE layer IN ('annotation', 'supertype', 'by hand')
                             AND ref IS NOT NULL))
    OR (f.layer = 'no caller'
        AND f.ref NOT IN (SELECT ref FROM found
                           WHERE layer <> 'no caller' AND ref IS NOT NULL))
 ORDER BY CASE f.layer WHEN 'annotation' THEN 1 WHEN 'supertype' THEN 2
                       WHEN 'by hand' THEN 3 WHEN 'type name' THEN 4 ELSE 5 END,
          f.stimulus IS NULL, calls DESC, entry_point, f.evidence;
```

### entry-point-kinds.sql

The inventory grouped by kind of stimulus, with the layer and the name that found each group. Parameters: :inventory — the saved rows of entry-points.sql.

```sql
WITH found(entry, layer, evidence, stimulus) AS (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[2]'),
         json_extract(r.value, '$[3]'), json_extract(r.value, '$[4]')
    FROM json_each(:inventory, '$.rows') r)
SELECT coalesce(f.stimulus, 'unclassified') AS stimulus, f.layer, f.evidence,
       count(DISTINCT f.entry) AS entry_points, min(f.entry) AS example
  FROM found f
 GROUP BY f.stimulus, f.layer, f.evidence
 -- what no table names comes last
 ORDER BY f.stimulus IS NULL, f.stimulus, entry_points DESC, f.layer, f.evidence;
```

### reach.sql

What one entry point reaches, hop by hop: on facts only, or with the candidates. Parameters: :id — the entry point's id, :candidates — 0 for declared facts only, 1 to add the candidates.

```sql
WITH RECURSIVE
operation AS (               -- what can be called, whatever its kind is named
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
above(type, super) AS (      -- a type, with every type above it
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
  UNION
  SELECT a.type, d.to_ref FROM above a JOIN dep d ON d.from_ref = a.super
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')),
arity(ref, n) AS (
  SELECT entity_id, count(*) FROM entity_parameter GROUP BY entity_id),
step(src, dst) AS (
  -- a call or an access, as written
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('invocation', 'access')
     AND (:candidates = 1 OR d.provenance = 'declared')
  UNION
  -- an operation written inside another runs with it: a lambda, a local function
  SELECT c.parent_id, c.id FROM entity c JOIN entity p ON p.id = c.parent_id
   WHERE c.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND p.trait_set_id IN (SELECT trait_set_id FROM operation)
  UNION
  -- candidates: the targets an edge lists without choosing one
  SELECT x.from_id, c.candidate_id FROM edge_candidate c JOIN edge x ON x.id = c.edge_id
   WHERE :candidates = 1
  UNION
  -- candidates: a call may run the operation of the same name in any type below
  SELECT s.id, o.id
    FROM above a
    JOIN entity s ON s.parent_id = a.super
    JOIN entity o ON o.parent_id = a.type AND o.name = s.name
    LEFT JOIN arity sn ON sn.ref = s.id
    LEFT JOIN arity om ON om.ref = o.id
   WHERE :candidates = 1
     AND s.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND o.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND coalesce(sn.n, 0) = coalesce(om.n, 0)),
reach(ref, depth) AS (
  SELECT ref, 0 FROM node WHERE id = :id
  UNION
  SELECT s.dst, r.depth + 1 FROM reach r JOIN step s ON s.src = r.ref
   WHERE r.depth < 20)
SELECT n.id, n.is_stub AS external, min(r.depth) AS depth
  FROM reach r JOIN node n ON n.ref = r.ref
 GROUP BY n.ref ORDER BY depth, n.id;
```

### chains.sql

The chain behind every classified entry point at once: the types it reaches, the nearest first. Parameters: :inventory — the saved rows of entry-points.sql, :candidates — 0 for declared facts only, 1 to add the candidates.

```sql
WITH RECURSIVE
operation AS (               -- what can be called, whatever its kind is named
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
above(type, super) AS (      -- a type, with every type above it
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')
  UNION
  SELECT a.type, d.to_ref FROM above a JOIN dep d ON d.from_ref = a.super
   WHERE d.kind IN ('inheritance', 'interfaceImplementation', 'traitUsage')),
arity(ref, n) AS (
  SELECT entity_id, count(*) FROM entity_parameter GROUP BY entity_id),
step(src, dst) AS (
  -- a call or an access, as written
  SELECT d.from_ref, d.to_ref FROM dep d
   WHERE d.kind IN ('invocation', 'access')
     AND (:candidates = 1 OR d.provenance = 'declared')
  UNION
  -- an operation written inside another runs with it: a lambda, a local function
  SELECT c.parent_id, c.id FROM entity c JOIN entity p ON p.id = c.parent_id
   WHERE c.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND p.trait_set_id IN (SELECT trait_set_id FROM operation)
  UNION
  -- candidates: the targets an edge lists without choosing one
  SELECT x.from_id, c.candidate_id FROM edge_candidate c JOIN edge x ON x.id = c.edge_id
   WHERE :candidates = 1
  UNION
  -- candidates: a call may run the operation of the same name in any type below
  SELECT s.id, o.id
    FROM above a
    JOIN entity s ON s.parent_id = a.super
    JOIN entity o ON o.parent_id = a.type AND o.name = s.name
    LEFT JOIN arity sn ON sn.ref = s.id
    LEFT JOIN arity om ON om.ref = o.id
   WHERE :candidates = 1
     AND s.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND o.trait_set_id IN (SELECT trait_set_id FROM operation)
     AND coalesce(sn.n, 0) = coalesce(om.n, 0)),
classified(id) AS MATERIALIZED (   -- the inventory's rows that have a stimulus
  SELECT json_extract(r.value, '$[0]')
    FROM json_each(:inventory, '$.rows') r
   WHERE json_extract(r.value, '$[4]') IS NOT NULL),
seed(ref) AS (               -- those of them that are operations
  SELECT n.ref FROM node n
   WHERE n.id IN (SELECT id FROM classified)
     AND n.trait_set_id IN (SELECT trait_set_id FROM operation)),
reach(entry, ref, depth) AS (
  SELECT ref, ref, 0 FROM seed
  UNION
  SELECT r.entry, s.dst, r.depth + 1 FROM reach r JOIN step s ON s.src = r.ref
   WHERE r.depth < 20),
climb(ref, at) AS (          -- from what is reached up to the nearest type around it
  SELECT DISTINCT ref, ref FROM reach
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NULL
      OR e.trait_set_id IN (SELECT trait_set_id FROM types))
SELECT s.id AS entry_point, t.id AS type, t.is_stub AS external,
       min(r.depth) AS depth, f.path AS file
  FROM reach r
  JOIN owner o  ON o.ref = r.ref
  JOIN node s   ON s.ref = r.entry
  JOIN node t   ON t.ref = o.type
  JOIN entity e ON e.id  = o.type
  LEFT JOIN file f ON f.id = e.anchor_file_id
 GROUP BY r.entry, o.type
 ORDER BY entry_point, depth, type;
```

### chain-ranking.sql

One row per chain: how much it reaches, and how many of step 3's hotspots it passes through. Parameters: :chains — the saved rows of chains.sql, :hotspots — step 3's joined hotspot report as saved, or {"rows":[]}.

```sql
WITH member(entry, external, depth, file) AS (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[2]'),
         json_extract(r.value, '$[3]'), json_extract(r.value, '$[4]')
    FROM json_each(:chains, '$.rows') r),
hot(file) AS (               -- the first ten rows of the report, by the file the model knows
  SELECT json_extract(h.value, '$.model')
    FROM json_each(:hotspots, '$.rows') h
   WHERE h.key < 10)
SELECT m.entry AS entry_point,
       sum(m.external = 0) AS types,
       sum(m.external = 1) AS exits,
       max(m.depth)        AS depth,
       count(DISTINCT CASE WHEN m.file IN (SELECT file FROM hot) THEN m.file END) AS hotspots
  FROM member m
 GROUP BY m.entry
 ORDER BY hotspots DESC, types DESC, entry_point;
```

### chain-groups.sql

The entry points grouped by what their chains share: one group, one candidate use case. Parameters: :chains — the saved rows of chains.sql, :min — the share of types two chains must have in common, in percent.

```sql
WITH RECURSIVE
member(entry, type) AS MATERIALIZED (   -- the code's own types only
  SELECT DISTINCT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0),
entries(entry) AS MATERIALIZED (
  SELECT DISTINCT entry FROM member),
plumbing(type) AS MATERIALIZED (        -- what more than half the chains reach tells no two apart
  SELECT type FROM member GROUP BY type
  HAVING 2 * count(*) > (SELECT count(*) FROM entries)),
own(entry, type) AS MATERIALIZED (
  SELECT entry, type FROM member
   WHERE type NOT IN (SELECT type FROM plumbing)),
size(entry, n) AS MATERIALIZED (
  SELECT entry, count(*) FROM own GROUP BY entry),
near(a, b) AS MATERIALIZED (            -- shared types over all the types of the two chains
  SELECT x.entry, y.entry
    FROM own x
    JOIN own y   ON y.type = x.type AND y.entry <> x.entry
    JOIN size sx ON sx.entry = x.entry
    JOIN size sy ON sy.entry = y.entry
   GROUP BY x.entry, y.entry
  HAVING 100.0 * count(*) / (max(sx.n) + max(sy.n) - count(*)) >= :min),
spread(entry, label) AS (               -- a group is whatever is near something in it
  SELECT entry, entry FROM entries
  UNION
  SELECT n.b, s.label FROM spread s JOIN near n ON n.a = s.entry),
grouped(entry, label) AS (
  SELECT entry, min(label) FROM spread GROUP BY entry)
SELECT g.label AS group_of,
       count(*) OVER (PARTITION BY g.label) AS entry_points,
       g.entry AS entry_point,
       (SELECT count(*) FROM member m WHERE m.entry = g.entry) AS types
  FROM grouped g
 ORDER BY entry_points DESC, group_of, entry_point;
```

### shared-types.sql

The types of the code that the most chains pass through: the shared kernel, or the plumbing. Parameters: :chains — the saved rows of chains.sql.

```sql
WITH member(entry, type) AS (
  SELECT DISTINCT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0)
SELECT m.type, count(*) AS chains,
       round(100.0 * count(*) / (SELECT count(DISTINCT entry) FROM member), 1) AS pct
  FROM member m
 GROUP BY m.type
 ORDER BY chains DESC, m.type
 LIMIT 20;
```

### residue.sql

The types nothing that starts at an entry point mentions, with the revisions of their file. Parameters: :inventory — the saved rows of entry-points.sql, :activity — step 3's joined hotspot report for every file, or {"rows":[]}.

```sql
WITH RECURSIVE
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
operation AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TInvocable'),
climb(ref, at) AS (          -- from each entity up to the nearest type around it
  SELECT id, id FROM entity
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS MATERIALIZED (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NULL
      OR e.trait_set_id IN (SELECT trait_set_id FROM types)),
uses(a, b) AS MATERIALIZED ( -- type a mentions type b: any edge, any provenance
  SELECT f.type, t.type FROM edge x
    JOIN owner f ON f.ref = x.from_id JOIN owner t ON t.ref = x.to_id
  UNION
  SELECT f.type, t.type FROM edge_candidate c JOIN edge x ON x.id = c.edge_id
    JOIN owner f ON f.ref = x.from_id JOIN owner t ON t.ref = c.candidate_id
  UNION                      -- the declared type of a field or a parameter
  SELECT f.type, t.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.declared_type_id
  UNION                      -- a part written elsewhere and the type it belongs to, both ways
  SELECT f.type, t.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.attached_to_id
  UNION
  SELECT t.type, f.type FROM entity e
    JOIN owner f ON f.ref = e.id JOIN owner t ON t.ref = e.attached_to_id
  UNION                      -- a type and a type written inside it, both ways
  SELECT p.id, e.id FROM entity e JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)
     AND p.trait_set_id IN (SELECT trait_set_id FROM types)
  UNION
  SELECT e.id, p.id FROM entity e JOIN entity p ON p.id = e.parent_id
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)
     AND p.trait_set_id IN (SELECT trait_set_id FROM types)),
classified(id) AS MATERIALIZED (   -- the inventory's rows that have a stimulus
  SELECT json_extract(r.value, '$[0]')
    FROM json_each(:inventory, '$.rows') r
   WHERE json_extract(r.value, '$[4]') IS NOT NULL),
touched(type) AS (           -- from the classified entry points, through every mention
  SELECT o.type
    FROM node n JOIN owner o ON o.ref = n.ref
   WHERE n.id IN (SELECT id FROM classified)
  UNION
  SELECT u.b FROM touched t JOIN uses u ON u.a = t.type),
activity(file, revisions) AS MATERIALIZED (
  SELECT json_extract(h.value, '$.model'), json_extract(h.value, '$.revisions')
    FROM json_each(:activity, '$.rows') h)
SELECT n.id AS type, n.kind, f.path AS file,
       (SELECT em.value FROM entity_metric em
         WHERE em.entity_id = n.ref AND em.key = 'sloc') AS sloc,
       -- no history given: not measured, which is not zero
       CASE WHEN (SELECT count(*) FROM activity) = 0 THEN NULL
            ELSE coalesce(a.revisions, 0) END AS revisions
  FROM node n
  JOIN entity e ON e.id = n.ref
  LEFT JOIN file f     ON f.id = e.anchor_file_id
  LEFT JOIN activity a ON a.file = f.path
 WHERE NOT n.is_stub
   AND n.ref NOT IN (SELECT type FROM touched)
   -- a type; or, where functions are written straight in a file, that file
   AND (n.trait_set_id IN (SELECT trait_set_id FROM types)
        OR (e.parent_id IS NULL
            AND EXISTS (SELECT 1 FROM entity c
                         WHERE c.parent_id = n.ref AND c.is_stub IS NOT 1
                           AND c.trait_set_id IN (SELECT trait_set_id FROM operation)
                           AND c.trait_set_id NOT IN (SELECT trait_set_id FROM types))))
 ORDER BY revisions DESC, sloc DESC, type;
```

## Related

- [Colour a Spring codebase by role](/docs/how-to/spring-roles/)
- [Exploring a model in the navigator](/docs/tutorials/navigator/)
- [Query model.db](/docs/how-to/query-model-db/)
- [Provenance](/docs/reference/metamodel/provenance/) for what `declared` and `dynamic-candidate` mean
