# Codegraph — Implementation Plan (TypeScript)

Multi-language, trait-based code-analysis metamodel (FamixNG-style), implemented in
TypeScript. Language-specific **extractors** (Java first, via Spoon) emit a **JSON
interchange file**; a TypeScript **analyzer** validates it, builds the dependency
graph, and runs analyses (imports, coupling, cycles, architecture).

Source of truth for design decisions: the August 2026 exploration document
(traits, not hierarchy; provenance on every edge; imports as the first-class
comparable layer; containment ≠ attachment; stubs for external types).

---

## 1. Architecture overview

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Extractors          │     │  JSON interchange     │     │  TypeScript analyzer │
│  (per language,      │ ──▶ │  contract             │ ──▶ │  validate → graph →  │
│  native tooling)     │     │  model.json           │     │  queries → exports   │
│                      │     │  (versioned schema)   │     │                      │
│  Java: Spoon (JVM)   │     └──────────────────────┘     └─────────────────────┘
│  Clojure: clj-kondo  │              ▲
│  TS/JS: ts compiler  │              │ JSON Schema published from the
│  … (later)           │              │ TS core package → extractors in any
└─────────────────────┘              │ language can self-validate output
```

Key principle: extractors are **federated behind one contract**. Each extractor
uses the best native tool for its language and only has to produce conforming
JSON. All intelligence about the metamodel (traits, profiles, validation,
derived indexes, analyses) lives once, in TypeScript.

## 2. Repository layout (pnpm workspace monorepo)

```
codegraph/
├── PLAN.md
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/                     # @codegraph/core — metamodel: traits, kinds,
│   │                             #   entities, edges, profiles, validation,
│   │                             #   JSON Schema export
│   ├── analyzer/                 # @codegraph/analyzer — graph construction,
│   │                             #   derived indexes, queries, metrics, exports
│   ├── cli/                      # @codegraph/cli — `codegraph` command
│   └── viz/                      # (future) Three.js "code city" 3D visualization
│                                 #   of the model — the only package allowed
│                                 #   to depend on three
├── extractors/
│   └── java/                     # Maven/Gradle project, Spoon-based, emits model.json
│       └── src/main/java/...
├── schemas/                      # generated JSON Schema files (committed,
│                                 #   versioned — the cross-language contract)
└── fixtures/
    └── java/                     # small reference corpus + expected model.json
```

Tooling: **Node ≥ 22**, **pnpm**, **TypeScript strict**, **Zod v4** (runtime
validation + static types + native JSON Schema export), **Vitest** +
**fast-check** (property-based tests), **tsup** for builds.

Why Zod: one definition per trait yields (a) the inferred TS type, (b) the
runtime validator, (c) `z.toJSONSchema()` output for non-TS extractors — the
exact role Malli plays in the original Clojure design.

---

## 3. Phase 0 — Bootstrap

- [ ] pnpm workspace, `tsconfig.base.json` (strict, `"module": "NodeNext"`), ESLint, Vitest.
- [ ] Empty `core`, `analyzer`, `cli` packages wired together; CI script (`pnpm -r build && pnpm -r test`).
- [ ] Rewrite README.md (currently GitLab template) with project pitch + this plan's summary.

## 4. Phase 1 — `@codegraph/core`: the metamodel

### 4.1 Identity, anchors, provenance (primitives)

```ts
// Opaque entity id: "<lang>:<module>/<symbol>[#<disambiguator>]"
// disambiguator = signature (overloads, receivers) or "file:startLine" for anonymous entities.
type EntityId = string; // opaque — never parsed by the analyzer, only compared

const SourceAnchor = z.object({
  file: z.string(),
  span: z.tuple([z.number().int(), z.number().int()]), // [startLine, endLine]
});

