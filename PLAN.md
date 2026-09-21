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
- [x] **CLOSED (M7) — the lambda id disambiguator was too coarse.**
      `Type#file:startLine` could not separate two nameless entities that START
      ON THE SAME LINE (`chain(() -> a, () -> b)`), so they shared an id and the
      first in AST order won: one real entity was absent from the model and
      nothing distinguished that from an entity never written.

      **It was worse than a missing entity.** A nameless entity written INSIDE
      another on the same line took the outer one's id as its `parent`, so the
      model contained an entity that was ITS OWN PARENT — a containment cycle no
      analysis walking `parent` survives, and one `validate` could not see.
      Found on apache/fineract at
      `json -> gson.fromJson(json, new TypeToken<HashSet<JobParameterDTO>>() {})`:
      a lambda and an anonymous class, both starting on line 79.

      The id now carries the COLUMN — `Type#file:line:column`. A column is a
      source FACT; an ordinal would have made the id depend on the order the
      extractor happens to walk the AST, so an unrelated change could renumber
      a corpus. What the corpora recovered:

      | corpus | entities | edges |
      |---|---|---|
      | fixtures/java | 166 → 167 | 173 → 175 |
      | apache/commons-lang | 15 338 → 15 362 | 24 631 → 24 648 |
      | apache/fineract | 240 929 → 241 101 | 782 032 → 782 046 |

      Both corpora still validate clean, and fineract now has zero containment
      cycles. `StubDisciplineTest.everyNamelessEntityOnASharedLineGetsItsOwnIdentity`
      replaced the pinned-loss test, as that test's own doc instructed, and
      `noEntityIsItsOwnParent` guards the consequence.
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
      `cycles` (Tarjan SCC) at module and type level — each SCC carrying its
      minimum feedback set and tangle metric (weighted ELS-GR + minimality
      pass, `metrics/tangle.ts`; pinned in `tangle.test.ts` and the property
      suite) — and the view stack
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
**`docs/model-metamodel.md`** (MM-1…MM-5, format-independent) and
**`docs/model-encoding.md`** (JSONL contract + SQLite cache). Clean break
**in place**: `schemaVersion` stays `"1.0.0"` — the format is entirely
internal for now, there is no external consumer to negotiate with, so the
contract changes under the same version and old files are simply
regenerated. No old-format reader (decision below).

The three milestones are sequenced so every one lands green: M5 adds v2
concepts to core while v1 keeps building; M6 is the breaking change; M7 is
additive on top of M6.

### 9.1 M5 — Metamodel v2 (non-breaking preparation)

✅ Shipped. The wire format is untouched (`schemas/` regenerated to a byte-identical
file); what changed is what the vocabulary MEANS, so M6 has something to encode.

- [x] METAMODEL.md amendments: §1.1 restated — identity is the structured key
      `(lang, module, symbol, disambiguator?)`, rendered ids display-only
      (MM-1); §4 extended to name `parent`/`children` (MM-2); §5.1 vocabularies
      as closed referential sets (MM-3); §5.2 profile validity as a function of
      `(kind, trait set)` (MM-4); §8 split into 8a model vs. 8b encodings
      (MM-5). CLAUDE.md invariants 4 and 7 restated to match.
- [x] `core`: `packages/core/src/identity.ts` — `NaturalKey` (type + Zod
      schema), `renderId`, `naturalKeyIndex`, `naturalKeysEqual`,
      `compareNaturalKeys`/`sortByNaturalKey` (canonical order),
      `duplicateNaturalKeys`, `naturalKeyIssues`.
- [x] `core`: `validateEntity` split into a memoized `(kind, trait set, isStub)`
      verdict and the per-entity value checks (MM-4).
- [x] Property suite: natural-key uniqueness generatively, plus rendering
      injectivity and canonical order as a total order.
- **DoD met**: METAMODEL.md v2 merged; core exports the identity vocabulary;
  the entire v1 suite still green (1 089 TS tests, `pnpm -r build` clean,
  `./mvnw package` clean, `schemas/` unchanged).

**Decision (M5) — separators are reserved so rendering is injective.** A key
whose `module` contained `/`, or whose `symbol` contained `#`, would render as
some *other* key's id, and the two entities would silently merge — the M2
`archive(List)` collision (§4.6) one level up, where it again costs a whole
entity with no error. `renderId` therefore validates and throws rather than
rendering a lossy id. Pinned by an exhaustive test over an alphabet built from
the separators themselves plus their concatenations: an alphabet of unrelated
words let a deliberately broken renderer pass, which is why the generated
pieces are `a`, `b`, `a.b`, `a/b`, `ab`.

**Decision (M5) — a module names ITSELF in the `module` component**, with an
empty `symbol`, rather than referencing its parent module as the design doc's
MM-1 first drafted. The parent form renders `java:com.acme.order` as
`java:com.acme/order`, breaking the frozen id scheme, and needs a fabricated
`java` module to place the stub package `java:java.util` whose parent no corpus
declares — the fabrication METAMODEL §6 exists to prevent. Consequence for M6:
a package record's `m` surrogate points at its own row.

**Note — MM-4's memo key carries `isStub` and the profile.** Validity is a
function of `(kind, trait set)` only *within* one profile and one side of the
stub exemption (§6 waives the lower bound for stubs). Both bounds are pinned by
tests that fail if the key is narrowed.

### 9.2 M6 — JSONL interchange (the breaking change)

✅ Shipped.

- [x] `core`: record schemas `HeaderRec`/`FileRec`/`EntityRec`/`EdgeRec`/`EofRec`
      discriminated on `t` (`wire.ts`); streaming codec (`jsonl.ts`) and file
      I/O (`jsonl-file.ts`); `children` key removed from `Entity`
      (`TWithChildren` stays a marker trait); traits ride as int arrays into
      the header's `dict.traits`; every `EntityId`-typed field is a surrogate
      int, driven by `ENTITY_REFERENCE_KEYS` so a new referencing trait cannot
      be forgotten.
- [x] `gen:schemas`: one JSON Schema per record type + a GENERATED container
      contract (`schemas/README.md`) for what a single line cannot express —
      section order, dict resolution, trait keys, closure, canonical order.
      Its trait/key table is printed from `WIRE_TRAITS`, so the published rules
      cannot drift from the code that enforces them.
- [x] `extractors/java`: `NaturalKey` + canonical sort → surrogate assignment →
      streaming `JsonlWriter` (one Jackson generator, one line at a time);
      `eof` trailer carries counts.
- [x] Property suite reformulated over surrogates: closure as
      `ref < entities count` checked as references resolve; truncation
      detection (every proper prefix must be refused); determinism as
      byte-identical output *whatever order the extractor emitted*.
- [x] Fixtures regenerated to `.jsonl`; the v1 document path and
      `schemas/model.schema.json` deleted.
- [x] CLI reads `.jsonl` through a CHUNKED SYNC reader — the ceiling is one
      JavaScript string, not sync I/O, so the CLI stays synchronous end to end
      instead of every command becoming async to buy nothing.
- **DoD met**, measured:

  | corpus | v1 | v2 | commands |
  |---|---|---|---|
  | fixtures/java | 155KB `model.json` | 41KB `model.jsonl` (3.8×) | all |
  | apache/commons-lang | 17.1MB | 6.9MB (2.5×) | all, < 1 s each |
  | apache/fineract | **559.5MB — unreadable** | **127.4MB (4.4×)** | all, 11–12 s, ≤ 1.6GB RSS |

  Fineract extracts in 94 s (240 929 entities / 782 032 edges, 0 edges dropped)
  and `validate` reports a clean bill of health. The 127MB is short of the
  ~90MB the encoding doc estimated — the estimate assumed more of the file was
  id strings than it is — but the number that mattered was never the ratio: v1
  could not be READ at any size, and now it can.

  Regression check on commons-lang: the v2 model has the **same 15 338 entity
  ids and the same 24 631 edges** as the v1 extraction, byte-for-byte identical
  content modulo the two intended metamodel changes below. The format changed;
  what the extractor claims did not.

**Decision (M6) — closure is enforced at WRITE time, not reported after.** A
reference is a surrogate into the file's own entity section, so "points at
nothing" is not expressible. Consequences, all deliberate:
- the extractor gained a pass 4.5 that DROPS an edge whose endpoint nothing
  declares, and counts it on stderr (0 on the fixtures, commons-lang and
  fineract) — v1 wrote such an edge and left the analyzer to report it;
- a dangling reference in a FILE is now a malformed file (a schema error),
  not a finding about a valid one. `LoadDiagnostics.danglingReferences`
  survives for models built in memory, and the CLI still exits 3 either way;
- cross-model references are gone too: each model is closed on its own, and a
  reference to another language's entity is a STUB that the union merges by
  natural key. That is the stub discipline of METAMODEL §6, applied to the
  multi-language case.

**Decision (M6) — a stub's MODULE is materialized even when its PARENT is
refused.** Identity names a module (MM-1), so an entity whose module is not
declared cannot be written at all; containment is a separate claim, and §6.1's
two refusals (a corpus-declared package, the unnamed package) still stand. The
two questions were conflated before because nothing forced them apart.

**Bug found by fineract, fixed — the corpus whitelist claimed types the corpus
never wrote.** `CorpusWhitelist` walked every `CtType` Spoon exposed, including
the SHADOW types noClasspath materializes for unresolvable references
(`jakarta.ws.rs.core.MediaType`, `java.math.BigDecimal`, …). The entity pass
correctly refused them — no source position, so no evidence — and the stub pass
then refused to degrade them ("declared by the corpus but never emitted"),
leaving every reference to them dangling. Under v1 those became dangling
references; under v2 the model could not be written. The whitelist now asks the
same "is it written here?" question the entity pass asks, which is what its own
contract already demanded.

**Bug found by fineract, fixed — `entities.push(...model.entities)`.** A spread
passes one ARGUMENT per element, so the union overflowed the call stack at
240 929 entities and `validate` reported an internal error. It fails long before
memory does, and no test-sized graph reaches it; `packages/analyzer/test/scale.test.ts`
now unions a 200 000-entity model.

**Bug found by MM-2, fixed — executables never declared themselves containers.**
A method's parameters and locals carry `parent`, but `method`/`constructor`/
`lambda` carried no `TWithChildren` and no `children`, so METAMODEL §3.2's "both
stored, must agree" was false for every method with a parameter. v1 could not
see it: the check only looked at entities that HAD a `children` key. The Java
profile now licenses `TWithChildren` on the three executable kinds and the
extractor emits it (4 795 entities on commons-lang).

### 9.3 M7 — SQLite analysis store (`model.db`)

Work in progress. Design settled by a scout-and-judge pass over the code
(4 readers → 3 independent proposals → one synthesis); the recommendation is
**cache the parse, not the graph** — `model.db` replaces the JSONL decoder and
nothing above it, so byte-identity is arithmetic rather than vigilance.

Measured on apache/fineract, which is why:

| stage | time | |
|---|---|---|
| decode JSONL | 7.1 s | the dominant cost |
| `parseModel` (Zod over the whole Model) | 2.6 s | redundant — the decoder already validated every record |
| `validateModel` (profile) | 1.3 s | real work |
| `unknownReferences` (closure) | 0.8 s | redundant since M6 — a dangling surrogate is unreadable |
| `buildGraph` | 0.6 s | real |
| fold + coupling + cycles + export | 0.2–0.6 s each | real |

**≈93% of a command is decode-and-revalidate; the analysis itself is under a
second.** Pushing metrics into SQL would optimise the 6% that is not the
problem.

Steps landed:

- [x] **Step 1 — split parse from unify** (`12c07f6`). `loadDecodedModels` runs
      the unify and diagnose halves only; `loadModels` keeps its signature as
      `parseModel` then that, for raw JSON and in-memory models. The CLI reads
      through core's decoder, so it uses the new entry point. Profile
      validation, closure over the union, self-edges and cross-model
      redeclaration all still run — `load-equivalence.test.ts` pins that both
      entry points agree, and catches divergence (verified by mutation).
      fineract `analyze`: **11.50 s → 9.13 s, 1 438 MB → 1 099 MB**, all 32
      baseline outputs byte-identical.
- [x] **Step 2 — freeze the two order contracts**, on pre-DB code, because the
      store is what will break them.
      - `fold-order-contract.test.ts`: no rendering depends on the order edges
        ARRIVED in. A `FoldedEdge` aggregates `kinds`/`provenances` into Sets,
        and a Set iterates in insertion order; today that is the decoder's
        canonical order, and a query planner's order is not. Asserted over the
        real pipeline at both levels and under a view, for DOT, PlantUML, CSV,
        JSON, cycles and coupling — and pinned as non-vacuous, since a
        single-member Set has no order to get wrong. Unsorting any of the four
        exporters fails it.
      - `fixtures/unicode/` + `collation-contract.test.ts`: canonical order is
        by UTF-16 CODE UNIT (`compareIds`), SQLite's `BINARY` collation is by
        UTF-8 BYTE. They agree across the BMP and invert above it — `𠀀…`
        (U+20000) leads with code unit `D840` but byte `F0`, while `Ａ…`
        (U+FF21) leads with `FF21` but `EF`. Both are legal Java identifier
        letters, so it is a corpus someone could write. The committed reference
        report is the artefact every later step is diffed against.

      **The rule both contracts state: sorting belongs to the model, never to
      the storage engine.** A query needing canonical order sorts in TypeScript
      or `ORDER BY`s a column the importer wrote in canonical order.

- [x] **Step 3 — expose core's validated wire-record stream.** `ModelDecoder`
      did two jobs: validating the wire, and materializing a `Model`. They are
      now `RecordReader` and `ModelBuilder`, and `readModelRecordsSync(path)`
      yields validated records without building anything — the importer writes
      rows as they go by and never holds the corpus. `readModelFileSync` is a
      consumer of that same stream, which is what makes the two readers ONE
      reader rather than two that drift.

      The trait-key rule moved from materialization into the reader, so it is
      now reported with its line number and holds for every consumer.

      `record-stream.test.ts` states the property as equivalence: nine broken
      files — not JSON, not a record, truncated, miscounted eof, dangling edge
      surrogate, missing trait key, forward module reference, empty, headerless
      — must be refused by BOTH routes with the identical message on the
      identical line. Plus the case that motivates the whole step: a truncated
      file is still a sequence of perfectly good JSON lines, so a hand-rolled
      `JSON.parse`-per-line importer accepts it happily and stores a corpus
      silently missing its tail.

      Measured on fineract (241 101 entities / 782 046 edges), separate
      processes: **stream 4.6 s at 140 MB peak; materialize 6.8 s at 555 MB.**
      Validating costs a quarter of the memory of keeping.

- [x] **Step 4 — one load site for Node's SQLite builtin.** `loadSqlite()` in
      `analyzer/src/store/sqlite.ts` patches `process.emitWarning`, loads via
      `createRequire(import.meta.url)`, restores in a `finally`, and memoizes.
      Three independent reasons it cannot be a static import, in increasing
      severity:

      1. ESM evaluates every `import` declaration before any statement of the
         importing module body, so the ExperimentalWarning is already on stderr
         by the time a patch could exist — and several CLI end-to-end tests
         assert `stderr === ""` on the built binary.
      2. `await import()` loads late enough but is async, and the read path is
         synchronous end to end; one `await` would reach `main`.
      3. esbuild rewrites a static `from "node:sqlite"` to `from "sqlite"` in
         the tsup output, stripping the `node:` prefix. Harmless for most
         builtins — `node:fs` and `fs` both resolve — and fatal for this one,
         which is prefix-only. **Verified by mutation: the built CLI then does
         not start at all.** The specifier inside `require()` is opaque to the
         bundler and survives verbatim.

      The returned `SqliteApi` is written from the store's needs (`exec`,
      `prepare`, `run`/`get`/`all`/`iterate`, `close`) rather than re-exporting
      the builtin's types, so PLAN's `better-sqlite3` fallback stays a matter of
      satisfying one interface at one site. `open()` passes `options ?? {}`:
      the builtin validates by ARITY, so an explicit `undefined` is not an
      omitted argument and throws.

      Two tests, because neither sees the other's failure. `store-sqlite.test.ts`
      spawns processes — stderr is only observable in one — and asserts the load
      is silent, that a static import of the same builtin is NOT silent (the
      control, so the guard cannot die quietly on a future Node), and that
      `emitWarning` is restored identically. `source-hygiene.test.ts` asserts
      that exactly one source file in the workspace names the builtin at all,
      which is the failure a stderr assertion cannot see: a second, equally
      quiet loader free to drift from the first.

      Also stated against the real engine for the first time: `ORDER BY` under
      BINARY collation really does return the unicode fixture's ids in a
      different order than `compareIds`, and ordering by the surrogate the
      importer assigned restores it. Step 2 proved that with `Buffer.compare`,
      a model of SQLite; this proves it with SQLite.

- [x] **Step 5 — freeze the DDL, against M6 rather than the sketch.**
      `analyzer/src/store/schema.ts` holds the schema, the open options, the
      `meta` key set, and the key→storage mapping. Four things the M6 wire
      changed about docs/model-encoding.md's earlier sketch:

      1. `module_id INTEGER **NOT NULL**` — `m` is required on every entity
         record and a module names itself, so the sketch's "NULL for root
         modules" case no longer exists.
      2. `entity_trait(entity_id, trait_id)` → an interned `trait_set`.
         Measured: **15 338 entities / 15 distinct trait sets** on commons-lang,
         **241 101 / 18** on fineract, so the join table would carry ~1.3M rows
         to say 18 things. Size is the smaller half — MM-4 makes profile
         validity a function of `(kind, trait set)` and core's validator already
         memoizes on that key, so the interned id IS the key. `ord` is kept so
         an entity's `tr` array re-encodes exactly.
      3. **No UNIQUE natural key and no `CHECK (to_id <> from_id)`.** Duplicate
         identities and self-edges are conformance FINDINGS; a store that
         refused to cache them would make `import` fail on exactly the models
         `validate` exists to report on. Same rule as step 3: two gates on one
         format drift.
      4. Array-valued keys get ordered tables (`entity_comment`,
         `entity_defined_in`, `entity_parameter`, `entity_local_variable`,
         `edge_candidate`) rather than JSON, so they stay joinable; `extra`
         holds only keys `core` does not type, since records are loose by design.

      Two things the implementation turned up that reasoning had not.
      **Foreign keys are a decision, not a default:** SQLite's default is OFF
      and Node's builtin overrides it to ON, so `STORE_OPEN_OPTIONS` states it —
      off, because `parent`/`declaredType` legitimately point forward and
      immediate constraints would reject valid models, while closure is already
      the reader's guarantee. `PRAGMA foreign_key_check` still audits a suspect
      cache, which `foreign_keys = ON` would not.
      And one addition to `core`: **MM-3 says a vocabulary is a SET**, so
      `RecordReader` now refuses a header dictionary that repeats an entry — a
      repeat makes two indices name one thing, which any interning store breaks
      on. It is a property of the file, so it belongs in the reader; stated
      there, both read routes refuse it identically.

      `store-schema.test.ts` (17) asserts everything against a REAL database
      created from the DDL, never against its source text: a `sqlite_master`
      snapshot of the effective schema; the invariant-4 guard (`edge_to` and
      `entity_parent` are indexes, no table name reads as an inverse); the
      "caches what the reader accepts" rule as behaviour, by inserting a
      duplicate natural key and a self-edge; and the drift guard — every key
      `WIRE_TRAITS` and the record schemas can carry maps to a real column of a
      real table, so adding a trait key to `core` fails the store until someone
      decides where it goes.

      Five mutations, each caught by the intended test — and S3 (making the
      natural key UNIQUE) exposed a defect in the test itself: the duplicate it
      inserted differed only by a NULL disambiguator, and SQLite treats NULLs as
      distinct in a unique index, so it would have passed either way. Now the
      duplicate carries a disambiguator, with the NULL case asserted alongside.

Remaining steps (from the synthesis, unchanged):


Role split (encoding doc §1): `.jsonl` is the CONTRACT — schema-validated,
diffable, language-agnostic; `model.db` is the WORKBENCH — a derived,
disposable cache, regenerable at any time, never committed, never the
interchange.

- [x] **Step 6 — `importModel(jsonlPath) → model.db`, and its exact inverse.**
      Driven by `readModelRecordsSync`, one transaction, prepared statements;
      the corpus is never held. `readStoreRecords(db)` yields the wire records
      back out, so losslessness is an EQUALITY rather than a checklist:
      `[...readStoreRecords(db)]` must equal `[...readModelRecordsSync(path)]`,
      record for record. **1 029 842 records identical on fineract.**
      `hydrateModel` is that stream fed to core's own `ModelBuilder` — the same
      one `readModelFileSync` uses, so a model from the cache cannot diverge
      from one off disk.

      The acid test earned its name on the first run, finding two real bugs of
      one kind: **an empty array and an absent key are the same rows.**
      `definedIn: []` writes nothing to `entity_defined_in`, exactly like an
      entity with no `TModule` — and the fixture has a stub module that proves
      it. Presence now comes from the TRAIT SET, which is where the wire keeps
      it (`TComment` contributes `comments`, so carrying the trait IS carrying
      the key). `candidates` is the one array-valued key no trait contributes,
      so `edge.candidate_count` records its presence: NULL absent, 0 empty.

      Measured on fineract (241 101 entities / 782 046 edges):

      | | time | peak RSS |
      |---|---|---|
      | import (once) | 9.0 s | 289 MB |
      | read the model from `.jsonl` | 6.4 s | 701 MB |
      | hydrate the model from `.db` | 3.6 s | 592 MB |
      | fan-in top 20, in SQL | 0.04 s | — |

      **The finding that redirects step 7: the win is not hydrating faster, it
      is not hydrating at all.** Full hydration was first measured at 7.6s —
      SLOWER than reading the text — and only beats it after switching the bulk
      queries to `setReturnArrays(true)` (1 023 147 rows: 3.83s as objects,
      1.46s as arrays). Even at 3.6s that is a 1.8× constant, where the same
      question asked in SQL is 0.04s against 6.4s. A DB-backed facade that
      begins by rebuilding the whole `Model` gives up the actual win.

      Two smaller decisions, both measured: indexes are created AFTER the
      inserts (10.75s → 9.0s, 178.4MB → 169.8MB), and atomicity comes from a
      rename rather than from the journal, which is what makes
      `journal_mode = OFF` safe.

      Four mutations. Dropping `space`, inferring list presence from rows, and
      ordering entities by `symbol` instead of by surrogate were all caught.
      The fourth — writing straight to the target with no temp file — was NOT,
      because deleting the target on failure also "leaves no database". The
      property that separates them is the one users feel: a failed re-import
      must not cost you the cache you had. Now asserted.
- [x] **Step 7 — fold in SQL.** `foldFromStore(db, options)` answers in SQL
      what `foldGraph` answers in JavaScript. Fold is the FUNNEL — coupling,
      cycles, DOT, PlantUML, CSV and JSON all consume a `FoldedGraph` and look
      at nothing else — so this is the one place worth moving, and everything
      downstream gets it unchanged.

      Measured on fineract, all eight (level × view) combinations in parity:

      | | in memory | from the store |
      |---|---|---|
      | prepare (build graph / open) | 9.0 s | ~0 s |
      | fold, module level | 0.4 s | 1.4 s |
      | fold, type level | 0.5–1.0 s | 1.5–1.6 s |
      | **total** | **9.4 s** | **1.4 s** |

      Stated honestly: the SQL fold is SLOWER per call — the win is entirely in
      not needing the 9s graph build, so a caller that folded many times would
      amortize the other way. Each CLI invocation folds once. The 782 046 base
      edges never enter JavaScript; only the ~20 000 aggregated ones do.

      Containers are resolved by a FIXPOINT over `parent_id`, not a recursive
      CTE: measured 0.38s against 1.06s, because the CTE re-walks each chain
      from every descendant. The loop ends when a pass adds nothing, so a
      malformed parent cycle terminates — its members just never resolve, which
      is what the in-memory walk also does.

      **It refuses rather than approximates.** A view is an arbitrary predicate
      pair; SQL cannot run one. `translateView` translates the ones a view
      NAMES through `ViewDescriptor.filters` (`internalOnly`, `declaredOnly`,
      `provenance:…`) and returns `undefined` for anything else, so the caller
      hydrates. A facade that quietly answered a slightly different question
      would be worse than none: the numbers would still look like numbers.

      `assembleFoldedGraph` was extracted from `foldGraph` so both producers
      sort, index and freeze through one function — the step-3 rule applied to
      a second producer.

      `store-fold.test.ts` (22) compares whole graphs — nodes, edges, counts,
      kind/provenance sets, diagnostics — for both levels × five views, plus
      self-loop dropping, edge-kind filtering, and the unicode fixture. Then it
      proves the payoff rather than assuming it: DOT, PlantUML, CSV, JSON,
      coupling and cycles byte-identical from either fold.

      Four mutations; two exposed gaps rather than confirming coverage.
      Silently accepting an untranslatable view, and miscounting
      `droppedEdges`, were caught. Restricting the container walk to
      view-included entities was caught only after being rewritten to break
      chains DURING resolution — the first version deleted already-resolved
      rows and was a no-op. And deciding "is this its own module?" by comparing
      SYMBOLS instead of surrogates passed everything: no fixture had a type
      whose symbol equals its module's path. That case now exists, because
      getting it wrong renders a class as its own package — two entities, one
      id.
- [x] **Step 8 — diagnose from the store.** `diagnoseStore(db)` returns the
      `LoadDiagnostics` `loadDecodedModels` returns, computed by query rather
      than by walking entities. The store is not asked to REMEMBER a diagnosis
      — a cached verdict inside a cache is a second thing to invalidate — it is
      asked to answer one.

      **MM-4 is what makes it cheap.** Profile validity is a function of
      `(kind, trait set, isStub)`, and the store interns trait sets, so
      `SELECT DISTINCT kind_id, trait_set_id, is_stub` is 23 rows over
      fineract's 241 101 entities. Each verdict comes from
      `entityCompositionVerdict` — now exported from core, the same memoized
      function `validateEntity` calls — and a verdict with no issues needs no
      entities at all, so a clean corpus enumerates nothing. `edge-kind-not-
      allowed` is likewise a function of six values, not 782 046 edges.

      Measured on fineract: **0.46 s from the store against 2.10 s in memory,
      and that 2.10 s needs a 6.21 s read first** — 8.3 s → 0.46 s.

      One check is skipped and says so: the per-entity Zod parse of each
      declared trait's keys, which is the bulk of the in-memory cost. It cannot
      fail on a model that reached a store, because the record reader enforced
      `WIRE_TRAITS` at import. That is an argument, so it is a test — every
      trait's key set is pinned to match between `TRAITS` and `WIRE_TRAITS`, and
      a value the model schema rejects is shown to be refused on the wire.

      Self-edges are the one diagnostic needing whole `Edge` objects, so when
      one exists the model is hydrated and core's `selfReferences` answers.
      A self-edge means the corpus is already broken; paying a hydrate there
      costs nothing on every correct run, and beats a second edge constructor
      drifting from `ModelBuilder`'s.

      **Both real corpora are clean, so parity on them proves almost nothing** —
      returning "no issues" unconditionally would pass. Every category is
      therefore exercised on a model broken on purpose, each asserting the issue
      exists before asserting the two paths agree about it.

      Four mutations; two exposed gaps, and building the case for a third found
      a real bug. Comparing interned `trait_set_id`s instead of the canonical
      trait SET was caught (two declarations differing only in trait ORDER are
      the same declaration). Dropping the emission order was NOT — until a model
      existed with issues from two categories landing in the opposite order.
      Constructing it surfaced the bug: `isStubEntity` is "declares TType or
      TModule AND isStub is true", and reading the `is_stub` column alone calls
      an entity a stub that the in-memory path does not — which flips the
      composition verdict, since the trait lower bound is waived for stubs. And
      the unknown-profile branch was returning no `duplicateIds`, where the
      in-memory path computes them regardless of profile; the test passed only
      because no fixture had a duplicate.

- [x] **Step 9 — `codegraph import`.** The explicit command:
      `codegraph import <model.jsonl...> [--out FILE] [--json]`. It is
      unconditional — the user asked for a store, so they get a fresh one, and
      nothing here guesses whether the old one was still good. That question
      belongs to the automatic cache, which has to answer it unasked.

      **One model per store.** Every other command unions its positionals; this
      one deliberately does not, because surrogates are file-scoped and are not
      identity (MM-1), so a union would mean renumbering — and a renumbered
      corpus is a repointed one. Several paths mean several imports, and `--out`
      with more than one is a usage error rather than a silent choice.

      Two decisions the CLI's own contracts forced:

      - **stdout says what is true of the STORE; stderr says what was true of
        the RUN.** SQLite promises no byte-determinism (page allocation varies)
        and a duration never could, so the size and the timing must not reach
        the stream `e2e-determinism` compares.
      - **A file that is not a model is a FINDING, not a crash.** Left
        unhandled, the record reader's `JsonlError` escaped to `main` and was
        reported as "an internal error — a bug in codegraph", blaming the tool
        for the user's file. It now exits 3 with the reader's own message, and
        one run reports every bad path while still importing the good ones —
        the same choice `loadModelFiles` makes for the reading commands.

      Exit 3 also covers a model that reads fine but breaks its profile: the
      store IS written and usable (refusing to cache what `validate` exists to
      describe would be the second gate this project keeps declining to add),
      and the exit code still says something is wrong. Step 8 makes that check
      affordable — `diagnoseStore` on fineract costs ~0.5s, not 8s.

      Also fixed: the 20 000-entity round-trip from step 6 was FLAKY. It takes
      ~0.4s alone but exceeded vitest's 5s default under the contention of
      `pnpm -r test`, where several packages' workers share one machine. A test
      that fails on a busy CI box and passes on a quiet one teaches nobody
      anything, so its budget is now stated.

- [x] **Step 10 — the automatic cache.** `analyze` and `export` given a
      `.jsonl` build the sibling `.db` if they must, reuse it if they can, and
      answer from it. `--no-cache` reads the model directly.

      Measured on fineract, `analyze --report deps`:

      | | wall | peak RSS |
      |---|---|---|
      | first run (builds the store) | 14.9 s | 268 MB |
      | **second run (reuses it)** | **1.9 s** | **163 MB** |
      | `--no-cache` | 11.8 s | 1 094 MB |

      **6.3× faster and 6.7× less memory**, and the 19 090-line report is
      byte-identical to the one the model produces.

      `AnalysisSource` (cli/src/source.ts) is the seam: neither command
      branches on where the answer came from, so there is no second formatting
      path to keep in step. The cache is used only when it can be EXACT — one
      model (a store holds one; a union would mean renumbering), no
      `--no-cache`, a writable store, and a view SQL can translate. Every
      other case falls back to what was there before, so the worst case is the
      old speed, never a different number. `importGraphFromStore` was added so
      `deps --level module` — the most-used report and the one cross-language
      layer — is not the single command that has to hydrate.

      Three things this found, two of them real bugs:

      1. **`open: false` does not mean "do not create".** In Node's SQLite it
         means "construct the handle but defer opening", so every freshness
         query threw, every store read as unreadable, and **the cache rebuilt
         itself on every run while looking like it worked.** Only the
         determinism suite noticed — via the elapsed time it printed.
      2. **A model the reader refuses was crashing.** `openCache` rethrew
         `JsonlError`, which reached `main` as "an internal error — a bug in
         codegraph", blaming the tool for the user's file. A refused model is
         now simply a reason to have no cache; the reading path reports it as
         a finding, with the reader's own message and exit 3.
      3. **stderr is a diffed stream.** `e2e-determinism` says so and explains
         why — an elapsed-time figure turns every CI log into a false diff —
         so the cache note is one line, `cache: <path>`, identical whether the
         run built the store or reused it. Whether *this* invocation paid for
         the import is a performance detail, and `codegraph import` is the
         command that reports it.

      Staleness is size and mtime, not a content hash: hashing 133 MB costs
      more than the parse the cache exists to avoid, which would make the check
      more expensive than the miss. The trade is stated rather than hidden, and
      both halves are tested — a changed model AND a model rewritten to the
      same size with a later timestamp. `*.db` is gitignored: the store is
      derived and disposable, and a binary beside the `.jsonl` in git would be
      a second, undiffable answer to the same question.
