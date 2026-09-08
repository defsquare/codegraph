---
title: Facts and inferences never mix
linkTitle: Facts vs inferences
weight: 2
---

A dependency graph is a claim about someone else's code, and claims differ in how
much they are worth. "`OrderService` calls `Ledger.post` on line 41" is something
the source literally says. "`OrderController` probably receives a
`ClinicServiceImpl`, because Spring wires the only implementation of the
interface it asks for" is something a tool worked out — plausibly, usefully, and
not the same kind of statement at all.

Most dependency tools merge the two. They have to: their output is a graph, a
graph has edges, and an edge is an edge. The result is a picture whose reader
cannot tell which parts would survive if the framework changed, and a metric
whose value depends on inferences nobody can enumerate. Codegraph's first design
bet is that these must never be merged, and the mechanism is a mandatory
attribute on every edge.

## The four values, and why there are exactly four

Every edge in the model carries a `provenance`:

| Value | Meaning | Examples |
|---|---|---|
| `declared` | written literally in the source | explicit `extends`, a direct call |
| `derived` | computed by analysis | Go implicit interface satisfaction, TypeScript structural conformance, Python protocols, Rust blanket impls |
| `dynamic-candidate` | dispatch not statically resolvable; the targets are guesses | multimethods, PHP `__call`, duck typing, `dyn Trait` |
| `generated` | produced by macro or annotation expansion | Rust `#[derive]`, Lombok, Python decorators, Clojure macros |

The set is closed and owned by the core package, which is the point that makes
it usable: an analysis that wants facts only filters on one value, and it will
still be filtering on one value after the next language and the next framework
land. A new inference does not get a new provenance — it gets classified into an
existing one, and if it cannot be, the classification was wrong.

That rule has already been tested once, from an unexpected direction. History
mining produces claims like "these two files always change together", which is
neither a fact about the source nor a static inference over it. The tempting
move was a fifth value. Instead, evolution facts live in a separate artifact,
`history.jsonl`, joined to the model at analysis time and never merged into it —
because a repo-scoped fact with a per-commit lifecycle does not belong in a
language-scoped structural contract, and because the provenance set only stays
meaningful while it is small.

The distinction between `derived` and `dynamic-candidate` is worth dwelling on,
because it is the one people expect to be a single value. A `derived` edge is a
*conclusion*: Go's compiler would agree that this type satisfies that interface,
we simply had to compute it rather than read it. A `dynamic-candidate` edge is a
*guess*: it names a target that dispatch might select at runtime, and the set of
candidates is our best enumeration, not a proof. Collapsing them would put a
result the language guarantees in the same bucket as a result the container
might contradict.

## Keeping them apart in every rendering

A provenance that is recorded and then averaged away is decoration. So the split
is carried through every stage, and mechanically rather than by convention:

- **In the analyzer**, `declaredOnly` is a view — a predicate pair, not a copy of
  the graph — and it composes with `internalOnly`. Folding to type or module
  level keeps the `provenances` set of everything it aggregated, so a folded edge
  can still answer "is this a fact?" after collapsing twenty base edges.
- **In every result**, the view travels with the number. A folded graph, a
  coupling table, a cycle report and every export repeat the view descriptor
  they were computed under, because a coupling number without its view is not a
  fact: filter the stubs out or drop the inferences and every number changes.
- **In the exports**, one visual channel is bound to it and never reused: a solid
  edge is `declared`, a dashed edge contains an inference, in DOT and in PlantUML
  alike. The view and the fold level reach the rendered image itself — DOT's
  header, PlantUML's `title`, a column on every CSV row — rather than sitting in
  a comment a parser would drop.
- **In the city**, the arrow's `inferred` flag is *precomputed by the model*
  (true when any base edge is not `declared`) so that the renderer cannot get the
  rule wrong; green arcs are declared facts and red arcs contain an inference,
  and the renderer is tested to use the flag verbatim rather than re-deriving it.