const Provenance = z.enum(["declared", "derived", "dynamic-candidate", "generated"]);
```

### 4.2 Traits — one Zod partial schema per trait

Each trait declares only the keys it contributes:

| Trait                 | Keys contributed                          |
|-----------------------|-------------------------------------------|
| `TNamed`              | `name`                                    |
| `TSourceAnchor`       | `anchor: SourceAnchor`                    |
| `TComment`            | `comments: string[]`                      |
| `TWithChildren`       | `children: EntityId[]` (lexical containment) |
| `TChildOf`            | `parent: EntityId`                        |
| `TAttachedTo`         | `attachedTo: EntityId` (semantic attachment — Go receivers, Rust impl blocks, C# extension methods, Clojure extend-type) |
| `TModule`             | `definedIn: string[]` (CodeFile paths; 1-1, 1-N or N-N per language), `isStub: boolean` |
| `TType`               | `isStub: boolean`                         |
| `TWithInheritances`   | *(marker — edges carry the data)*         |
| `TWithImplements`     | *(marker — edges carry the data)*         |
| `TTypedEntity`        | `declaredType?: EntityId`                 |
| `TInvocable`          | `signature: string`                       |
| `TWithParameters`     | `parameters: EntityId[]`                  |
| `TWithLocalVariables` | `localVariables: EntityId[]`              |
| `TWithInvocations`    | *(marker — outgoing Invocation edges)*    |
| `TStructural`         | *(marker — value holder)*                 |
| `TWithAccesses`       | *(marker — outgoing Access edges)*        |

Design rules carried over verbatim:
- **Outgoing only** — incoming indexes are always derived by the analyzer, never
  serialized (consistency + no serialization cycles).
- **Containment ≠ attachment** — `TChildOf/TWithChildren` (where it's written)
  vs `TAttachedTo` (what it semantically belongs to) are distinct.
- `space?: ("type" | "value")[]` on entities for TypeScript profiles (interface
  = type-space only; class = both) — optional field, only meaningful in TS/… profiles.

Implementation: `TRAITS: Record<TraitName, ZodObject>` + a `TraitName` string
literal union. An **Entity** is:

```ts
const EntityBase = z.object({
  id: z.string(),
  kind: z.string(),          // constrained per profile, not globally
  traits: z.array(TraitName),
}).passthrough();            // trait keys validated per declared trait
```

### 4.3 Edges (associations)

All edges carry `from`, `to`, `provenance`, `anchor` (evidence), optional
`sourceFile` (C# partial classes), optional `candidates: EntityId[]`
(uncertain dispatch).

Edge kinds: `import`, `inheritance`, `interfaceImplementation`, `invocation`,
`access` (+ `isRead`/`isWrite`), `reference`, `embedding` (Go), `traitUsage`
(PHP), `fileInclude` (PHP). Discriminated union on `edge` field.

### 4.4 Language profiles — data, not code

```ts
interface Profile {
  lang: string;
  kinds: Record<string, { required: TraitName[]; optional: TraitName[] }>;
  edges: EdgeKind[];                    // which associations this language can emit
  space?: Record<string, Space[]>;      // per kind, the declaration spaces it MAY occupy
  notes?: string[];                     // documented static-analysis blind spots
}
```

**Decision (M1 audit, added after the first draft of this section):** `space?`
belongs on the Profile, not only on the Entity. METAMODEL §1.4 says the type/value
split is "only meaningful in profiles that declare it"; without a profile-side
declaration that sentence is unenforceable and `space: ["type"]` on a Java entity
would validate. A profile that omits `space` licenses none, which is exactly the
statement "this language has no type/value split". Only the TypeScript profile
declares it. The field is optional and additive: every profile literal predating
the decision still compiles unchanged.

**Decision (was open in the design doc):** validation uses
`required ⊆ traits ⊆ required ∪ optional` — strict equality is too brittle for
optional traits like `TComment`/`TSourceAnchor`; unrestricted subset would hide
extractor bugs. This gives both.

- [x] Define all **9 profiles** (Java, C#, Go, Clojure, JS, TS, Python, PHP, Rust)
      as data files — specifiable without being implemented (robustness test).
      Only Java's needs to be exercised in Phase 2.

**Decision (M1 review) — lang ids are frozen as declared:**

| `clj` | `csharp` | `go` | `java` | `js` | `php` | `python` | `rust` | `ts` |
|---|---|---|---|---|---|---|---|---|

Abbreviated where the abbreviation is the idiomatic name of the language
(`clj`, `js`, `ts`), spelled out otherwise. The mixed style is deliberate and
not to be "tidied": the lang id is the **EntityId prefix**, so it is embedded in
every id an extractor emits and in every edge endpoint referencing one. Renaming
one after an extractor ships invalidates that extractor's whole id space and any
model.json already produced. Frozen before M2 for exactly that reason.

### 4.5 Validation

```ts
validateEntity(profile, entity):
  1. entity.kind ∈ profile.kinds
  2. required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind)
  3. ∀ t ∈ entity.traits: TRAITS[t].parse(entity) succeeds
validateModel(model):
  + every edge's provenance is set
  + edge kinds allowed by the profile
  (graph closure — every from/to/parent/children id resolves — is checked in
   the analyzer, since stubs are legitimate targets)