- [x] **Step 11 — the SQL cookbook.** `docs/sql-cookbook.md`: orientation,
      two setup views that turn surrogates into rendered ids, and recipes for
      fan-in, fan-out, facts-only, traits, modules, the import graph,
      reachability, module cycles, evidence and uncertain dispatch — plus the
      four rules a query must respect and the list of questions to ask
      `codegraph` instead.

      **The cookbook is executable.** `sql-cookbook.test.ts` extracts every
      ```sql block and runs it in document order against a store built from the
      committed fixture, because a recipe that has rotted still LOOKS like SQL
      and the reader finds out at a prompt rather than in review. Three claims
      the document makes about agreeing with `codegraph` are checked as
      equalities, not for syntax: the `node` view reproduces `renderId` for all
      167 ids in order, the fan-in recipe counts what the model's edges count,
      and the cycle recipe agrees about cycles.

      Two mutations. Breaking a recipe fails three tests. **Rendering the
      self-module test by SYMBOL instead of surrogate did not** — the same
      hazard that survived step 7's parity suite, now living in the
      documentation, where it would have taught the wrong idiom. The namesake
      corpus is now built here too.

      Written while checking rather than asserting: `module_id` and the fold's
      container walk agree for every entity that resolves on both corpora (0
      disagreements), but they differ where the walk ends with NO container and
      `module_id` always points somewhere — the fixture has 2 such entities. The
      document says so rather than implying they are the same question.

---

### M7 — definition of done

**Every clause verified on apache/fineract (241 101 entities / 782 046 edges),
not asserted.**

| DoD clause | evidence |
|---|---|
| a second `analyze` opens the cache without re-parsing | cold 10.9 s / 241 MB → **warm 1.96 s / 114 MB**; `--no-cache` 9.8 s / 1 053 MB |
| every report byte-identical to its JSONL-only output | **12 of 12**, `cmp`-verified: 8 `analyze` variants and 4 `export` formats, 486 000+ lines including `deps --level type` at 124 266 lines and `export --format json` at 134 077 |
| ad-hoc SQL cookbook documented | `docs/sql-cookbook.md`, every query executed by a test |

The cache is **5× faster and 9× lighter** on the report that motivated M7, and
the whole M6 → M7 arc takes `analyze` on fineract from 11.5 s / 1 438 MB to
1.96 s / 114 MB — **5.9× faster on 12.6× less memory**, with the answer
unchanged to the byte.

What the eleven steps actually bought, in order of how much it mattered:

1. **The wire became streamable** (steps 1–3, 6). A 559.5 MB v1 model was
   unreadable at all — past Node's single-string ceiling. It is 133.7 MB of
   JSONL now, and validating it costs 140 MB of memory where materializing it
   costs 555 MB.
2. **The fold moved into SQL** (step 7). Fold is the funnel every report and
   export goes through, so moving that one thing moved all of them, and the
   782 046 base edges never enter JavaScript.
3. **MM-4 made validation nearly free** (step 8). Profile validity is a
   function of `(kind, trait set, isStub)` and the store interns trait sets, so
   23 rows decide a 241 101-entity corpus: 2.1 s → 0.46 s.
4. **The store answers, it does not remember** (steps 5, 8). No cached verdicts,
   no second representation to invalidate — every diagnostic is a query.

And what the process bought, which is most of why the numbers are trustworthy:
**of roughly two dozen mutations, five exposed gaps rather than confirming
coverage**, and three of those found real bugs that no test had asked about —
`open: false` silently rebuilding the cache on every run, an empty array
indistinguishable from an absent key, and `is_stub` read without the trait that
gives it meaning. The two that recur are worth naming: a test that passes
because the fixture has no instance of the case (the namesake type, the
duplicate under an unknown profile), and a mutation written so symmetrically
that it cannot be detected by construction.

## 10. Phase 7+ — Next languages (deferred, contract-ready from day 1)

0. **C# via Roslyn** — planned in full as Phase 10 (§13, M12): the second
   real extractor, first-class on Linux/macOS, shipped as one binary per OS.
1. **Clojure** via `clj-kondo --analysis` → thin JSON adapter (near-free; first
   cross-language test on the Import layer; exercises the fn-var case for real).
2. **TypeScript** via the TS compiler API — planned in full as Phase 11
   (§14, M13): self-hosting (run codegraph on codegraph), `space: type|value`,
   declaration merging, and the `namespace`-style legacy corpus.
3. **SCIP adapter** (one effort → Rust + TS + Python via existing indexers).
4. **Code city visualization** (`packages/viz`, Three.js + Vite): render the
   analyzed model as a 3D city — districts = modules, buildings = types
   (height/footprint/color mapped to documented metrics), edges as flows.
   Consumes analyzer output only; visual-language rules live in `CLAUDE.md`.
5. **Elixir** via the compiler's parser as a library plus a lexical resolver,
   compilation tracers as the optional enrichment — planned in full as
   Phase 13 (§16, M15): the first macro-first, dynamically dispatched
   language, `generated` and `dynamic-candidate` provenance exercised for real.

Documented static limits (all languages, per profile `notes`): reflection,
`Class.forName`/Spring XML, service loaders, pre-expansion macro code.

## 11. Phase 8 — Evolution: SCM mining, temporal store, city replay

Motivation: `model.jsonl` is a snapshot — it says what the code IS, not what
happened to it. The crime-scene analyses (hotspots, logical coupling,
knowledge maps — Tornhill, *Your Code as a Crime Scene*) and a Gource-style
replay of the city both need the time axis. Two prior decisions make this
phase cheaper than it looks: identity is the natural key (invariant 7), so
"the same entity across two snapshots" is key equality — no diff heuristics
for named entities; and Spoon runs noClasspath, so historic commits that no
longer compile still extract.

Three principles, locked up front:

1. **Evolution facts are a third artifact.** `history.jsonl` sits beside
   `model.jsonl`: repo-scoped, language-agnostic, and changing on every
   commit while structure does not. It never merges into the model file and
   never grows a fifth provenance value — code facts and history inferences
   stay unmixable. The join happens in the analyzer, on `anchor.file` /
   `TModule.definedIn` paths relative to the analyzed root.
2. **The miner has no code intelligence** — the extractor rule, mirrored.
   It emits paths, authors, timestamps, and line deltas from one `git log`
   pass; everything smarter is derived downstream.
3. **Lineage v1 is the natural key, exactly.** A renamed symbol is a death
   plus a birth; anonymous entities (`file:line:column` disambiguators
   shift under any edit above them) are not tracked over time. Both
   restrictions are documented, not silent.

### 11.1 M9a — SCM miner + file-level replay (the Gource milestone)

Everything Gource shows comes from `git log` alone — so the replay
experience ships before any extractor touches the time axis, and the one
genuinely hard viz problem (layout stability) is forced on cheap data.

- [x] `codegraph scm <repo> [--since <date>] --out history.jsonl`
      (`scm`, not `git`: the door stays open for hg/fossil): one
      `git log --numstat --no-merges --find-renames -z` subprocess, parsed
      by pure `@codegraph/scm`. M6 discipline reused: header dictionary
      (author table), interned path table, surrogate ints, sorted
      deterministic output (encoder canonicalizes), `eof` count trailer.
- [x] Two record types: `commit` (hash, author ref, timestamp,
      `isFix`/`isRevert` subject-regex flags — labeled heuristic) and
      `change` (commit ref, path ref, added, deleted, rename-from).
      Rename chains are resolved at mine time so one path surrogate names
      one file lineage — unresolved renames corrupt every downstream
      metric. (Documented approximation: a path recreated after a
      deletion continues the same lineage — lineages are named by paths.)
- [x] Reports, file-level only, no model join yet:
      `codegraph history --report summary|hotspots|authors` — churn, bus
      factor, bug density, momentum, firefighting frequency.
- [x] File-level city replay: buildings = files (height = running LOC sum
      of numstat deltas), districts = directories, timeline scrubber in
      viz, commits as ticks. (`codegraph history --serve` / `--city FILE`:
      a laid-out city artifact with a `replay` block — frozen union
      layout and keyframe height series, M9c's shape adopted early.)
- [x] Fixture: a scripted git repo built by the test suite in a temp dir
      (two authors, a rename, a `fix:` commit, a deletion) —
      deterministic, and it exercises the rename chain.
- **DoD**: miner output byte-identical across runs on the scripted repo;
  summary reports match hand-counted fixture numbers; file-level replay
  runs end to end on codegraph's own history.

### 11.2 M9b — temporal store + entity timelines

- [x] Sampled snapshots: extract at K chosen revisions (tags/releases, or
      every N commits — 50–200 frames suffice for replay) via
      `git worktree add`, never mutating the main checkout.
      (`codegraph snapshots [repo] --jar F (--every N | --tags) [--store S]
      [--src DIR]`: throwaway worktree per frame, `java -jar` extraction,
      `import --at` append, per-frame diagnose. RESUMABLE — revisions the
      store holds are skipped, so an interrupted run continues and a moved
      source root is handled by composing runs with different `--src`; a
      frame that fails to extract is reported and isolated, never fatal.)
- [x] `codegraph import --at <sha> [--time <t>]` extends `model.db` (M7)
      with `revision`, `entity_key` (interned natural keys), and
      `entity_version` / `edge_version` tables (names as TEXT — dictionary
      ids are file-scoped). The flat tables mirror the latest import; the
      cache NEVER regenerates a store holding revisions (state `temporal`
      — it stands aside and the model is read directly). Lifespans
      (`appeared`, `disappeared`) are derived per key at query time —
      inverse indexes over the time axis, never serialized (invariant 4
      applied to time).
- [x] Cross-graph queries — the ones only a tool holding BOTH graphs can
      ask: **hidden coupling** (co-change pairs with no path — transitive,
      either direction — in the declared graph) and **dead weight**
      (declared file dependencies that never co-change), via
      `codegraph history --report hidden|deadweight --model M`; logical
      coupling with support/confidence thresholds and a changeset-size
      cap (`--report coupling`, `--min-support`, `--min-confidence`).
      The join is by path SUFFIX (model roots sit below repo roots);
      ambiguous suffixes join nothing and are counted. Ownership map and
      truck factor shipped file-level in M9a (`--report authors`);
      code age and revisions×LOC enrichment remain open.
- [x] `codegraph timeline <id>`: first/last revision containing the key,
      LOC series between them, still-present flag. (Exact birth commit
      via targeted bisect — extract one file at ~log₂ N revisions — is
      still open; a query-time feature, not an ingest-time cost.)
- **DoD**: property suite (closure, profile validity, determinism) green
  at every keyframe unconditionally; timeline and coupling queries
  verified on a real corpus history (google/gson). ✅ Verified 2026-08-25:
  all 55 gson release tags (2008–2025) in one store via two composed
  `snapshots --tags` runs (`--src src/main/java` for the pre-2.4 layout,
  `--src gson/src/main/java` after the module move — resume skipping
  makes the composition free), zero findings at every keyframe;
  `timeline Gson` spans 55/55 from 1.0, `MappedObjectConstructor` dies
  after gson-1.7.2 (the 2.0 rewrite), `Excluder` is born at gson-2.1;
  hidden coupling finds the JsonSerializer/JsonDeserializer and
  Since/Until twins (no declared path), dead weight finds the stable
  JsonToken/TypeAdapter interfaces.

### 11.3 M9c — entity-level city replay

- [x] Layout computed ONCE on the union of every key that ever existed;
      every plot frozen. Buildings animate in place — rise from zero at
      birth, sink at death; land is vacant before its time. Early sparse
      frames are the honest picture of a city that will grow, not a
      defect. (`buildEntityCity`: types are buildings, modules are FLAT
      districts — nesting a package hierarchy from its name would be an
      inference; presence GAPS become explicit 0 keyframes so a rebirth
      scrubs honestly; members and anonymous types raise no building.)
- [x] One temporal `city.json`: per building
      `{plot, birth, death, series: [{t, height, heat, …}]}` — viz
      interpolates between keyframes and still renders a laid-out
      artifact only. (`codegraph replay [--store S] [--out F] [--serve]`:
      analyzer `readEntityHistory` → city `buildEntityCity` → the M9a
      replay block with `clock: "revisions"`; metrics carried per
      building: loc, peak-loc, revisions, born. Verified on gson's 55
      release keyframes: rev 1/55 is one sparse district of 2008, dead
      types leave vacant plots, JsonReader born at gson-1.6.)
- [x] Change heat as color + age as desaturation, documented like every
      other channel: keyframes carry `heat` (1 = changed at that tick,
      pre-decayed by `REPLAY_HEAT_DECAY` when a sampled revision saw the
      entity unchanged); the renderer keeps cooling between keyframes,
      ages toward gray by timeline fraction lived, and legends both — a
      'Time colors' toggle (replay artifacts only) restores the plain
      palette. Verified on gson: 2.14.0's touched core glows ember,
      one-release-old changes read brick, the untouched old core grays.
- [x] Ownership as a toggleable color mode; co-change arcs visually
      distinct from declared edges (they are inferences, and the city
      never lies). Fed by the history join: `codegraph replay --history
      F` (and `history --serve` for the file city) runs scm's
      `fileOwners` + `logicalCoupling` and the analyzer's SUFFIX join —
      buildings gain `owner {name, share}`, the replay block gains
      `coChange` building pairs. Viz: a 'Colors' selector (Time / Owner
      / Plain — Owner offered only when a history was joined; unowned
      buildings go neutral, never a claimed hue), owner in the details
      panel, and co-change as DASHED magenta arcs shown for the
      selected building — a different KIND of line from dependency
      arrows, legend and help stating the inference.
- **DoD**: replay on a real corpus reviewed as screenshots at user-facing
  camera angles; no per-frame allocation in the scrub path. ✅ Verified
  2026-08-25 on gson (55 release keyframes + 2,088-commit history, 170
  of 197 store files joined): sparse 2008 city grows to 2026; time
  colors read ember/brick/gray at 2.14.0 and 2.9.1; owner mode maps
  the original-author core against the modern maintainers; TypeAdapters
  shows owner (29% of added lines) and its dashed co-change fan. Scrub
  path allocates nothing: caller-owned Float32Array buffers, in-place
  instance matrix/color rewrites, event-driven repaints only.

### 11.4 Deferred, explicitly

- **Per-commit incremental extraction** (keyframes + deltas): Spoon's
  resolution is corpus-wide — the stub whitelist depends on all
  corpus-declared ids — so between-keyframe models are approximate. Build
  only if sampling proves too coarse; keyframes bound the staleness.
- **Symbol rename lineage** (same-parent + similar-body matching).
- **Lambda/anonymous-entity tracking** over time.
- **`.mailmap` author normalization** (start with email identity; add it
  when it bites).

## 12. Phase 9 — Back to source, measures, framework semantics (M10)

Motivation: the model says what the code *is* (structure) and what *happened*
to it (Phase 8). This phase makes it say **where it lives** (a permalink for
every anchor), **how big and how branchy it is** (measured, not guessed),
**what it says verbatim** (the constant values the source writes — annotation
arguments, constant initializers, defaults), and **what frameworks do to it**
(the DI wiring the static graph cannot see). All four land on hooks the
codebase already carries: anchors are repo-projectable the moment the header
knows the repo; the city's metric registry was written for extractor-emitted
measures (`attribute:`/`sum:` sources, `metrics.ts`); annotation usage is
already an edge and Spring wiring is already a documented blind spot in the
Java profile notes.

Four principles, locked up front:

1. **Facts in the model, projections downstream.** The header gains the
   repository facts (`remote`, `commit`, repo-relative `root`); the blob-URL
   template of a particular host is presentation, derived by consumers — a
   stored URL would freeze one host's scheme into the interchange
   (METAMODEL §8a/§9).
2. **Only the extractor measures.** `sloc` and `cyclomatic` require reading
   source; nothing downstream may re-parse or approximate them. Gross span
   length stays a *derived* proxy (the city's `loc`), and the two claims are
   never conflated (METAMODEL §3.8).
3. **A value is what is written, never runtime state.** A `Literal`
   (METAMODEL §1.6) is emitted only when the language fixes it at the
   declaration — a literal, or an expression folding from constants; anything
   else is `unevaluated` (source text kept) or absent. Ids inside values obey
   closure like edge endpoints.
4. **Framework knowledge is data, like profiles.** The analyzer derives DI
   wiring from declared facts plus a declarative annotation table
   (METAMODEL §9.1); the extractor stays framework-blind, and derived wiring
   edges are in-memory only — invariant 4 applied to inference.

### 12.1 M10a — repository provenance + source links

- [x] Core: optional `repository {remote, commit, root, provider?}` on the
      header record (Model, wire, container contract), `pnpm run gen:schemas`
      committed with it. Additive — `schemaVersion` unchanged (M6 decision:
      the format is internal, bumping a version nobody consumes buys nothing).
      `root` is the analyzed root **relative to the repo root** — the M9b gson
      gotcha (`--src gson/src/main/java`) resurfacing as a data requirement;
      without it no anchor projects back to a repo path. Every field is a
      PATTERN, not a refinement: `z.toJSONSchema()` drops refinements, and the
      published schema has to refuse an ssh remote or a `../` root exactly as
      core does, or `schemas/` is not the contract it claims to be.
- [x] Java extractor: passthrough flags (`--repo-remote`, `--repo-commit`,
      `--repo-root`, `--repo-provider`) copied verbatim into the header — no
      git knowledge, no metamodel intelligence, one writer per file. The flags
      travel together (a remote without a sha links nowhere) and are checked
      against the published patterns at the flag, not written into a header
      the analyzer would then refuse whole.
- [x] CLI derives the values: normalize `git remote get-url origin` (ssh,
      `ssh://`, `git://`, embedded credentials → https, strip `.git`);
      `snapshots` supplies the per-frame sha it already checks out and the
      `--src` prefix, which is already repo-relative. A remote no browser can
      open (local path, `file://`, plain http) yields NOTHING and says so —
      a guessed URL is a link that lies.
- [x] Analyzer/city carry `repository` into artifact metadata (store `meta`
      row; `readEntityHistory` exposes it beside the revisions); viz details
      panel renders a "view source" link from the selected entity's anchor —
      GitHub `{remote}/blob/{commit}/{root}/{file}#L{s}-L{e}`, GitLab
      `{remote}/-/blob/{commit}/{root}/{file}#L{s}-{e}`; provider guessed
      from hostname, `provider` field overriding (self-hosted GitLab). An
      unknown host template renders no link. In a replay the commit is the
      SCRUBBED tick's sha, retargeted in place so playback churns no DOM.
- **DoD** ✅ verified on gson at `b3f4ca2`: the JsonReader link opened
  `gson/src/main/java/com/google/gson/stream/JsonReader.java#L211-L2005` on
  github.com at the extraction sha (screenshot reviewed); the fixture city,
  whose model carries no block, renders no link at all; a 4-revision gson
  replay store retargeted the link to `ed2b25d` (2011) when scrubbed to
  revision 2/4, and that URL resolves too.

### 12.2 M10b — measures (`TMetrics`)

- [x] Core: `TMetrics` trait contributing `metrics: Record<string, number>`
      (finite values validated — Zod v4's `z.number()` rejects NaN/Infinity by
      construction; keys deliberately open — METAMODEL §3.8), optional on the
      Java profile's measurable kinds (types + invocables); header trait
      dictionary grows; `gen:schemas` committed. The encoder writes the map
      KEY-SORTED: canonical order (MM-5) reaches inside the record, or two runs
      that measured the same thing would differ in bytes.
- [x] Java extractor emits `sloc` per type and invocable (span lines minus
      blank and comment-only lines) and `cyclomatic` per invocable:
      1 + count of `CtIf`, `CtFor`/`CtForEach`/`CtWhile`/`CtDo`, non-default
      `CtCase` (one per case expression), `CtCatch`, `CtConditional`,
      `CtBinaryOperator` AND/OR, switch-pattern guards. A lambda's branches
      count toward the lambda — it is its own invocable. Purely syntactic:
      immune to the noClasspath resolution ceiling. `sloc` runs a small LEXER,
      not a regex: a `"/*"` inside a string literal would otherwise open a
      block comment that never closes and silently blank the rest of the file.
- [x] Store: measures are ROWS (`entity_metric`), not a JSON blob — the cache
      exists to be queried and a measure is what one aggregates; presence
      follows the trait set like every other trait key, so `metrics: {}`
      survives. `DB_VERSION` 2 → 3.
- [x] City: `numericKey` reads the `metrics` map (top-level loose keys stay
      legal but uncontractual, and the map wins), so `--height sum:cyclomatic`
      and `attribute:sloc` work exactly as `metrics.ts` promised.
- [x] Fixture: hand-counted `cyclomatic` values asserted on the fixture
      corpus (`Reporting.max` 4 = for + if + `||`, `join` 2, `first` 2 ternary,
      `today` 1); the constructs the corpus does not contain — switch labels,
      pattern guards, multi-catch, lambda-in-method — are hand-counted over
      sources written for them in the extractor's `MeasuresTest`. Properties:
      every measure finite and non-negative, `sloc ≤ span`, a stub carries none.
- **DoD** ✅ verified on apache/commons-lang at `e073d5d` (15 381 entities,
  5 200 measured, 9 790 total cyclomatic over 4 809 invocables):
  `--height sum:cyclomatic --footprint loc` reviewed as screenshots at
  user-facing angles — ArrayUtils (1 099) and StringUtils (904) tower over a
  mid-rise of StrBuilder/Conversion/TypeUtils; the 246 unmeasured buildings
  (239 of them stubs) sit at the channel minimum 1, counted in diagnostics and
  in the legend, never at zero. `sloc ≤ span` held on all 5 200; a hand-count
  of `JavaVersion.get` (1 + 28 case labels + 4 ifs) matched the emitted 33
  exactly.

### 12.3 M10c — literal values (the value door)

- [x] Core: `Literal` primitive (METAMODEL §1.6) — tagged union: string,
      number (canonical decimal **text** — a Java `long` does not fit a JSON
      number), boolean, null, enum (type id + simple name — a member stub is
      never fabricated, §6 verbatim), type, array, nested annotation, and
      `unevaluated` (source text of a constant expression the extractor did
      not fold). `TWithValue { value: Literal }` optional on `attribute` and
      `method` (annotation element defaults) in the Java profile; new edge
      kind `annotationUse` — Entity → annotation Type, `arguments:
      {name, value}[]`, the implicit `value =` normalized explicit. Header
      dictionaries grew (one trait, one edge kind); `gen:schemas` committed —
      the recursive union publishes as a NAMED `$defs/Literal`, so the
      contract states the tree once and both record schemas reference it.
- [x] Encoding: ids inside Literals are file-scoped surrogates, so closure
      over values is enforced by the wire exactly as for edge endpoints — a
      value pointing at an undeclared entity has no surrogate to name it with
      and is unwritable. Property suite extended: the generators build values
      from the same id pool as every other reference, so closure over values
      is exercised by construction; determinism untouched — argument and array
      order is written order, a source fact like parameter order. An EMPTY
      argument list is omitted on the wire (the edge kind vouches for the key)
      and restored on read, so `@Override` costs no bytes.
- [x] Store: `entity.value` and `edge.arguments` are JSON columns — a Literal
      is a tree, nothing queries inside one, and the ids it holds are the
      wire's own surrogates, so the blob round-trips exactly. `DB_VERSION`
      3 → 4.
- [x] Java extractor: `emitAnnotations` upgraded from `reference` to
      `annotationUse` with arguments (Spoon annotation values + partial
      evaluator; chars ride as one-character strings; a class literal in an
      argument still emits its own `reference` edge — a value never replaces a
      dependency). Constant `attribute` initializers (JLS compile-time
      constant expressions) and annotation element `default`s carried via
      `TWithValue`. A field that is `final` but whose initializer is CODE
      (`new StringBuilder()`) carries nothing: absence means "not constant".
      In-place clean break for the usage edge kind — fixtures regenerated, no
      dual emission (the M6 precedent).
- [x] Analyzer and city: values pass through untouched on load; the details
      panel shows a constant beside its field, ids rendered as the referenced
      entity's NAME — presentation, no new derivation.
- **DoD** ✅ the fixture asserts `@Retention(RetentionPolicy.RUNTIME)` on
  `Audited` as an `annotationUse` edge whose argument is the enum form,
  `value() default ""` as a `TWithValue` string, `MAX_LINES = 4 * 25` folded
  to `100`, and one honest `unevaluated` (`@Audited(LedgerClient.AUDIT_TAG)`,
  a constant noClasspath cannot resolve); property suite green including
  value-closure; regenerated gson (63 valued entities, 599 annotation uses,
  122 with arguments) and commons-lang (458 valued, 1 164 uses) diagnose
  clean. The discipline is visible on real code: `SAFE_MAX_ARRAY_LENGTH`
  (`static final`) states `2147483639`, while `SOFT_MAX_ARRAY_LENGTH` — the
  same `Integer.MAX_VALUE - 8` initializer, but not `final` — states nothing.

### 12.4 M10d — framework semantics (Spring first)

- [x] Framework profile as data in the analyzer (METAMODEL §9.1): annotation
      identity → role (`stereotype`, `injection-point`, `entry-point`,
      `qualifier`, and `primary` — the one role this list did not name, since
      `@Primary` narrows by PRESENCE on the producer rather than qualifying the
      injection point; adding it was a row, not code, which is the property the
      table exists to have). Specifiable without being implemented — the
      profile robustness test, again: a Micronaut table validates with nothing
      behind it.
- [x] Analyzer DI pass: for each injection point (field / constructor param on
      a stereotyped class), derive in-memory `dynamic-candidate` edges from the
      consumer to every corpus implementation of the declared interface —
      candidates straight from the existing `interfaceImplementation` inverse
      index; `@Primary` narrows on presence, `@Qualifier` on its
      `annotationUse` argument value (M10c) against the bean's names (its
      stereotype's string argument, or Spring's decapitalized default) — exact
      strings, not guesswork. Narrowing is never silent: the point says what it
      narrowed FROM. Injection points and roles are selected on `annotationUse`
      edges directly; matching reads the referenced annotation entity's `name`
      + its module, never a parsed id, and tolerates stub targets (the
      petclinic case: every Spring type is a stub). `implicitSoleConstructorInjection`
      is profile DATA, so Spring 4.3+ constructor injection with no annotation
      at all is described by a field rather than by a branch.
- [x] Stereotype classification surfaced as a report (`analyze --report
      wiring`, text and `--json` under the same envelope) and as a semantic
      city color channel (`codegraph city --framework spring` → `Building.role`
      plus a `roles` legend block; viz gains a `Role` color mode, legended like
      every channel) — derivable from `annotationUse` edges (M10c), no further
      model change.
- **DoD** ✅ hand-verified on spring-petclinic at `a6e81a5` (the last revision
  with `@Autowired`): all 6 `@Autowired` sites found — 9 injection points, of
  which the 5 injecting `ClinicService` list exactly `ClinicServiceImpl`, the
  corpus's one implementation (`grep -rl "implements ClinicService"` returns
  exactly that file), and the 4 injecting Spring Data repository interfaces
  list NOTHING, with the reason stated: the container implements them at
  runtime, so the empty set is a fact about the corpus. The facts-only view is
  byte-identical before and after the pass — `analyze --report deps --level
  type --declared-only --json` is the same 107 359 bytes either side, 286
  edges, provenance `declared` only. Also run on petclinic HEAD (`818c413`),
  which has no `@Autowired` at all: 6 implicit sole-constructor injection
  points found by the profile's own rule.

## 13. Phase 10 — C# extractor (Roslyn) and native distribution (M12)

Motivation: the second *real* extractor is the first test of the claim
CLAUDE.md makes on every page — that an extractor in any language can conform
using nothing but `schemas/` and the container contract. C# is the right second
language: the `csharp` profile has existed as data since M1 without an
implementation (invariant 8 says that must be possible; M12 is where it is
checked), Roslyn gives Spoon-grade semantic binding (symbols, overload
resolution, extension-method binding), and the .NET ecosystem's legacy corpora
(Framework 4.x, WebForms, `packages.config`) are exactly the non-compilable
kind the pipeline exists for. The extractor must run on Linux and macOS as
first-class hosts and ship as ONE self-contained binary per OS, so a user needs
no SDK on the machine that runs it.

Three principles, locked up front:

1. **Roslyn without MSBuild — the noClasspath of .NET.** The extractor never
   opens a `.sln`/`.csproj` and never calls `MSBuildWorkspace`: it walks
   `--src` for `*.cs`, parses each file, and binds one `CSharpCompilation`
   against the BCL reference assemblies it carries inside itself. A missing
   NuGet package is a stub, not a build failure — the same degraded-honesty
   contract as Spoon's noClasspath (§5.2). `MSBuildWorkspace` needs an installed
   SDK, a restore, and an evaluable project graph: three things a legacy corpus
   does not offer and a self-contained binary cannot assume. A project-aware
   mode (`--references`) is an optional later enrichment, never the baseline.
2. **The extractor holds no metamodel intelligence** — the Java rule, mirrored.
   It knows the C# id scheme, the kind→traits table, and how to write bytes.
   Trait vocabulary, profile validation and closure live in `core`; the
   cross-language gate (`packages/core/test/fixtures-csharp.test.ts`, the twin
   of the Java one) is where the two halves meet.
3. **Byte-identity is the cross-OS contract.** Two runs on one unchanged corpus
   produce the same bytes (contract §6) — *on any of the three OSes*. That
   single property turns "does it work on macOS/Windows?" into `cmp` against the
   committed fixture snapshot, which is the only cross-OS test the Linux-only CI
   can delegate to a human with a laptop.

### 13.1 Toolchain and repository layout

```
extractors/csharp/
  global.json                       pins the SDK band (10.0.x, LTS, roll-forward latestPatch)
  Directory.Build.props             Deterministic, ContinuousIntegrationBuild, InvariantGlobalization,
                                    Nullable=enable, TreatWarningsAsErrors, LangVersion latest
  Codegraph.CSharp.sln
  src/Codegraph.CSharp/             console project → `codegraph-csharp`
    Program.cs                      CLI: same flags and exit codes as the Java jar (§13.5)
    CorpusLoader.cs                 pass 0: file walk (ordinal order) + parse + one compilation
    ReferenceAssemblies.cs          the embedded BCL ref pack → MetadataReference.CreateFromImage
    CorpusWhitelist.cs              pass 1: the declared-type set (INamedTypeSymbol from source)
    EntityIds.cs                    THE C# id scheme (§13.3)
    EntityExtractor.cs              pass 2
    EdgeExtractor.cs                pass 3
    StubSynthesizer.cs              pass 4
    Measures.cs                     sloc (trivia-based) + cyclomatic (syntax-based)
    Literals.cs                     attribute arguments / const initializers → Literal (M10c shape)
    Model/                          Entity, Edge, NaturalKey, JsonlWriter (Utf8JsonWriter), Progress
  tests/Codegraph.CSharp.Tests/     xUnit; the same test names as extractors/java where the property
                                    is the same (SnapshotTest, DeterminismTest, StubDisciplineTest,
                                    ModelSchemaValidationTest, EntityTraitConformanceTest, …)
fixtures/csharp/src/                the reference corpus (§13.6) — `Acme.Order`, the Java corpus's twin
fixtures/csharp/expected/model.jsonl
```

Toolchain facts that bite first, mirroring `extractors/java/README.md`:

- **`dotnet` is not installed on the dev box** (checked 2026-09-07). Install
  user-locally, sdkman-style: `curl -sSL https://dot.net/v1/dotnet-install.sh |
  bash -s -- --channel 10.0 --install-dir ~/.dotnet`, then
  `DOTNET_ROOT=~/.dotnet` and `~/.dotnet` on `PATH`. `scripts/lib.sh` gains
  `ensure_dotnet` beside `ensure_jdk`: PATH first, then `~/.dotnet/dotnet`,
  then a `die` that prints the one-liner. Same script on macOS.
- `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`,
  `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1` exported by the scripts so a first build
  is not a telemetry conversation.
- `InvariantGlobalization=true`: the extractor does no culture-sensitive work,
  and the flag removes the `libicu` runtime dependency that makes a .NET binary
  fail on a minimal Linux (`Couldn't find a valid ICU package`) — the single
  most common "works on my Mac, dies in the container" failure. It also makes
  ordinal string behaviour identical on all three OSes, which §13.4 needs.
- Roslyn packages: `Microsoft.CodeAnalysis.CSharp` (syntax + semantics) only.
  NOT `Microsoft.CodeAnalysis.Workspaces.MSBuild`, NOT `Microsoft.Build.Locator`
  (principle 1; both are also incompatible with single-file publishing).
- BCL reference assemblies: the `Microsoft.NETCore.App.Ref` pack's
  `ref/net10.0/*.dll` are embedded as resources at build time and loaded with
  `MetadataReference.CreateFromImage`. Why not `typeof(object).Assembly.Location`
  like every Roslyn tutorial: in a single-file bundle `Assembly.Location` is the
  empty string, so the "obvious" approach works in `dotnet run` and silently
  binds *nothing* in the shipped binary — every `string` would become an
  unresolved stub and the resolution rate would collapse only in production.
  `ReferenceAssembliesTest` pins that `System.String` resolves to a stub in
  module `System`, not `<unresolved>`, and runs against the *published* binary
  in CI (§13.7).

### 13.2 Mapping table (C# profile) — and the profile corrections M12 forces

The profile (`packages/core/src/profiles/csharp.ts`) predates M6 and M10; the
first M12 commit is `feat(core): csharp profile v2`, a data change with the
same justification each Java change had:

