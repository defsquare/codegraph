---
title: Measures and literals
linkTitle: Measures & literals
weight: 7
---

## Measures — `TMetrics`

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TMetrics` | `metrics: Record<string, number>` | open map of **measured** finite numbers. Only the extractor writes it: every value here required reading source no consumer sees. Optional on every kind that licenses it — a profile without measures is complete, not deficient |

Two rules give the map meaning:

- **Absence means "not measured", never zero.** A consumer may not default a missing key: "nothing measured this" and "measured as zero" are different statements, and only the second is a fact about the code.
- **Keys are canonical by documentation, not by schema.** Deliberately not a closed vocabulary: a new measure must not wait on a core release. Validation checks the values (finite numbers); the canonical names below are what makes one key comparable across extractors. An extractor inventing a key documents it in its profile `notes`.

### Canonical keys

| Key | Unit | Definition |
|---|---|---|
| `sloc` | source lines | lines in the entity's own span that are neither blank nor comment-only |
| `cyclomatic` | branches + 1 | per invocable: 1 + count of decision points — `if`, loops, non-default `case` labels, `catch`, `?:`, short-circuit `&&`/`\|\|`, pattern guards. A lambda's branches belong to the lambda: it is its own invocable |

The **derived** counterpart: gross span length (`end − start + 1`) is computable from `TSourceAnchor` alone and is not a measure — it is the city's `loc` source. A module's size is a sum over its derived children. `sloc` exists because blanks and comments are invisible downstream: the two claims ("how much is written here" vs "how much of it is code") are never conflated.

Measures reach the city through the open metric forms `attribute:<key>` and `sum:<key>` — see [City metrics](/docs/reference/city-metrics/).

## Literals

A **written, declaration-site value**: what an annotation argument, a constant initializer, or a default carries in the source. A tagged union whose tags are a closed core-owned vocabulary.

| Form | Shape | Notes |
|---|---|---|
| `string` | `{k: "string", v: string}` | chars ride as one-character strings; the declared type keeps `'a'` and `"a"` apart |
| `number` | `{k: "number", v: string}` | the evaluated constant's **canonical decimal text** — lossless where JSON numbers are not (a Java `long`, a big decimal) |
| `boolean` | `{k: "boolean", v: boolean}` | |
| `null` | `{k: "null"}` | |
| `enum` | `{k: "enum", type: EntityId, name: string}` | a reference to the *type* plus the constant's simple name — a member is never fabricated to close a value |
| `type` | `{k: "type", type: EntityId}` | `Foo.class` and kin. The written type use still emits its own `reference` edge — a value never replaces a dependency |
| `array` | `{k: "array", items: Literal[]}` | written order kept — a source fact, like parameter order |
| `annotation` | `{k: "annotation", type: EntityId, arguments: NamedArgument[]}` | a nested annotation value |
| `unevaluated` | `{k: "unevaluated", source: string}` | a written constant expression the extractor did not fold. The source text is still a fact — kept, and honest about what it is |

`NamedArgument` is `{name: string, value: Literal}`; a language-implicit name is normalized explicit (Java's `@Foo("x")` is `value = "x"`).

Two rules:

- **A Literal is what is written, never runtime state.** Emitted only when the language fixes the value at the declaration — a literal, or an expression that folds from constants (Java: JLS compile-time constant expressions). Anything else is `unevaluated` or absent; nothing downstream may "run" one.
- **Ids inside values count for closure.** `enum.type`, `type.type` and nested annotation types resolve to a declared entity or a stub exactly like an edge endpoint — in the `model.jsonl` encoding they are file-scoped surrogates, so a dangling one is unwritable.

**Relations:** carried by entities via `TWithValue` and by `annotationUse` edges.

### Examples from the reference fixture

```json
{"k":"number","v":"100"}
{"k":"string","v":""}
{"k":"enum","type":"java:java.lang.annotation/RetentionPolicy","name":"RUNTIME"}
```