```

### 4.6 The interchange file format

```jsonc
// model.json
{
  "schemaVersion": "1.0.0",
  "lang": "java",
  "extractor": { "name": "codegraph-spoon", "version": "0.1.0", "noClasspath": true },
  "root": "/path/analyzed",
  "entities": [ /* Entity[] */ ],
  "edges":    [ /* Edge[]   */ ]
}
```

Reference example (the doc's §9 EDN example, translated):

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
```json
{
  "edge": "invocation",
  "from": "java:com.acme.order/OrderService.bill(com.acme.order.Order)",
  "to": "java:com.acme.order/TaxCalculator.apply(double)",
  "candidates": ["java:com.acme.order/TaxCalculator.apply(double)"],
  "provenance": "declared",
  "anchor": { "file": "OrderService.java", "span": [19, 19] }
}
```

**Id parameter types are erased FQNs, not simple names** (M2, verified against
Spoon). `archive(java.util.List)` and `archive(com.acme.order.legacy.List)` are
legal overloads whose simple names are identical; rendered as `archive(List)`
they collapse into one id and one method disappears silently. Ids must be
unique per model, so the FQN form is normative — here, in METAMODEL.md §10, and
in the extractor. The fixture corpus pins the collision as a regression test.

- [ ] `pnpm run gen:schemas` → `z.toJSONSchema()` → `schemas/model.schema.json`
      (committed; the Java extractor validates against it in its own tests).

**Decision (M1 audit):** the published schema must be sufficient on its own. Zod
refinements do not survive `z.toJSONSchema()`, so the trait-key rule of §4.5 step 3
is re-stated in the emitted schema as one `if/then` conditional per key-contributing
trait, generated from the same `TRAITS` table. Without it the contract accepted
`{traits: ["TNamed"]}` with no `name`, and "an extractor in any language can
self-validate using only the published schema" was only partly true. What remains
outside the schema — deliberately — is everything profile-aware: which kinds exist
and which trait compositions each kind licenses. That is `validateEntity`'s job and
requires the profile data, so an extractor self-validates structure + vocabulary +
trait keys against the schema, and the analyzer adds the profile pass on load.

**Deliverable Phase 1:** `@codegraph/core` published locally; 9 profile data
files; JSON Schema generated; unit tests incl. the canonical hierarchy-breaking
case (a Clojure fn-var validating as `TNamed + TStructural + TInvocable`).

## 5. Phase 2 — Java extractor (Spoon)

Separate Maven project in `extractors/java/`, JDK 17+, [Spoon](https://spoon.gforge.inria.fr/)
in **noClasspath mode** (legacy, non-compilable corpora). Output: `model.json`
via Jackson. CLI: `java -jar codegraph-java.jar --src <dir> --out model.json`.

### 5.1 Mapping table (Java profile)

| Java construct | kind | traits |
|---|---|---|
| package | `package` | TNamed, TModule, TWithChildren (TModule brings `definedIn` **and `isStub`**) |
| class / interface / enum / record / annotation | `class`/`interface`/… | TNamed, TType, TWithInheritances, TWithImplements, TWithChildren, TChildOf, TSourceAnchor, (TComment) |
| method | `method` | TNamed, TInvocable, TWithParameters, TWithLocalVariables, TWithInvocations, TWithAccesses, TTypedEntity, TChildOf, TSourceAnchor |
| constructor | `constructor` | TInvocable, TWithParameters, … — **no TNamed, no TTypedEntity** |
| lambda / anonymous class | `lambda` | TInvocable **without TNamed**; disambiguator = `(file, startLine)` |
| field | `attribute` | TNamed, TStructural, TTypedEntity, TChildOf, TSourceAnchor |
| parameter / local var | `parameter`/`localVariable` | TNamed, TStructural, TTypedEntity, TChildOf |

Edges: `import` (package/type imports → module-level), `inheritance`,
`interfaceImplementation`, `invocation` (via `getReferencedTypes()`/executable
references), `access` (field reads/writes), `reference` (type usages).
Lombok-generated members, if visible: `provenance: "generated"`.

### 5.2 Stub discipline (critical, from §5 of the doc)

Spoon in noClasspath mode **invents plausible FQNs**. Rule: build a **whitelist
of corpus-declared types first** (pass 1); anything referenced but not in the
whitelist becomes `{ kind: "class", traits: ["TNamed","TType"], isStub: true }`.
**Never filter by package prefix.** Edges to stubs are kept; internal-only
analysis = analyzer-side `filter(!isStub)`.

**Decision (M2): `isStub` is contributed by `TModule` as well as `TType`.** The
import graph is module-level (§4.6, METAMODEL §9), so `import java.util.List`
yields an edge to `java:java.util` — a package no corpus file declares and, with
`isStub` on `TType` alone, one nothing could represent. The choices were a class
stub named `util` (a fabrication), a permanently dangling endpoint (breaking
closure, invariant 10), or making a degraded module expressible. An external
package is now `{ kind: "package", traits: ["TNamed","TModule","TWithChildren"],
definedIn: [], isStub: true }` — `definedIn: []` is precisely what makes it
external — so "internal view = filter stubs" holds for the import layer too.
Only `TType` and `TModule` contribute `isStub`; a dangling **member** id is
still refused and reported, because a `method` stub would need a degraded-member
concept core does not have.

**Primitives, `void` and `<nulltype>` are not entities.** `EntityIds.erasedTypeName`
keeps primitives as-is by design, so pass 2 omits `declaredType` for them rather
than letting `java:<unnamed>/int` reach pass 4 and be fabricated into a stub
*class* named `int`. `TTypedEntity`'s value is optional even when the trait is
declared, so omitting is legal and lossless — and a phantom class with a fan-in
of hundreds would distort every coupling metric the analyzer computes.

### 5.3 Validation of the extractor

- [x] Fixture corpus in `fixtures/java/` (overloads, lambdas, inner classes,
      constructors, static imports, an unresolvable external lib) + snapshot
      `fixtures/java/expected/model.json`, pretty-printed and sorted so it is
      reviewable in a diff. `SnapshotTest` reproduces it;
      `-Dcodegraph.updateSnapshot=true` regenerates it deliberately.
- [x] Extractor test validates its output against `schemas/model.schema.json`
      (`ModelSchemaValidationTest`, networknt).
- [x] **Profile conformance across the language boundary**: a JSON Schema cannot
      express per-kind trait rules, so `packages/core/test/fixtures-java.test.ts`
      loads the snapshot, `parseModel`s it and runs `validateModel` against
      `javaProfile` expecting zero issues. This is the M2 acceptance gate — the
      first check that runs both halves of the system against each other.
- [ ] **KNOWN GAP carried into M3 — the lambda id disambiguator is too coarse.**
      `Type#file:startLine` cannot separate two lambdas that START ON THE SAME
      LINE (`chain(() -> a, () -> b)`). The extractor deduplicates
      deterministically (first in AST order wins) rather than letting a hash
      decide, but one real lambda is then absent from the model and nothing
      distinguishes that from a lambda never written. Measured on the fixtures:
      5 nameless invocables in source, 4 in the model; pinned by
      `StubDisciplineTest.lambdasSharingALineCollapseIntoOneEntityAndTheLossIsBounded`.
      The fix is a column or an in-line ordinal in the disambiguator — an
      id-scheme change, hence M3 and not a seam-level bug.
