---
title: Stubs
weight: 6
---

Not a separate node type — an entity with `isStub: true`, representing something **external to the corpus** (JDK, npm packages, …). Exactly two traits contribute `isStub`, so exactly two things are stubbable.

| Stub of | Trait | Shape | Why it must exist |
|---|---|---|---|
| a **type** | `TType` | `TNamed + TType`, optionally `TChildOf`; no children, no anchor | every corpus references types it does not declare |
| a **module** | `TModule` | `TNamed + TModule + TWithChildren`, `definedIn: []` | the import graph is module-level, so `import java.util.List` points at the *package* `java:java.util`; with no module stub the first-class import layer could never satisfy closure |

A **member** (method, field) is deliberately *not* stubbable: an external member folds up to its declaring type's stub. Fabricating a `class` named `bill(Order)` to close an endpoint is the one thing stub synthesis exists to prevent — an unresolvable member id is reported and left dangling instead.

## A stub's parent

The one non-degraded thing a stub type may hold is `TChildOf` — the external **module** it belongs to — and a stub module lists such types among its children. Two rules bound it, both extractor-side obligations:

1. **A stub's parent must itself be a stub.** Attributing an external type to a *corpus* module would make it read as internal to every module-level analysis. Where the parent cannot honestly be named — a static-analysis artefact invented inside the corpus's own package, or a primitive, which has no module at all — the stub stays **parentless** and is reported as unplaceable at module level.
2. **Only the extractor may derive it.** Ids are opaque to everything downstream; the extractor owns the id scheme and already knows the package.

Without this, an external type could not be folded to module level at all, and the tempting workaround — treating such a stub as its own module — silently changes the *granularity* of the result.

## Membership

- Edges *to* stubs are kept; the internal-only view is obtained by filtering stubs out at analysis time — uniformly, for types and modules alike. That is what `--internal-only` does.
- Membership is decided by a **whitelist of corpus-declared ids** built in a first pass — never by package or name prefix. Spoon in noClasspath mode invents plausible FQNs, and a prefix filter would launder them into facts.

## In each rendering

| Rendering | How a stub appears |
|---|---|
| `analyze` node lists | `external (stub)` |
| DOT, PlantUML | dashed and grey node; `<<stub>>` stereotype in PlantUML |
| City | `Building.isStub` / `District.isStub`; a stub carries no anchor, so `loc` is unmeasured |
| Navigator | `NavNode.isStub` |
| Domain facts | no dossier is emitted for a stub type; `external: true` on the facts that reach one |

Why stubs rather than dropped edges: [Extracting without compiling](/docs/explanation/extracting-without-compiling/).
