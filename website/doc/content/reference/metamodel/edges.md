---
title: Edges
weight: 3
---

The single relationship concept. Every edge, regardless of kind, carries:

| Attribute | Type | Required | Meaning |
|---|---|---|---|
| `edge` | EdgeKind | yes | discriminant, see below |
| `from` | EntityId | yes | source |
| `to` | EntityId | yes | primary target (best candidate if uncertain) |
| `provenance` | Provenance | yes | how we know |
| `anchor` | SourceAnchor | yes | where observed |
| `candidates` | EntityId[] | no | possible targets when dispatch is uncertain; non-empty iff resolution was ambiguous |
| `sourceFile` | string | no | disambiguates which declaration site produced the edge (C# partial classes, TS declaration merging) |

## Rules

- **Outgoing only, stored once.** All inverse views — callers of X, subtypes of Y, importers of M, and `children` (the inverse of `parent`) — are derived in memory, never serialized. Only `parent` is a stored fact.
- **Closure:** `from` and `to` must resolve to a known entity or a stub — a tested property of every model.
- **No self-reference:** `from ≠ to`.

## Edge kinds

| Kind | From → To | Extra attributes | Notes |
|---|---|---|---|
| `import` | Module → Module | | **First-class layer**: the only relation reliable ≈100% across all languages, hence the granularity for cross-language comparison. Rust has two levels (mod, crate) |
| `inheritance` | Type → Type | | N edges for multiple inheritance (Python); optional MRO order left to profile notes |
| `interfaceImplementation` | Type → Type (interface/trait/protocol) | | `declared` (Java `implements`) or `derived` (Go, TS structural) depending on language. For Rust/Clojure the anchor is the reified impl block |
| `invocation` | Invocable → Invocable | `candidates` | uncertain dispatch → `provenance: dynamic-candidate` + candidates list |
| `access` | Invocable → Structural | `isRead: bool`, `isWrite: bool` | field/variable reads and writes; a compound assignment sets both |
| `reference` | Entity → Type | | type usage that is none of the above (declarations, generics, casts) |
| `annotationUse` | Entity → Type (annotation) | `arguments: NamedArgument[]` | a written annotation on any entity, with its arguments. The dedicated kind carries the values and lets a consumer select annotation usages without guessing from the target's kind — which a stub target cannot answer |
| `throws` | Invocable → Type (exception) | | a written `throw` statement whose static exception type resolved; the anchor is the throw SITE. A declared propagation clause (Java `throws E`) is a plain `reference`, not this |
| `embedding` | Type → Type | | Go `struct { Base }` — neither inheritance nor attribute (method promotion); dedicated relation |
| `traitUsage` | Type → Trait (PHP) | | PHP `use TraitX;` — kept as a usage edge, never flattened into the class |
| `fileInclude` | CodeFile → CodeFile | | PHP `include`/`require` — the only file-to-file dependency in the metamodel |

The order above is the order the header dictionary's enum declares.

**Relations:** edges connect entities; are licensed per [language profile](/reference/metamodel/profiles/) (a profile lists which edge kinds its extractor can emit); carry a [SourceAnchor](/reference/metamodel/identity/#sourceanchor) and a [Provenance](/reference/metamodel/provenance/).

## Folded edges

Analyses do not read base edges directly: the analyzer folds them to `--level module` or `--level type` first, aggregating every base edge between two folded nodes into one arrow that carries the count, the set of base kinds and the set of provenances. A folded arrow is an inference about a group, not a written fact; what it aggregates is stated in every rendering.