- [x] Graph closure and self-reference asserted on the snapshot from both sides
      (`StubDisciplineTest` in Java, `unknownReferences`/`selfReferences` in TS).
- [x] Measure resolution rate in noClasspath on a real corpus; report unresolved
      counts in the extractor's stderr summary. **Measured (M2 audit): 100.0% on
      apache/commons-lang — 263 files, 133 478 type references, 0 unresolved,
      15 338 entities (261 stubs), 24 631 edges, 6.6 s wall clock — and 77.8% on
      spring-petclinic (30 files, 2 189 references, 487 unresolved).**

      Categorising the failures is what makes those numbers readable, and it
      first corrected the metric: **every one of commons-lang's 1 466 originally
      "unresolved" references was `<nulltype>`**, Spoon's static type for the
      `null` literal — a pseudo-type that can never have a declaration, which the
      extractor already refuses to make an entity. It is now excluded from the
      denominator alongside type variables, for the same stated reason. The old
      98.9% was measuring how many `return null;` statements commons-lang
      contains.

      What is left is a clean statement: the rate measures the corpus's
      **dependency surface**, not the extractor. commons-lang is self-contained
      and depends on nothing but the JDK, which resolves against the runner's own
      classpath — so it resolves perfectly and the 85% target is **vacuous**
      there. petclinic's 487 failures are Spring and Jakarta types
      (`jakarta.persistence` 86, `org.springframework.web.bind.annotation` 82,
      `org.springframework.data.domain` 48, …) whose jars are simply absent; a
      jar that is not there cannot be resolved by any extractor, so 77.8% is a
      structural floor for that corpus, not a defect to fix. This is exactly the
      legacy/non-compilable case M2 exists for, and it is why the stub discipline
      of §5.2 — not the resolution rate — is the property worth asserting.
      `ResolutionRateTest` therefore keeps a deliberately low floor plus
      `unresolved > 0` rather than pinning a number that would pressure someone
      into deleting the unresolvable half of the corpus.