- **In the navigator**, inference gets its own hue — violet on any row whose
  provenance is not `declared` — alongside cyan for incoming and amber for
  outgoing. A stub is drawn muted rather than in a colour of its own, because a
  stub is a degraded fact, not a fifth category.

None of this stops you from using inferences. It stops you from using them
without knowing.

## The Spring case, in detail

The sharpest test of the rule is dependency injection, because it is precisely
where the structural graph is least useful: a Spring controller declares a
dependency on an *interface*, and the thing that decides which implementation
arrives is a container that runs long after the compiler is done.

Codegraph answers that question, and the way it answers it is the design in
miniature. A framework profile is a data table mapping annotation identities to
roles — stereotype, injection point, entry point, qualifier, primary. The
analyzer's pass reads two things the model already carries — `annotationUse`
edges with their written arguments, and the `interfaceImplementation` inverse
index — and produces, for each injection point, the corpus implementations of the
declared interface. `@Primary` narrows on presence; `@Qualifier` narrows on its
argument value against the bean's names. Narrowing is never silent: the injection
point says what it narrowed *from*.

Three properties keep it from contaminating the facts:

1. **It returns; it does not attach.** Nothing is written back into the graph or
   the model. A caller who wants the wiring adds it to their own view.
2. **Every derived edge is `dynamic-candidate`** — the definition above, applied
   verbatim. Spring's dispatch is not statically resolvable and the targets are
   candidates.
3. **Matching reads the annotation's name and module, never a parsed id**, and
   tolerates the annotation being a stub — which is the normal case, since a
   corpus extracted without its framework jars declares none of those types.

{{< callout type="info" >}}
The invariant is stated as a test, not as a promise: on spring-petclinic, the
facts-only view is byte-identical whether or not the wiring pass ran —
`analyze --report deps --level type --declared-only --json` is the same 107,359
bytes, 286 edges, provenance `declared` only, on both sides.
{{< /callout >}}

What the pass found on that corpus is the other half of the argument. At the last
revision that still used `@Autowired`, all six annotated sites were found, giving
nine injection points. The five that inject `ClinicService` list exactly one
candidate, `ClinicServiceImpl` — the corpus's only implementation. The four that
inject Spring Data repository interfaces list **nothing at all**, and say why:
the container implements those interfaces at runtime, so the empty set is a fact
about the corpus rather than a failure of the pass. At the project's current
head, which has no `@Autowired` anywhere, the profile's own
`implicitSoleConstructorInjection` rule — a data field, not a code branch — finds
six implicit constructor injection points.

An honest empty answer, with its reason attached, is the outcome this design is
for. A tool that merged provenances would have had to choose between inventing a
target and saying nothing.

## What this costs, and what it does not

The cost is that consumers must decide. `--declared-only` is not the default,
because for most questions the inferences are exactly what you want: the wiring
*is* the architecture of a Spring application, and a Lombok-generated equals
method really is called. What the design refuses is to make that decision
invisibly on the reader's behalf.

The cost it does *not* impose is a second pipeline. A view is a predicate pair
built in constant time; asking for facts only does not rebuild the graph, does
not re-read the model, and does not change a code path. That is why the rule
survived: keeping facts and inferences apart is cheap enough that no future
optimisation will be tempted to trade it away.

## Where this shows up

- [How to get a facts-only view](/docs/how-to/facts-only-view/) — `--declared-only`,
  `--internal-only`, and reading the view stamp in the output.
- [Reference: provenance](/docs/reference/metamodel/provenance/) — the four values as
  the model defines them.
- [How to colour a Spring codebase by role](/docs/how-to/spring-roles/) —
  `analyze --report wiring` and `city --framework spring`.
- [Tutorial: reading a city](/docs/tutorials/reading-the-city/) — green arcs, red
  arcs, and what a stub building means.
- [Time as structure](/docs/explanation/time-as-structure/) — why history facts stayed
  in their own artifact instead of becoming a fifth provenance.