| Change | Why |
|---|---|
| `TWithChildren` added to `method`, `constructor`, `lambda`, `delegate`, `property` | M6's executable-containment decision (§9.2): parameters and locals carry `parent`, so the container must be licensed too, or the model states a containment its own profile forbids. `property` because accessor bodies hold locals and lambdas. |
| `TMetrics` optional on every type and invocable | M10b: `sloc` + `cyclomatic`, the same two measures Java emits, so the city's `--height sum:cyclomatic` works on a C# corpus unchanged. |
| `TWithValue` optional on `field` (`const`, enum members) and `parameter` (default values) | M10c, the value door. An enum member is a `field` whose value is its constant, exactly the Java shape. |
| edges `annotationUse` and `throws` added | Attributes ARE annotation usage (M10c's edge kind, with `arguments`); `throw` statements are M10d-era evidence the insights walk consumes. |
| kind `event` added: `TNamed, TStructural, TTypedEntity, TChildOf, TSourceAnchor` | An event is a value-shaped member with its own declaration site; folding it into `field` would lie about the kind and into `property` about accessors. |
| lambda disambiguator note: `(file, line, column)` | The M7 lesson (§5.3): two nameless entities on one line — `Chain(() => a, () => b)`, or a lambda inside an anonymous method — collide on `(file, line)`. A column is a source fact. |
| the `dynamic` note reworded: a `dynamic` call site is dropped and COUNTED, not emitted as `dynamic-candidate` | The M10d decision moved candidate generation to the analyzer, which alone has whole-corpus implementor knowledge. An extractor inventing a candidates list from the file's `using`s would be the prefix-filter sin at the edge level. |

Construct → kind, on top of the profile's table:

| C# construct | kind | notes |
|---|---|---|
| `namespace` (block or file-scoped), global namespace | `namespace` | module; global namespace is `csharp:<global>`; block-nested namespaces get `TChildOf` |
| `class`, `interface`, `struct`, `record`, `record struct`, `enum`, `delegate` | as named; `record struct` → `record` | `static class` is a `class`; `partial` merges by id (§13.3) |
| method, `operator`, conversion, finalizer, local function | `method` | operators use the metadata name (`op_Addition`, `op_Implicit`); a local function's parent is the enclosing invocable |
| constructor, static constructor, primary constructor (records, C# 12 classes) | `constructor` | primary constructor: anchor = the parameter list; a positional record's synthesized `Deconstruct`/`Equals` are NOT emitted (never written) |
| property, indexer (`this[]`), auto-property | `property` | indexer symbol `Item(params)`; accessor bodies contribute edges FROM the property |
| field, `const`, enum member | `field` | `TWithValue` for `const` and enum members |
| event | `event` | `+=` / `-=` are `access` edges with `isWrite` |
| parameter, local (incl. `out var`, pattern variables, `foreach` variables) | `parameter` / `localVariable` | `var` → `TTypedEntity` present, `declaredType` absent when Roslyn's inferred type is anonymous/error |
| lambda, anonymous method, local function *expression* | `lambda` | `#file:line:column` |
| extension method | `method` + `TAttachedTo` → extended type | the profile's existing rule |
| attribute usage | `annotationUse` edge with `arguments` | attribute *classes* are ordinary `class` entities |
| `using X;`, `global using`, `using static X.Y`, `using A = X.Y` | `import` → module `X` (resp. `X`, the containing namespace of `Y`) | folded to namespace level, never a type |
| `: Base`, interface `: IOther` | `inheritance` | |
| `: IFoo` on class/struct/record | `interfaceImplementation` | |
| calls, `new`, delegate `Invoke`, `nameof`-free | `invocation` | virtual/interface dispatch → the declared member (profile note); `dynamic` receiver → dropped + counted |
| field/property/event reads and writes | `access` (`isRead`/`isWrite`) | property access is modelled as access, not invocation — the source writes a member access, and the accessor is not an entity |
| type usages: declared types, generic arguments, casts, `is`/`switch` patterns, `typeof`, `default(T)`, base lists' generic args | `reference` | erased per §13.3 |
| `throw` statements | `throws` | static type of the thrown expression; rethrow → the caught variable's static type |

Explicitly NOT extracted in M12, stated in the profile `notes`: source
generators (their output is not in `--src`), `InternalsVisibleTo`, XAML/Razor
code-behind partials (the `.cs` half is extracted; the generated half is
absent), `#if` branches the default symbol set excludes (Roslyn parses ONE
configuration — `--define` is a later flag), and cross-assembly DI wiring
(the analyzer's M10d framework table can gain an ASP.NET Core profile later;
the extractor stays framework-blind).

### 13.3 The C# id scheme (`EntityIds.cs`)

Same shape as Java's (`extractors/java/.../EntityIds.java`), with the
differences C# forces:

```
namespace       csharp:<Ns.Path>                                  csharp:Acme.Order
global ns       csharp:<global>
unresolved ns   csharp:<unresolved>                               (§13.4)
type            csharp:<Ns>/<TypeMetadataName>                    csharp:Acme.Order/OrderService
generic type    csharp:<Ns>/<Name>`<arity>                        csharp:Acme.Order/Repository`1
nested type     csharp:<Ns>/<Outer>.<Inner>                       csharp:Acme.Order/OrderService.Line
method          csharp:<Ns>/<Type>.<name>[`<arity>](<erasedFqnParams>)   csharp:Acme.Order/OrderService.Bill(Acme.Order.Order)
constructor     csharp:<Ns>/<Type>.<init>(<params>)               static ctor: .<cctor>()
indexer         csharp:<Ns>/<Type>.Item(<params>)
operator        csharp:<Ns>/<Type>.op_Addition(<params>)
lambda / anon   csharp:<Ns>/<Type>#<file>:<line>:<column>
field/prop/evt  csharp:<Ns>/<Type>.<name>
parameter       csharp:<Ns>/<Type>.<methodSig>#param:<name>
local           csharp:<Ns>/<Type>.<methodSig>#local:<name>:<startLine>
local function  csharp:<Ns>/<Type>.<methodSig>#fn:<name>(<params>)
stub type       csharp:<Ns>/<TypeMetadataName>                    same shape as a declared type, on purpose
```

- **Arity is part of the symbol, because C# lets `Foo`, `Foo<T>` and `Foo<T,U>`
  coexist in one namespace.** Java erases generics to the raw name; doing so
  here would merge three legal declarations into one entity — the M2 overload
  collision one level up. Roslyn's `MetadataName` (`Foo`1`) is a source fact,
  not an invention, and the backtick is not a reserved id character.