- [x] **Two fabrication bugs found only under real load (M2 audit), both fixed
      and both now in the fixture corpus (`Batch.java`) and
      `ArrayAndAnonymousIdentityTest`.** The fixtures had arrays and an anonymous
      class, but never read `array.length` and never touched an anonymous class's
      own members, so neither was visible:
      (a) an array type owns `length` and `T[]::new`; folding those up to the
      component type produced 8 stub CLASSES named `int`, `boolean`… with a
      fan-in of 44–88, plus 624 access edges claiming dependencies the source
      never wrote — the exact phantom §5.2 forbids by name, reaching the model
      through the one path that never asked the primitive question;
      (b) Spoon's `Outer$N` name for an anonymous class rendered as
      `java:pkg/Outer.N`, giving one declared class two ids and laundering the
      second into a stub inside the corpus's own package (invariant 6 failing
      from the inside). Edges into such a class now name its members precisely.

## 6. Phase 3 — `@codegraph/analyzer`

Input: one or more `model.json` files (multi-language later — union of models).

- [x] **Load & validate** against core (profile-aware). Hard fail on schema
      errors, collected warnings on profile violations (`loadModels`, `isClean`).
- [x] **Graph construction**: entity map by id; **derived inverse indexes**
      (incomingInvocations, incomingAccesses, subtypes, importers…) computed in
      memory, never persisted. `test/no-inverse-index-serialized.test.ts` scans
      every export for an inverse-index key rather than trusting the convention.
- [x] **Closure check**: every edge endpoint / parent / child resolves to a known
      id or a stub — asserted as a property, using core's `unknownReferences`.
- [x] **Queries / analyses**:
      `importGraph` (module→module, the cross-language layer), `typeDependencyGraph`,
      `dependenciesOf`/`dependentsOf`, `neighboursOf` (METAMODEL §9 in one record),
      `coupling` (fan-in/fan-out, Ca/Ce, instability) with `topByFanIn`/`topByFanOut`,
      `cycles` (Tarjan SCC) at module and type level, and the view stack
      (`internalOnly`, `declaredOnly`, `provenanceOnly`, `composeViews`).
- [x] **Exports**: DOT/Graphviz, CSV (folded graph, coupling, cycles) and JSON
      artefacts (GraphML/Mermaid later).

### 6.1 What M3 settled

**Folding aggregates, and keeps what it aggregated.** A `FoldedEdge` carries
`count`, `kinds` and `provenances`; collapsing parallel edges to a bare pair
would discard exactly what makes the result auditable. Self-loops created BY
folding (a method calling a sibling method of its own class) are kept and
flagged — they are cohesion, not the forbidden self-edge of METAMODEL §4.

**Self-loops are excluded from coupling by default, on all four counters
together.** `fanIn`/`fanOut` AND `outgoingEdgeCount`/`incomingEdgeCount` obey
`includeSelfLoops` as a unit, so a row can never read "fanOut 0, outgoing weight
6". Counting a self-loop would give every cohesive class Ce ≥ 1 and Ca ≥ 1 and
instability could never reach 0 or 1. The conservation law follows per mode:
with `includeSelfLoops: true` the row sums equal `diagnostics.foldedEdges`
exactly; by default they equal the non-self folded weight. Both are pinned.

**Tarjan is iterative, with an explicit frame stack.** The recursive
formulation exhausts V8's stack at the ~15 000 nodes commons-lang folds to, and
it fails only on real corpora because every hand-built test graph is shallow.
Guarded by a 20 000-node chain and a 20 000-node ring.

**A stub is its own container at every fold level.** A stub has no parent, so a
stub CLASS becomes its own module node. Consequence, measured on the fixture:
24 of the 27 module-level nodes are external classes. Anything user-facing
should default to `internalOnly` at module level. See the M4 note below.

**An analysis number without its view is not a fact.** `FoldedGraph`,
`CouplingTable` and `CycleReport` all carry `level` and `view`, and every CSV
row repeats them as columns (a `#` comment line is data to an RFC 4180 parser).

- [ ] **KNOWN GAP carried into M4 — stub classes do not fold into their stub
      package.** The extractor emits stub packages (`java:java.util`) and stub
      classes (`java:java.util/List`) as unrelated roots, so the unfiltered
      module graph lists external CLASSES as modules. The import layer is
      unaffected (the extractor already writes imports module→module:
      `nonModuleEndpoints` is 0 on the fixture, gson and commons-lang), but the
      full type-fold at module level is noisier than it should be. The fix is a
      `parent` on stub classes in the extractor, not a special case in the fold.

