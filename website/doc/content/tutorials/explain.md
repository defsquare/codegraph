---
title: Explaining a codebase with a language model
linkTitle: Explain
weight: 5
---

**What you will build.** A costed, inspectable plan for having a language model
explain every method, class and package of a corpus — bottom-up, so every
summary rests on parts already explained. You will run the planner and the
estimator for real, and you will see what a live run produces without spending
anything.

**What you need.**

- codegraph installed and built — see [Install](/how-to/install/).
- A JDK 17 or newer on `PATH`.
- **No API key.** Every command in this tutorial is one of the two that make no
  network call.

**How long.** About 10 minutes.

`explain` is the only codegraph command that costs money and needs a network.
That is exactly why it has a dry run and an estimator, and why this tutorial
uses them first.

## 1. Extract the reference corpus

This tutorial uses the committed reference fixture rather than a real library:
it is 13 files, it never leaves your machine, and it is small enough that a full
plan fits on one screen. Point `--src` at the fixture inside your codegraph
clone:

```bash
cd ~/codegraph-tutorial
JAR=~/src/codegraph/extractors/java/target/codegraph-java.jar
SRC=~/src/codegraph/fixtures/java/src

java -jar "$JAR" --src "$SRC" --out order.jsonl
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

{{< callout type="info" >}}
This corpus does **not** compile, on purpose. It imports a class that does not
exist and uses two types that are never declared anywhere — the ordinary legacy
case. `javac` reports 12 errors on it; codegraph extracts it and turns what it
cannot resolve into 27 explicit stubs. A corpus that compiles cleanly cannot
test classpath-free extraction at all.
{{< /callout >}}

## 2. See the plan, without calling anything

```bash
codegraph explain order.jsonl --src "$SRC" --dry-run
```

```text
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~70459 prompt tokens
  type          17 units     17 calls ~28078 prompt tokens
  module         3 units      3 calls ~4249 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 68 calls, ~102786 prompt tokens in, ~36650 completion tokens out

