---
title: "6 · Domain"
linkTitle: 6 · Domain
weight: 6
---

**The question.** Which part of this codebase is the domain, its structure
and its behaviour, clearly separated from the technical concerns (application
and infrastructure, through the hexagonal lens)? And what is the domain model
underlying the code, stated in a structured domain-driven metamodel?

Step 5 gave one explanation per unit. This step assembles them into one
**model of the business**: bounded contexts, aggregates, entities, value
types, commands, events, invariants, in the vocabulary of Domain-Driven
Design as formalised by the Specy `.domain` metamodel. The result is the
document a domain expert can read and correct, and the one a rewrite or a
migration starts from.

**Before you start:** `app.jsonl`, the records of step 5 (for the hotspot
scope at least: without them the extraction reads the source alone, and sees
what it samples), step 4's saved chains, the source tree, and Claude Code with
the [Specy](https://specy.ai) plugin installed, which provides the extraction
skill. The first two sections need codegraph only.

## Gather the facts, pre-joined

The skill works from evidence, and codegraph writes the evidence out in one
file, one dossier per type: annotations with their written arguments, fields
joined to their declared types, operations with their invocations, accesses
and throw sites, supertypes, and the framework roles and injection candidates
when you pass a framework:

```bash
codegraph domain-facts app.jsonl --framework spring --out app-facts.json
```

```text
wrote 100949 bytes to app-facts.json (domain facts, view all, 19 type dossiers, 58 operations).
```

Three parts of a dossier matter most here. **Fields and their declared
types** are the structure. **Throw sites** guarding writes are where
invariants live in code that has no DDD vocabulary at all. An **enum-typed
field read and written by the type's own operations** is a state machine
waiting to be named.

## Apply the hexagonal lens, structurally

Before asking anyone, human or model, three measures computed from the graph
answer most of "is this domain or plumbing". Each is a query file run with
[`codegraph query`](/docs/reference/cli/query/); the statements are at
[the end of this page](#the-statements).

**Purity.** The share of a module's outgoing references that target the
code's own types rather than framework or library stubs. The standard
library is left out, since a `String` says nothing about architecture; `:stdlib`
names it, from the table of [step 5](/docs/discover/meaning/#separate-technical-from-domain-logic):

```bash
codegraph query app.jsonl --file purity.sql --param stdlib='["java.*"]'
```

| module | refs | external | purity_pct |
|---|---|---|---|
| `com.acme.order.legacy` | 6 | 0 | 100.0 |
| `com.acme.order` | 111 | 11 | 90.1 |
| `com.acme.order.adapter` | 5 | 4 | 20.0 |

A pure module is the domain candidate. A module whose references are mostly
stubs is plumbing: `adapter` above lives up to its name. The mixed ones are
where the application services sit. Every annotation is a library
reference, so annotated code reads low everywhere: compare the modules with
each other, never with a fixed share. Name the standard library of the
language at hand: with Java's in place of C#'s, the C# fixture's
`Acme.Order` reads 53.1 % pure, every `System` type counted as a library;
with its own, 95.1 %.

**Position in the chains.** The query of step 5, `chain-position.sql`, over
step 4's saved chains: a type where chains start is the driving side, a type
at their edge reaches a library itself, a type inside them reaches none. What
sits inside and is pure is the domain.

**Invariant evidence.** Where a type's rules leave marks in the code: its
operations that write its own fields, its throw sites, the operations that do
both, and the enum-typed fields it drives:

```bash
codegraph query app.jsonl --file invariant-evidence.sql
```

| type | operations | writes | throws | guarded | state |
|---|---|---|---|---|---|
| `java:com.acme.order/Order` | 4 | 1 | 0 | 0 | channel |
| `java:com.acme.order/StockGuard` | 3 | 0 | 1 | 0 | NULL |
| `java:com.acme.order.legacy/List` | 3 | 1 | 0 | 0 | NULL |
| `java:com.acme.order/AbstractOrder` | 3 | 1 | 0 | 0 | NULL |

`guarded` counts the operations that write the type's own fields and throw,
the shape of a rule enforced where the state changes; `state` lists the
fields whose type is an enum of the code that the type itself writes.
`throws` alone is a guard clause somewhere. Where these cluster is where the
business rules are, whatever the classes are called. A guard written as a
library call (Spring's `Assert.notNull`) is a call, not a throw site: this
query does not see it, and the type shows at the edge of its chains instead.
The preconditions step 5's records name, each with its reason, are the other
half of this evidence. A language with no enum kind (Elixir, Ruby) has no
`state`.

Write the three down per module, and per type in the hotspot chains. They are
the prior the extraction starts from, and the corroboration for what the
model proposed in step 5. Where the three agree on a module, the verdict is
theirs. Where they do not, the module is undecided: say which measure points
where, and ask whoever knows the code.

## Extract the domain model

In Claude Code, with the Specy plugin, in the repository:

```text
/specy:domain-extract-from-code
```

Point it at the source root, and give it `app-facts.json` and
`app.insights.jsonl` as inputs. The skill applies four decision tests, in
order, before it emits any element, and this is why its output can be
trusted more than a summary:

1. **Is it real?** A line of production or test code evidences it. A
   concept no anchor supports is not emitted.
2. **Is it domain?** Would it survive a stack swap? A JPA annotation would
   not; a rule that an order cannot ship unpaid would.
3. **Is it faithful?** Does the expression in the model match the condition
   in the code, not a nicer version of it?
4. **Is it the right construct?** An entity, a value type, an aggregate, an
   event, a service, chosen from the evidence and not from the class name.

It writes three files:

- **`<name>.domain`**: the model, in the Specy grammar: bounded contexts,
  modules, entities and aggregates with their identity, fields and
  invariants, value types, enums, commands, queries, events of the four
  kinds, operations with pre- and postconditions, reactions, repositories
  and the three service kinds.
- **a refactoring report**: the design smells the extraction found, such as
  anemic entities, god entities, missing aggregates, missing state machines,
  transaction scripts, orphan events, missing invariants, weak aggregate
  boundaries.
- **`<name>.meta.json`**: the anchors and the gaps, what the grammar could
  not express.

Then validate the model with the Specy command line, where it is installed:
`specy validate <name>.domain`. A file that validates is well-formed, not
right: the model is an inference until a domain expert confirms it.

From the `.domain`, the sibling skills go further: `sysreq-extract-from-code`
derives testable requirements in EARS form; `domain-refactor` redesigns the
extracted model into a proper one and explains each change; `domain-dialogue`
lets you interrogate the model in conversation.

{{< callout type="info" >}}
The skill reads the step 5 records before the source when it finds them, and
opens a file only to confirm a record or to write an exact expression: on a
large codebase that is what keeps anything from falling between the cracks.
Where it looks depends on its version. One that knows this walk reads its
workspace first, `.codegraph/discovery.json` and the models, records and
dossiers beside it, and takes from it the excluded paths, the names a person
gave and the hotspot ranks. An older one looks under `specy/codegraph/`: give
it the side-car and the dossiers by path, those three in words, and ask it to
cite `concept`, `owner` and `boundedContextHint` from the records. Where the
records and the skill disagree, the disagreement is the finding.
{{< /callout >}}

## Weigh the result by the hotspots

The refactoring report is static: a smell is a smell wherever it sits. Give
each one the rank of the code it lives in, from step 3. An anemic entity
nobody has touched in three years is a note. The same smell in the top
hotspot is the first refactoring, and it is the kind that pays for itself
within the quarter. This is what keeps the report short enough to act on.

## The context map

The module records of step 5 carry a `boundedContextHint`; step 4 grouped
entry points by the overlap of their chains; step 3 measured which modules
co-change. A group of modules that cluster by chain, change together and
share a vocabulary is one bounded context. Two "contexts" joined by a
dependency cycle from step 1 are not two contexts. Draw the map from those
three sources, and mark each boundary with the evidence it rests on.

## Write down

- Per module, the hexagonal verdict (domain, application, infrastructure)
  and the three measures behind it.
- The `.domain` file, and the elements of it a domain expert should confirm
  first: the aggregates, their invariants, the events.
- The refactoring report, weighted by hotspot rank, cut to what is worth
  doing this quarter.
- The context map.

That is the end of the walk. What you have is not a grade, and no single
number was produced on purpose: a ranked list of places to read, a map of
how the code is cut and where the cut fails, an inventory of what the system
reacts to, an explanation of every unit that mattered, and a model of the
business in its own words. Everything in it links to a file and a line at a
commit, so anyone can disagree with a conclusion and still hold the
evidence.

## The statements

A type is asked for by its trait (`TType`), an operation by `TInvocable`,
never by a list of kinds, so the same text runs on every language.

### purity.sql

Per module of the code, the share of its references that land on the code rather than on a library, the standard library left out. Parameters: :stdlib — the standard library's modules, a JSON list of GLOB patterns (the page's table).

```sql
WITH std(pattern) AS MATERIALIZED (
  SELECT value FROM json_each(:stdlib))
SELECT m.symbol AS module,
       count(*) AS refs,
       sum(t.is_stub) AS external,
       round(100.0 * (count(*) - sum(t.is_stub)) / count(*), 1) AS purity_pct
  FROM dep d
  JOIN node f    ON f.ref = d.from_ref
  JOIN entity m  ON m.id  = f.module_ref
  JOIN node t    ON t.ref = d.to_ref
  JOIN entity tm ON tm.id = t.module_ref
 WHERE f.is_stub IS NOT 1
   AND NOT EXISTS (SELECT 1 FROM std s WHERE tm.symbol GLOB s.pattern)
 GROUP BY m.id ORDER BY purity_pct DESC, refs DESC, module;
```

### invariant-evidence.sql

Per type of the code, where its rules leave evidence: operations that write its own fields, throw sites, both in one operation, and the enum-typed fields it drives. Parameters: none.

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
climb(ref, at) AS (          -- every entity of the code, up to the nearest type around it
  SELECT e.id, e.id FROM entity e WHERE e.is_stub IS NOT 1
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
owner(ref, type) AS MATERIALIZED (
  SELECT c.ref, c.at FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)),
own_write(op, field) AS MATERIALIZED (   -- a write to a field of the operation's own type
  SELECT x.from_id, x.to_id
    FROM edge x
    JOIN edge_kind k ON k.id = x.kind_id
    JOIN owner o ON o.ref = x.from_id
    JOIN owner f ON f.ref = x.to_id
   WHERE k.name = 'access' AND x.is_write = 1 AND o.type = f.type AND x.from_id <> o.type),
thrower(op) AS MATERIALIZED (
  SELECT DISTINCT from_ref FROM dep WHERE kind = 'throws'),
state(type, field) AS (      -- a field typed by an enum of the code, written by its own type
  SELECT DISTINCT o.type, fe.name
    FROM own_write w
    JOIN owner o   ON o.ref = w.op
    JOIN entity fe ON fe.id = w.field
    JOIN entity dt ON dt.id = fe.declared_type_id
    JOIN kind dk   ON dk.id = dt.kind_id
   WHERE dk.name = 'enum' AND dt.is_stub IS NOT 1),
ops(type, op, writes, throws) AS (
  SELECT o.type, o.ref,
         o.ref IN (SELECT op FROM own_write),
         o.ref IN (SELECT op FROM thrower)
    FROM owner o JOIN entity e ON e.id = o.ref
   WHERE e.trait_set_id IN (SELECT trait_set_id FROM operation)),
counted(type, operations, writes, throws, guarded) AS (
  SELECT type, count(*), sum(writes), sum(throws), sum(writes AND throws)
    FROM ops GROUP BY type),
fields(type, list) AS (
  SELECT type, group_concat(field, ', ')
    FROM (SELECT type, field FROM state ORDER BY type, field)
   GROUP BY type)
SELECT n.id AS type,
       c.operations, c.writes, c.throws, c.guarded,
       s.list AS state
  FROM counted c
  JOIN node n ON n.ref = c.type
  LEFT JOIN fields s ON s.type = c.type
 WHERE c.writes > 0 OR c.throws > 0
 ORDER BY c.guarded DESC, s.list IS NULL, c.throws DESC, c.writes DESC, n.id;
```

## Related

- [`codegraph domain-facts`](/docs/reference/cli/domain-facts/) and the
  [domain-facts.json artifact](/docs/reference/artifacts/domain-facts/)
- [`insights.jsonl` reference](/docs/reference/artifacts/insights-jsonl/)
- [Facts and inferences never mix](/docs/explanation/facts-vs-inferences/)
- [Prior art](/docs/explanation/prior-art/)