## 7. Phase 4 — `@codegraph/cli`

✅ Shipped in M4. Every command takes one or more model paths and loads them as
a **union** (decision 5).

```
codegraph validate <model.json...> [--json]
codegraph analyze  <model.json...> --report deps|cycles|coupling [--level module|type]
                                   [--internal-only] [--declared-only] [--json] [--top N]
codegraph export   <model.json...> --format dot|json|csv|plantuml [--level module|type]
                                   [--internal-only] [--declared-only] [--out FILE]
codegraph profiles [--lang java] [--json]        # print a profile spec
```

- [x] `validate` — runs the analyzer's `checkConformance` gate over the union.
- [x] `analyze` — deps / cycles / coupling, at module or type level.
- [x] `export` — DOT, JSON, CSV and PlantUML (class diagram) of the folded
      graph. The PlantUML rendering keeps the DOT encoding: solid arrow =
      all-`declared`, dashed = contains an inference, label = folded count,
      `<<stub>>` = external.
- [x] `profiles` — prints core's profile data; synthesizes nothing.
- [x] `--help` per command, `--version`, and a usage error naming the valid
      values for a bad flag.

Locked behaviour, all covered by the end-to-end binary suite:
- **Exit codes**: `0` ok · `1` internal bug · `2` usage · `3` findings. 1 and 3
  are never conflated, so a CI job can gate on model quality alone.
- **Streams**: stdout is the artifact ONLY; every warning, summary and fold
  diagnostic is stderr. Verified by real shell redirection, not in-process.
- **No ANSI**, ever. **Deterministic**: identical inputs give byte-identical
  stdout.
- **`--json` on every reporting command**, always a self-describing object with
  a `kind` stamp — the same facts as the text form, differently printed.

## 8. Phase 5 — Tests as properties (fast-check)

✅ Shipped in M4 as `checkConformance` (in the analyzer, so the CLI, the property
suite and CI all ask the same question), plus a fast-check property suite.

Invariants from the design doc, run against every extractor output:

- [x] **Closure**: no edge to an unknown id (stubs count as known).
- [x] **No self-reference**: `from !== to` on every edge.
- [x] **Provenance always set**; `candidates` non-empty when present, and
      present only on `dynamic-candidate` edges.
- [x] **Profile validity**: every entity passes `validateEntity`.
- [x] **Anchors**: every edge anchored; spans 1-based, ordered.
- [x] **Duplicate ids**: identical redeclaration is legal (§1.1); only a
      disagreement on kind or trait set is an error.
- [x] **Determinism**: two runs on the same corpus produce identical output.
- [x] Generative side: arbitrary entities from a profile always round-trip
      JSON → validate → JSON.

**Not asserted, deliberately:** that `to` appears in its own `candidates` list.
§4 calls `to` the "best candidate", but measured against real Spoon output
(commons-lang: 361 dynamic-candidate edges) 119 correctly EXCLUDE it — those
resolve to an interface or abstract method, which cannot itself run, so the
candidates are the concrete overriders. The model records no abstractness, so
nothing can distinguish a correct exclusion from a mistaken one; re-instating
the rule requires an abstractness fact in the metamodel first.

Cross-validation strategy (later, when a 2nd Java extractor exists, e.g.
Tree-sitter): Spoon output is the **oracle**; property = Tree-sitter edge set
⊆ Spoon edge set; any gap = a missed resolution case.

## 9. Phase 6 — Model v2: structured identity, JSONL interchange, SQLite store

Motivation (M4 aftermath): extracting apache/fineract produced a 559.5MB
`model.json` — over Node's string ceiling (`0x1fffffe8` ≈ 512MB), so the
analyzer cannot read it at all. Profiling showed ≈76% of the bytes are
repeated strings (edge endpoint ids 186MB, anchor paths 117MB, entity ids +
parents 88MB) with tiny value sets. Design docs, which this phase executes:
**`docs/model-v2-metamodel.md`** (MM-1…MM-5, format-independent) and
**`docs/model-v2-encoding.md`** (JSONL contract + SQLite cache). Clean break
**in place**: `schemaVersion` stays `"1.0.0"` — the format is entirely
internal for now, there is no external consumer to negotiate with, so the
contract changes under the same version and old files are simply
regenerated. No old-format reader (decision below).

The three milestones are sequenced so every one lands green: M5 adds v2
concepts to core while v1 keeps building; M6 is the breaking change; M7 is
additive on top of M6.

### 9.1 M5 — Metamodel v2 (non-breaking preparation)

