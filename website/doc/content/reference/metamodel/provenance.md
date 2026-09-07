---
title: Provenance
weight: 4
---

The enum qualifying *how we know* an edge exists. It is a mandatory attribute of every edge, from a closed set of four values.

| Value | Meaning | Examples |
|---|---|---|
| `declared` | written literally in the source | explicit `extends`, direct call |
| `derived` | computed by analysis | Go implicit interface satisfaction, TS structural conformance, Python protocols, Rust blanket impls |
| `dynamic-candidate` | dispatch not statically resolvable; targets are guesses | multimethods, PHP `__call`, duck typing, `dyn Trait` |
| `generated` | produced by macro/annotation expansion | Rust `#[derive]`, Lombok, Python decorators, Clojure macros |

The order above is the order the header dictionary's enum declares.

## Consequences

**Facts and inferences never mix.** An analysis that wants facts only filters on `declared`; that is what `--declared-only` does on every command that accepts it, and the resulting view is named in the report's header.

**A folded arrow keeps the set.** Folding to module or type level aggregates base edges, so a folded arrow carries the sorted set of the provenances underneath it. Renderings collapse that to one bit — an arrow is *inferred* when any base edge is not `declared` — and precompute it, so no renderer can get the rule wrong:

| Rendering | Fact | Inference |
|---|---|---|
| DOT, PlantUML | solid edge | dashed edge |
| City arrows | `inferred: false` | `inferred: true` |
| Navigator rows | `provenance: "declared"` | any other value |

**Wiring is `dynamic-candidate`.** `analyze --report wiring` and `--framework spring` derive dependency-injection edges from written annotations: the container's choice is not statically resolvable and every candidate is a guess, so the value is `dynamic-candidate` and the report says so.

Why the distinction is a value on every edge rather than a flag on a report: [Facts vs inferences](/explanation/facts-vs-inferences/).
