---
title: "5 · Meaning"
linkTitle: 5 · Meaning
weight: 5
---

**The question.** What does each unit do, in domain words? Is it business
logic, application logic or infrastructure? Which concepts belong to each?

Steps 1 to 4 say what the code *is* and what it *touches*. None of them says
what it is *for*. That needs reading, and on a codebase of tens of thousands
of methods nobody reads everything. `explain` reads it for you: it hands each
method, then each type, then each module to an inexpensive language model,
bottom-up, so every unit is explained *after* the things it depends on, and
writes one structured record per unit into a side-car file beside the model.
Meaning is the one step that costs money, and this page is mostly about
spending it well.

**Before you start:** `app.jsonl`, the source tree its anchors point into, and
an API key on [OpenRouter](https://openrouter.ai) or a Cloudflare AI Gateway.
No key is needed until the last section.

## Why bottom-up, and why it matters to you

A method is explained with the explanations of the methods it calls already
in its prompt, not the model's guess about them. A type is explained from its
methods' records; a module from its types'. Two consequences you will feel:

- **The explanations are consistent.** The name a concept gets in a leaf is
  the name its containers see.
- **A re-run redoes only what changed.** Every record carries a fingerprint
  of what it was computed from, including its dependencies' fingerprints.
  Change one method's source and exactly its dependents are re-explained.
  Running `explain` on Monday and again on Friday costs the week's changes,
  not the codebase.

Getters, setters, `equals`/`hashCode`/`toString` and field-assigning
constructors are described from facts alone, with no call and confidence 1.
On a typical corpus that is a noticeable share of the units.

## See the plan and the price first

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java --dry-run
```

```text
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~70459 prompt tokens
  type          17 units     17 calls ~28078 prompt tokens
  module         3 units      3 calls ~4249 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  total: 68 calls, ~102786 prompt tokens in, ~36650 completion tokens out
```

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java \
  --estimate --price-in 0.10 --price-out 0.60
```

```text
  cost at $0.1/M in, $0.6/M out: $0.0323
```

Prices are dollars per million tokens for the model you intend to use; the
figure is a floor (retries are not in it). Three cents for the reference
fixture; a few dollars for a mid-sized service with a cheap model; tens of
dollars for a very large codebase. Neither command makes a call or needs a
key, so run them before every real run.

## Scope it by what the earlier steps ranked

Do not explain everything on a first visit. Step 3 gave you hotspots; step 4
gave you the chains through them. `--scope` takes module or type ids and
explains only what is inside, reusing any dependency that already has a
record and never calling for one that does not:

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java \
  --scope java:com.acme.order,java:com.acme.order.adapter --estimate
```

`--max-calls N` is the other bound: it stops planning after N calls and
always runs a dependency-consistent prefix, never a half-explained unit whose
callees were skipped. Combine them: scope to the top hotspot module,
estimate, run, read the result, and decide whether the rest of the corpus is
worth paying for.

## Run it

```bash
export OPENROUTER_API_KEY=…
codegraph explain app.jsonl --src ~/src/app/src/main/java \
  --scope java:com.acme.order \
  --model a/cheap-model --rollup-model a/stronger-model
```

`--model` explains the many leaves (operations); `--rollup-model` the few
types and modules, which need synthesis. A cheap model for the first and a
stronger one for the second is the intended split. `--framework spring`
adds the roles and entry points from step 2 to the facts each prompt sees,
so the model decides "controller" from an annotation, not from a name.

Records land in `app.insights.jsonl` beside the model, never inside it. An
interrupted run resumes where it stopped. [Estimate, cap and scope an explain
run](/docs/how-to/explain-cost/) covers providers, rate limits and `--force`.

## Read the side-car

One record per unit, in the vocabulary of the Specy domain metamodel. The
fields that answer this step's question, with `jq`:

The modules, and what the model thinks each one is for:

```bash
jq -r 'select(.t == "i" and .level == "module")
       | "\(.id)\t\(.block.name)\t\(.block.boundedContextHint.name // "-")\t\(.block.confidence)"' \
   app.insights.jsonl
```

Every type with its concept, which is where **domain and technical logic
separate**:

```bash
jq -r 'select(.t == "i" and .level == "type")
       | "\(.block.concept)\t\(.id)\t\(.block.name)"' app.insights.jsonl | sort
```

`concept` is one of a closed list: `entity`, `aggregate`, `valueType`,
`event`, `repository`, `domainService`, `applicationService`,
`infrastructureService`, `notDomain`, `unknown` and a few more. Read the
sorted list in three groups:

| `concept` | What it is | Belongs to |
|---|---|---|
| `entity`, `aggregate`, `valueType`, `enum`, `event`, `domainService`, `invariant`, `stateMachine` | the business, said in its own words | the **domain** |
| `applicationService`, `command`, `query`, `reaction`, `interface` (API or SPI) | the use cases and the doors | the **application** layer |
| `repository`, `infrastructureService`, `notDomain` | persistence, transport, framework glue | **infrastructure** |
| `unknown` | the model could not decide from the code | read it yourself |

The operations, with who owns them and which outside capabilities they need:

```bash
jq -r 'select(.t == "i" and .level == "operation")
       | "\(.block.owner)\t\(.id)\t\(.block.handlesCommand // "-")\t\(.block.usesSpi | map(.name) | join(","))"' \
   app.insights.jsonl | sort
```

`handlesCommand` names the command an operation handles when it is an entry
point from step 4; `emits` lists the events it raises and their kind
(`internal`, `external`, `error`, `temporal`); `preconditions` are the checks
it makes, each with the reason a violation is refused; `usesSpi` names the
ports it needs (a clock, a ledger, a store). Together, that is the operation
described as a domain expert would.

Two fields to respect on every record. **`confidence`** is the model's own
estimate, and the prompt tells it to lower it when the code does not let it
decide; sort by it ascending to find what needs a human. **`origin`** is
`llm` or `template`; templated records are facts, not opinions.

## Separate technical from domain logic

You now have three independent readings of the same question, and they
should agree:

- the **concept** each type got in the side-car (this step);
- the **framework role** from the annotations (step 2): a `@Repository` that
  the model calls an `aggregate` is a disagreement worth a look;
- the **position in the chains** (step 4): the first corpus type after an
  entry point is a driving adapter or an application service; the last
  before an exit point is an infrastructure adapter; what sits between and
  references no framework stub is the domain.

Where the three agree, you have a classification you can defend. Where they
disagree, you have a finding, and usually a smell: an entity that talks to
the database, a service that is really a data carrier, a controller with
business rules in it.

## Write down

- Per module: its one-line purpose and its bounded-context hint.
- Per type in the hotspot chains: its concept, and whether the three
  readings agree.
- The `unknown` and low-confidence records: the reading list for a human.
- The ubiquitous language the module records propose (`ubiquitousLanguage`):
  the glossary of the business, extracted from the code.

Next: [Domain](/docs/discover/domain/).

## Related

- [Explaining a package with a language model](/docs/tutorials/explain/)
- [Estimate, cap and scope an explain run](/docs/how-to/explain-cost/)
- [`insights.jsonl` reference](/docs/reference/artifacts/insights-jsonl/), with every block field and vocabulary
- [Explaining bottom-up](/docs/explanation/explaining-bottom-up/)