- [ ] METAMODEL.md amendments: invariant 7 restated — identity is the
      structured key `(lang, module, symbol, disambiguator?)`, rendered ids
      display-only (MM-1); invariant 4 extended to name `parent`/`children`
      (MM-2); vocabularies stated as closed referential sets (MM-3); profile
      validity stated as a function of `(kind, trait set)` (MM-4); §8 split
      into model vs. encodings (MM-5).
- [ ] `core`: `NaturalKey` type + `renderId`; canonical model order defined
      as sort by natural key.
- [ ] `core`: `validateEntity` memoized per `(kind, sorted trait list)` —
      pure speedup, no wire support (MM-4).
- [ ] Property suite: natural-key uniqueness added generatively.
- **DoD**: METAMODEL.md v2 merged; core exports the identity vocabulary;
  the entire v1 suite still green.

### 9.2 M6 — JSONL interchange (the breaking change)

- [ ] `core`: record schemas `Header`/`FileRec`/`EntityRec`/`EdgeRec`/`Eof`
      discriminated on `t`; streaming `readModel`/`writeModel` (line at a
      time, never a whole-document string); `children` key removed from
      `Entity` (`TWithChildren` stays a marker trait); traits inline as int
      arrays into the header's `dict.traits`; every `EntityId`-typed field
      becomes a surrogate int (driven by the `TRAITS` table).
- [ ] `gen:schemas`: one JSON Schema per record type + a prose container
      contract (section order `header → files → entities → edges → eof`,
      reference rules) in `schemas/` — still sufficient for a non-TS
      extractor to self-validate line-by-line.
- [ ] `extractors/java`: canonical sort → surrogate assignment → Jackson
      streaming JSONL writer (removes whole-document buffering); `eof`
      trailer carries counts so truncated runs are detectable.
- [ ] Property suite reformulated over surrogates: closure becomes
      `ref < entities count` checked streaming; truncation detection;
      determinism stays byte-identical output.
- [ ] Fixtures regenerated to `.jsonl`; v1 code path and schema deleted.
- [ ] CLI commands read `.jsonl` streaming.
- **DoD**: fineract extracts to ~90MB `model.jsonl` (~6× smaller) and every
  CLI command completes on it; property suite green on the fixtures,
  commons-lang and fineract.

### 9.3 M7 — SQLite analysis store (`model.db`)

Role split (encoding doc §1): `.jsonl` is the CONTRACT — schema-validated,
diffable, language-agnostic; `model.db` is the WORKBENCH — a derived,
disposable cache, regenerable at any time, never committed, never the
interchange.

- [ ] `analyzer`: `importModel(jsonlPath) → model.db` — DDL of encoding doc
      §3.1 (natural-key unique index, `entity_trait` join table, outgoing
      facts only with `edge_to`/`entity_parent` as storage-level derived
      indexes, rare trait keys in an `extra` JSON column); single
      transaction, prepared statements; `node:sqlite` first,
      `better-sqlite3` fallback.
- [ ] DB-backed graph facade behind the existing analyzer API; metrics
      migrate to SQL (recursive CTEs for cycles/reachability)
      opportunistically, not big-bang.
- [ ] `cli`: `codegraph import`; `analyze`/`export` given a `.jsonl`
      auto-build a sibling `.db` cache (`--no-cache` escape hatch);
      `dbVersion` mismatch in `meta` ⇒ re-import from JSONL — migration is
      regeneration, because the DB is a cache.
- **DoD**: a second `analyze` run on fineract opens the cache without
  re-parsing; every report byte-identical to its M6 (JSONL-only) output;
  ad-hoc SQL cookbook (fan-in, facts-only view, reachability) documented.

## 10. Phase 7+ — Next languages (deferred, contract-ready from day 1)

1. **Clojure** via `clj-kondo --analysis` → thin JSON adapter (near-free; first
   cross-language test on the Import layer; exercises the fn-var case for real).
2. **TypeScript** via the TS compiler API (self-hosting: run codegraph on
   codegraph) — introduces `space: type|value` and declaration merging.
3. **SCIP adapter** (one effort → Rust + TS + Python via existing indexers).
4. **Code city visualization** (`packages/viz`, Three.js + Vite): render the
   analyzed model as a 3D city — districts = modules, buildings = types
   (height/footprint/color mapped to documented metrics), edges as flows.
   Consumes analyzer output only; visual-language rules live in `CLAUDE.md`.

Documented static limits (all languages, per profile `notes`): reflection,
`Class.forName`/Spring XML, service loaders, pre-expansion macro code.

## 11. Milestones