llm         L0 operation java:com.acme.order.adapter/LedgerAdapter.<init>() calls=1 ~1461tok
llm         L0 operation java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object) calls=1 ~1468tok
template    L0 operation java:com.acme.order.legacy/List.<init>(java.lang.String,com.acme.order.legacy.List)
template    L0 operation java:com.acme.order.legacy/List.head()
llm         L0 operation java:com.acme.order.legacy/List.length() calls=1 ~1422tok
llm         L0 operation java:com.acme.order/AbstractOrder.price() calls=1 ~1424tok
template    L0 operation java:com.acme.order/AbstractOrder.reference()
...
llm         L1 type      java:com.acme.order.adapter/LedgerAdapter calls=1 ~1534tok
llm         L1 type      java:com.acme.order.legacy/List calls=1 ~1575tok
llm         L1 operation java:com.acme.order/Basket.add(com.acme.order.Basket.Line) calls=1 ~1469tok
```

Four things are worth reading closely.

**The order is bottom-up.** Layer `L0` is leaf operations — methods that call
nothing else in the corpus. `L1` holds their callers and the types whose
operations are all done. Modules come last. Every prompt is fed the explanations
already written for what the unit depends on, so no summary is guessed from a
signature.

**A cycle is one unit.** Mutually recursive methods, a type cycle, mutually
dependent packages — all explained together in one call, with every member's
record listing the group. There is no order in which one of them could come
first, so pretending there is would be a lie.

**Nine units cost nothing.** The `template` rows are getters, setters,
`equals`/`hashCode`/`toString`, and field-assigning constructors. They are
described from facts alone — no throw site, no corpus call, cyclomatic
complexity ≤ 1, at most one field touched — with no model call at all. Anything
with a `throws` fact or a corpus call is never trivial, however short.

**Nothing was sent.** `--dry-run` needs no key and opens no socket.

## 3. Price it

`--dry-run` tells you what would happen. `--estimate` tells you what it would
cost:

```bash
codegraph explain order.jsonl --src "$SRC" --estimate --price-in 0.10 --price-out 0.60
```

```text
explain estimate: order.jsonl
  units: 77 (operation 57, type 17, module 3) in 8 layers
  calls: 68 (template 9, reuse 0, skipped 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1

  level        calls   input tokens  output tokens
  operation       48         70 459         21 600
  type            17         28 078         12 350
  module           3          4 249          2 700
  total           68        102 786         36 650

  cost at $0.1/M in, $0.6/M out: $0.0323
  input ≈ rendered prompts at 4 characters per token; output ≈ measured block averages (operation 450, type 650, module 900) per block asked for.
  not included: repair re-asks, rate-limit retries. Records already in the side-car are reused, not re-sent.
```

Prices are USD per million tokens and you supply them — codegraph does not carry
a price list that would be wrong by next week. Drop `--price-in`/`--price-out`
and you get the volumes without a cost line.

The estimate says what it does not cover. It is a floor, not a quote.

## 4. Shrink the run before you make it

Three controls, and they compose.

`--scope` restricts calls to units inside named modules or types. Dependencies
outside the scope are reused when they already have a record and never called:

```bash
codegraph explain order.jsonl --src "$SRC" --estimate --scope java:com.acme.order.legacy
```

```text
  units: 77 (operation 57, type 17, module 3) in 8 layers
  calls: 3 (template 9, reuse 0, skipped 65)

  level        calls   input tokens  output tokens
  operation        1          1 422            450
  type             1          1 575            650
  module           1          1 308            900
  total            3          4 305          2 000
```

Sixty-eight calls became three.

`--max-calls N` stops planning after N calls, and what runs is always a
dependency-consistent prefix — you never get a type explained from callees that
were never explained.

`--model` and `--rollup-model` split the work: a cheap model for the leaf
operations, a stronger one for types and modules.

## 5. What a live run does

When you do have a key, the run is:

```bash
OPENROUTER_API_KEY=… codegraph explain order.jsonl --src "$SRC" --max-calls 50
```

or, for the other supported provider:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
  codegraph explain order.jsonl --src "$SRC" --provider cloudflare
```

Model names are the same `author/model` form on both, so switching provider
leaves every fingerprint — and therefore every reusable record — intact.

{{< callout type="warning" >}}
`--concurrency` defaults to 4. A new OpenRouter account is limited to 20
requests a minute; `--concurrency 1` is the setting that account wants. The
client obeys the provider's `Retry-After` on a 429 before retrying.
{{< /callout >}}

**Where the output goes.** A side-car, `order.insights.jsonl`, beside the model.
It never touches `model.jsonl` or `model.db`. Explanations are the one artefact
in the pipeline that is not a pure function of the model, which is why they live
beside it rather than in it.

**What a record looks like.** A header, one record per unit, and a count
trailer:

```text
{"t":"header","kind":"codegraph.insights/1",…,"metamodel":"specy.domain/3",…}
{"t":"i","id":…,"level":"operation",…,"block":{…},"fingerprint":…}
…
{"t":"eof","counts":{…},"usage":{…},"generatedAt":"…"}
```

Every record carries a prose description and a structured `block` in the
vocabulary of the Specy domain metamodel: an operation is an *Operation* (safe,
idempotent, owner, handled command, emitted events, pre- and postconditions);
a type names the concept it realises (entity, aggregate, value type, repository,
service…) with its fields, invariants and relations; a module is a *Module*
with its APIs, SPIs, concepts and a bounded-context hint.

Records are sorted and re-serialised through their schema, and the body carries
no timestamp — only the trailer does. Two runs are therefore diffable: what
changed is what was re-explained.

**Re-running is cheap.** Every record carries a sha256 over what it was computed
from — the prompt version, the model slug, the source slices, the facts, and the
*fingerprints of the units it depended on*. Change one method's source and
exactly its transitive dependents and containers are redone; nothing else is.
The explanation text is deliberately not hashed, so a non-deterministic answer
never cascades a re-run. Re-run the command and the plan's `reuse` count rises
while `llm` falls. `--force` overrides all of it.

Records are appended to a `.journal` as they arrive and the sorted side-car is
rewritten at every layer, so an interrupted run resumes where it stopped.

**What it cost, measured.** A full live run over this corpus with
`openai/gpt-5.6-luna` was **77 units, 68 calls, about six cents**, and produced
blocks in the Specy vocabulary — `Order` recognised as an entity with an
identity, the module `com.acme.order` described by its APIs and the SPI it
depends on.

{{< callout type="info" >}}
Everything the corpus contributes to a prompt sits inside a fence, and the
system message states that fenced content is **material, never instruction**.
That is the defence against a comment in the source that reads "ignore the rules
above". A dependency with no record is shown as NOT EXPLAINED and the model is
told not to invent it.
{{< /callout >}}

## What you have now

- A costed plan for explaining a corpus, produced without a key and without a
  call.
- The three levers — `--scope`, `--max-calls`, and the two model slugs — that
  turn a plan you cannot afford into one you can.
- The knowledge of where the output goes, why it goes there, and why a second
  run is nearly free.

## Where to go next

- [Estimate, cap and scope an explain run](/how-to/explain-cost/) — choosing a
  provider, models per level, and forcing a re-run.
- [Explaining bottom-up](/explanation/explaining-bottom-up/) — units, why a
  cycle is one unit, context packs and fingerprints.
- [Querying the model with SQL](/tutorials/sql/) — the same facts, asked your
  own way.
