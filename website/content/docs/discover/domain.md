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

**Before you start:** `app.jsonl`, `app.insights.jsonl` from step 5 (for the
hotspot scope at least), the source tree, and Claude Code with the Specy
plugin installed, which provides the extraction skill.

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
wrote 100827 bytes to app-facts.json (domain facts, view all, 19 type dossiers, 58 operations).
```

Three parts of a dossier matter most here. **Fields and their declared
types** are the structure. **Throw sites** guarding writes are where
invariants live in code that has no DDD vocabulary at all. An **enum-typed
field read and written by the type's own operations** is a state machine
waiting to be named.

## Apply the hexagonal lens, structurally

Before asking anyone, human or model, three measures computed from the graph
answer most of "is this domain or plumbing":

**Purity.** The share of a module's outgoing references that target corpus
types rather than framework or library stubs. The standard library is
excluded, since a `String` says nothing about architecture:

```sql
SELECT m.symbol AS module,
       count(*) AS refs,
       sum(t.is_stub) AS external,
       round(100.0 * (count(*) - sum(t.is_stub)) / count(*), 1) AS purity_pct
  FROM dep d
  JOIN node f    ON f.ref = d.from_ref
  JOIN entity m  ON m.id  = f.module_ref
  JOIN node t    ON t.ref = d.to_ref
  JOIN entity tm ON tm.id = t.module_ref
 WHERE f.is_stub IS NOT 1 AND tm.symbol NOT LIKE 'java.%'
 GROUP BY m.symbol ORDER BY purity_pct DESC;
```

| module | refs | external | purity_pct |
|---|---|---|---|
| `com.acme.order.legacy` | 6 | 0 | 100.0 |
| `com.acme.order` | 111 | 11 | 90.1 |
| `com.acme.order.adapter` | 5 | 4 | 20.0 |

A pure module is the domain candidate. A module whose references are mostly
stubs is plumbing: `adapter` above lives up to its name. The mixed ones are
where the application services sit. (The `NOT LIKE 'java.%'` is a stated
heuristic for this one query; codegraph itself never decides membership by
name prefix, and neither should a conclusion you keep.)

**Position in the chains.** From step 4: the first corpus type after an entry
point is a driving adapter or an application service; the last before an
exit point is an infrastructure adapter; what sits between and is pure is
the domain.

**Invariant evidence.** From the dossiers: operations with throw sites that
guard a write to the type's own fields, preconditions with a reason, an
enum-typed status the type itself drives. Where these cluster is where the
business rules are, whatever the classes are called.

Write the three down per type in the hotspot chains. They are the prior the
extraction starts from, and the corroboration for what the model proposed in
step 5.

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

From the `.domain`, the sibling skills go further: `sysreq-extract-from-code`
derives testable requirements in EARS form; `domain-refactor` redesigns the
extracted model into a proper one and explains each change; `domain-dialogue`
lets you interrogate the model in conversation.

{{< callout type="info" >}}
Today the skill reads the source and the dossiers. Reading the step 5
side-car as its primary evidence, with the source as corroboration, is the
planned change, and it matters: without it, a skill on a large codebase sees
what it samples, and the point of explaining every unit bottom-up first is
that nothing falls between the cracks. Until then, give it the side-car
explicitly and ask it to cite `concept`, `owner` and `boundedContextHint`
from the records. Where the side-car and the skill disagree, the
disagreement is the finding.
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

## Related

- [`codegraph domain-facts`](/docs/reference/cli/domain-facts/) and the
  [domain-facts.json artifact](/docs/reference/artifacts/domain-facts/)
- [`insights.jsonl` reference](/docs/reference/artifacts/insights-jsonl/)
- [Facts and inferences never mix](/docs/explanation/facts-vs-inferences/)
- [Prior art](/docs/explanation/prior-art/)
