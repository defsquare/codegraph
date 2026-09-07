---
title: Identity
weight: 1
---

## The natural key

**Identity is the structured key `(lang, module, symbol, disambiguator?)`.** It is compared **component-wise**, never by parsing a rendered string. Uniqueness is per model union: no two entities share `(lang, module, symbol, disambiguator)`.

| Component | Role |
|---|---|
| `lang` | language id, frozen per profile (`java`, `ts`, `clj`, …) |
| `module` | the owning module's path. A **module names itself here**, with an empty `symbol` |
| `symbol` | the path below the module — dots for nesting; empty only for a module |
| `disambiguator` | optional: `file:line:column` for anonymous entities (lambdas, impl blocks), `param:`/`local:` markers for sub-members; absent when the symbol is already unique. For Java invocables the erased-FQN parameter list is part of `symbol`, not of this component. The COLUMN is load-bearing: one line can start several nameless entities, and without it they collapse into one id |

## Rendered ids

A **rendered id** — `java:com.acme.order/OrderService.bill(com.acme.order.Order)`, produced by core's `renderId` as `<lang>:<module>[/<symbol>][#<disambiguator>]` — is a **display projection**: written into v1 files and shown to users, and **never parsed**.

Because the id is a projection it must not lose information, so `/` and `#` are **reserved**: a `module` may contain neither, a `symbol` may not contain `#`, and a present `disambiguator` is non-empty. Under those rules rendering is injective — two distinct keys can never produce one id.

A module names itself rather than its parent: the alternative renders the package `java:com.acme.order` as `java:com.acme/order` and needs a fabricated `java` module to place the stub package `java:java.util`.

Identity is multi-declaration tolerant: one key may be declared in several places (TypeScript declaration merging, C# partial classes).

## Canonical order

Sort by natural key, component by component, a missing disambiguator before any present one. It belongs to the model, not to an encoding: it is what makes snapshot diffs reviewable and extractor cross-validation meaningful. It is deliberately *not* the same as sorting the rendered ids as strings, where `/` and `.` are ordinary characters.

## References

Every reference between concepts (edge endpoints, `parent`, `children`, `attachedTo`, `declaredType`, `candidates`) identifies an entity by its natural key. The v1 file format spells each of those as the rendered id string; the [`model.jsonl`](/reference/model-jsonl/) encoding uses file-scoped integer surrogates. A surrogate is **not** identity and never crosses a file boundary.

## SourceAnchor

The *evidence* concept: where in the source a fact was observed.

| Attribute | Type | Meaning |
|---|---|---|
| `file` | string | path of the CodeFile, relative to the analyzed root |
| `span` | `[int, int]` | `[startLine, endLine]`, 1-based, inclusive |

**Relations:** attached to entities (via the `TSourceAnchor` trait) **and** to edges (directly). Anchors on edges are what make every dependency claim auditable.

## Space

TypeScript-family concept: which declaration space(s) an entity occupies.

| Value | Meaning |
|---|---|
| `type` | exists only at type-check time (TS `interface`, `type`) — dependencies on it are erased at runtime |
| `value` | exists at runtime |

An entity may occupy both (a TS `class`). Optional attribute; only meaningful in profiles that declare it.

## CodeFile

A source file. Not reified as a first-class entity in most profiles — it appears as `anchor.file` values and in `TModule.definedIn`. It becomes an explicit node only where a language has file-level dependencies (PHP `FileInclude` edges).

## Worked example

```json
{
  "id": "java:com.acme.order/OrderService.bill(com.acme.order.Order)",
  "kind": "method",
  "traits": ["TNamed", "TInvocable", "TWithParameters", "TWithLocalVariables",
             "TWithInvocations", "TWithAccesses", "TTypedEntity", "TChildOf",
             "TSourceAnchor"],
  "name": "bill",
  "signature": "bill(com.acme.order.Order)",
  "declaredType": "java:com.acme.billing/Invoice",
  "parent": "java:com.acme.order/OrderService",
  "anchor": { "file": "OrderService.java", "span": [15, 22] }
}
```

The `id` is the rendering of the natural key:

| Component | Value |
|---|---|
| `lang` | `java` |
| `module` | `com.acme.order` |
| `symbol` | `OrderService.bill(com.acme.order.Order)` |
| `disambiguator` | *(absent — the symbol is already unique)* |

The id's parameter types are **erased fully-qualified names**, not simple names: `archive(java.util.List)` and `archive(com.acme.order.legacy.List)` are legal Java overloads that both render as `archive(List)` under simple names, so one method would vanish from the model with no error.

Why identity is a key and not a string: [Identity](/explanation/identity/).
