# Codegraph Metamodel Reference

Conceptual reference for the trait-based, multi-language code metamodel
(FamixNG lineage). Every concept is described with its **attributes** and its
**relations** to other concepts. The executable form of this document is
`@codegraph/core` (Zod schemas) and the generated `schemas/` contract;
if they ever disagree, the code is authoritative and this file has a bug.

Concept map:

```mermaid
graph TB
  subgraph Model["Model (one extraction run)"]
    E[Entity]
    ED[Edge]
  end
  P[Language Profile] -- "licenses kinds & trait\ncompositions, edge kinds" --> E
  P -- licenses --> ED
  T[Trait] -- "composes into\n(traits set)" --> E
  ED -- "from / to" --> E
  A[SourceAnchor] -- "evidence on" --> E
  A -- "evidence on" --> ED
  PR[Provenance] -- "qualifies" --> ED
  CF[CodeFile] -- "definedIn / anchors" --> E
  S[Stub] -- "degraded Entity\n(isStub = true)" --> E
```

---

## 1. Primitives

### 1.1 Identity — the natural key

**Identity is the structured key `(lang, module, symbol, disambiguator?)`**
(MM-1). It is compared **component-wise**, never by parsing a rendered string.
Uniqueness is per model union: no two entities share
`(lang, module, symbol, disambiguator)`.

| Component | Role |
|---|---|
| `lang` | language id, frozen per profile (`java`, `ts`, `clj`, …) |
| `module` | the owning module's path. A **module names itself here**, with an empty `symbol` |
| `symbol` | the path below the module — dots for nesting; empty only for a module |
| `disambiguator` | optional: `file:line:column` for anonymous entities (lambdas, impl blocks), `param:`/`local:` markers for sub-members; absent when the symbol is already unique. For Java invocables the erased-FQN parameter list is part of `symbol`, not of this component (§10). The COLUMN is load-bearing: one line can start several nameless entities, and without it they collapse into one id — and a nested one then becomes its own parent |

A **rendered id** — `java:com.acme.order/OrderService.bill(com.acme.order.Order)`,
produced by core's `renderId` as `<lang>:<module>[/<symbol>][#<disambiguator>]` —
is a **display projection**: written into v1 files and shown to users, and
**never parsed**. v1 carries nothing else, so the analyzer compares those
strings as opaque tokens; from M6 the key travels structurally and comparison is
component-wise. Because the id is a projection it must not lose information, so
`/` and `#` are **reserved**: a `module` may contain neither, a `symbol` may not
contain `#`, and a present `disambiguator` is non-empty. Under those rules rendering is injective — two distinct keys can
never produce one id — which is the property that keeps an entity from silently
vanishing into another (the overload collision of §10, one level up).

*Why a module names itself rather than its parent:* the alternative renders the
package `java:com.acme.order` as `java:com.acme/order` and, worse, needs a
fabricated `java` module to place the stub package `java:java.util`, whose
parent no corpus declares — exactly the fabrication §6 exists to prevent.