| # | Milestone | Definition of done |
|---|---|---|
| M0 | Bootstrap | workspace builds, CI green |
| M1 | Core metamodel | traits + 9 profiles + validation + JSON Schema, tested |
| M2 | Java extractor | ✅ fixture corpus → valid `model.json`, schema-validated **and profile-validated across the language boundary**, closed graph, 94.1% resolution on the fixtures |
| M3 | Analyzer | ✅ import graph, type deps, cycles, coupling metrics, DOT/CSV/JSON exports; 252 tests; verified end to end on google/gson (3 624 entities) and apache/commons-lang (15 338 entities) |
| M4 | CLI + properties | ✅ `validate`/`analyze`/`export`/`profiles` shipped; conformance gate + property suite green; 1 007 TS tests; verified end to end on apache/commons-lang (15 338 entities / 24 631 edges, every command < 1 s) |
| M5 | Metamodel v2 | METAMODEL.md invariants 4/7 restated + §8 model/encoding split; core natural-key vocabulary, `renderId`, memoized validation; entire v1 suite still green |
| M6 | JSONL interchange | in-place clean break (`schemaVersion` unchanged): streaming reader/writer, per-record schemas, extractor emits `.jsonl`, fixtures regenerated, v1 deleted; fineract (559MB → ~90MB) analyzable end to end |
| M7 | SQLite store | `codegraph import` → `model.db` cache; DB-backed analyzer facade; repeat runs skip parsing; reports byte-identical to M6 outputs |
| M8 | 2nd language | clj-kondo adapter; cross-language import-graph query works |

## 12. Decisions made in this plan (deltas vs. the design doc)

| Topic | Decision | Rationale |
|---|---|---|
| Schema lib | Zod v4 (not Malli) | types + runtime validation + JSON Schema export from one source |
| Interchange | JSON (not EDN), `schemaVersion`-ed | TS-native; JSON Schema is the polyglot contract |
| Traits/profile equality (open point §2) | `required ⊆ traits ⊆ required ∪ optional` | strict equality breaks on TComment; free subset hides extractor bugs |
| Marker traits | `TWithInvocations` etc. contribute no keys | edge lists live in `edges[]`, not on entities — keeps entities flat and avoids duplication |
| Java extractor language | Java (Maven) subproject, JSON out | Spoon is a JVM lib; the TS side stays extractor-agnostic |
| Lang ids (M1 review) | frozen as declared, abbreviations kept (`clj`/`js`/`ts`) | the lang id is the EntityId prefix — renaming one invalidates every id an extractor has emitted |
| Stub containment (M3 review) | a stub type carries `TChildOf` → its stub **module**; never a corpus one, and never for primitives or in-corpus phantoms | the analyzer folds to module level by walking `parent` and may not parse ids; the alternative — a stub being its own container at every level — put classes and primitives into module graphs (88% of gson's module nodes were not modules) |
| Profile `space` (M1 audit) | `space?` declared per kind on the Profile, not only on the Entity | METAMODEL §1.4's "only meaningful in profiles that declare it" is otherwise unenforceable |
| Trait keys in the published schema (M1 audit) | re-stated as `if/then` conditionals generated from `TRAITS` | Zod refinements do not survive `z.toJSONSchema()`; without them the contract accepted `{traits:["TNamed"]}` with no `name` |
| Identity v2 (fineract audit) | structured key `(lang, module, symbol, disambiguator?)`; rendered id strings are display-only, never stored or compared | 559MB model.json broke Node's 512MB string ceiling; ≈76% of the bytes were repeated id/path strings |
| Interchange v2 | JSONL: surrogate ints for all intra-model refs, header dictionaries for closed vocabularies, file-path table, `eof` count trailer; in-place clean break, `schemaVersion` kept at 1.0.0, no old-format reader | streaming in both directions kills the ceiling; ~6× smaller; extractor bar stays "anything that prints JSON lines"; the format is internal-only — bumping a version nobody consumes buys nothing |
| `children` serialization (v2) | dropped — derived from `parent` like every other inverse index | invariant 4 already forbade serialized inverses; v1 carrying it was an inherited inconsistency (and 12MB on fineract) |
| SQLite (v2) | `model.db` is a derived, disposable analyzer cache built by `codegraph import` — never the contract, never committed | queryable/incremental/random access for CLI + future viz without sacrificing diffable fixtures, byte-determinism, or the any-language extractor bar |
| Trait-set interning (v2) | rejected — traits ride inline as int arrays; MM-4's validate-once-per-set is reader-side memoization | set indirection saved ~4MB on a ~90MB file but cost a record type, a dedup pass in every extractor, and lines unreadable in isolation |
