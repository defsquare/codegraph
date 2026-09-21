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

**Before you start:** `app.db` with the helper views from step 1, and the
annotation census from step 2.

{{< callout type="warning" >}}
This is the least finished step. What exists today: a Spring entry-point
reading, a generic query for methods nothing in the corpus calls, and a
recursive query that walks a call chain. What does not exist yet: a
framework-aware inventory that classifies every stimulus by kind, and a
one-command forward slice per entry point. The page gives you the pieces
and says which part you assemble by hand.
{{< /callout >}}

## Inventory the entry points

Three detection layers, strongest first. Use all three and merge.

**1. Framework annotations.** For Spring, codegraph already recognises them:

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

The entry points are the web mappings, the event listeners, the scheduled
methods and the beans the container calls. For any framework, Spring
included, the annotation query from step 2 does the same with a name list
you choose. A starting list, by the kind of stimulus:

| Stimulus | What it is, in domain words | Annotations and interfaces to look for |
|---|---|---|
| inbound command | a request to change something | `PostMapping`, `PutMapping`, `DeleteMapping`, `[HttpPost]`, `CommandHandler`, a CLI verb |
| inbound query | a request to read something | `GetMapping`, `[HttpGet]`, GraphQL resolvers, `QueryHandler` |
| external event | something happened elsewhere | `KafkaListener`, `JmsListener`, `RabbitListener`, `SqsListener`, a webhook route |
| internal event | something happened here, and something else reacts | `EventListener`, `TransactionalEventListener`, `EventHandler` |
| temporal | time passed | `Scheduled`, Quartz `Job`, `TimerTask`, JobRunr |
| lifecycle | the process starts or stops (technical, not domain) | `main`, `ApplicationRunner`, `CommandLineRunner`, `PostConstruct` |
| framework callback | plumbing the framework calls (usually not domain) | `Filter`, `Interceptor`, `Converter`, `HealthIndicator` |

```sql
SELECT n.id AS entry_point, a.name AS annotation, x.arguments
  FROM edge x
  JOIN edge_kind ek ON ek.id = x.kind_id
  JOIN entity a     ON a.id  = x.to_id
  JOIN node n       ON n.ref = x.from_id
 WHERE ek.name = 'annotationUse'
   AND a.name IN ('GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping',
                  'KafkaListener', 'JmsListener', 'RabbitListener',
                  'EventListener', 'Scheduled')
 ORDER BY a.name, n.id;
```

**2. Interfaces the framework calls.** A class implementing `Runnable`,
`Job`, `MessageListener` or `CommandLineRunner` is an entry point with no
annotation on it. The `interfaceImplementation` edges to a stub say so:

```sql
SELECT n.id AS implementation, t.id AS framework_interface
  FROM dep d
  JOIN node n ON n.ref = d.from_ref
  JOIN node t ON t.ref = d.to_ref
 WHERE d.kind = 'interfaceImplementation' AND t.is_stub = 1
 ORDER BY t.id, n.id;
```

Read the list and keep the interfaces that mean "called from outside".

**3. Methods nothing in the corpus calls.** The structural fallback, which
needs no framework knowledge at all. A method with no incoming invocation is
one of four things: an entry point the tables above missed, a reflection
target, dead code, or library API offered to others. Rank by fan-out so the
ones that *do* something come first:

```sql
SELECT n.id, count(d.ref) AS fan_out
  FROM node n
  LEFT JOIN dep d ON d.from_ref = n.ref AND d.kind = 'invocation'
 WHERE n.kind = 'method' AND n.is_stub IS NOT 1
   AND NOT EXISTS (SELECT 1 FROM dep i
                    WHERE i.to_ref = n.ref AND i.kind = 'invocation')
 GROUP BY n.ref ORDER BY fan_out DESC, n.id
 LIMIT 50;
```