Multi-declaration tolerant: one key may be declared in several places
(TypeScript declaration merging, C# partial classes).

**Canonical order** is sort by natural key, component by component, a missing
disambiguator before any present one. It belongs to the model, not to an
encoding: it is what makes snapshot diffs reviewable and extractor
cross-validation meaningful. It is deliberately *not* the same as sorting the
rendered ids as strings, where `/` and `.` are ordinary characters.

**Relations:** every reference between concepts (edge endpoints, `parent`,
`children`, `attachedTo`, `declaredType`, `candidates`) identifies an entity by
its natural key. The v1 file format spells each of those as the rendered id
string (`EntityId` in core); an encoding is free to spell them otherwise — M6
uses file-scoped integer surrogates — as long as they resolve to the same key.
A surrogate is **not** identity and never crosses a file boundary.

### 1.2 SourceAnchor

The *evidence* concept: where in the source a fact was observed.

| Attribute | Type | Meaning |
|---|---|---|
| `file` | string | path of the CodeFile, relative to the analyzed root |
| `span` | `[int, int]` | `[startLine, endLine]`, 1-based, inclusive |

**Relations:** attached to Entities (via the `TSourceAnchor` trait) **and** to
Edges (directly). Anchors on edges are what make every dependency claim
auditable.

### 1.3 Provenance

Enum qualifying *how we know* an edge exists. Never mix facts and inferences.

| Value | Meaning | Examples |
|---|---|---|
| `declared` | written literally in the source | explicit `extends`, direct call |
| `derived` | computed by analysis | Go implicit interface satisfaction, TS structural conformance, Python protocols, Rust blanket impls |
| `dynamic-candidate` | dispatch not statically resolvable; targets are guesses | multimethods, PHP `__call`, duck typing, `dyn Trait` |
| `generated` | produced by macro/annotation expansion | Rust `#[derive]`, Lombok, Python decorators, Clojure macros |

**Relations:** mandatory attribute of every Edge. Analyses wanting facts only
filter on `declared`.

### 1.4 Space

TypeScript-family concept: which declaration space(s) an entity occupies.

| Value | Meaning |
|---|---|
| `type` | exists only at type-check time (TS `interface`, `type`) — dependencies on it are erased at runtime |
| `value` | exists at runtime |

An entity may occupy both (a TS `class`). Optional attribute; only meaningful
in profiles that declare it (TypeScript).

### 1.5 CodeFile

A source file. Not reified as a first-class entity in most profiles — it
appears as `anchor.file` values and in `TModule.definedIn`. It becomes an
explicit node only where a language has file-level dependencies (PHP
`FileInclude` edges).

### 1.6 Literal

A **written, declaration-site value**: what an annotation argument, a constant
initializer, or a default carries in the source. A tagged union whose tags are
a closed core-owned vocabulary (MM-3):

| Form | Shape | Notes |
|---|---|---|
| `string` | `{k: "string", v: string}` | chars ride as one-character strings; the declared type keeps `'a'` and `"a"` apart |
| `number` | `{k: "number", v: string}` | the evaluated constant's **canonical decimal text** — lossless where JSON numbers are not (a Java `long`, a big decimal) |
| `boolean` | `{k: "boolean", v: boolean}` | |
| `null` | `{k: "null"}` | |
| `enum` | `{k: "enum", type: EntityId, name: string}` | a reference to the *type* plus the constant's simple name — a member is never fabricated to close a value (§6, verbatim) |
| `type` | `{k: "type", type: EntityId}` | `Foo.class` and kin. The written type use still emits its own `reference` edge — a value never replaces a dependency |
| `array` | `{k: "array", items: Literal[]}` | written order kept — a source fact, like parameter order |
| `annotation` | `{k: "annotation", type: EntityId, arguments: NamedArgument[]}` | a nested annotation value |
| `unevaluated` | `{k: "unevaluated", source: string}` | a written constant expression the extractor did not fold. The source text is still a fact — kept, and honest about what it is, mirroring stub degradation |

`NamedArgument` is `{name: string, value: Literal}`; a language-implicit name
is normalized explicit (Java's `@Foo("x")` is `value = "x"`).

Two rules:

- **A Literal is what is written, never runtime state.** Emitted only when the
  language fixes the value at the declaration — a literal, or an expression
  that folds from constants (Java: JLS compile-time constant expressions).
  Anything else is `unevaluated` or absent; nothing downstream may "run" one.
- **Ids inside values count for closure** (§8a): `enum.type`, `type.type` and
  nested annotation types resolve to a declared entity or a stub exactly like
  an edge endpoint — in the M6 encoding they are file-scoped surrogates, so a
  dangling one is unwritable.

**Relations:** carried by Entities via `TWithValue` (§3.6) and by
`annotationUse` edges (§4).

---

## 2. Entity

The single node concept. There is **no entity class hierarchy**: an entity is a
kind plus a *sum of traits*, and each trait contributes attributes.

| Attribute | Type | Always present | Meaning |
|---|---|---|---|
| `id` | EntityId | yes | the natural key of §1.1, rendered — compared, never parsed |
| `kind` | string | yes | language-profile-defined classification (`class`, `method`, `function`, `namespace`, …) |
| `traits` | TraitName[] | yes | the capabilities this entity composes |
| `space` | Space[] | no | TS-family only, see §1.4 |
| *(trait keys)* | — | per trait | every trait in `traits` contributes its keys (§3) |

**Validity** (per the owning Language Profile, §5):
`required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`, and every declared
trait's keys are present and well-typed.

**Relations:**
- composed of **Traits** (§3);
- source or target of **Edges** (§4);
- classified and licensed by a **Language Profile** (§5);
- may be a **Stub** (§6).

---

## 3. Traits

A trait is a named micro-capability: a partial schema contributing zero or more
attributes to the entity that declares it. Composition is commutative and
associative; the trait vocabulary is closed and canonical (never renamed).

Traits marked *(marker)* contribute **no attributes**: they declare a
capability whose data lives in `edges[]` (edges are stored once, outgoing
direction only — see §4).

### 3.1 Base

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TNamed` | `name: string` | Not universal: lambdas, closures, Rust impl blocks, Java constructors have no own name |
| `TSourceAnchor` | `anchor: SourceAnchor` | Evidence for the entity's declaration |
| `TComment` | `comments: string[]` | Attached documentation/comments |

### 3.2 Containment and attachment — two distinct relations

A strong design decision: *where an entity is written* (lexical containment)
and *what it semantically belongs to* (attachment) are different relations and
both are kept.

| Trait | Attributes contributed | Relation expressed |
|---|---|---|
| `TWithChildren` | `children: EntityId[]` **(v1 only, see below)** | lexical containment, downward |
| `TChildOf` | `parent: EntityId` | lexical containment, upward — the STORED direction |
| `TAttachedTo` | `attachedTo: EntityId` | semantic attachment. Required by: Go receiver methods, Rust `impl` blocks, C# extension methods, Clojure `extend-type`/`defmethod` |

Example where they diverge: a Go method with receiver `(o *Order)` is a
*child* of its file/package (where it is written) but *attached* to `Order`.

**`children` is an inverse index, not a fact** (MM-2). It is the exact inverse
of `parent`, and §4's rule — inverse views are derived in memory, never
serialized — has always applied to it; v1 carrying the key was an inherited
inconsistency (11.6MB of it on fineract). `TWithChildren` stays a declared
trait: it says an entity is a container, which is what §5's containment ≠
attachment distinction needs. Only the serialized key goes, in M6.

### 3.3 Modularity

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TModule` | `definedIn: string[]` (CodeFile paths), `isStub: boolean` | module↔file cardinality varies by language: 1-1 (JS/TS/Python: module *is* the file), 1-N (Java package, C#/Go/PHP namespace), N-N (Rust inline `mod`). Rust modules are hierarchical (crate = root). `isStub` mirrors `TType`'s: the import graph is module-level (§9), so an import of an external module needs an endpoint that exists — a stub module has `definedIn: []`, which is exactly what makes it external |

### 3.4 Types

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TType` | `isStub: boolean` | any type-like entity: class, interface, struct, enum, protocol, PHP/Rust trait |
| `TWithInheritances` | *(marker)* — see `Inheritance` edges | multiple inheritance = N edges (Python). Absent from Go/Rust profiles — that absence is profile information, not a gap |
| `TWithImplements` | *(marker)* — see `InterfaceImplementation` edges | |
| `TTypedEntity` | `declaredType?: EntityId` | optional even when the trait is present: absent value in JS/Python/Clojure, C# `var`, inferred Go/TS/Rust |

### 3.5 Behavior

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TInvocable` | `signature: string` | signature is part of identity (Java/C# overloads, Go receivers) |
| `TWithParameters` | `parameters: EntityId[]` | ordered |
| `TWithLocalVariables` | `localVariables: EntityId[]` | |
| `TWithInvocations` | *(marker)* — see `Invocation` edges | outgoing only; incoming is derived by the analyzer, never stored |

### 3.6 Structure

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TStructural` | *(marker)* — value holder | attributes, variables, parameters, Clojure vars. Legal target of `Access` edges |
| `TWithAccesses` | *(marker)* — see `Access` edges | outgoing only |
| `TWithValue` | `value: Literal` (§1.6) | the entity's declaration-site constant value: a Java `static final` constant initializer, an annotation element's `default`, a TS enum member's value, a Clojure def'd constant. Optional wherever licensed — an attribute whose initializer is not a compile-time constant simply carries no value, and absence means "not constant", never "empty" |

### 3.7 The composition that motivates the whole design

A Clojure var holding a function is simultaneously named, a value holder, and
invocable: `traits: [TNamed, TStructural, TInvocable]`. No tree-shaped
hierarchy can place it; trait composition expresses it directly.

### 3.8 Measures

| Trait | Attributes contributed | Notes |
|---|---|---|
| `TMetrics` | `metrics: Record<string, number>` | open map of **measured** finite numbers. Only the extractor writes it: every value here required reading source no consumer sees. Optional on every kind that licenses it — a profile without measures is complete, not deficient |

Two rules give the map meaning:

- **Absence means "not measured", never zero.** A consumer may not default a
  missing key: "nothing measured this" and "measured as zero" are different
  statements, and only the second is a fact about the code (the city's metric
  sources already honor this — an unmeasured building is floored and counted,
  not zeroed).
- **Keys are canonical by documentation, not by schema.** Deliberately *not* a
  closed MM-3 vocabulary: a new measure must not wait on a core release.
  Validation checks the values (finite numbers); the canonical names below are
  what makes one key comparable across extractors — an extractor inventing a
  key documents it in its profile `notes`.

| Key | Unit | Definition |
|---|---|---|
| `sloc` | source lines | lines in the entity's own span that are neither blank nor comment-only |
| `cyclomatic` | branches + 1 | per invocable: 1 + count of decision points — `if`, loops, non-default `case` labels, `catch`, `?:`, short-circuit `&&`/`\|\|`, pattern guards. A lambda's branches belong to the lambda: it is its own invocable |

The **derived** counterpart: gross span length (`end − start + 1`) is
computable from `TSourceAnchor` alone and is not a measure (it is the city's
`loc` source); a module's size is a sum over its derived children. `sloc`
exists because blanks and comments are invisible downstream — the two claims
("how much is written here" vs "how much of it is code") are never conflated.

---

## 4. Edges (associations)

The single relationship concept. Every edge, regardless of kind, carries:

| Attribute | Type | Required | Meaning |
|---|---|---|---|
| `edge` | EdgeKind | yes | discriminant, see table below |
| `from` | EntityId | yes | source |
| `to` | EntityId | yes | primary target (best candidate if uncertain) |
| `provenance` | Provenance | yes | how we know (§1.3) |
| `anchor` | SourceAnchor | yes | where observed |
| `candidates` | EntityId[] | no | possible targets when dispatch is uncertain; non-empty iff resolution was ambiguous |
| `sourceFile` | string | no | disambiguates which declaration site produced the edge (C# partial classes, TS declaration merging) |

Rules:
- **Outgoing only, stored once.** All inverse views — callers of X, subtypes
  of Y, importers of M, and `children` (the inverse of `parent`, §3.2) — are
  derived in memory, never serialized. Only `parent` is a stored fact; v1 files
  still carry `children` and M6 drops the key (MM-2).
- **Closure:** `from` and `to` must resolve to a known entity or a stub —
  a tested property of every model.
- **No self-reference:** `from ≠ to`.

### Edge kinds

| Kind | From → To | Extra attributes | Notes |
|---|---|---|---|
| `import` | Module → Module | | **First-class layer**: the only relation reliable ≈100% across all languages, hence the granularity for cross-language comparison. Rust has two levels (mod, crate) |
| `inheritance` | Type → Type | | N edges for multiple inheritance (Python); optional MRO order left to profile notes |
| `interfaceImplementation` | Type → Type (interface/trait/protocol) | | `declared` (Java `implements`) or `derived` (Go, TS structural) depending on language. For Rust/Clojure the anchor is the reified impl block (§7) |
| `invocation` | Invocable → Invocable | `candidates` | uncertain dispatch → `provenance: dynamic-candidate` + candidates list |
| `access` | Invocable → Structural | `isRead: bool`, `isWrite: bool` | field/variable reads and writes |
| `reference` | Entity → Type | | type usage that is none of the above (declarations, generics, casts) |
| `annotationUse` | Entity → Type (annotation) | `arguments: NamedArgument[]` (§1.6) | a written annotation on any entity, with its arguments. Formerly a plain `reference`; the dedicated kind both carries the values and lets a consumer select annotation usages without guessing from the target's kind — which a stub target cannot answer |
| `throws` | Invocable → Type (exception) | | a written `throw` statement whose static exception type resolved; the anchor is the throw SITE — the evidence a guard clause leaves. A declared propagation clause (Java `throws E`) is a plain `reference`, not this. Distinct from `reference` so failure exits are selectable without reading the target's kind, which a stub target cannot answer |
| `embedding` | Type → Type | | Go `struct { Base }` — neither inheritance nor attribute (method promotion); dedicated relation |
| `traitUsage` | Type → Trait (PHP) | | PHP `use TraitX;` — kept as a usage edge, never flattened into the class |
| `fileInclude` | CodeFile → CodeFile | | PHP `include`/`require` — the only file-to-file dependency in the metamodel |

**Relations:** edges connect Entities; are licensed per Language Profile
(a profile lists which edge kinds its extractor can emit); carry SourceAnchor
and Provenance.

---

## 5. Language Profile

A profile is **data, not code**: the contract stating what a given language's
extractor may produce. A profile must be *specifiable without being
implemented* (robustness test of the schema).

| Attribute | Type | Meaning |
|---|---|---|
| `lang` | string | language id, matches the EntityId prefix |
| `kinds` | `Record<kind, {required: TraitName[], optional: TraitName[]}>` | the licit trait compositions per entity kind |
| `edges` | EdgeKind[] | edge kinds this language can emit |
| `notes` | string[] | documented static-analysis blind spots (reflection, `Class.forName`, dynamic `require`, macros pre-expansion, …) |

**Validation** of an entity against its profile:
1. `kind` exists in the profile;
2. `required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind)`
   (strict equality rejected — too brittle for `TComment`; free subset rejected
   — hides extractor bugs);
3. each declared trait's attributes are present and well-typed.

**Relations:** licenses Entities and Edges; cross-language analyses operate on
the **intersection** of the profiles involved (in practice: the `import` layer
plus whatever both profiles share).

### 5.1 Vocabularies are closed referential sets (MM-3)

Kinds, trait names, edge kinds and provenance values are **finite sets owned by
core**. The consequence, stated so encodings need not each invent it: an
encoding may represent a member **by reference** — an index into a dictionary, a
foreign key — as long as the reference resolves to a canonical name that core
validates. An unknown name is a hard error, never a passthrough.

This is what licenses the header dictionaries of the M6 JSONL encoding and the
lookup tables of the M7 store without either of them redefining the vocabulary.

### 5.2 Validity is a function of `(kind, trait set)` (MM-4)

The rule above reads only the kind and the *set* of traits — never the entity
carrying them. So a consumer may decide each distinct `(kind, trait set)` pair
**once** and share the verdict across every entity with that composition
(fineract: a few dozen pairs across 240 910 entities). Step 3 — the trait-key
check — still runs per entity, because the keys' *values* differ.

Two bounds on that licence, both load-bearing: a stub's exemption from the
lower bound (§6) is an entity-level fact, so it is part of what the verdict is
keyed on; and the verdict is per profile, since two profiles may name the same
kind under different rules. It is a **reader-side** optimisation and requires no
encoding support — trait sets are deliberately not a wire-level concept.

---

## 6. Stub

Not a separate node type — an Entity with `isStub: true`, representing something
**external to the corpus** (JDK, npm packages, …). Exactly two traits contribute
`isStub`, so exactly two things are stubbable:

| Stub of | Trait | Shape | Why it must exist |
|---|---|---|---|
| a **type** | `TType` | `TNamed + TType`, optionally `TChildOf`; no children, no anchor | every corpus references types it does not declare |
| a **module** | `TModule` | `TNamed + TModule + TWithChildren`, `definedIn: []` | the import graph is module-level (§9), so `import java.util.List` points at the *package* `java:java.util` — with no module stub the first-class import layer could never satisfy closure (§11 invariant) |

A **member** (method, field) is deliberately *not* stubbable: an external member
folds up to its declaring type's stub. Fabricating a `class` named `bill(Order)`
to close an endpoint is the one thing stub synthesis exists to prevent — an
unresolvable member id is reported and left dangling instead.

### 6.1 Why a stub may carry a parent

The one non-degraded thing a stub type may hold is `TChildOf` — the external
**module** it belongs to — and a stub module lists such types in its `children`.
Two rules bound it, and both are extractor-side obligations:

1. **A stub's parent must itself be a stub.** Attributing an external type to a
   *corpus* module would make it read as internal to every module-level
   analysis. Where the parent cannot honestly be named — a static-analysis
   artefact invented inside the corpus's own package (§6, and the `noClasspath`
   note in the Java profile), or a primitive, which has no module at all — the
   stub stays **parentless** and is reported as unplaceable at module level.
2. **Only the extractor may derive it.** Ids are opaque to everything
   downstream (§1.1); the extractor owns the id scheme and already knows the
   package, so the knowledge is recorded here rather than re-derived by parsing.

Without this, an external type could not be folded to module level at all, and
the tempting workaround — treating such a stub as its own module — silently
changes the *granularity* of the result: classes, and even primitives, become
nodes of a module dependency graph.

- Edges *to* stubs are kept; the internal-only view is obtained by filtering
  stubs out at analysis time — uniformly, for types and modules alike.
- Membership is decided by a **whitelist of corpus-declared ids** built in a
  first pass — never by package/name prefix (Spoon in noClasspath mode invents
  plausible FQNs; prefix filters would launder them into facts).

---

## 7. Reified impl block (anonymous attachment entity)

Verified against Rust (and improving Clojure `extend-type`): a block like
`impl Display for Order` attaches to *two* entities and owns methods, so it is
reified as an anonymous entity:

- `traits: [TWithChildren, TAttachedTo, TSourceAnchor]` — **no `TNamed`**;
- `attachedTo` → the type (`Order`);
- the `interfaceImplementation` edge `Order → Display` takes the block as its
  `anchor`;
- its methods are its `children`.

---

## 8. Model and encodings

### 8a. The model — logical content

The unit of exchange between an extractor and the analyzer: the result of one
extraction run. Its content is format-independent.

| Attribute | Type | Meaning |
|---|---|---|
| `schemaVersion` | semver string | version of the interchange contract |
| `lang` | string | profile id of the extractor |
| `extractor` | `{name, version, ...flags}` | provenance of the model itself (e.g. `noClasspath: true`) |
| `root` | string | analyzed source root (anchors are relative to it) |
| `repository` | `{remote, commit, root, provider?}` | optional — where the analyzed root lives in a hosted repository (see below) |
| `entities` | Entity[] | all nodes, stubs included |
| `edges` | Edge[] | all relations, outgoing direction |

**`repository`** records provenance of the *corpus*, as facts:

| Field | Meaning |
|---|---|
| `remote` | normalized https clone URL (`https://github.com/google/gson` — never the ssh form, never trailing `.git`) |
| `commit` | the sha the corpus was extracted at — a permalink; a branch name moves and is not a fact |
| `root` | path of the analyzed root **relative to the repository root**. Anchors are relative to the *analyzed* root, which may sit below the repo root (gson: `gson/src/main/java`) — without this prefix no anchor can be projected back to a repo path |
| `provider` | `github` \| `gitlab`, only when the hostname does not say (self-hosted); consumers guess from the host otherwise |

The model stores these facts; the blob-URL of a particular host is a
**projection** consumers derive (§9), never serialized — a stored URL would
freeze one host's scheme into the interchange. The extractor copies the four
strings verbatim from its invocation (it has no git knowledge); the values are
supplied by whoever runs it, e.g. the CLI's snapshot orchestration, which
already knows the per-frame sha.

The integrity properties a model must satisfy, whatever encodes it:

- **closure** — every reference resolves to a declared entity or a stub (§4,
  §6), the ids inside `Literal` values included (§1.6);
- **no self-reference** — `from ≠ to` on every edge;
- **provenance set** on every edge, from the closed set of §1.3;
- **profile validity** for every entity (§5);
- **natural-key uniqueness** — no two entities share `(lang, module, symbol,
  disambiguator)` (§1.1);
- **canonical order** — entities and edges sorted by natural key (§1.1), so two
  runs over one corpus are diffable.

**Relations:** a model conforms to exactly one Language Profile; multi-language
analysis is the union of models (keys are globally unique thanks to the `lang`
component), queried through profile intersection.

### 8b. Encodings — how a model hits disk

A file **conforms to this metamodel iff its decoded content satisfies §8a**, so
several encodings may conform at once and each decides for itself how the
canonical order manifests physically and how references are spelled (integer
surrogates, rowids). The interchange is `model.jsonl`, specified by
[`schemas/`](schemas/README.md) — one JSON Schema per record type plus the
container contract — and designed in
[`docs/model-encoding.md`](docs/model-encoding.md), which also covers the
planned `model.db` analysis store: a derived, disposable cache, never the
contract.

**What the encoding decides, and what it therefore enforces.** Because a
reference is a surrogate into the file's own entity section, closure (§8a) is
not something a reader checks afterwards — a dangling reference is not
expressible. A producer that cannot close a reference must drop it and say so;
it cannot write it and hope. The same applies across models: each file is closed
on its own, so a reference to another language's entity is a stub (§6) that the
union merges by natural key.

---

## 9. Derived concepts (never serialized)

Computed by the analyzer from the stored model; listed here because they are
part of the conceptual vocabulary even though no encoding stores them:

| Concept | Derived from | Definition |
|---|---|---|
| Incoming indexes | all edges | callers-of, importers-of, subtypes-of, accessors-of — inverse of stored outgoing edges |
| Children index | `parent` | children-of — the inverse of the stored containment link (§3.2, MM-2) |
| Type-level dependency graph | all edge kinds | edges folded up to the containing `TType` entities |
| Module import graph | `import` edges | the cross-language comparison layer |
| Coupling metrics | folded graphs | fan-in/fan-out, afferent/efferent coupling, instability |
| Cycles | folded graphs | strongly connected components at module or type level |
| Tangle / minimum feedback set | folded graphs | per-SCC minimal weighted edge set whose removal leaves the component acyclic; tangle metric = feedback references / cyclic references |
| Internal view | `isStub` | model minus stubs and their edges |
| Facts-only view | `provenance` | model restricted to `declared` edges |
| Source links | `repository` + anchors | per-anchor host permalink — `{remote}/blob/{commit}/{root}/{file}#L{s}-L{e}` on GitHub, `{remote}/-/blob/{commit}/{root}/{file}#L{s}-{e}` on GitLab; template chosen by hostname, `provider` overriding |
| Framework roles | `annotationUse` edges + a framework profile (§9.1) | stereotype classification of types (`@Service`, `@RestController`, …) and identification of injection points |
| DI wiring | injection points + the interfaceImplementation inverse index | `dynamic-candidate` edges from a consumer to every corpus implementation of the injected interface — §1.3's definition verbatim: dispatch not statically resolvable, targets are guesses |

### 9.1 Framework profiles (data, consumed by the analyzer)

Mirror of §5's rule at the framework level: what an annotation *means*
(`@Autowired` marks an injection point, `@Service` a stereotype, `@Qualifier`
narrows candidates, `@Primary` wins a tie) is a declarative table — annotation
identity (simple name + declaring module) → role —
specifiable without being implemented, extensible to another framework (CDI,
Micronaut) without code. It lives in the analyzer: the extractor stays
framework-blind (it already emits the facts — a `reference` edge per written
annotation), and the wiring it licenses is derived in memory, never
serialized. Matching reads the referenced entity's `name` and parent chain —
never a parsed id — and must tolerate the target being a stub, which is the
normal case for a corpus whose framework jars are absent. Injection points and
roles are selected on `annotationUse` edges, and qualifier narrowing reads
their `arguments` (§1.6) — exact values, not guesswork.

A framework RULE that is not an annotation is data too: Spring 4.3+ treats the
sole constructor of a bean as an injection point with nothing written on it, so
the profile carries that as a flag rather than the analyzer as a branch. And a
meta-annotated stereotype is deliberately NOT followed: resolving `@MyService`
to the `@Service` it carries needs the annotation type's own declaration, which
is exactly what a stub does not have — so such a type is unclassified, honestly,
rather than classified by a guess.

---

## 10. Worked example (Java profile)

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

The `id` shown is the rendering of the natural key (§1.1)

| component | value |
|---|---|
| `lang` | `java` |
| `module` | `com.acme.order` |
| `symbol` | `OrderService.bill(com.acme.order.Order)` |
| `disambiguator` | *(absent — the symbol is already unique)* |

and it is the key, not the string, that decides whether two entities are the
same. The string is what a v1 file carries and what a report prints.

Note the id's parameter types: **erased fully-qualified names**, not simple
names. Simple names genuinely collide — `archive(java.util.List)` and
`archive(com.acme.order.legacy.List)` are legal Java overloads that both render
as `archive(List)`, so under simple names they would merge into a single id and
one method would vanish from the model with no error. Ids must be unique, so the
FQN form wins; the `signature` attribute keeps the same form. (The fixture
corpus contains exactly that overload pair as a regression case.)

Reading it through the metamodel: the entity is a `method` **kind** whose
**traits** license each attribute — `TNamed` brings `name`, `TInvocable` brings
`signature` (also serving as the id's disambiguator), `TTypedEntity` brings
`declaredType` (the return type, itself an EntityId), `TChildOf` brings
`parent`, `TSourceAnchor` brings `anchor`. `TWithParameters` and
`TWithLocalVariables` reference child entities; `TWithInvocations` and
`TWithAccesses` are markers announcing outgoing `invocation`/`access` edges:

```json
{
  "edge": "invocation",
  "from": "java:com.acme.order/OrderService.bill(com.acme.order.Order)",
  "to": "java:com.acme.order/TaxCalculator.apply(double)",
  "provenance": "declared",
  "anchor": { "file": "OrderService.java", "span": [19, 19] }
}
```

A fact (`declared`), with evidence (line 19), between two internal entities
(neither is a stub) — it will survive both the internal-only and the facts-only
filters of §9.
