---
title: "5 · Meaning"
linkTitle: 5 · Meaning
weight: 5
---

> **In Claude Code**, `/codegraph:discover-5-meaning <path>` runs this step with you: the commands below, a few rows at a time, written to a workspace that resumes. See [Walk a codebase with Claude Code](/docs/how-to/discover-with-claude-code/).

**The question.** What does each unit do, in domain words? Is it business
logic, application logic or infrastructure? Which concepts belong to each?

Steps 1 to 4 say what the code *is* and what it *touches*. None of them says
what it is *for*. That needs reading, and on a codebase of tens of thousands
of methods nobody reads everything. `explain` reads it for you: it hands each
method, then each type, then each module to a language model, bottom-up, so
every unit is explained *after* the things it depends on, and writes one
structured record per unit into a store beside the model. Meaning is the one
step that costs money and sends source code to a model provider, and this
page is mostly about spending it well.

**Before you start:** `app.jsonl`, the source tree its anchors point into, and
a model provider: an API key on [OpenRouter](https://openrouter.ai) or a
Cloudflare AI Gateway, or Claude Code installed and logged in
(`--provider claude-code`: no key, the calls count against your Claude plan).
Nothing below needs a provider until [Run it](#run-it).

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

What a record was computed from is more than the source: the facts its prompt
showed, the measures among them, and the model and depth that explained it.
So a record is reused only by a run with **the same models and depth**, on a
model **measured the same way**, by a codegraph that **asks the same words**
(a release that changes the words a prompt asks to define plans again the
units whose words it changed, and what depends on them). `codegraph insights app.jsonl` names the
models and depth a store was written with; plan with those, or every unit is
planned again. The metrics pass ([step 1](/docs/discover/structure/)) adds
fourteen measures to every unit it measures: a store written before the pass
is planned again after it. On Spring PetClinic, the same code and the same
store plan 53 calls on a model without the pass's measures and 90 on the same
model with them.

Getters, setters, `equals`/`hashCode`/`toString` and field-assigning
constructors are described from facts alone, with no call and confidence 1.
On a typical corpus that is a noticeable share of the units.

## See the plan and the price first

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java --dry-run
```

```text
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~78146 prompt tokens
  type          17 units     17 calls ~31000 prompt tokens
  module         3 units      3 calls ~4990 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 68 calls, ~114136 prompt tokens in, ~52415 completion tokens out
```

`llm` is a unit that would be sent to the model, `template` one described
from facts, `reuse` one whose record still matches. After the summary, one
line per unit with its status. A unit planned `llm` that already has a record
is one whose inputs moved since: until a run replaces it, its record explains
the code as it was, and is read as such. Then the volume, and with two
prices, the cost:

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java \
  --estimate --price-in 0.10 --price-out 0.60
```

```text
  cost at $0.1/M in, $0.6/M out: $0.0429
```

Prices are dollars per million tokens for the model you intend to use, read
from the provider's price list or given by whoever pays, the day you run it:
never remembered from another run. The figure is a floor (retries are not in
it). Four cents for the reference fixture; a few dollars for a mid-sized
service with a cheap model; tens of dollars for a very large codebase. Claude
Code is billed by the Claude plan, not per call: there the estimate is the
calls and the tokens they count against the plan.

Give both commands the `--provider` the run will use. Claude Code adds its own
instructions to every prompt and the estimate counts them, so the plan of one
provider is not the plan of another. Neither command makes a call or needs a
key: run them before every real run.

## Scope it by what the earlier steps ranked

Do not explain everything on a first visit. Step 3 gave you hotspots; step 4
gave you the chains through them. `--scope` takes module or type ids and
explains only what is inside, reusing any dependency that already has a
record and never calling for one that does not:

```bash
codegraph explain app.jsonl --src ~/src/app/src/main/java \
  --scope java:com.acme.order,java:com.acme.order.adapter --estimate
```

A good first scope is the module that holds the chain to read first (step 4)
and most of the hotspot shortlist (step 3). A module's purpose and its
glossary are explained from all of its types, so a scope of types alone gives
no module record: those types are the cheaper option, without the module's
words. On Spring PetClinic, with no record yet, the `owner` module plans 55
calls and the nine types of its chain and shortlist 50. `--max-calls N` is the
other bound: it stops planning after N calls and always runs a
dependency-consistent prefix, never a half-explained unit whose callees were
skipped. Combine them: scope, estimate, run, read the result, and decide
whether the rest of the corpus is worth paying for.

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
so the model decides "controller" from an annotation, not from a name. With
`--provider claude-code` no key is needed; `--model` is then a Claude Code
model name (`sonnet` by default).

A run that makes calls prints its estimate and asks before the first one.
`--yes` answers that question for it, so it belongs on a command line only
once whoever pays has said yes to that scope and that estimate.

Records land in the store `app.insights.db` beside the model, exported to
`app.insights.jsonl` at the end of the run, never inside the model. An
interrupted run resumes where it stopped. `codegraph insights app.jsonl
--runs` says what each run explained, in how many calls, and what it cost.
[Estimate, cap and scope an explain run](/docs/how-to/explain-cost/) covers
providers, rate limits and `--force`.

## Without a run

No provider, no budget, or a "no": the walk goes on. Read the source of three
to five types yourself, the ones at the top of the hotspot shortlist and of
the chain to read first, and give each its concept from the table below, its
purpose in one line and the three readings of the last section. Write it down
as your reading: no record holds it, nothing fingerprints it, and no later run
reuses it. The words of the names are still counted, for free, by
`codegraph vocabulary`.

## Read the records

One record per unit, in the vocabulary of the Specy domain metamodel.
`codegraph insights` reads the store and nothing else: no model, no
provider, no call.

```bash
codegraph insights app.jsonl                        # the summary: records, concepts, models, what they cost
codegraph insights app.jsonl --level module         # each module: its bounded-context hint and its purpose
codegraph insights app.jsonl --level type           # each type: its concept and its description
codegraph insights app.jsonl --max-confidence 0.6   # what the model was least sure of
codegraph insights app.jsonl --concept unknown      # what it could not decide
codegraph insights app.jsonl --id java:com.acme.order/Order   # one record whole
```

Every type has a `concept`, which is where **domain and technical logic
separate**. It is one of a closed list: `entity`, `aggregate`, `valueType`,
`event`, `repository`, `domainService`, `applicationService`,
`infrastructureService`, `notDomain`, `unknown` and a few more. Read the list
of types in three groups:

| `concept` | What it is | Belongs to |
|---|---|---|
| `entity`, `aggregate`, `valueType`, `enum`, `event`, `domainService`, `invariant`, `stateMachine` | the business, said in its own words | the **domain** |
| `applicationService`, `command`, `query`, `reaction`, `interface` (API or SPI) | the use cases and the doors | the **application** layer |
| `repository`, `infrastructureService`, `notDomain` | persistence, transport, framework glue | **infrastructure** |
| `unknown` | the model could not decide from the code | read it yourself |

An operation's record (`--id` on the operation) names its `owner`;
`handlesCommand`, the command it handles when it is an entry point from
step 4; `emits`, the events it raises and their kind (`internal`, `external`,
`error`, `temporal`); `preconditions`, the checks it makes, each with the
reason a violation is refused; `usesSpi`, the ports it needs (a clock, a
ledger, a store). Together, that is the operation described as a domain
expert would.

Two fields to respect on every record. **`confidence`** is the model's own
estimate, and the prompt tells it to lower it when the code does not let it
decide; `--max-confidence` finds what needs a human. **`origin`** is `llm`
or `template`; templated records are facts, not opinions.

The words come last. A module's record carries its `ubiquitousLanguage`, and
its glossary reconciles the words its types spell, flagging as `polysemous` a
word its types use in different senses:

```bash
codegraph insights app.jsonl --glossary java:com.acme.order   # one module's words, each with its sense
codegraph insights app.jsonl --polysemy                       # the words used in more than one sense
codegraph vocabulary app.jsonl --level module                 # the words of the names, counted: no model involved
```

## Separate technical from domain logic

You now have three independent readings of the same question, and they
should agree:

- the **concept** each type got in its record (this step);
- the **framework role** from the annotations (step 2): a `@Repository` that
  the model calls an `aggregate` is a disagreement worth a look;
- the **position in the chains** (step 4): where a chain starts, what it
  passes through, and where it leaves the code.

The position is a query over step 4's saved chains. A type is at the
**edge** of a chain when its own code calls or reads a library, or a library
type is above it (it extends or implements one); the standard library does
not count, since a `String` says nothing about architecture:

```bash
codegraph query app.jsonl --file chain-position.sql --param-file chains=chains.json --param stdlib='["java.*"]'
```

| type | chains | entry | edge | inside |
|---|---|---|---|---|
| `java:com.acme.order/AbstractOrder` | 3 | 0 | 0 | 3 |
| `java:com.acme.order/OrderService` | 3 | 3 | 0 | 0 |
| `java:com.acme.order/Money` | 2 | 0 | 0 | 2 |
| `java:com.acme.order.adapter/LedgerAdapter` | 1 | 1 | 0 | 0 |

`:stdlib` is the language's standard library, as modules of the model:

| Language | `:stdlib` |
|---|---|
| Java | `["java.*"]` |
| C# | `["System","System.*"]` |
| TypeScript | `["<lib>","node:*"]` |
| Elixir | `["<otp>"]` |
| Ruby | `["<ruby>"]` |

These are stated heuristics for this one reading. codegraph never decides
what belongs to the code by a name; it decides only which of the libraries
the code uses is the language's own.

**How to read it.** Each column counts chains. **`entry`**: the chain starts
in this type: the driving side, an adapter or an application service.
**`edge`**: the chain reaches this type and the type reaches a library
itself: where the chain leaves the code, an infrastructure adapter or a type
that leans on a framework. **`inside`**: reached, and reaching no library:
what sits between, the domain candidate. On Spring PetClinic,
`OwnerRepository` is at the edge of six chains (it extends Spring Data's
`JpaRepository`) and so is the entity `Owner` of seven (`addVisit` calls
Spring's `Assert`, `toString` its `ToStringCreator`), while `Pet` is inside
eight.

Where the three agree, you have a classification you can defend. Where they
disagree, you have a finding, and usually a smell: an entity that talks to
the database, a service that is really a data carrier, a controller with
business rules in it.

## Write down

- What was explained: the scope, the plan's calls and reuse, and what the run
  cost; or that nothing was sent, and why.
- Per module: its one-line purpose and its bounded-context hint.
- Per type in the hotspot chains: its concept, and whether the three
  readings agree.
- The `unknown` and low-confidence records: the reading list for a human.
- The ubiquitous language the module records propose (`ubiquitousLanguage`):
  the glossary of the business, extracted from the code.
- The words the code spells, as each module's `glossary` reconciles them,
  and the ones it flags `polysemous`: a word its types use in different
  senses is a boundary to look at.

Next: [Domain](/docs/discover/domain/).

## The statement

A type is asked for by its trait (`TType`), never by a list of kinds, so the
same text runs on every language.

### chain-position.sql

Where each type of the code sits in step 4's chains: where a chain starts, inside it, or at its edge, where it reaches a library itself. Parameters: :chains — the saved rows of chains.sql, :stdlib — the standard library's modules, a JSON list of GLOB patterns.

```sql
WITH RECURSIVE
member(entry, type, depth) AS MATERIALIZED (
  SELECT json_extract(r.value, '$[0]'), json_extract(r.value, '$[1]'), json_extract(r.value, '$[3]')
    FROM json_each(:chains, '$.rows') r
   WHERE json_extract(r.value, '$[2]') = 0),
std(pattern) AS MATERIALIZED (
  SELECT value FROM json_each(:stdlib)),
types AS (
  SELECT m.trait_set_id
    FROM trait_set_member m JOIN trait t ON t.id = m.trait_id
   WHERE t.name = 'TType'),
leaving(ref) AS MATERIALIZED (   -- code that calls or reads a library, or a type a library is above, as written
  SELECT DISTINCT d.from_ref
    FROM dep d
    JOIN node t    ON t.ref = d.to_ref
    JOIN entity tm ON tm.id = t.module_ref
   WHERE d.kind IN ('invocation', 'access', 'inheritance', 'interfaceImplementation', 'traitUsage')
     AND d.provenance = 'declared'
     AND t.is_stub = 1
     AND NOT EXISTS (SELECT 1 FROM std s WHERE tm.symbol GLOB s.pattern)),
climb(ref, at) AS (              -- from that code up to the nearest type around it
  SELECT ref, ref FROM leaving
  UNION ALL
  SELECT c.ref, e.parent_id FROM climb c JOIN entity e ON e.id = c.at
   WHERE e.parent_id IS NOT NULL
     AND e.trait_set_id NOT IN (SELECT trait_set_id FROM types)),
edge_type(id) AS MATERIALIZED (
  SELECT n.id FROM node n
   WHERE n.ref IN (SELECT c.at FROM climb c JOIN entity e ON e.id = c.at
                    WHERE e.trait_set_id IN (SELECT trait_set_id FROM types)))
SELECT m.type,
       count(*) AS chains,
       sum(m.depth = 0) AS entry,
       sum(m.depth > 0 AND m.type IN (SELECT id FROM edge_type)) AS edge,
       sum(m.depth > 0 AND m.type NOT IN (SELECT id FROM edge_type)) AS inside
  FROM member m
 GROUP BY m.type
 ORDER BY chains DESC, m.type;
```

## Related

- [Explaining a package with a language model](/docs/tutorials/explain/)
- [Estimate, cap and scope an explain run](/docs/how-to/explain-cost/)
- [Ask your own question of the code](/docs/how-to/walk-your-question/) — `walk`: another question, the same bottom-up order
- [`insights.jsonl` reference](/docs/reference/artifacts/insights-jsonl/), with every block field and vocabulary
- [Explaining bottom-up](/docs/explanation/explaining-bottom-up/)