| id | fan_out |
|---|---|
| `java:com.acme.order/OrderService.bill(com.acme.order.Order)` | 3 |
| `java:com.acme.order/Reporting.join(java.lang.String[])` | 3 |
| `java:com.acme.order/Basket.add(com.acme.order.Basket.Line)` | 2 |

Step 3 separates two of the four cases: dead code is stable (no revisions),
an entry point is worked on. The model does not carry visibility modifiers
today, so `private` helpers reached only through a lambda can appear here;
they are recognisable by their name and their small fan-out.

## Walk what each stimulus reaches

From an entry point, follow the invocation and access edges forward. The
reachable set is everything that *can* run when the stimulus fires. SQLite
does this with a recursive query; paste the entry point's id on the first
line:

```sql
WITH RECURSIVE reach(ref, depth) AS (
  SELECT ref, 0 FROM node WHERE id = 'java:com.acme.order/Order.discount(int)'
  UNION
  SELECT d.to_ref, r.depth + 1
    FROM reach r JOIN dep d ON d.from_ref = r.ref
   WHERE d.kind IN ('invocation', 'access')
     AND d.provenance = 'declared'
     AND r.depth < 20)
SELECT n.id, n.is_stub AS external, min(r.depth) AS depth
  FROM reach r JOIN node n ON n.ref = r.ref
 GROUP BY n.ref ORDER BY depth, n.id;
```

| id | external | depth |
|---|---|---|
| `java:com.acme.order/Order.discount(int)` | 0 | 0 |
| `java:com.acme.order/AbstractOrder.total` | 0 | 1 |
| `java:com.acme.order/Money.times(int)` | 0 | 1 |
| `java:com.megacorp.ledger/LedgerClient` | 1 | 1 |
| `java:com.acme.order/Money.<init>(long)` | 0 | 2 |

**How to read it.** The rows with `external = 1` are the **exit points**: the
stubs the chain ends in. A database driver, an HTTP client, a message
producer, a clock. An entry point and its exit points are one end-to-end
flow: in domain words, a command, the operations it triggers and the outside
capabilities it needs. Write the chain down as a list of types in depth
order; that list is the reading order for the use case.

Run it twice. With `d.provenance = 'declared'` you get the **facts-only lower
bound**. Remove that line and you add the `dynamic-candidate` edges (the
Spring wiring from `--report wiring`, for instance): the plausible upper
bound. A chain that doubles between the two runs goes through an interface
whose implementation is chosen at runtime, and a reader must know which one.

For a chain you want to *see* rather than list, the navigator does the same
walk by hand: open the entry point in the **Navigate** tab of
`codegraph serve`, and each row under fan-out opens the next hop with its
source line. Five hops in, you have read the use case.

## What the slices give you

Once you have a chain per entry point, three cheap observations follow:

- **Use cases, grouped.** Entry points whose chains overlap heavily belong
  to the same feature; groups with little overlap are candidate bounded
  contexts. Types present in almost every chain are the shared kernel or the
  cross-cutting plumbing, and step 5 will say which.
- **The residue.** Everything no chain reaches. Stable residue (step 3: no
  revisions) is deletion material. Actively changed residue is a detection
  gap: reflection, a framework the name lists do not know. Report it as a
  gap, not as dead code.
- **Which chain to read first.** Rank the chains by how many step 3 hotspots
  they pass through. The chain through the biggest, most-changed, most-tangled
  code is the one to read first, and the one to explain first in step 5.

## Write down

- The entry-point inventory, grouped by kind, each with its module and the
  evidence it was found by (annotation, interface, zero callers).
- For the top chains: the list of types in depth order and the exit points.
- The residue, split into stable and active.

Next: [Meaning](/docs/discover/meaning/).

## Related

- [Colour a Spring codebase by role](/docs/how-to/spring-roles/)
- [Exploring a model in the navigator](/docs/tutorials/navigator/)
- [Query model.db](/docs/how-to/query-model-db/)
- [Provenance](/docs/reference/metamodel/provenance/) for what `declared` and `dynamic-candidate` mean
