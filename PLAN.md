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
Node, which today is nobody who can run the rest of the pipeline.

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

## 15. Milestones

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

## 16. Decisions made in this plan (deltas vs. the design doc)

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
