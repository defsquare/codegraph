---
title: Traits
weight: 2
---

A trait is a named micro-capability: a partial schema contributing zero or more attributes to the entity that declares it. Composition is commutative and associative; the trait vocabulary is closed and canonical, and a name is never renamed or aliased.

Traits marked *(marker)* contribute **no attributes**: they declare a capability whose data lives in edges, which are stored once, outgoing direction only.

## Base

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TNamed` | `name: string` | Not universal: lambdas, closures, Rust impl blocks, Java constructors have no own name |
| `TSourceAnchor` | `anchor: SourceAnchor` | Evidence for the entity's declaration |
| `TComment` | `comments: string[]` | Attached documentation/comments |

## Containment and attachment

*Where an entity is written* (lexical containment) and *what it semantically belongs to* (attachment) are different relations, and both are kept.

| Trait | Attributes contributed | Relation expressed |
|---|---|---|
| `TWithChildren` | `children: EntityId[]` **(v1 only, see below)** | lexical containment, downward |
| `TChildOf` | `parent: EntityId` | lexical containment, upward — the STORED direction |
| `TAttachedTo` | `attachedTo: EntityId` | semantic attachment. Required by: Go receiver methods, Rust `impl` blocks, C# extension methods, Clojure `extend-type`/`defmethod` |

A Go method with receiver `(o *Order)` is a *child* of its file/package and *attached* to `Order`.

**`children` is an inverse index, not a fact.** It is the exact inverse of `parent`, and inverse views are derived in memory, never serialized. `TWithChildren` stays a declared trait: it says an entity is a container. Only the serialized key goes.

## Modularity

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TModule` | `definedIn: string[]` (CodeFile paths), `isStub: boolean` | module↔file cardinality varies by language: 1-1 (JS/TS/Python: module *is* the file), 1-N (Java package, C#/Go/PHP namespace), N-N (Rust inline `mod`). A stub module has `definedIn: []`, which is exactly what makes it external |

## Types

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TType` | `isStub: boolean` | any type-like entity: class, interface, struct, enum, protocol, PHP/Rust trait |
| `TWithInheritances` | *(marker)* — see `inheritance` edges | multiple inheritance = N edges (Python). Absent from the Go and Rust profiles — that absence is profile information, not a gap |
| `TWithImplements` | *(marker)* — see `interfaceImplementation` edges | |
| `TTypedEntity` | `declaredType?: EntityId` | optional even when the trait is present: absent value in JS/Python/Clojure, C# `var`, inferred Go/TS/Rust |

## Behavior

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TInvocable` | `signature: string` | signature is part of identity (Java/C# overloads, Go receivers) |
| `TWithParameters` | `parameters: EntityId[]` | ordered |
| `TWithLocalVariables` | `localVariables: EntityId[]` | |
| `TWithInvocations` | *(marker)* — see `invocation` edges | outgoing only; incoming is derived by the analyzer, never stored |

## Structure

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TStructural` | *(marker)* — value holder | attributes, variables, parameters, Clojure vars. Legal target of `access` edges |
| `TWithAccesses` | *(marker)* — see `access` edges | outgoing only |
| `TWithValue` | `value: Literal` | the entity's declaration-site constant value. Optional wherever licensed — absence means "not constant", never "empty" |

## Measures

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TMetrics` | `metrics: Record<string, number>` | open map of **measured** finite numbers. Only the extractor writes it |

See [Measures and literals](/docs/reference/metamodel/measures-literals/).

## The composition that motivates the design

A Clojure var holding a function is simultaneously named, a value holder, and invocable: `traits: [TNamed, TStructural, TInvocable]`. No tree-shaped hierarchy can place it; trait composition expresses it directly. The argument is in [Why traits](/docs/explanation/why-traits/).

## The closed vocabulary

Nineteen names, in the order the header dictionary's enum declares them:

`TNamed` · `TSourceAnchor` · `TComment` · `TWithChildren` · `TChildOf` · `TAttachedTo` · `TModule` · `TType` · `TWithInheritances` · `TWithImplements` · `TTypedEntity` · `TInvocable` · `TWithParameters` · `TWithLocalVariables` · `TWithInvocations` · `TStructural` · `TWithAccesses` · `TMetrics` · `TWithValue`

The keys each contributes on the wire are listed under [`model.jsonl`](/docs/reference/model-jsonl/#e).