- Parameter types in signatures are fully-qualified metadata names WITH their
  type arguments (`System.Collections.Generic.List`1<Acme.Order.Order>`) —
  **corrected in the M12c audit**: the plan first said "erased", and Humanizer
  overloads `Humanize<T>` on `Func<T,string>` versus `Func<T,object>`, which C#
  allows and Java's erasure never could; erasing merged the two into one key.
  Arrays as `T[]`, `ref`/`out`/`in` dropped (they cannot overload by
  themselves), nullable annotations dropped (`string?` and `string` are one
  type), `Nullable<T>` as `System.Nullable`1<T>`, tuples as
  `System.ValueTuple`n<…>`, pointers as `T*`, type parameters as their
  ordinal `!0`/`!!0` (ECMA-335's form — type-level vs method-level — computed
  from `ITypeParameterSymbol.Ordinal`; a type parameter's *name* is not part
  of the signature in C#, and two overloads differing only in `T`'s name would
  otherwise get two ids).
- **Partial types and partial methods are ONE entity.** The anchor is the
  declaration that sorts first by `(file path, start line)` — ordinal order,
  so the choice is stable across OSes — and every edge carries the
  `sourceFile` of the declaration part that produced it (the profile's own
  note). `PartialTypesTest` asserts one id, one entity, both files' edges.
- Paths in anchors and `definedIn` use `/` on every OS and are relativized
  against the deepest common ancestor of the `--src` roots, as Java does.

### 13.4 Stub discipline, Roslyn edition

Roslyn does not invent FQNs — but it has its own way of lying, and the
discipline is the same: **membership is the whitelist of corpus-declared type
symbols built in pass 1, never a name-prefix test.**

- **Whitelist** = every `INamedTypeSymbol` whose `DeclaringSyntaxReferences`
  are in the compilation's own trees (`compilation.Assembly.GlobalNamespace`
  walked, or the `TypeDeclarationSyntax` set — the test asserts both agree).
- **Metadata-resolved external types** (the BCL from the embedded ref pack;
  later, `--references` DLLs) are stubs with their real namespace:
  `csharp:System/String` `{kind: class, traits: [TNamed, TType], isStub: true}`,
  `parent` → the stub namespace `csharp:System` `{definedIn: [], isStub: true}`.
  The M3 stub-containment decision applies unchanged.
- **Error types** (`IErrorTypeSymbol`, a name Roslyn could not bind — a missing
  NuGet package, a typo, generated code) are stubs in the reserved module
  `csharp:<unresolved>`, named as written (`csharp:<unresolved>/JsonConvert`).
  This is the honest form: the corpus wrote a type of that name, and nothing
  says where it lives. Guessing a namespace from the file's `using` directives
  would be inventing an FQN, which is the one thing the Java extractor exists
  to be defended against. The `import` edge to `csharp:Newtonsoft.Json` from
  the `using` directive still says what was imported.
- **Roslyn's equivalent of Spoon's receiver promotion**: an unbound member
  access `foo.Bar()` where `foo` itself is unbound gives an error type named
  `foo`. It lands in `<unresolved>` like any other — and, like the Java note
  says, a stub count is not a count of external types.
- **Not entities**: primitives are BCL types in C# (`int` IS `System.Int32`),
  so unlike Java they DO resolve — to stubs in `csharp:System`. `void`,
  `dynamic`, anonymous types, tuples' element names, pointer/function-pointer
  types, `null`/error *values* and type parameters are not entities;
  `declaredType` is omitted for them. Arrays fold to the element type ONLY for
  the written type reference, never for members (`xs.Length` is an access on
  `System.Array`'s `Length` — Roslyn binds it there, so the phantom the Java
  extractor had to fight does not arise, and the test that pins it is kept
  anyway).
- **Resolution summary** on stderr, in the Java format: type references,
  resolved / unresolved (`IErrorTypeSymbol`), rate; entities (stubs); edges
  (self-edges dropped; `dynamic` call sites dropped). Type parameters and error
  *values* excluded from the denominator, for the reasons §5.3 records.

### 13.5 The extractor command-line contract (both extractors)

`codegraph snapshots` orchestrates extraction with a fixed argument shape; M12
writes that shape down as the contract every extractor must honour, in
`schemas/README.md §8`, and the C# extractor implements it verbatim:

```
<extractor> [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
            [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--help]
exit codes: 0 ok · 1 failure · 2 usage · 3 unimplemented
stdout: nothing but `--help`; stderr: progress (tty only under auto) + the summary
```

CLI change: `--jar FILE` becomes `--extractor FILE` (`--jar` kept as an alias).
A `.jar` runs as `java -jar FILE …`; anything else runs directly. The seam is
already an injected `Extract` function in `snapshots.ts`, so the change is one
dispatcher plus its ENOENT messages naming the right runtime. `replay`/`history`
usage strings follow. `codegraph` itself stays extractor-agnostic — there is no
`codegraph extract`, by design: the Node side never learns a language.

### 13.6 Validation (the M2 gate, replayed)

Red-green, in this order, each step a commit:

- [x] **Walking skeleton (M12a, 2026-09-07)** — `header`/`f`/`eof`, namespaces
      and every type kind (delegates with their parameters), doc comments,
      `import` + `inheritance` + `interfaceImplementation` edges, stubs;
      schema-validated per line (`JsonSchema.Net`, draft 2020-12) plus the
      sequence rules in the extractor's own suite (51 tests); snapshot at
      `fixtures/csharp/expected/model.jsonl` (20 files, 42 entities of which 11
      stubs, 24 edges); the core gate `fixtures-csharp.test.ts` (13 tests:
      parse → `validateModel(csharpProfile)` zero issues → **byte-identical to
      `encodeModelToString`** on the first run → closure → no self-reference →
      the stub evidence). `./bin/codegraph validate` reports OK and `analyze
      --report deps` folds the import layer to 10 namespaces / 6 dependencies.
      The JSON writer, ordering and the id scheme were proven against core's
      encoder before a single member existed — which was the point.
- [x] **Fixture corpus** `fixtures/csharp/src` (`Acme.Order`, the Java corpus
      translated, plus what C# adds): a partial class across two files; a
      file-scoped and a block namespace; nested types; `Foo`/`Foo<T>` in one
      namespace; overloads differing by generic arity; an extension method;
      a lambda and a local function starting on the same line; `record`,
      `record struct`, `struct`, `enum : byte`, `delegate`, `event`, indexer,
      `operator +`, `const` + enum members, a primary constructor, `using
      static`, `global using`, an alias `using`; async/LINQ over the BCL (stubs
      with real namespaces); an unresolvable external (`Newtonsoft.Json`);
      `throw`, rethrow and a guard clause; attributes with positional, named
      and `typeof` arguments; a `dynamic` call site (dropped + counted).
- [x] **Members and edges (M12b, 2026-09-07)** — methods, constructors (the
      implicit parameterless one included; a record's primary constructor at
      its parameter list), operators, properties and indexers, fields, events,
      parameters with defaults, locals (`#local:name:line:column`), lambdas
      (`#file:line:column`), local functions (`#fn:`); `invocation` (calls,
      `new`, `: this()`/`: base()`, user-defined operators, delegate
      invocations folded to the delegate type, extension calls resolved to
      the static method), `access` with `isRead`/`isWrite`, `reference` from
      the narrowest declared owner, `throws` (rethrow → the catch's type),
      `annotationUse` with `Literal` arguments named after the bound
      constructor's parameters; extension `attachedTo`; `sloc` + `cyclomatic`.
      Members Roslyn synthesizes (record `Equals`, accessors, backing fields)
      are not entities — a call to one folds to its type. 25 new .NET tests
      (`MembersTest`, `EdgesTest`, `MeasuresTest`); the snapshot went from
      88 to 570 lines (244 entities, 285 edges) and stayed byte-identical to
      core's encoder. Review of the first full snapshot caught five defects
      before they were committed: attribute arguments leaking as accesses, a
      lambda parameter keyed without its lambda's position, `base.Post` on an
      unresolved base collapsing into the module key, an unbound receiver
      (`JsonConvert`) producing no edge, and a `foreach` local owning its
      whole loop body.
- [x] **Stub discipline tests**: a corpus type declared in namespace `System.Acme`
      stays internal (no prefix test); `Newtonsoft.Json.JsonConvert` lands in
      `<unresolved>` as a reference from its call site; `string` lands in
      `System`; every nameless entity on a shared line gets its own id, and so
      does each of their parameters; no entity is its own parent.
- [x] **Determinism**: two runs byte-identical; file walk order ordinal;
      `\r\n` sources give the same lines as `\n` sources (Windows checkouts with
      `core.autocrlf`); `Utf8JsonWriter` with
      `JavaScriptEncoder.UnsafeRelaxedJsonEscaping` matched against core's
      `JSON.stringify` on the `fixtures/unicode` characters — the byte-identity
      test in core is what catches an escaping mismatch, so the unicode
      identifiers go into the C# fixture too.
- [x] **CLI e2e** on the C# fixture: `validate` OK, `analyze --report deps`
      (55 type nodes / 114 dependencies), `coupling`, `cycles` (three module
      self-dependencies, no tangle), `city` (9 districts, 55 buildings, 98
      arrows), `navigator` (181 nodes, 219 rows), `domain-facts` (26 type
      dossiers, 69 operations), `explain --dry-run` (an L8 walk plan). The
      fixture joined the per-fixture suites: analyzer `conformance-csharp`
      (the acceptance gate, clean), city and navigator `csharp-fixture`, and
      the CLI `validate` suite.
- [x] **Real-corpus audit (M12c, 2026-09-07)** — Humanizer (`src/Humanizer`,
      the commons-lang analogue), `dotnet/eShop` (`src`, the petclinic
      analogue) and OrchardCore (`src`, the fineract analogue), extracted with
      the published `linux-x64` binary, every model `validate`-clean:

      | corpus | files | entities (stubs) | edges | resolution | wall clock |
      |---|---|---|---|---|---|
      | Humanizer | 212 | 12 146 (148) | 27 234 | 97.3 % | 6.2 s |
      | dotnet/eShop | 498 | 7 396 (789) | 13 223 | 63.5 % | 12.2 s |
      | OrchardCore | 5 193 | 88 007 (2 175) | 225 184 | 93.4 % | 53.5 s |

      **The first run aborted on all three**, each with a duplicate natural
      key — the audit's whole purpose. Humanizer overloads `Humanize<T>` on
      `Func<T,string>` versus `Func<T,object>`, which C# allows and erasure
      merged: signatures now carry type arguments. eShop's ten services each
      declare `static class Extensions` and a top-level `Program.cs`: one
      compilation makes them one type with ten `<Main>$`, and "first wins"
      would have erased nine services' DI wiring — every duplicate is now
      kept, re-keyed by its file. OrchardCore's `JsonDynamicValue` has 37
      `explicit operator`s differing only in return type (now part of a
      conversion's signature) and a `(_, _) =>` lambda whose two parameters
      share a name (the second carries its ordinal). Humanizer then failed
      `validate` on an empty `name`: C# 14 `extension(T t) { … }` blocks,
      which Roslyn models as nameless nested types — their members are now
      members of the enclosing static class, attached to the receiver.

      **Resolution, categorised.** Before the audit OrchardCore stood at
      62.7 % and its most-referenced "unresolved" names were `Task`, `Task<T>`,
      `IEnumerable<T>`, `List<T>`: not missing packages but the SDK's
      *implicit global usings*, which live in the generated `obj/` file the
      extractor skips as build output. Adding Microsoft.NET.Sdk's seven by
      default (`--implicit-usings sdk`; `web` opt-in — the Web SDK's
      additions made OrchardCore's own `StartupBase` ambiguous with
      `Microsoft.AspNetCore.Hosting.StartupBase` 345 times) and embedding the
      ASP.NET Core reference pack beside the BCL's took OrchardCore to
      93.4 %, its edges from 178 k to 225 k, and Humanizer to 97.3 %. What is
      left is exactly the dependency surface §5.3 predicts: third-party
      packages (eShop: EF Core, Npgsql, MAUI, CommunityToolkit.Mvvm;
      OrchardCore: Fluid, YesSql, GraphQL, OpenIddict), generated code whose
      output is not under the roots (Humanizer's source generators), and one
      honest limit of a single compilation — two corpus types with one simple
      name whose projects each `global using` their own namespace (eShop's
      two `CatalogItem`) are ambiguous once merged. eShop's 63.5 % is that
      floor: the corpus mixes ASP.NET Core, MAUI and Aspire projects that
      never compile together.

      Screenshots of the eShop city and navigator reviewed at user-facing
      angles (§13.9). Numbers and causes recorded in the profile `notes`.

No second C# extractor exists, so the cross-validation oracle rule does not
apply; the resolution-rate categorisation and the BCL-stub namespace check are
the substitutes.

### 13.7 Distribution: one binary per OS, built from Linux

**Yes — dedicated binaries for macOS, Linux and Windows are one `dotnet
publish` matrix, and all of it cross-compiles from a single Linux job.**

| RID | artifact | notes |
|---|---|---|
| `linux-x64` | `codegraph-csharp-linux-x64` | the dev box and CI; `InvariantGlobalization` means no `libicu` needed |
| `linux-arm64` | `codegraph-csharp-linux-arm64` | Graviton / Pi / Docker on Apple silicon |
| `osx-arm64` | `codegraph-csharp-osx-arm64` | Apple silicon; `chmod +x` after download; unsigned ⇒ Gatekeeper quarantine (`xattr -d com.apple.quarantine`) — documented, notarization is a later decision |
| `osx-x64` | `codegraph-csharp-osx-x64` | Intel Macs; also runs under Rosetta on arm64 |
| `win-x64` | `codegraph-csharp-win-x64.exe` | unsigned; SmartScreen warns once |

Publish shape, decided:

```
dotnet publish src/Codegraph.CSharp -c Release -r <rid> --self-contained \
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true \
  -p:PublishReadyToRun=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:DebugType=none -o dist/<rid>
```

- **Single-file self-contained, not NativeAOT.** Roslyn is not AOT-clean
  (`Microsoft.CodeAnalysis` emits trim/AOT warnings and relies on reflection
  for its own services), and NativeAOT needs the *target* OS's native
  toolchain, so macOS and Windows binaries would each need their own runner.
  Single-file bundles the runtime (~30 MB compressed) plus Roslyn and the ref
  pack; ~70–90 MB per RID, ~1 s cold start with ReadyToRun. Trimming stays OFF
  (`PublishTrimmed=false`) for the same Roslyn reason; revisit both when
  Roslyn ships AOT annotations — that is a build-flag change, not a code change.
- **Deterministic builds** (`Deterministic`, `ContinuousIntegrationBuild`,
  `PathMap`) so the binary, like the model, is reproducible from a commit.
- **Version** = `extractor.version` in the header = the assembly's informational
  version, set from one property in `Directory.Build.props`; `--version` prints
  it; `HeaderTest` pins that the three agree.

Wiring into the repo's scripts and CI:

- `build.sh --csharp` (and `--all` includes it when `extractors/csharp/`
  exists — `have_csharp_extractor`, `ensure_dotnet`); artifact report lists
  `extractors/csharp/dist/<host-rid>/codegraph-csharp`. `build.sh --csharp
  --publish-all` runs the five-RID matrix.
- `test.sh --csharp` → `dotnet test`, plus the **published-binary smoke test**:
  run `dist/<host-rid>/codegraph-csharp --src fixtures/csharp/src --out $tmp`
  and `cmp` against the committed snapshot. That the smoke test runs the
  *published* artifact, not `dotnet run`, is the point — it is the only test
  that sees the embedded-ref-pack path (§13.1) and the single-file `Location`
  trap.
- **CI moved to GitHub Actions with the repository (M12c, 2026-09-07)** —
  `.github/workflows/ci.yml` replaces `.gitlab-ci.yml`, and GitHub's hosted
  macOS and Windows runners turn the cross-OS check from a laptop ritual into
  a gate:
  - `verify` (the TypeScript workspace: build, typecheck, tests, `schemas/`
    drift) and `java` (`./mvnw test`) — the old gate, ported;
  - `csharp-test` — `dotnet test` on the SDK pinned by `global.json`;
  - `csharp-publish` — a five-job matrix, one RID each, every job calling
    `./build.sh --csharp --rid <rid>` so CI and a developer's machine share
    one definition of the publish flags; each binary is uploaded as an
    artifact (14 days);
  - `csharp-smoke` — a second matrix downloading each artifact onto a runner
    of ITS OWN OS (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest` for
    Apple silicon, `macos-15-intel`, `windows-latest`), running it on
    `fixtures/csharp/src` from the repo root with the relative `--src`, and
    `cmp`-ing the output with the committed snapshot. Nothing is installed on
    those runners for the extractor: the binary carries the runtime. A
    `.gitattributes` (`* text=auto eol=lf`, `*.jsonl -text`) plus
    `core.autocrlf false` keep the snapshot's bytes intact on Windows;
  - `release` — on a `v*` tag, the five binaries renamed after their RID plus
    a `SHA256SUMS` are attached to a GitHub Release.
  Measured locally first: the five-RID matrix cross-publishes from one Linux
  host in 287 s (57 s per RID, ReadyToRun included), and `file` confirms each
  artifact is a native executable of its target (ELF x86-64/aarch64, Mach-O
  x86_64/arm64, PE32+).
- `README.md` + `CLAUDE.md` architecture block gain `extractors/csharp/`;
  `extractors/csharp/README.md` mirrors the Java one (build, run, progress,
  the stderr summary, the toolchain gotchas above).

### 13.8 OS-specific hazards, each with the test that pins it

| Hazard | Where it shows | Guard |
|---|---|---|
| `Assembly.Location == ""` in single-file bundles | published binary binds no BCL; `dotnet run` is fine | embedded ref pack + smoke test on the published artifact |
| `libicu` missing | Linux containers, Alpine | `InvariantGlobalization=true`; the CI image test |
| Case-insensitive file systems | macOS, Windows: `Foo.cs` and `foo.cs` cannot coexist, and enumeration order differs | ordinal sort of the walked paths before parsing; `DeterminismTest` |
| `\` path separators | Windows anchors and `definedIn` | always emit `/`; `PathsTest` on a `\`-joined input |
| `\r\n` sources | Windows checkouts | Roslyn line map handles it; `sloc` scanner test with both endings |
| Culture-sensitive `string.Compare`/`ToUpper` | wrong canonical order on a Turkish locale | `StringComparer.Ordinal` everywhere; an analyzer rule (`CA1309`) as an error |
| `Utf8JsonWriter` escaping `<`, `>`, `&`, non-ASCII by default | `<global>`, `<init>`, unicode names | `UnsafeRelaxedJsonEscaping` + the core byte-identity gate |
| Gatekeeper quarantine | first run on macOS after a download | documented; not a code problem |
| Long paths | Windows `MAX_PATH` on deep corpora | `\\?\` not needed on .NET 10 with long-path awareness; `--src` a deep fixture in the Windows manual check |

### 13.9 Milestone split

- **M12a — skeleton + contract** ✅ (2026-09-07): profile v2 (core), toolchain
  scripts (`ensure_dotnet`, `build.sh --csharp [--publish-all]`, `test.sh
  --csharp` with the published-binary `cmp`), walking skeleton end to end
  (§13.6 first bullet), `snapshots --extractor` (a `.jar` runs under `java
  -jar`, anything else directly; `--jar` kept as an alias), and the extractor
  command-line contract as `schemas/README.md §8`, generated from core.
- **M12b — the model** ✅ (2026-09-07): members, all edge kinds, stubs,
  measures, literals, the full fixture and its snapshot, stub-discipline and
  determinism tests, CLI e2e, and the fixture in every per-fixture suite.
- **M12c — distribution + audit** ✅ (2026-09-07): five-RID publish matrix
  (cross-published from one Linux host in 287 s, each artifact a native
  executable of its target), GitHub Actions gate with the per-OS smoke test
  and tagged releases, the three-corpus audit (five defects fixed, resolution
  causes measured, implicit usings and the ASP.NET Core pack added), eShop
  city (187 districts, 1 176 buildings, 3 738 arrows) and navigator (4 493
  nodes, 10 751 rows, 7 cycles) reviewed as screenshots, profile `notes`
  rewritten from measurements, `docs/csharp-extractor.md` for running it
  with the SDK, the runtime, or nothing.

Definition of done: `fixtures/csharp/expected/model.jsonl` byte-identical to
core's encoder and profile-valid with zero issues; the same bytes from the
published `linux-x64`, `osx-arm64` and `win-x64` binaries on their hosts; the
audit numbers in the profile notes; `./test.sh` and CI green with the C#
fixture in every per-fixture suite.

### 13.10 The Java extractor's native distribution (GraalVM)

The Spoon extractor ships the same way: one executable per platform, no runtime
to install. The mechanism is not the same, and the difference is not cosmetic.

**native-image cannot cross-compile.** `dotnet publish -r osx-arm64` works from
Linux because .NET ships prebuilt per-RID runtimes and the app stays portable IL.
GraalVM instead runs an AOT compiler *and the host's native linker*, so a macOS
binary is built on macOS. The C# matrix is five RIDs in one Linux job plus five
smoke jobs; the Java matrix is **five jobs, each building and proving its own
RID** (`java-native` in `.github/workflows/ci.yml`).

| RID | runner | artifact |
|---|---|---|
| `linux-x64` | `ubuntu-latest` | `codegraph-java-linux-x64` |
| `linux-arm64` | `ubuntu-24.04-arm` | `codegraph-java-linux-arm64` |
| `osx-arm64` | `macos-latest` | `codegraph-java-osx-arm64` |
| `osx-x64` | `macos-15-intel` | `codegraph-java-osx-x64` |
| `win-x64` | `windows-latest` | `codegraph-java-win-x64.exe` |

Build shape, decided:

```
native-image -jar target/codegraph-java.jar -o dist/<rid>/codegraph-java \
  --no-fallback -march=compatibility
```

- **From the shaded jar**, deliberately: the binary and `java -jar` are then the
  same artifact compiled two ways, and cannot drift. Reachability metadata and
  the platform reference travel inside that jar.
- **`--no-fallback`** — a missing reflection entry must fail the BUILD, never
  produce an image that silently needs a JVM.
- **`-march=compatibility`** — the baseline ISA, not the builder's CPU. A
  released binary runs on the machine that downloads it.
- ~42 MB, ~3 ms startup, and **13× faster than the jar** on the fixture corpus
  (0.13 s vs 1.78 s) — no JIT warm-up on a process that exits in a second.

**The hard part was not the compiler: it was the platform library.** ECJ, given
no `-bootclasspath`, resolves `java.*` against the class library of the JVM it
runs inside. A native image has no JVM, no `java.home`, and no boot classpath —
and Spoon's noClasspath mode does not degrade gracefully when `java.lang` is
absent, it INVENTS: `System.out.println(…)` yields a type named `out`, a type
variable `T` becomes an entity. Measured on `fixtures/java/src`: 84.9%
resolution and 40 stubs, against 94.5% and 27.

So the binary carries its own, exactly as the C# extractor embeds the BCL
reference pack (§13.1). Two build outputs, both generated from the build JDK's
`lib/ct.sym` by `PlatformReferenceJar` and both landing inside the shaded jar:

1. **`java-api.jar`** — the Java 17 public API as signature-only class files,
   4,721 classes / 2.6 MB (a JDK image is ~130 MB). Handed to Spoon as the
   *source classpath*, which ECJ searches LAST — bootclasspath, extdirs,
   sourcepath, classpath. On a JVM the VM's own library still wins, so `java
   -jar` behaviour is untouched and the committed snapshot did not move.
2. **A reachability-metadata file naming `java.base`'s 1,352 types.** Spoon
   resolves an *import* through the runtime classloader, not through ECJ —
   proved by running the jar under `--limit-modules java.base`, which flips
   exactly the `java.sql.*` imports from `declared` to `derived` while ECJ still
   sees them. `java.base` only: registering the rest pulls AWT, fontmanager and
   sound natives into the image and the single file becomes a directory of
   shared objects.

Two smaller obstacles, both recorded because they are invisible until they bite:
ECJ's `handleExtdirs` dereferences `getJavaHome()` unconditionally, so the image
NPEs before parsing a single file unless `java.ext.dirs` is set (empty is the
truth — extension directories are a JDK 8 relic); and the reflection metadata for
Spoon/ECJ itself is agent-traced over three corpora and **committed** under
`src/main/resources/META-INF/native-image/`, because a trace of one corpus misses
what another needs.

**The residual, stated exactly.** On `fixtures/java/src` the binary reproduces
the committed snapshot byte for byte. On gson (86 files, 3,635 entities, 9,260
edges) the entity table is byte-identical to the jar's and **3 of 9,260 edges**
differ: imports of `java.sql.*` carry `derived` instead of `declared`. The
package they point at is unchanged, no entity is affected, and it is the same
answer a JVM limited to `java.base` gives. That is provenance doing its job —
the metamodel has a word for "inferred, not read" precisely so this can be
reported rather than hidden.

Wiring, mirroring the C# story so the two cannot disagree:

- `./build.sh --java --native` → `extractors/java/dist/<host-rid>/codegraph-java`;
  `ensure_native_image` finds GraalVM (GRAALVM_HOME, JAVA_HOME, PATH, sdkman).
- `./test.sh --java` runs `./mvnw test` and then, if a binary exists, the
  **native smoke test**: the binary re-extracts the fixture corpus and must
  reproduce the snapshot. It is the only test that sees the image's
  platform-library path, and `--no-fallback` cannot catch a wrong one.
- CI builds and smoke-tests all five RIDs and attaches them to a `v*` release
  beside the C# binaries.

## 14. Phase 11 — TypeScript extractor (the compiler API) and self-hosting (M13)

Motivation: the third real extractor closes the loop the plan opened in §10 —
**run codegraph on codegraph**. It is also the first extractor written in the
same language as `core`, which makes it the sharpest test of the boundary rule:
when importing `@codegraph/core` is one line away, an extractor must still
conform using nothing but `schemas/`. TypeScript brings the two metamodel
features no other profile exercises — `Entity.space` (type vs value) and
declaration merging — and its own flavour of non-compilable legacy: the
pre-ES-module codebase of `namespace` blocks and `/// <reference path>`
directives compiled with `outFile`, which no modern toolchain builds any more.

**What is the Spoon / Roslyn of TypeScript?** The answer is the language's own
compiler, used as a library — the `typescript` npm package, the same package
that ships `tsc`:

| Roslyn | TypeScript compiler API | Role |
|---|---|---|
| `CSharpCompilation` | `ts.Program` (`ts.createProgram`) | one compilation over a set of files and options |
| `SyntaxTree` / `SyntaxNode` | `ts.SourceFile` / `ts.Node` | the concrete syntax tree, positions included |
| `SemanticModel` | `ts.TypeChecker` (`program.getTypeChecker()`) | binding and typing on demand: `getSymbolAtLocation`, `getTypeAtLocation`, `getResolvedSignature` |
| `ISymbol` | `ts.Symbol` — with `declarations[]`, plural | the binder's view; the plural is declaration merging made explicit |
| `MetadataReference` (the BCL ref pack) | `lib.*.d.ts` inside the package | the standard library, resolved from the package's own directory |
| `IErrorTypeSymbol` | the `any`/error type from an unresolved name | binding failure, tolerated, never fatal |

It is error-tolerant by construction: a `Program` over files with missing
modules, missing types and type errors still binds everything that binds —
`tsc` prints diagnostics and emits anyway. So "noClasspath" is not a mode to
switch on, it is the default; the extractor's job is to keep the honest
distinction between "resolved to a declaration" and "resolved to `any`".

The alternatives, and why they are not the baseline:

| Candidate | What it is | Verdict |
|---|---|---|
| **ts-morph** | a convenience wrapper over the compiler API (Spoon-like navigation, `findReferences`) | rejected — wraps every node in an object, so memory and time scale badly on the corpora this pipeline exists for; lags TypeScript releases; adds nothing the extractor needs beyond the checker it already wraps |
| **tree-sitter, swc, oxc, Babel, esbuild** | parsers — fast, error-tolerant, no binder | rejected as a baseline — without a checker every call is a `dynamic-candidate` and every import an unresolved string; the model would be a lexical approximation of the graph. A syntactic pass is not needed for speed either: the compiler API parses a million lines in seconds; the checker is what costs |
| **scip-typescript** (Sourcegraph) | an indexer built on the same compiler API, emitting SCIP occurrences | not for this extractor — SCIP carries definition/reference/implementation occurrences, not kinds, traits, provenance, `access` vs `invocation`, or spaces. It remains the cheap multi-language *adapter* path §10 lists, whose output is a lower bound of this one |
| `ts.createLanguageService` | the editor-facing incremental layer | unnecessary — one batch program per run; incremental extraction is the temporal track's problem (§11.4) |

Three principles, locked up front:

1. **The checker without a build — the noClasspath of TypeScript.** The
   extractor never runs `tsc`, never builds project references, and never
   needs `node_modules`. It walks `--src` for `*.ts`, `*.tsx`, `*.mts`,
   `*.cts` (and `*.js`/`*.jsx` under `--allow-js`), skipping `node_modules`
   and build output, and creates ONE `Program` over all of them. A
   `tsconfig.json` is read for **resolution options only** — `paths`,
   `baseUrl`, `rootDirs`, `jsx`, `lib`, `target` — never for `files`/`include`
   (the roots define the corpus) and never for `references`. A module
   specifier that resolves to nothing is a **stub module keyed by the
   specifier**, not a dropped edge; a package that is not installed is a stub,
   not a failure. One resolution the standard host does not do, and this one
   does: a bare specifier that names a package declared *inside the roots*
   (`@codegraph/core` → the `package.json` under `packages/core`) resolves to
   that package's source entry even with nothing installed and nothing built
   — the monorepo's own packages are corpus, not dependencies.
2. **No metamodel intelligence — and no `@codegraph/*` at runtime.** The
   extractor's only runtime dependency is `typescript`. A boundary test (the
   twin of `packages/llm/test/boundary.test.ts`) pins that nothing under
   `extractors/typescript/src` imports `@codegraph/`; core is a
   *dev*Dependency for the extractor's own tests, where validating one's
   output against the reference implementation is exactly right. Two
   reasons: the core-side gate — "byte-identical to what core's encoder
   writes" — is a statement about two independent encoders only if they are
   independent; and a package that depends on `typescript` alone can be
   published and run with `npx` on a machine that has never seen this repo.
3. **Byte-identity across OS and across install state.** Two runs over one
   unchanged corpus write the same bytes on Linux, macOS and Windows — the C#
   contract — and, because external entities are keyed by **package name**
   (from the nearest `package.json`) and never by a resolved
   `node_modules/…/index.d.ts` path, the *keys* of a model do not depend on
   what happens to be installed. Edge *counts* do (an uninstalled package's
   exports are `any`, and a call through `any` is dropped and counted), and
   the fixture snapshot is produced with no `node_modules` at all, so the
   committed bytes are reproducible from a bare checkout.

### 14.1 Toolchain and repository layout

```
extractors/typescript/                 pnpm workspace package `codegraph-typescript` (public name; bin of the same name)
  package.json                         dependencies: typescript (catalog) — NOTHING else at runtime
                                       devDependencies: @codegraph/core, vitest, fast-check, tsup
  tsconfig.json                        strict, NodeNext, extends ../../tsconfig.base.json
  src/
    main.ts                            CLI: the extractor contract (schemas/README.md §8) + --tsconfig, --allow-js, --ignore-node-modules
    corpus.ts                          pass 0: walk (ordinal order), tsconfig resolution options, the workspace-package resolver, ts.createProgram
    whitelist.ts                       pass 1: the declared-symbol set (every declaration under the roots and outside node_modules)
    ids.ts                             THE TypeScript id scheme (§14.3): keys, escaping, spaces
    entities.ts                        pass 2
    edges.ts                           pass 3
    stubs.ts                           pass 4: lib / package / <unresolved> stubs, stub modules for specifiers
    measures.ts                        sloc (ts.createScanner — the compiler's own lexer, JSX and template literals included) + cyclomatic
    literals.ts                        const initializers, enum values (checker.getConstantValue), decorator arguments, parameter defaults
    model/                             NaturalKey, Entity, Edge, canonical order, JsonlWriter (JSON.stringify — the reference bytes, natively), Progress
  test/                                vitest; the C# suite's names where the property is the same (snapshot, determinism, stub-discipline,
                                       ids, schema-per-line, cli, boundary) + spaces, merging, escaping
  bin/codegraph-typescript             `#!/usr/bin/env node` → dist/main.js
fixtures/typescript/src/               the reference corpus (§14.6): `acme-order`, the Java and C# corpora's twin, plus a legacy script half
fixtures/typescript/expected/model.jsonl
```

- `pnpm-workspace.yaml` gains `extractors/typescript`; `pnpm -r build/test/typecheck`
  cover it with no new tooling. `build.sh --ts` already builds it; `test.sh
  --ts` gains the built-bundle smoke test: run `bin/codegraph-typescript` on
  `fixtures/typescript/src` and `cmp` with the snapshot — the one test that
  sees the bundled code path rather than vitest's source aliasing.
- **`typescript` stays external to the tsup bundle.** `ts.createProgram`
  locates `lib.*.d.ts` relative to `typescript.js`
  (`ts.getDefaultLibFilePath`); a bundle that inlines the compiler binds no
  standard library and every `Array`, `Promise` and `string` method becomes
  `<unresolved>` — the `Assembly.Location` trap of §13.1 in its Node form. A
  test pins that `Array` resolves to a stub in module `<lib>`, and runs
  against the *built* bin, not the sources.
- The pinned compiler version is the workspace catalog's (`typescript`
  ^5.9); the header's `extractor.version` is the package version and the
  compiler version rides in `extractor` as an extra key (the header schema
  allows it), so a model says which checker produced it.
- `codegraph snapshots --extractor` learns one more launcher rule beside
  `.jar → java -jar`: a `.js`/`.mjs`/`.cjs` file runs under `node`. Anything
  else, `bin/codegraph-typescript` included, still runs directly.
- Node ≥ 22 is already a requirement of codegraph itself, so "nothing to
  install" holds for anyone who can run the analyzer. A Node single-executable
  build is deferred (§14.7).

### 14.2 Mapping table (TypeScript profile) — and the profile corrections M13 forces

The profile (`packages/core/src/profiles/typescript.ts`) predates M6, M10 and
M12; the first M13 commit is `feat(core): typescript profile v2`, data changes
with the M12 pattern of justification:

| Change | Why |
|---|---|
| kind `constructor` added: `TInvocable, TWithChildren, TWithParameters, TWithLocalVariables, TWithInvocations, TWithAccesses, TChildOf, TSourceAnchor` (+ `TComment`, `TMetrics`); no `TNamed`, no `TTypedEntity` | the Java/C# shape; a class constructor is not a `method` named `constructor` — it has no return type and its parameter properties declare fields |
| `TMetrics` optional on every type kind and every invocable; `module` too | M10b: `sloc` + `cyclomatic`, so `--height sum:cyclomatic` works on a TypeScript city unchanged. A module's top level is executable code, hence measured |
| `TWithValue` optional on `variable` (`const` initializers), `property` (enum members, readonly literals), `parameter` (defaults) | M10c, the value door; an enum member is a `property` whose value is its constant |
| `TWithInvocations`, `TWithAccesses`, `TWithLocalVariables` optional on `module` | a module body IS a scope with statements: `app.listen()` at top level is an invocation FROM the module, and `const x = …` at top level is a local of it. Without the licence the model states edges from an entity its profile says cannot have them |
| edges `annotationUse` and `throws` added | decorators ARE annotation usage (M10c's edge kind, with `arguments`); `throw` sites are the M10d-era evidence the insights walk consumes |
| `arrowFunction` / nameless `function` disambiguator: `line:column` | the M7 lesson (§5.3): two arrows on one line collide on `(file, line)`. The module is the file already, so the disambiguator needs no file component |
| merging note rewritten: a merged symbol is one entity **per declaration file**, one entity per file for same-file merges | the module is the file and containment is where a thing is written (invariant 5). The old note ("one namespace id may span files") contradicted both. An edge to a merged symbol targets the declaration that owns the referenced member (§14.3) |
| new note: key escaping (`/`, `#`, `%` and, in names, `.`) | the file path is the module and `/` is a reserved separator (§14.3) |
| `space` on `enum` becomes per-entity: `["type"]` for `const enum` | the profile already says `const enum` members leave no runtime entity; the entity should say so where analyses read it |
| `any`-receiver note reworded: dropped and COUNTED, never emitted as `dynamic-candidate` | the M10d/M12 decision: candidate generation is the analyzer's, which alone has whole-corpus knowledge |

Construct → kind, on top of the profile's table:

| TypeScript construct | kind | notes |
|---|---|---|
| a source file, module or script | `module` | `definedIn` = the one file; `space: ["value"]`. A **script** (no import/export) puts its declarations in the global scope *semantically*, but they are still children of the file (invariant 5); nothing lives in a `<global>` module |
| `namespace X` / `module X {}` (internal module), nested `X.Y` | `namespace` | child of the file or the enclosing namespace; `space` from what it declares (`["type"]` if it exports only types) |
| `declare module "pkg" {}` (ambient external module) | `module` | keyed by the quoted name (`ts:pkg`), `definedIn` = the `.d.ts`, `isStub: false` — it IS declared by the corpus; `import "pkg"` resolves to it |
| `declare global {}` and module augmentations `declare module "express" { interface Request { user: User } }` | no entity for the block | its members are ordinary declared entities parented by the augmented type — a stub type when the package is external (§14.4) |
| `class`, `abstract class`, class expression bound to a name (`const A = class {}`, `export default class {}`) | `class` / `abstractClass` | name from the binding (`default` for a nameless default export); a class expression with no binding is not an entity (dropped and counted), its members neither |
| `interface` | `interface` | `extends` → `inheritance` (multiple); `space: ["type"]` |
| `type T = …` | `typeAlias` | constituents → `reference` edges |
| `enum`, `const enum` | `enum` | members → `property` children with `TWithValue` (`checker.getConstantValue`); `const enum` → `space: ["type"]` |
| function declaration, overload signatures + implementation | `function` | ONE entity, anchored at the implementation (or the sole ambient signature); overload signatures are not entities. `signature` is the implementation's |
| function expression, arrow function | `function` (no `TNamed`) / `arrowFunction` | `#line:column`; `const f = () => {}` yields the `variable` f AND its child arrow (profile rule); call sites target the arrow |
| method, `get`/`set` accessor, `static` member, `abstract` method, object-literal method | `method` | accessors: `#get` / `#set`; static: `#static` (§14.3) |
| `constructor(…)` | `constructor` | parameter properties (`constructor(private x: T)`) yield BOTH a `parameter` and a `property` |
| property declaration, `accessor` field, object-literal property, enum member | `property` | index signatures are not entities |
| `#private` member | `method` / `property` | name escaped (`%23secret`), never the unescaped `#` |
| `var`/`let`/`const` at any level, every binding of a destructuring pattern | `variable` | parent = module / invocable / block-owning invocable; `TWithLocalVariables` on the owner lists them |
| parameter, `this` parameter excluded | `parameter` | `#param:name` below the owner, below the owner's own disambiguator when it has one |
| type parameter | not an entity | its constraint and default → `reference` edges from the declaring entity |
| decorator `@Dec(args)` | `annotationUse` edge with `arguments` (literals) | legacy (`experimentalDecorators`) and TC39 decorators alike — both parse; the *decorator* is an ordinary `function`/`variable` entity |
| `import x from "m"`, `import { a as b }`, `import * as ns`, `import type`, `export … from`, `export * from`, `import("m")` / `require("m")` with a literal, `/// <reference path="…">` | `import` → the module | module-level, never a member (the Java fold). `import type` is an ordinary import edge whose erasure shows in the target's `space`. A computed specifier is dropped and counted |
| `class A extends B` | `inheritance` | `extends Mixin(Base)`: the checker's base type if it names a declaration, else a `reference` to what is named, counted |
| `class A implements I` | `interfaceImplementation`, provenance `declared` | structural conformance is NOT computed by the extractor — `derived` conformance is an analyzer enrichment, never mixed in |
| call, `new`, tagged template, optional call `f?.()`, JSX element `<Comp/>` with a component tag | `invocation` | target = the resolved signature's declaration, else every declaration of the callee's symbol (a union receiver's synthetic symbol has the real ones); receiver typed `any`/`unknown`/error → dropped and counted. A JSX element is a call by the language definition, so the edge is `declared`; intrinsic tags (`<div>`) yield nothing |
| property read / write / compound / `delete`, destructuring reads, `obj["lit"]` | `access` (`isRead` / `isWrite`) | computed non-literal keys dropped and counted; a property access that runs an accessor is `access`, not `invocation` (the C# rule) |
| type positions: annotations, generic arguments, `as`, `satisfies`, `typeof X` in a type, `keyof T`, `import("m").T`, conditional/mapped-type operands, heritage clause type arguments, `instanceof X` | `reference` | to named types only; primitives, literal types, type parameters and `any` name nothing |
| `throw expr` | `throws` | the static type of `expr` when it names a declaration; rethrow → the caught binding's static type; else dropped and counted |
| JSDoc / leading doc comment | `comments` | the declaration's own JSDoc, not every leading comment |

Explicitly NOT extracted in M13, stated in the profile `notes`: structural
(`derived`) interface conformance; `emitDecoratorMetadata` synthesis; CommonJS
`module.exports` reassignment shapes beyond a literal `require`; monkey
patching (the JS profile's rules apply verbatim); Vue/Svelte/Angular template
files (only `.ts`/`.tsx` bodies are read — a `.vue` SFC's script block is a
later `--extract-sfc` flag, never a default); `declare` d code whose
implementation is in a language the pipeline does not model (native
addons).

### 14.3 The TypeScript id scheme (`ids.ts`)

```
module (file)         ts:src%2Facme%2Forder.ts                  path relative to root, escaped
ambient module        ts:express                                 declare module "express" in the corpus
external package      ts:zod/ZodType     ts:@types%2Fnode/Buffer  nearest package.json `name` under node_modules
external subpath      ts:zod%2Fv4                                 an import edge's target: the specifier as written
lib                   ts:<lib>/Array                             lib.*.d.ts inside the typescript package
unresolved name       ts:<unresolved>/Ledger                     a name that binds to nothing, as written
unresolved specifier  ts:.%2Fmissing     ts:@megacorp%2Fledger    a stub module for an import nothing resolves
type / value          ts:src%2Facme%2Forder.ts/OrderService     nested namespaces: Ns.Inner.Type
member                ts:src%2Facme%2Forder.ts/OrderService.bill no parameter list — TypeScript overloads are one declaration
static / accessors    …/OrderService.create#static   …/OrderService.total#get   …/OrderService.total#set
constructor           …/OrderService.constructor
nameless invocable    …/OrderService.bill#12:7     top level: ts:src%2Fa.ts#3:15
parameter / local     …/OrderService.bill#param:order   …/OrderService.bill#12:7#param:x
```

- **Escaping, the one rule.** `renderId` reserves `/` and `#` in a module
  and `#` in a symbol so rendering stays injective; a file path is made of
  `/`. Every path segment and every non-identifier name entering a key is
  percent-encoded for exactly `/` → `%2F`, `#` → `%23`, `%` → `%25`, and —
  for names only, where `.` is the nesting separator — `.` → `%2E`.
  Identifiers cannot contain any of the four, so an identifier is written
  as-is and the encoding is injective and reversible; the extractor's
  `escape`/`unescape` pair is pinned by a fast-check round-trip property.
  Rejected alternatives: relaxing core's reservation (breaks rendering
  injectivity for every language, since a module entity renders with no
  `/` after it); a look-alike separator such as U+2215 (not typeable on a
  CLI or in a SQL query); dropping the extension or dotting the path
  (`a.b/c.ts` and `a/b.c.ts` collide). The `name` of the module entity is
  the unescaped path, which is what the city and navigator display.
- **Module = file, always.** The `<global>` module of C# has no counterpart:
  a script file's globals are children of the file (invariant 5), and an
  entity's module is the file it is written in. Consequence for declaration
  merging: an `interface Order` in two files is two entities; two in one file
  is one entity anchored at the first. A reference to a merged symbol targets
  the declaration that owns the referenced member (`checker.getSymbolAtLocation`
  on the member gives one declaration); a reference to the merged container
  itself targets its **first declaration in canonical file order** — a
  deterministic choice, named in the profile note as one.
- **Overloads are one entity** — TypeScript has no overloading by parameter
  type at the declaration level; the overload list is one function's
  signature set. No parameter-list component, unlike Java and C#.
- **Same-name members that TypeScript allows to coexist** get a
  disambiguator: `static` for static members (a class may declare `static
  parse()` and `parse()`), `get`/`set` for accessor pairs. The disambiguator
  is the only place these flags are identity, so a class with only an
  instance `parse` renders with no suffix — the absent-first canonical order
  puts the instance member first.
- **Nameless invocables** carry `line:column` of their first token, below
  the nearest *named* ancestor's symbol and below that ancestor's own
  disambiguator when it has one — so two arrows on one line are two
  entities, and an arrow inside an arrow does not become its own parent (the
  METAMODEL §1.1 column rule). At module top level the symbol is empty and
  the disambiguator alone identifies the entity: `ts:src%2Fa.ts#3:15`.
  METAMODEL §1.1 says the symbol is "empty only for a module"; M13a loosens
  that by one clause ("or for a nameless entity at module top level, which
  then carries a disambiguator"). Verified (2026-09-08): the JSONL reader
  recognises a module record by `m === i`, and `renderId` only omits the
  `/` for an empty symbol — nothing in `core` or the analyzer treats an
  empty symbol as the module marker, so the form needs no new encoding.
- **Stub keys have the same shape as declared keys** — membership is the
  whitelist, never the key. An external type's module is the npm package
  name (walk up from the declaring file to the nearest `package.json`),
  never the resolved path under `node_modules`, so keys are the same on
  every machine; an import edge's stub module is the specifier as written
  (`zod` and `zod/v4` are two entry points, honestly two modules). Node
  built-ins are normalised to the `node:` form (`fs` and `node:fs` are one
  module in fact, and `module.builtinModules` says which names those are).

### 14.4 Stub discipline, checker edition

Pass 1 builds the whitelist: every `ts.Symbol` at least one of whose
declarations lies in a file under the roots and outside `node_modules`. Then:

| The checker says | The model says |
|---|---|
| declared in the corpus | a declared entity |
| declared only under `node_modules/<pkg>` | stub type in module `<pkg>`; a member reference into it retargets to the type stub (the C# fold); a free function or variable exported by the package retargets to the **stub module** — the smallest degraded container a module-level value has |
| declared in `lib.*.d.ts` | stub type in `<lib>`; `string`/`number`/`boolean`/`symbol`/`bigint`/`void`/`null`/`undefined` and literal types are not entities (the Java primitive rule) |
| an error type / `cannot find name` | stub in `<unresolved>`, named as written — never a guess from the file's imports |
| a specifier that resolves to nothing | a stub module keyed by the specifier; the import edge survives (import fan-out stays honest) |
| `any` / `unknown` / an index signature on a receiver | the edge is dropped and counted; the count is the profile's stated resolution ceiling |
| a corpus declaration merged into an external one (module augmentation) | the corpus members are declared entities parented by the stub type — closure holds because the stub exists; `isStub` is a fact about the type, not about its members |
| the `typescript` package itself, when a corpus imports it | an external package like any other (`ts:typescript/Node`) — the extractor's own dependency is not corpus |

Two things the checker resolves that are still external: the standard library
(`<lib>`) and installed packages. Resolvability is not membership — the C#
rule, verbatim.

The **workspace-package resolver** (principle 1) is the one place the
extractor adds resolution the compiler host lacks, and it is bounded: a bare
specifier whose package name matches a `package.json` `name` under the roots
resolves to that package's source entry — the `source`/`module`/`main`/`types`
field that points at a file under the roots, else `src/index.ts` when it
exists — and *only* when standard resolution failed. It never reads
`node_modules` to do so, never follows `exports` conditions into `dist/`
(build output, not corpus), and names every such resolution on stderr under
its own counter, because it is a fact about the repository layout rather than
about the language. A subpath into a workspace package (`@acme/pricing/rules`)
resolves the same way below that package's source root, else stubs.

### 14.5 The extractor command-line contract, plus three flags

Same flag shape and exit codes as the Java jar and the C# binary
(`schemas/README.md §8`) — `codegraph snapshots` must stay language-blind.
Three additions, all optional:

| Flag | Meaning |
|---|---|
| `--tsconfig <file>` | the `tsconfig.json` whose *resolution options* apply (`paths`, `baseUrl`, `rootDirs`, `jsx`, `lib`, `target`, `allowJs`); default: the nearest `tsconfig.json` at or above each `--src` root, the first root's winning on conflict (named on stderr); `none` for the synthesized defaults (`target esnext`, `moduleResolution bundler`, `lib esnext + dom`, `jsx preserve`, `skipLibCheck`, `noEmit`) |
| `--allow-js` | also walk `*.js`/`*.jsx`/`*.mjs`/`*.cjs`; JSDoc types feed `declaredType` (the JS profile's rule); the model still claims `lang: "ts"` — a mixed corpus is a TypeScript program with JavaScript files in it, which is what the checker models too |
| `--ignore-node-modules` | never read `node_modules`, even when present: every external package is an unresolved stub module. What the fixture uses, and what makes two machines' models key-and-edge identical |

`stdout` carries nothing but `--help`/`--version`; progress and the resolution
summary go to `stderr`:

```
✓ walk        310 files  0.1s
✓ program     310 files, tsconfig ./tsconfig.base.json, lib esnext  2.4s
✓ whitelist   4 812 symbols  0.3s
✓ entities    9 340 entities  1.1s
✓ edges       21 907 edges  1.8s
✓ stubs       417 stubs (lib 96, packages 288, <unresolved> 33)  0.1s
✓ write       31 664 records  0.4s
RESOLUTION SUMMARY
  type references : 21 907
  resolved        : 20 588
  unresolved      : 1 319
  resolution rate : 94.0%
  any-typed receivers (dropped) : 212   ← the honest ceiling (profile note)
  imports         : 1 204 (unresolved: 41, workspace-resolved: 388)
  entities        : 9 757 (stubs: 417)
  edges           : 21 907 (self-edges dropped: 3, computed accesses dropped: 19, nameless classes dropped: 1)
wrote model.jsonl
```

### 14.6 Validation (the M2 gate, replayed a third time)

- **Walking skeleton first**: modules and imports (resolved, workspace-resolved,
  unresolved → stub modules), every type kind with `space`, inheritance /
  implements, stubs — one file in, `codegraph validate` green, snapshot
  committed, the core gate `packages/core/test/fixtures-typescript.test.ts`
  (parses as a `Model`; byte-identical to core's encoder; ZERO profile
  issues; closed; no self-edges; the stub-discipline evidence by id).
- **The fixture corpus** `fixtures/typescript/src` — `acme-order` as an ES
  module package tree plus a **legacy script half** — around 18 files, 350
  lines, each pinning one hazard (its README lists them, the Java README's
  form):
  - `tsconfig.json` with `paths` (`@acme/*`) and a second workspace package
    `packages/pricing` imported by name with **no `node_modules` and no
    `dist`** — the workspace resolver's case;
  - `@megacorp/ledger` imported and never present — the stub-module case;
    `Ledger` extended from it — inheritance from a stub; a call through its
    `any` export — the dropped-and-counted case;
  - `import type` and an inline `type` specifier — erased imports whose edge
    is the same kind;
  - `interface Order` merged **in one file** and again **across two files**;
    a `namespace Acme.Order` in two script files joined by `/// <reference
    path>` — the legacy internal-module style; a module augmentation of the
    absent package;
  - `const enum Channel` and a plain `enum` with computed and literal
    members — `space: ["type"]` on one and `TWithValue` on both;
  - two arrow functions on one line, an arrow inside an arrow, a top-level
    arrow (`ts:…#line:col`), an IIFE;
  - overloads with one implementation; `static parse()` beside `parse()`;
    a `get`/`set` pair; a `#private` field; a string-literal member `"a.b"`
    and a computed `[Symbol.iterator]` — every escaping rule;
  - a `.tsx` component tree (`<OrderTable rows={…}/>`) — JSX invocations;
  - decorators with literal arguments (both syntaxes, two files);
  - `throw new OrderError(...)`, a rethrow, a `throw "string"` (dropped);
  - parameter properties, destructured parameters and locals, a `declare
    module "legacy-lib"` ambient in a corpus `.d.ts`, `export default class
    {}`, `export * from`, a dynamic `import("./lazy")` with a literal and
    one with a template (dropped and counted), a compound assignment
    (`isRead` and `isWrite` both).
- **The extractor's own suite** (vitest): per-line schema validation against
  `schemas/*.schema.json` and the sequence rules; the trait-key rule of
  contract §4; snapshot byte-identity; determinism (two runs, shuffled walk
  order, CRLF-converted sources, `--src` given as `a b` and `b a`);
  stub discipline by id; the escaping round-trip property; the spaces of
  every fixture kind; merging (which declaration an edge lands on); the
  built bin's CLI (exit codes 0/1/2, silent stdout, `--version`); the
  boundary test; `Array` resolving to `<lib>` **from the built bundle**.
- **The fixture in every per-fixture suite**: analyzer (`fixture.ts` loaders,
  conformance, coupling, cycles, store import/fold/diagnose), city, navigator,
  CLI e2e (`validate`, `analyze`, `export`, `import`, `city`, `navigator`,
  `domain-facts`, `explain --dry-run`).
- **Self-hosting — the DoD of the phase.** `codegraph-typescript --src packages
  --src extractors/typescript --out codegraph.jsonl` on this repository:
  `validate` clean, zero `<unresolved>` entities that name a corpus symbol
  (every one must be a genuinely absent dependency, named in the audit),
  `analyze --report cycles` agreeing with the package boundaries CLAUDE.md
  states (no cycle crosses a package; `viz` and `navigator-ui` import their
  model packages for types only — the boundary tests restated as a graph
  query), and the city and navigator of codegraph reviewed as screenshots at
  user-facing angles.
- **Three-corpus audit**, the M12c pattern, with resolution causes measured
  and the residue named in the profile `notes`:
  - **TypeScript 4.9's own `src/compiler`** — the legacy corpus: `namespace
    ts {}` in a hundred files merged by `/// <reference>`, `outFile`-style,
    no ES modules. Merging, script-file globals and the per-file entity rule
    at scale;
  - **nestjs/nest** — decorators everywhere, a pnpm monorepo of packages
    importing each other by name: the workspace resolver and `annotationUse`
    at scale;
  - **excalidraw** — a large `.tsx` React corpus: JSX invocations, `any`
    density, `import type` erasure, path aliases.

  No second TypeScript extractor exists, so the oracle rule does not apply;
  the resolution-rate categorisation, the `<lib>` stub check and the
  self-hosting graph query are the substitutes.

### 14.7 Distribution: an npm package, and why not a binary yet

**`npx codegraph-typescript --src . --out model.jsonl` on any machine with
Node ≥ 22** — the same floor as codegraph itself. The published package
bundles the extractor into one file (tsup, `platform: node`, `typescript`
external) and declares `typescript` as its one dependency, so an install is
the compiler plus a few hundred kilobytes. `bin/codegraph-typescript` at the
repository root runs the same bundle from a checkout, and is what
`test.sh --ts` smoke-tests and what `codegraph snapshots --extractor` is
pointed at.

A **Node single-executable application** (SEA) per OS — the C# distribution
shape — is deferred, with the trap named now so it is not rediscovered: a SEA
embeds the bundle but not the `typescript` package's `lib/*.d.ts` files, and
`ts.getDefaultLibFilePath` then points into a directory that does not exist,
which binds no standard library and passes every test run from sources. Doing
it means embedding the lib files as assets and a custom `CompilerHost` that
serves them from memory — a build-and-host change, not a model change — and
it is worth doing only once someone needs the extractor on a machine without
Node, which today is nobody who can run the rest of the pipeline — and the
desktop distribution (§15) does not create that someone: `codegraph-typescript`
is a Homebrew formula that depends on Homebrew's `node`, so the machine has
Node without the user managing it, and this package stays exactly as it is.

Wiring into the repo's scripts and CI:

- `build.sh --ts` (already `pnpm -r build`) lists `extractors/typescript/dist`
  in its artifact report; `test.sh --ts` adds the built-bin `cmp` against the
  snapshot.
- `.github/workflows/ci.yml`: the `verify` job already builds and tests the
  package as part of the workspace; a `typescript-smoke` matrix runs the built
  bin on `fixtures/typescript/src` on `ubuntu-latest`, `macos-latest` and
  `windows-latest` and `cmp`s the output with the snapshot — Windows is the
  one that matters (`\` paths, CRLF checkouts, case-insensitive walks), and
  `actions/setup-node` makes it a two-step job. On a `v*` tag the package is
  published to npm with provenance (`npm publish --provenance`) beside the C#
  binaries on the release.
- `README.md` + `CLAUDE.md` architecture block gain `extractors/typescript/`;
  `docs/typescript-extractor.md` mirrors `docs/csharp-extractor.md` (run with
  `npx`, from a checkout, the flags, reading the summary, troubleshooting —
  the tsconfig-conflict and `<lib>`-empty symptoms first).

### 14.8 OS- and toolchain-specific hazards, each with the test that pins it

| Hazard | Where it shows | Guard |
|---|---|---|
| `typescript` inlined into the bundle | built bin binds no lib: every `Array` is `<unresolved>`; sources pass | tsup `external: ["typescript"]`; the `<lib>` test runs against the built bin |
| `\` path separators and drive letters | Windows anchors, `definedIn`, module keys | `ts.sys` paths normalised with `/` before they enter a key; `paths.test.ts` on a `\`-joined input; the Windows smoke job |
| case-insensitive file systems | macOS/Windows: the checker's `useCaseSensitiveFileNames` differs, `Foo.ts`/`foo.ts` cannot coexist, enumeration order differs | ordinal sort of walked paths; the host is created with `useCaseSensitiveFileNames: true` so keys keep the written case; `DeterminismTest` shuffles the walk |
| `\r\n` sources | Windows checkouts, `.gitattributes`-less corpora | `ts.getLineAndCharacterOfPosition` is EOL-agnostic; the `sloc` scanner test with both endings; the CRLF determinism case |
| `tsconfig` conflicts in a monorepo | two roots with incompatible `paths` | first root wins, the conflict named on stderr; `--tsconfig` overrides; a fixture with two roots |
| `Intl`/locale-sensitive sorting | canonical order on a machine with a different locale | comparisons by UTF-16 code unit (`<` on strings), never `localeCompare`; an eslint rule forbidding `localeCompare` in the extractor |
| `JSON.stringify` of lone surrogates and non-BMP names | byte identity with core | it IS core's encoder, natively — the one hazard this extractor lacks |
| memory on very large programs | the checker holds every type; `excalidraw` and `nest` are fine, `vscode`-sized corpora are not | `--max-old-space-size` documented; `Program` created with `skipLibCheck` and no emit; an explicit "one program per `--src` root" flag is a later enrichment if a corpus needs it |

### 14.9 Milestone split

- **M13a — profile v2 + skeleton + contract** ✅ (2026-09-08): `feat(core):
  typescript profile v2` (§14.2) with the METAMODEL §1.1 clause for nameless top-level entities;
  the workspace package with its boundary test; the walking skeleton
  (§14.6 first bullet) → `fixtures/typescript/expected/model.jsonl`
  byte-identical to core's encoder and profile-valid with zero issues; the
  core gate; `snapshots --extractor` running `.js` under `node`;
  `bin/codegraph-typescript`; `test.sh --ts` with the built-bin `cmp`.
- **M13b — the model** ✅ (2026-09-08): members (methods, accessors as
  `#get`/`#set`, statics as `#static` beside an instance twin, constructors,
  properties incl. parameter properties, enum members with computed values,
  parameters, destructured bindings, locals as `#local:name:line:column`,
  nested functions as `#fn:`), nameless invocables by `line:column`, bound
  object literals and class expressions, overloads folded to the
  implementation, cross-kind merging by rank; every edge kind incl.
  `annotationUse` with written arguments named after the factory's
  parameters and `throws` at the site; JSX elements as invocations;
  accessor writes on the setter; `sloc` + `cyclomatic`; constant-shaped
  values (`4 * 25` unevaluated); the full 23-file fixture and its README;
  the fixture in the analyzer, city, navigator and CLI suites; every CLI
  command verified on it. Snapshot: 193 entities / 127 edges.
- **M13c — self-hosting + audit + distribution** ✅ (2026-09-09):
  - **Codegraph on codegraph** (`--src packages --src extractors/typescript`):
    24 887 entities / 51 255 edges in 12 s, `validate` clean, 96.5 %
    resolution, ZERO `<unresolved>`, zero duplicates, zero unclosable edges;
    168 imports resolved to workspace packages by name. The architecture
    rules of CLAUDE.md hold as graph queries (`test/self-hosting.test.ts`):
    no dependency cycle crosses a package; `viz` and `navigator-ui` reach
    their model packages only through imports and through TYPE-space
    entities (interface members ARE type-space — the audit's first
    correction to the profile); `@openrouter/sdk` is imported by
    `packages/llm/src/openrouter.ts` alone, `three` by `viz` alone, `react`
    by `navigator-ui` alone. City (355 stub buildings unmeasured, as
    designed) and navigator reviewed as screenshots.
  - **Three-corpus audit**, every model `validate`-clean:

    | corpus | files | entities / edges | rate | `<unresolved>` | any-receivers | time |
    |---|---|---|---|---|---|---|
    | microsoft/TypeScript 4.9.5 `src/compiler` (namespaces + `/// <reference>`, `outFile` style) | 69 | 52 341 / 120 127 | 97.4 % | 3 (`Profile`, `Session`, `Stats` — node types with no `@types/node`) | 2 684 | 21 s |
    | nestjs/nest `packages` (decorators, a monorepo importing itself by name) | 902 | 29 992 / 32 537 | 88.6 % | 78 (fastify/express/class-transformer types, not installed) | 20 745 | 12 s |
    | excalidraw `packages` + `excalidraw-app` (`.tsx`, path aliases) | 628 | 43 706 / 62 557 | 94.4 % | 41 (react/mermaid/vitest types, not installed) | 24 954 | 23 s |

    All three ran with NO `node_modules`: the any-receiver counts are the
    ceiling the profile note describes — every call into an uninstalled
    package is a call through `any`, dropped and counted — and nest's 508
    workspace-resolved imports are its own `@nestjs/*` packages reached by
    `package.json` name. excalidraw's 303 stub modules are mostly font and
    asset imports (`./Excalifont-Regular-….woff2`), honest imports of
    non-code. Six defects found and fixed by the audit: members of an unbound
    object literal (array elements, arguments) were entities and collided
    (2 260 re-keyings on codegraph itself); a parameter owned an arrow written
    in its default value; methods of an unbound literal keyed their
    parameters under the enclosing function; members of an unbound class
    expression (`return class extends Base {}`, nest's dynamic modules)
    surfaced as members of the enclosing method and aborted the write with a
    dangling constructor; overloaded signatures with no implementation (an
    interface's, an ambient function's) each emitted parameters (74 on the
    compiler); a class expression bound to a PROPERTY (`static readonly
    ConfigProxy = class …`) was both a property and a class. Plus the safety
    net the contract asks for: an edge the model cannot close is dropped and
    counted (`unclosable`), never written dangling and never an abort.
  - **Distribution**: `typescript-smoke` in CI runs the built bundle on
    Ubuntu, macOS and Windows and `cmp`s the fixture snapshot; `npm-publish`
    on a `v*` tag publishes `codegraph-typescript` with provenance when the
    repository holds `NPM_TOKEN` (skipped, not failed, otherwise);
    `docs/typescript-extractor.md`; README and CLAUDE.md name the extractor.

Definition of done: `fixtures/typescript/expected/model.jsonl` byte-identical
to core's encoder and profile-valid with zero issues; the same bytes from the
built bin on Ubuntu, macOS and Windows runners; codegraph's own model
`validate`-clean with its package boundaries recovered as a graph query; the
audit numbers in the profile notes; `./test.sh` and CI green with the
TypeScript fixture in every per-fixture suite.

## 15. Phase 12 — The desktop app: one app, one Node binary, one install per extractor (M14)

Everything a user needs, from Homebrew, with nothing to manage on the machine
— no JDK, no .NET SDK, no Node of one's own. The app is ONE install; every
language extractor is its OWN install, taken only by those who need it:

```
brew install --cask defsquare/tap/codegraph            # Codegraph.app + `codegraph`
brew install defsquare/tap/codegraph-java               # one per language, as needed
brew install defsquare/tap/codegraph-csharp
brew install defsquare/tap/codegraph-typescript
brew install defsquare/tap/codegraph-elixir             # and every extractor to come
```

The cask puts `Codegraph.app` in `/Applications` and `codegraph` on `PATH`;
each formula puts one `codegraph-<language>` command on `PATH`. The app opens
a folder and shows the navigator with the city as a tab — the `codegraph
serve` page — after running the right extractor, which it FINDS on the
machine rather than carries; a folder whose language has no extractor
installed is answered with the one `brew install` line that fixes it. **The
CLI is the backend**: nothing is rewritten, the pipeline of §7, §11, §12 and
the navigator is called through a long-lived process instead of one command
line.

WHY SPLIT. Every extractor carries its own runtime — a GraalVM image for
Java, the .NET single-file host for C#, the BEAM for Elixir — and each is
tens of megabytes per architecture that a user of one language never needs.
One cask with every extractor inside would grow with each Phase 7+ language
and re-download all of them on every `brew upgrade` of any one; one formula
per extractor keeps the app download at the SEA and the shell, lets an
extractor release on its own cadence, and is the shape Homebrew already has
for a command on `PATH`. The extractors were designed as separate processes
under one command-line contract (§13.5, schemas/README.md §8) exactly so
this could be true: the app needs to know nothing about them but that
contract and the file extensions they claim.

Locked decisions, each with its reason (the delta table in §19 repeats them):

- **Tauri is the shell, not a runtime.** Window, native menu, folder dialog,
  drag-and-drop, sidecar lifecycle, bundling, signing and notarization. No
  business logic in Rust: the analyzer, the city and the navigator stay
  TypeScript, and the Rust crate never reads a `model.jsonl`. A Rust rewrite
  of anything under `packages/` is out of scope by construction.
- **The Node side is ONE binary, ONE program**, a Node single-executable
  application (SEA) built from the CLI bundle with the two frontends embedded
  as assets. It IS `codegraph` in a terminal and the daemon behind the app.
  It carries no extractor: the TypeScript extractor is its own install like
  every other (§15.1), so the image has no dispatch by name and no compiler
  inside — §15.3.
- **One install per extractor, each a formula in our tap.** `codegraph-java`,
  `codegraph-csharp`, `codegraph-typescript`, `codegraph-elixir`… are
  formulae in `defsquare/homebrew-tap`, one command on `PATH` each, per
  architecture where the runtime is native, generated by that extractor's own
  release job. The app bundles none of them and discovers what is installed
  (§15.4); a language without its extractor is a message naming the install
  line, never a silent failure. App and extractors version independently and
  meet on the interchange contract (`schemaVersion`, schemas/) — the same
  boundary that lets a Go or Python extractor exist without touching the app.
- **The page comes from the daemon, same origin.** The webview navigates to
  the daemon's loopback URL and fetches `navigator.json`/`city.json` beside it
  — exactly what `codegraph serve` does today (`?src=`/`?city=` and the
  sibling routes, unchanged). No Tauri IPC in the page, so `navigator-ui`
  never imports `@tauri-apps/*` (the boundary test scans for it) and CORS
  between `tauri://localhost` and `127.0.0.1` never arises. `frontendDist` is
  a one-line "starting…" page the shell replaces once the daemon has printed
  its port.
- **A capability URL, not an open port.** The daemon binds `127.0.0.1:0` and
  prints one JSON line `{ "port", "token" }` on stdout; every route lives
  under `/<token>/`. A code model is sensitive (§7's `--host` announcement
  exists for that reason), and on loopback any page in any browser could
  otherwise read it. The `Origin` header, when present, must be the page's own.
- **The daemon dies with its parent.** It exits when stdin reaches EOF, so a
  crashed or killed shell cannot leave an orphan holding a model in memory.
  The shell also kills the child on window close; both rules, not one.
- **Extractors are a registry the shell hands over, as data.** Each entry is
  `{ name, path, extensions[], launch, env?, install? }` — the §13.5 contract
  is the only thing the daemon knows about any of them, and the language-blind
  rule of §13.5 ("there is no `codegraph extract`") holds: the daemon runs a
  registry entry, it never names a language. Detection is a census of file
  extensions against `extensions[]`; a tie is a question the page asks, never
  a guess. The shell writes the registry from what it FINDS (§15.4): an entry
  it knows but did not find has no `path` and carries `install`, the line to
  type, and a tree only such entries claim is answered `not-installed` with
  that line.
- **Homebrew: a cask for the app, a formula per extractor, one tap, updates
  through `brew upgrade`.** Tauri produces a `.app` in a DMG, which is what a
  cask installs and a formula cannot; an extractor is a command on `PATH`,
  which is what a formula installs — from a prebuilt per-architecture binary,
  legitimate in our own tap (homebrew-core refuses vendored binaries; a tap
  does not). The Tauri updater plugin stays off: two update paths disagree
  eventually. Linux ships the Tauri `.deb`/AppImage on the GitHub release and
  Windows the NSIS installer — both built by the existing runner matrix, both
  outside brew's scope, neither a gate of M14; the extractors' binaries for
  those OSes are already on their own releases (§13.7, §13.10, §14.7).

### 15.1 What the TypeScript extractor (M13) changes, and what it keeps

M13 landed on `main` before this phase. With one install per extractor, the
TypeScript extractor stays exactly the npm package M13 shipped — and its
Homebrew form is a formula that installs that package under Homebrew's own
`node`, the way Homebrew ships every Node command (`typescript`, `eslint`…):

| M13 decision | M14 consequence |
|---|---|
| the extractor is an npm package with `typescript` external, run with `npx codegraph-typescript` (§14.7) | KEPT, and it is the Homebrew form too: `Formula/codegraph-typescript.rb` has `depends_on "node"`, installs the published tarball into `libexec` with `std_npm_args` and links `bin/codegraph-typescript`. A ~12 MB download (bundle + compiler) on top of a `node` Homebrew already shares with everything else, instead of a second 110 MB Node image or 12 MB folded into the app for every user |
| `typescript` stays OUTSIDE the bundle so the compiler finds `lib.*.d.ts` beside itself (§14.1, §14.7) | unchanged — inside `libexec/lib/node_modules/…` the libs ARE beside the compiler; the §14.7 trap (a single file has no "beside itself") never arises because the extractor never becomes a single file. The `<lib>` built-bin test of §14.8 keeps its two runs |
| the extractor never imports `@codegraph/*` (boundary test), and the Node side never learns a language (§13.5) | unchanged, and now also a packaging fact: the SEA (§15.3) carries no extractor at all; the app reaches TypeScript as it reaches Java — a registry entry, a process |
| `snapshots --extractor` runs a `.js` under `node` | in the app the registry entry's `path` is the formula's `bin/codegraph-typescript` shim, `launch: exec`; `node` is Homebrew's, never the SEA's |
| `run(args, io, cwd)` in `main.ts`, `cli.ts` a two-line program | untouched |
| self-hosting (§14.6) | `apps/desktop/src` joins the `--src` roots of the self-hosting run, and the boundary query gains one row: `@tauri-apps/*` is imported under `apps/desktop` alone |

Sizes, so the split is measurable: the app cask downloads the SEA (~110 MB,
of which both frontends are 1.4 MB) plus the shell; `codegraph-typescript`
~12 MB plus Homebrew's `node` once; `codegraph-java` and `codegraph-csharp`
are each their native image per architecture, tens of megabytes a user of
another language never fetches.

### 15.2 The daemon: `codegraph serve --app`

Today `serve` takes models on argv and exits with the window. `--app` is the
long-lived form:

```
codegraph serve --app --data-dir <dir> --extractors <registry.json> [--host 127.0.0.1]
stdout: exactly one line, {"port":N,"token":"…"}, then nothing
exit:   when stdin closes, or on SIGTERM
```

Routes, all under `/<token>/`:

| route | what |
|---|---|
| `GET /` and the static page | the navigator-ui bundle, from SEA assets (the `vizAssetsDir`/`navigatorAssetsDir` lookups of `serve.ts` gain an asset-backed branch; the checkout branch stays for `pnpm` users) |
| `POST /jobs { src, extractor? }` | detect (census) or take the named registry entry, run it under the §13.5 contract into `<data-dir>/models/`, then build `navigator.json` + laid-out `city.json` exactly as `serveCommand` does (`cityBuildOf`, `navigatorOf`); one job at a time, a second `POST` while one runs is `409` |
| `GET /jobs/current` (SSE) | the extractor's stderr progress lines + the build phases, then `done` or `failed` with the extractor's exit code and the last stderr lines |
| `GET /navigator.json`, `GET /city.json` | the current project's artifacts, the routes the page already fetches |
| `GET /recent` | the last projects, `<data-dir>/recent.json`; the page's empty state lists them |

`model.db` and the artifacts live under `--data-dir` (the shell passes the OS
app-data directory, `~/Library/Application Support/codegraph` on macOS), so a
reopened folder skips extraction when the tree is unchanged — the M7 cache
doing its job. The page's empty state (the existing `Loader`) learns the
`--app` form: recents, a progress view fed by the SSE route, and the
instruction "File › Open… (⌘O), or drop a folder on the window" — the shell
owns the dialog. Everything above is tested under Vitest with a fake extractor
(a script that copies a fixture into `--out` and prints two progress lines),
including the capability token (a request outside `/<token>/` is `404`, never
`401` — the route does not exist), the stdin-EOF exit, and the `409`.

### 15.3 One image, one program: the SEA

- **CommonJS, one file.** A SEA's main script is CommonJS; the CLI bundle is
  ESM with a dynamically imported `explain` chunk. A second tsup target —
  `format: cjs`, `splitting: false`, `platform: node`, the workspace packages
  inlined — feeds the SEA; the ESM build stays what `pnpm` users run.
  `node:sqlite` is a built-in and needs nothing. No extractor is in the image
  (§15.1), so there is no dispatch on the invoked name and no compiler to
  inline: the entry is the CLI's, unchanged.
- **Assets.** `sea-config.json` lists the two frontend `dist/` trees and
  `package.json` (for `--version`); `serve.ts`'s `navigatorAssetsDir` /
  `vizAssetsDir` gain an asset-backed branch behind the same resolver
  interface the checkout paths use — `node:sea`'s `isSea()` decides, and the
  tests exercise one seam with two implementations.
- **CI.** A `sea` matrix on the five existing runners (the Java native job's
  shape: no cross-compilation, macOS signs on macOS) builds the image and
  gates it three ways: `codegraph --version` prints the package version,
  `codegraph analyze` on the Java fixture byte-identical to the ESM build's
  output, and `serve --app` answering `/<token>/navigator.json` on the
  fixture under the fake extractor of M14a — the page's assets served from
  the image, not from a checkout.
- **macOS.** `postject` breaks Node's signature: `codesign --remove-signature`
  before injection, an ad-hoc signature after (arm64 refuses to run an
  unsigned Mach-O at all), and the real signature comes with the bundle
  (§15.5).

### 15.4 The shell: `apps/desktop/` (Tauri 2)

- ONE sidecar in `tauri.conf.json` `bundle.externalBin`: the SEA, one file
  per Rust target triple. The release job renames what the `sea` matrix
  produces:

  | RID today | triple |
  |---|---|
  | osx-arm64 | aarch64-apple-darwin |
  | osx-x64 | x86_64-apple-darwin |
  | linux-x64 | x86_64-unknown-linux-gnu |
  | linux-arm64 | aarch64-unknown-linux-gnu |
  | win-x64 | x86_64-pc-windows-msvc |

  Two DMGs, arm64 and Intel, rather than a universal binary: the SEA is per
  triple and a universal `.app` would carry both. No extractor rides in the
  bundle.
- **Extractor discovery.** The shell ships a CATALOGUE, `extractors.json` in
  its resources — one row per extractor codegraph knows: `{ name,
  extensions[], command, install }` (`codegraph-java`, `[".java"]`, `brew
  install defsquare/tap/codegraph-java`; and so on for csharp, typescript,
  elixir…). On launch it looks each `command` up on `PATH` and in the
  Homebrew prefixes (`/opt/homebrew/bin`, `/usr/local/bin`, the Linuxbrew
  prefix), then writes the daemon's registry: found → `{ name, path,
  extensions, launch: "exec" }`; not found → `{ name, extensions, install }`
  with no `path`. A settings entry lets a user point a row at a binary
  anywhere (a checkout's `bin/codegraph-typescript`, a jar with `launch:
  java`). The catalogue is data: a new extractor is one row, no Rust.
- **The daemon's side of that** (a small M14c change to `registry.ts` and
  `jobs.ts`): an entry without `path` is legal, counts in the census, and
  when the only claimants of a tree are such entries `detect` answers
  `not-installed` — `POST /jobs` → `422 { error: "not-installed",
  extractors: [{ name, files, install }] }` — and the page shows the line to
  type with a "Check again" that asks the shell to re-run discovery. A tree
  claimed by one installed and one missing extractor is still `ambiguous`,
  and the missing candidate is offered with its install line rather than
  hidden.
- On launch: discovery, write the registry, spawn `codegraph serve --app
  --data-dir <app data> --extractors <registry>` as a sidecar with stdin held
  open, read the one stdout line, navigate the webview to
  `http://127.0.0.1:<port>/<token>/`. On window close: close stdin, kill the
  child. The Rust crate is that, the discovery, a menu (File › Open…, Open
  Recent) and the drag-and-drop handler, each of which does one `POST /jobs`
  — a few hundred lines with no dependency on the model.
- **The WebGL gate.** WKWebView is not Chrome. Before anything else in M14c,
  `tauri dev` on the fineract city (the NV milestone's 100 MB artifact) at
  user-facing angles, screenshots reviewed, frame time measured; a failure
  here changes the plan (a Chromium-based shell) and is cheaper to learn
  first. WebKitGTK on Linux is known to be fragile with WebGL, one more
  reason Linux is not a gate.

### 15.5 Signing, notarization, the cask and the formulae

- `tauri build` signs and notarizes from the Apple Developer credentials
  in CI (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
  with hardened runtime, and signs the one sidecar with the same identity.
  The entitlements file is the bundle's one file and carries the JIT trio —
  `com.apple.security.cs.allow-jit`,
  `com.apple.security.cs.allow-unsigned-executable-memory`,
  `com.apple.security.cs.disable-library-validation` — because the SEA (V8)
  needs it. If the bundler turns out not to apply the entitlements to the
  sidecar, CI signs it itself with `codesign --options runtime
  --entitlements` before `tauri build` — a step to verify on the first
  notarized build, not to assume.
- Two things to confirm on the first signed build, each a CI assertion
  afterwards: `spctl --assess` accepts the DMG's `.app` on a clean machine,
  and `codegraph --version` runs from `/Applications/Codegraph.app/Contents/
  MacOS/codegraph` under the hardened runtime.
- **The extractor binaries** are formula downloads, not bundle contents.
  Homebrew fetches them with `curl`, which sets no quarantine attribute, so
  Gatekeeper does not assess them; arm64 still refuses an unsigned Mach-O,
  which the .NET publish and GraalVM both satisfy with an ad-hoc signature
  today. The macOS release jobs of `codegraph-java` and `codegraph-csharp`
  nevertheless sign with the Developer ID when the identity is present (the
  .NET single-file host wants the JIT trio too, per Microsoft's notarization
  guidance) — a clean-Mac `brew install` of each is the assertion that
  decides whether notarization of a bare binary is also needed, and the
  answer goes in the profile notes. The osx C# publish must be truly ONE file
  (only the linux-x64 dist exists on the dev machine; .NET refuses to embed
  native libraries in a single file on macOS, and a stray `.dylib` beside the
  host is not something `bin.install` carries).
- `defsquare/homebrew-tap`, `Casks/codegraph.rb`: `arch arm:/intel:`, the
  DMG URL per architecture from the app's GitHub release, `sha256` per
  architecture, `app "Codegraph.app"`, ONE `binary` stanza —
  `Contents/MacOS/codegraph`. `auto_updates false`, a `livecheck` on the
  app's release tags.
- `Formula/codegraph-java.rb`, `Formula/codegraph-csharp.rb`: `on_arm` /
  `on_intel` (and `on_linux`) blocks with the binary's URL and `sha256` from
  THAT extractor's release, `bin.install`, a `test do` that runs
  `--version` and extracts a two-file fixture written by the test itself;
  `livecheck` on that extractor's tags. `Formula/codegraph-typescript.rb`:
  `depends_on "node"`, `url` the npm registry tarball, `system "npm",
  "install", *std_npm_args`, `bin.install_symlink Dir["#{libexec}/bin/*"]` —
  Homebrew's standard Node-package formula, the `<lib>` files beside the
  compiler as §14.7 requires. Every future extractor (`codegraph-elixir`…)
  adds one formula in the same shape, in its own release job.
- **Generated, never edited by hand.** Each release job — the app's, and each
  extractor's — gains a step that rewrites ITS cask or formula with the new
  version and hashes and pushes to the tap with a deploy key. Versions are
  independent: the cask and the formulae bump on their own tags, and
  compatibility is the interchange contract — the daemon validates every
  model it opens exactly as `serve` does, and a `schemaVersion` the app does
  not know is a `failed` job whose message names `brew upgrade codegraph` (or
  the extractor), not a crash.

### 15.6 Milestone split

- **M14a — the daemon** ✅ (2026-09-16). `serve --app [--data-dir DIR]
  [--extractors FILE]` in `packages/cli/src/app/`: `registry.ts` (the
  registry as data, `launch` inferred from the path as `snapshots
  --extractor` does, the extension census, `detect` → one | ambiguous | none,
  the size-and-mtime tree fingerprint over the files the chosen extractor
  would read), `store.ts` (`<data-dir>/models/<name>-<hash>/` with
  `model.jsonl`, the `model.db` `openCache` builds beside it, the two
  artifacts and `project.json`; `recent.json`; the platform default
  data dir), `jobs.ts` (one job at a time; `started`/`phase`/`progress`/
  `done`/`failed` events replayed to a late subscriber; the extractor
  skipped when the fingerprint has not moved, the build skipped when the
  build key has not either — a reopen from the recents took 59 ms) and
  `daemon.ts` (the 32-hex token minted per launch, `/<token>/` routes: the
  page, `app`, `recent`, `navigator.json`, `city.json`, `POST jobs` →
  202/409/422/404, `jobs/current` SSE that says `idle` and stays open; an
  `Origin` that is not the page's own is 403, anything outside the token is
  404; stdin EOF and SIGTERM close the server and kill a running extractor).
  Two things the plan did not name and the daemon does: a `POST jobs` whose
  `src` is a `model.jsonl` builds the page with no extractor, and an empty
  registry is legal (the dev loop from a checkout needs neither a registry
  nor a JDK). navigator-ui: `app-mode.ts` (probe by the `codegraph.app/1`
  kind, typed `submitJob` outcomes, the event reducer) and `AppHome` — the
  recents, "File › Open… (⌘O), or drop a folder on the window", a path field
  as the browser dev loop, the three phases with a window on the extractor's
  stderr, the "which extractor?" question, failures with the exit code and
  the last stderr lines — plus an "Open…" header button and the
  `@tauri-apps/*` boundary test. Tests: 19 registry, 17 daemon over real
  sockets against `test/fake-extractor.mjs` (the §13.5 contract: copies a
  fixture, two stderr lines, `FAKE_EXTRACTOR_FAIL/SLOW_MS/LOG`), 3 process
  tests (one stdout line through a real pipe, exit 0 on stdin EOF, exit 2 on
  a bad registry before binding), 8 serve-command tests, 17 app-mode tests.
  Driven headlessly on the Java fixture (fake extractor) and a mixed tree
  (the real TypeScript extractor after the question), screenshots reviewed.
- **M14b — the SEA** ✅ (2026-09-16). `packages/cli/tsup.config.ts` gains a
  second target: `src/sea-entry.ts` (the same `run`, no top-level await) →
  `dist-sea/codegraph.cjs`, CommonJS, `splitting: false`, `noExternal: [/.*/]`,
  `shims: true`, 2.9 MB with every workspace package and zod inlined and only
  Node's built-ins external. `src/sea.ts` owns the three image facts through
  `process.getBuiltinModule("node:sea")` — a static `import "node:sea"` came
  out of the bundler as `require("sea")`, which the prefix-only builtin does
  not answer — `isSeaImage()`, `seaAsset(key)`, and `nodeCommand()` (`node`
  on PATH inside the image, `process.execPath` in a checkout; used by
  `snapshots --extractor` and the registry's `launch: node`). `src/assets.ts`
  is the one seam: `FrontendAssets { label, read(relative) }` with
  `directoryAssets` (jailed) and `keyedAssets`/`seaFrontendAssets(prefix)`
  (the key space is the jail); `serve.ts`'s `vizAssets()`/`navigatorAssets()`
  return one or the other, `serveStatic` and both servers read through it,
  and `version.ts` reads the `package.json` asset before the file beside
  itself. `scripts/sea-config.mjs` GENERATES `sea-config.json` (every file of
  both `dist/` trees as `viz/…` and `navigator-ui/…`, plus `package.json`;
  `useCodeCache`), `scripts/sea-build.mjs` does the seven steps (blob, copy
  this Node, macOS `codesign --remove-signature`, `postject` with the sentinel
  fuse and the `NODE_SEA` Mach-O segment, ad-hoc sign) into
  `dist-sea/<rid>/codegraph[.exe]`, `scripts/sea-smoke.mjs` is the three-gate
  acceptance (`--version` = the package's, `analyze` deps/cycles/coupling
  byte-identical to the ESM build, `serve --app` under the fake extractor
  serving index.html AND its hashed script from the image, opening
  `fixtures/java/src`, `navigator.json` + laid-out `city.json`, exit 0 on stdin
  EOF). `./build.sh --ts --sea`, `test.sh`'s phase when the image exists, the
  five-runner `sea` CI job (`codegraph-cli-<rid>` artifacts, `codegraph-<rid>`
  on the release). Verified on linux-x64: a 131 MB image, all 13 gate checks
  green, `node:sqlite` and the model.db cache working inside it. Tests: the
  asset seam with two sources through one server (27), the config generator,
  `versionOf`; every existing suite rewired to `FrontendAssets`.
- **M14c — the shell** ◐ (2026-09-16, written on a Linux machine without
  WebKitGTK or a display: everything below the Tauri crate is tested here,
  the crate itself is compiled by CI's `desktop` job, and THE WEBGL GATE HAS
  NOT BEEN RUN — it is the first thing to do on a Mac, per §15.4). The
  daemon's side: `registry.ts` accepts an entry without `path` when it
  carries `install`; the census counts its extensions; `detect` answers
  `not-installed` `{ extractors: [{ name, files, install }] }` when only such
  entries claim a tree (or the chosen one is missing), and an installed +
  missing pair is `ambiguous` with the missing candidate carrying its install
  line; `POST /jobs` → 422 `not-installed`; `/app` lists `installed` and
  `install` per extractor; the registry is a SOURCE (`registrySource`,
  mtime-cached) asked on every request, so the shell's rewrite after a rescan
  is seen without a restart and a rewrite that does not parse keeps the last
  good one. The page: the extractors line marks "not installed", the
  `NotInstalled` panel shows each install line (selectable) with "Check
  again" (a plain retry — no IPC), the "which extractor?" question shows a
  missing candidate's install line instead of a button. `apps/desktop/`: a
  Cargo workspace — `discovery/` (`codegraph-discovery`: the catalogue
  `{name, extensions, command, install}`, `search_dirs` = PATH then
  `$HOMEBREW_PREFIX/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, Linuxbrew;
  `find_command` (executable files only, `.exe` on Windows), `discover` with
  `settings.json` overrides (launch inferred for a jar/script), the registry
  JSON round-tripping the daemon's contract, atomic `write_registry`; 8
  tests) and `src-tauri/` (`daemon.rs`: spawn the sidecar beside the
  executable with stdin held open, read the one line, `POST jobs` / `GET
  recent` over `ureq`, refusals as one sentence with the install line,
  shutdown = close stdin + kill; `lib.rs`: discovery → registry → spawn →
  `navigate` the webview; File › Open Folder… (⌘O, native dialog), Open
  Recent (rebuilt from `recent`), Rescan Extractors; drag-and-drop; rescan +
  menu refresh on every window focus; close → shutdown; a refusal from the
  shell's own open is a native dialog). `tauri.conf.json`: one window, one
  sidecar `binaries/codegraph`, the catalogue as a resource, the JIT-trio
  entitlements; `capabilities/default.json` lists the shell's permissions
  and deliberately no `remote` origin — the page has no Tauri API at all.
  `scripts/sidecar.mjs` copies `dist-sea/<rid>/codegraph` to
  `binaries/codegraph-<triple>`; icons from `tauri icon`; `dist/index.html`
  the one-line starting page; `@codegraph/desktop` in the pnpm workspace with
  no-op `build`/`test` and explicit `tauri:dev`/`tauri:build`. CI `desktop`
  job (ubuntu with the WebKitGTK packages, macos): sidecar from the `sea`
  artifact, `cargo fmt --check`, `cargo test --workspace`. Verified here:
  the new daemon/registry/page tests (824 CLI tests green), 8 discovery
  tests, `cargo fmt`, lint; a headless run of the not-installed path — the
  home says "elixir — not installed", an Elixir tree shows the install line
  with Check again, the registry rewritten (as the shell does on focus) and
  Check again opens it without a restart, screenshots reviewed. NOT
  verified here: the Tauri crate compiling (no WebKitGTK), `tauri dev`, the
  screenshots on the Java fixture and fineract, the WebGL frame time. Two
  rough edges to revisit on a Mac: an ambiguous folder opened from the
  menu/drop is a dialog that sends the user to the page's path field (the
  page cannot be told what the shell posted without IPC), and the
  `codegraph://rescanned` event is emitted but nothing listens.
- **M14d — signed, notarized, in the tap** ◐ (2026-09-16; the pipeline and
  the generators, not yet a release). ci.yml `desktop-bundle` on
  `macos-latest` (osx-arm64) and `macos-15-intel` (osx-x64): the sidecar from
  the `sea` artifact, the Developer ID certificate imported into a throwaway
  keychain, the sidecar signed by CI itself with hardened runtime and the
  JIT-trio entitlements BEFORE `tauri build` (the plan said not to assume
  the bundler does it), `tauri build --bundles app,dmg --target <triple>` (Tauri
  signs the app and notarizes from `APPLE_ID`/`APPLE_PASSWORD`/
  `APPLE_TEAM_ID`), then the §15.5 assertions as CI facts — `codesign
  --verify --deep --strict`, `allow-jit` present on the embedded `codegraph`,
  `spctl --assess` — and the DMG renamed `Codegraph-<version>-<rid>.dmg`.
  Every signing step is conditional on `APPLE_SIGNING_IDENTITY`: without
  the secrets the job bundles ad hoc so a fork or a PR proves the bundling,
  and the signed-only assertions are skipped, never faked. The `release`
  job now needs it and `npm-publish`, attaches the two DMGs, and gains the
  tap step: `scripts/homebrew/render.mjs` renders `Casks/codegraph.rb`
  (arch arm/intel, one DMG URL + sha256 each, `app` + ONE `binary` stanza,
  `auto_updates false`, `livecheck` github_latest, a zap of the app data
  dir), `Formula/codegraph-java.rb` and `codegraph-csharp.rb` (`on_macos`/
  `on_linux` × `on_arm`/`on_intel` with the asset URL and sum from the
  release's SHA256SUMS, `bin.install` renaming the asset, a `test do` that
  extracts a one-file tree) and `Formula/codegraph-typescript.rb` (the npm
  tarball on `depends_on "node"`, `std_npm_args`, rendered only when the
  registry answers for the version), then clones the tap over an SSH deploy
  key and pushes "codegraph <version>" — skipped, not failed, without
  `HOMEBREW_TAP_DEPLOY_KEY`. A missing sum aborts the render before any file
  is written. 7 `node --test` cases pin the templates to the release's asset
  names (a `test.sh` phase). `docs/distribution.md` names every secret, what
  each job puts on the release, and how to render by hand. Departure from
  the text above: all four tap files are rendered from ONE `v*` tag by the
  one release job, not by per-extractor release jobs — the repository has
  one release workflow today; independent extractor cadence means
  per-extractor tags, deferred until an extractor needs a release of its
  own. 2026-09-17: the tap is https://github.com/defsquare/homebrew-tap —
  public, already carrying Defsquare's `datagraph` and `specy` formulae
  under the same "generated, pushed by the tool's own release" rule, and
  needing `brew trust defsquare/tap` once on newer Homebrew; the generator
  renders `codegraph-elixir` too (Apple silicon + Linux x64, the platforms
  `elixir-native` builds) and the release job attaches the Burrito binaries
  as `codegraph-elixir-<rid>`. NOT done, and not doable from here: the tap
  deploy key and the Apple credentials are not in the repository's secrets
  (creating credentials is a maintainer's act — `docs/distribution.md` has
  the three commands), and no tagged release has run — so no notarized DMG
  exists, the tap holds no codegraph file yet, and the clean-Mac install
  checks of the definition of done are outstanding.

Definition of done: a clean Mac with Homebrew and nothing else runs the cask
line, opens the app, is told on a Java folder which line installs
`codegraph-java`, runs it, and then opens a Java, a C# and a TypeScript
folder from the app and sees the city and the navigator; `codegraph analyze`,
`codegraph-java`, `codegraph-csharp` and `codegraph-typescript` work in a
terminal from those installs, each reproducing its fixture snapshot byte for
byte; the SEA job is green on all five runners; `pnpm -r test` green with the
daemon and resolver seams covered; the WebGL screenshots reviewed; the app
download carries no extractor.

---

## 16. Phase 13 — Elixir extractor (the parser as a library, tracers as enrichment) (M15)

Motivation: the fourth real extractor is the first for a **dynamic, macro-first
language on a VM with no class library of types** — the case the trait design
was built for (§2, the Clojure fn-var) and the one no shipped extractor has
exercised. Elixir brings three things the pipeline has not modeled: a
`defmodule` that is at once the compilation unit, the namespace and the type
(a struct, a behaviour, a protocol are all modules); dispatch that is
overwhelmingly dynamic by design (protocols, behaviours called by OTP, message
passing) and must be reported honestly rather than guessed; and code that does
not exist before macro expansion (`use`, `@derive`, a Phoenix router, an Ecto
schema) — the Clojure profile's `generated` provenance, for real. Its legacy is
of the non-compilable kind too: a Phoenix 1.3 app whose `deps/` no longer
resolves and whose `mix compile` fails at the first `use Ecto.Schema`.

**What is the Spoon / Roslyn / tsc of Elixir?** The compiler again — but split
in two, and the split is the design:

| Roslyn / `ts` | Elixir | Role |
|---|---|---|
| `SyntaxTree` | `Code.string_to_quoted/2` → the quoted AST (`{form, meta, args}`), `columns: true`, `token_metadata: true` (`do`/`end`/`closing` positions), `literal_encoder` for literal positions | syntax with positions; the same data structure every macro receives |
| `SemanticModel` / `TypeChecker` | **none before expansion.** Binding happens in `:elixir_expand`, reachable only by compiling, through **compilation tracers** (`Code.put_compiler_option(:tracers, …)`: `remote_function`, `local_function`, `imported_function`, `alias_reference`, `require`, `import`, `struct_expansion`, `on_module`) | exact calls after macro expansion — Spoon-grade, and unreachable without every dependency present |
| the BCL ref pack / `lib.*.d.ts` | the Elixir standard library and Erlang/OTP: a module and export table generated at build time from the building Elixir/OTP (`Application.spec(:elixir, :modules)`, `:code.all_available/0`, `Module.exports/1`) and embedded in the extractor | what `Enum.map/2`, `Kernel.is_nil/1`, `:ets.lookup/2` resolve to on a machine with nothing installed |
| `IErrorTypeSymbol` | a local call that binds to nothing (a macro-injected import the AST cannot see) | binding failure, tolerated, counted, never fatal |

So the baseline is a **lexical resolver over the parser's AST** — the alias /
import / require / use scope stack, nested-`defmodule` auto-aliases,
`__MODULE__`, the embedded OTP table — and it needs nothing but source. It is
"noClasspath" by construction: a file that parses is a file that extracts. The
tracer is the optional enrichment (`--trace`, §16.5), the `--references` slot
of §13 and the `--deps` idea of §14: it needs a project that compiles, and when
it has one it recovers what the baseline honestly could not.

The alternatives, and why they are not the baseline:

| Candidate | What it is | Verdict |
|---|---|---|
| **`mix xref`** | the compiler's own dependency graph (`mix xref graph`, compile/export/runtime edges between modules) | not an extractor — it needs a compiled project, knows modules only (no functions, no anchors, no provenance), and says nothing a tracer does not. It becomes an **oracle** (§16.6): on a corpus that compiles, the baseline's module layer must reproduce it |
| **tree-sitter-elixir driven from TypeScript** | a parser with a CST | rejected — it re-implements the Elixir parser's desugaring (do-blocks, keyword lists, multi-clause heads, sigils, operators as calls) to reach the quoted form the language defines, and can never reach tracers. The compiler's own parser is the reference and is a library call away |
| **ElixirSense / ElixirLS / Expert's Spitfire** | editor-oriented analysis (error-tolerant parsing, completion metadata) | not a baseline — designed for one file with a warm project, not one pass over a corpus; Spitfire's error tolerance is a later enrichment for files the compiler's parser rejects (§16.8) |
| **`Code.compile_file` / `Code.eval_*` on corpus files** | running the corpus | never — evaluating corpus code is the thing the pipeline refuses (§5.2, §13); a `mix.exs` is read as source, not run |

Three principles, locked up front:

1. **The parser without the compiler — the noClasspath of Elixir.** The
   extractor never runs `mix`, never reads `_build`, never loads a corpus
   module. It walks `--src` for `*.ex` and `*.exs` (skipping `_build`, `deps`,
   `.elixir_ls`, `node_modules`), parses each file to its quoted form, and
   resolves names through a lexical scope stack plus the embedded OTP table. A
   module the corpus does not declare is a stub, not a failure; a file the
   parser rejects is skipped and counted, never fatal. Everything visible
   **before** expansion is `declared`; what only expansion produces is
   `generated` when the language itself defines the expansion (`use X` calls
   `X.__using__/1`; `@derive P` defines an impl) and absent otherwise, with the
   absence counted.
2. **No metamodel intelligence, and the extractor is a BEAM program.** It is
   written in Elixir, on the language's own parser, and shipped as an escript
   (the jar: needs Erlang/OTP on the machine, nothing else — an escript embeds
   Elixir) and as a Burrito binary per OS (the GraalVM image: needs nothing).
   It knows the Elixir id scheme, the kind→traits table and how to write bytes;
   trait vocabulary, profile validation and closure live in `core`, and the
   cross-language gate (`packages/core/test/fixtures-elixir.test.ts`) is where
   the two halves meet. `codegraph snapshots --extractor` and the M14 registry
   run it as a process under the §13.5 contract and learn no Elixir.
3. **Byte-identity across OS and across install state.** Two runs over one
   unchanged corpus write the same bytes on Linux, macOS and Windows, from the
   escript and from the binary; and because external modules are keyed by
   **module name** under reserved modules (`<otp>`, `<deps>`, `<unresolved>`,
   §16.3), never by a path under `deps/`, the keys of a model do not depend on
   what is checked out beside it. Edge *counts* do (`--deps` resolves imported
   names through dependency sources, §16.5), and the fixture snapshot is
   produced with no `deps/` at all.

### 16.1 Toolchain and repository layout

```
extractors/elixir/                     Mix project `codegraph_elixir` (escript name `codegraph-elixir`)
  mix.exs                              deps: NONE at runtime (Elixir ≥ 1.18 for the built-in `JSON`); ex_unit + stream_data (property tests) for test
  lib/codegraph_elixir/
    cli.ex                             the extractor contract (schemas/README.md §8) + --deps, --trace
    corpus.ex                          pass 0: walk (ordinal order), parse each file (`Code.string_to_quoted_with_comments/2`), the skipped-file count
    otp.ex                             the embedded OTP table (modules + exports of the building Elixir/OTP), generated by `mix codegraph.otp_table` at build time
    scope.ex                           the lexical resolver: alias / import / require / use stack, nested defmodule, __MODULE__, Kernel except:
    whitelist.ex                       pass 1: every defmodule under the roots — membership, never a name prefix
    ids.ex                             THE Elixir id scheme (§16.3): keys, escaping, arity
    entities.ex                        pass 2
    edges.ex                           pass 3
    stubs.ex                           pass 4: <otp> / <deps> / <unresolved> stubs
    measures.ex                        sloc (`:elixir_tokenizer`, the compiler's own lexer) + cyclomatic
    literals.ex                        module-attribute constants, struct-field defaults, parameter defaults (`\\`)
    model/                             NaturalKey, Entity, Edge, canonical order (UTF-16 code units), JsonlWriter (`JSON.encode_to_iodata!`)
  test/                                ExUnit; the C# suite's names where the property is the same (snapshot, determinism, stub-discipline,
                                       ids, schema-per-line, cli) + scope, arity, clauses, defimpl, dynamic-candidate
  priv/otp/<elixir>-<otp>.etf          the generated OTP table (Erlang term format), one per building toolchain; the fixture pins one
  dist/<rid>/codegraph-elixir          Burrito output, one per OS/arch (build.sh --elixir --native)
bin/codegraph-elixir                   the escript (build.sh --elixir)
fixtures/elixir/src/                   the reference corpus (§16.6): `acme_order`, the Java, C# and TypeScript corpora's twin, Mix-shaped
fixtures/elixir/expected/model.jsonl
```

- `scripts/lib.sh` gains `have_elixir_extractor`, `ensure_erlang` (Erlang/OTP
  ≥ 27 and Elixir ≥ 1.18 on PATH, or the instructions to install them with
  `mise`/`asdf`); `build.sh --elixir` runs `mix escript.build`, `--native` adds
  Burrito; `test.sh --elixir` runs `mix test` and then the built escript AND
  the binary (when present) on `fixtures/elixir/src` with `cmp` against the
  snapshot — the Java/C# shape. CI adds `elixir-test` (`erlef/setup-beam`) and
  `elixir-smoke` on the three OS runners.
- **Nothing installed on the machine that runs the binary.** An escript needs
  `escript` (Erlang) on PATH — the jar's JDK. Burrito wraps a Mix release with
  its ERTS into one executable per target (Linux x64/arm64, macOS x64/arm64,
  Windows x64), cross-built from one host through Zig — the `dotnet publish`
  matrix of §13.7. The `--version` output names the Elixir and OTP versions the
  OTP table was generated from, and the header carries them as extra keys
  under `extractor` (the header schema allows it), so a model says which
  standard library it resolved against.
- `codegraph snapshots --extractor` learns nothing new: an escript is a file
  with `#!/usr/bin/env escript` and runs directly on Linux/macOS; on Windows
  the registry entry (§15) names `escript.exe <path>` or the Burrito binary.
  The M14 cask gains a fifth `binary` stanza and the registry a fourth entry
  (`extensions: [".ex", ".exs"]`).
- The extractor's own `mix.exs` has no runtime dependency: `JSON` (Elixir
  1.18), `Code`, `Macro` and `:elixir_tokenizer` are the whole front end.
  `stream_data` is a test dependency, the fast-check of this side.

### 16.2 Mapping table (Elixir profile — new, `ex`)

There is no Elixir profile yet; the first M15 commit is `feat(core): elixir
profile` — the tenth, data before implementation (invariant 8; the profile
registry's "nine profiles" test becomes ten). Its shape follows two prior
decisions rather than inventing a third:

| Decision | Why |
|---|---|
| **the module (`TModule`) is the file**, the TypeScript rule verbatim | Elixir has no namespace: `MyApp.Accounts.User` is one atom, and nothing contains it but the file it is written in (invariant 5). The import layer stays file-level and comparable with TypeScript's (invariant 9); umbrella apps (`apps/<name>/lib/…`) fall out as directory districts with no extra concept |
| **a `defmodule` is a `module` kind carrying `TType`** — one building per defmodule | the module IS the type: a struct is `%Mod{}`, a behaviour is a module, a protocol is a module, `@spec f :: Mod.t()`. Making only `defstruct` modules types would leave most of a Phoenix app's city empty; a separate `struct` entity would draw two buildings for one thing |
| no `inheritance`, no `embedding` | Elixir has neither; the absence is profile information, as in Go and Clojure |
| `TWithLocalVariables` deferred (optional on the profile, unemitted in M15) | every match binds; emitting each `=` as a local multiplies entities by ten for no edge the analyzer reads today. The trait stays licensed so M15c can add it without a profile change |

Kinds, with the traits that identify them (`TSourceAnchor`, `TComment`,
`TMetrics` optional wherever it makes sense):

| kind | required traits | Elixir construct |
|---|---|---|
| `file` | `TNamed, TModule, TWithChildren` | a source file; optional `TWithInvocations`, `TWithAccesses` — `config/*.exs` and `mix.exs` call at top level (the TypeScript module rule) |
| `module` | `TNamed, TType, TWithChildren, TChildOf, TSourceAnchor` | `defmodule`; optional `TWithImplements` (`@behaviour`, `defimpl`, `@derive`), `TAttachedTo` (a `defimpl` block, attached to the type it implements for), `TComment` (`@moduledoc`) |
| `protocol` | as `module` | `defprotocol`; its `def`s are `callback` children |
| `function` | `TNamed, TInvocable, TWithParameters, TWithInvocations, TWithAccesses, TChildOf, TSourceAnchor` | `def` / `defp`, every clause folded into ONE entity (§16.3); `defdelegate` is a `function` whose body is one invocation; `private: true` rides as a pass-through key (the metamodel has no visibility, the contract tolerates the key) |
| `macro` | as `function` | `defmacro` / `defmacrop`; the guard `@doc` reads; a call to it is an `invocation` whose expansion is invisible |
| `callback` | `TNamed, TInvocable, TWithParameters, TChildOf, TSourceAnchor` | `@callback`, `@macrocallback`, a protocol's `def` — the interface-method analog, no body |
| `field` | `TNamed, TStructural, TChildOf, TSourceAnchor` | a `defstruct` / `defexception` key; optional `TWithValue` (the default) |
| `attribute` | `TNamed, TStructural, TChildOf, TSourceAnchor` | `@name value` for a non-reserved attribute — the module constant; optional `TWithValue`, `TWithAccesses` (its value may reference modules) |
| `parameter` | `TStructural, TChildOf` | one per position of the folded function; optional `TNamed` (from the first clause that names the position, `_`-prefixed and bare `_` excluded), `TWithValue` (a `\\` default) |

Construct → what the model says, on top of that table:

| Elixir construct | model |
|---|---|
| `defmodule A.B do … end`, nested `defmodule C` inside it | two `module` entities, `A.B` and `A.B.C`, both children of the file (nesting is an alias, not containment); `C` is aliased inside `A.B` (the auto-alias rule) |
| `defimpl P, for: T` (and `for: [T1, T2]`) | a `module` named as the compiler names it (`P.T`), child of the file, `attachedTo` → T; an `interfaceImplementation` edge T → P, `declared`, anchored at the block — the Clojure `implBlock` shape (METAMODEL.md §7) with the name Elixir gives it. `for: Any` → the stub type `<otp>/Any` |
| `@behaviour B` | `interfaceImplementation` module → B, `declared` |
| `use X` / `use X, opts` | an `import` edge file → X's file (declared, form `use`) AND an `invocation` of `X.__using__#1` (declared: `use` is defined as `require X` + `X.__using__(opts)`). What `__using__` injects — `@behaviour`, imports, `def`s — is NOT modeled in the baseline and every local it would have bound is counted (§16.4); `--trace` recovers it as `generated` |
| `@derive P` / `@derive {P, opts}` | `interfaceImplementation` module → P, provenance **`generated`**, anchored at the attribute — the language defines the expansion (`Protocol.derive/3`), so the fact is safe to state and honest to mark |
| `alias A.B`, `alias A.{B, C}`, `alias A, as: X`, `import M` (`only:`/`except:`), `require M` | one `import` edge kind, file → M's file (or the stub module), with the written form as a pass-through key (`alias`/`import`/`require`/`use`) — the TypeScript "three ways to import, one edge kind" rule. Scoped forms inside a function apply to that function's body only |
| `M.f(a, b)`, `M.f a, b`, `x \|> M.f(b)` (arity + 1), `:erl_mod.f(x)`, `__MODULE__.f(x)`, `alias`-resolved `F.f(x)` | `invocation` → `M.f#arity`; M resolved through the scope stack; a corpus M → the declared function (defaults fold, §16.3); M in the OTP table → its stub; else a stub under `<deps>` |
| `f(a, b)` (a local call) | resolved in this order: a `def`/`defp`/`defmacro` of the enclosing module with that name and arity (defaults folded) → an explicit `import M` that exports it (a corpus M, or the OTP table) → Kernel / Kernel.SpecialForms (unless `import Kernel, except:` removed it) → the **sole** non-corpus `import M` that could provide it (attributed to `<deps>/M.f#arity`, counted as `import-attributed`) → two or more candidates: dropped and counted → nothing: dropped and counted as `local-unbound` — the macro-injected import, the baseline's stated ceiling |
| `&M.f/2`, `&f/2`, `&M.f(&1, x)` | `reference` → the function; the call happens elsewhere (the Clojure higher-order rule) |
| `%M{…}`, `%M{s \| …}`, `%__MODULE__{}` in expressions and patterns | `reference` → M (struct expansion); each named key → `access` to `M.<key>` (`isRead` in a pattern, `isWrite` in an update or construction) — the ONLY static field access Elixir has; `s.name` is a runtime map access, dropped and counted |
| `@attr` read inside a body | `access` → the module's `attribute`, `isRead` |
| `children = [MyWorker, {Registry, keys: :unique}]`, `Supervisor.start_link(children, …)`, any module atom in argument position | `reference` → the module — how the supervision tree surfaces; a module in argument position is a value, not a call |
| `GenServer.call(__MODULE__, msg)`, `.cast`, `Agent.get(__MODULE__, …)`, `send(self(), …)` | `invocation` → the target module's `handle_call#3` / `handle_cast#2` / `handle_info#2`, provenance **`dynamic-candidate`** with every clause-folded handler as the candidate set and `to` the first — the one message-passing form that is statically honest, because `__MODULE__` names the module. Any other first argument (a pid, a name, a variable): dropped and counted as `dynamic-dispatch` |
| `P.f(x)` where P is a corpus `defprotocol` | `invocation` → `P.f#arity` (the `callback`), provenance `dynamic-candidate`, candidates = every corpus `defimpl` of P's `f#arity` — the Go interface-call and Clojure multimethod rule; a protocol from `<otp>` (`Enumerable`, `String.Chars`) → an ordinary stub invocation, its impls unknown |
| `raise M`, `raise M, msg`, `reraise M, …` | `throws` → M (`<otp>/RuntimeError` for `raise "text"`, `<otp>/ArgumentError` for `raise ArgumentError`); `throw`/`exit` are not exceptions and yield nothing |
| `@spec f(A.t()) :: B.t()`, `@type t :: %__MODULE__{…}`, `@typep`, `@opaque` | `reference` edges from the function (or module) to every named remote type's module; `@type` is not an entity in M15 (noted) |
| `@moduledoc "…"`, `@doc "…"`, the `#` comment block directly above a definition | `comments` (`TComment`) — the docs are the semantic comment, the `#` block is what the TypeScript rule takes |
| `defexception [:message, :code]` | a `module` with `field` children, `TWithImplements` (the `Exception` behaviour it declares) |
| `defdelegate f(a), to: M, as: :g` | a `function` `f#1` with one `invocation` → `M.g#1`, `declared` — the delegation is written |
| `apply(M, :f, args)`, `mod.f(x)` with `mod` a variable, `Module.concat(…)`, `Code.eval_*`, `:erlang.apply` | dropped and counted as `dynamic-dispatch` — the profile's blind spot, stated |
| a file `Code.string_to_quoted` rejects | skipped, counted as `unparsed`, the path on stderr; the model carries the file record without entities |

Explicitly NOT extracted in M15, stated in the profile `notes`: definitions a
`use`d macro injects (a Phoenix router's routes, an Ecto schema's fields, a
`plug` pipeline) and the locals that call them; callback implementations as
edges (`handle_call/3` under `@behaviour GenServer` — the analyzer recovers
"implements callback" from `interfaceImplementation` + name/arity, as it does
for Java overrides); message passing beyond the `__MODULE__` form; process
topology at runtime (`Registry`, `:via` tuples, dynamic supervisors); `.erl`
files in a mixed corpus (an Erlang profile is its own phase); `@type` entities.

### 16.3 The Elixir id scheme (`ids.ex`)

```
module (file)      ex:lib%2Facme_order%2Forder.ex                       path relative to root, escaped
external (OTP)     ex:<otp>/Enum     ex:<otp>/ets     ex:<otp>/Any        the embedded table: Elixir + Erlang/OTP, by module name
external (deps)    ex:<deps>/Ecto%2EChangeset                           a module nothing under the roots declares
                   (a stub has no members: `Enum.map/2` is an invocation of `<otp>/Enum` — the C# fold)
module (defmodule) ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder     the atom as written, its dots escaped
function / macro   …/AcmeOrder%2EOrder.total#1     …/AcmeOrder%2EOrder.create#2   name, then ARITY as the disambiguator — always present
defimpl module     ex:lib%2Facme_order%2Fmoney.ex/String%2EChars%2EMoney   the compiler's name for it
callback           …/AcmeOrder%2EPricing.price#2                          the same shape as a function
field / attribute  …/AcmeOrder%2EOrder.lines      …/AcmeOrder%2EOrder.@max_lines   no arity: a 0-arity `lines#0` cannot collide
parameter          …/AcmeOrder%2EOrder.create#2#param:attrs     …#2#param:2 (an unnamed position, by ordinal)
```

- **Escaping, the TypeScript rule with one more input.** `/`, `#` and `%`
  are percent-encoded in every path segment and name; `.` is the nesting
  separator inside a symbol, so a **module atom's own dots** are encoded
  (`AcmeOrder%2EOrder`) exactly as a TypeScript name containing `.` is. The
  rejected shortcut — leaving the dots and relying on the rule that alias
  segments start uppercase while function names do not — holds for
  `defmodule A.B` and fails for `defmodule :"a.b"`, which is legal; the
  encoding is injective by construction, pinned by a `stream_data` round-trip
  property, and the module's `name` is the atom as written, which is what the
  city and navigator display.
- **Arity is identity, always.** `f/1` and `f/2` are unrelated functions in
  Elixir, so the disambiguator is never absent on a `function`, `macro` or
  `callback`. `def f(a, b \\ 1)` declares `f/1` and `f/2`: ONE entity, `f#2`,
  and a call `f(x)` resolves to it (the profile note states the fold; a
  `defaults: 1` pass-through key says how many arities it covers). Multiple
  clauses of one `f/2` are ONE entity anchored from the first clause's line
  to the last clause's `end` — the TypeScript overload fold, with the
  `parameter` set taken per position across clauses (§16.2).
- **`defimpl` is a named module.** `defimpl String.Chars, for: Money`
  defines `String.Chars.Money` on the BEAM; the key uses that name in the
  file where the block is written, and `attachedTo` carries the relation the
  name only implies.
- **Stub keys have the same shape as declared keys** — membership is the
  whitelist, never the key or the name. Two reserved modules, each a fact
  about where the name was NOT found: `<otp>` (in the embedded table — the
  BEAM ships it), `<deps>` (a module the roots do not declare and the table
  does not know — a dependency, whichever one). `:ets` and `Enum` sit side
  by side in `<otp>`: the Erlang/Elixir split is a naming convention on one
  VM, not a boundary the model should invent. A stub has no members (M15b
  finding: `isStub` is a key of TType and TModule only, so a stub
  *function* is not representable — the C# fold applies, and a call into an
  external module lands on its stub module). A local that binds nowhere is
  dropped and counted, never stubbed.

### 16.4 Stub discipline, parser edition

Pass 1 builds the whitelist: every `defmodule` (and `defprotocol`, `defimpl`)
under the roots, by atom. Then:

| The resolver says | The model says |
|---|---|
| a module under the roots | a declared entity |
| a module in the OTP table | a stub `module` in `<otp>`; a function of it, when the table exports that name/arity, a stub `function` below it; a name the table does not export (a typo, a newer Elixir than the table's) → the stub module, counted |
| a module neither declared nor in the table | a stub `module` in `<deps>`; every function called on it a stub `function` below it, named as written — there is nothing to check it against |
| a local that resolves through the sole non-corpus import | a stub function under that import's `<deps>` module, counted as `import-attributed` — what the compiler itself would conclude |
| a local that resolves to nothing | dropped and counted as `local-unbound` — never a `<unresolved>` entity for a *call*; `<unresolved>` receives only what an edge must target and cannot (an `@behaviour`/`raise` naming a module that is neither declared nor known, keyed as written) |
| a variable in module position (`mod.f()`), `apply/3`, a computed module | dropped and counted as `dynamic-dispatch` |
| a file that does not parse | a file record, no entities, counted as `unparsed` |

Resolvability is not membership — the C# rule, verbatim: `Enum` resolves and
is external; `AcmeOrder.Repo` is declared even when `use Ecto.Repo` bound
nothing.

**`--deps <dir>`** (§16.5) is the one bounded place the baseline adds
resolution it otherwise lacks: the dependency sources under `deps/*/lib` are
parsed for their **exports only** (names and arities of `def`/`defmacro` per
module) so that `import Ecto.Query` followed by `from(u in User)` binds to
`<deps>/Ecto.Query.from#2` as a fact rather than an attribution, and so that
a `__using__` whose body is nothing but `import`/`alias` lines can be read
for those lines. Keys do not change — `<deps>` stays `<deps>` — only counts do,
every such resolution under its own counter; and a `deps/` tree is never
corpus: no entity is emitted from it. The fixture runs without it.

### 16.5 The extractor command-line contract, plus two flags

Same flag shape and exit codes as the jar, the C# binary and the TypeScript
bin (`schemas/README.md §8`). Two additions, both optional:

| Flag | Meaning |
|---|---|
| `--deps <dir>` | parse dependency sources for their exports only (§16.4); default: none, even when `deps/` exists beside the roots — the model of a corpus must not change with what is checked out next to it |
| `--trace <file>` | merge a compiler trace produced INSIDE the project by `mix codegraph.trace --out <file>` (a Mix task shipped with the extractor, run by the user where `mix compile` works): every `remote_function`/`local_function`/`imported_function`/`struct_expansion` event after macro expansion, keyed by file and position. Edges the baseline already has are unchanged; edges only the trace knows are added with provenance `generated`; a baseline `local-unbound` that the trace binds is resolved and the counter says so. Keys never come from the trace — the AST assigns them, the trace only closes edges between them. Shape fixed in M15c after the audit says how much it recovers |

`stdout` carries nothing but `--help`/`--version`; progress and the resolution
summary go to `stderr`:

```
✓ walk        412 files (.ex 388, .exs 24)  0.1s
✓ parse       411 parsed, 1 unparsed  1.9s
✓ whitelist   603 modules  0.1s
✓ entities    7 912 entities  0.8s
✓ edges       19 340 edges  1.4s
✓ stubs       541 stubs (<otp> 212, <deps> 318, <unresolved> 11)  0.1s
✓ write       27 806 records  0.3s
RESOLUTION SUMMARY
  references      : 19 340
  resolved        : 17 863
  unresolved      : 1 477
  resolution rate : 92.4%
  local-unbound (dropped)   : 1 102   ← macro-injected imports: the honest ceiling without --trace (profile note)
  dynamic-dispatch (dropped): 375
  import-attributed         : 84
  imports         : 2 410 (alias 1 630, import 402, require 118, use 260; unresolved: 318)
  dynamic-candidate         : 96 (protocol 61, GenServer self-calls 35)
  entities        : 8 453 (stubs: 541)
  edges           : 19 340 (self-edges dropped: 6)
wrote model.jsonl
```

### 16.6 Validation (the M2 gate, replayed a fourth time)

- **Walking skeleton first**: files, `defmodule`s, `def`/`defp` with arity,
  the four import forms, `@behaviour`, stubs — one file in, `codegraph
  validate` green, snapshot committed, the core gate
  `packages/core/test/fixtures-elixir.test.ts` (parses as a `Model`;
  byte-identical to core's encoder; ZERO profile issues; closed; no
  self-edges; the stub-discipline evidence by id).
- **The fixture corpus** `fixtures/elixir/src` — `acme_order` as a Mix
  project (`mix.exs`, `lib/`, `test/`, `config/`) of around 20 files and 400
  lines, each pinning one hazard (its README lists them, the TypeScript
  README's form):
  - `application.ex`: `use Application`, a `children` list → `reference`
    edges to every child module — the supervision tree;
  - `order.ex`: `defstruct` with defaults and `@enforce_keys`, a multi-clause
    `total/1`, `def create(attrs, opts \\ [])` — the defaults fold — a pipe
    (`|> Money.add(x)` → `add#2`), a capture, `defdelegate`, `@max_lines`
    read in a body, `%__MODULE__{}` in a pattern and an update;
  - `money.ex`: `defimpl String.Chars, for: Money` → the named impl module
    attached to `Money`; `@derive Jason.Encoder` → `generated`; `raise
    ArgumentError` → `throws` to `<otp>`;
  - `pricing.ex`: a behaviour with two `@callback`s and two implementations
    (`@behaviour`, `@impl true`) — `interfaceImplementation` declared;
  - `priceable.ex`: `defprotocol` with two `defimpl`s and `for: Any` → the
    `dynamic-candidate` protocol call with two candidates;
  - `stock.ex`: `use GenServer`, `GenServer.call(__MODULE__, {:reserve, id})`
    → candidates = the three `handle_call/3` clauses folded to one, an
    `:ets.lookup/2` call → `<otp>/ets`, a `GenServer.call(pid, …)` dropped;
  - `repo.ex` and `schema/line.ex`: `use Ecto.Repo`, `use Ecto.Schema`,
    `import Ecto.Changeset`, `field :qty, :integer` (local-unbound, counted),
    `cast(line, attrs, [:qty])` (import-attributed to `<deps>/Ecto.Changeset`),
    `from(l in Line)` under `import Ecto.Query` — the `--deps` case in a test,
    not in the snapshot;
  - `macros.ex`: a corpus `defmacro __using__` `use`d by another module — the
    `__using__#1` invocation resolves to a declared macro;
  - `notifier.ex`: nested `defmodule` auto-alias, `alias AcmeOrder.{Order,
    Money}`, `alias Money, as: M`, `import Kernel, except: [length: 1]` plus a
    local `length/1` of its own, a function-scoped `alias`;
  - `errors.ex`: `defexception`, `raise "text"` → `<otp>/RuntimeError`,
    `reraise`;
  - `dynamic.ex`: `apply/3`, `mod.f()`, `Module.concat` — dropped and counted;
  - `spec.ex`: `@spec`/`@type` naming remote types → `reference`;
  - `legacy/broken.ex`: a file with a syntax error — skipped and counted;
  - `two_modules.ex`: two `defmodule`s in one file; `promo#2024.ex`: a `#` in
    a file name; `defmodule :"legacy.mod"`: an atom-named module with a dot;
  - `test/acme_order/order_test.exs`: `use ExUnit.Case`, `.exs` walked like
    `.ex`; `config/config.exs`: `import Config` and top-level `config/3` calls
    FROM the file.
- **Extractor-side tests** (ExUnit): every line against the per-record schema
  for its `t` (a JSON Schema validator in test only, never at runtime), the
  sequence rules, dense surrogates, canonical order; `DeterminismTest`
  shuffles the walk order and flips line endings; `StubDisciplineTest` asserts
  membership by whitelist on a corpus whose module names mimic OTP's
  (`defmodule Enum.Extra` is corpus; `Enum` is not); `ScopeTest` and
  `ArityTest` as tables; `stream_data` properties for the key round trip and
  for the clause fold (n clauses → one entity spanning all).
- **Two oracles Elixir alone offers.** On a corpus that compiles (the
  standard library's `lib/elixir`, Phoenix), `mix xref graph --format dot`
  is the compiler's module graph: the baseline's file-level `import` layer,
  folded to modules, must reproduce its compile-time edges (`alias`,
  `require`, `use`, `import`) exactly, and its runtime edges up to the
  documented blind spots. And on the same corpus the trace (`--trace`) is
  the richer extractor of the cross-validation rule: the baseline's edge set
  must be a **subset** of the traced one, every gap a named resolution miss
  in the audit table, never noise.
- **Every per-fixture suite** (analyzer, city, navigator, CLI `validate`,
  core `fixtures-*`) gains the Elixir fixture; every CLI command is run on
  it; the city and navigator are reviewed as screenshots — one building per
  `defmodule`, districts by directory (`lib/acme_order/schema/`), the
  `dynamic-candidate` arcs visibly distinct.

### 16.7 Distribution

- **The escript** (`bin/codegraph-elixir`, built by `mix escript.build`):
  runs anywhere Erlang/OTP ≥ 27 is installed; Elixir itself is embedded in
  the archive. This is the jar: the development and CI form.
- **The Burrito binary** (`extractors/elixir/dist/<rid>/codegraph-elixir`):
  a Mix release plus ERTS in one executable per target, cross-built from one
  host; needs nothing on the machine. The published artifact — and the M14
  sidecar. Both forms must `cmp` the fixture snapshot (the §13.7 gate,
  twice), and the `elixir-smoke` job runs the binary on the three OS runners.
- **A Hex package** (`codegraph_elixir`) for the `mix codegraph.trace` task,
  so a project can produce the trace with one dependency; published on a
  `v*` tag when `HEX_API_KEY` is present (skipped, not failed, otherwise) —
  the `npm-publish` shape.

### 16.8 OS- and toolchain-specific hazards, each with the test that pins it

| Hazard | Where it shows | Guard |
|---|---|---|
| canonical order compares UTF-16 code units; Elixir strings are UTF-8 binaries | any name with a character above U+FFFF or in the surrogate-adjacent range sorts differently under byte order | comparison key = `:unicode.characters_to_binary(s, :utf8, {:utf16, :big})`, compared as bytes; the `fixtures/unicode` corpus (the Java/C# guard) reproduced byte for byte |
| JSON bytes must match core's `JSON.stringify` | escaping (` `, control characters, `/` unescaped), key order, integers vs floats in `metrics` | the two-encoder gate in core; a `JsonWriterTest` with the characters JS and Elixir disagree on by default; `JSON.encode_to_iodata!` with an explicit string encoder where the defaults differ |
| a source file that is not valid UTF-8 (Latin-1 legacy) | `Code.string_to_quoted` rejects it; a lone surrogate cannot exist in a binary | counted as `unparsed`, path on stderr; `--encoding latin1` is a later flag, not a default that guesses |
| `\r\n` sources | Windows checkouts | the tokenizer is EOL-agnostic; the CRLF determinism case; `sloc` counted from tokens, not from line splits |
| `\` path separators and drive letters | Windows anchors and module keys | `Path.relative_to/2` + a forced `/` join before a path enters a key; the Windows smoke job |
| case-insensitive file systems | enumeration order differs, `Foo.ex`/`foo.ex` cannot coexist | ordinal sort of walked paths by UTF-16 units; the walk never trusts `File.ls` order |
| the OTP table drifts with the building toolchain | a module built with Elixir 1.19 resolves `Enum.new_fn/1`, one built with 1.18 counts it | the table is a build artifact named by version and pinned in the header's `extractor` keys; the fixture snapshot names the version it was made with and CI builds with exactly it (`erlef/setup-beam` versions in `.tool-versions`) |
| `escript` on Windows | no shebang; `escript.exe` must be on PATH | the registry entry names the launcher; the Burrito binary is the Windows deliverable |
| Burrito's cross-build | needs Zig and downloads ERTS per target at build time | `build.sh --elixir --native` checks for Zig and names the ERTS cache; CI caches it; the escript is the fallback every job has |
| an `.exs` that is a script, not a module | `mix.exs`, `config/*.exs`, `seeds.exs` call at top level | the `file` kind licenses `TWithInvocations`/`TWithAccesses` (§16.2); a top-level `defmodule` in an `.exs` is a module like any other |
| memory on very large corpora | the whole quoted AST of a file is held during its pass; nothing is held across files but the whitelist and the tables | per-file passes, streaming write; the standard library's `lib/elixir` (≈ 900 files) is the size gate |

### 16.9 Milestone split

- **M15a — profile + skeleton + contract.** `feat(core): elixir profile`
  (§16.2, the tenth) and the registry test; `extractors/elixir/` as a Mix
  project with the embedded OTP table; the walking skeleton (§16.6 first
  bullet) → `fixtures/elixir/expected/model.jsonl` byte-identical to core's
  encoder and profile-valid with zero issues; the core gate; the escript on
  `bin/codegraph-elixir`; `build.sh --elixir` / `test.sh --elixir` with the
  escript `cmp`; `elixir-test` in CI.
- **M15b — the model.** Every kind and edge of §16.2 (clause and default
  folds, the four import forms, `defimpl` as an attached named module,
  `@derive` as `generated`, `use` as import + `__using__` invocation, struct
  expansion accesses, protocol and `GenServer` self-call
  `dynamic-candidate`s, `throws`, `@spec` references, docs as comments),
  `sloc` + `cyclomatic`, literals; the full fixture with its README; the
  determinism, stub-discipline, scope and arity suites; `--deps`; the fixture
  in every per-fixture suite; every CLI command verified on it; city and
  navigator screenshots reviewed.
- **M15c — audit + oracles + distribution.** Three corpora, every model
  `validate`-clean: `elixir-lang/elixir` `lib/elixir` (the standard library —
  the size gate and the `mix xref` oracle), `phoenixframework/phoenix`
  (macros everywhere: the ceiling measured), an Ecto-heavy application
  (`plausible/analytics`: schemas, changesets, queries — the `--deps` and
  `--trace` value measured); the `mix xref` subset check and the trace
  superset check as tests with an opt-in real-corpus run
  (`CODEGRAPH_CORPUS_ELIXIR`, the M11 pattern); `mix codegraph.trace` and
  `--trace` shaped by what the audit shows; the defects found named in the
  profile notes with their counts; Burrito binaries, `elixir-smoke` on three
  OS runners, the M14 registry entry and cask stanza, the Hex package on a
  tag; `docs/elixir-extractor.md`; README and CLAUDE.md name the extractor.

Definition of done: `fixtures/elixir/expected/model.jsonl` byte-identical to
core's encoder and profile-valid with zero issues; the same bytes from the
escript and from the Burrito binary on Ubuntu, macOS and Windows runners; the
baseline's module layer equal to `mix xref`'s compile-time graph on the
standard library and its edge set a subset of the traced one, with every gap
named; the audit numbers in the profile notes; `./test.sh` and CI green with
the Elixir fixture in every per-fixture suite.

---

## 17. Phase 14 — The insights store: `<model>.insights.db` (M16)

Motivation: the insights are the only artefact in the pipeline that is **not a
pure function of the model** — they are bought, call by call, from a provider
(`docs/insights.md`). M11 keeps them in one sorted JSONL side-car, which is the
right shape for what it was built for (a diffable file a Specy skill reads
whole) and the wrong one for everything that came after: a run that fails
halfway, a retry, a consumer that wants ONE explanation.

Measured on BroadleafCommerce (`deepseek-v4.1-flash`, 2026-09-18), which is
why — and which is also why parsing is NOT the argument:

| fact | value | |
|---|---|---|
| side-car | 47.5 MB, 28 206 records (24 392 operations / 3 312 types / 502 modules) | 55 % of the bytes are `block` |
| read + strict decode (Zod per line) | 0.19 s + 0.47 s, **528 MB RSS** | cheap for `explain`, prohibitive for a page that wants one description |
| encode | 0.36 s, byte-identical to the file read | the round trip M16 must keep |
| whole-file rewrites per full run | one per Kahn layer: **35 × 47 MB** | `onLayer` → `writeFileAtomic` (explain.ts) |
| what a crash mid-layer keeps | the records (`.journal`) — **not the failures**: the journal carries `t:"i"` lines only | a killed run forgets what it paid for and lost |
| what the file remembers of past runs | the LAST run's trailer (`llm 1 043`, $4.70); the 17 271 reused records' runs are gone | total spend is unrecoverable |

The JSONL decode is under a second: M7's argument ("cache the parse") does not
transfer, and this phase does not claim it. What transfers is the other half
of M7 — a store is **random access, transactions and queries** — applied to
the one artefact where losing a write costs money.

**Why not a table in `model.db`?** Because `model.db` is disposable by
construction (§9.3: *migration is regeneration*; a `DB_VERSION` bump or a
changed size/mtime deletes the file) and that rule is what keeps the cache
honest. Insights cannot be regenerated for free. Two lifecycles cannot share a
file without one of them lying, so they do not share one:

| | `model.db` (M7) | `<model>.insights.db` (M16) |
|---|---|---|
| role | derived cache of `model.jsonl` | the working store of what was bought |
| version mismatch | delete, rebuild | **migrate** (a ladder on `PRAGMA user_version`); a newer file is refused, never touched |
| staleness | per file: size + mtime | per record: the Merkle fingerprint (unchanged from M11) |
| will not open | degrade to the `.jsonl`, silently | a usage error naming the file; never overwritten |
| committed / shared | never | never — the JSONL export is what is committed, diffed and handed to Specy |

Locked decisions, each with its reason (the delta table in §19 repeats them):

- **The db is the working copy; the JSONL becomes its deterministic export.**
  `<model>.insights.jsonl` keeps its format, its byte-determinism and its
  place beside the model — written ONCE at the end of a run instead of once
  per layer. The Specy skill, the fixtures and `git diff` see no change.
- **The round trip is lossless and is a tested property.** `decode(jsonl) →
  store → export()` reproduces the input bytes, for header, records and
  failures. The only db-only state is the `run` history, declared losable:
  deleting the `.db` and re-importing the JSONL loses the ledger and nothing
  that was paid for.
- **`block` stays one JSON text column**, stored as `encodeRecord` normalized
  it (Zod key order), so the export is a concatenation and not a
  re-serialization. Its shape moves with `PROMPT_VERSION`; tables per block
  field would turn every prompt change into a migration. What is queried
  (`concept`, `confidence`) is a generated column over the JSON — the opposite
  call from M10b's `entity_metric` rows, for the opposite reason: measures are
  aggregated, blocks are fetched.
- **The envelope is columns.** `id`, `level`, `fingerprint`, `origin`,
  `model`, usage and the natural key `(lang, module, symbol, disambiguator)`
  carried structurally (invariant 7) — the planner needs `id → fingerprint`
  for 28 k units and must not pay for 26 MB of blocks to get it.
- **One transaction per finished unit.** `put(record)` inserts the record and
  deletes the unit's failure row in the same transaction; a failure is
  written when it happens, not at the layer boundary. The `.journal`, its
  lenient decoder and `mergeRecords` are deleted — a crash leaves a database,
  which is what SQLite is for.
- **WAL, one writer — by liveness, not by lock.** A run commits per unit, so
  no SQLite lock spans it and `SQLITE_BUSY` cannot be the refusal. A run
  records its `pid`; the next one that finds it unfinished asks whether that
  process is alive: alive is a usage error naming it (today two runs silently
  interleave one journal), dead is a note and a resume. A reader (`serve`,
  M16c) is never blocked by a run in progress. A clean close checkpoints, so
  one file sits beside the model.
- **`@codegraph/insights` stays pure.** It gains a PORT (`InsightsStore`) and
  the SQLite adapter behind it, reached through the analyzer's `loadSqlite()`
  seam — `store/sqlite.ts` remains the only module that names `node:sqlite`
  (the self-hosting boundary query, M13c). The CLI injects the store through
  `ExplainSeam` exactly as it injects `fs`; every test runs on `:memory:` or
  a Map-backed fake.
- **No SQLite, no explain.** Unlike `model.db` there is no silent fallback:
  a runtime without `node:sqlite` is told so before the first call is priced.
  `--export`/`--import` aside, the JSONL is not a second write path — two
  authoritative copies is how paid work gets lost.

### 17.1 Schema (`INSIGHTS_DB_VERSION = 1`)

As landed (`store-sqlite.ts`, migration 0). Four things differ from the first
draft of this section, each because a test or a measurement said so:

- **rowid tables.** `WITHOUT ROWID` keeps whole rows in the b-tree's interior
  pages and a record is a kilobyte or more of block: Broadleaf's store was
  96 MB that way and is **57 MB** as a rowid table, for no faster read.
- **no `(level, id)` index for the export order.** The side-car sorts ids by
  UTF-16 code units; SQLite compares TEXT as UTF-8 bytes; they disagree above
  U+FFFF (the §16.8 hazard, met again). Order is decided in JS.
- **a failure's `reason` is JSON text**, `reason_kind`/`status` generated
  columns. Node's binding reads TEXT back only up to its first U+0000, and a
  provider's words are verbatim: as JSON they are escapes and survive. A
  COLUMN string holding U+0000 (an id, a name) is refused at write rather than
  stored and read back shorter — found by the round-trip property on its
  second case.
- **`PRAGMA application_id`** ("CGI1") beside `user_version`: a `model.db`
  handed over by mistake is refused, not migrated.

```sql
PRAGMA journal_mode = WAL;  PRAGMA application_id = 0x43474931;  PRAGMA user_version = 1;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- header · eof (both JSON, exactly as exported; eof is withdrawn while a run is open)
-- · exported (path, size, mtime of the last JSONL written — see §17.2)

CREATE TABLE run (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  pid INTEGER,                       -- the writer, so a later run can tell live from dead
  provider TEXT, leaf TEXT NOT NULL, rollup TEXT NOT NULL, depth INTEGER NOT NULL,
  llm INTEGER, template INTEGER, reused INTEGER, failed INTEGER, calls INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  aborted TEXT                       -- the 401/402/403 reason, or 'interrupted'
);

CREATE TABLE insight (
  id TEXT PRIMARY KEY,               -- rendered entity id: an opaque token, never parsed
  level INTEGER NOT NULL,            -- LEVEL_RANK: 0 operation · 1 type · 2 module
  kind TEXT NOT NULL, name TEXT, file TEXT,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  scc TEXT,                          -- JSON array of member ids; NULL off-cycle
  origin TEXT NOT NULL,              -- llm | template
  fingerprint TEXT NOT NULL,
  model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  metadata TEXT,                     -- JSON map
  block TEXT NOT NULL,               -- JSON, Zod-normalized key order
  concept TEXT GENERATED ALWAYS AS (block ->> '$.concept') VIRTUAL,
  confidence REAL GENERATED ALWAYS AS (block ->> '$.confidence') VIRTUAL,
  run_id INTEGER REFERENCES run(id)  -- db-only; not exported
);
CREATE INDEX insight_concept ON insight(concept) WHERE concept IS NOT NULL;
CREATE INDEX insight_run     ON insight(run_id)  WHERE run_id IS NOT NULL;

CREATE TABLE failure (               -- FailureRecord; lives until a run explains the unit
  id TEXT PRIMARY KEY, level INTEGER NOT NULL, members TEXT NOT NULL,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,              -- JSON: kind, message (verbatim), status?, retryable?
  reason_kind TEXT GENERATED ALWAYS AS (reason ->> '$.kind') VIRTUAL,
  status INTEGER GENERATED ALWAYS AS (reason ->> '$.status') VIRTUAL,
  attempts INTEGER NOT NULL, calls INTEGER NOT NULL,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  run_id INTEGER REFERENCES run(id)
);
```

The port, in `packages/insights/src/store.ts` — what `explain` needs and
nothing a SQL engine would leak. The adapter is handed an OPEN database, so
the package still touches no file of its own:

```ts
interface InsightsStore {
  isEmpty(): boolean;                                  // first contact: import, do not compare
  header(): InsightsHeader | undefined;
  eof(): InsightsEof | undefined;                      // undefined while a run is open, or after a kill
  records(): InsightRecord[];                          // side-car order (M16a's planner input)
  fingerprints(): Map<string, string>;                 // id → fingerprint, no blocks — all a plan reads (M16b)
  summary(id: string): RecordSummary | undefined;      // what a prompt quotes, projected in SQL (M16b)
  get(ids: readonly string[]): InsightRecord[];        // whole records: the export's chunks, M16c's reader
  failures(): FailureRecord[];
  exported(): ExportStamp | undefined;
  openRuns(): OpenRun[];                               // no end: still going, or killed — the caller tells which
  importFile(file: InsightsFile): void;                // REPLACES the content; the ledger is kept
  closeRun(id: number, aborted: string): void;
  beginRun(start: RunStart): RunHandle;                // header, caller's clock, pid
  putUnit(run, unitId, records): void;                 // ONE transaction: a cycle's members in, its failure out
  fail(run: RunHandle, failure: FailureRecord): void;  // when it happens
  finishRun(run: RunHandle, end: RunEnd): void;        // trailer + the owed set REPLACES the failure table
  export(): Iterable<string>;                          // the side-car's lines, in order
  markExported(stamp: ExportStamp): void;
  close(): void;
}
```

`executeRun` gained the two hooks this needs — `onUnit(records, step)` (a
finished unit handed over whole; `onRecord` could only say one member at a
time) and `onFailure(failure, step)` (the moment it happens; `onLayer` could
only say it a layer late).

### 17.2 The JSONL, from now on

- **First contact.** `explain` finds `<model>.insights.jsonl` and no `.db`:
  it imports the file strictly (`decodeInsights`, one transaction), says so on
  stderr, and continues. A truncated file imports what it holds, as today. A
  leftover `.journal` is merged once, then removed — the last time that code
  runs.
- **Every run ends with an export**, atomic, and records the written file's
  `(size, mtime)` in `meta`.
- **An edited JSONL is noticed, never obeyed.** At open, a side-car whose
  size/mtime differ from the recorded export is named in a warning with the
  remedy (`explain --import FILE`); the db wins until the user says otherwise.
  The M7 staleness test, reused with the opposite consequence.
- `explain --export` (to `--out`, by default the side-car's path) and
  `explain --import FILE` do only that: no graph, no walk, no source root, no
  provider variables. `--import` REPLACES paid-for records, so it asks like a
  spending run does — `--yes`, or a terminal to confirm on.
- **`--dry-run` and `--estimate` create nothing.** With no store they read the
  side-car as M11 did; the import waits for a run that gets to write (past the
  confirmation), so declining still means "nothing was written".
- **Ctrl-C leaves the side-car one run behind the store** — it was one LAYER
  behind under M11. The next run says so and names `--export`.

### 17.3 Milestone split

- **M16a — the store behind the port (storage swap).** ✅ (2026-09-19) Red
  first: the round-trip property (`store.test.ts`, fast-check over any
  side-car the schema admits), which found the U+0000 truncation on its second
  case. Then `InsightsStore`, the SQLite adapter, first-contact import,
  `putUnit`/`fail` per step through the new `onUnit`/`onFailure` hooks, export
  at the end, `--export`/`--import`, the live-writer refusal, the migration
  ladder with refusal tests for a newer `user_version` and a foreign file
  (bytes unchanged). `planRun`/`executeRun` keep receiving the in-memory
  `Map<id, InsightRecord>` — loaded from the store instead of the file — so
  the diff is the storage and nothing else. The journal WRITER is deleted
  (`encodeJournalLine`'s caller, `appendFile`, the per-layer rewrite); its
  READER stays for first contact with an older build's leftovers.
  Verified on Broadleaf in a scratch directory: 28 206 records imported in
  2.6 s, exported in 1.9 s, `cmp`-equal to the original 47.5 MB side-car, one
  57 MB file beside it; `--estimate` under the writing model then plans
  **0 calls, 17 780 reused** from the store. Not done here: the opt-in
  `CODEGRAPH_CORPUS_INSIGHTS` test (the check was run by hand).
- **M16b — lazy reads.** ✅ (2026-09-20) What is already explained is read
  through a `RecordSource` (`records.ts`) that keeps two questions apart
  because they cost differently: a PLAN asks `fingerprint(id)` of every unit
  and reads no block; a PROMPT asks `summary(id)` of what it quotes — the
  description and the Specy word, two short strings — and only for a unit
  about to be sent (`DependencySummary.summary/concept` are memoized getters,
  sound because the fingerprint hashes part IDS, never their text). A
  `RecordBook` is also where a run `put`s a finished unit; backed by the store
  (`storeBook`) the put IS the commit, so `executeRun` holds no record at all
  and `RunResult.records` materializes only on access (tests). The export
  streams: ids sorted in JS, then 500 consecutive records at a time, written
  in ~1 MB batches (`writeLinesAtomic`) — the side-car never exists in memory.

  The first cut asked the store for the whole RECORD per quoted dependency.
  Every gate was byte-identical and it was wrong: a popular callee is quoted
  by thousands of callers, and with every prompt rendered Broadleaf went from
  681 MB · 7.3 s to **1 521 MB · 15.1 s**. The prompt needs a projection, so
  the store serves one — `block -> '$.description'` (`->`, not `->>`: the JSON
  text keeps U+0000 as an escape) fed to the SAME `conceptLabel` the in-memory
  path uses, pinned equal by a fast-check property — and the book keeps it
  once read.

  Gate, on Broadleaf (28 206 records), every plan and every exported record
  `cmp`-equal to M16a's — reuse-all, `--force` (17 809 prompts quoting the
  store) and the fixture:

  | | M16a | M16b |
  |---|---|---|
  | records held by a plan (heap, GC forced) | 68 MB, 723 ms to load | **7 MB**, 68 ms (fingerprints) |
  | … with EVERY summary quoted | — | 27 MB |
  | the export | 47 MB string + a second copy of every record | 500 records at a time |
  | `--dry-run`, all reused (peak RSS · wall) | 676 MB · 6.4 s | 686 MB · 5.5 s |
  | `--dry-run --force`, every prompt rendered | 681 MB · 7.3 s | 706 MB · 7.6 s |
  | a real run, 0 calls, with export | 1 094 MB · 37 s | 936 MB · 10.6 s |

  **What the numbers say, plainly: peak RSS did not move at `--dry-run`, and
  could not have.** The records were 68 MB of a process whose graph, facts and
  walk are ~580 MB; §17's motivation table quoted 528 MB for decoding the
  side-car, which was the JSONL text plus Zod's garbage — a cost M16a had
  already removed by not reading the file. M16b's gain is the one in the first
  three rows, it scales with the corpus, and a reader (M16c) inherits it; it
  is not a smaller `explain`. Two things the measuring found that ARE:
  - the 37 s → 10.6 s is `PRAGMA synchronous = NORMAL` (WAL's intended
    setting), not laziness: M16a made each of the 9 892 templated units —
    recomputed on every run — a durable commit with its own fsync. A kill, an
    OOM or Ctrl-C still loses nothing; only a power cut can lose the last few
    commits, never the file.
  - the real run's remaining ~250 MB over a dry run is `naturalKeys()`:
    `explain` rebuilds the whole model (78 017 entities, ~156 MB, 2.5 s) to
    label records with `(lang, module, symbol)`. Not a records problem; see
    §17.4.
- **M16c — the first reader.** `codegraph insights <model> [--id ID]
  [--concept aggregate] [--min-confidence X] [--json]` over the store,
  read-only; then the daemon route the Navigate panel asks for a selected
  node's description (one `get`, no artifact — `navigator.json` does not
  grow by 26 MB of prose). The navigator-ui guard learns the route; the page
  renders with no store present. Design the panel against screenshots before
  writing it; this step may split.

Tests that pin the decisions: the round trip (above); **crash safety** — kill
after N `put`s, reopen, N records reused, the failure rows of that run
present; **failure lifecycle** — a `put` for a failed unit deletes its row,
`attempts` increments across runs, `--retry-failed` scopes from the table;
**never disposable** — a newer `user_version` is refused and the file's bytes
are unchanged, an older one migrates with the row count intact; **one
writer** — a second store on a running one fails with the usage error;
**boundaries** — no `node:sqlite` outside `analyzer/store/sqlite.ts`, no
`insight.id` parsed, `model.db` opened read-only-or-not-at-all by everything
in this phase.

Definition of done: `explain` on the Java fixture live and on the fake client
writes a `.insights.jsonl` byte-identical to M11's for the same answers; the
Broadleaf side-car imports, exports byte-identical, and a `--retry-failed` on
it runs from the store; no `.journal` is ever created; a run killed mid-layer
resumes with its records AND its failures; `pnpm -r test`, typecheck and
`test.sh` green; the numbers of M16b in this section.

### 17.4 Deferred, explicitly

- **A run that changes nothing should cost a dry run** (found measuring M16b;
  Broadleaf, 0 calls: 10.6 s and 936 MB against 5.5 s and 686 MB). Two causes,
  both outside the records: (1) a templated unit is recomputed AND re-committed
  on every run — 9 892 of them; one whose stored fingerprint already matches
  could be counted and left alone, which changes no plan; (2) `naturalKeys()`
  rebuilds the model to label records, when the keys are needed only for units
  about to be written and `model.db` already holds them (`entity_key`). With
  both, a no-op run writes nothing and reads no model twice.
- **Several models side by side.** The model is part of every fingerprint,
  so a run under another `--model` redoes — and replaces — everything
  (Broadleaf under the default model: `reuse 0`, 17 809 calls). A key of
  `(id, model)` would keep both and let them be compared; it changes the
  export contract (which one is THE side-car?) and waits for a use.
- **Insights in the desktop app's `--data-dir`** (M14a) — the store sits
  beside the model there as everywhere; running `explain` from the app is its
  own question (a provider key in a GUI).
- **Full-text search over descriptions** (FTS5) — `node:sqlite` builds carry
  it, no reader asks for it yet.
- **History of a record** (what the previous model said) — the `run` ledger
  says when and for how much; the superseded text is not kept.

---

## 18. Milestones

| # | Milestone | Definition of done |
|---|---|---|
| M0 | Bootstrap | workspace builds, CI green |
| M1 | Core metamodel | traits + 9 profiles + validation + JSON Schema, tested |
| M2 | Java extractor | ✅ fixture corpus → valid `model.json`, schema-validated **and profile-validated across the language boundary**, closed graph, 94.1% resolution on the fixtures |
| M3 | Analyzer | ✅ import graph, type deps, cycles, coupling metrics, DOT/CSV/JSON exports; 252 tests; verified end to end on google/gson (3 624 entities) and apache/commons-lang (15 338 entities) |
| M4 | CLI + properties | ✅ `validate`/`analyze`/`export`/`profiles` shipped; conformance gate + property suite green; 1 007 TS tests; verified end to end on apache/commons-lang (15 338 entities / 24 631 edges, every command < 1 s) |
| M5 | Metamodel v2 | ✅ METAMODEL.md §1.1/§4 restated + §5.1/§5.2 added + §8 model/encoding split; core natural-key vocabulary, `renderId`, memoized validation; 1 089 TS tests, wire format and `schemas/` byte-identical |
| M6 | JSONL interchange | ✅ in-place clean break (`schemaVersion` unchanged): streaming reader/writer, per-record schemas + generated container contract, extractor emits `.jsonl`, fixtures regenerated, v1 deleted; fineract 559.5MB → 127.4MB and analyzable end to end; 1 149 TS + 153 Java tests |
| M7 | SQLite store | `codegraph import` → `model.db` cache; DB-backed analyzer facade; repeat runs skip parsing; reports byte-identical to M6 outputs |
| M8 | 2nd language | clj-kondo adapter; cross-language import-graph query works |
| M9a | SCM miner + Gource replay | `codegraph scm` → deterministic `history.jsonl`; `history summary/hotspots/authors` reports match hand-counted fixture numbers; file-level city replay with timeline scrubber runs on codegraph's own history |
| M9b | Temporal store | ✅ sampled `import --at` revisions in `model.db` (orchestrated by `codegraph snapshots`); lifespans + `codegraph timeline`; hidden-coupling/ownership queries verified on gson history (55 release keyframes, 2008–2025); property suite green at every keyframe |
| M9c | Entity-level city replay | ✅ frozen union layout; temporal `city.json` with per-building series (`codegraph replay`); time colors (heat + age), owner color mode and dashed co-change arcs via the `--history` join; scrubbed replay reviewed as screenshots on gson at user-facing angles, allocation-free scrub path |
| NV | Navigator frontend | ✅ `codegraph navigator --serve` (since folded into `codegraph serve`: one page, the navigator with the city as a tab, a building's panel opening its navigator entry): `@codegraph/navigator` builds an index-addressed browsable artifact (tree + one classified dependency row per base edge, reference sub-roles recovered from the source entity); `@codegraph/navigator-ui` renders it — virtualized tree with search, fan-in/fan-out sectioned by role with member, provenance and anchor. Design record: `docs/navigator.md`. Verified on fineract (102 972 nodes / 668 286 rows, 100 MB artifact loading in 1.3 s, 45 rows mounted after scrolling) |
| M10a | Source links | ✅ header `repository` facts (remote, commit, repo-relative root, provider?) in core + `schemas/` as patterns; extractor passthrough flags; CLI-derived normalization carried per snapshot frame; store/city/viz carry them and the details panel links at the scrubbed sha — verified on gson (`JsonReader.java#L211-L2005` at `b3f4ca2`, replay retargeting to `ed2b25d`, fixture city linkless) |
| M10b | Measures | ✅ `TMetrics` (open keys, finite values) in core, `schemas/` and the store (`entity_metric` rows, DB_VERSION 3); Java extractor emits `sloc` (lexer-based) + `cyclomatic` with a lambda's branches charged to the lambda; fixture CC values hand-counted, `sloc ≤ span` a property; `--height sum:cyclomatic --footprint loc` reviewed as screenshots on commons-lang (`JavaVersion.get` hand-count 33 = emitted 33) |
| M10c | Literal values | ✅ `Literal` + `TWithValue` + `annotationUse` in core, `schemas/` (a named `$defs/Literal`) and the store (JSON columns, DB_VERSION 4); Java extractor carries annotation arguments, constant initializers and element defaults, `unevaluated` where it cannot fold; closure reaches inside values by ENCODING; fixture asserts the four `Audited`/`MAX_LINES` cases; gson and commons-lang diagnose clean |
| M10d | Framework semantics | ✅ data-driven Spring/Jakarta framework profile (5 roles, matching on name + module, stub-tolerant); derived DI `dynamic-candidate` wiring with @Primary/@Qualifier narrowing that states what it narrowed from; `analyze --report wiring` + `city --framework` role channel with its legend; hand-verified on spring-petclinic (`a6e81a5`: 5 injections → the one corpus impl, 4 → honest empty; HEAD: 6 implicit constructor injections), `declared` view byte-identical before and after |
| M11 | Insights walk | ✅ `codegraph explain`: `@codegraph/insights` (pure) + `@codegraph/llm` (the one SDK importer); units = operations → types → modules; one SCC-condensed dependency graph (calls, type deps, imports, downward containment) so mutually dependent packages/types/methods are ONE unit, Kahn-layered; context packs with dependency explanations at `--depth`; Specy-vocabulary blocks validated by Zod and sent as strict JSON Schema; Merkle fingerprints (inputs + dependency fingerprints + missing deps, never explanation text) make re-runs incremental; `--dry-run`/`--max-calls`/`--scope`/`--concurrency`/`--max-scc`; journal + sorted side-car `<model>.insights.jsonl`; cycle suite pinned to the analyzer's cycle report (opt-in real-corpus run via `CODEGRAPH_CORPUS_MODEL`; Fineract: 53 207 units, 18 package tangles, largest 509). Verified live on the Java fixture with gpt-5.6-luna: 77 units, 68 calls, $0.06 all-in, blocks in the Specy vocabulary (Order → entity with identity, StockGuard.ensure → precondition + error event, com.acme.order → APIs/SPI `Ledger`); the `specy:domain-extract-from-code` skill consumes the side-car (`heuristics/codegraph.md`). Design record: `docs/insights.md` |
| M12a | C# extractor — skeleton | ✅ `extractors/csharp/` (Roslyn 5.9 on .NET 10, no MSBuild, BCL ref pack embedded — §13); csharp profile v2 in core; walking skeleton (namespaces, every type kind, delegates + parameters, doc comments, import/inheritance/implements, stubs) → `fixtures/csharp/expected/model.jsonl` byte-identical to core's encoder and profile-valid with zero issues; 51 .NET tests (per-line schema + sequence rules, stub discipline, determinism incl. CRLF and walk order, id scheme, CLI) + 13 core gate tests; `codegraph validate` OK; `codegraph snapshots --extractor` (jar or binary); extractor CLI contract as `schemas/README.md §8`; `build.sh --csharp [--publish-all]` / `test.sh --csharp` with the published-binary `cmp` |
| M12b | C# extractor — model | ✅ members (incl. implicit and primary constructors, operators, indexers, events, locals, lambdas, local functions), every profile edge kind incl. `annotationUse` with written values and `throws`, extension `attachedTo`, `sloc` + `cyclomatic`; synthesized record members fold to their type; stub discipline (BCL stubs in real namespaces, error types in `<unresolved>`, unbound receivers referenced by name); snapshot 244 entities / 285 edges, byte-identical to core's encoder; 76 .NET tests + 20 core gate tests; the fixture in the analyzer, city, navigator and CLI suites; every CLI command verified on it |
| M12c | C# extractor — binaries + audit | ✅ five-RID `dotnet publish` matrix cross-published from one Linux host (287 s; ELF x64/aarch64, Mach-O x64/arm64, PE32+); GitHub Actions gate (`verify`, `java`, `csharp-test`, `csharp-publish` ×5, `csharp-smoke` on Ubuntu x64/arm64, macOS arm64/Intel and Windows — each binary must reproduce the snapshot byte for byte — and tagged releases with SHA256SUMS); three-corpus audit: Humanizer 97.3 % / 12 146 entities / 6 s, dotnet/eShop 63.5 % / 7 396 / 12 s, OrchardCore 93.4 % / 88 007 entities / 225 184 edges / 54 s, every model `validate`-clean; five defects found and fixed (signatures carry type arguments, conversion operators their return type, duplicate parameter names their ordinal, same-keyed declarations across projects kept and re-keyed by file, C# 14 extension blocks); resolution causes measured — the SDK's implicit usings and the ASP.NET Core reference pack now in — and the residue named in the profile notes; eShop city and navigator screenshots reviewed; `docs/csharp-extractor.md` |
| M13a | TypeScript extractor — skeleton | ✅ `extractors/typescript/` (the compiler API as the front end, no build, `typescript` the only runtime dependency — §14); typescript profile v2; walking skeleton → `fixtures/typescript/expected/model.jsonl` byte-identical to core's encoder and profile-valid with zero issues; core gate; boundary test; `snapshots --extractor` runs `.js` under `node`; `test.sh --ts` built-bin `cmp` |
| M13b | TypeScript extractor — model | ✅ members, every edge kind incl. `annotationUse` with written arguments and `throws`, `space` per entity, declaration merging per file, key escaping, JSX invocations, workspace-package resolution without `node_modules`, `sloc` + `cyclomatic`, literals; the full fixture with its README; determinism and stub-discipline tests; the fixture in every per-fixture suite |
| M13c | TypeScript extractor — self-hosting + audit | ✅ codegraph's own model (24 887 entities / 51 255 edges, 12 s, 96.5 %, zero `<unresolved>`) validate-clean with the package boundaries, the frontend types-only rule and the three import boundaries recovered as graph queries, city and navigator screenshots reviewed; TypeScript 4.9 compiler (52 341 / 120 127, 97.4 %) / nestjs (29 992 / 32 537, 88.6 %) / excalidraw (43 706 / 62 557, 94.4 %) audit with six defects fixed and the causes in the profile notes; `typescript-smoke` on three OSes and `npm-publish` on a tag; `docs/typescript-extractor.md` | `validate`-clean with its package boundaries recovered as a graph query, city and navigator screenshots reviewed; TypeScript 4.9 compiler / nestjs / excalidraw audit with resolution causes in the profile notes; `npx codegraph-typescript`, the three-OS smoke matrix and tagged npm release; `docs/typescript-extractor.md` |
| M14a | Desktop — the daemon | ✅ `codegraph serve --app [--data-dir DIR] [--extractors FILE]`: loopback capability URL (`/<token>/`, one stdout JSON line, 404 outside it, 403 on a foreign `Origin`), extractor registry as data with extension-census detection (a tie is a 422 question), `POST /jobs` (202/409/422/404) + `jobs/current` SSE with replay, `--data-dir` holding model + model.db + artifacts + recents, extraction skipped on an unchanged tree fingerprint and the build on an unchanged build key, a `model.jsonl` opens with no extractor, exit on stdin EOF/SIGTERM; the page's empty state in app form (recents, three phases + extractor stderr, the open instruction, the "which extractor?" question, failures); 64 tests incl. the fake extractor over real sockets and the real binary as a child; driven headlessly on the Java fixture and the TypeScript extractor, screenshots reviewed |
| M14b | Desktop — the SEA | ✅ one Node single-executable image per OS, ONE program: `dist-sea/codegraph.cjs` (CJS, everything but built-ins inlined, 2.9 MB) + both frontends and `package.json` as assets, folded into a copy of the building Node by `scripts/sea-build.mjs` (postject, macOS re-signing) → `dist-sea/<rid>/codegraph`; `node:sea` reached via `process.getBuiltinModule`; one `FrontendAssets` seam with a directory and a keyed source; `./build.sh --ts --sea`, `test.sh` gate, five-runner `sea` CI job + release artifacts; `scripts/sea-smoke.mjs` green on linux-x64 (131 MB): `--version`, `analyze` ×3 byte-identical to the ESM build, `serve --app` serving the page from the image and opening the Java fixture |
| M14c | Desktop — the shell | ◐ `apps/desktop/` (Tauri 2) written and CI-compiled, the WebGL gate on fineract NOT yet run (needs a Mac): the one sidecar (the SEA) by target triple via `scripts/sidecar.mjs`, daemon lifecycle (spawn, read the port line, navigate, close stdin + kill), the extractor catalogue + `codegraph-discovery` (PATH + Homebrew prefixes + settings overrides, 8 tests) writing the registry (missing entries carry `install`, no `path`), the daemon's `not-installed` answer + registry re-read on every request (tested, headless screenshots reviewed), the page's install line with "Check again", File › Open Folder… / Open Recent / Rescan / drag-and-drop each one `POST /jobs`; no `@tauri-apps/*` outside `apps/desktop` (boundary test); remaining: `tauri dev` screenshots on the Java fixture and fineract, the WebGL frame time |
| M14d | Desktop — signed, in the tap | ◐ pipeline + generators written and tested, no release yet: `desktop-bundle` job per macOS architecture (sidecar signed by CI with the JIT entitlement trio, `tauri build` signing + notarizing from secrets, `codesign`/`spctl` assertions, ad-hoc bundling without secrets), two DMGs + the raw SEA on the release, `scripts/homebrew/render.mjs` rendering the cask (`app` + ONE `binary` stanza) and the three formulae (`codegraph-java`/`-csharp` per architecture from SHA256SUMS, `codegraph-typescript` on Homebrew's `node` from the npm tarball) and the release job pushing them to `defsquare/homebrew-tap` over a deploy key (7 tests, `docs/distribution.md`); outstanding: the Apple credentials and the deploy key in the repository's secrets, the tap repository, a `v*` tag, and the clean Apple-silicon and Intel Mac checks (`brew install --cask defsquare/tap/codegraph` opens the app, a Java folder names the install line, the three extractor formulae put the commands on PATH, each reproducing its fixture snapshot) |
| M15a | Elixir extractor — profile + skeleton | `elixir` profile in core (the tenth: the module is the file, a `defmodule` is a `module` kind carrying `TType`, arity is identity, no inheritance/embedding — §16.2); `extractors/elixir/` as a Mix project on the compiler's parser with the embedded OTP table, no runtime dependency (§16); walking skeleton → `fixtures/elixir/expected/model.jsonl` byte-identical to core's encoder and profile-valid with zero issues; core gate; escript on `bin/codegraph-elixir`; `build.sh --elixir` / `test.sh --elixir` with the escript `cmp`; `elixir-test` in CI |
| M15b | Elixir extractor — model | ✅ (2026-09-16) every kind and edge of §16.2: clause and default folds, the four import forms as one edge kind, `defimpl` as an attached named module, `@derive` as `generated`, `use` as import + `__using__` invocation, struct-expansion accesses, protocol and `GenServer` self-call `dynamic-candidate`s, `throws`, `@spec` references, docs as comments; `sloc` + `cyclomatic`, literals; `--deps` (exports only); the full fixture with its README; determinism, stub-discipline, scope and arity suites; the fixture in every per-fixture suite; city and navigator screenshots reviewed. Snapshot 210 entities / 174 edges; 60 ExUnit tests + 3 properties; Plausible re-run: 16 369 entities / 51 736 edges in 5 s, `validate`-clean, 64.7 % of 119 972 sites resolved or Kernel, the rest counted by reason (`local_injected` and `local_unbound` dominate — the macro ceiling `--trace` exists for) |
| M15c | Elixir extractor — audit + oracles + distribution | ✅ (2026-09-16) `elixir-lang/elixir` `lib` (557 files, 27 061 / 78 564, 17 s, 80.8 %), Phoenix (205, 5 828 / 14 314, 76.7 %) and Plausible (1 256, 16 369 / 43 661, 58.2 %) audited `validate`-clean, byte-identical to core's encoder, the causes in the profile notes; four defects found and fixed (variadic special forms counted as unbound locals, binary specifiers read as calls, repeated head names re-keying parameters, a corpus `use` treated as no injection source); `--explain-dropped` lists every dropped site; `mix codegraph.trace` (a compilation tracer, JSONL events) + `--trace` merging `generated` edges through the closing rules (Phoenix: 16 797 events → 5 895 edges); the `mix xref` witness check (147/148 on Phoenix) and the trace superset check as opt-in real-corpus tests (`CODEGRAPH_CORPUS_ELIXIR`); the Burrito binary (Zig 0.16, `build.sh --elixir --native`, `test.sh` `cmp`), `elixir-smoke` on three OS runners, `elixir-native` on two, `hex-publish` on a tag; README, CLAUDE.md and `docs/elixir-extractor.md` name the extractor. Deferred: the M14 registry entry and cask stanza (M14 is not on main yet), the Windows native binary (needs 7z on the runner) |
| M16a | Insights store — the storage swap | ✅ (2026-09-19) `<model>.insights.db` (§17) as `explain`'s working copy behind an `InsightsStore` port in `@codegraph/insights`, its SQLite adapter handed an open database (the analyzer's `loadSqlite()` stays the one load site — the hygiene guard caught three comments naming the specifier); one transaction per finished unit and failures written when they happen (`onUnit`/`onFailure` in `executeRun`); the journal writer and the per-layer 47 MB rewrite deleted; the side-car an atomic deterministic export at the end of a run, imported on first contact by the first run that WRITES (`--dry-run`/`--estimate` create nothing), an outside edit warned about and never obeyed; `--export`, `--import FILE` (asks); a run records its pid — a live writer is refused, a dead one resumed with its records AND its failures; a migration ladder on `user_version` + `application_id`, a newer or foreign file refused with its bytes unchanged; round trip byte-identical as a fast-check property and on Broadleaf (28 206 records, 47.5 MB, `cmp`-equal; store 57 MB — 96 MB before `WITHOUT ROWID` was measured and dropped); 18 store tests + 2 run-hook tests + 11 CLI tests incl. a real-disk run |
| M16b | Insights store — lazy reads | ✅ (2026-09-20) a `RecordSource` keeps a plan's question (`fingerprint`, no block) apart from a prompt's (`summary`: description + the Specy word, projected in SQL and pinned equal to the in-memory rule by a property, read once however often quoted); a `RecordBook`'s `put` is the store's commit, so `executeRun` holds no record; the export streams 500 records at a time into ~1 MB writes. Every plan — reuse-all, `--force` (17 809 prompts quoting the store), the fixture — and every exported record `cmp`-equal to M16a's. Records held by a plan: 68 MB → 7 MB (27 MB with every summary quoted); a 0-call run 1 094 MB · 37 s → 936 MB · 10.6 s, the time being `synchronous = NORMAL` undoing M16a's fsync per templated unit. Stated plainly in §17.3: `--dry-run` peak RSS did NOT move (676 → 686 MB) — the graph is ~580 MB of it, the records never were the cost; a first cut that re-read a whole record per quote was byte-identical and twice as slow (1 521 MB), which is why the gate measures and does not only compare |
| M16c | Insights store — the first reader | `codegraph insights <model>` (by id, concept, confidence; read-only) and the daemon route serving a selected node's description to the Navigate panel — `navigator.json` does not grow; the page renders with no store present; screenshots reviewed |

## 19. Decisions made in this plan (deltas vs. the design doc)

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
| Closure (M6) | enforced by the ENCODING: a reference is a surrogate, so a dangling one is unwritable and unreadable | the check moves from "report it afterwards" to "it cannot exist"; the extractor drops and counts what it cannot close |
| Executable containment (M6) | `method`/`constructor`/`lambda` declare `TWithChildren` | their parameters and locals already carried `parent`; only one direction was licensed, so the model stated a containment its own profile forbade |
| Sync chunked reader (M6) | `readModelFileSync` reads 1MB at a time rather than making the CLI async | the ceiling is one JavaScript string, not synchronous I/O — going async would change every command signature and fix nothing |
| SQLite (v2) | `model.db` is a derived, disposable analyzer cache built by `codegraph import` — never the contract, never committed | queryable/incremental/random access for CLI + future viz without sacrificing diffable fixtures, byte-determinism, or the any-language extractor bar |
| Key separators (M5) | `/` and `#` reserved in the key's components; `renderId` validates and throws | rendering must be injective, or two distinct keys merge into one entity with no error — the M2 overload collision one level up |
| Module component (M5) | a module names ITSELF, with an empty symbol — not its parent module | the parent form breaks the frozen `java:com.acme.order` id shape and needs a fabricated `java` module to place the stub package `java:java.util` |
| Trait-set interning (v2) | rejected — traits ride inline as int arrays; MM-4's validate-once-per-set is reader-side memoization | set indirection saved ~4MB on a ~90MB file but cost a record type, a dedup pass in every extractor, and lines unreadable in isolation |
| Evolution facts (Phase 8) | separate `history.jsonl` joined on `anchor.file` paths — never merged into `model.jsonl`, no fifth provenance value | repo-scoped facts with a per-commit lifecycle don't belong in a language-scoped structural contract; the provenance set keeps code facts and history inferences unmixable |
| Lineage over time (Phase 8) | natural-key equality across snapshots; a rename is a death + a birth; anonymous entities untracked | invariant 7 makes temporal identity free for named entities; rename matching is heuristic machinery, deferred until a corpus proves it necessary |
| Replay layout (Phase 8) | one layout over the union of all keys that ever existed, plots frozen; buildings animate in place | shelf packing is chaotic — one insertion reshuffles the city; a readable replay needs positional stability more than land density |
| Snapshot strategy (Phase 8) | sampled keyframes via `git worktree`; per-commit incremental extraction deferred | full extraction × thousands of commits is prohibitive, 50–200 frames give the replay effect; noClasspath makes non-compiling historic commits extractable |
| Repository provenance (Phase 9) | facts in the header — `remote` (normalized https), `commit` (sha), repo-relative `root`; host URL templates derived by consumers, `provider` only when the hostname lies | a serialized URL freezes one host's scheme into the interchange; a sha is a permalink where a branch moves; anchors are relative to the analyzed root, which sits below the repo root (gson) — without the prefix no anchor projects back |
| Measures (Phase 9) | `TMetrics` open numeric map; canonical key names documented (METAMODEL §3.8), values validated finite, keys deliberately NOT a closed MM-3 vocabulary | measures are the extractor-innovation surface — a closed set gates every new measure on a core release; loose top-level keys stay legal (container contract) but uncontractual, and only a trait makes `sloc`/`cyclomatic` comparable across extractors |
| Measure storage (M10b) | `entity_metric(entity_id, key, value)` rows in `model.db`, not a JSON column; the wire writes the map key-sorted, so reading back `ORDER BY key` restores it | the store exists to be QUERIED and a measure is precisely what one aggregates ("cyclomatic by package"); a blob would make the one thing measures are for a full-table JSON scan |
| DI wiring (Phase 9) | derived by the analyzer from declared facts + a framework data table; `dynamic-candidate` provenance, in-memory only, matched by entity name — never id parsing | the extractor stays framework-blind; the candidate set needs whole-corpus implementor knowledge only the analyzer holds; Spring dispatch is §1.3's `dynamic-candidate` definition verbatim |
| Literal values (Phase 9) | tagged-union `Literal`: numbers as canonical decimal text, enum values as type id + simple name, unfoldable constant expressions kept as `unevaluated` source text; ids inside values obey closure | a JSON number loses a Java `long`; a fabricated enum-member stub is the one thing §6 forbids; dropping an unfoldable expression erases a written fact — degraded honesty over silent loss, the stub discipline applied to values |
| Annotation usage (Phase 9) | dedicated `annotationUse` edge kind carrying `arguments`, replacing the plain `reference` — in-place clean break, fixtures regenerated | overloading `reference` would make `arguments` meaningful on one disguised subset of a kind; consumers cannot select annotation usages today without guessing from the target's kind, which a stub target cannot answer |
| C# corpus loading (M12) | Roslyn syntax + semantic model over a hand-built `CSharpCompilation`; never `MSBuildWorkspace`/`Build.Locator` | the noClasspath contract: legacy corpora have no restorable project graph; MSBuild needs an installed SDK and breaks single-file publishing; a missing package must be a stub, not a build failure |
| C# unresolved types (M12) | `IErrorTypeSymbol` → stub in the reserved module `csharp:<unresolved>`, named as written; BCL/metadata types → stubs in their real namespace | guessing a namespace from `using` directives would invent an FQN — the exact fabrication the whitelist rule exists to refuse; the `using` itself still yields the import edge |
| C# type identity (M12) | symbol carries generic arity via Roslyn `MetadataName` (`Foo`1`); signatures use erased FQ metadata names with type parameters as ordinals | `Foo`, `Foo<T>`, `Foo<T,U>` legally coexist in one namespace — Java-style erasure would merge three declarations into one entity (the M2 overload collision one level up) |
| C# BCL references (M12) | `Microsoft.NETCore.App.Ref` embedded as resources, loaded via `CreateFromImage`; never `Assembly.Location` | `Location` is empty inside a single-file bundle, so the tutorial approach binds nothing in the shipped binary while passing under `dotnet run` |
| C# distribution (M12) | self-contained single-file + ReadyToRun per RID, cross-published from Linux; NativeAOT and trimming deferred | Roslyn is not AOT/trim-clean, and NativeAOT needs each target OS's native toolchain; single-file needs only one runner for all five RIDs |
| Extractor CLI contract (M12) | one flag shape and exit-code set for every extractor, written in `schemas/README.md`; `snapshots --extractor` (jar → `java -jar`, else run directly) | the Node side must stay language-blind: it orchestrates a process, not a language |
| Cross-OS acceptance (M12) | `cmp` of the published binary's output against the committed snapshot — run in CI on a runner of each OS since the move to GitHub Actions | byte-determinism (§6 of the contract) makes "works on macOS/Windows" a one-line check; GitHub's hosted macOS and Windows runners make it a gate rather than a laptop ritual |
| C# signatures carry type arguments (M12c) | `System.Func`2<!!0,System.String>`, not the erased `System.Func`2`; conversion operators append their return type | C# overloads on type arguments alone (Humanizer) and conversions on the return type alone (OrchardCore, 37 on one type); erasure merged written methods into one key and aborted the extraction |
| Same-keyed declarations across projects (M12c) | every one kept: the first in ordinal file order owns the plain key, each later one is re-keyed `#in:<file>`, each re-keying named on stderr | a corpus is not a compilation unit (eShop's ten `Program.<Main>$`, its per-service `Extensions`); the JDT "first wins" rule the Java profile documents would erase nine services' DI wiring, and a file is a source fact like a lambda's position |
| Implicit usings (M12c) | Microsoft.NET.Sdk's seven `global using`s added as a synthetic tree by default; the Web SDK's opt-in (`--implicit-usings web`); none write an import edge | they live in the generated obj/ file the extractor skips as build output; without them `Task`/`List<T>` were OrchardCore's top unresolved names (62.7 % → 93.4 %); the Web set on a mixed corpus makes names ambiguous (OrchardCore's own `StartupBase`, 345 times) |
| Reference packs (M12c) | the ASP.NET Core shared framework's pack embedded beside the BCL's when the building SDK has it | `ILogger<T>`, `IServiceCollection`, `WebApplication` topped eShop's and OrchardCore's unresolved lists; a shared framework is not a NuGet package and ships with every SDK |
| C# 14 extension blocks (M12c) | members of `extension(T t) { … }` are members of the enclosing static class with `TAttachedTo` → the receiver; the block itself is no entity | Roslyn models the block as a nameless nested type, which failed `validate` on an empty name (Humanizer); the block names no type the source can reference |
| TypeScript front end (M13) | the `typescript` compiler API (`ts.createProgram` + `TypeChecker`) used directly; ts-morph, parser-only front ends (tree-sitter, swc, oxc, Babel) and scip-typescript rejected | it is Roslyn's twin — a compilation plus a semantic model, error-tolerant by default; ts-morph wraps every node and lags releases; a parser has no binder, so every call would be a guess; SCIP carries occurrences, not kinds, provenance or spaces |
| TypeScript corpus loading (M13) | one `Program` over every source file under the roots; `tsconfig` read for resolution options only; a bare specifier naming a package declared under the roots resolves by `package.json` name to its source entry when standard resolution fails; a missing package is a stub module | the noClasspath contract: no build, no `node_modules`, no project references; a monorepo's own packages are corpus, not dependencies |
| TypeScript extractor boundary (M13) | runtime dependency `typescript` only; `@codegraph/core` a devDependency of its tests; a boundary test scans `extractors/typescript/src` | the two-encoder gate ("byte-identical to core's encoder") is a statement only while the encoders are independent; the temptation to import core is greatest in core's own language; a one-dependency package runs under `npx` anywhere |
| TypeScript module identity (M13) | the module is the file, always; every path segment and non-identifier name entering a key percent-encodes `/`, `#`, `%` (and `.` in names); declaration merging yields one entity per declaring file, edges land on the declaration owning the referenced member | `/` is a reserved separator and rendering must stay injective for every language; a look-alike separator is not typeable in a CLI or a SQL query; containment is where a thing is written (invariant 5) — a `<global>` module would state otherwise |
| TypeScript external keys (M13) | stubs keyed by npm package name (nearest `package.json`), lib types in `<lib>`, unbound names in `<unresolved>`, an unresolved specifier a stub module keyed by the specifier; `--ignore-node-modules` produces the fixture | keys must not depend on what happens to be installed; resolvability is not membership (the C# rule); a dropped import edge would understate fan-out |
| TypeScript distribution (M13) | an npm package run with `npx`, `typescript` external to the bundle; a Node single-executable per OS deferred | Node ≥ 22 is already the pipeline's floor; a bundle that inlines the compiler loses `lib.*.d.ts` and binds no standard library — the `Assembly.Location` trap in its Node form, pinned by a test on the built bin |
| Interface members are type-space (M13c) | a `method` or `property` written in an `interface` body carries `space: ["type"]`; the profile licenses both spaces on those kinds | the self-hosting query "frontends depend on model packages for types only" was false with interface members in the value space — `viz` reads `city.roles`, a shape, not a value; an access to an interface member is a dependency on the interface's shape and is erased at runtime like the interface |
| What an object literal's parts are (M13c) | members of a literal BOUND to a name (`const Ops = {…}`, `static x = {…}`) are entities below the binding; members of an unbound literal (array elements, arguments, return values) are none, and a method written there is keyed positionally like an arrow; a class expression bound to a variable or property IS that binding | 2 260 re-keyed collisions on codegraph's own tests came from `[{hash, time}, {hash, time}]`; an unbound literal is no entity, so its parts cannot be either, while the functions written inside it are still code |
| Unclosable edges (M13c) | the extractor drops an edge whose endpoint no entity declares, counts it on stderr as `unclosable`, and never aborts | schemas/README.md §5: a producer that cannot close a reference drops it and says so; two audited corpora aborted the write on a dangling constructor before this net existed — zero on every corpus is the goal, and a non-zero count names an id-scheme gap |
| Desktop shell (M14) | Tauri 2 as window, menu, dialog, drag-and-drop, extractor discovery, sidecar lifecycle, bundling and signing — no model logic in Rust | the analyzer, city and navigator exist in TypeScript and are tested there; a Rust rewrite of any of it is a second implementation of a contract that already has one |
| Distribution granularity (M14) | the app is ONE install (cask: `Codegraph.app` + `codegraph`); every extractor is its OWN install (`codegraph-java`, `codegraph-csharp`, `codegraph-typescript`, `codegraph-elixir`… as formulae in the same tap); the app bundles no extractor and discovers what is installed | each extractor carries its own runtime, tens of MB per architecture a user of another language never needs; one cask with all of them grows with every language and re-downloads all on any upgrade; extractors and app version independently and meet on the interchange contract — the reason the extractors were separate processes under one command line in the first place |
| The Node side of the app (M14) | ONE Node single-executable image, ONE program: the CLI, the daemon and both frontends; no extractor inside, no dispatch by invoked name | with TypeScript its own install there is nothing to dispatch; the image is the CLI as built, plus assets, and the §13.5 rule (the Node side never learns a language) is a packaging fact with no exception to explain |
| TypeScript extractor as a formula (M14) | `codegraph-typescript` = the M13 npm package installed by a Homebrew formula with `depends_on "node"` (`std_npm_args`), `typescript` still external | it IS one install per extractor without a second 110 MB Node image: ~12 MB on Homebrew's shared `node`, the shape every Node command has in Homebrew; the libs stay beside the compiler so the §14.7 trap never arises; `npx codegraph-typescript` and the formula are the same tarball |
| The app's page (M14) | served by the daemon on loopback, same origin, under a per-launch capability token; no Tauri IPC in the page | `navigator-ui` stays Tauri-free and its boundary test stays simple; CORS between the webview origin and loopback never arises; a code model on an open loopback port is readable by any local page |
| Extractor selection in the app (M14) | a registry `{ name, path?, extensions[], launch, env?, install? }` written by the shell from a catalogue + discovery on PATH and the Homebrew prefixes; detection by extension census; a tie is asked, never guessed; a tree only a missing extractor claims is `not-installed` with the `brew install` line | profiles are data (invariant 8) and so is this: the daemon runs a registry entry under the §13.5 contract and names no language; an absent extractor is a fact the page states with its remedy, not a silent failure |
| Daemon lifetime (M14) | exits on stdin EOF and on SIGTERM; the shell also kills it on close | an orphaned daemon keeps a model in memory and a port open after the window is gone; two rules make that impossible rather than unlikely |
| Homebrew (M14) | one tap, `defsquare/homebrew-tap`: a cask for the app, one formula per extractor, each generated by its own release job; `brew upgrade` is the update path, the Tauri updater off; Linux and Windows on the releases, outside brew | Tauri produces a `.app`, which a cask installs and a formula cannot; a command on PATH is what a formula installs, from a prebuilt binary that is legitimate in our own tap (homebrew-core refuses vendored binaries, a tap does not); two update mechanisms drift |
| Elixir front end (M15) | the compiler's parser as a library (`Code.string_to_quoted/2`) plus a lexical resolver and an embedded OTP export table; compilation tracers only as the `--trace` enrichment; `mix xref`, tree-sitter-elixir and editor tooling rejected as baselines | binding in Elixir exists only after macro expansion, which needs every dependency present — a Phoenix corpus with no `deps/` fails at its first `use`; the parser needs nothing, so the noClasspath contract is met by construction and the tracer adds `generated` facts where a project still compiles |
| Elixir host and distribution (M15) | written in Elixir; an escript (Erlang on the machine, Elixir embedded) and a Burrito binary per OS (nothing on the machine); no runtime dependency (Elixir ≥ 1.18 `JSON`) | the quoted AST is the reference form and is reachable only from the BEAM; the escript is the jar and Burrito the native image, so `test.sh` and the M14 registry keep their shapes |
| Elixir module identity (M15) | the module is the file (the TypeScript rule); a `defmodule` is a `module` kind carrying `TType`, child of its file, nesting an alias not a containment; a module atom's dots are percent-encoded inside the symbol | Elixir has no namespace to contain a module but the file (invariant 5); the module IS the type (struct, behaviour, protocol), so one building per `defmodule` is the honest city; the capitalization rule that would make raw dots injective fails for `defmodule :"a.b"` |
| Elixir function identity (M15) | arity is the disambiguator, always present; `f(a, b \\ 1)` is one entity `f#2` covering `f/1`; n clauses are one entity spanning first to last; `defimpl` is the named module the compiler defines, `attachedTo` the type | `f/1` and `f/2` are distinct functions in the language; a default-generated arity and a clause are not declarations of their own (the TypeScript overload fold); the BEAM names the impl module, the model only adds the relation the name implies |
| Elixir external keys (M15) | three reserved modules — `<otp>` from the embedded table, `<deps>` for a module nothing declares, `<unresolved>` for a target an edge must name and cannot; a local that binds nowhere is dropped and counted, never an entity; `--deps` parses dependency sources for exports only and changes counts, never keys | keys must not depend on what is checked out beside the corpus (the TypeScript rule); a `deps/` tree is not corpus; Erlang and Elixir modules share one VM and one reserved module |
| Elixir dynamic dispatch (M15) | protocol calls and `GenServer.call(__MODULE__, …)`-style self-calls are `dynamic-candidate` invocations written by the extractor with the corpus impls / handler clauses as candidates; every other dynamic form (`apply/3`, `mod.f()`, a pid) is dropped and counted | the Go interface-call and Clojure multimethod precedent: the extractor holds the whole corpus and the candidate set is a language fact, unlike Spring DI whose set needs a framework table (M10d); a guess beyond that would be an invented edge |
| Language-defined expansions (M15) | `use X` is an `import` plus a `declared` invocation of `X.__using__/1`; `@derive P` is a `generated` `interfaceImplementation`; what a `use`d macro injects is absent from the baseline and counted as `local-unbound` | both expansions are defined by the language, not by a library, so stating them invents nothing; a router's routes or a schema's fields exist only after expansion, and the Clojure profile's rule (`generated` where known, absent otherwise) applies verbatim |
| Stub members (M15b) | a stub has no members: a call into an external module is an `invocation` of the stub `module`; a field of an external struct is no entity | `isStub` is a key of TType and TModule only (`isStubEntity`), so a stub *function* would be a full function without an anchor — unrepresentable; the C# fold was already the rule for members of a BCL type |
| Kernel is the language (M15b) | a local that binds to Kernel / Kernel.SpecialForms, and a remote `Kernel.f` (a string interpolation's `to_string/1`), is resolved and never an edge, counted as `kernel` | `length/1`, `+/2`, `case` are the language: an edge to `<otp>/Kernel` from every function would be noise that hides real fan-out |
| Injected locals (M15b) | a local that binds nowhere in a module that `use`s a foreign module is `local_injected`, and the sole-foreign-import attribution is refused there; a static `GenServer.call(Server, …)` on any corpus module dispatches to its handler | the Ecto schema case: `field :sku, :string` under `use Ecto.Schema` beside `import Ecto.Changeset` was attributed to Changeset — a guess; a `use` is the one place the parser knows it cannot see |
| Module bodies (M15b) | a module body is compile-time code: `use`, `plug`, `schema … do … end`, a `for` that defines — its calls are edges FROM the module (`TWithInvocations`/`TWithAccesses` licensed on `module`); a module attribute's value owns its own edges | the TypeScript rule for a file's top level and a class's static block; without the licence the model would state edges its profile forbids, or drop the `use` invocations that make injection visible |
| The trace (M15c) | `mix codegraph.trace` writes JSONL events from a compilation tracer (call kind, site, caller module+function, callee); `--trace` merges them AFTER the parser's pass as `generated` edges through the same closing rules, a call to an undeclared (injected) function counted rather than invented; the task is reachable from a compiled checkout with `ERL_FLAGS=-pa …/ebin`, no `mix.exs` edit | the compiler is the second reader, not the first: keys stay the parser's, the enrichment only closes edges, and a project that does not compile loses nothing it had. `mix compile` prunes the code path, so the tracer must be loaded before compiling |
| Kernel special forms (M15c) | matched by name alone; binary specifiers after `::` are syntax | `for`/`try`/`with`/`case` are variadic — 32 118 "unbound" locals on the standard library were `assert`, `test`, `for/2` and `size/1` in binaries |
| Injection source (M15c) | any `use` — corpus or foreign — makes the module's unbound locals `local_injected`, and refuses the sole-import attribution | a corpus macro's `__using__` is as opaque to the parser as a dependency's: the standard library's own tests `use ExUnit.Case` |
| Native binary entry (M15c) | the Burrito release runs the CLI from `Application.start/2` on `:init.get_plain_arguments/0` when `__BURRITO_BIN_PATH` is set, and halts; Burrito itself is a build-only dependency; the escript never starts the application (`app: nil`) | Burrito boots through `elixir start_cli`, which would parse `--src` as Elixir's own options; halting from the application's start pre-empts it without a runtime dependency on Burrito |
| Elixir oracles (M15) | on a corpus that compiles, `mix xref graph` must equal the baseline's module-level import layer and the `--trace` edge set must be a superset of the baseline's; both as opt-in real-corpus tests | the cross-validation rule ("the richer extractor is the oracle, any gap is a missed case") gets two oracles the language ships for free — the first extractor whose ceiling is measured rather than estimated |
| Insights storage (M16) | a store of its own, `<model>.insights.db`, beside the model — never a table in `model.db` | `model.db` is disposable by construction (a version bump or a changed mtime deletes it) and that rule keeps the cache honest; insights are bought, not derived, so the first regeneration would silently discard paid work — two lifecycles cannot share a file |
| Insights store lifecycle (M16) | migrated, never regenerated: a ladder on `PRAGMA user_version`; a newer file is refused and left untouched; no fallback when SQLite is absent | the exact inverse of the M7 rule, for the inverse reason: nothing the file holds can be recomputed from the model; a silent JSONL fallback would be a second authoritative copy, which is how paid work gets lost |
| The side-car after M16 | `<model>.insights.jsonl` keeps its format and byte-determinism as the store's export, written once per run; imported on first contact; an edit made outside is warned about (size + mtime against the recorded export) and taken only by `--import`; the round trip is a tested bijection, the `run` ledger the only losable state | the Specy skill, the fixtures and `git diff` are built on that file; a binary db is none of committable, diffable or portable |
| Insight blocks in the store (M16) | one JSON text column holding the Zod-normalized bytes; the envelope (id, level, fingerprint, natural key, usage) as columns; `concept`/`confidence` as generated columns | the block's shape moves with `PROMPT_VERSION`, so tables per field would make every prompt change a migration; storing the normalized text makes the export a concatenation; blocks are fetched, not aggregated — the opposite of M10b's measures, hence the opposite storage |
| Run durability (M16) | one transaction per finished UNIT (a cycle's members in together, its failure row out), failures written when they happen, WAL; ONE writer, decided by the recorded pid's liveness — alive is refused, dead is resumed; the journal writer deleted, its reader kept for first contact | the journal carried records only, so a killed run forgot its failures; a second concurrent `explain` interleaved one journal silently; a run that commits per unit holds no lock across itself, so `SQLITE_BUSY` could never be the refusal |
| Insights store physical shape (M16a) | rowid tables; order decided in JS, never by `ORDER BY id`; a failure's `reason` as JSON text; a column string holding U+0000 refused at write; `application_id` beside `user_version` | each one measured or found by a test: `WITHOUT ROWID` cost 96 MB against 57 MB on Broadleaf; SQLite orders TEXT by UTF-8 bytes and the side-car by UTF-16 units; Node's binding reads TEXT only up to its first U+0000 (the round-trip property's second case) — an id read back shorter is worse than a refusal; a `model.db` handed over by mistake must not be migrated |
