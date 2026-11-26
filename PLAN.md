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
(PHP, Ruby), `fileInclude` (PHP). Discriminated union on `edge` field.

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
3. **SCIP adapter** (one effort → Rust via an existing indexer; TypeScript
   and Python have extractors of their own, §14 and §23, for which the SCIP
   indexers are oracles).
4. **Code city visualization** (`packages/viz`, Three.js + Vite): render the
   analyzed model as a 3D city — districts = modules, buildings = types
   (height/footprint/color mapped to documented metrics), edges as flows.
   Consumes analyzer output only; visual-language rules live in `CLAUDE.md`.
5. **Elixir** via the compiler's parser as a library plus a lexical resolver,
   compilation tracers as the optional enrichment — planned in full as
   Phase 13 (§16, M15): the first macro-first, dynamically dispatched
   language, `generated` and `dynamic-candidate` provenance exercised for real.
6. **Ruby** via Prism as a library plus a lexical constant resolver, written
   in Rust so no Ruby is needed to build or run it — planned in full as
   Phase 16 (§19, M18): open classes, mixins, and an import layer the source
   does not write.
7. **Python** via Ruff's parser as a library plus a scope-and-import
   resolver and a table distilled from typeshed, written in Rust so no Python
   is needed to build or run it — planned in full as Phase 20 (§23, M22):
   names bound statically and attributes not at all, annotations as a
   `derived` tier, and Python 2 read from the recovered tree.

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

Locked decisions, each with its reason (the delta table in §26 repeats them):

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
    measures.ex                        sloc (blank and comment-only lines out, comments as the parser reports them) + cyclomatic
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
  1.18), `Code` and `Macro` are the whole front end.
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
| JSON bytes must match core's `JSON.stringify` | escaping (`
`, control characters, `/` unescaped), key order, integers vs floats in `metrics` | the two-encoder gate in core; a `JsonWriterTest` with the characters JS and Elixir disagree on by default; `JSON.encode_to_iodata!` with an explicit string encoder where the defaults differ |
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

Locked decisions, each with its reason (the delta table in §26 repeats them):

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
- **M16c — the first reader.** ✅ (2026-09-21) Two readers, one rule each.

  *The store as a reader sees it.* `sqliteInsightsStore(db, { readOnly: true })`
  migrates nothing and lets SQLite refuse every write (`PRAGMA query_only`); a
  store not already at this build's version is refused, not brought to it. It
  is handed an ORDINARY connection, not a read-only file handle: the first
  attempt was the latter, and it stranded `-wal`/`-shm` beside the model — a
  read-only handle on a WAL database may not clean up after itself. The port
  gains what a reader asks and none of it reads a block: `query()` (level,
  concept, confidence range, ids, limit → ROWS: envelope + description + the
  same `conceptLabel` a prompt quotes), `stats()` (by level / origin / type
  concept, what is owed, and the records' OWN usage — which survives an import
  where the run ledger does not), `runs()` (the ledger), and `answerInsight()`
  — explained / failed / unknown — the one rule both readers below answer by.

  *`codegraph insights [model.jsonl]`.* One question per invocation: the
  summary (no flag), a tab-separated list (`--level`, `--concept`,
  `--min/--max-confidence`, `--limit`), one explanation whole (`--id`; an id
  that FAILED is answered with why, exit 3), `--failures`, `--runs`; `--json`
  is one kind-tagged document each. It opens the store and nothing else — the
  model path only says WHICH store (`--store FILE` otherwise), and it does not
  import `explain.ts`, whose module graph is the provider SDK. On Broadleaf:
  0.14–0.18 s and ~81 MB (Node's floor) for any question over 28 206 records,
  the store's hash unchanged and no file beside it.

  *The Navigate panel.* `codegraph serve` gains its ONE route that is not an
  artifact — `/insight.json?id=…`, a lookup (`ArtifactServerOptions.lookups`)
  over a reader opened on first request, so a store `explain` creates while
  the page is open is found; `--insights FILE` names it, the default is beside
  the first model. No store, a foreign one, an id nobody explained: 404, and
  the page shows nothing. `navigator-ui` restates the answer's kind as a
  literal pinned by a test and imports `@codegraph/insights` not even for
  types (a second boundary test); the loader asks once per id and stops asking
  a server that answers the route with HTML (the app daemon, a static host,
  Vite). The block renders GENERICALLY (`blockFacts`): its shape moves with
  the prompt version, and a panel naming fields would lag every change.
  **An inference never looks like a fact:** the block wears the page's
  `--inference` colour and a badge in the family of `DERIVED` /
  `DYNAMIC-CANDIDATE`, names the model and its claimed confidence, and says
  `templated` when no model was involved. Reviewed as screenshots on Broadleaf
  (`ProductImpl`, the `catalog.domain` package), which is where the opened
  fact list earned its `max-height`: a JPA entity lists thirty fields.

  Left out, deliberately: **operations.** A navigator member node carries no
  entity id (the artifact would double — NV), and ids are never constructed
  (invariant 7), so the panel explains types and modules; `codegraph insights
  --id` reaches an operation's record. And the desktop daemon serves no
  insights yet (§17.4).

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

## 18. Phase 15 — Measures from big-code-analysis: one pass for every extractor (M17)

Motivation: M10b gave the model two measures, `sloc` and `cyclomatic`, each
written by its extractor on its own compiler's syntax — four implementations
of two numbers. [big-code-analysis](https://github.com/dekobon/big-code-analysis)
(bca: a hard fork of Mozilla's rust-code-analysis, MPL-2.0, published on
crates.io) computes the whole suite — cognitive complexity, Halstead, the
maintainability index, ABC, exits, the LOC variants, public methods and
attributes — over tree-sitter for twenty-odd languages, plus change-history
metrics over git (churn, ownership dilution, fix history, an ordinal risk
score, per-function blame). It is a Rust library first; its CLI is a front end.
The question was where it lives.

**Decision: one Rust binary, `codegraph-metrics` (`extractors/metrics/`), that
links bca as a library and runs as a PASS over a model an extractor already
wrote.** It parses every source file the measured entities are anchored in,
joins bca's function and class spaces to those entities on their anchors, and
rewrites their `metrics` maps — no other byte of the file moves. Rejected:

- **bca inside each extractor** (JNI in a GraalVM image, P/Invoke and a
  cdylib per RID for .NET, napi for Node, a NIF in an escript): four bridges,
  four build systems learning Rust, and the join written four times. Nothing
  the join needs lives in Spoon or Roslyn — only `(file, start, end)`, and
  every entity already carries it (invariant 3). The Elixir `--trace` merge
  (§16) is the precedent: a second producer's facts landing on entities the
  model already names.
- **bca's own CLI**: a foreign wire format to translate, all 23 grammars
  shipped, and no hold on what this contract cares about — number spelling,
  key names, the reference time of history metrics.

Five principles, locked up front:

1. **The extractor's keys are the extractor's.** `sloc` and `cyclomatic` are
   compiler-based and hand-counted in every fixture; the pass never touches
   them. It owns a closed key list (`join::KEYS`) and on every run replaces
   exactly those — so a re-run over its own output is the identity, and a
   key an extractor starts emitting must leave that list first.
2. **Only an entity that IS one space gets span measures.** Two families
   (METAMODEL §3.8): *charged* keys (`cognitive`, `nexits`, `abc.*`) add up
   over several spaces; *span* keys (`lloc`, `cloc`, `halstead.*`, `mi`,
   `npm`, `npa`) are computed over one text and are not additive, so an
   entity joined to several spaces (an Elixir function's clauses) has none.
3. **A space the model does not name is charged to the entity around it**
   (the FOLD) — the rule every extractor's `cyclomatic` already follows: a
   lambda the model names is its own invocable, a closure it does not name
   belongs to its enclosing one. `sum:cognitive` over a building then counts
   every piece of code once.
4. **Bytes as core writes them.** A new value is rounded to four decimals
   (libm's `ln`/`log2` may differ in the last ulp between platforms) and
   spelled as JavaScript's `Number::toString` spells it (`3`, `1e+21`,
   `1e-7`); the `metrics` map is re-sorted by UTF-16 code unit; an unchanged
   line is copied, never re-encoded. Two runs over one corpus write the same
   bytes on every OS (contract §6).
5. **The join reports itself.** Every run prints how many measured entities
   joined, and how; `--audit` lists every entity not joined exactly. The
   WITNESS: on an exact join, bca's `ploc` (lines holding code) and the
   extractor's `sloc` share a definition — they must agree, and a
   disagreement names a join or a parser gone wrong.

### 18.1 The join (M17a), measured

The model and bca disagree on granularity in both directions — a C# property
with accessors is one entity over two spaces, an Elixir function one entity
over one space per clause, a callback nobody names a space with no entity —
and on where a declaration starts. Three matches, tried in order, then the
fold (`extractors/metrics/src/join.rs`):

- **EXACT** — same line span. Natural pairs first, per category (an invocable
  and a function space, a type and a class space, a `TModule` and the file),
  outermost to outermost when their numbers agree; then what is left, by
  depth alone (a one-line C# property and the lambda in it). More entities
  than spaces leaves the innermost unjoined — a Java class and the implicit
  constructor Spoon anchors on it; more spaces than entities joins none,
  unless the one entity sits over sibling spaces (`{ get; set; }`: CONTAINED).
- **LEADING** — the same last line, first lines apart by nothing but
  annotations, attributes, decorators, comments and blanks, brackets balanced
  (`@RequestMapping(value = …,\n method = …)` spans lines). Both ways: Spoon
  starts a method after its annotations and tree-sitter at them; the
  TypeScript compiler starts an exported class at its decorator and
  tree-sitter after it.
- **CONTAINED** — an entity no space spans takes the outermost unjoined
  compatible spaces inside its span; never an entity anchored exactly on its
  parent (an implicit constructor has no extent of its own).

Measured with the release binary (11.0 MB, four grammars):

| corpus | measured | joined | exact · leading · contained | not joined, and why | witness `sloc = ploc` | run |
|---|---|---|---|---|---|---|
| `fixtures/java` | 87 | 70 | 61 · 9 · 0 | 17: 11 implicit constructors, 5 lambdas, 1 annotation element | 61 / 61 | |
| `fixtures/csharp` | 117 | 101 | 99 · 0 · 2 | 16: implicit constructors (anchored on the type's name), record positional members, a property inside a C# 14 extension block | 99 / 99 | |
| `fixtures/typescript` | 105 | 89 | 87 · 2 · 0 | 16: namespaces, enums, type aliases, signatures, ambient declarations — no space in bca | 87 / 87 | |
| `fixtures/elixir` | 103 | 96 | 91 · 0 · 5 | 7: `defprotocol`/`defimpl` bodies, `defguard`, `defdelegate` | 90 / 91 — `broken.ex`, unparseable by design (the extractor says 0, tree-sitter recovers 6) | |
| BroadleafCommerce (Java) | 28 596 | 26 209 (91.7 %) | 16 395 · 9 814 · 0 | 2 387: 2 102 implicit constructors — 98.9 % of what has text of its own joins — 46 lambdas, annotation elements, one modifier line | 16 395 / 16 395 | 2 983 files, 0.82 s, 70 MB |
| codegraph, self-hosted (TypeScript) | 8 125 | 7 887 (97.1 %) | 7 887 · 0 · 0 | 238: 121 interface signatures, 110 type aliases, 7 declarations | 7 872 / 7 887 — the 15 are `.tsx`: the extractor counts every line a JSX text token spans, bca one or two fewer | 396 files, 0.27 s, 34 MB |

Zero ambiguous joins anywhere. What stays unmeasured is what big-code-analysis
opens no space for, by its own choice ("Java keeps lambdas out": a Java
lambda's complexity is charged to its method) or its grammar's
(tree-sitter-c-sharp 0.23.5 misparses C# 14 `extension(…)` blocks) — absent,
never zero, and listed by `--audit`.

### 18.2 Change history (M17b) — a side-car, not the model

**Decided 2026-10-02, against this section's first draft**: history measures
do NOT enter `model.jsonl`. The first draft put per-file history on `f`
records and per-function `vcs.*` keys in entity `metrics`; that reverses §11's
principle 1 (evolution facts are a third artifact), and its reason holds here
too — a window counts back from the commit's time, so two snapshots a week
apart would differ on entities whose code did not move, and every
`snapshots`/replay diff would carry that noise. So `codegraph-metrics
--history` writes a side-car beside the model, `<model>.history-metrics.jsonl`,
and the CLI joins the two in memory. No core change; `model.jsonl` keeps code
measures only.

- **What it measures** (bca's `vcs` feature, pure-Rust `gix`, no libgit2):
  per FILE from one walk — commits, churn (added + deleted), authors over a
  long (365 d) and a recent (90 d) window, ownership, burst, fix / security /
  revert counts, age, change and co-change entropy, an ordinal risk score;
  per ENTITY from one blame per file — the same signals over its SURVIVING
  lines (the line's last commit), whose line count is named `lines_*`, never
  `churn_*`: the two are different quantities and never share a key. Who and
  why live in `@codegraph/scm`'s `HISTORY_MEASURES`, pinned equal to the
  Rust lists by a test.
- **At which commit**: the model's `repository.commit`, else HEAD, `--ref`
  overriding both; the clock is that commit's committer time, never the wall
  clock — so two runs over one repository write the same bytes (§6), and a
  `snapshots` frame can be measured at its own commit. Blame reads files at
  the commit and anchors come from the files the extractor read: a file whose
  bytes differ from the commit keeps its file record and loses its entities,
  counted on stderr.
- **The whole commit graph, merges excluded**: bca walks first-parent by
  default, which hides every commit a merge brought in — 65 % of
  BroadleafCommerce's (6 657 of 18 776 are first-parent) — from the file
  level while blame still credits them. Found by the fixture, pinned by the
  synthetic-repository test (a branch commit must count).
- **Identity**: an entity record carries its natural key `{lang, module,
  symbol, disambiguator?}` — never a rendered id; the CLI renders it with
  core's `renderId` to join (invariant 7: ids are rendered, never parsed). A
  file record carries the model's own path (relative to its root).
- **The format** (`@codegraph/scm`, `history-metrics.ts`): `header` (kind
  `codegraph.history-metrics/1`, producer and bca versions, `lang`, `root`,
  `commit`, `asOf`, window days) → `f` per file by path → `e` per entity in
  canonical key order → `eof` with counts. Strictly ascending order is the
  uniqueness check; the decoder refuses a missing trailer, wrong counts,
  disorder, a non-number; `encode(decode(x)) = x` on what Rust wrote.
- **The join** (`packages/cli/src/history-metrics.ts`): `city` and `serve`
  read `<model>.history-metrics.jsonl` beside each model (or
  `--history-metrics FILE`) and offer two metric forms to every channel and
  `--carry`: `history:<measure>` (the building's own type, its blame) and
  `history-file:<measure>` (the file the type is written in). Through the
  city's custom `MetricSource` hook: `@codegraph/city` itself is unchanged.
  Asking for one with no side-car, or at a level the measure lacks, is a
  usage error that says how to get it.
- `@codegraph/scm`'s `history.jsonl` (the time axis: replay, hidden coupling)
  stays as it is; these are measures AT one commit.

### 18.3 Where it runs, how it ships (M17c)

- **A pass is a registry entry** (`role: "pass"`, in the catalogue, the
  discovery crate's `RegistryEntry` and `registry.ts` alike): it claims no
  files, `detect` never answers it — not even when a user names it — and it
  runs under its own one-line contract, `<pass> <model.jsonl> --src <dir>`,
  rewriting the model in place. The catalogue gained one row; the shell counts
  extractors apart from it ("4 of 4 extractors installed, measures on"); the
  daemon's `/app` lists `passes` beside `extractors`, so the page never
  offers a pass as an extractor.
- **The app's job** runs every pass after a fresh extraction, and again over
  a reused model when the installed passes (`name@path`, recorded as the
  project's `measuredBy`) are not the ones that measured it — a page rebuilt
  in either case. Never over a model the user opened directly: that file is
  theirs. A missing pass is a progress line with its install command, a
  failing one a line with its exit status; the job completes either way and
  the page is built from whatever model there is (the pass writes through a
  temporary file, so a failure leaves the extractor's model intact).
- **Not `snapshots`**, decided on reading the temporal store: its measures
  live in the flat tables `import --at` replaces on every revision, so a pass
  per frame would compute numbers the store throws away. Measures over time
  are a replay feature of their own (§18.5).
- **Homebrew**: one formula, `codegraph-metrics` (four Unix platforms, a test
  over a header-and-trailer model); every extractor formula, the npm-based
  TypeScript one included, `depends_on "defsquare/tap/codegraph-metrics"` —
  installing any extractor installs the pass once (four formulae carrying the
  same binary would conflict). `render.mjs` generates it with the rest.
- **CI**: `metrics` (`./test.sh --metrics`) and `metrics-native`, built
  NATIVELY on the four Unix runners the Java image uses — the tree-sitter
  grammars are C, and a native build needs no cross C toolchain; each binary
  re-measures the four fixtures and must `cmp` equal to the committed
  snapshots, the cross-OS proof of principle 4. No Windows build: no tap
  serves it, and nothing would test it. `release` attaches
  `codegraph-metrics-<rid>` through the extractors' copy loop.
- **The notice**: `codegraph-metrics --licenses` prints
  `THIRD-PARTY-LICENSES.txt` (generated by `scripts/licenses.mjs` from `cargo
  metadata` and the crates' own license files, identical texts once: 189
  crates, 107 texts, 363 KB), which points to the source of the two MPL-2.0
  crates (big-code-analysis, uluru) — MPL's one obligation beyond
  attribution. A test fails while a locked crate is missing from it.
- **The C# and Elixir audits** (code metrics; shallow clones):

  | corpus | measured | joined | exact · leading · contained | not joined, and why | witness | run |
  |---|---|---|---|---|---|---|
  | Humanizer (C#), `src/` | 5 736 | 4 817 (84.0 %) | 4 764 · 8 · 45 | 919: 419 implicit constructors (anchored on the type's name), 311 record positional members, 183 on their parent's anchor — none has a body | 4 727 / 4 764: the rest are files with `#if` blocks — tree-sitter measures every branch, Roslyn's `sloc` the active one (C# profile note) | 245 files, 0.22 s |
  | Phoenix (Elixir), `lib/` | 1 247 | 1 227 (98.4 %) | 981 · 0 · 246 (multi-clause functions) | 20: `defdelegate`s, `defimpl`/`defprotocol` bodies | 770 / 981 before the fix below, 769 after — see below | 75 files, 0.06 s |

  **The witness's first real catch**: the Elixir extractor's `sloc` counts
  the line each TOKEN STARTS on (`Measures.token_lines`), so a heredoc — one
  token over many lines — counts once; Phoenix's `@doc` heredocs and
  templates put it below METAMODEL §3.8's "neither blank nor comment-only"
  (`mix_app_path`: 19 such lines, `sloc` 9, big-code-analysis 13). Java's
  lexer and the TypeScript extractor count every line a string spans.
  **Fixed** (2026-10-03, test first): `Measures.code_lines` takes the
  definition literally — every line that is not blank and not comment-only,
  a comment being what `Code.string_to_quoted_with_comments` reports, so a
  `#` inside a heredoc is text. `mix_app_path` now says 19, the hand count.
  The fixture corpus holds no multi-line literal inside a span — which is why
  its snapshot never showed the bug and does not move now; a unit test pins
  heredoc, sigil and multi-line string. The Phoenix witness still disagrees
  (769 / 981), from the other side: big-code-analysis's Elixir `ploc` leaves
  a heredoc's text out (13 for `mix_app_path`), where its TypeScript `ploc`
  counts a template literal's — an oracle wrong there, noted in the Elixir
  profile.

### 18.4 Milestone split

**M17a — the pass, code metrics** (this worktree)

- [x] `extractors/metrics/`: a standalone Cargo crate (edition 2024),
      `big-code-analysis = "=2.2.0"` with four grammars — an exact pin, since
      every key's value is that version's definition. `codegraph-metrics
      <model> [--src DIR] [--out FILE] [--jobs N] [--audit]`; `--src`
      defaults to the header's `root`, `--out` to the model itself (written
      through a sibling temp file, renamed on success); exit codes 0/1/2.
- [x] Two passes over the file: an inventory (header, file table, every
      `TMetrics` entity with an anchor, its depth and whether it sits on its
      parent's anchor), then one parse per file on N threads, then a
      byte-preserving rewrite of the `metrics` values that changed.
- [x] The join and the fold (§18.1), pinned by unit tests on small sources in
      all four languages: annotation and decorator offsets, Elixir clauses,
      C# accessors and one-line nesting, the fold compared with and without
      the nested entity named.
- [x] Keys and families in METAMODEL §3.8; `mi` absent when bca has no
      Halstead volume (it answers 0, which would be a fake zero).
- [x] Snapshots `fixtures/<lang>/expected/model.metrics.jsonl`: the Rust gate
      reproduces them byte for byte and a second run over its own output
      changes nothing (`CODEGRAPH_UPDATE_SNAPSHOTS=1` rewrites them); the core
      gate (`fixtures-metrics.test.ts`) re-encodes each to the same bytes
      (the two-encoder test), validates it against its profile, proves nothing
      but measures moved and every extractor key kept its value, holds values
      finite, non-negative, counts whole, `mi ≤ 100`, pins the key list equal
      to `join.rs` and to METAMODEL, and asserts hand counts (`max` = 4 in
      Java, C# and TypeScript alike).
- [x] Measured on the fixtures, BroadleafCommerce and codegraph itself
      (§18.1); every enriched model `validate`-clean.
- [x] `build.sh --metrics` (`cargo build --release --locked`; the lockfile
      committed), `test.sh --metrics` (`cargo test`), `ensure_cargo` checking
      the crate's `rust-version`, `bin/codegraph-metrics`, `docs/metrics.md`,
      CLAUDE.md, and one note per profile naming what the pass leaves
      unmeasured in that language and why.
- [x] Seen in the city: `codegraph city` over the enriched Broadleaf model
      with `--height sum:cognitive --footprint attribute:lloc` — every
      internal building measured (the 1 231 unmeasured are all stubs), the
      tallest `FormBuilderServiceImpl` at 701.

**M17b — change history, as a side-car** (§18.2)

- [x] `codegraph-metrics --history [--history-out FILE] [--ref REV]`: bca's
      `vcs` feature plus `gix` 0.87 (the one bca links) for the reference
      commit, its time and its blobs; one history walk over the full graph,
      one blame per file on N threads with a session each; the side-car
      written atomically. The inventory gained each entity's natural key and
      the header's `repository.commit`; nothing in `model.jsonl` changes.
- [x] `@codegraph/scm`: the side-car's schema, strict decoder and canonical
      encoder, `HISTORY_MEASURES` (unit, meaning, level) pinned equal to the
      Rust lists; a property test (`encode ∘ decode` is the identity on any
      encoded side-car) and the refusals (truncated, wrong counts, disorder,
      a non-number, no header).
- [x] The CLI join (`history-metrics.ts`): `history:`/`history-file:` on
      every channel and `--carry` of `city` and `serve`, `--history-metrics
      FILE`, usage errors that say what to run.
- [x] A repository built by the Rust test, commit by commit, with pinned
      authors and dates (no history needed from the checkout — CI clones
      shallow): every file and blame number hand-countable, the branch commit
      counted through a merge, `--ref` pinned to an earlier commit, an edited
      file losing its entities and keeping its file record. Its side-car is
      committed (`fixtures/history-metrics/`) beside its validate-clean model,
      and is what the scm codec and the CLI join are tested against.
- [x] BroadleafCommerce at `5036306` (18 776 commits): 2 983 file and
      26 494 entity records — every entity with text of its own — in 35 s and
      670 MB (the code metrics alone: 0.8 s); a second run byte-identical; the
      TypeScript decoder accepted all 26 494 keys in the order Rust wrote
      them; a city with `--height history-file:churn_long --footprint
      history:commits_long` measured all 3 312 internal buildings (190 types
      changed in the year to the commit, 64 non-merge commits in it).

**M17c — wired in and shipped** (§18.3)

- [x] `role: "pass"` across the catalogue (one row), the discovery crate
      (`is_extractor`, tested with the shipped catalogue) and `registry.ts`
      (parse, `detect` excluding passes, `/app`'s `passes`); the shell's count.
- [x] The daemon's job: passes after a fresh extraction or when `measuredBy`
      changed, never over a user's own file; missing and failing passes
      tested with `fake-pass.mjs` (install line, exit line, extractor's model
      kept, job done), a re-run of an unchanged tree not measuring again, a
      named pass refused as the extractor.
- [x] The tap: `Formula/codegraph-metrics.rb` and the dependency of every
      extractor formula, pinned by `render.test.mjs`.
- [x] CI: `metrics` and `metrics-native` (four runners, four `cmp`s each),
      the release's copy loop; the smoke loop run locally.
- [x] `--licenses` and its generated notice, held complete by a test.
- [x] Audits on Humanizer and Phoenix; the Elixir `sloc` finding recorded
      (§18.5), the C# `#if` difference in the C# profile note.
- [ ] Prove the CI jobs and the tap on the next tagged release (nothing here
      can run a GitHub runner or `brew install`; the Tauri crate does not
      compile without WebKit).

### 18.5 Deferred, explicitly

- **Java lambdas** — bca opens no space for them by design; a change belongs
  upstream (`JavaCode::is_func_space`), not in a fork.
- **C# 14 extension blocks** — wait for a tree-sitter-c-sharp that parses
  them; bca pins its grammars.
- **The modifier-line gap** — `public @ResponseBody` alone on a line, Spoon
  starting the method on the next: one method of 239 unjoined on Broadleaf.
  Recognizing it means a modifier list per language, for a single case.
- **Entities that do not declare `TMetrics`** — adding the trait means
  inserting into the header's sorted trait dictionary and renumbering every
  `tr`; the pass measures what the profile already licensed.
- **More languages** — bca parses twenty-odd; a future extractor's entities
  are measured by adding one line to `join::language`.
- **big-code-analysis 2.2.1** (unpublished today) — a bump is a reviewed
  snapshot diff, never a silent `cargo update`.
- **Blank lines inside a multi-line literal**: the Elixir and Java `sloc`
  leave them out (they are blank), the TypeScript extractor counts every line
  a template literal spans. A one-line difference per blank line in a
  template; aligning it changes the TypeScript snapshot and waits for a reason.
- **Measures over time**: the temporal store keeps no per-revision measures
  (they sit in the flat tables `import --at` rewrites), so `snapshots` does
  not run the pass; a replay of `sum:cognitive` would start there.
- **`--history` from the app** — 35 s on Broadleaf is a setting's decision,
  not a default; the side-car would then sit beside the app's model and
  `serve` already reads it.
- **A Windows binary** of the pass — when something ships or tests it.

---

## 19. Phase 16 — Ruby extractor (Prism as a library, no Ruby on the machine) (M18)

Motivation: the fifth real extractor is the first for a language where **the
receiver of most calls has no static type and a class is never finished** —
any file may reopen any class, the VM's included. Elixir (§16) was dynamic by
dispatch; Ruby is dynamic by *declaration*: `define_method`, `method_missing`,
`has_many`, a mixin applied inside an `included do` block. Its legacy is of the
non-bootable kind: a Rails 3 application whose `Gemfile.lock` no longer
resolves cannot be loaded, and loading is the only way Ruby itself learns what
a class is. And Ruby brings the pipeline one thing no language so far has: an
import layer the source **does not write**. A Zeitwerk application contains no
`require`; the constant reference is the load.

**What is the Spoon / Roslyn / tsc of Ruby?** A parser, and nothing more — the
language has no compiler front end that binds names before running them.

| Roslyn / `ts` | Ruby | Role |
|---|---|---|
| `SyntaxTree` | **Prism** (`ruby/prism`, CRuby's default parser since 3.4): a C library with a typed tree, byte offsets, error recovery, and the encoding magic comments honoured | syntax with positions, for every Ruby from 1.8-era files to today's |
| `SemanticModel` / `TypeChecker` | **none before the program runs.** A constant is found by `Module.nesting` and the ancestor chain at run time; a method by `respond_to?` | binding is the VM's; what is statically honest is the LEXICAL part of constant lookup |
| the BCL ref pack / `lib.*.d.ts` / the OTP table | a table of the constants **the VM defines before any file runs**, distilled from RBS `core/` signatures at a pinned release and embedded | what `StandardError`, `Comparable`, `String` are on a machine with nothing installed |
| `IErrorTypeSymbol` | a constant neither the corpus declares nor the VM defines | a library, whichever one — stubbed, never guessed |

So the baseline is a **lexical resolver over Prism's tree** against a whitelist
of what the corpus writes. It is noClasspath by construction and goes one
further than every extractor before it: a file with syntax errors still
extracts, from the tree Prism recovered.

The alternatives, and why they are not the baseline:

| Candidate | What it is | Verdict |
|---|---|---|
| **Booting the application and introspecting** (`ObjectSpace`, `Module#ancestors`, `Method#source_location`) | the truth, after every `define_method` ran | never the extractor — it runs corpus code, which the pipeline refuses (§5.2), and a legacy application does not boot. It is the `--trace` enrichment of M18c, produced by the user inside a project that still runs |
| **Sorbet / Steep / TypeProf** | type checkers | enrichments, not a baseline: they need signatures the corpus rarely has (`sig`, RBS) and a resolvable bundle. A typed receiver from a `sig` is M18c material |
| **ruby-lsp's index, Packwerk's constant resolver** | editor- and boundary-oriented constant resolution | Packwerk becomes an **oracle** (§19.6): on a Zeitwerk application its reference list is what the baseline's constant resolution must reproduce |
| **tree-sitter-ruby** | a parser with a CST | rejected — a second implementation of Ruby's grammar (heredocs, command calls, `%w`) with no encoding handling, where the language's own parser is a library call away |

Four principles, locked up front:

1. **The parser without the VM — and without Ruby.** The extractor never
   loads a corpus file, never reads a bundle, and is **written in Rust on
   Prism's official bindings** (`ruby-prism`). This breaks the habit of §13–§16
   (an extractor written in the language it reads) for three reasons, each
   measured rather than preferred: a Ruby program parses with whichever Prism
   the machine's Ruby bundles, so the same corpus would give different models
   on two machines, while a binary pins exactly one (principle 3); Ruby has no
   dependable single-binary packager, where a Rust binary is one file that
   needs nothing; and the repository already builds, tests and ships one Rust
   binary per platform (§18). Nothing about the *model* depends on the choice.
2. **No metamodel intelligence.** It knows the Ruby id scheme, the kind →
   traits table and how to write bytes. The cross-language gate
   (`packages/core/test/fixtures-ruby.test.ts`) is where the two halves meet.
3. **Byte-identity across OS and across install state.** Prism is pinned by
   exact version in `Cargo.toml` and the core table by RBS release in its file
   name; the header names both. External types are keyed by name under
   reserved modules, never by a path into a gem directory, so a model's keys do
   not depend on what is installed beside the corpus.
4. **Every provenance earns its place.** `declared` for what the source writes
   and the lexical rules bind; `derived` for what the extractor infers and
   says so (the Zeitwerk import, a locally typed receiver); `generated` and
   `dynamic-candidate` for what only the run-time trace knows (M18c). Ruby is
   the first profile to use all four.

### 19.1 Toolchain and repository layout

```
extractors/ruby/                       Cargo package `codegraph-ruby`, standalone (its own [workspace])
  Cargo.toml                           ONE dependency: ruby-prism, pinned `=` (Prism's C sources vendored in the crate)
  src/
    cli.rs                             the extractor contract (schemas/README.md §8)
    corpus.rs                          pass 0: walk (ordinal order), read as bytes, the common root
    declarations.rs                    pass 1: what one file WRITES — bodies, defs, constants, mixins, requires, and every
                                       SITE (a constant read, a call and the shape of its receiver, a variable) — off Prism's tree
    resolve.rs                         the whitelist (constant paths, fixed point), the lexical resolver, ancestor chains, method lookup
    core_table.rs                      the embedded table of what the VM defines: constants, superclasses, mixins, methods
    ids.rs                             THE Ruby id scheme (§19.3): keys, escaping
    extraction.rs                      passes 2–4: entities, edges, stubs
    model.rs  writer.rs  json.rs       natural keys, canonical order (UTF-16 code units), the JSONL writer
    stats.rs                           what was dropped and why — the summary
  tests/contract.rs                    the snapshot byte for byte, determinism (CRLF, creation order), the CLI contract
  data/core-rbs-<version>.tsv          the generated core table, committed
  tools/core-table/                    its generator: RBS's own parser (`ruby-rbs`) over `<rbs>/core` — a separate
                                       package, so the extractor never links it
bin/codegraph-ruby                     runs target/release/codegraph-ruby
fixtures/ruby/src/                     the reference corpus: `acme_order`, gem-shaped
fixtures/ruby/expected/model.jsonl     + model.metrics.jsonl: the same model after the metrics pass (§18)
```

- **Building needs libclang; running needs nothing.** `ruby-prism-sys`
  generates its bindings with bindgen at build time. `scripts/lib.sh`
  (`ensure_libclang`, `cargo_ruby`) handles the one trap found on the way: a
  machine with the library and without clang's builtin headers fails on
  `limits.h`, GCC's stand in, and the variable that says so must be the
  TARGET-specific one — the crate sets it itself, shadowing the plain form, and
  a name with dashes is one only `env` can set.
- **No Ruby anywhere in the toolchain**, the table's generator included: RBS
  ships a C parser with Rust bindings, so `tools/core-table` reads
  `core/*.rbs` with RBS's own grammar rather than a second one.
- No JSON schema validator on the Rust side: the core gate parses the snapshot
  with core's reader, which enforces the container contract, and re-encodes it
  byte for byte.

### 19.2 Mapping table (Ruby profile — new, `rb`)

The first M18 commit is `feat(core): ruby profile`, the eleventh, data before
implementation (invariant 8). Its shape follows prior decisions and adds three.

| Decision | Why |
|---|---|
| **the module (`TModule`) is the file** — the TypeScript and Elixir rule | Ruby has no namespace construct apart from its types: a `module` is a mixin, and a `class` nests constants too. A Rails application declares almost everything at the top level, so a namespace-as-module model would be one district. Directories ARE the namespaces under Zeitwerk, so districts by directory coincide with them |
| **one entity per declaring file; a reopening is `attachedTo` its primary declaration** | the TypeScript merging rule (§14.3), plus the relation TypeScript did not need: Ruby reopens across files as a matter of course, and containment ≠ attachment (invariant 5) says exactly "written here, belongs there". The primary is the declaration that writes a superclass, else the first in canonical file order |
| **a wrapper body is not a declaration** (decision confirmed 2026-10-13) | `module Acme; class Order; end; end` and `class Acme::Order; end` are two spellings of one thing and must yield one key. A body with no superclass whose statements are all class/module declarations is lexical scope; without the rule a namespace reopened in fifty files is fifty empty buildings |
| **a constant reference across files is a `derived` import** (decision confirmed 2026-10-13) | a Zeitwerk application writes no `require`, so the import layer — the one layer comparable across languages (invariant 9) — would be empty for every Rails corpus. One edge per (file, target file), at the first site, none where a `require` already says it |
| `include` / `extend` / `prepend` are **`traitUsage`** | the edge kind PHP introduced: a mixin is used, never flattened. `core` owns the vocabulary; Ruby adds no kind |
| no `interfaceImplementation`; `inheritance` on `class` only | Ruby has no interface to declare conformance to, and a module has no superclass |
| no arity in a method's key; `self` as the singleton disambiguator | Ruby has no overloading — a name is one method per type. `def self.call` and `def call` do coexist, and the disambiguator is the keyword the source writes (the TypeScript `#static` rule) |
| blocks and lambdas are not entities | a block contributes to its enclosing method (the Elixir `fn` rule); it also does not change where a `def` or a constant is written |

Kinds (`TComment`, `TMetrics` optional wherever it makes sense):

| kind | required traits | Ruby construct |
|---|---|---|
| `file` | `TNamed, TModule, TWithChildren` | a source file; optional `TWithInvocations`, `TWithAccesses` — a script, a Rakefile, `config/*.rb` run at top level. The reserved stub modules and every external feature are this kind |
| `class` | `TNamed, TType, TWithInheritances, TWithChildren, TChildOf, TSourceAnchor` | `class Foo [< Bar]`; optional `TAttachedTo` (a reopening), `TWithInvocations`/`TWithAccesses` (class macros are calls from the body) |
| `module` | `TNamed, TType, TWithChildren, TChildOf, TSourceAnchor` | `module Foo`; the same options, no inheritance |
| `method` | `TNamed, TInvocable, TWithChildren, TWithParameters, TWithInvocations, TWithAccesses, TChildOf, TSourceAnchor` | `def`, instance or singleton, in a type or at a file's top level |
| `field` | `TNamed, TStructural, TChildOf, TSourceAnchor` | an instance variable, the `attr_*` that exposes it, a `Struct`/`Data` member — ONE entity named `@x`, read and written by `access` (the C# property rule) (M18b) |
| `constant` | `TNamed, TStructural, TChildOf, TSourceAnchor` | `NAME = value` for a value that is not a type (M18b) |
| `parameter` | `TStructural, TChildOf` | optional `TNamed` — `*`, `**`, `&`, `...` and a destructured position have none |

Construct → what the model says (M18a unless marked):

| Ruby construct | model |
|---|---|
| `class A < B` with `B` a constant | `inheritance` A → B, `declared`, anchored at the superclass |
| `class A < Struct.new(:x)`, `< Data.define(:x)` | `inheritance` A → `<ruby>/Struct` (`<ruby>/Data`), **`generated`** — the language says so, the source writes no such class; each member is a `field` (M18b) |
| `X = Struct.new(:a) do … end`, `X = Data.define(:a)`, `X = Class.new(Base) do … end`, `X = Module.new` | a `class` / `module` named `X`, the block its body; `Class.new(Base)` WRITES its superclass, so that `inheritance` is `declared` (M18b) |
| `class A < Class.new(Base)`, `< Migration[7.0]` | dropped and counted `computed-superclass` |
| `include M`, `extend M`, `prepend M` in a type's body; `include M` inside its `class << self` | `traitUsage` type → M, `declared`, one per argument; the edge does not say which was written. `extend self` is no relation |
| what an `included` hook gives the includer, where the idiom is literal: `base.extend(M)` / `base.include(M)` (and `base.send(:extend, M)`) in `def self.included(base)`; in a module that writes `extend ActiveSupport::Concern`, its `ClassMethods` module, `class_methods do … end` (the BODY of that module: an entity anchored on the block) and the mixins written directly in `included do … end` | read, and used for lookup: the includer's class side answers along those modules. NO `traitUsage` is written — the includer writes no `extend` — and a method found that way is an `invocation` with provenance **`derived`** (M18c; the plan's first stated blind spot, which the audit showed too central to leave to the trace: 214 concerns in rails, 67 in Mastodon) |
| a mixin applied any other way (a computed argument, a hook that calls a helper, `Foo.extend(Bar)` from outside) | invisible to the parser; `--trace` adds it as a `generated` `traitUsage` (M18c) |
| `class Admin::Users` — a compact declaration | reads `Admin`: where `Admin` is a type, a `reference` from `Admin::Users` to it (and the `derived` import that follows), since the name must exist for the class to open. A wrapper (`module Admin; class Users`) creates what it opens and reads nothing (M18c) |
| a namespace no file gives a body to, sent a message no bare module answers (`Rails.env` where the corpus only writes `class Rails::Patch`), or inherited from while nothing opens it | a library's: a stub below `<gems>`, not `namespace-only` (M18c) |
| `Child::LIMIT` where `Base` assigns `LIMIT` | the constant of the ancestor that declares it: a qualified constant is looked up in its qualifier and in what that inherits from (M18c) |
| `require_relative "x"` | `import` file → the file that path names, or a stub module keyed by that path when nothing is there |
| `require "acme/order"` | `import` → the corpus file a load root answers with (every directory named `lib`, `spec` or `test`, then the root; the nearest to the requiring file; a tie is dropped and counted) — a fact about the layout, counted on its own — else a stub module keyed by the feature as written below `<gems>` |
| `require File.expand_path("../x", __FILE__)`, `File.join(__dir__, "x")`, `File.dirname(__FILE__) + "/x"`, `"#{__dir__}/x"` | the Ruby 1.8 spellings of `require_relative`: the same `import` (M18b) |
| `load "tasks/x.rake"` | `import`: a file named WITH its extension, searched on the same load roots (M18b) |
| `autoload :X, "acme/x"` | `import`, `declared`: the feature is written, only its loading is deferred (M18b) |
| any other computed argument | dropped and counted `computed-require` |
| a constant resolving to a declaration in another file | the `derived` import above |
| `def x`, `def self.x`, a `def` inside `class << self` | a `method`, the last two with the `self` disambiguator; written twice in one file, ONE entity anchored at the first |
| `def obj.x`, a `def` in `class << obj`, `class self::Foo` | no key can carry them: dropped and counted |
| `NAME = value` | a `constant`, keyed by its full constant path, a child of the type (or file) that writes it, with its literal `value`; read from a body, an `access`. A name the whitelist knows is never stubbed (M18b) |
| `@x`, `@x = …`, a call that names an `attr_*` or a Struct member | `access` to the `field`, reading or writing — the accessor is not an entity. The field belongs to the root-most corpus ancestor that has it (M18b) |
| a constant in a body | `reference` to the type it names: lexically, then through the ancestors of the innermost scope (M18b) |
| a bare `x`, `self.x`, `super`, `Foo.bar`, `Foo.new` (→ `Foo#initialize`), `Foo.new.x`, `send(:x)` | `invocation`, **`declared`**: the receiver's class is written (§19.4). `method(:x)` takes the method as a value: a `reference` to it (M18b) |
| a method of `Object`/`Kernel`/`BasicObject` (`puts`, `freeze`), of `Class`/`Module` on the class side (`private`), of a literal (`"x".upcase`) | the LANGUAGE: resolved, counted, **no edge** — an arrow from every method to `<ruby>/Kernel` says nothing (M18b) |
| a call nothing declares, where exactly ONE library could answer — a library superclass, a library module mixed in, and on the class side a library module merely INCLUDED (its hook may have extended the class) | `invocation` of that stub, **`derived`**, counted `ancestor-attributed` — where `has_many` lands (the Elixir `import-attributed` rule); with two, dropped `ambiguous-ancestor`, the drop naming both (M18b; the class-side candidate is M18c: `validates` in a model that includes ActiveModel::Validations was charged to ActiveRecord::Base) |
| `x = Foo.new; x.bar`, `@repo = Repo.new` … `@repo.find` | `invocation` (or `access`), **`derived`**: a local typed by its assignment in the method, an instance variable only ever assigned one class (M18b) |
| `x.bar` with `x` untyped | dropped and counted — the stated ceiling; candidate generation is the analyzer's (the §13.2 decision) |
| `raise Foo`, `raise Foo, "…"`, `raise Foo.new(…)` | `throws` to Foo; `raise "text"` throws `<ruby>/RuntimeError`; `raise error` is a value: dropped `raise-of-a-value` (M18b) |
| `define_method(:x) { … }` | a `method` like a `def`; a computed name is dropped `computed-define-method` and marks the type as one with methods no key can name — as `method_missing` does (M18b) — on the side they are defined for: a class body's `define_method` and `def method_missing` cloud the INSTANCES, `define_singleton_method` and `def self.method_missing` the class itself (M18c) |
| `--trace`: a mixin the VM holds and no line writes | `traitUsage`, **`generated`**, anchored on the declaration of the type that has it (M18c) |
| `--trace`: a call the program made at a site the baseline left unresolved | ONE `invocation`, **`dynamic-candidate`**, `candidates` = every method that site was seen to reach, `to` the first (M18c) |
| a comment block directly above a declaration | its `comments`, magic comments and `# rubocop:` directives left out; `sloc` on files, types and methods, `cyclomatic` on methods (M18b) |

### 19.3 The Ruby id scheme (`ids.rs`)

```
file (module)     rb:lib%2Facme%2Forder.rb                    path relative to the root, escaped
reserved          rb:<ruby>   rb:<gems>                        what the VM defines / what nothing here declares
external feature  rb:<gems>%2Fnokogiri   rb:<gems>%2Fnet%2Fhttp     a `require` no corpus file answers, as written
missing relative  rb:lib%2Facme%2Fmissing.rb                   a `require_relative` to a file that is not there
class / module    rb:lib%2Facme%2Forder.rb/Acme::Order         the fully qualified constant path
stub type         rb:<ruby>/StandardError     rb:<gems>/ActiveRecord::Base
method            …/Acme::Order.total         singleton: …/Acme::Order.call#self
top-level method  rb:bin%2Ftool.rb/main
operator          …/Acme::Money.%2F     …/Acme::Money.%25     …/Acme::Money.<=>
parameter         …/Acme::Order.total#param:currency           unnamed or repeated: #param:<1-based ordinal>
field             …/Acme::Order.@total       the class's own (`@x` in a class body or a `def self.x`): …/Acme::Order.@registry#self
constant          rb:lib%2Facme%2Forder.rb/Acme::Order::MAX_LINES      its full constant path, as a type's
```

- **`::` is part of a name, not a separator of the key.** A type's symbol is
  its constant path whole; a member hangs below it with a dot.
- **Escaping, the TypeScript rule with one more input.** `/`, `#` and `%` are
  percent-encoded in every path segment and name — `def /(other)` and
  `def %(other)` are ordinary Ruby — and `<` in a path segment, so that no
  walked path can spell a reserved module: `<gems>/json.rb` is a legal file
  name, and the extensionless files Ruby walks (`Rakefile`) mean a key can lack
  the extension that protected every extractor before. Injective by
  construction, pinned by an exhaustive round-trip over the reserved alphabet.
- **A field is named as the variable is written, `@total`**, whichever of an
  `attr_*`, an assignment or a Struct member introduces it: `total` is already
  the key of a `def total`, and a class may write both.
- **An external feature is a module of its own, below `<gems>`.** What a
  `require` names is written in the source and is kept (the TypeScript rule:
  the specifier as written), `.rb` dropped; which gem provides a *constant* is
  not written anywhere, so constants share the two reserved modules.

### 19.4 Stub discipline and the lexical resolver

Pass 1 reads every `class`/`module` body and every constant assignment; the
whitelist is the set of constant paths they open, **and every prefix of one**
(`A::B::C` cannot exist without `A::B`). A compact declaration (`class A::B`)
needs `A` resolved, and `A` may be declared compactly in a later file: the
names are computed to a fixed point, two rounds on any corpus people wrote.

A constant path at a site resolves as Ruby resolves it lexically — each
enclosing scope from the innermost out, then the top level. **A compact class
opens ONE scope**: inside `class Acme::Order`, a bare `Priceable` is not
`Acme::Priceable`, in the model as in Ruby. A name no enclosing scope answers
is then searched in the ancestors of the innermost scope — its prepends,
mixins and superclasses, corpus and core table alike — and last at the top
level, as Ruby does (M18b); a name found nowhere is taken as written.

| The resolver says | The model says |
|---|---|
| a type the VM defines (the core table) | a stub below `<ruby>`, its kind from the table — **even when the corpus reopens it** |
| a constant path some corpus file gives a body to | the primary declaration |
| a path the corpus knows and gives no body (a namespace, an assigned constant), or a value constant of the table (`ARGV`) | dropped and counted `not-a-type` (`namespace-only` in a body) — never a stub: resolvability is not membership, and neither is its absence |
| such a namespace that the corpus itself proves has a body elsewhere — it is sent a message no bare `Module` answers, or a class inherits from it while nothing opens it (M18c) | a stub below `<gems>`: nobody can answer `env` on a module nobody wrote |
| anything else | a stub below `<gems>`: a `class` when a site inherits from it, a `module` when one mixes it in |

`<ruby>` is deliberately **core only**. The standard library is `<gems>`:
nearly all of it is default or bundled gems, the set moves with every Ruby
release (`csv` left the default gems in 3.4), and a model's keys must not move
with it. That choice is also what makes the first row exact rather than
heuristic: the VM defined `String` before any file ran, so a corpus
`class String` can only be a reopening — a declared entity `attachedTo`
`<ruby>/String`, while every reference to `String` still names the VM's. The
one corpus it misreads is a library that itself implements a core-table
constant (rubygems' own `Gem`); M18c measures it. A *library's* class the
corpus reopens has no table to consult and is the declaration the corpus
knows — the monkey-patch file becomes that constant's target, stated.

**Calls (M18b): the shape of the receiver decides everything.** The walker
records each call with what its receiver IS in the source; pass 3 looks the
method up along the chain that names — prepends, the type, its mixins in
reverse, the superclass; corpus declarations first, the core table as the
tail.

| Receiver | Chain | Provenance |
|---|---|---|
| none, `self`, `super` | the enclosing type's — instance side in a method, class side in a body or a `def self.x` | `declared` |
| a constant (`Foo.bar`), `Foo.new` (→ `Foo#initialize`), `Foo.new.bar`, `self.class.bar`, `new.bar` in a class method | that type's | `declared` |
| a local assigned `Foo.new` in the method (a later reassignment untypes it); an instance variable only ever assigned one class | that type's | **`derived`** — flow, not text |
| a literal (`"x".blank?`) | the literal's class | `declared` when the corpus defines the method, else the language |
| a parameter, a block argument, the result of a call | none | dropped, `untyped-receiver` |

What answers decides the edge. A corpus `def` → `invocation` of it. An
`attr_*` or a Struct member → `access` to the field. A method the core table
gives to a class the receiver *is* (`upcase` in a `String` subclass) →
`invocation` of that stub type. A method of `Object`/`Kernel`/`BasicObject`,
or of `Class`/`Module` on the class side → the language: resolved, counted,
no edge. Nothing answers and the chain holds exactly one library ancestor →
`invocation` of it, `derived`, counted `ancestor-attributed`; two →
`ambiguous-ancestor`; none → `unbound-self-call`. In a type that writes
`method_missing` or a `define_method` with a computed name, a miss is
`unbound-dynamic`: "nothing declares it" is no longer evidence — on the side
those methods are defined for (M18c): instances and the class are clouded
separately. An operator
on an untyped receiver (`a + b`, `x[0]`) is the language far more often than
not: counted apart, and kept out of the rate either way.

**Hooks (M18c).** A class gets its class methods from what it includes more
often than from what it extends: `def self.included(base);
base.extend(ClassMethods)`, and ActiveSupport::Concern on top of it. Where the
idiom is literal the walker records it on the MODULE (`hooks`, `concern`), and
the class side of every includer answers along those modules as hook stops:
found there, a method is `derived` — the receiver is written, the link is
not. A LIBRARY's module included by a type is one more library that could
answer on its class side, whatever its hook did; that is what turns a
confident wrong attribution into an honest `ambiguous-ancestor`.

### 19.5 The extractor command-line contract

Same flag shape and exit codes as every extractor (`schemas/README.md §8`),
plus one flag of its own: `--explain-dropped` lists every drop on stderr, in
source order, as `dropped <reason>: <file>:<line> <what>` — the audit's working
tool, and it changes no byte of the model. `stdout` carries nothing but
`--help`/`--version`:

```
syntax errors (recovered, 1): lib/acme_order/legacy/broken.rb
RESOLUTION SUMMARY
  files           : 31 (with syntax errors: 1)
  sites           : 177
  resolved        : 135 (corpus 79, <ruby> 21, <gems> 14, the language 21)
  unresolved      : 42
  resolution rate : 76.3%
  ambiguous-ancestor (dropped): 4
  computed-require (dropped)  : 1
  …
  unbound-self-call (dropped) : 10
  untyped-receiver (dropped)  : 22
  ancestor-attributed         : 2
  operators, untyped receiver : 8 (not in the rate)
  imports         : 41 (require 12, require_relative 11; unresolved: 5, by load path: 7, derived: 18)
  entities        : 181 (stubs: 24)
  edges           : 153 (self-edges dropped: 1)
```

A **site** is a constant read, a call, a `super`, a `raise` or a variable; the
rate is over the sites that named something, the language included, and a
declaration no key can carry (`def obj.x`) is counted without entering it.

A drop says what decided it where something did (M18c): `unbound-dynamic`
names the type that defines methods at run time, `ambiguous-ancestor` the
libraries that could answer.

**`--trace <file>` (M18c)** merges what `extractors/ruby/trace/
codegraph_trace.rb` wrote from inside the running program — one Ruby file, no
dependency, required first (`ruby -r…/codegraph_trace -e 'require
"./config/environment"; Rails.application.eager_load!'`), reading the VM when
the program exits and, with `CODEGRAPH_TRACE_CALLS=1`, listening to the calls
it makes. The trace is JSONL: a header, then `mixin` (type, how, module),
`method` (type, name, file, line) and `call` (the site's file and line, the
name, the file and line of the method entered). It names things as Ruby does
and **carries no key**: the extraction finds its own entities from a constant
path, or a file and a line. Merged AFTER the baseline's pass:

- a mixin the source writes is the same fact; one it does not is a
  `traitUsage`, `generated`, anchored on the declaration of the type that has
  it — no line writes it;
- a call at a site the baseline left unresolved is ONE `invocation`,
  `dynamic-candidate`, `candidates` every method that site was seen to reach
  and `to` the first of them — what ran, not what must run; a call the
  baseline already wrote (same caller, callee and line) is counted as known;
- a method the VM holds on a line that writes no `def` has no entity and gets
  none: counted.

No entity is added and no edge of the source changes: a tested property. A
file that is not a trace, or is not there, is a failure that writes nothing.

### 19.6 Validation (the M2 gate, replayed a fifth time)

- **Walking skeleton first** (M18a): one corpus in, `codegraph validate`
  green, snapshot committed, the core gate (parses as a `Model`;
  byte-identical to core's encoder; ZERO profile issues; closed; no
  self-edges; the stub-discipline evidence by id).
- **The fixture corpus** `fixtures/ruby/src` — `acme_order` as a gem, each
  file pinning one hazard (its README lists them): both spellings of a nested
  class, a wrapper beside a body with something of its own, a reopening that
  sorts before its primary, a monkey patch of `String` and a class that
  inherits from `String`, `def self.x` beside `def x`, `class << self`, the
  operators `/` and `%`, every parameter shape, a compact class that cannot
  see its namespace, two wrappers deep, a `Struct.new` superclass, an assigned
  constant used as a superclass, the standard library under `<gems>`, a
  `require` by load root, by path, missing, computed, a file with a syntax
  error, a `#` in a file name, an extensionless `Rakefile`, a `.rake`, a
  `.ru`, and a `vendor/` tree that must not appear. M18b adds what a body
  says: constants of three literal shapes, fields from `attr_*`, assignments
  and Struct members, a `Struct.new` assigned to a constant, every receiver
  shape of §19.4 with its provenance, `has_many` attributed and `update!`
  refused, `raise`, `super` into the core table, `define_method` literal and
  computed, `send`, `load`, `autoload`, the `__dir__` idiom, and two files
  under `bin/` — one with a Ruby shebang, one without.
  M18c adds what the audit found: a class with one library above it and one
  with two (attribution, then the refusal that names both), a computed
  `define_method` beside a class-side call, a concern (`class_methods do`,
  `included do`) and its plain-Ruby twin (`base.extend(ClassMethods)`) with a
  class that includes both, a compact declaration under a library's
  namespace, and a block argument only a trace can type.
- **The metrics pass** (§18) reads the snapshot with the `ruby` grammar: 106
  of 109 measured entities joined, the witness `sloc = ploc` on all 106 — the
  fifth `model.metrics.jsonl`, hand-counted on `Order#total`. The three others
  are types the grammar reads as a block.
- **Extractor-side tests** (cargo): the walker, the resolver and the writer as
  unit tables; `tests/contract.rs` holds the library to the snapshot byte for
  byte, to a CRLF copy created in reverse order, and to the CLI contract.
- **The audit (M18c)**, four corpora, each model `validate`-clean:

  | corpus | files | sites | resolved | entities (stubs) | edges | time |
  |---|---:|---:|---:|---:|---:|---:|
  | rake 13.2.1 (a plain gem: the `require` resolver) | 100 | 9 261 | 77.8 % | 1 865 (94) | 6 696 | 0.1 s |
  | rubygems 3.6.2 (implements a core-table constant) | 794 | 138 051 | 54.4 % | 15 809 (465) | 71 197 | 1.0 s |
  | Mastodon 4.3.0 (Zeitwerk) | 2 541 | 151 603 | 31.2 % | 16 510 (593) | 47 663 | 1.0 s |
  | — its `app/` and `lib/` alone | 1 108 | 51 548 | 62.1 % | 12 806 (388) | 31 180 | |
  | rails 8.0.2 (metaprogramming) | 3 334 | 383 269 | 57.0 % | 71 681 (1 004) | 212 140 | 4.7 s |
  | — every `lib/` and `app/` alone | 1 459 | 84 800 | 59.4 % | 36 275 (667) | 47 918 | |

  The ceiling, measured: four fifths of what application code leaves
  unresolved is `untyped-receiver`; 55 000 of Mastodon's unbound calls are
  RSpec's DSL in `spec/`; rails has 46 000 `unbound-dynamic`, nearly all in its tests
  and three quarters of them from three types (a helper that `define_method`s
  over a list, the fixture accessors' `method_missing`, ActiveRecord's dynamic
  finders). On rake every
  `rake/…` feature resolves to its file through the `lib` load root, and the
  one `require` the model lacks sits in a string given to `class_eval`.
- **The Packwerk oracle (M18c).** Packwerk 3.3.1 driven without booting the
  application — its parser, its reference extraction and its
  ConstantResolver, over the autoload paths Rails would compute — resolves
  4 335 cross-file constant references in Mastodon's `app/` and `lib/`. The
  model has the same constant in the same file for **4 289 (98.9 %)**. The 45
  others are a `module Admin` wrapper around a class, which Packwerk counts as
  a reference to `Admin` and the wrapper rule does not; one is an inherited
  constant Packwerk places by file name and the model in the superclass that
  assigns it. The model names 346 that Packwerk cannot (declarations under
  `lib/`, outside the autoload paths) and 147 compact declarations. Two of the
  audit's fixes came from this oracle: the qualifier of a compact declaration,
  and a qualified constant looked up through its qualifier's ancestors.
- **The boot-time oracle (M18c).** rake's own tests, run in a container under
  the trace: of the 1 012 methods the model declares in the 83 files that were
  loaded, the VM holds one on the same line for **1 006** — the six others are
  definitions under a platform or capability `if`, a `def` inside a method
  that never ran, and methods of anonymous classes. The VM holds 200 methods
  the model has none for: 199 written by the metaprogramming loops of three
  files, one the `else` branch of a platform test. Of 2 829 calls observed,
  1 533 are edges the baseline wrote — same caller, callee and line — 879 land
  on sites it had left untyped (860 `dynamic-candidate` edges), 259 are
  written by no line under that name, 158 enter a run-time definition.
- **The §19.4 misreading, measured (M18c).** rubygems declares 39 bodies of 20
  types the core table lists (`Gem` alone 12): each is `attachedTo` the VM's
  stub, and 3 802 of that model's 71 197 edges land on the stub of a type the
  corpus itself implements. Nothing is lost — the bodies are there, attached —
  but the reference names the stub rather than the file.

### 19.7 Distribution

One binary per platform from a runner of its own OS, the `metrics-native`
shape (§18.3): `codegraph-ruby-<rid>`, a formula in the tap, a registry entry
(`extensions: [".rb", ".rake", ".gemspec", ".ru"]`). All of it is M18c; M18a
ships `bin/codegraph-ruby` over `target/release/`.

Wired in M18c: the `ruby-native` job (the four Unix runners of
`metrics-native`, each binary re-extracting the fixture and `cmp`ed with the
snapshot), `ruby` in the release job's copy loop, the `ruby` row of
`BINARY_EXTRACTORS` in `scripts/homebrew/render.mjs` (so
`Formula/codegraph-ruby.rb` depends on the pass like every extractor), and
the `ruby` row of the app's catalogue. A release that renders the tap now
needs the four `codegraph-ruby-<rid>` sums: the job, the loop and the row
land together. Not exercised until a `v*` tag — and `ruby-test` itself has
yet to run on a GitHub runner: both jobs install `libclang-dev` where the
image has no `clang`.

### 19.8 Hazards, each with the test that pins it

| Hazard | Where it shows | Guard |
|---|---|---|
| canonical order compares UTF-16 code units; Rust strings compare by byte | a name above U+FFFF sorts differently | `utf16_cmp` on `encode_utf16`; a unit test with the pair that disagrees |
| JSON bytes must match core's `JSON.stringify` | escaping, key order | a hand-written encoder (no serde: the order is the contract); the two-encoder gate in core |
| a source that is not UTF-8 (a Latin-1 comment in a 2009 file) | names enter the model as strings | Prism reads bytes and honours the magic comment; the FILE is never rejected, a name that is not valid UTF-8 is written with U+FFFD and counted |
| `\r\n` sources | Windows checkouts | lines counted on `\n`; the CRLF determinism test |
| `\` separators | Windows anchors and keys | every path `/`-joined before it enters a key |
| enumeration order | case-insensitive file systems | ordinal sort of walked paths by UTF-16 units; the reversed-creation-order test |
| a Prism bump reads one more syntax form | entities move | the exact pin, `PRISM_VERSION` restated for the header and pinned to `Cargo.toml` by a test; `--locked` builds |
| the core table drifts with RBS | `Set` entered `core/` when Ruby made it core | the table is named by RBS version and the header carries it |
| bindgen without clang's builtin headers | `limits.h` not found on a machine with libclang alone | `ensure_libclang` + `cargo_ruby` in `scripts/lib.sh` |
| a symlinked directory cycle | `vendor/bundle` links | directory symlinks are not followed; symlinked files are read |
| a drop counted and not locatable | an audit that cannot find what the summary counts | the walker's drops ARE the list (`reason, line, what`), the counts derived from it; the contract test holds `listed == counted` |
| an accessor and a `def` of one name | `attr_reader :total` beside `def total` | the field is `@total`, the method `total`: two keys |
| a library's namespace the corpus reopens below (`class Rails::Patch`) | every `Rails.env` dropped as `namespace-only` — 592 in Mastodon, 422 `I18n.*` in rails | a stub on evidence: a message no bare module answers, a superclass nothing opens; `Admin` (a Zeitwerk directory) stays a namespace |
| a class method that arrives through an `included` hook | `Account.find_remote` unbound, or charged to the wrong library | the hook is read where it is literal and the lookup goes through it, `derived`; a library mixin is a class-side candidate |
| `define_method` in a class body clouding the class's own calls | `where`, `scope`, `validates` in a model with one computed accessor: all `unbound-dynamic` | the flag is per side; the drop names the type that set it |
| a constant qualified by a subclass | `Child::LIMIT` a `declared` reference to an invented `<gems>/Child::LIMIT` | looked up through the qualifier's ancestors |
| a trace that names what the model does not hold | a method defined at run time, a library's class | counted, never an entity: the entities with and without a trace are the same lines |

### 19.9 Milestone split

- **M18a — profile + skeleton + contract.** `feat(core): ruby profile`
  (§19.2, the eleventh) and the registry test; `extractors/ruby/` on Prism
  with the embedded core table; the walking skeleton — files, classes and
  modules (the wrapper rule, one entity per declaring file, attachment),
  methods and parameters, `require`/`require_relative`, superclasses and
  mixins, the `derived` import, stubs — → `fixtures/ruby/expected/model.jsonl`
  byte-identical to core's encoder and profile-valid with zero issues; the
  core gate; `bin/codegraph-ruby`; `build.sh --ruby` / `test.sh --ruby` with
  the release-binary `cmp`; `ruby-test` in CI.
- **M18b — the model.** `field` (instance variables and `attr_*` as one
  entity) and `constant`; `Struct.new` / `Class.new` / `Data.define` as types;
  constant references in bodies, with the ancestor chain searched; the
  invocation tiers of §19.2 with their provenances; `access`, `throws`;
  comments; `sloc` + `cyclomatic`, literals; the `__FILE__` require idioms,
  `load` and `autoload`; a Ruby shebang as a walked file; `ruby` in the
  metrics pass (big-code-analysis has the grammar) and a fifth
  `model.metrics.jsonl`; the full fixture with its README; the fixture in
  every per-fixture suite; every CLI command verified on it; city and
  navigator screenshots reviewed.
- **M18c — audit + oracles + distribution.** Three corpora, every model
  `validate`-clean: `rails/rails` (metaprogramming: the ceiling measured), a
  Zeitwerk application (Discourse or Mastodon: the `derived` import layer and
  the Packwerk oracle), a plain gem (the `require` resolver); a default gem
  that implements a core-table constant (the §19.4 misreading, measured); the
  trace gem and `--trace`; the defects found named in the profile notes with
  their counts; binaries on four Unix runners, the registry entry, the
  formula; `docs/ruby-extractor.md`; README names the extractor.
  *As done:* the trace tool is one Ruby FILE, not a published gem — nothing
  to install, `ruby -r` it; the oracles ran in a container, since no Ruby is
  installed where the extractor is built; and the plan's "invisible" hook
  mixins are read statically where the idiom is literal (§19.4), the trace
  keeping the rest.

Definition of done: `fixtures/ruby/expected/model.jsonl` byte-identical to
core's encoder and profile-valid with zero issues; the same bytes from the
binary on every runner; the constant layer equal to Packwerk's on a Zeitwerk
application up to the documented blind spots; the audit numbers in the
profile notes; `./test.sh` and CI green with the Ruby fixture in every
per-fixture suite.

---

## 20. Phase 17 — The vocabulary: word cloud and semantic glossary (M19)

Motivation ([#6](https://github.com/defsquare/codegraph/issues/6), with the
profile half of [#19](https://github.com/defsquare/codegraph/issues/19)): a
codebase speaks a language, and the model already holds every word of it —
every `TNamed` entity is an identifier someone chose — but it holds each name
as ONE token. `OrderManagerRepository` is a name to the analyzer, not the
three words `order`, `manager`, `repository`; nothing today can say that
`order` is spoken 1 400 times across 61 modules while `basket` is spoken
twice, in one. The issue's pitch is the word cloud of an application; what
makes it more than a picture is what the issue lists after it: **drift**
(words in the code that the business never says, and the reverse),
**overlap** between modules, a proxy for **cognitive load** (a module with
500 distinct words against one with 100), and the city link (where does
`order` live). Then the half a model is for: a word's MEANING where it is
used — `order` is polysemic — stored with the insights, as a glossary per
scope.

**Decision: a pure package, `@codegraph/vocabulary`, computing from the
NAMES the model carries; an artifact, `vocabulary.json`, beside `city.json`
and `navigator.json`; the per-language idioms as profile DATA in core
(`Profile.lexicon`, which is #19); the glossary TIED TO EACH EXPLAINED
ENTITY — its explanation carries the words its name is made of, each with
its sense and its concern in that entity's context, and every scope's
glossary is rolled up from those.** Rejected, each with its reason:

- **Tokenizing source text** (the issue's step 1, read literally: strip the
  keywords of a file, collect every identifier). The words the issue names —
  class, method, variable, argument names — are exactly what the model
  carries, with its kind, its containment and its anchor; a lexer per
  language would be a sixth source reader, outside the two the architecture
  licenses (the extractor, the metrics pass), and keyword filtering would
  become a necessity instead of a tag. What source text would add —
  comments, string literals, the names of external members called — is a
  second channel (§20.5). The cost of the choice is COVERAGE: an extractor
  that emits no local variables (Ruby, Elixir — their profiles have no
  `localVariable` kind) yields a cloud with fewer incidental words. That is
  measured and stated per extractor (§20.1), not hidden.
- **Inside `@codegraph/analyzer`.** The analyzer answers graph questions;
  this is a view model with an artifact of its own, like the city and the
  navigator, and it carries its own layout.
- **Inside the metrics pass.** It would re-read source for words the model
  already states, and `metrics` is for measured NUMBERS (METAMODEL §3.8), not
  for derived strings.
- **Words in `model.jsonl`.** Derived from names, hence recomputable from
  the model alone — the opposite of a measure. The artifact is the
  serialization; the model does not move (invariant 4's spirit: derived
  indexes are never serialized into the interchange).
- **`d3-cloud` or a browser-only layout.** The layout is a page of geometry
  that must run in Node — the demo image is a committed SVG the CLI writes
  deterministically — and the browser passes its own text measurer into the
  same function.

Seven principles, locked up front:

1. **Words come from the model's names, never from source.** Every kept
   `TNamed` entity contributes the words of its name; a nameless one
   (constructor, lambda) contributes none and is counted. Coverage per
   extractor is a table in this section, filled by the milestone.
2. **The idiom is the profile's; the algorithm is one.** Keywords,
   conventional names, technical words and file kinds are DATA on the
   profile (`lexicon`), specifiable without being implemented (invariant 8);
   word boundaries are universal and need none. The splitter reads the data
   and knows no language.
3. **Classification, not filtering.** Every token is kept and tagged
   `domain | technical | keyword | short`; a consumer filters. Drift needs
   the technical words too, and "not shown" must stay distinguishable from
   "not there" (the §3.8 rule, applied to words).
4. **Weights are data and travel in the artifact.** A count without the
   scheme it was weighted under is not a fact — the city's `bindings` rule.
5. **Scope membership is the fold's.** A type's words are the words of
   everything that folds into its building (`containingType`), a module's
   likewise (`containingModule`), the corpus's every kept entity — the same
   membership the city uses, so a `vocabulary:order` channel measures the
   building whose words were counted. Attachment is NOT followed, as the
   fold does not: a Ruby reopening speaks in the file it is written in.
6. **Deterministic bytes.** Terms interned and sorted, scopes in id order,
   tables by weight then term; `fixtures/<lang>/expected/vocabulary.json`
   per fixture, byte-identical on every run and every OS.
7. **A word's meaning is an inference about one entity, stored and shown as
   one.** It lives inside that entity's insight record in
   `<model>.insights.db` (paid for: migrated, never regenerated), never in
   the artifact, and wears the page's inference colour.

### 20.1 The split, the classes, the weights (M19a)

**The profile lexicon** (#19, METAMODEL §5 gains the row). Optional on every
profile — a profile without one is complete, and the splitter falls back to
the universal rules below — present on the eleven shipped:

```ts
lexicon?: {
  keywords: string[];       // the specification's RESERVED words, as the language spells them;
                            // a contextual keyword (record, var, TS's type) is an identifier
  conventional: string[];   // whole identifiers the language or its runtime dictates;
                            // skipped whole: toString/equals/hashCode/main (Java),
                            // initialize/to_s/inspect/<=> (Ruby), constructor (TS),
                            // __using__/start_link/init/handle_call (Elixir),
                            // Equals/GetHashCode/ToString/Dispose/Main (C#)
  technical?: string[];     // language-specific plumbing beyond the shared list, as the
                            // splitter yields it: bean, jdbc (Java); concern (Ruby); live, web (Elixir)
  fileKinds?: string[];     // kinds whose name is a file path: TS/JS `module`, Ruby and Elixir
                            // `file`, PHP `codeFile` — the extension is not a word
  qualified?: Record<string, string>;
                            // kinds the language names by a qualified path, with the separator
                            // that ends the qualifier: Java `package` ".", Ruby `class` "::",
                            // every file kind "/" — the qualifier's words weigh as incidental
  interfacePrefix?: true;   // C#: `IOrderService` → order, service (I + Upper + lower)
};
```

The first draft carried `idioms.separators`, `prefixes` and `suffixes`; built
(M19a), they could change no output. The splitter must break on EVERY
character that is not a letter, a mark or a digit anyway — or `<=>`,
`[Symbol.iterator]` and `this[]` become tokens — and once it does, `@total`,
`valid?`, `Order::Line` and `` Repository`1 `` need no data. The draft's
`fileModules` flag was per PROFILE; file-ness is per KIND (Elixir's `file` is
a path, its `module` the dotted `AcmeOrder.Registry`, whose `.Registry` a
profile-wide flag would drop as an extension), so it became `fileKinds`.

`qualified` was added when the aggregation was measured (M19a, below): a
qualified name speaks its container's words again, on every entity the
container holds. Full names made `acme` weigh 468 in the Ruby fixture and 392
in the Elixir one, against about 50 for the next domain word, and `packages`
168 in the TypeScript one. A kind is listed when the LANGUAGE names it by a
path — Java's `package`, C#'s `namespace`, Clojure's `namespace` and Python's
`module` by `.`, Elixir's `module` and `protocol` by `.`, Ruby's `class`,
`module` and `constant` by `::`, PHP's `namespace` by `\`, every file kind by
`/`; Go's package (`package order`) and Rust's module (`mod line`) are named by
one identifier and are not listed. `validateProfile` gains
`lexicon-not-a-separator` (empty, or holding a letter, a mark or a digit), and
an undeclared qualified kind is `lexicon-unknown-kind`.

`ProfileSchema` mirrors it (a test parses every shipped profile through it
unchanged); `codegraph profiles --lang X` prints it in full, between the kinds
and the notes (the command's completeness rule); `schemas/` is unchanged — a
profile is not on the wire. `validateProfile` rejects an entry that could
never do what its list says, with four codes: `lexicon-duplicate`,
`lexicon-not-a-word` (a keyword with no letter, a name holding whitespace, a
technical entry the splitter cannot yield), `lexicon-keyword-overlap` (a
conventional name or a technical word a keyword claims first) and
`lexicon-unknown-kind`. Tests pin, per shipped profile: a non-empty keyword
list, no contextual keyword listed, `interfacePrefix` in C# alone, and exactly
the five file kinds above. TypeScript reserves exactly ECMAScript's words, so
the two profiles read one `ECMASCRIPT_LEXICON`.

**The split** (`split.ts`): one function, `splitIdentifier(name, kind,
lexicon)` → `{tokens, qualifier, numeric, conventional}`, in six steps, each
pinned by a table of hand cases per idiom:

1. for a kind in `fileKinds`, drop the extension of the last path segment
   (`legacy/acme-report.ts` → `legacy/acme-report`); for a kind in
   `qualified`, cut the name at the LAST occurrence of its separator — the
   words before it are the qualifier, counted in `qualifier`
   (`AcmeOrder::Order::Line` → 3 of `acme`, `order`, `order`, `line`); then
   the interface prefix on the own name when the flag is set and it starts
   `I` + Upper + lower (`IOrderService`, not `IO`; `Acme.IOrder` → `order`);
2. split on every character that is not a Unicode letter, mark or digit —
   universal, no data: `@total` → `total`, `valid?` → `valid`, `save!`,
   `name=`, `Order::Line`, `max_lines`, `acme-report`, `Repository\`1` →
   `repository`, `1`;
3. camel-case boundaries with the acronym rule — lower→Upper, digit→Upper,
   and an Upper run followed by Upper + lower splits before its last letter
   (`HTTPServer` → `http`, `server`; `getURLString` → `get`, `url`,
   `string`; `XMLHttpRequest` → `xml`, `http`, `request`) — on Unicode
   letter categories, not ASCII (`fixtures/unicode` is the test: `ＡFullwidth`
   and `𠀀Supplementary` must split and lowercase without a replacement
   character). A caseless letter (`𠀀`, `注`) counts as lower; a mark takes
   the case of the letter it sits on, so a decomposed `é` never splits;
4. a digit run stays with the letters around it — only an Upper after it
   breaks (`utf8`, `md5`, `v2`, `i18n`, `http2`; `Utf8Encoder` → `utf8`,
   `encoder`); a token that is only digits is dropped and counted
   (`skipped.numeric`);
5. lowercase (`toLowerCase`, locale-independent: a Turkish-locale machine
   must write the same bytes);
6. a `conventional` identifier is skipped whole BEFORE step 1 and counted
   (`skipped.conventional`): `toString` must not contribute `string`,
   `handle_call` must not contribute `call`.

Properties (fast-check over identifiers the grammar admits): every token is
a non-empty run of letters, marks and digits, lowercase, never digits only,
and a slice of the lowered name; the same input gives the same tokens;
`split(a + sep + b) = split(a) ++ split(b)` for any character that is not a
letter, a mark or a digit — without a lexicon, since the file kinds, the
interface prefix and a conventional name read the WHOLE name. Qualification
moves no word: the tokens are the same with the qualified kinds removed, and
for a qualified kind `qualifier` is the number of words of `a` in
`a + separator + b`. A Σ is left
out of the generator: its lower case depends on what follows it, so a
token's lower case and its slice of the lowered name may differ (`ΟΔΟΣ` →
`οδος`, pinned by hand).

**The classes** (`classify.ts`), a closed set `TERM_CLASSES = ["domain",
"technical", "keyword", "short"]`, decided per TOKEN in this order:
`keyword` when the lowercased token equals a lowercased lexicon keyword
(`type`, `default`, `case`, `new`, `end`) — a keyword the splitter never
yields whole (`defined?`, `__FILE__`, `set!`) classifies nothing, since the
`file` of `upload_file` is not `__FILE__`; `short` when it is one code point
that is not a mark (`i`, `e`, `x`, `𠀀` — length 2 stays: `id`, `db`, `io`
are words); `technical` when it is in the shared list ∪ the profile's
(`DEFAULT_TECHNICAL`, 138 words in the package: `get set is has to from of
with by and or not new create build make init impl abstract base default
util utils helper manager service repository controller handler factory
provider dto dao entity model data info config exception error test mock
spec com org net io src lib main app`, the CRUD verbs, the web and format
words…, overridable whole with `--technical FILE`, its digest recorded in
the artifact — the profile's own words apply either way); else `domain`. The
list is contestable by construction — which is why it is data in one place
and the artifact says which one it used. It holds what every language
shares: a word two lexicons listed (`args`, `opts`, `ctx`, `err`,
`callback`, `str`, `mutex`, `mixin`, `async`) moved into it, and a test
keeps it disjoint from every profile's `technical`.

**Roles and weights** (`weight.ts`). The role of the entity carrying a name
comes from its traits, never its kind (the navigator's rule), first match
winning: `module` (TModule), `type` (TType — a C# delegate, TType +
TInvocable, is a type), `operation` (TInvocable — a Clojure fn-var too),
`parameter` / `local` (TStructural listed in some entity's `parameters[]` /
`localVariables[]`), `attribute` (every other TStructural: fields,
constants, properties, module attributes), and `other` — a named entity no
role trait describes (TypeScript's `namespace`, PHP's `codeFile`, Python's
`decorator`), whose words still count (principle 1). Built on the fixtures,
one parameter is listed nowhere: the C# indexer's, a child of its
`property`, which the C# profile gives no `TWithParameters`; it weighs as
an attribute until the model lists it, pinned by id. Default weights,
recorded in the artifact and overridable with `--weights role=n,…`:

| role | weight | why |
|---|---|---|
| `type`, `module` | 8 | a concept the corpus names once and refers to everywhere |
| `attribute` | 4 | a thing the type holds — nouns, usually domain |
| `operation` | 3 | something it does; the prefix is usually technical (`get`, `find`, `build`) |
| `parameter`, `local` | 1 | incidental: the "variable buried deep in a method" of the issue |
| `other` | 1 | no trait says what it is |
| `qualifier` | 1 | not a role: the words before the last separator of a qualified name, whatever its role — a container's words, spoken again by every name it qualifies |

An occurrence is one token in one name; a name carrying a word twice counts
twice, and is one carrier. Both the weighted sum and the raw occurrence count
are kept — one is a judgement, the other a fact; a word weighing 0 still
occurs.

**Scopes and aggregation** (`aggregate.ts`, `buildVocabulary(graph,
{view?, weights?, technical?, name?})`). Kept is the view's verdict on a
non-stub entity; a stub never speaks, whatever the view — its name was chosen
by another corpus (`String`). Scopes are the kept modules and types (by trait:
TModule first), plus the corpus root; an operation's table is computed on
demand (`--scope ID`), not stored (§20.5). A scope's table is the union of the
tables of every kept entity whose fold container it is — the NEAREST: a nested
type is its own scope, and its members are not its outer type's —
`term → { weight, occurrences, carriers }` where `carriers` is the number of
distinct entities carrying the word. Per scope: `entities` (each one unnamed,
conventional, or counted in `roles` by its role), `skipped` by reason,
`distinct` and `distinctDomain` (the cognitive-load proxy), total `weight` and
`occurrences`. Per term: `modules` and `types` (how many scopes speak it) and
`exclusive` (the one module scope whose table has it, when exactly one does) —
the overlap and the drift inputs. A class is decided per language (Go
reserves `type`, Java does not), so a word is interned once per class it
takes; an entity's language is its model's, read from the union, never from
its id. A kept entity no module contains counts at the root alone and is
listed (`unplaced`); a language without a lexicon is split by the universal
rules alone and listed (`withoutLexicon`). Every scope's parent is the
nearest scope up the containment chain the model writes, else the root.

**The artifact** `vocabulary.json`, kind `codegraph.vocabulary/1`
(`artifact.ts`): a header (generator, view descriptor, `corpus`, `langs`,
`weights`, `classes`, `technical: {words, sha256}` — the shared list's size
and a sha256 over its sorted words, one per line), `terms[]` interned and
sorted by text in code-unit order then class, `scopes[]` (root first, then
modules then types in id order: `level`, `id`, `name`, `kind`, `parent` scope
index, the counts above, `terms: [termIndex, weight, occurrences,
carriers][]` by weight descending then term) and `diagnostics` (`unplaced`,
`withoutLexicon`). Every scope id is a kept entity of its level, every index
is in range, and the counts add up — the closure property, tested on the
fixtures and on generated corpora, with conservation (every kept entity in one
module scope or unplaced) and order-independence (the same bytes whatever the
order entities arrive in). Compact by default; `pretty` writes one term and one
scope per line, the snapshots' form. Size, measured on BroadleafCommerce
(3 305 types, 502 modules): 2.9 MB compact, built in 0.29 s — no cap.

**The command.** `codegraph vocabulary <models…> [--level corpus|module|type]
[--scope ID] [--top N] [--class domain|technical|keyword|short|all]
[--weights …] [--technical FILE] [--drift FILE] [--out vocabulary.json]
[--svg FILE] [--json] [--internal-only] [--declared-only] [--no-cache]`
(`--svg`, M19b's, draws the one scope reported — the corpus or `--scope`'s —
so it is a usage error with `--level module|type` or `--drift`), a shell over the package like
`analyze` over the analyzer. Every report's
header states the view, the weights and the technical list (its size, the
first 12 hex of its digest, and the file it came from). No flag: the corpus
root's top 40 `domain` terms as a table — term, class, weight, occurrences,
carriers, modules, types. `--level module`: one block per module, its top N
(10 by default) and its `distinct` column, sorted by `distinct` descending,
ties by id — the cognitive-load report. `--scope ID`: a stored module or
type, else an operation counted on demand (`operationScope`: the operation
and every kept entity written inside it, lambdas included, short of a type
or module, indexed by the artifact's terms; an artifact built under other
options is refused); an unknown id, a stub, or a member that is no operation
is a usage error that says what the id is. `--weights KEY=N,…` lays the keys
typed over the defaults (an unknown or repeated key, or a weight below 0, is
a usage error). `--technical FILE` replaces the shared list whole, one word
per line, `#` comments skipped; a line the splitter does not yield as one
word could never match a token and is refused by its number. `--out` writes
the artifact (compact) beside the report. `--drift FILE`: a plain text file,
one business term per line, `#` comments skipped, a term whose words repeat
an earlier one's merged, a line naming no word warned about by its number;
each term is split with the universal rules so `Order Line` meets `order`
and `line`; a business term is SPOKEN in a scope when every one of its words
is, whatever class the code gives it, and the report lists the business
terms no scope of `--level` speaks (with the words no scope says at all, or
"never together"), the ones it speaks and where, and the `domain` words the
code speaks that no business term contains, summed over the level's scopes.
Nothing is stemmed. A term spoken nowhere exits 3, as `analyze --report
cycles` does for a cycle: a CI job can gate on the glossary. `--class` with
`--drift`, and `--level` or `--drift` with `--scope`, are usage errors — a
flag the report would not read is refused, never dropped. `--json` is one
object, `codegraph.vocabularyReport/1`, `report: "words" | "drift"`. The
Specy `.domain` file as input is deferred (§20.5): the plain list first,
because it exists in every company.

**Measured** (2026-10-26, Apple M1 Max, Node 26; `build` is
`buildVocabulary` alone over a built graph, the median of five; `artifact`
the compact `vocabulary.json`). Whole repositories as cloned, tests included:
BroadleafCommerce at `26208e01de` (the Java jar), codegraph at `294e5cc`
(`--src packages --src extractors/typescript`), Mastodon at `2bc820fb84` and
Plausible at `9bc90b0063`:

| corpus | kept entities | named | by role (module · type · operation · attribute · parameter · local) | skipped (unnamed · conventional · numeric) | distinct terms (domain) | artifact | build |
|---|---:|---:|---|---|---|---:|---:|
| `fixtures/java` | 152 | 127 | 3 · 19 · 43 · 21 · 35 · 6 | 25 · 0 · 0 | 85 (73) | 17 KB | 1.2 ms |
| `fixtures/csharp` | 210 | 178 | 4 · 26 · 45 · 38 · 54 · 9 | 32 · 2 · 0 | 113 (93) | 23 KB | 1.0 ms |
| `fixtures/typescript` | 179 | 161 | 24 · 22 · 37 · 28 · 39 · 6 (+ 4 other) | 18 · 1 · 1 | 108 (87) | 29 KB | 0.8 ms |
| `fixtures/elixir` | 181 | 167 | 23 · 28 · 50 · 11 · 49 · 0 | 14 · 6 · 1 | 97 (73) | 31 KB | 0.8 ms |
| `fixtures/ruby` | 157 | 156 | 31 · 32 · 35 · 16 · 31 · 0 | 1 · 11 · 1 | 107 (87) | 36 KB | 0.9 ms |
| BroadleafCommerce (Java) | 76 310 | 72 843 | 502 · 3 305 · 21 201 · 8 521 · 22 528 · 15 742 | 3 467 · 1 044 · 6 | 3 381 (3 191) | 2.9 MB | 290 ms |
| codegraph, self-hosted (TypeScript) | 30 873 | 24 696 | 428 · 587 · 1 751 · 5 517 · 6 491 · 9 914 | 6 177 · 8 · 0 | 2 143 (1 994) | 0.8 MB | 71 ms |
| Mastodon (Ruby) — no locals by construction | 20 358 | 20 276 | 3 379 · 2 360 · 8 906 · 2 373 · 3 058 · 0 | 82 · 200 · 652 | 2 447 (2 294) | 3.2 MB | 100 ms |
| Plausible (Elixir) — no locals by construction | 16 435 | 15 520 | 1 300 · 1 355 · 5 052 · 1 273 · 6 416 · 0 | 915 · 124 · 306 | 1 999 (1 845) | 1.8 MB | 68 ms |

What the unnamed are: Broadleaf's 3 140 constructors and 327 lambdas;
codegraph's 6 154 arrow functions — a fifth of its entities, the price of a
codebase written in `const f = () => …` callbacks, whose names are the
attributes that hold them; Mastodon's 82 and Plausible's 915 anonymous
parameters (splats, patterns). Mastodon's 652 numeric tokens are the
timestamps of `db/migrate/` file names. The artifact grows with SCOPES, not
entities: Mastodon's 5 739 (a file is a module) outweigh Broadleaf's 3 807 on
a quarter of the entities. End to end, `codegraph vocabulary` on Broadleaf
takes 2.2 s with `--no-cache` (the load dominates), Mastodon 0.8 s; no cap is
needed.

The Broadleaf top ten by weight under `domain` is the issue's sanity check
— it must read as a commerce vocabulary (`order`, `product`, `customer`,
`offer`, `sku`, `fulfillment`, `payment`, `catalog`…), and whatever
technical word leaks into it names a missing entry of the shared list, fixed
as data. **Reviewed.** Under the 125-word list it read `order name type
field item customer offer extension value product`; after the correction
below, `order 8 588 · item 4 883 · customer 4 020 · offer 3 514 · product
2 917 · admin 2 890 · group 2 666 · fulfillment 2 368 · category 2 319 ·
payment 2 281` — `admin` is the back office, `group` the fulfillment group
and the admin's field group, both Broadleaf's own words. **The correction**,
13 words added to the shared list (125 → 138), each read off its carriers,
never off its spelling: `name type value key map property field` (the data
vocabulary of every language: `getName`, `propertyName`, `cacheKey`,
`parsedValue`, `itemMap`, `FieldMetadata`), `extension extensions` (the
`…ExtensionManager`/`…ExtensionHandler` pattern; moved from the C# profile,
since a word two lists hold is the shared list's), `read` (the R of CRUD,
missing from a list that claimed the CRUD verbs: `readStaticAssetById`), and,
from Mastodon's top ten, `serializer`, `worker` (`app/serializers/`,
`app/workers/`) and `index` (search indexes, database indexes, array
positions, `index.ts`, the controller action — machinery in all four
corpora). Kept as domain because their carriers are mixed: `policy`
(Mastodon's Pundit policies, but also its privacy and quote-approval
policies), `change`, `query`, `collection`. The others' top ten, after:
codegraph `edge kind required optional graph file path module edges city` —
its domain IS code, so the list costs it `type`, `name` and `index`, which a
`--technical` file gives back; Mastodon `account status accounts statuses
domain policy change collection user block` (`domain` is the federation's:
domain blocks); Plausible `plausible site query team user change stats email
event plan` (`plausible` is every module's namespace, as `acme` is the
fixtures').

### 20.2 The cloud, the tab, the city channel (M19b)

**Layout** (`layout.ts`): pure geometry, no randomness. Terms by weight
descending; font size interpolated between a minimum and a maximum on the
square root of the weight (area reads as magnitude); each box placed on an
Archimedean spiral from the centre, first position with no axis-aligned
overlap against what is placed, the canvas growing when the spiral leaves
it. The text measurer is INJECTED — `measure(text, size) → { width, height }`
— with a monospace default (0.6 em advance per code point, 1.2 em line) that
is exact for the font the SVG declares, and the browser passes
`canvas.measureText` for its proportional face. Properties: no two placed
boxes intersect; every box lies inside the reported viewBox; the same input
gives the same positions; placement order is weight order. **As built**
(`cloud.ts`, type imports only, so a page runs it without the pipeline):
12 to 56 px rounded to the pixel, 4 px kept clear on each side (2 px let
neighbours touch on screen), the spiral stretched 2:1 for a landscape image,
ties by text then class so ANY order of the same words lays out the same;
the monospace measurer counts a combining mark as no cell and a Han, kana,
Hangul or fullwidth character as two, as a terminal draws them; the spiral's
points are whole pixels and the SVG rounds to 1/100 px.

**SVG** (`svg.ts`): size by weight, colour by class and nothing else
(`domain` in ink, `technical` muted, `keyword` and `short` faint — meaning
controls appearance), a legend naming the scope, the weight scheme, the
class filter and the counts, a monospace font stack. Deterministic bytes:
`fixtures/java/expected/vocabulary.svg` is a snapshot, and the demo image is
this command's output on a public corpus, committed under `docs/`.
`codegraph vocabulary --svg FILE [--scope ID] [--top N] [--class …]`.
**As built** (`vocabularyCloudSvg`): the palette is a stylesheet keyed by
class, light and dark (`prefers-color-scheme`), so a word carries one class
attribute and no fill; a key line appears when more than one class is drawn;
the legend's three lines are the scope and its counts, the weights, and the
view with the technical list's size and digest. `docs/vocabulary-broadleaf.svg`
is BroadleafCommerce's corpus at `--top 80` (6.7 KB; 1.9 s end to end, the
load dominating) — `order item customer product offer fulfillment payment sku
cart catalog…`, the commerce vocabulary §20.1 asked for.

**`serve`** builds `vocabulary.json` from the same graph and view as the two
others and serves it at `/vocabulary.json`; evidence is a LOOKUP,
`/carriers.json?scope=ID&term=order` → the entities of that scope whose
names carry the word (name, kind, role, anchor, and the id when the entity
is a type or module — the hand-off key), from the in-memory model `serve`
already holds; an unknown scope or term is 404, like `/insight.json`. The
artifact stays small (counts, not lists) and a static host degrades to no
evidence rather than to a bigger file. **As built** (`carriers.ts`,
`carriers-route.ts`): the counting rule moved to `reading.ts` so the
artifact and the carriers read a name the same way, and A ROW IS THE SUM OF
ITS CARRIERS — weights, occurrences and count — a property over every term
of every scope of the six fixtures; an artifact counted under other weights,
another list or another view is refused. A member carries no id and an
`owner` (its type, else its module), the navigator's rule. No `scope` is the
corpus; `class` disambiguates a text two languages class apart (`ambiguous`,
400, lists the classes); `limit` defaults to 200 and `total` always counts
them all. The index is built at the first answerable request, reading every
kept entity once, and the graph is released then. The app daemon builds
`vocabulary.json` with the other two, but holds no model between jobs, so it
has no `/carriers.json`: the tab shows the counts and says why there are no
names. On Broadleaf the artifact is 2.9 MB and `order` at the corpus has
3 303 carriers.

**The Vocabulary tab** (`navigator-ui`, the sixth): the cloud of the current
scope — the corpus until a module or a type is selected in Navigate, then
that scope, the way the explanation panel follows the selection — with class
chips (default `domain`), a `--top` slider, and beside it the table (term,
weight, occurrences, carriers, spread). Clicking a word asks `/carriers.json`
and lists the carriers; a type or module among them reveals in Navigate (its
`id`), a member reveals its type. The tab restates the artifact kind and
`TERM_CLASSES` as literals pinned equal to the package's by a test, imports
`@codegraph/vocabulary` for TYPES only (the frontend rule), and the layout
runs in the browser with the page's own measurer — the same function the
CLI ran. Reviewed as screenshots on Broadleaf: the corpus, `catalog.domain`,
`ProductImpl`. **As built**: the layout is a VALUE import through
`@codegraph/vocabulary/cloud`, a tsup entry of `cloud.ts` alone whose shared
chunk imports nothing; the guard test allows that one specifier and keeps
the package's index types-only. The measurer is `canvas.measureText` in the
page's monospace face (the page sets identifiers in mono; so does the SVG),
the colours the page's paper, dimmed and faint — no hue, since the page's
four hues already mean direction, inference and selection. The scope chain
(corpus › module › … › type) steps up by selecting the scope's node, the
corpus by clearing the selection. The tab mounts on first visit and stays
mounted, refetching `vocabulary.json` with each new navigator (the daemon's
next job). Reviewed on Broadleaf at 1600×1000: the corpus reads `order item
customer offer product admin group fulfillment category payment`;
`ProductImpl` reads `product category all sale sku parent`; `catalog.domain`
with `product` picked lists 239 carriers, and a parameter among them reveals
its owner, `Category`, in Navigate; a page with no carriers route keeps the
counts and says so.

**The city channel**: `vocabulary:<term>` as a metric source for `--height`,
`--footprint` and `--carry` — the term's weight in the building's type scope,
`undefined` where the type does not speak it, so an unmeasured building is
floored and labelled, never zeroed. Wired through the CLI's `metric(name)`
hook exactly as `history:` is (`history-metrics.ts`); `@codegraph/city` is
unchanged. `codegraph serve model.jsonl --height vocabulary:order` is "where
does `order` live" — the issue's city link, and the second demo image.

**As built** (`vocabulary-metric.ts`): a HEIGHT, not a colour — this plan
first said `--color`, but the city's one colour channel is the framework's
categorical `role`, and a weight is a magnitude. A type whose names never say
the word weighs **0**, not `undefined`: its names were read and zero is what
they say, and `undefined` there would have printed "N unmeasured" on every
such city for a measured fact. `undefined` stays for a building with no type
scope — a stub, whose names the vocabulary never reads. The word goes
through the splitter (`Order` is `order`; `OrderLine`, two words, is a usage
error); the classes two languages give one text add up, the metric being
about the text; a word no name in the view says is a usage error rather than
a flat city that looks like an answer. `serve` and the app job hand `cityOf`
the artifact they serve; `city` counts one only when a `vocabulary:` metric
is named. On Broadleaf 627 of 3 305 types say `order`, the tallest
`OrderServiceImpl` (203), the towers in `core.order.service` and
`core.offer`: `docs/vocabulary-city-broadleaf.png` is the City tab at
`--height-scale sqrt` (the root lifts a type that says the word once off the
floor: 589 of the 627 rise above 5 of 40 units, against 92 on a linear
scale), arrows hidden and the tower selected so its panel shows the number. The viewer's help no longer says a
taller tower "holds more code": height is whatever the legend names.

### 20.3 The glossary: words in the explanation (M19c)

What a model is asked, and OF WHAT. The deterministic part knows that
`OrderManagerRepository` is made of `order`, `manager` and `repository`,
that `order` is spoken in 61 modules and that `repository` is on the
technical list; it cannot know what `order` means in THIS class, nor that
`service` in `CustomerServiceTicket` is a domain word and not a layer. That
is a judgement about one entity, in the context of that entity — its source,
its Javadoc, its fields, what its operations were just explained to do, what
it depends on — and the pipeline already assembles exactly that context for
exactly that purpose: the context pack `explain` builds before it asks the
model to explain the entity (`context.ts`). **So the glossary is not a
second thing beside the explanations. It is IN them: an explained entity's
record carries the words its name is made of, each with its sense and its
concern in that entity's context, and every scope's glossary — a type's, a
module's, the corpus's — is rolled up from the records, deterministically.**
The first two drafts of this section — a standalone command over a scope's
term table, then a second request per type and module over the pack — both
asked about words at the wrong altitude: a scope has a vocabulary, but a
MEANING belongs to the entity that uses the word, and only there is the
context complete.

Three layers, each a pure function of the one below it:

| layer | what | who | cost |
|---|---|---|---|
| 1. count | names → words, classes, weights, scopes, the cloud (§20.1, §20.2) | `@codegraph/vocabulary` | none — a function of the model |
| 2. mean | per explained entity, each word of its name: sense + concern, in context | the model, inside the `explain` call it already makes | a longer completion, no extra call |
| 3. roll up | glossary per type, module, corpus; polysemy; drift between what the list says and what the model judged | readers over the store; the module call reconciles its types | none — a function of the records |

**Layer 2 — the question added to every explanation.** A unit's prompt gains
one section, *Words to define*: the words of the unit's own name and of the
names of its members that are not units themselves — an operation's
parameters, a type's fields, constants and properties — split by the
deterministic rules of §20.1 and listed with the identifier each comes from
(`order (OrderManagerRepository)`, `total, amount (totalAmount)`). The
words are GIVEN, not chosen: the model cannot define a word the name does
not spell, and the deterministic class is deliberately withheld so the
judgement is the model's — the gap between the two is layer 3's first
report. Words of class `short` and `keyword` are not asked (`i`, `x`,
`type`); `technical` ones are, since a technical word in a domain position
is the whole point (`service`, `manager`, `handler`). *Nor, since, are
function words (`or`, `of`, `all`): "As built — function words".* Locals and
lambda parameters are counted (weight 1) and not defined (§20.5). The block
gains:

```ts
words: [{
  word,                                    // as the splitter spelled it, lowercase
  in: string[],                            // the identifiers of this unit it appears in
  concern: "domain" | "technical" | "ambiguous",
  sense,                                   // a short label: the signified
  meaning,                                 // one sentence, in THIS entity's context
  confidence
}]
```

One entry per word per unit — one entity means one thing by a word; an
entity that does not is `ambiguous`, with the two senses in `meaning`. The
module block, which already quotes its types' summaries, is additionally
shown its types' `words` entries (from the store, through the same
projection discipline as summaries: one JSON path, never the block) and
gains:

```ts
glossary: [{ word, concern, sense, meaning,
             polysemous: boolean,          // its types disagree on the word
             senses: [{ in: string, sense }] }]   // the disagreeing types, when they do
```

— the module-level reconciliation of what its types said, over the words
its types spell (cut at `--terms N`, default 60, by weight). Its existing
`ubiquitousLanguage` keeps its role (terms the model proposes, in its
words); `glossary` is over the words the CODE spells. The corpus level has
no call: a reader lays the modules' senses of a word side by side (below).

**Why in the block, this time.** M11 put `PROMPT_VERSION` into every
fingerprint precisely so a better prompt re-explains what it improves; a
shape change is the designed case, not a hazard. `PROMPT_VERSION` becomes
`"2"`; a store explained under `"1"` keeps every record until a run replaces
it (the store is not a cache — nothing is deleted by the bump), and a reader
meeting a record without `words` says "not defined under this prompt", as
`answerInsight` already distinguishes failed from unknown. `words` and
`glossary` are `.optional()` in the record schema so a version-1 record
decodes and re-encodes to its own bytes — the round-trip identity holds for
every existing side-car — while `strictify` makes them required in the
response schema sent to the provider, as it makes every property. **The
side-car format does not change**: no new record type, no new trailer
count, nothing on failures; the words ride inside `block`, where `concept`
and `confidence` already do.

**The store**: `INSIGHTS_DB_VERSION = 2`, migration index 1 — the first rung
of the ladder to run on a real file: a PROJECTION table `insight_word (id,
word, in, concern, sense, confidence)` written from the block in the same
transaction as the record (the `glossary_term` idea of the previous draft,
at the right altitude), indexed on `word`; nothing to backfill, since no
version-1 block holds words. Tests: a version-1 store with N insights and M
failures migrates with N and M intact and exports the same bytes as before;
a version-3 file is refused untouched; `insight_word` is rebuilt from the
blocks on `--import`, so the side-car stays the one source of truth.

**Fingerprints.** The word list is a function of the lexicon (profile data)
and of the names already hashed through `signatures` and `factsDigest`; it
joins the fingerprint inputs anyway, so a lexicon correction re-explains
exactly the units whose words it changed. A module's fingerprint already
takes its types' fingerprints, which now cover their words.

**Cost.** No new call. A completion grows by roughly 30 tokens per word:
an operation defines ~4 (its name and its parameters), a type ~10 (its name
and its fields), a module ~60 glossary entries at ~40. Broadleaf, estimated
and to be replaced by the measurement: 24 392 × 4 × 30 + 3 312 × 10 × 30 +
502 × 60 × 40 ≈ 5 M completion tokens, about **$3 on top of a run** at $0.60
per million out; and the bump re-explains the existing side-car once
(measured at $4.70 under `deepseek-v4.1-flash`), which `--estimate` prints
before anyone pays.

**Measured (2026-10-29) — the estimate above is replaced.** The test corpus is
Spring PetClinic, not Broadleaf (the user's decision: small enough to read
every answer). A live prompt-2 run, gpt-5.6-luna, `--max-tokens 6000`: 106
calls, 228 177 prompt + 96 356 completion tokens, $0.1343, no failure;
`--estimate` had said 66 570 out (−31%). Each call's prompt was rebuilt with
the planner (`contextPackFor` + `renderPrompts` over the run's own records;
their estimates sum to the run's, token for token) and its measured completion
tokens fitted on what it asked, reasoning tokens included since they are
billed: **466 / 534 / 527 per operation / type / module block, 121 per word,
123 per glossary entry** (r² 0.81 per call; the old figures 0.13), rounded
into `COMPLETION_TOKENS_PER_BLOCK` = 470 / 530 / 530 and 120 / 125. A word
entry's own JSON is ~50 tokens; the rest is the reasoning that goes with it.
Fitted on one half of the calls, the other half's total is predicted within
−7% and +15% (±6% without the module calls), against −29% and −33% before.
The glossary figure rests on five module calls (one half-sample fits 342): a
corpus with more modules should refit it. Per word, at the run's fitted
prices ($0.067/M in, $1.256/M out), ~$0.00015. Input, unchanged here: the
planned prompts were 15% under the measured input — 7.9% because a cold
estimate cannot quote explanations no run has written yet, 6.3% because this
model's tokenizer packs 3.76 characters per token, not 4.

**Layer 3 — readers, all over the store, none calling anything.**
`codegraph insights --word order` — every entity whose names spell it,
grouped module → type → operation, each with the identifiers it is in, its
concern, sense and confidence, then the module-level `glossary` entries
with their `polysemous` flag: the signifier/signified glossary of the issue,
at every scope, from one index lookup. `--glossary MODULE_ID` — a module's
reconciled glossary whole. `--polysemy` — the words a module flagged, and
the words whose module-level senses differ across the corpus, side by side
for a human to judge (the corpus has no call to judge for it). *A flag
counts when its senses are two: "As built — two senses to a polysemy".* `--concerns`
— per module, how many of its words the model called domain, technical,
ambiguous: the cognitive-load proxy split by kind. `codegraph vocabulary
--drift-insights` — the deterministic classes against the model's concerns
(words the technical list calls technical that the model judged domain
somewhere, and the reverse, with the entities), plus the business list of
§20.1 against both; it opens the store as a reader beside the model, which
`insights` (store only) cannot. `serve` gains `/glossary.json?scope=ID&term=
order` — the entries of the entities under that scope, from `insight_word`
— over the same reader as `/insight.json`; the Vocabulary tab shows them
under a clicked word, each in the `--inference` colour with the model badge,
and the Navigate explanation panel renders `words` and `glossary` through
the same generic `blockFacts` it renders everything else with: an inference
never looks like a fact.

**As built — layer 2 (2026-10-27).** As designed, with these decisions:

- **The own name's words only.** A qualifier's words are its container's,
  asked where they are the own name: `com.acme.order` is asked for `order`,
  `AcmeOrder::OrderLine` for `order, line`. `definitionSpeller` in
  `@codegraph/vocabulary` (`define.ts`) splits and classifies exactly as the
  cloud does and keeps `domain` and `technical`; it takes no technical list,
  since that list only moves a word between two classes that are both asked.
- **A port, not an import.** `@codegraph/insights` imports nothing from the
  vocabulary, not even types: the context env takes a `Speller`
  (`words(id)`, `ranked(moduleId)`) and the CLI hands in `definitionSpeller`
  and `rankedWords` over the run's `buildVocabulary`, built on first ask.
- **Kept on receipt.** The words are given: an entry for a word the prompt
  did not list is dropped, a word given twice keeps its first entry, and
  `in` is restated from the split, a fact the prompt stated. A module's
  glossary is filtered the same way. An answer without `words` (or a
  module's without `glossary`) gets the repair re-ask, then a failure.
- **Templated records carry no `words`**: no model judged them. The
  definition of done's "every record carries `words`" holds for every
  record a model wrote.
- **The glossary's candidates** are the words its types' prompts asked
  (their names and fields), ordered by the module's vocabulary row order (an
  unranked word after, by text) and cut at `--terms`. The module prompt
  shows, per word, each type's `concern`, `sense` and `meaning`, or "no type
  defined it", read through `RecordSource.words(id)` (a `block -> '$.words'`
  projection in the store) only when the prompt renders. *Since, a word no
  type defined is not shown: "As built — only defined words reconciled".*
- **Fingerprints** take, per member, the identifiers and words asked and a
  module's glossary words; never what a type said of them. The same
  `--terms` reuses every module, and another redoes exactly the modules whose
  cut moved.
- **The estimate** adds 30 completion tokens per word and 40 per glossary
  entry, this section's figures, until a run measures them. On the Java
  fixture the plan goes from 102 786 to 114 483 prompt tokens (+11%) and
  from 36 650 to 41 670 completion tokens (+14%). *Measured since (the
  Cost paragraph): 120 per word, 125 per entry, blocks 470 / 530 / 530; the
  fixture's plan now says 52 900 completion tokens.*

**As built — the store (2026-10-27).** `INSIGHTS_DB_VERSION = 2`. Migration 1
creates `insight_word (id, entry)`, indexed on `word` and on `id`. `entry` is
the word entry as JSON text, without its `meaning`; `word`, `concern`, `sense`
and `confidence` are generated columns over it. The decisions:

- **JSON text with generated columns, as `insight` has.** These strings come
  from a model or a side-car, and a plain column cannot hold U+0000 (the binding
  reads it back cut short). The round-trip property's words are binary strings,
  and they import whole. `in` rides in `entry`: it is a reserved word in SQL.
- **No `meaning`.** A sentence per entry was a third of the table at Broadleaf's
  scale. An answer that shows it reads the block, by the M16b rule this
  section's table cites.
- **Backfilled after all.** This section said there was nothing to backfill,
  but a build that asked prompt 2 while its store was still at version 1 (#35)
  writes words into version-1 blocks. The migration projects them.
- **Written per record**, in the unit's transaction: first the replaced
  record's rows are deleted, then the record is written, then its rows. An
  import deletes the whole table and rebuilds it from the blocks. There is one
  row per entry, a repeated word included: the projection says what the block
  says.
- **A reader still refuses an older store** (M16c). The refusal now names the
  free way out: any `explain` on the store migrates it, `--dry-run` included. So
  `serve`'s panel shows nothing on a version-1 store until then.
- **Tested from a real file.** `packages/insights/test/fixtures/store-v1.sql`
  is the `.dump` of a store the version-1 build wrote (6 records, 2 failures, a
  run, 2 blocks with words), kept with the export that build wrote.
- **Scale, on a synthetic side-car** with Broadleaf's counts and this section's
  word estimates (28 206 records, 131 190 entries): the import takes 1.5 s and
  the export is byte-identical. The projection is 22 MB of a 91 MB store,
  `WHERE word = 'order'` takes 0.5 ms, and the migration's backfill 0.6 s. The
  real file is PetClinic's (139 records, `cmp`-identical; §20.4's definition
  of done), not Broadleaf's.

**As built — the store's readers (2026-10-27).** `codegraph insights --word`,
`--glossary`, `--polysemy` and `--concerns`, over `glossary.ts` in
`@codegraph/insights` and four projections of the port (`wordHits`,
`glossaryEntries`, `concernRows`, `withoutWords`). The decisions:

- **The module comes from the natural key.** `insights` opens the store alone,
  so a record is placed by its key: core renders the module's id from `lang`
  and `module`, groups compare through `naturalKeyIndex`, and the id is never
  parsed. "Grouped module → type → operation" is by level within each module:
  an operation is not nested under its type, which only the model knows.
- **Tab-separated, like the command's other lists**, the module first so the
  grouping survives `sort`. A module's glossary entry heads its group. The
  entries show no `meaning`: the projection does not hold it, and `--glossary`
  and `--id` read it from the block.
- **Polysemy across modules** is two entries that differ in concern or in
  sense, case and spacing aside: the wording varies from call to call, and an
  exact comparison would list every word two modules define. The most senses
  first.
- **Concerns** count distinct words per concern, so a word two units of one
  module judged differently counts under both.
- **The prompt-1 answer** (`wordsAbsence`): a record a model wrote without
  `words` is prompt 1's, one no model wrote is a template's. `--id` says which,
  `--glossary` on such a module says why it has none, and the summary and every
  word answer count what they cannot see.
- **Lookup is exact for any string.** The `word` index holds what `->>` made of
  the word; a lone surrogate's bytes are not the binding's, so such a word is
  looked for by a scan, and JS equality decides either way.
- **Measured** through the CLI on the synthetic store at Broadleaf's scale:
  `--word order` (549 entries, 19 glossary entries) 0.46 s, `--polysemy`
  0.48 s, `--concerns` 0.54 s, Node's start included. The re-explained
  Broadleaf store is owed, as above.

**As built — `vocabulary --drift-insights` (2026-10-28).** `concernDrift` and
`businessJudged` in `@codegraph/vocabulary` (`concern-drift.ts`), fed by the
store's `wordHits()`, which with no word now returns every entry. The decisions:

- **Neither package imports the other.** The vocabulary package takes
  `WordJudgement`s in its own shape and restates the three concerns
  (`JUDGED_CONCERNS`), pinned equal to the insights block's by a CLI test; the
  command maps the store's rows into them.
- **The class is the list's, per entity.** Each judgement's word is classed as
  `buildVocabulary` would class it in that entity's language (read from the
  union) under the list in effect, `--technical` included. So a word judged in
  two languages may be two rows (`select`: Java `domain`, Go `keyword`).
- **Two lists.** The technical words a model judged domain somewhere, and the
  domain words it judged technical, ranked by the judgements against, ties by
  word; `--top N` cuts each (40). `ambiguous` is counted and contradicts
  neither class; a `keyword` or `short` word (a lexicon corrected since) is
  counted and contradicts nothing.
- **Kept as the vocabulary keeps.** A record of an id the model does not hold
  (explained against another version of it) or the view does not keep is left
  out and counted on stderr, as are prompt-1 records.
- **The surest five.** A word's judgements against are ordered by confidence,
  then by id; the text shows five per word and says how many more, `--json`
  every one. On Broadleaf every judgement in full was 6 868 lines, each padded
  to the longest operation id (≈ 600 characters), so the entity now comes last,
  unpadded: `getSectionKey in java:…AdminFieldController.getSectionKey(…)`.
- **The business list against both** (`--drift FILE` beside it): each term's
  words with the classes the corpus says them under and the model's concerns
  over every entity; a term drifts on a word the list does not call domain
  (`list`) or a model judged technical somewhere (`model`).
- **A judgement never sets the exit code.** It is an inference; `--drift`
  keeps its own exit 3 for a term the corpus never says (`said` is the
  corpus-level drift's answer, pinned by a test).
- **The store** is beside the first model, or `--insights FILE` (serve's flag
  name); missing or unmigrated, a usage error before the model is read.
  `--scope`, `--level`, `--class` and `--svg` with it, and `--insights`
  without it, are usage errors. `--json` is `report: "drift-insights"` in
  `codegraph.vocabularyReport/1`.
- **Measured** on a store built over Broadleaf's own ids (29 098 records, the
  words `definitionSpeller` asks plus parameters and attributes: 109 208
  entries, 12 % judged against the list): 4.1 s end to end against 3.2 s for
  the plain report on the same machine (an x86-64 Linux box, slower than the
  M1 of §20.1), at the same peak memory (≈ 0.5 GB). A store a model wrote is
  owed, as above.

**As built — the glossary in the page (2026-10-28).** `/glossary.json`, the
Vocabulary tab's entries and the Navigate panel's, over `answerGlossary` in
`@codegraph/insights` (`glossary.ts`). The decisions:

- **The scope is the model's, injected.** `answerGlossary(store, query,
  placement)` takes a `Placement` (an id → its containing module and type);
  the CLI builds it from the analyzer's fold over the entities the view keeps,
  so a word's carriers and its glossary are of the same entities, and the
  package still opens no model. Under a module: what folds into it, its own
  record included; under a type: the type and its members. A module's
  reconciliation is under its module and the corpus, not under a type. A scope
  is a kept module or type; anything else is `unknown-scope`, 404.
- **One store reader.** `insightLookup` and `glossaryLookup` share
  `storeReader(path)`, opened at the first request that finds the file. No
  store is `{status: "no-store"}`, 404, and the tab shows nothing. The
  placement is built at the first request a store can answer, then the graph
  is let go, as for the carriers.
- **The answer** is the projection's entries without the natural key (the
  page has no use for it), an operation's `owner` (its type, else its module:
  the node a page reveals), ordered module, types, operations, then by id; the
  modules' glossary entries whole. Each list is cut at `limit` (200) with its
  total. No `meaning` per entity: the projection does not hold it, and the
  panel shows it from the block. `withoutWords` is the store's.
- **The tab** lists them under the clicked word's carriers, inside the
  explanation panel's border and badge (`LLM glossary`), with the models that
  wrote them; an entry reveals its entity in Navigate (an operation, its type);
  the prompt-1 records are counted in a footnote.
- **The panel reads `words` and `glossary` by name** — the one exception to
  its generic block rendering, since generically a word entry showed the
  identifiers where a definition reads, and a glossary entry lost the types
  that disagree: `order (domain) — sense. Meaning. In Order · 0.90`.
- **One remembered lookup** (`lookup.ts`): the insight, carriers and glossary
  loaders ask once per URL and stop asking a server with no such route.
- **Measured** on the Broadleaf store of the previous note: the first request
  takes 0.21 s with the placement built, later ones 0.11 s; `order` over the
  corpus is 1 908 entries, 200 sent (53 KB). The server's RSS after a click
  is the same within noise (605 MB, against 619 MB without the route).
  Screenshots reviewed at 1600×1000 on the Java fixture (a hand-worded store
  over its ids) and on Broadleaf.

**As built — function words (2026-11-03).** The PetClinic run defined `by`,
`with`, `is`, `of`, `all` and `or` (10 of its 301 word entries), and the
`owner` module reconciled `or` into a glossary entry flagged `ambiguous`.
Their senses were grammar ("lookup criterion", "boolean predicate",
"identifier connector"), and `--polysemy` listed `or`. The decisions:

- **A list in `define.ts`, not a fifth class.** `definitionSpeller` and
  `rankedWords` leave out `FUNCTION_WORDS` (60 words: articles and
  determiners, pronouns, conjunctions, prepositions, auxiliaries and modals,
  `not`) whatever class the word has: `or` is on the technical list, `all`
  is domain. The cloud, the classes and drift are unchanged, every word still
  counted and tagged (§20.1). A class would have moved the artifact, the
  tab's toggles and `--class` for a question only layer 2 asks.
- **Not on the list:** a word that names a thing as often as it joins two —
  `no` (a number), `may`, `will`, the particles of phrasal verbs (`out` of
  `checkOut`, `up` of `signUp`), the prepositions of time and order
  (`before`, `after`, `between`). And only English: `du` of `getNomDuClient`
  is still asked.
- **No option.** `explain` takes no technical list either (layer 2's as-built
  note); a correction to the list is a code change, and the fingerprint
  shows what it touches.
- **What it costs a store already paid for.** The asked words are in the
  fingerprint, so a unit whose names spell a function word goes stale, and
  through the Merkle chain so does every unit that depends on it. On
  PetClinic, `--dry-run` goes from 106 reused calls to 53 to redo (~121 k
  prompt, ~56 k completion tokens, about $0.08 at the run's prices): 9 units
  directly (7 operations, 2 controllers with an `…_OR_…` view field), 44
  through their dependencies. Nothing is lost before a run: the old records
  stay, and the readers show their entries until they are replaced. *(The 44
  are gone for stores stamped since: "As built — the words leave the
  chain".)*
- **The Java fixture's plan** is now 114 474 prompt and 52 415 completion
  tokens (was 114 483 and 52 900).

**As built — only defined words reconciled (2026-11-03).** Of the ~50
words the PetClinic modules were asked to reconcile, 2 no type had defined:
`Pet` skipped `birth` (of `birthDate`), and the `owner` module paid for
`birth`, "ambiguous: undefined term"; `BaseEntity` skipped `base`, and the
`model` module wrote it a meaning anyway. The decisions:

- **Asked = a type defined it.** `glossaryAsked(member)` in `context.ts` keeps
  the candidates with at least one type entry; the prompt lists those, and on
  receipt the module's glossary keeps only those. The "no type defined it"
  line is gone. A module whose candidates all went undefined shows no
  glossary section and keeps an empty `glossary`.
- **The candidates stay hashed, not the asked.** The fingerprint takes the
  cut list as before; which of it a type defined is read when the prompt
  renders, like the summaries it quotes. No record goes stale: PetClinic's
  `--dry-run` statuses are the same, unit by unit. A type that is
  re-explained changes the module's fingerprint already, as its container.
- **Cut, then filter.** `--terms N` still cuts the candidates; a module asks
  at most N, fewer when some went undefined. Filtering first would make the
  hashed cut a function of what the types said.
- **The estimate** counts a candidate unless every type that spells it has
  `words` and none defined it: a type not explained yet, or under prompt 1,
  may still define it, so a cold plan counts every candidate as before. On
  PetClinic's warm plan, 250 completion tokens fewer (`birth`, `base`). A cold
  module prompt now prints no glossary lines at all, so the plan's input is a
  little lower (the Java fixture: 114 136 prompt tokens, was 114 474).

**As built — two senses to a polysemy (2026-11-03).** PetClinic's `owner`
module flagged `owners` polysemous and listed its three types, each giving
the one sense "owner repository dependency", and `or`, two types and one
sense: 2 of the run's 16 flags, over 52 glossary entries. `--polysemy` listed
both, and the page said "its types disagree" with nothing to disagree on.
The decisions:

- **A flag counts when its senses bear it out.** `typesDisagree(entry)` in
  `glossary.ts`: `polysemous`, and two distinct `senses` at least, case and
  spacing aside — the comparison `--polysemy` already made across modules.
  The flag is the model's judgement of meaning, the senses its evidence; both
  are needed, so two wordings the model did not flag stay one sense.
- **Read, not rewritten.** The record keeps what the model wrote: the store
  is not a cache, and the side-car's decode → import → export stays the
  identity. `--polysemy`,
  `--word`, `--glossary`, the Vocabulary tab and the Navigate panel ask the
  rule; the page restates it (it imports nothing of `@codegraph/insights`),
  pinned to the package's by a test over the same cases.
- **A flag that does not hold adds no sense** to a word's count in
  `--polysemy`: its one sense rewords the entry's own.
- **Lexical, not semantic.** `pet`'s four wordings of "animal under care" in
  the same module stay four senses: judging meaning is a model call, and the
  readers make none.
- **The prompt is unchanged.** It already asks for a flag only where the
  types disagree; rewording it is a new `PROMPT_VERSION`, which every
  fingerprint includes — 106 calls again on PetClinic — for what a reader
  can check. No fingerprint input moved: no record goes stale.
- **On PetClinic** `--polysemy` lists 14 words, was 16 (`owners` and `or`
  gone; `or` is no longer asked at all since the function words).

**As built — the words leave the chain (2026-11-15).** The function words
made 9 PetClinic units stale and 44 more only because a dependent hashed its
dependencies' whole fingerprints, words included — though no caller's prompt
shows a callee's words (`DependencySummary`: summary and concept). The user's
choice among four (keep the cascade; split the hash; a words-only re-ask; no
words in the fingerprint): split it. The decisions:

- **Two hashes per unit.** `unitHashes` in `plan.ts` gives the fingerprint
  (stored, as before) and the *chain* — `chainOf` in `fingerprint.ts`, every
  input but the words, over the dependencies' chains; never stored. A
  dependent hashes a dependency's chain unless its prompt reads that
  dependency's words: `readsWordsOf(unit, dependency)`, true for a module and
  its types only, since it reconciles their entries (`context.ts`). Its own
  candidates are hashed as before; its types' whole fingerprints cover an
  entry that changed under a candidate that did not.
- **What still cascades:** source, comments, signatures, facts, model,
  depth, prompt version, a missing dependency — all in the chain. A words-only
  change re-explains the units whose words moved and the modules above those
  types.
- **No store re-explained for the switch.** A record stamped under the fold
  before is reused while that stamp matches (`stampedBeforeSplit`, computed
  beside the fingerprint, read for `reuse` only): a match means every
  transitive input is unchanged, words included, so the split would reuse it
  too. A leaf's two stamps are one. What is re-explained gets the new stamp;
  nothing is rewritten on reuse. The cost: an old stamp cannot tell a
  dependency's words from its source, so a store stamped before still pays
  the 53 once.
- **Measured on PetClinic** (the paid store, on a copy; stamps restated under
  the words as they were before the function words): the old fold's 106
  stamps reproduced exactly (0 calls); the function words then cost 53 calls
  as stamped (121 067 in, 55 665 out, ~$0.08) and **10** stamped under the
  split (7 operations, 2 types, 1 module; 26 758 in, 12 925 out, ~$0.02).
- **Tests:** a callee's words leave its callers and its type reused; a type's
  words re-explain its module even when the module's candidates did not move;
  a type depending on it and a module importing its module stay reused; a
  source change still reaches every dependent; old stamps reused while
  nothing changed, followed once more on a dependency's words, refused on a
  source change. Six mutants (no module rule, the old fold, old stamps
  refused, words in the chain, whole fingerprints in the chain, the run
  stamping the chain) each fail at least one.

### 20.4 Milestone split

**M19a — the lexicon, the split, the artifact** (closes the profile half of #19)

- [x] `Profile.lexicon` in core: type, `ProfileSchema`, METAMODEL §5 row,
      the eleven profiles filled (keywords from each language's
      specification; conventional names from its runtime), `codegraph
      profiles --lang` printing it; the lexicon's validation codes and tests; `schemas/`
      unchanged, proven by the drift check.
- [x] `packages/vocabulary/` (`@codegraph/vocabulary`, depends on core and
      analyzer only): `split.ts`, `classify.ts` with `DEFAULT_TECHNICAL`,
      `weight.ts`; the hand tables per idiom and the properties of §20.1;
      the unicode fixture through the splitter; the shared words out of
      the profiles.
- [x] `qualified` in the lexicon (the kinds named by a qualified path and
      their separators), its validation code, `profiles --lang` printing it;
      the splitter's `qualifier` count and the `qualifier` weight.
- [x] `aggregate.ts` on `containingType`/`containingModule`, `artifact.ts`
      (`codegraph.vocabulary/1`); the package now depends on the analyzer.
- [x] `drift.ts` and `codegraph vocabulary` (§20.1): the report, `--level`,
      `--scope` (an operation's scope on demand), `--class`, `--weights`,
      `--technical`, `--drift` (exit 3 on a term spoken nowhere), `--out`,
      `--json`, the view flags; usage errors for an unknown scope, role or
      class; `docs/cli.md`, the website's command and `vocabulary.json`
      pages.
- [x] `fixtures/<lang>/expected/vocabulary.json` for the five fixtures and
      `fixtures/unicode`, byte-identical on every run
      (`CODEGRAPH_UPDATE_SNAPSHOTS=1` rewrites them); hand counts in each
      fixture's README (`order` in the Java fixture: which names, which
      weights), pinned by a test; the closure and determinism properties over
      every fixture.
- [x] The coverage table of §20.1 filled on the fixtures, Broadleaf,
      codegraph itself, Mastodon and Plausible; the Broadleaf top ten
      reviewed; the technical list corrected as data where it leaked
      (13 words, 125 → 138).

**M19b — the cloud, the tab, the city channel**

- [x] `layout.ts` and `svg.ts` with their properties and the SVG snapshot;
      `--svg` (the layout is `cloud.ts`).
- [x] `serve`: `/vocabulary.json` built with the two others,
      `/carriers.json` as a lookup; both on the app daemon's page for free
      (the artifact rides the same build), the lookups following the
      insight route's precedent (the daemon has neither lookup).
- [x] The Vocabulary tab: cloud, chips, table, carriers, reveal; the
      literal-pinning and types-only boundary tests; screenshots on
      Broadleaf reviewed at user-facing sizes.
- [x] `vocabulary:<term>` metric source through the `metric(name)` hook;
      `--height vocabulary:order` on Broadleaf reviewed as a screenshot.
- [x] The demo images: the corpus cloud of a public repository as SVG
      (`docs/vocabulary-<corpus>.svg` — Broadleaf's, committed with `--svg`)
      and the city raised by one term, with the README section that shows
      them — the issue's fourth acceptance criterion.

**M19c — the glossary: words in the explanation**

- [x] `words` on the three blocks and `glossary` on the module block,
      `.optional()` in the record schema and required on the wire;
      `PROMPT_VERSION = "2"`; the *Words to define* prompt section fed by
      `@codegraph/vocabulary` (types only, through the env); the module
      prompt quoting its types' entries through a `RecordSource.words(id)`
      projection; the word list in the fingerprint inputs.
- [x] The store at version 2: migration 1 creating `insight_word`, written
      per record in the unit's transaction and rebuilt on `--import`; the
      migration tests of §20.3; the round-trip property unchanged and green
      on every existing side-car. *(Scale measured on a synthetic side-car
      at Broadleaf's counts; the real file is PetClinic's — the definition
      of done.)*
- [x] `--terms N`; `--dry-run`/`--estimate` reflecting the longer
      completions (`COMPLETION_TOKENS_PER_BLOCK` re-measured); a reader's
      answer for a record explained under prompt `"1"`; on the fake client
      and live on the Java fixture; the §20.3 estimate replaced by the
      PetClinic measurement. *(The measurement: a live run on Spring
      PetClinic in Broadleaf's place, 2026-10-29, §20.3 "Measured". The live
      run on the Java fixture: M20's, 2026-11-10 (§21.4), Claude Code with
      Sonnet under prompt `"2"` — 68 calls, 79 records, the 70 a model wrote
      every one with `words`, the 3 modules with `glossary`; the 9 templated
      operations carry none, as built.)*
- [x] Readers: `insights --word`, `--glossary`, `--polysemy`, `--concerns`;
      `vocabulary --drift-insights`; `/glossary.json`; the entries in the
      Vocabulary tab and in the Navigate panel as inferences.
- [x] `docs/vocabulary.md` (the idioms per profile, the classes, the
      weights, the artifact, the three layers, the readers, the drift
      reports); README names the feature; `docs/cli.md` the command and the
      flags; `docs/insights.md` the `words` and `glossary` fields and the
      version bump. *(`docs/vocabulary.md` is the design record VO-1…VO-16,
      merged 2026-11-05 with #45.)*

Definition of done — M19a and M19b on Broadleaf, where the demo images were
made; M19c on Spring PetClinic, the user's choice (2026-10-29): small enough
to read every answer, where re-explaining Broadleaf's 28 206 records was
not. The five `vocabulary.json` snapshots byte-identical to the package's
output; `codegraph vocabulary` on Broadleaf prints a commerce vocabulary
under `domain`; the tab and the coloured city reviewed as screenshots;
`explain` on the Java fixture, live and on the fake client, writes a
side-car whose every record a model wrote carries `words` and whose module
records carry `glossary`; `--estimate` prices a PetClinic run before it runs
and the live run's measurement replaces its per-block figures; the PetClinic
side-car (prompt `"2"`, 139 records) imports into a fresh version-2 store
with its counts intact and exports `cmp`-equal, a version-1 store migrates
(`store-v1.sql`, and the synthetic side-car at Broadleaf's scale); `insights
--word pet` on the PetClinic store answers in under a second; `pnpm -r test`,
typecheck and `./test.sh --ts` green; the coverage table and the cost filled
in this section.

**Met (2026-11-12, main `4e3aa82`).** The Java-fixture live run is M20's
(above). PetClinic, on a copy of the paid store: 139 records imported (109
operations, 76 by a model, every one with `words`; 25 types; 5 modules, each
with `glossary`: 301 word and 52 glossary entries), exported `cmp`-identical;
`insights --word pet` 0.14 s, 81 MB. `--estimate` had said 66 570 completion
tokens, the run took 96 356; refitted (§20.3 "Measured"), it now prices the
53 calls the function-word change made stale (#42) — 121 067 in, 55 665 out,
~$0.08 at the run's fitted prices — before any is sent. CI green on that
commit: the workspace's build, typecheck and tests, and the TypeScript
extractor's `cmp` gate that `./test.sh --ts` runs.

### 20.5 Deferred, explicitly

- **A source-text channel** — comments, string literals, the names of
  external members a scope calls (what it speaks TO, against what it
  declares). A second reader with its own classes, waiting for the first
  channel to prove the tags and the weights.
- **Operation scopes in the artifact.** Computable on demand; the navigator
  addresses types and modules only (a member node carries no id), so the
  page could not ask for one. The day it can, they join the artifact.
- **Locals and lambda parameters.** Counted at weight 1, never defined:
  24 392 operations on Broadleaf would spend completion tokens on `i` and
  `result`. A unit's `words` cover its name, its parameters and (for a
  type) its fields — the weighted vocabulary minus its lightest role.
- **A corpus-level reconciliation call.** The modules' senses of a word
  are laid side by side for a human; one more call could judge them, the
  way the module call judges its types'. It waits for `--polysemy` to show
  how often a human disagrees with the obvious reading.
- **A glossary without explaining** (this section's first two drafts: a
  request per scope over a term table, with or without the pack). Cheaper,
  and context-poor by construction: a word's meaning asked at the altitude
  of a scope instead of the entity that uses it. Waits for a corpus nobody
  can explain but everybody wants to count.
- **Deterministic compounds** (n-grams over adjacent tokens of one name:
  `order line item`). The glossary's `compounds` field answers it for the
  top terms; a counting pass would answer it everywhere, and its weights
  would need their own rule.
- **A Specy `.domain` file as the drift input** — its ubiquitous language
  is the business glossary a plain list approximates. The skill that reads
  side-cars lives in another repository; the plain list ships first.
- **History joins** (who speaks which words, when a word entered the
  corpus): the `history-metrics` side-car and `snapshots` make it a join,
  not a feature of this phase.

---

## 21. Phase 18 — Model providers as adapters: Claude Code headless (M20)

Motivation: `explain` buys its explanations call by call from a provider, and
until now a provider meant an API key — `OPENROUTER_API_KEY`, or a Cloudflare
token in front of one. A developer who already pays for Claude Code has a
model on the machine: the CLI's headless mode (`claude -p`) answers one
prompt per process, takes a system prompt and a JSON Schema, and prints one
JSON object with the document, the tokens and the cost. The request: let
`explain` use that installation — Sonnet by default — instead of OpenRouter,
detect the binary or take its path as a parameter, and name the architecture
so a direct Anthropic API client can follow without touching the walk.

**Decision: the port is what `@codegraph/llm` already has — `LlmClient`
(`client.ts`: one structured completion in, parsed JSON out, one error type
with `retryable` decided once). The adapters are the provider modules behind
it: OpenRouter (SDK), Cloudflare AI Gateway (REST) and now Claude Code (a
subprocess). The fourth — the Anthropic API with an API key — is a named,
empty slot, not a stub.** Nothing above the port changes shape: the run's
`Completer`, the CLI's `completerFor`, the store and the side-car are
untouched; `provider` in the side-car header was already a free string.
Rejected, each with its reason:

- **The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as the adapter.**
  It bundles its own copy of Claude Code: the user's install, login and
  version would be bypassed, a second provider SDK would enter the workspace
  (the boundary test guards ONE), and `query()` is an agent loop where one
  completion is wanted. The CLI on the machine IS the installation the
  request names.
- **The Anthropic SDK now.** "Maybe in the future" is not a milestone; a
  stub is an unwired subsystem (CLAUDE.md). §21.6 says exactly where it goes.
- **`--bare` for a clean process.** `--bare` restricts authentication to
  `ANTHROPIC_API_KEY`: a subscription login stops working, which is the
  case this phase exists for. `--safe-mode` keeps authentication and model
  selection and disables every customization (CLAUDE.md, hooks, plugins,
  MCP servers, output styles) — the Claude Code persona is replaced by
  `--system-prompt` anyway.
- **A hand-rolled JSON mode** (`--output-format text` + fence stripping).
  `--json-schema` is the CLI's own structured output; the answer arrives
  parsed in `structured_output`. The fenced-text fallback stays for a
  version that lacks it.
- **Probing `claude --version` during resolution.** Discovery is a pure
  function of (option, environment, `exists`), like the key providers are of
  the environment; a process per resolution would make `--dry-run` spawn.

### 21.1 The adapter (`packages/llm/src/claude-code.ts`)

One call = one process. Measured on 2.1.318 (2026-11-05, Sonnet 5.5): a
2-token prompt costs 1 140 cache-creation tokens of scaffolding plus the
prompt, $0.0053, 2.8 s wall; `--concurrency N` is N processes.

| argument | why |
|---|---|
| `-p --output-format json` | one JSON object on stdout, the prompt from stdin |
| `--model <slug>` | `sonnet` by default (Claude Code's alias for the latest Sonnet); a full id (`claude-sonnet-5-5`) pins the fingerprint |
| `--json-schema <schema>` | the strict response schema, as the other adapters send it |
| `--system-prompt <text>` | REPLACES the default system prompt: no persona, no tool talk |
| `--tools ""` | no tool may run: the model can only answer |
| `--safe-mode` | no CLAUDE.md, hooks, plugins, MCP, output styles; auth untouched |
| `--no-session-persistence` | nothing written under `~/.claude/projects` |
| `--effort <level>` | from `reasoningEffort` when set (`none` → `low`) |

The **user prompt goes through stdin**: a context pack with source can
exceed Linux's 128 KB per-argument limit (`MAX_ARG_STRLEN`); the system
prompt (~6 KB) and the schema ride as arguments. The working directory is
the OS temp directory — no CLAUDE.md of the caller's tree, `--safe-mode` or
not. The environment is the parent's: the `CLAUDECODE` nesting markers of a
`codegraph` run started from inside Claude Code do not stop a `-p` child
(tested on 2.1.318).

Reading the result (`type: "result"`):

| field | → |
|---|---|
| `structured_output` | `json`; absent → `result` through the shared `extractJson` (fenced text tolerated) |
| `result` | `text` |
| `usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | `promptTokens` — what was sent, cached or not, as the chat adapters count it |
| `usage.output_tokens` | `completionTokens` |
| `total_cost_usd` | `cost` |
| the key of `modelUsage` (its `canonicalModel`) | `model` — what served, not the alias asked for |

Errors, every one an `LlmError` (the port's one type):

| what happened | status | retryable |
|---|---|---|
| the binary cannot be spawned (`ENOENT`, `EACCES`) | — | no: the message names the path |
| the call exceeded `timeoutMs` (default 10 min): the child is killed | — | no (`--retry-failed` redoes the unit) |
| non-zero exit, or `is_error`/`subtype ≠ success`: `api_error_status` is a number | that status | the HTTP rule (`isRetryableStatus`) |
| … no status: the message says not logged in / invalid key / unauthorized | 401 | no — and `FATAL_STATUSES` aborts the run |
| … rate limit / 429 | 429 | yes |
| … overloaded / 529 | 529 | yes |
| … budget / credit / billing / 402 | 402 | no, aborts the run |
| … anything else | — | no |
| exit 0 but stdout is not the result JSON | — | no |

The CLI retries its own API errors before answering, so the adapter's
`withRetry` only covers what leaks. What the port carries and the CLI cannot
take — `temperature`, `maxTokens` — is ignored; `explain` says so once when
`--max-tokens` is combined with this provider.

The subprocess is held behind a one-function seam (`ClaudeCodeProcess.run`),
like OpenRouter's transport and Cloudflare's `fetch`: every test drives the
adapter with a fake process and recorded stdout/stderr/exit, and no test in
the workspace spawns anything.

### 21.2 Discovery (`packages/llm/src/claude-code-discovery.ts`)

`findClaudeCode({ explicit, env, exists, platform })` — pure — looks, in
order: `--claude-path` (explicit); `CLAUDE_CODE_PATH`; `claude` in each
directory of `PATH` (`claude.exe`/`claude.cmd` also on Windows); then the
install locations the docs name:

| method | path |
|---|---|
| native installer (macOS, Linux, WSL) | `~/.local/bin/claude` |
| native installer (Windows) | `%USERPROFILE%\.local\bin\claude.exe` |
| legacy local install | `~/.claude/local/claude` |
| Homebrew | `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` |
| npm global (Windows) | `%APPDATA%\npm\claude.cmd` |

An explicit path (option or variable) that does not exist is an error with
that path in it — never a fall-through to a different binary. On Windows an
npm-global `claude.cmd` is found but cannot be spawned: the adapter passes
argv without a shell and Node refuses `.cmd`/`.bat` there (`EINVAL`, the
CVE-2024-27980 mitigation) — the native installer's `claude.exe` is the
supported binary, `--claude-path` points at it. The result
carries `source` (`option`, `env`, `PATH`, `known`), which the provider line
prints.

### 21.3 Resolution (`providers.ts`)

`PROVIDERS` gains `claude-code`; it is *configured* when discovery found a
binary (`PROVIDER_VARIABLES["claude-code"]` requires nothing, lists
`CLAUDE_CODE_PATH` as optional). `resolveProvider(choice, env, { claudeCode })`
keeps its rule — the single configured provider wins — and, with several, a
fixed precedence: OpenRouter, then Cloudflare, then Claude Code; the reason
names the flag for each alternative. An exported key is a deliberate act; an
installed CLI is ambient, so it never overrides one. For `claude-code` the
`missing` list is `["CLAUDE_CODE_PATH"]` — the way to fix it — and the
reason says what was searched. `clientFromEnv` takes the found location and
builds `claudeCodeClient`; the seam's `clientFor` takes the whole resolution.

### 21.4 The CLI

- `--provider claude-code`; `--claude-path FILE`. Under `--provider auto`,
  `--claude-path` alone IMPLIES `claude-code` — a user who named a binary
  meant to run it, key or no key; otherwise a path that does not exist would
  vanish behind "no provider configured".
- `--model` defaults **per provider**: `openai/gpt-5.6-luna` on the key
  providers (unchanged), `sonnet` on `claude-code`; `--rollup-model` still
  defaults to `--model`. The provider is therefore resolved BEFORE the plan,
  so `--dry-run` and `--estimate` print the model that would run — and still
  need no binary, no key.
- A run that needs calls with nothing found is a usage error that leads with
  what discovery said — `no claude on PATH or in a known install location,
  and this run needs N model calls`, or `--claude-path FILE does not exist,
  …`, or `CLAUDE_CODE_PATH=FILE does not exist, …` — never "a variable is
  not set" for a path the user named on the command line; the hint: install
  Claude Code and log in, `--claude-path FILE`, or the variable.
  `--claude-path` with `--provider openrouter|cloudflare` is a usage error:
  the flag names a binary that provider would never run.
- The provider line: `provider: claude-code (found on PATH:
  /home/me/.local/bin/claude)` — or `--claude-path: …`, `CLAUDE_CODE_PATH:
  …`, `found in a known install location: …`; the header's `provider` is
  `claude-code`; the trailer's cost is the CLI's `total_cost_usd` (list
  price — a subscription is billed by its plan), summed as before.
- The fingerprint carries the slug as REQUESTED (`sonnet`), each record's
  `model` the id that served (`claude-sonnet-5-5`): a new Sonnet behind the
  alias does not re-explain what was explained; a full id in `--model` does.
- The estimate counts what the transport adds to every prompt
  (`promptOverhead(provider)` in `providers.ts`, handed to `planRun` as a
  number — the walk never learns a provider): nothing on the key providers;
  on Claude Code `CLAUDE_CODE_SCAFFOLD_TOKENS` (1 850) a call plus the
  response schema, which `claude -p` sends as prompt. The live run measured
  why: 48 operation calls billed +2 292…+2 617 over the bare estimate. With
  it, operations land within 1 % (190 850 estimated, 191 862 billed); types
  (×1.28) and modules (×1.38) stay under, as on OpenRouter (PetClinic types
  ×1.20…1.38) — the dependency explanations a prompt inlines do not exist
  at plan time, a gap every provider shares.

### 21.5 Milestone split

| | scope | definition of done |
|---|---|---|
| **M20a** | the adapter, discovery and resolution in `@codegraph/llm` | `claudeCodeClient` passes the same request/response/error paths the other two adapters are tested on, against a fake process; discovery and resolution tested as pure functions on both platforms' path shapes; the boundary test unchanged (no SDK); `pnpm --filter @codegraph/llm test` and typecheck green |
| **M20b** | the CLI, docs, a live run | `codegraph explain --provider claude-code` on the Java fixture against the real CLI yields a validate-clean side-car with `provider: "claude-code"` and a Sonnet cost in the trailer; `auto` picks it only when no key is set; `--dry-run`/`--estimate` show `sonnet`; docs (`docs/cli.md`, `docs/insights.md`, README, CLAUDE.md, the website's explain pages) name three adapters and the empty slot; the workspace gate green |

### 21.6 Deferred, explicitly

- **The Anthropic API adapter** — `packages/llm/src/anthropic.ts`,
  `ANTHROPIC_API_KEY`, `--provider anthropic`: the Messages API with
  `output_config.format` for the schema, through the official SDK (a second
  line in the boundary test) or raw `fetch` (none). Model slugs would be
  Anthropic's own ids, so a run that moves from `claude-code` to `anthropic`
  keeps its fingerprints only when `--model` names the same full id.
- The desktop app's job using `claude-code` (the daemon knows extractors,
  not providers).
- `--output-format stream-json` for per-call progress; `claude --version`
  in the header.

## 22. Phase 19 — The walk, generalized: `codegraph walk`, `explain` as one definition (M21)

Motivation: `explain` is a bottom-up walk that asks ONE question — "what is
this, in the Specy vocabulary?" — of EVERY unit. The machinery under it
(units, the SCC-condensed order, context packs, Merkle fingerprints, the
plan before the spend, the store, the retry) asks nothing about the
question. The request: a `walk` command that takes the question as a
parameter — a custom prompt, or a file with prompts per entity — and an
optional filter (include or exclude entities, or entities with given
edges), with sane defaults; `explain` becomes that command pre-wired for
semantic explanation, and configurable the same way.

**Decision: the engine stays in `@codegraph/insights` and learns nothing new;
what `explain` hard-codes moves behind ONE seam, a `WalkSpec`. A walk
DEFINITION is data (`codegraph.walk/1`, a JSON file or two flags) compiled
into a spec; `explain` is the built-in spec, and `codegraph explain` is
`codegraph walk --walk explain` with its own defaults and its own store
path. Default `explain` is byte-identical before and after — plan, prompts,
fingerprints, side-car — and that is the gate of every step.** Rejected,
each with its reason:

- **A new package (`@codegraph/walk`) with `insights` on top.** The engine
  files would move and every import with them, for no boundary gained: the
  seam is an interface, not a dependency edge. The package keeps its name
  (CLAUDE.md: never rename a vocabulary); `walk` is the general word,
  `insights` the name of one walk's results.
- **Prompt templates with placeholders (`{{source}}`, `{{callers}}`).** The
  user message's layout IS the engine's contract: fixed sections, corpus
  material fenced, deterministic bytes. A template would let a definition
  unfence source or drop the "NOT EXPLAINED" line. A definition supplies the
  TASK and instructions; the layout is not negotiable.
- **A user-supplied JSON Schema for the answer.** Strict structured output
  accepts a narrow dialect (every property required, no additional
  properties, no constraints), and validating an answer against arbitrary
  JSON Schema needs a validator the workspace does not have. A small closed
  FIELD GRAMMAR compiled to Zod keeps the rule "one definition → type,
  validator, strict schema" (CLAUDE.md, Stack).
- **One store for every walk (a `walk` column in `insight`'s primary key).**
  That is a migration of paid-for stores to serve files that do not exist
  yet. One store per walk needs none: the block is already TEXT and the
  header already JSON in `meta`. `<model>.insights.db` stays explain's.
- **Building the walk over the filtered entities only.** Units, cycles and
  fingerprints would then depend on the filter, and a record bought under
  one filter would be worthless under another. The walk is built over the
  whole model, as now; a filter only decides which units are ASKED.
- **A different task per entity inside one walk.** A cycle is one prompt
  with one answer schema; two tasks in it have no meaning. Per-entity text
  is INSTRUCTIONS added to a member's section. A different task for a
  subset is a second walk with a filter.

### 22.1 The seam: what the engine asks of a walk

Everything below is what `plan.ts`, `run.ts`, `context.ts`, `prompt.ts`,
`records.ts` and `fingerprint.ts` reach for today by name. After M21a they
reach for it through `WalkSpec` (`packages/insights/src/spec.ts`), and
`order.ts`, `units.ts`, `source.ts`, `store*.ts` do not change at all.

| the engine needs | `explain` gives (unchanged) | a definition gives |
|---|---|---|
| the system message per level and shape | `COMMON_RULES` + the Specy vocabulary + `task(level)` | the generic rules + `prompt.task[level]` + `prompt.instructions` |
| extra lines in a member's section | the words to define, a module's glossary words | the entity instructions that select this member |
| the answer schema per level and shape | `ANSWER_BLOCKS`, `sccResponseSchema` | the field grammar, compiled |
| what is kept of an answer | `clampConfidence`, `restateWords` | `clampConfidence` |
| a block with no call | `classifyTemplate` → `templateBlock` | none: a trivial member is not selected (`trivial: "skip"`, the default) or is asked (`"ask"`) |
| what a dependent quotes | `description` + `conceptLabel` | `description` + the field named by `answer.label`, if any |
| completion tokens per block, for the estimate | the fitted constants of §20.3 | one constant, printed as unmeasured until §22.6's live run |
| what else the fingerprint hashes | nothing (`PROMPT_VERSION` only) | the definition's `version`, the system message's digest, the answer schema's digest, the member's instructions |

The last row is the compatibility rule: the fingerprint gains an optional
`walk` input that the built-in `explain` OMITS, so its canonical JSON — and
every fingerprint ever stored — is unchanged. A customized `explain` (§22.5)
carries it, and re-explains exactly what the customization touches.

### 22.2 The walk definition (`codegraph.walk/1`) — data, like a profile

```json
{
  "kind": "codegraph.walk/1",
  "name": "tx-boundaries",
  "version": "1",
  "levels": ["operation", "type"],
  "select": { "any": [{ "edge": { "kind": "annotationUse", "to": { "name": "Transactional" } } }] },
  "closure": "none",
  "trivial": "skip",
  "context": { "depth": 1, "maxLines": 200, "source": true },
  "prompt": {
    "task": { "operation": "Say where the transaction starts and ends…", "type": "…" },
    "instructions": "Answer in English. Name the isolation level when the code states it.",
    "entities": [{ "select": { "module": "com.acme.billing**" }, "instructions": "Billing uses two datasources; say which one." }]
  },
  "answer": {
    "label": "boundary",
    "fields": { "operation": { "boundary": { "enum": ["starts", "joins", "none"] }, "risks": "string[]" } }
  }
}
```

- **Defaults** (every key but `kind` is optional): `name` `adhoc`; `levels`
  all three; `select` everything; `exclude` (a selector too, the file's
  counterpart of `--exclude`) nothing; `closure` `none`; `trivial` `skip`;
  `context` as `explain`'s flags default; `prompt.task` a neutral "answer the
  instructions about this unit" per level; `answer.fields` none.
- **Every block** is `{ description, answer, confidence }` plus the declared
  fields. `description` is the line dependents are shown — the generic rules
  say so ("at most 60 words, for a reader who sees only this line") — and
  `answer` is the response in full. That is the whole bottom-up contract:
  WHAT FLOWS UPWARD IS `description`.
- **Field grammar**, closed: `"string"`, `"number"`, `"boolean"`,
  `"string[]"`, `{ "enum": [...] }`, `{ "list": { field: scalar } }`, each
  optionally `{ "nullable": true }`. Compiled to Zod, strictified by the
  existing `strictify`; the names `description`, `answer`, `confidence`,
  `words`, `glossary` are refused.
- `name` matches `[a-z][a-z0-9-]*`; `insights` and `explain` are reserved.
- The built-in is printable: `codegraph walk --print-definition explain`
  prints explain's definition with `"answer": { "builtin": "specy.domain/3" }`
  — the one thing the grammar does not spell, and a file may not claim.

*As built (step 5, `packages/insights/src/definition.ts`).*

- **Nullable** is one more key on a field's object form:
  `{ "type": "string", "nullable": true }`, `{ "enum": […], "nullable": true }`.
  A list holds scalars and enums, never a list or a `string[]`.
- **A block's wire order** is `answer`, the declared fields BY NAME, then
  `description`, `confidence`: the line that flows upward is written after
  the answer it summarizes, and a key-sorting formatter moves no fingerprint.
- **`answer.label`** names a scalar or enum field declared at one level at
  least; a level without it quotes `description` alone. The label is hashed
  (it changes what every dependent is shown).
- **A task or fields for a level outside `levels` are kept**, digested and
  hashed for that level: the spec does not depend on `levels`, so
  `--levels` never moves a fingerprint.
- **The fence marker** (four backticks) is refused in every task and
  instruction text, so an instruction can never open or close a fence.
- **`context.source: false` is refused** ("not supported yet"): the engine
  always shows source, and a file must not run as if it said `true`
  (deferred, §22.7).
- **The digest** is over the canonical resolved definition — defaults
  applied, keys sorted, text trimmed, `name` and `context` included — so a
  spelled default and an omitted one digest the same. A flag is folded into
  the JSON before parsing, so the digest is the effective definition's.
- **A file handed to `explain`** may restate the built-in (`name: explain`,
  its version, `answer.builtin`) and is refused for `prompt.task`,
  `answer.fields`, `answer.label`, `trivial`, another name or version. With
  nothing to carry, the customized spec IS the built-in (the same object);
  a unit no instruction reaches, and every templated unit, keeps explain's
  fingerprint.

### 22.3 Selection: selectors, and what a filter means bottom-up

**Selectors live in `@codegraph/analyzer`** (`selectors.ts`) — the CLI
defines no predicate of its own (decision 7), and `analyze`, `city` and the
navigator can take them later. The vocabulary is core's: an unknown kind,
trait or edge kind is a usage error listing `EDGE_KINDS` / `TRAIT_NAMES`,
never a silent empty match.

| term (flag text) | JSON | matches an entity when |
|---|---|---|
| `id:ID` | `{ "id": … }` | it is that entity (the id verbatim, an opaque token) |
| `kind:K`, `trait:T`, `lang:L` | `{ "kind": … }` … | its kind / a trait it declares / its language |
| `name:GLOB`, `module:GLOB`, `file:GLOB` | `{ "name": … }` … | its name / its containing module's name / its anchor's file (`*` in a segment, `**` across) |
| `edge:KIND`, `edge:KIND>TERM` | `{ "edge": { "kind", "to"? } }` | it WRITES an edge of that kind (to an entity matching TERM) |
| `edge-in:KIND`, `edge-in:KIND<TERM` | `{ "edgeIn": { "kind", "from"? } }` | an edge of that kind points AT it — the analyzer's derived inverse, in memory |
| — | `{ "all": [] }`, `{ "any": [] }`, `{ "not": … }` | composition; files only |

*As built (step 3).* Core exports no kind list, so `kind:` takes the union
of the profiles' kinds; `lang:` takes the profile CODES (`java`, `csharp`,
`ts`, `ex`, `rb`). A glob matches the whole string, case-sensitively, with
no escape (`*` is always a wildcard — an exact name is `id:`); its segment
separator is `/` for `file:` and, for `name:` and `module:`, the one the
profile's `lexicon.qualified` states for that kind (`.` for a Java package,
`/` for a TypeScript, Elixir or Ruby file module, `::` for a Ruby constant),
so `module:com.acme.order*` does NOT reach a sub-package and
`module:com.acme.order**` does. An unnamed entity (a constructor, a lambda)
matches no `name:`; a parentless stub no `module:`; an unanchored package no
`file:`. A selector matches inside the view's projection: `not` complements
within it.

Edges are read THROUGH the resolved view: `--declared-only` makes every
`edge` term see facts only (invariant 2), with no provenance syntax of its
own. A term matches the entity itself — nothing is folded: a type does not
"have" its methods' invocations.

**What a filter means for the walk** — five rules, each a tested property:

1. **Downward to the nearest containers.** An entity is selected when it,
   its NEAREST containing type or its nearest containing module matches an
   include (no include = everything) and none of the three matches an
   exclude. Exclude always wins. This is what `--scope` does today, stated
   once — and NOT transitive containment (corrected by step 1, which pinned
   it: `--scope java:com.acme.order` leaves the seven units of its
   sub-packages `skip-scope`, and a nested type is not reached through the
   type around it). A sub-tree is a glob: `module:com.acme.order**`.
2. **Levels.** A unit is asked only if its level is in `levels`.
3. **A cycle is one unit.** Selecting one member selects the unit: half a
   cycle is never asked (as `--scope` today).
4. **Closure**, `none` by default: `dependencies` adds the transitive unit
   dependencies of the selection (so every asked unit sees its callees'
   summaries); `containers` adds the type and module above a selected unit;
   `all` both. The plan PRICES the alternative: "214 dependencies of the
   selection are not walked; `--closure dependencies` adds 214 units".
5. **Not selected = `skip-scope`**, the existing status under its existing
   name: reused when a record with its fingerprint exists, never called,
   shown to dependents as NOT EXPLAINED, and — as now — part of their
   fingerprint through `missingDependencies`.

The walk itself is filter-blind (the rejected alternative above), so a
record bought under a filter is reused by any later run whose inputs match.

*As built (step 4, `packages/insights/src/selection.ts`).* Where the rules
were silent:

- **A cycle and an exclude.** Include is existential over a cycle's members
  (as `--scope` always was) and so is exclude: one excluded member leaves
  the whole cycle unasked — asking it would ask the excluded member.
- **Closure never adds a barred unit**: one outside `levels`, one an exclude
  reaches, or a trivial member under `trivial: "skip"`. It is the LEAST set
  closed under its rule, and `dependencies` does not walk THROUGH a barred
  unit (f → g → h with g excluded adds nothing: at depth 1 no asked prompt
  would quote h). `containers` reaches the module above an operation even
  when the type between them is barred; a parent package is not a container.
- **Templates are not filtered.** Under a spec that templates (explain) a
  trivial member is `template` whatever the selection says — no call either
  way — and is counted apart in the price.
- **Fingerprints.** A selection moves a unit's fingerprint only through
  `missingDependencies`: a unit keeps its fingerprint exactly when nothing
  in its transitive dependency cone is `skip-scope`. So "a record bought
  under a filter is reused by the unfiltered run" reads transitively.
- **`--scope` and the view.** The old predicate compared ids and never
  consulted the view; an `id:` selector matches nothing the view drops. They
  differ only for a corpus member whose nearest type or module is a stub
  under `--internal-only` — measured absent from the five fixtures and from
  PetClinic. Until step 7 `explain` compiles `--scope` under the identity
  view, so not one byte moves; step 7 folds it into `--include id:` under
  the resolved view and states that corner.

### 22.4 Records, side-car, store — one store per walk

- A walk named N writes `<model>.N.walk.db` (the working copy) and its export
  `<model>.N.walk.jsonl`. `explain` keeps `<model>.insights.db` /
  `.insights.jsonl`, kind `codegraph.insights/1`, untouched bytes.
- A generic side-car's header kind is `codegraph.walkRecords/1` (NOT
  `codegraph.walk/1`, which is the definition file's: two formats, two
  kinds) with `walk: { name, version, digest }`; record (`t:"i"`), failure (`t:"f"`) and
  trailer lines are the existing envelopes, the block validated by the
  walk's compiled schema instead of the Specy union.
- `INSIGHTS_DB_VERSION` stays 2: the block is TEXT, the header JSON in
  `meta`, `concept` and `insight_word` simply empty. If a step proves a
  column is needed, a migration is APPENDED — never an edit of a shipped one.
- **The store is not a cache, here too.** A store opened by a walk of
  another NAME is refused, bytes untouched (as a foreign file is). A walk of
  the same name whose `digest` changed is not refused — fingerprints decide
  what is redone — but the confirmation says it in words before the count:
  "the definition changed since this store was written: these N units are
  asked again and their records REPLACED; `--name OTHER` keeps both."
- `decode → import → export` is the identity for generic records as well.

*As built (step 6, `packages/insights/src/format.ts`).*

- **A store, the codec and a run are handed the walk's `RecordFormat`** —
  its name, its header schema, its compiled block schemas; with none they
  use explain's, so every earlier caller is unchanged. The file never
  carries a schema, only the identity the name check compares.
- **The name check sits in the refusal that already existed** (`migrate()`,
  before the first write, for readers too) and again on `importFile`,
  `beginRun`, and line 1 of a side-car. A header with no `walk` key is
  explain's; an empty store is nobody's yet.
- **A customized explain** keeps its kind and its store and records
  `walk: { name: "explain", version, digest }`, the digest over its
  instructions alone; a plain explain's header gains no key. An older build
  reads such a file as a plain explain and drops the key on export.
- **What a dependent quotes after a re-open** is a projection the spec
  DECLARES (`WalkSpec.quoted`, the block paths its quote reads): the store
  answers it in SQL, memory builds the same projection, and explain's four
  paths are the ones its SQL always read — one point query, no block parsed.
- **A changed answer is another walk.** The fingerprint hashes the answer
  schema, so new fields re-ask every unit anyway; a store that kept both
  shapes would export a side-car no definition decodes. So the header's
  `walk` also carries the answer schema's digest, and a store written under
  another answer is refused like a store of another name — "`--name OTHER`
  keeps both" (step 7a). A changed TASK is not: the blocks keep their shape,
  the fingerprints decide, and the confirmation says so.
- **`concept` joins the reserved field names**: the store's generated
  `concept` column reads `$.concept` of any block (step 7a).

### 22.5 The CLI

```bash
codegraph walk model.jsonl --prompt "Where does this code build SQL from user input?" \
  --include 'edge:invocation>module:java.sql**' --levels operation --dry-run
codegraph walk model.jsonl --walk tx-boundaries.json [--name N] [--out FILE]
codegraph walk --print-definition [explain]        # a file to start from
codegraph explain model.jsonl --exclude 'file:**/generated/**' --instructions @domain-context.md
codegraph insights model.jsonl --walk tx-boundaries --id ID
```

- **`walk`** takes every run flag `explain` has (`--src`, `--provider`,
  `--model`, `--rollup-model`, `--depth`, `--max-calls`, `--max-tokens`,
  `--concurrency`, `--max-lines`, `--max-scc`, the view flags, `--dry-run`,
  `--estimate` + prices, `--force`, `--retry-failed`, `--export`, `--import`,
  `--yes`, `--json`) through ONE shared option table, plus: `--walk FILE` or
  a built-in's name; `--prompt TEXT` / `--prompt-file FILE` (the task, every
  level); `--name N`; `--include SEL` / `--exclude SEL` (repeatable, one term
  each, OR within a flag); `--levels a,b`; `--closure`; `--print-definition`.
  A flag overrides the file's key, and the result is what is digested.
- **`explain`** gains the same selection flags (`--include`, `--exclude`,
  `--levels`, `--closure`) and `--instructions TEXT|@FILE` and
  `--walk FILE` — a file that may set `select`, `levels`, `closure`,
  `context`, `prompt.instructions` and `prompt.entities`, and is refused if
  it sets `prompt.task` or `answer`: the Specy blocks are what the readers,
  the glossary and the Specy skill depend on. `--scope a,b` stays, as sugar
  for `--include id:a --include id:b`, and still cannot meet `--retry-failed`.
- `walk`'s `--json` kinds are `codegraph.walkPlan/1`, `walkEstimate/1`,
  `walkSummary/1`; `explain`'s keep their names and bytes.
- `insights --walk NAME` resolves the store path; its summary, lists by
  level and confidence, `--id`, `--failures` and `--runs` are generic
  already; `--concept` and the word reports answer "none" on a walk that
  has none. `serve --insights FILE` shows a walk's store in the Navigate
  panel as it shows explain's — the block is rendered generically (M16c).

*As built (step 7a, `packages/cli/src/commands/walk-run.ts`).*

- **One runner, two descriptions.** `runWalk(flags, walk, io, seam)` runs a
  `WalkRun` — its words, store path, record format, JSON kinds, spec,
  selection and header. `explain.ts` (174 lines, from 921) and `walk.ts`
  each only build one; `explain.test.ts` passes with no edit at all.
- **A flag is folded into the definition's JSON before it is parsed**, so an
  override is validated like a key of the file (`name (from --name): …`) and
  the digest is the effective definition's: `--walk FILE --closure all`
  digests as the file with that key edited (tested for every flag).
- **The answer's digest** is `walk.answerDigest` in the header: the sha256 of
  the three strict block schemas as sent, keys sorted. Required in a walk's
  header, absent from explain's. A format that names no answer (a reader
  holding no definition) compares the walk's name only — the lenient read
  the readers use.
- **`--walk explain`** runs explain's description under walk's kinds and
  titles, on explain's store; it refuses `--prompt`, `--prompt-file` and
  `--name`. `--terms` and `--scope` stay explain's own flags.
- **`--scope` is `--include id:`**, compiled under the walk's resolved view;
  its unknown-id check and message stay. The 11 PetClinic `--scope`
  baselines are byte-identical, the stub-package corner included.
- **The price is printed, text only**, after `statuses:` (plan) and `calls:`
  (estimate, so the confirmation too): what the selection leaves unwalked,
  and what the next closure would add — cold-plan figures. A walk is always
  priced; explain only when a selection flag other than `--scope` or a
  `--walk FILE` is given. Walk kinds carry `walk` and `price` in their JSON;
  **explain's kinds carry neither**, so their documents keep their shape.
- **The digest notice** is the first line of a dry run's or an estimate's
  text, on stderr under `--json`, and before the question in the
  confirmation; declined, nothing is written (store sha256 unchanged).
- **`--retry-failed` replaces the selection**: the failures and their direct
  dependents are what is asked, a file's `select` is not read, a selection
  flag is refused with it. The task and answer still apply, so the retried
  units hash as the failed run's.
- **The runner is loaded only when a run is due**: `walk --print-definition`
  and a refused definition never load the provider SDK (0.15 s, not 0.9 s).
  `e2e-exit-codes.test.ts` is one long run of `spawnSync` calls, about 55 s
  in a full run, near vitest's 60 s worker RPC timeout: a slow case added
  there brings back "Timeout calling onTaskUpdate".
- **A test of step 5 was restated** (review of 7a): the fence-hygiene
  property drew refused and accepted texts from one generator and asserted
  that more than ten of sixty were accepted — it failed once at exactly ten.
  It now draws each outcome from its own generator, so neither half is luck.

*As built (step 7b — the readers).*

- **A reader holds no definition.** `walkReader(name)` compares the walk's
  name, never its answer, and reads each block as stored — so a store
  written under answer fields since changed stays readable. It writes
  nothing: a writable open, the codec and its record schema all refuse.
  `sqliteStoreReader(db, walk?)` picks the reader from the store's header.
- **Explain's projections are explain's.** The row's concept label ("owned
  by X") and the "owed words" count apply to a `codegraph.insights/1` store
  only; a walk field named `owner` used to be read as an aggregate's owner.
- **`insights --walk N`** reads `<model>.N.walk.db` in the walk's words;
  `--store FILE` alone reads whichever walk's store its header names, with
  `--walk N` the file must be N's. No flag, or `--walk explain`, is explain's
  output byte for byte (checked on the paid PetClinic copy). `--id` prints
  the block by field name. `--concept`, `--word`, `--glossary`, `--polysemy`
  and `--concerns` answer **none** — exit 0, the reason on stderr, and under
  `--json` one document of kind `codegraph.insightsNone/1` — rather than an
  empty table a consumer would read as "no such concept".
- **`serve --insights FILE`** chooses the reader the same way. A walk's
  `insight.json` answer is `kind, id, status, walk, record`: the `walk` key
  is the discriminator, on every status, and never on explain's answers,
  whose keys are unchanged. The glossary answers `no-store` on a walk's
  store. An empty store (no header yet) is re-opened on each request, so a
  walk that fills it later is not read through explain's schema.
- **The Navigate panel** renders a walk's block in the same inference frame
  as explain's: "LLM answer", the walk's name, the model, the confidence;
  then the answer, every field by its declared name (a list, a nested
  object, `false` shown, `—` for an empty value), then the description.
  Explain's panel markup is byte-identical to the build before the change.
  Screenshots read on the Java fixture, with a store made by the fake client.
- **The SEA smoke has five gates**: `walk --print-definition` (both), a walk
  dry run and `insights --walk` (summary and `--id`) must answer from the
  image as from the ESM build.
- **Two load-sensitive tests remain, neither of this milestone**:
  `import.test.ts` "keeps timing and file size off stdout" fails when the
  random temp directory's name contains `MB`; `test.sh` runs `pnpm -r test`
  without `--no-bail`, so the analyzer's `scale.test.ts` timeout hides every
  later package on a loaded machine.

*As built (step 8, the documentation half — the paid run is still owed).*

- **Written**: `docs/insights.md` (IN-9, the walk), `docs/cli.md`, README,
  CLAUDE.md, and on the site a how-to (`how-to/walk-your-question`), three
  reference pages (`reference/walk-definition`, `reference/cli/walk`,
  `reference/cli/insights` — the site had none for `insights`) and fourteen
  pages updated. Every pasted command was run on a copy of the Java fixture.
- **`docs-walk-definitions.test.ts`** parses every `codegraph.walk/1` block
  of the docs through the schema (9 blocks; `name: "explain"` is an explain
  file) and every `--include`/`--exclude` term of a shell block through
  `parseTerm` (11 terms). An example that must be invalid goes in a `text`
  fence.
- **Corrected in review**: the plan's selection line said unwalked
  dependencies are "shown as NOT EXPLAINED", false on a warm store where
  their records are reused; it now ends "without a record, shown as NOT
  EXPLAINED". `serve --help` says `--insights` reads a walk's store too.
- **A pitfall the docs name**: a `not` inside `select` is still reached
  through rule 1 (a package has no file, so `not file:**/legacy/**` matches
  the module and its members follow); `exclude` is the form that bars.
- **Owed after the live run**: ten passages and the pasted plans state the
  output figure as unmeasured (500 tokens per block); `WEBSITE.md` §4 does
  not list the four new pages. *(The passages: done below. `WEBSITE.md`:
  still owed.)*

*As built (step 8, the live run — 2026-11-22, on a copy of PetClinic).*

- **The run**: `walk --name controllers --prompt "Say what this code does
  for the web requests it serves: the inputs it reads, what it validates,
  what it changes, and the view or response it returns." --include
  'edge:annotationUse>name:Controller' --closure dependencies --provider
  claude-code` (`sonnet`, depth 1, concurrency 4, no field declared). 139
  units; **83 calls (63 operations, 20 types, no module), 0 failed**, 56
  skipped (32 trivial), 127 s, **200 779 prompt + 43 814 completion tokens,
  $0.9380**, records stamped `claude-sonnet-5-5`.
- **Verified**: a second run made 0 calls (83 reused) and did not ask;
  `--import` of the side-car into an empty copy then `--export` gives the
  same bytes; `explain` on the copy plans the gate's bytes (`240f75ce…`) and
  explain's store kept its sha (`719b2b30…`) — the walk wrote
  `petclinic.controllers.walk.db`/`.jsonl` and nothing else.
- **Estimate against the bill.** Input: 225 603 estimated, 12.4 % above
  (operations 165 435 for 136 093 billed, 21.6 % above; types 60 168 for
  64 686, 7.0 % below — the type-side shortfall §21.4 left open, now with a
  second data point; the operation-side excess is not investigated). Output,
  with the guessed 500 per block: 41 500 for 43 814, 5.3 % below — operations
  0.3 % above (mean 499 per block, 273 to 802), types 19.3 % below (mean 620,
  307 to 1 177).
- **The constant replaced**: `WALK_COMPLETION_TOKENS_PER_BLOCK = { operation:
  500, type: 620, module: 620 }` — the run's means; no module was asked, so
  it takes the type's figure, and nothing measured a declared field. The
  estimate says all of it: "measured on a live run: operation 500, type 620
  tokens per block asked for (sonnet through claude-code, on a walk that
  declares no field: declared fields add to it; no module was measured, it
  takes the type's figure)". The unmeasured variant of the runner's
  `completion` and the JSON key `completion: { measured: false, … }` are
  gone. In-sample by construction (43 900 for 43 814): one run, one corpus,
  one model, one question. The figures are not in a fingerprint — the paid
  store still plans 0 calls under them.
- **Seen in the answers**: the trivial rule skipped `setAllowedFields`, an
  `@InitBinder` method the question is about (a setter by name); the type's
  answer read it from the type's source and said its record was missing.
  `"trivial": "ask"` is the remedy; a name-based rule that reads annotations
  is not planned.

### 22.6 Milestone split — eight steps, each with its verification

**Standing gate, every step:** `pnpm -r test`, `pnpm -r build`, typecheck;
the M21a goldens byte-identical (`packages/cli/test/golden/explain/`); and
on a COPY of the paid PetClinic store (`~/spring-petclinic`), the output of
`explain <copy>/petclinic.jsonl --src ~/spring-petclinic/src/main/java
--model openai/gpt-5.6-luna --depth 1 --dry-run --json` is byte-identical
to the one taken on untouched `main` (cf7432a) — the end-to-end proof that
no fingerprint moved on a store somebody paid for. One logical change per
commit.

*Restated by step 1 (2026-11-21).* The gate first read "plans 0 calls". It
cannot: on untouched `main` that store plans **llm 53, template 33, reuse
53**, because 2a79c8f (2026-11-03, "ask no definition of grammar") changed
the words asked of every name that spells a function word (`findById`:
`find, by, id` → `find, id`) five days after the paid run, and a store from
before the chain split carries that up to every dependent. Proven by
running the plan with the speller as it was before that commit: 0 calls.
So the durable property is "the plan does not move", not "the plan is
empty"; the 0-call half is held on the fixtures instead, by the golden
suite's warm-store test (re-stamped records → 0 calls).

| step | change | verification |
|---|---|---|
| **1 — pin what exists** (M21a) | no source change: a golden suite over the five fixtures — the `--dry-run --json` plan, every rendered prompt (system + user), every fingerprint and chain, the side-car of a fake-completer run | green on untouched `main`; then PROVE it bites: one character changed in a task string, one in `factsProjection`, one in the canonical key order each turn it red, and are reverted |
| **2 — the seam** (M21a) | `spec.ts` (`WalkSpec`) and `explain-spec.ts`; `plan`/`run`/`context`/`prompt`/`records`/`fingerprint` reach the Specy vocabulary, the templates, the words and the quote rule only through the spec; `explain.ts` passes it explicitly | step 1's goldens untouched; `insights` and `cli` suites green with no test edited beyond imports; a boundary test: the engine files import nothing from `ddd.ts`, `template.ts`, nor name `ANSWER_BLOCKS`; a second, toy spec (two fields, no template, no words) runs the Java fixture end to end against the fake completer |
| **3 — selectors** (M21b) | `packages/analyzer/src/selectors.ts`: the term grammar, the JSON form, `compileSelector(selector, graph, view)`, the glob | each term hand-counted on the Java fixture (e.g. `edge:annotationUse>name:Audited` against the `@Audited` uses counted in the fixture's sources); properties: text ⇄ JSON round trip, `not(not s) ≡ s`, `all([])` = everything and `any([])` = nothing, matches under `declaredOnly` ⊆ under identity for a selector with no `not`; every fixture id (five languages) survives `id:` verbatim; unknown names are errors listing core's vocabulary |
| **4 — selection in the walk** (M21b) | `selection.ts`: rules 1–5 of §22.3 → the `inScope` predicate `planRun` already takes; `--scope` restated on it; `trivial` | properties over fast-check-generated selections on each fixture: `buildWalk` output identical with and without a filter; the `llm` steps under a filter ⊆ the unfiltered ones (cold store); under `closure: dependencies` no asked unit has a `skip-scope` dependency within `levels`; a record produced under a filter is reused by the unfiltered run exactly when none of its dependencies was missing; members of a matched type and of a matched module's types are selected, a sub-module's and a nested type's are not; exclude wins; golden: `--scope X` ≡ `--include id:X` ≡ step 1's bytes (`java-scope-order`) |
| **5 — definitions** (M21c) | `definition.ts`: the Zod schema of `codegraph.walk/1`, defaults, the field grammar → Zod → strict schema, `compileDefinition` → `WalkSpec`, the generic rules and entity instructions, the fingerprint's `walk` input. Separately, test-first: the source fence's language comes from the model's `lang` (it is the literal `java` today, on every language) | invalid definitions rejected with the path of the fault; every compiled answer schema passes the existing strict-compat property; fake-completer run of the §22.2 example validates each record against its schema; properties: editing one `entities` instruction moves exactly the fingerprints of the members it selects and their transitive dependents, editing `select`/`exclude`/`levels`/`closure` moves none but through `missingDependencies` (a unit whose dependency cone stays walked keeps its fingerprint), the same definition and model render the same bytes; an instruction is never inside a fence and corpus text never outside one; the fence fix restates four fixtures' prompt goldens and NO fingerprint |
| **6 — store and side-car per walk** (M21c) | the `walk` header key; the generic record codec; name check and digest notice in the store port; `<model>.N.walk.*` paths | `decode → import → export` identity as a fast-check property over arbitrary grammar-shaped blocks; an existing version-2 explain store opens, plans and exports `cmp`-equal (fixture, and the PetClinic copy); a store of another name is refused with its sha256 unchanged; a changed digest is reported and nothing is written before the confirmation |
| **7 — the CLI** (M21d) | `commands/walk-run.ts` (the shared runner, lifted out of `explain.ts`), `commands/walk.ts`, `explain.ts` reduced to its spec and defaults; the shared option table in `args.ts`; dispatch; `insights --walk` | `explain.test.ts` passes unedited but for imports; `walk.test.ts` through the seam and the fake client: `--prompt`, `--walk FILE`, flag-over-file precedence, `--include`/`--exclude`/`--levels`/`--closure`, the three `--json` kinds, the changed-definition confirmation, the reserved names, `explain --walk` refusing `answer`; `walk --walk explain --dry-run --json` ≡ `explain --dry-run --json` modulo `kind`; args, dispatch, help, stream-purity and exit-code suites; `test.sh` SEA smoke; `serve --insights` on a walk's store, the Navigate panel screenshot read |
| **8 — live, measured, documented** (M21d) | a paid run and the docs | on PetClinic, after `--estimate` and an explicit go-ahead: one filtered custom walk (the `@Controller` types, `--closure dependencies`) through `--provider claude-code`, 0 failed, side-car decode-clean, a second run 0 calls, cost and the estimate's error stated here and the unmeasured completion constant replaced; `explain` on the copy still plans its baseline bytes. `docs/insights.md` (the seam, the definition, the rules of §22.3), `docs/cli.md`, README, CLAUDE.md, the website's how-to and reference pages; a test parses every `codegraph.walk/1` block in the docs through the schema, so an example cannot rot; the site builds |

| | scope | definition of done |
|---|---|---|
| **M21a** | steps 1–2: the engine behind a seam | default `explain` byte-identical on five fixtures and its plan unmoved on the paid PetClinic copy; a toy second spec runs end to end |
| **M21b** | steps 3–4: selectors and selection | the selector vocabulary is core's; the five rules of §22.3 hold as properties; `--scope` is one of its cases |
| **M21c** | steps 5–6: definitions and their store | a definition file compiles to a spec, hashes what it says, and its results round-trip a store of their own with no migration |
| **M21d** | steps 7–8: `codegraph walk`, `explain` on top of it | the two commands share one runner; a live filtered walk measured on PetClinic; docs name the definition, the selectors and the reserved store |

### 22.7 Deferred, explicitly

- **Planning only the selection's dependency cone.** A plan builds a context
  pack for every unit to hash it; a narrow filter needs only the units its
  selection transitively depends on. Worth doing when measured: Broadleaf,
  a 50-unit selection, plan time and peak RSS before and after.
- **Selectors over measures and roles** (`metric:cyclomatic>=10`,
  `stereotype:repository`) and **over another walk's results**
  (`insight:concept=aggregate` — the store as a selector input).
- **A walk quoting another walk** (a review that reads `explain`'s
  descriptions as context): a second `RecordSource` in the pack, and a
  fingerprint that hashes it.
- `context.source: false` (a walk over facts alone): the key is read and
  refused until the engine can leave source out of a pack and of its hash.
- `context.sections` (which facts a prompt shows) with a facts digest that
  follows it; a task per entity subset; an answer schema beyond the grammar.
- Selectors on `analyze`, `city` and `navigator`; the Navigate panel
  choosing among several walks' stores; the desktop app's job running a walk.

---

## 23. Phase 20 — Python extractor (Ruff's parser as a library, no Python on the machine) (M22)

Motivation: the sixth real extractor is the first for a language that is
**exact about names and silent about attributes**. `import` is a statement
with a literal name, and which binding a bare name reads is decided by the
compiler before anything runs (the rules `symtable` implements); one dot
later, `x.y` is a dictionary lookup at run time. Ruby (§19) wrote no import
layer; Python writes all of it — and then nothing a receiver could be typed
by, except, sometimes, an annotation the language records and never checks: a
third state between the typed languages of §5–§14 and the untyped ones of
§16–§19. Its legacy is of two kinds, and neither runs: Python 2 sources, which
no Python 3 parses, and applications whose `requirements.txt` no longer
resolves — and importing a module is the only way Python itself learns what a
class is.

**What is the Spoon / Roslyn / tsc of Python?** A parser and the compiler's
scoping rules — the language binds names statically and nothing else.

| Roslyn / `ts` | Python | Role |
|---|---|---|
| `SyntaxTree` | **Ruff's parser** (`ruff_python_parser`, astral-sh/ruff): a hand-written recursive-descent parser in Rust with a typed tree, byte offsets, error recovery, and every Python 3 grammar up to the current one in ONE build | syntax with positions — and, through recovery, the declarations of a Python 2 file |
| `SemanticModel` / `TypeChecker`, for NAMES | the compiler's own rules, static and small: a name assigned in a function is local to it, `global`/`nonlocal` say otherwise, a class body encloses nothing, a comprehension is a scope, then the module, then `builtins` | what a bare name reads is `declared` — the same answer CPython's `symtable` gives |
| the same, for ATTRIBUTES | **none before the program runs.** What statically stands: the module a name was imported as, the class a name is, `self` inside a class whose bases are written | binding is the interpreter's; the receiver's SHAPE decides what may be said (§23.4) |
| the BCL ref pack / `lib.*.d.ts` / the OTP table / the RBS core table | **typeshed `stdlib/`** at a pinned commit — `builtins.pyi` and every module of `VERSIONS` — distilled to a table and embedded | what `Exception`, `os.path`, `enum.Enum` are on a machine with nothing installed |
| `IErrorTypeSymbol` | an import neither the corpus nor the table answers | a third-party module, whichever distribution ships it — stubbed under the dotted name the source writes, never guessed |

So the baseline is a **scope-and-import resolver over Ruff's tree** against a
whitelist of what the corpus writes. It is noClasspath by construction — no
`site-packages`, no virtual environment — and, like Ruby's, it extracts a file
with syntax errors from the tree the parser recovered. For Python that is not
a courtesy to broken files: it is what makes a Python 2 file an input.

**This is the first extractor whose parser is not the language's own**, and
§19 rejected tree-sitter-ruby for being exactly that. The difference is stated
here, measured below, and then held by an oracle (§23.6): CPython's parser
exists only inside a CPython. It reads one grammar — its own version's —
rejects a file whole at the first error, and therefore reads no Python 2 at
all; a model built on it would depend on which interpreter the machine has.
Prism was CRuby's parser *and* a library; Python has no such thing, and of the
second implementations Ruff's is the one that reads every version, recovers,
and is run daily over most of PyPI.

The alternatives, and why they are not the baseline:

| Candidate | What it is | Verdict |
|---|---|---|
| **CPython's `ast`** (an extractor written in Python) | the language's own parser | not the baseline, for the three reasons above plus the one of §19 principle 1 (no dependable single-binary packager). It becomes the **parity oracle**: on every file CPython accepts, the model's declarations must be `ast`'s |
| **Importing the project and introspecting** (`sys.modules`, `inspect`, `__mro__`) | the truth, after every metaclass and decorator ran | never the extractor — it runs corpus code (§5.2) and a legacy application does not import. It is the `--trace` enrichment of M22c, produced by the user inside a project that still runs |
| **ty** (`ty_python_semantic`), **pyright**, **mypy** | type checkers with inference | enrichments and oracles, not a baseline. ty is 0.0.96 (2026-11-03) and says of itself that it has no stable API; all three need the third-party packages resolvable to type a receiver, which is what a legacy corpus lacks. Pyright, through scip-python, is the **reference oracle**. A typed-receiver pass on ty is deferred (§23.10) — its crates sit in the same repository and tag as the parser |
| **A SCIP adapter over scip-python** — what §10 pencilled in for Python | an existing indexer | the §14 verdict on scip-typescript, verbatim: occurrences, not kinds, traits, containment or provenance; and it needs Node and an installed environment. Its output is a lower bound of this extractor's, which is what an oracle is |
| **tree-sitter-python** | a parser with a CST | rejected as the front end — no version awareness, a third grammar — though the metrics pass already links it for measures (§18). Its tolerance of Python 2 is not needed (measured below) |
| **Jedi, parso, LibCST, `rustpython-parser`** | editor inference; parsers | Jedi and LibCST need a Python; `rustpython-parser` is the ancestor Ruff's parser replaced, and today republishes it |

**Measured before planning** (2026-11-21, a throw-away crate, nothing
committed):

| Question | Result |
|---|---|
| Does the parser build as a dependency? | yes, as a **git** dependency: tag `0.16.4` builds in 22 s on Rust 1.95; the closure is 60 crates, all Rust — **no bindgen, no libclang** (§19.1's trap does not exist here); a release binary of parser + visitor is 2.3 MB |
| Is it on crates.io? | no. The crate describes itself as "an internal component crate of Ruff", version `0.0.x`. Two unofficial republications exist (`rustpython-ruff_python_parser`, `littrs-ruff-python-parser`): a third party's snapshot of someone else's code, not used |
| What does the pin cost? | Ruff's Rust floor moves with it: `1.91` at 0.15.0, `1.95` at 0.16.0, `1.97` at 0.17.0, **`1.98` at 0.17.6** (the latest). `0.16.4` is the newest tag the Rust on this machine (1.95) builds |
| Python 2: what survives recovery? | CPython 2.7.18's own `Lib/`, 1 612 files, parsed in 0.34 s: 590 files with syntax errors. Against `lib2to3` — the Python 2 grammar, as CPython 3.12 still ships it — on the 1 601 files it reads too: **classes 8 348 = 8 348, functions 34 934 = 34 934, import statements 8 464 = 8 464, zero files differing**; inside the 586 erroring files alone, 4 394 / 20 614 / 4 248, all equal. A hand-written file of nothing but Python 2 forms (`print` statement, `except E, e`, backticks, `<>`, `exec`, a tuple parameter): 14 errors, 2 of 2 classes, 4 of 4 functions |
| …and what is not measured | on Python 2 the counts agree, not yet each (name, line); and what recovery does to a BODY (the calls inside a `print` statement) is unknown. Both are M22c's (§23.6) |
| Valid Python 3: is the tree CPython's? (M22a's first step, run 2026-11-21 on tag 0.17.6) | by (file, line, kind, name), against `ast` under CPython 3.12: the 3.12 standard library, 1 757 files accepted — **85 712 declarations on each side** (13 605 classes, 60 334 functions, 11 773 import statements), none only in one; requests, 37 files, 1 131, the same. The parser decision is not reopened |
| Does it read typeshed? | `stdlib/` as Ruff 0.16.4 vendors it (commit `6fba3ae7`): 752 `.pyi`, **zero syntax errors**, 3 240 classes, 17 290 functions, `builtins.pyi` alone 110 classes. `VERSIONS` gives each module its range, removed ones included (`asynchat: 3.0-3.11`). The table's generator needs no second grammar |
| What did the corpus say the plan had missed? | 24 of the 1 612 files are **not UTF-8**. Prism read bytes and honoured the magic comment; this parser takes a `&str`. Decoding is the extractor's (§23.8) |

Four principles, locked up front:

1. **The parser without the interpreter — and without Python.** The extractor
   never imports a corpus module, never reads a virtual environment, and is
   written in Rust (§19 principle 1, the same three reasons: one grammar per
   machine's interpreter, no single-binary packager, a Rust release pipeline
   already there).
2. **No metamodel intelligence.** It knows the Python id scheme, the kind →
   traits table and how to write bytes. The cross-language gate
   (`packages/core/test/fixtures-python.test.ts`) is where the two halves meet.
3. **Byte-identity across OS and across install state.** Ruff is pinned by
   tag and `Cargo.lock` holds its commit; the table is named by typeshed
   commit; the header names both. An external module is keyed by the dotted
   name the source writes, never by a path into `site-packages`.
4. **Every provenance earns its place.** `declared` for what the source
   writes and the scoping rules bind — a name, an import, a class named at
   the site, `self` along written bases; `derived` for what flow or an
   ANNOTATION says (a local assigned `Foo()`, a parameter written `repo:
   Repo`) and for attribution to a sole library ancestor; `generated` and
   `dynamic-candidate` for what only the trace knows (M22c).

**Confirmed before M22a** (2026-11-21 — the five recommendations, each with
the answer it was preferred to; Rust on this machine is 1.100 since):

| Decision | Confirmed | The other answer |
|---|---|---|
| the parser | Ruff's, in Rust — the first not the language's own | CPython's `ast`, in Python: no Python 2, no partial files, a Python on every machine |
| the pin | the newest tag when M22a starts (0.17.6 today): `rustup update stable` here, 1.95 → ≥ 1.98; CI installs stable already | `0.16.4`, which builds on today's toolchain and lacks half a year of grammar |
| an annotated receiver (`repo: Repo` … `repo.find()`) | **`derived`**, counted apart as `annotation-typed` — the interpreter never checks an annotation, so a `declared`-only analysis must not hold it (invariant 2). M22c measures the tier against pyright and reports the agreement | `declared`: what a codebase that runs mypy in CI would say of itself |
| standard library vs. third party | two reserved roots, `<stdlib>` and `<site>` — "which third-party packages does this module need" is the first question asked of a Python model | one root, Ruby's `<gems>`: nothing to maintain, and `os` beside `django` |
| the writer (canonical order, JSON bytes, surrogates: ≈ 780 lines of `extractors/ruby`) | lifted into a path crate both extractors depend on — FIRST, as a pure refactor whose gate is Ruby's snapshot, byte for byte | copied: no shipped extractor is touched; two copies each held to core's bytes by the two-encoder gate |

**Ruled after the audit** (2026-11-22 and 2026-11-23 — the six questions the
five corpora raised and the memory figure, each with the answer it was
preferred to; where a ruling contradicts a sentence below, the ruling holds):

| Question | Ruled | The other answer |
|---|---|---|
| a third-party class reached through an imported name (`models.Model` after `from django.db import models`) | keyed at the dotted module, `<site>/django.db.models/Model`: a stated guess, on class evidence only (a base, `raise`, `except`, an annotation) — a library function or value still folds to the module the import names. 66 classes over the five corpora, one known wrong (Zulip's `pika.spec` `Basic.Deliver`, a nested class taken for a module) | the name as written under the imported module: one class under as many keys as files spell its import (12 pairs on Zulip) |
| a standard-library class the table knows to be re-exported | keyed where typeshed declares it (`unittest.case/TestCase`; `collections.abc.Mapping` under `typing`), the import edge unchanged, Python 2 names as written; "no stdlib class has two keys" is a tested property | the name as written at the site (§23.3's last bullet, superseded) |
| a star-imported name read from another file (`signal.SIGINT`, bound in `signal.py` by `from _signal import *`) | left dropped `unbound-name`, counted (578 `signal.*` reads in CPython 3.14's `Lib/`) | attributing through the star import across modules |
| a corpus class written as a receiver (`Message.objects`, `Sub.method`) | a `declared` `reference` to the class beside the member's edge, whichever way the member goes — a library ancestor, a corpus ancestor, or dropped; not for `self` / `cls`, nor for the class's own member. Evidence about the class, not a resolution: no rate and no drop counter moves (23 135 references over the five corpora) | the member's edge alone, which names the ancestor or nothing |
| an import under `if TYPE_CHECKING:` | counted, not marked on the edge (§23.10): the cycles it closes are drawn | a mark on the import edge — a core change |
| a base written under an alias, in the trace | accepted: it comes back under its real name and is added again as `generated` (2 of 85 bases on requests) | resolving the alias before the merge |
| peak memory (822 MB on CPython 3.14's `Lib/`, 433 MB on Django) | accepted as measured; a leaner representation stays deferred | a redesign before the first release |

### 23.1 Toolchain and repository layout

```
extractors/python/                     Cargo package `codegraph-python`, standalone (its own [workspace])
  Cargo.toml                           ruff_python_parser + ruff_python_ast + ruff_text_size: ONE git tag;
                                       Cargo.lock holds the commit, every build is --locked
  src/
    cli.rs                             the extractor contract (schemas/README.md §8)
    corpus.rs                          pass 0: walk (ordinal order), read as bytes, PEP 263 decoding, the import roots
    declarations.rs                    pass 1: what one file WRITES — scopes and their bindings, defs, classes, imports,
                                       assignments, and every SITE (a name read, an attribute and the shape of its
                                       receiver, a base, a decorator, a raise). THE ONLY FILE THAT NAMES A ruff_* TYPE
    scopes.rs                          the binding rules: local / global / nonlocal / free, class and comprehension scopes
    resolve.rs                         the module table (dotted name → file), import resolution, re-export chains,
                                       star imports, the MRO (C3), attribute lookup
    stdlib_table.rs                    the embedded table: builtins, modules and their version ranges, classes, bases, members
    ids.rs                             THE Python id scheme (§23.3): keys, escaping
    extraction.rs                      passes 2–4: entities, edges, stubs
    stats.rs                           what was dropped and why — the summary
  tests/contract.rs                    the snapshot byte for byte, determinism (CRLF, creation order), the CLI contract
  data/typeshed-stdlib-<commit>.tsv    the generated table, committed
  data/stdlib-py2.txt                  the module index of the Python 2.7 Library Reference, with its URL (M22b)
  tools/stdlib-table/                  the generator: THE SAME PARSER over `<typeshed>/stdlib/**/*.pyi` + `VERSIONS` —
                                       a separate package, so the extractor links no generator
  trace/codegraph_trace.py             the run-time trace (M22c): one file, standard library only
bin/codegraph-python                   runs target/release/codegraph-python
fixtures/python/src/                   the reference corpus: `acme_order`, `src/`-layout
fixtures/python/expected/model.jsonl   + model.metrics.jsonl: the same model after the metrics pass (§18)
```

- **Building needs Rust at the pinned tag's floor and a C compiler** (`psm`,
  for the parser's stack growth); running needs nothing. `rust-version` in
  `Cargo.toml` is the tag's, so `cargo` says why an old toolchain fails.
- **A git dependency, because there is no other.** The tag is what a human
  reads, the lock's commit is what is built; `RUFF_TAG` in `src/lib.rs` is
  restated for the header and pinned to `Cargo.toml` by a test (the
  `PRISM_VERSION` shape). A bump is a deliberate change that regenerates the
  snapshot — and may raise the Rust floor.
- **The parser's API is internal and unversioned.** It is met in ONE file:
  `declarations.rs` turns the tree into the extractor's own records, and a
  boundary test keeps `ruff_` out of every other source. A bump breaks the
  build there or nowhere.
- **No Python anywhere in the toolchain**, the table's generator included.
- A third-party notice: 60 crates and typeshed-derived data (Apache-2.0)
  ship in the binary — `--licenses`, generated as `codegraph-metrics`
  generates its own.

### 23.2 Mapping table (Python profile) — and the profile corrections M22 forces

`packages/core/src/profiles/python.ts` predates M10, M12 and M13; the first
M22 commit is `feat(core): python profile v2`, data before implementation
(invariant 8), each change with its reason:

| Change | Why |
|---|---|
| kind `decorator` removed; edge `annotationUse` added | the TypeScript rule (§14.2): a decorator application is annotation usage, with its written `arguments`. An entity per application would be the only nameless, bodiless kind in any profile, and `edge:annotationUse>name:route` (§22.3) must mean in Python what it means in Java |
| kind `lambda` removed | a lambda is one expression: it contributes to the invocable that writes it (the Ruby block rule, §19.2). TypeScript keeps `arrowFunction` because an arrow IS how its functions are written; `f = lambda: …` is the variable `f` |
| `variable` is a MODULE-level binding only; `TWithLocalVariables` removed from `function` and `method` | nothing declares a Python local — its first assignment is its declaration — so a local is flow, not structure (the Ruby and Elixir shape). A module global is structure: `settings.DEBUG`, `app = Flask(__name__)`, `logger` are what other files read |
| `TWithChildren` required on `function` and `method` | parameters and nested `def`/`class` are written in them (the Ruby `method` shape) |
| `TChildOf` removed from `module` | the profile linked a submodule to its package's `__init__`. A namespace package (PEP 420) has none, so the tree would hold for some packages and not others; and a file is not WRITTEN in another file (invariant 5). Directories carry the nesting, as for TypeScript and Ruby |
| `TWithInvocations`, `TWithAccesses` optional on `module` | a module body is executable — the §14.2 correction, verbatim |
| `TMetrics` optional on `module`, `class`, `function`, `method`; `TWithValue` on `variable`, `attribute`, `parameter` | M10b, M10c |
| edge `throws` added | `raise` sites |
| `interfaceImplementation` stays in the profile; the extractor writes none | a Protocol is structural: conformance is a `derived` analyzer enrichment (the §14.2 decision), never mixed in |
| lexicon: `fileKinds: ["module"]`, `qualified: { module: "/" }` (it says `"."`) | the module's name is its path (§23.3), whose extension is not a word |
| notes rewritten: star imports, duck typing, synthesized members; new: escaping, the annotation tier, Python 2 | a star import's names ARE attributed when its target is known (below); an untyped receiver is dropped and COUNTED, never a `dynamic-candidate` from the extractor (the §13.2 decision) |
| `lang` stays `python` | `core` owns the vocabulary; the prefix of every key |

Kinds (`TComment`, `TMetrics` optional wherever it makes sense):

| kind | required traits | Python construct |
|---|---|---|
| `module` | `TNamed, TModule, TWithChildren` | a source file, an `__init__.py` included — a package IS that file. Every reserved and external module is this kind |
| `class` | `TNamed, TType, TWithInheritances, TWithChildren, TChildOf, TSourceAnchor` | `class`, at any depth; a `namedtuple(…)` / `NamedTuple(…)` / `TypedDict(…)` / `Enum(…)` call bound to a module name (M22b) |
| `function` | `TNamed, TInvocable, TWithChildren, TWithParameters, TWithInvocations, TWithAccesses, TTypedEntity, TChildOf, TSourceAnchor` | `def` / `async def` in a module or a function |
| `method` | the same | `def` directly in a class body — `@staticmethod` and `@classmethod` included |
| `attribute` | `TNamed, TStructural, TTypedEntity, TChildOf, TSourceAnchor` | a class-level assignment or annotation, and `self.x = …` in a method: ONE entity per class and name (M22b) |
| `variable` | `TNamed, TStructural, TTypedEntity, TChildOf` | a module-level assignment (M22b) |
| `parameter` | `TNamed, TStructural, TTypedEntity, TChildOf` | every parameter; `*args` and `**kwargs` have names |

Construct → what the model says (M22a unless marked):

| Python construct | model |
|---|---|
| `import a.b.c`, `import a.b.c as m` | `import` file → the file `a.b.c` names, `declared` |
| `from a.b import c` | where `a.b` binds `c` at its top level: `import` → the file of `a.b`; else where `a/b/c.py` or `a/b/c/__init__.py` exists: `import` → that file — the order Python itself tries, and the rule of the oracle (§23.6) |
| `from . import x`, `from ..models import Y` | the same, from the importing file's own directory: arithmetic on the path, no root involved |
| an import no corpus file answers | `import` → a stub module: `<stdlib>` when the table names it, else `<site>`, keyed by the dotted name as written |
| a name reached through a re-export (`acme/__init__.py` writes `from .order import Order`; a file writes `from acme import Order`) | the `import` names `acme/__init__.py` — what the source writes; every `reference` and `invocation` of `Order` names the class in `acme/order.py` — what it is (the TypeScript `export … from` rule). Chains are followed to the declaration, cycle-guarded |
| `from x import *` | the `import`; and its names are bound: `__all__` where it is a literal list, else every public top-level name — for a corpus module and for the table's (M22b) |
| an import under `try`/`except ImportError`, under `if`, inside a function, `if TYPE_CHECKING:` | an `import` like any other, module-level (the Java fold); the last is counted `type-checking-only` (§23.10) |
| `importlib.import_module("a.b")`, `__import__("x")` with a literal | `import`, `declared`; a computed name is dropped `computed-import` (M22b) |
| `class A(B, C)` | `inheritance` A → B and A → C, `declared`, each anchored at its base. The order is not in the model (the profile's note stays); the lookup uses it |
| `class A(Generic[T])`, `class A(Base[int])` | `inheritance` to the subscripted name; the arguments are `reference`s |
| `class A(namedtuple("A", "x y"))` | `inheritance` A → `<builtins>/tuple`, **`generated`**; each field an `attribute` (M22b) — the `Struct.new` rule of §19.2 |
| `class A(make_base())`, `six.with_metaclass(M, B)` | dropped and counted `computed-base`; the type is marked as one whose members no line lists |
| `P = namedtuple("P", "x y")`, `NamedTuple("P", […])`, `TypedDict("T", {…})`, `Enum("Color", "RED GREEN")` at module level | a `class` named by the binding, its literal members `attribute`s (M22b) |
| `def f`, nested `def`, `def` in a class, `async def` | a `function` / `method`; written twice under one name (a platform `if`, a redefinition): ONE entity anchored at the first |
| `@overload` signatures and their implementation | ONE entity, anchored at the implementation (the §14.2 rule) |
| `@property` and its `@x.setter` / `@x.deleter` | `method`s, the last two with the `setter` / `deleter` disambiguator; READING `obj.x` is an `access` to the first, not an `invocation` (the C# property rule) |
| `@staticmethod`, `@classmethod`, `@property` | the language: they shape the entity and the lookup, and are no edge |
| any other decorator, on a function or a class | `annotationUse` from the decorated entity to what the decorator names, with its literal `arguments` (`@app.route("/orders", methods=["GET"])`). The entity stays the `def`: what the decorator returns in its place is not in the model |
| a class-level `x: int = 0`, `x = Column(…)`; `self.x = …` in a method; a dataclass field; an `Enum` member | an `attribute`, with its literal `value` when it has one; owned by the root-most corpus ancestor that has the name (the §19.2 field rule). A `def` of the same name in the same class wins the key: the attribute is counted, not an entity (M22b) |
| a module-level `NAME = …` | a `variable`, with its literal `value`; read from a body, an `access`; written under `global`, an `access` that writes. A `def` or `class` of the same name wins the key (M22b) |
| a bare name that reads a corpus class or function, not called | `reference` — `isinstance(x, Order)`, `except OrderError`, `Thread(target=run)` (M22b) |
| an annotation: `x: Order`, `-> Order`, `Optional[Order]`, `list[Order]`, a string annotation `"Order"` | `declaredType` as written; a `reference` to each class it names (M22b). `int`, `str`, `None`, the built-in containers name nothing (the Java primitive rule) |
| `f(…)`, `Order(…)`, `mod.f(…)`, `Order.create(…)`, `self.total()`, `cls.make()`, `super().save()` | `invocation`, **`declared`**: the callee is a name the scoping rules bind, or an attribute of a receiver whose class is WRITTEN (§23.4). `Order(…)` is `Order.__init__` where a corpus class of the MRO writes one, else the class itself |
| `len(x)`, `print(…)`, `str(x)`, a method of a literal (`"x".upper()`) | the LANGUAGE: resolved, counted, **no edge** (the §19.2 rule: an arrow from every function to `<builtins>` says nothing) |
| `os.getcwd()`, `json.dumps(…)` | `invocation` of the stub MODULE — the smallest degraded container a module-level function has (§14.4) |
| `x = Order(…); x.total()`; `self.repo = Repo()` … `self.repo.find()` | `invocation` or `access`, **`derived`**: a local typed by its one assignment in the function, an attribute only ever assigned one class (M22b) |
| `def f(repo: Repo): repo.find()`; a field `repo: Repo`; `make().find()` where `def make() -> Repo` | the same edge, **`derived`**, counted `annotation-typed` — an optional or a union with `None` unwrapped, anything wider untyped (M22b) |
| a member nothing in the corpus declares, where exactly ONE library class stands in the MRO | `invocation` / `access` of that stub, **`derived`**, counted `ancestor-attributed` — where `Order.objects` and `self.assertEqual` land; with two, dropped `ambiguous-ancestor`, the drop naming both (M22b) |
| the same in a class that writes `__getattr__` / `__getattribute__`, has a `metaclass=`, or a computed base | dropped `unbound-dynamic`: "nothing declares it" is no longer evidence |
| `x.y` with `x` a bare parameter, a call's result, a subscript | dropped and counted `untyped-receiver` — the stated ceiling |
| `raise Foo`, `raise Foo(…)`, `raise Foo(…) from e` | `throws` to Foo; `raise e` inside `except Foo as e` → Foo (the clause guarantees it); a bare `raise` nothing; any other value dropped `raise-of-a-value` (M22b) |
| `--trace`: a base the interpreter holds and no line writes | `inheritance`, **`generated`**, anchored on the class declaration (M22c) |
| `--trace`: a call made at a site the baseline left unresolved | ONE `invocation`, **`dynamic-candidate`**, `candidates` = every function that site was seen to enter (M22c) |
| a docstring; else the `#` block directly above a declaration | its `comments`, the coding cookie, the shebang and `# type:` / `# noqa` / `# pylint:` / `# pragma:` directives left out; `sloc` on modules, classes and invocables, `cyclomatic` on invocables (M22b) |

Explicitly NOT extracted in M22, stated in the profile `notes`: members a
decorator or a metaclass synthesizes (a dataclass's `__init__`, a Django
model's manager — the class's own fields ARE written and are attributes);
monkey patching (`Order.total = total`); Protocol conformance; what a string
names (`ForeignKey("orders.Order")`, `INSTALLED_APPS`, an entry point in
`pyproject.toml`) — framework semantics, the M10d door; `isinstance`
narrowing; `# type:` comments; notebooks; Cython.

### 23.3 The Python id scheme (`ids.rs`)

```
module (file)      python:src%2Facme%2Forder.py                 path relative to the root, escaped
package            python:src%2Facme%2F__init__.py              a package is its __init__ file
reserved           python:<builtins>                            what the interpreter binds before any file runs
standard library   python:<stdlib>%2Fos.path                    a module of the table, as the import writes it
third party        python:<site>%2Fdjango.db.models             a module nothing here declares, as written
missing relative   python:src%2Facme%2Fmissing.py               a relative import to a file that is not there
class              python:src%2Facme%2Forder.py/Order           nested: Order.Line
function           python:src%2Facme%2Forder.py/total_of        nested: total_of.helper   a local class: make.Local
method             …/Order.total     accessors: …/Order.total#setter   …/Order.total#deleter
parameter          …/Order.total#param:currency     …/Order.total#setter#param:value
attribute          …/Order.lines                    variable: python:src%2Facme%2Fsettings.py/DEBUG
stub type          python:<builtins>/ValueError     python:<stdlib>%2Fenum/Enum     python:<site>%2Fdjango.db.models/Model
```

- **The module is the file, and so is its name** (the TypeScript rule,
  §14.3). The dotted name is not the key because it is not unique —
  `conftest`, `setup`, `__main__`, `tests.test_models` recur across one
  repository — and not the name because it depends on which directory is
  taken for a root, which is an inference (§23.4). A key must not move when a
  heuristic does.
- **No arity, no `static` disambiguator.** Python has no overloading, and a
  class holds one member per name whatever decorates it. The only names the
  language lets coexist are an accessor's: the disambiguator is the word the
  source writes after the dot (`@total.setter`).
- **Escaping, the Ruby rule (§19.3).** `/`, `#`, `%` percent-encoded in every
  path segment, and `<` so that no walked path can spell a reserved module.
  A NAME is an identifier and needs none — `.` cannot occur in one, so it is
  the nesting separator unescaped. Identifiers are NFKC-normalized, as the
  language normalizes them (the parser does it; a test pins a ligature and
  its expansion to one key).
- **An external module is named as the import writes it**, one stub module
  per dotted name: `django.db` and `django.db.models` are two, as `zod` and
  `zod/v4` are (§14.3). Which DISTRIBUTION ships a module is written nowhere
  in the source (`yaml` is PyYAML's), and is not guessed.
- **A stub's symbol is the name as written at the site**, under the module it
  was imported from — not where typeshed, or the library, really declares it
  (`collections.abc.Mapping`, whatever re-exports it).

### 23.4 Stub discipline, the import resolver, the receiver

**The module table and its roots.** A dotted name is a path below a root, and
Python finds roots in `sys.path`, which no source writes. So:

- **A relative import needs no root** — it is resolved from the importing
  file's directory, exactly.
- **A regular package names its own root**: from a file, climb while the
  directory holds an `__init__.py`; the first directory that does not is the
  root of that file's dotted name. This is what mypy does, it needs no
  configuration, and it is exact for `src/` and flat layouts alike.
- An absolute import is looked up in every root so found, plus the corpus
  root, plus each `--import-root`; the root NEAREST the importing file wins,
  and a tie is dropped and counted `ambiguous-root`. A hit that crosses a
  directory with no `__init__.py` (a namespace package) is counted on its
  own; so is `implicit-relative` — an absolute import answered only by a
  sibling of the importing file, which is Python 2's rule inside a package
  and Python 3's for a script's directory.
- The corpus answers before the table: a corpus `logging/` at a root shadows
  the standard library, as it does on `sys.path`.
- `acme.py` beside `acme/__init__.py`: the package wins, as in Python.

Each of these is a fact about the LAYOUT, not about the language, and is
named as one on stderr under its own counter (the §14.4 and §19.2 precedent).

**Names.** Pass 1 records every scope's bindings; a name read is looked up as
the compiler would — the enclosing function scopes (never a class body), the
module, `builtins`:

| The resolver says | The model says |
|---|---|
| bound by a corpus `def`, `class` or assignment — in this file, or through an import chain | the declaration |
| bound by an import of a module the table has, or a name of it | a stub below `<stdlib>`: a class the table lists is a stub type; a function or a value folds to the stub MODULE (§14.4) |
| a name of `builtins` | a stub below `<builtins>` ONLY as a base, a `raise` or an `except` target; called or annotated, it is the language: no entity, no edge |
| bound by an import nothing answers | a stub below `<site>`: a stub CLASS on evidence — a site inherits from it, raises or catches it, or annotates with it — else the stub module |
| bound only by a star import of ONE unknown module | that module's, `derived`, counted `star-attributed` (the Elixir `import-attributed` rule); with two, dropped |
| bound by nothing | dropped and counted `unbound-name` — never a guess |
| a module bound more than one way (`try: import json` / `except: json = None`) | the first binding in source order that names a declaration; counted `rebound-name` |

Resolvability is not membership, and neither is presence on disk: a virtual
environment below the root is not corpus. It is recognised by what it IS — a
directory holding `pyvenv.cfg` — not by a name; `site-packages`,
`__pycache__`, `node_modules` and dot-directories are skipped by name. Code a
repository vendors (`_vendor/`) is written there and is corpus.

**Attributes: the shape of the receiver decides everything** (the §19.4
table, for a language with annotations):

| Receiver | Looked up in | Provenance |
|---|---|---|
| a module (`import a.b` … `a.b.f`, `import x as m` … `m.f`) | that module's top-level bindings, through re-exports; a submodule where a component names one | `declared` |
| a class named at the site (`Order.create`, `Order.MAX`) | its MRO | `declared` |
| `self` / `cls` — the first parameter of a method, by what decorates it — and `super()` | the enclosing class's MRO; `super()` from the next class in it | `declared` |
| a local assigned `Foo(…)` once in the function; an attribute only ever assigned one class | that class's MRO | **`derived`** — flow |
| a parameter, attribute or call result ANNOTATED with a class | that class's MRO | **`derived`** — written, and unchecked |
| a literal | the literal's class | the language: no edge |
| anything else | nothing | dropped, `untyped-receiver` |

The MRO is C3 over the bases that resolve; a base that does not (a call, a
`<site>` stub) ends the certain part of the chain, and says which library
could answer what the corpus does not. What answers decides the edge, as in
§19.4: a corpus `def` → `invocation`; a `@property` or an attribute →
`access`; nothing, and one library ancestor → the `derived` attribution;
two → `ambiguous-ancestor`; none → `unbound-self-call`; a class with
`__getattr__`, a metaclass or a computed base → `unbound-dynamic`.

### 23.5 The extractor command-line contract, plus three flags

Same flag shape and exit codes as every extractor (`schemas/README.md §8`).
Its own: `--import-root <dir>` (repeatable — a root no `__init__.py`
betrays, as `PYTHONPATH` would name it; it changes how imports resolve and no
key), `--explain-dropped` (the §19.5 listing: `dropped <reason>: <file>:<line>
<what>`, no byte of the model changed), and `--trace <file>` (M22c).
`stdout` carries nothing but `--help` / `--version`:

```
syntax errors (recovered, n): src/acme_order/legacy/report.py
decoded (not UTF-8, n): src/acme_order/legacy/latin.py (iso-8859-1)
RESOLUTION SUMMARY
  files           : n (with syntax errors: n; not UTF-8: n)
  sites           : n
  resolved        : n (corpus n, <stdlib> n, <site> n, the language n)
  unresolved      : n
  resolution rate : n %
  untyped-receiver (dropped)  : n
  unbound-self-call (dropped) : n
  …
  annotation-typed            : n
  ancestor-attributed         : n
  imports         : n (relative n; by package root n, by namespace package n, implicit-relative n;
                       <stdlib> n, <site> n; type-checking-only n)
  entities        : n (stubs: n)
  edges           : n (self-edges dropped: n)
```

A **site** is a name read, an attribute, a base, a decorator, an annotation's
class, a `raise`; the rate is over the sites that named something, the
language included. The drops ARE the list the counts are derived from
(`listed == counted`, a contract test — the §19.8 guard, from the start).

**`--trace <file>` (M22c)** merges what `trace/codegraph_trace.py` wrote from
inside the running program: `python <repo>/extractors/python/trace/
codegraph_trace.py -m pytest`, or a script in `-m`'s place. One file,
standard library only, Python ≥ 3.8 (`sys.monitoring` from 3.12,
`sys.setprofile` before); it runs the PROJECT's code, which the extractor
never does. At exit it reads `sys.modules` for what lives under the root —
each class's bases, each function's file and first line — and, with
`CODEGRAPH_TRACE_CALLS=1`, the calls it saw. JSONL, names and positions,
**never a key**. Merged after the baseline, under §19.5's three rules: a base
no line writes is a `generated` `inheritance`; a call at an unresolved site
is one `dynamic-candidate` `invocation`; a function the interpreter holds on
a line with no `def` is counted and gets no entity. No entity is added and no
edge of the source changes: a tested property.

### 23.6 Validation (the M2 gate, replayed a sixth time)

- **Walking skeleton first** (M22a): one corpus in, `codegraph validate`
  green, snapshot committed, the core gate (parses as a `Model`;
  byte-identical to core's encoder; ZERO profile issues; closed; no
  self-edges; the stub-discipline evidence by id).
- **The fixture corpus** `fixtures/python/src` — `acme_order`, `src/`-layout,
  each file pinning one hazard (its README lists them). M22a: a regular
  package and a namespace package; a re-export chain through two
  `__init__.py`; relative imports one and two levels up; `from a import b`
  where `b` is a name and where it is a submodule; a missing relative import;
  an import by sibling; two `conftest.py`; `acme.py` beside `acme/`; a
  diamond; a built-in exception, a `<stdlib>` base and a `<site>` base; a
  nested class, a nested function, a class in a function; every parameter
  shape; a `def` written twice; a Python 2 file; a file with a real syntax
  error; a Latin-1 file with its cookie and one with a BOM; a `#` in a file
  name; a non-ASCII identifier and its NFKC twin; a directory holding
  `pyvenv.cfg` that must not appear. M22b adds what a body says: every
  receiver shape of §23.4 with its provenance; an annotated parameter, an
  optional, a string annotation; `__all__` and a star import, one unknown and
  two; `property` with its setter, `@overload`, a decorator with arguments;
  a dataclass, both spellings of a named tuple, an `Enum`; `global` and
  `nonlocal`, a comprehension's scope, a lambda that is no entity;
  attribution to one library ancestor and the refusal with two; a class with
  `__getattr__`; `raise` in each of its forms; `importlib.import_module`
  literal and computed; `match`, a walrus, a PEP 695 `class A[T]`; a `.pyi`
  beside its `.py` and one alone; a shebang script with no extension.
- **The metrics pass** (§18): `python` joins the five features of
  big-code-analysis 2.2.0 — it has the grammar — and `"python" =>
  LANG::Python` the join; a sixth `model.metrics.jsonl`, hand-counted on one
  function, the witness `sloc = ploc` stated with whatever it does not join.
- **Extractor-side tests** (cargo): the walker, the scopes, the resolver and
  the writer as unit tables; `tests/contract.rs` holds the library to the
  snapshot byte for byte, to a CRLF copy created in reverse order, and to the
  CLI contract.
- **The audit (M22c)**, five corpora, each model `validate`-clean, reported
  as §19.6's table (files, sites, resolved, entities and stubs, edges, time):

  | corpus | what it is there to measure |
  |---|---|
  | requests | a plain library: the import resolver, a flat layout |
  | Django | metaclasses and strings: the ceiling, and where `ancestor-attributed` and `unbound-dynamic` land |
  | Zulip (a Django application under mypy) | the annotation tier at its best, on application code |
  | CPython 3.x `Lib/` | a corpus that IS the table: every import must resolve to a corpus file and none to `<stdlib>` — the §19.4 misreading, measured |
  | CPython 2.7.18 `Lib/` | Python 2 from the recovered tree: declarations by name and line, and what a body loses |

- **The oracles (M22c)** — each run in a container, since the extractor's
  build machine needs no Python and must not be trusted to have the right one:
  1. **Parity with CPython's `ast`** — the oracle this language needs and
     Ruby did not. On every file of the audit CPython accepts, each
     `ClassDef`, `FunctionDef`, `AsyncFunctionDef` and import statement, by
     (file, line, name), against the model's entities and import sites; the
     only differences allowed are the stated folds (a redefinition, an
     overload). For the Python 2 corpus, `lib2to3` under CPython 3.12 stands
     in — the count parity already measured, now by name and line.
  2. **The import graph, against grimp** (the engine of import-linter, which
     reads imports statically as Packwerk read constants): on Django, the
     module → module edges of both, each difference classified.
  3. **References, against pyright** (scip-python, on a corpus with its
     environment installed): for every site where the model wrote an edge,
     does pyright name the same definition? Reported PER PROVENANCE:
     `declared` must agree up to documented rules — a disagreement is a bug —
     and the `derived` tiers are measured (`annotation-typed`, flow-typed,
     `ancestor-attributed`), which is the evidence the annotation decision
     above is confirmed or reversed on. And the converse: what pyright
     resolves that the baseline dropped — the ceiling, with its cause.
  4. **Import time** (the trace on requests' own tests): of the functions the
     model declares in the files that were imported, how many the interpreter
     holds on the same line; how many it holds that no line writes; of the
     calls observed, how many are edges the baseline wrote.

### 23.7 Distribution

One binary per platform from a runner of its own OS, the `ruby-native` shape
(§19.7) without its `libclang-dev` step: `codegraph-python-<rid>`, each
re-extracting the fixture and `cmp`ed with the snapshot; `python` in the
release job's copy loop; the `python` row of `BINARY_EXTRACTORS` in
`scripts/homebrew/render.mjs` (so `Formula/codegraph-python.rb` depends on the
pass like every extractor) with its `render.test.mjs` case; the `python` row
of the app's catalogue (`extensions: [".py", ".pyi", ".pyw"]`) with its
discovery test. All of it is M22c; M22a ships `bin/codegraph-python` over
`target/release/`. A release that renders the tap then needs the four
`codegraph-python-<rid>` sums: the job, the loop and the row land together.

### 23.8 Hazards, each with the test that pins it

| Hazard | Where it shows | Guard |
|---|---|---|
| the parser takes a `&str`; a source need not be UTF-8 | 24 of the 1 612 files of CPython 2.7's `Lib/` | pass 0 reads bytes, honours a BOM and the PEP 263 cookie of the first two lines, decodes UTF-8, Latin-1, ASCII and cp1252 itself; any other encoding is read lossily (U+FFFD) and COUNTED. The file is never rejected |
| Python has three line endings: `\n`, `\r\n` and a lone `\r` | a 2003 file saved on a Mac | lines are the parser's, not a count of `\n` (§19.8's rule is wrong here); a fixture file with lone `\r`, and the CRLF determinism test |
| the parser recurses | a generated module of one 10 000-term expression | the crate's `stacker` feature, and the walker on a thread with a stated stack; a test at the depth that overflows without them |
| a git dependency on a tag someone else can move | a rebuild fetches other code | `Cargo.lock`'s commit, `--locked` everywhere, `RUFF_TAG` pinned to `Cargo.toml` by a test |
| the parser's API is internal, version `0.0.x` | a bump renames a node | one file names `ruff_` types (a boundary test); a bump is a reviewed change that regenerates the snapshot |
| Ruff's Rust floor rises about every six weeks | a bump fails on a machine one release behind | `rust-version` is the tag's; CI builds on stable; README names the floor |
| identifiers are NFKC-normalized by the language | `ﬁle` and `file` are one name | the parser normalizes; a test with the pair |
| one dotted name in two places | two `conftest.py`, two `tests/` | the key is the path; the resolver takes the nearest root and counts a tie |
| a corpus module named like a standard one | `logging/`, `types.py`, `queue.py` at a root | the corpus answers first; CPython's own `Lib/` in the audit is the limit case |
| `if TYPE_CHECKING:` imports | a cycle the Cycles tab shows and the program never has — the idiom exists to break it | written, so emitted; counted `type-checking-only`, the count in the profile note; the mark itself deferred (§23.10) |
| setuptools' `build/lib/` | every module twice | measured on the audit before a rule is written; no directory is skipped on its name alone |
| a re-export or a star import that loops | `a/__init__` from `b`, `b` from `a` | fixed point with a visited set; a fixture pair |
| a conditional definition | `if sys.platform == "win32": def f` … `else: def f` | one entity anchored at the first; both bodies' edges are its own |
| an attribute and a `def` of one name | `self.total = 0` beside `def total` | the `def` holds the key; the attribute is counted |
| a virtual environment inside the root | 40 000 files that are not the corpus | `pyvenv.cfg`, not a directory name |
| canonical order, JSON bytes, `\` separators, enumeration order, symlinked directory cycles | as §19.8 | the same guards, from the shared writer |
| a trace that names what the model does not hold | a function a decorator made | counted, never an entity: the entities with and without a trace are the same lines |

### 23.9 Milestone split

- **M22a — profile v2 + skeleton + contract.** The writer lifted out of
  `extractors/ruby` (Ruby's snapshot unchanged, byte for byte);
  `feat(core): python profile v2` (§23.2) and the registry test;
  `extractors/python/` on the pinned parser with the embedded table and its
  generator; the walking skeleton — files and their decoding, the import
  roots, classes, functions, methods and parameters at every nesting,
  imports (absolute, relative, the submodule rule, re-export chains), bases,
  the three stub roots — → `fixtures/python/expected/model.jsonl`
  byte-identical to core's encoder and profile-valid with zero issues; the
  core gate; `bin/codegraph-python`; `build.sh --python` / `test.sh
  --python` with the release-binary `cmp`; `python-test` in CI. *First
  step, before any of it:* the parity script of §23.6 on the fixture and on
  requests — if `ast` and the recovered tree part on valid Python 3, the
  parser decision is reopened here, not in M22c.
- **M22b — the model.** `attribute` and `variable`; scopes and the name
  tiers; the receiver table of §23.4 with its provenances; star imports;
  `annotationUse`, `access`, `reference`, `throws`; synthetic classes;
  annotations and `declaredType`; comments; `sloc` + `cyclomatic`, literals;
  the Python 2 module list; `.pyi` and shebang files; `python` in the
  metrics pass and a sixth `model.metrics.jsonl`; the full fixture with its
  README; the fixture in every per-fixture suite (core, analyzer
  conformance, city, navigator, vocabulary, CLI `validate`, and M21a's
  goldens if they exist by then); every CLI command verified on it; city and
  navigator screenshots reviewed.
- **M22c — audit + oracles + distribution.** The five corpora and the four
  oracles of §23.6; the trace file and `--trace`; the defects found named in
  the profile notes with their counts; the annotation decision confirmed or
  reversed on the pyright numbers; binaries on four Unix runners, the
  registry entry, the formula; `--licenses`; `docs/python-extractor.md`, the
  website's extractor, install and profile pages (the last is generated),
  README, CLAUDE.md.

Definition of done: `fixtures/python/expected/model.jsonl` byte-identical to
core's encoder and profile-valid with zero issues; the same bytes from the
binary on every runner; declarations equal to CPython's `ast` on every file
it accepts, up to the stated folds; the import graph equal to grimp's on
Django up to the documented differences; `declared` edges agreeing with
pyright up to documented rules, the `derived` tiers measured; the audit
numbers in the profile notes; `./test.sh` and CI green with the Python
fixture in every per-fixture suite.

### 23.10 Deferred, explicitly

- **A typed-receiver pass on ty**, when it has an API to pin: the largest
  single gain left (`untyped-receiver` is the ceiling), from crates of the
  same repository and tag — `derived`, behind a flag, never the baseline.
- **A mark on a type-only import** (`if TYPE_CHECKING:`): a core change — the
  import edge has no place for it, and Python declares no `space` — to make
  when the audit's count says what the Cycles tab is being shown.
- **A PyPI wheel** of the binary (`uvx codegraph-python`; the channel Ruff
  itself uses, and this language's npm): not while npm's trusted publishing
  fails behind a green job (v0.2.0, v0.3.0) — a second registry of the same
  shape is not added on top of a red one.
- Framework semantics (Django's string references and `INSTALLED_APPS`,
  FastAPI's `Depends`, entry points) — M10d's door, per framework.
- Notebooks (the parser reads cells), `# type:` comments, `isinstance`
  narrowing, a literal monkey patch as `attachedTo`, `ABC.register` as a
  declared `interfaceImplementation`, roots read from `pyproject.toml`, a
  Windows binary, Cython (not Python's grammar).

## 24. Phase 21 — The discovery walk as agent skills: a `codegraph` plugin (M23)

Motivation: the six pages of `website/content/docs/discover/` are a METHOD
for a person with a terminal — six questions in a fixed order, each page
ending on a "Write down" list the next one reads, three habits that make
the result checkable. An agent can run every command in them. What the
reader still does alone is the rest: choose the source roots, see the three
rows that matter among forty, remember at step 3 what step 1 found, decide
at step 5 what is worth paying for. The request: a skill that, given a
path, has an agent GUIDE a person through the walk progressively, split
into sub-skills where that helps, with codegraph and the Specy toolkit as
its tools.

**Decision: a Claude Code plugin named `codegraph`, in this repository and
versioned with the CLI — one guide skill (`discover`), one skill per
question (`discover-1-structure` … `discover-6-domain`) and a `query`
utility. The skills hold no method of their own: the pages are the method,
and the SQL both run is ONE set of files. What a step learned is written to
disk, in `.codegraph/` at the root of the analyzed repository, never kept
in the conversation. Steps 1–5 need only codegraph; step 6 hands over to
the Specy plugin, which is detected, not required. The CLI gains
`codegraph query`, so that no step needs `sqlite3`.** Rejected, each with
its reason:

- **One skill for the whole walk.** After a compaction Claude Code keeps
  the first 5 000 tokens of an invoked skill (25 000 across all of them);
  the six step pages are 9 326 words. A walk that reaches step 4 has been
  compacted, and the steps it would forget are the ones that spend money.
  Specy's `domain-extract-from-code` template is 2 638 lines: the shape not
  to copy.
- **A skill inside the Specy plugin.** Specy is a CONSUMER of codegraph's
  artifacts, at step 6, and that is its place. A skill that spells
  `codegraph` flags must be released with the binary that parses them: the
  test of §24.8 reads this repository's `CommandSpec` tables, and cannot
  from another one.
- **A subagent per step** (`context: fork`). A step is a conversation; a
  fork returns a summary and cannot ask. Forks are for the work INSIDE a
  step that holds no question — the extraction, the history mining.
- **An MCP server over the model.** The CLI is the interface already, with
  `--json` on every report; a server is a second surface to version, and
  no step needs a tool the shell does not give.
- **Relying on `sqlite3`.** It is not on this machine, and one block of the
  method cannot run without its shell (measured below).
- **The workspace in Specy's `specy/codegraph/`.** That directory is
  Specy's, inside a tree the user may commit. The walk's artifacts exist
  before Specy is involved and belong in one hidden directory; Specy learns
  to read it (§24.6).
- **A template assembler like Specy's `build.sh`.** It inlines shared text
  into every `SKILL.md`, which is what the token budget forbids. Shared
  text is a file under `references/`, read when a step needs it.

**Measured before planning** (2026-11-21; throw-away scripts, nothing
committed):

| Question | Result |
|---|---|
| Which tools does the method assume, and which does this machine have? | `sqlite3`, `dot` and `duckdb`: absent. `jq`: present. `node:sqlite` is already inside the binary (Node 22.22.2 here) |
| Do the pages' SQL blocks run as written? | 18 blocks on the six pages and the how-to they point to, run through `node:sqlite` with the two helper views, on `fixtures/java` and on PetClinic: **17 run, 1 cannot** — `activity.md:97` is `sqlite3` shell (`.mode csv`, `.output`), and the join it feeds is "a spreadsheet, a notebook or ten lines of any language". The three Spring queries return no row on the fixture, which has no Spring, and 24, 17 and 5 on PetClinic |
| How many definitions of the helper views? | three copies (`how-to/query-model-db.md`, `tutorials/sql.md`, `docs/sql-cookbook.md`), equal once comments are stripped — and no test runs any of the 18 blocks |
| Does a read-only handle hold the views, and is it enough? | `readOnly: true` accepts `CREATE TEMP VIEW`, refuses a write to the store and the `ATTACH` of a new file, answers "not authorized" to `load_extension`; the store's sha256 is unchanged. **It does not refuse `VACUUM INTO 'file'`**, which wrote a 221 184-byte copy: the handle protects the store, not the disk. Named parameters bind (`:id`) |
| How long do the three free steps take? | PetClinic, cold, 13 commands: two extractions (main 1.7 s, test 3.6 s), `validate`, `import`, the metrics pass, cycles, coupling, wiring, `scm` (0.8 s), three history reports, the history side-car — **9.5 s in all** |
| What does the paid step cost? | already recorded: the Java fixture $0.06 on OpenRouter (M11) and $1.03 through Claude Code (M20b); PetClinic's store $0.13 (M19c) |
| Can the page be pointed at one building? | no: it reads `?src=` and `?city=` only (grep of `navigator-ui` and `viz`) |
| What does Claude Code give a plugin? (its docs read 2026-11-21; CLI 2.1.330) | a skill is `skills/<name>/SKILL.md`, invoked `/codegraph:<name>`; `${CLAUDE_PLUGIN_ROOT}` reaches the plugin's other files; a top-level `bin/` blocks installation on claude.ai; `claude plugin validate`, `details` (projected token cost), `eval` and `tag` exist. **Not documented: one skill invoking another, and any way to declare an external command as a prerequisite** |
| What does Specy read today? | `domain-extract-from-code` (2672f03) looks for `specy/codegraph/*.insights.jsonl`, then any `*.insights.jsonl`, and honours `$CODEGRAPH_HOME/bin`; it already reads the side-car before source, which `domain.md` still calls "the planned change". `architecture-extract-from-code` and `sysreq-extract-from-code` know nothing of codegraph |

Six principles, locked up front:

1. **The pages are the method; the skills execute it.** A skill states no
   step, threshold or reading rule the pages do not. When a step needs a
   query the pages lack, the page gets it in the same commit.
2. **Kinds of knowledge are never mixed.** The page names five:
   `declared`, `derived`, `dynamic-candidate`, co-change and a model's
   explanation. The walk adds a sixth, what a person said, and keeps
   `generated` apart where a trace was merged. Every claim in the notebook
   carries its kind and its anchor — `file:line` at a commit, or the saved
   query and row, or who said it and when. A claim with no anchor is
   written as a question.
3. **State on disk, not in the context.** A step starts by reading the
   state file and ends by writing it. A session that starts cold says
   where the walk stands and how far the model is behind `HEAD`.
4. **No money spent, and no source sent to a second provider, without a
   yes per scope.** The session's own model reads whatever the agent
   reads, and intake says so; what the gate guards is a SECOND provider
   and a bill. `explain` is given `--yes` only after that yes.
5. **The walk changes nothing it was not asked to change.** No install
   (the two brew lines are printed), no run of the analyzed project's code
   (the Elixir and Ruby traces are the user's to run), no write outside
   `.codegraph/` and `specy/`, no tracked file touched, `serve` on
   `127.0.0.1`, a secret's value never printed.
6. **The "Today" column is carried, not hidden.** Each step says what the
   tool does not do for this language, before the person finds out.

### 24.1 Repository layout and packaging

```
plugin/                            the plugin root: what the marketplace entry points at
├── .claude-plugin/plugin.json     name "codegraph"; version = the root package.json's
├── skills/
│   ├── discover/SKILL.md          the guide
│   ├── discover-1-structure/ … discover-6-domain/    one SKILL.md each
│   └── query/SKILL.md
├── references/                    read on demand, never inlined
│   ├── rhythm.md                  the seven beats and the gate (§24.3)
│   ├── evidence.md                the kinds of knowledge; how a claim is written
│   ├── state.md + discovery.schema.json
│   ├── words.md                   the page's "Words used in this section"
│   ├── capabilities.md            GENERATED from core's profiles
│   └── stacks/spring.md …         entry points and roles, per framework
├── queries/*.sql                  one statement per file, named parameters (§24.4)
└── evals/                         `claude plugin eval` cases (§24.8)
.claude-plugin/marketplace.json    repository root: one plugin, source `./plugin`
```

- **Text and SQL, nothing executable.** No `bin/` (it blocks claude.ai),
  no MCP server, no hook, no build step. CLAUDE.md gains the boundary: the
  plugin imports nothing and nothing imports it.
- **Tool lookup is Specy's**: `$CODEGRAPH_HOME/bin/<tool>` when executable,
  else `PATH`. A missing `codegraph` or extractor prints its brew line and
  stops; a missing pass or provider is said and the walk goes on.
- **`capabilities.md` is generated**, as `website/scripts/profiles-page.mjs`
  generates the profiles page: which kinds, edges and measures each
  profile gives, which frameworks have a profile (Spring only), which
  extractors take a trace. A test fails when regenerating it changes it.
- **Each step file stands alone**: at most 300 lines and 2 500 words (the
  proxy for the 5 000-token cut), the question, the required artifacts,
  the commands and the gate on its first screen.
- **The guide does not depend on one skill invoking another.** It names
  the step's skill; where the host does not load it, it reads
  `${CLAUDE_PLUGIN_ROOT}/skills/<step>/SKILL.md`, the same file. M23a's
  first step measures which of the two a session does.

### 24.2 The skills

| Skill | The agent runs | Only a person can say | Written down |
|---|---|---|---|
| `discover` | preflight, intake, routing, resume | purpose, time at hand, the step-5 gate | intake, the final report |
| `discover-1-structure` | one extraction per source root, `validate`, `import`, the metrics pass, the page's four queries, cycles by module, coupling by type | which outliers are generated or vendored | resolution rate, the breaks in the two curves, the largest tangle and its feedback set, top fan-in |
| `discover-2-boundaries` | module graph, external modules, module → external reach, annotation census, `--report wiring` on Spring | what each unknown external module is; who calls this system | the style claim with the checks that held and failed, the stack, inbound and outbound lists |
| `discover-3-activity` | `scm`, the six `history` reports, the history side-car, the joined hotspot report (§24.5) | the window, the false positives, whether each top owner is still there | the hotspot shortlist, hidden couplings, the cross-module co-change share |
| `discover-4-stimuli` | the page's three detection layers merged into one inventory; a forward slice per entry point, on facts then with candidates; overlap groups; the residue | the business name of each use case | the inventory with the layer that found each row, a reading order per chain, the residue split stable / active |
| `discover-5-meaning` | `--dry-run`, `--estimate`, a scope proposed from steps 3–4, the run in the background, the `insights` and `vocabulary` readings | the yes; the review of `unknown` and low-confidence records | module purposes, the three-readings table, the glossary, polysemous words |
| `discover-6-domain` | `domain-facts`, purity, chain position, then the Specy extraction with the hotspot ranks | a domain expert's confirmation of aggregates, invariants and events | the verdict per module, the `.domain`, the weighted refactoring report |
| `query` | a question in words → one `SELECT`, saved with its result | — | a query a claim can cite |

**Every step is enterable on its own.** It lists the artifacts it needs,
builds the free ones itself (9.5 s on PetClinic), and stops only for what
costs money or a decision: step 6 without step 5's records says what the
model will lack and asks.

**`discover <path> [--tour] [--step N]`.**

- *Preflight*, free and silent: the tools found and their versions; a git
  repository or not, and how deep (a shallow clone makes step 3
  unavailable); a language census by extension over `git ls-files`,
  against the installed extractors; candidate source roots, main and test
  apart as the page asks (a build file is read, never run); the providers
  configured, BY NAME — whether a variable is set, never its value —
  and `claude` on `PATH`; the Specy plugin present or not; an existing
  `.codegraph/`.
- *Intake*, three questions at most, each skippable:
  1. the purpose — takeover, migration, due diligence, onboarding. It sets
     the emphasis (migration: steps 4 and 6; due diligence: 1–3) and the
     shape of the report;
  2. the time at hand — the tour, a session (steps 1–4), the whole walk;
  3. the step-5 gate, asked now so nothing is discovered late: may source
     go to a second provider, which one, under what ceiling in dollars.
     "No" is a complete answer; the walk then continues on facts.
- The extraction and the mining run in the background while the person
  answers.
- *`--tour`*: steps 1–3 with no question (9.5 s of commands on PetClinic)
  and a one-page brief — every guess marked as one, the questions
  collected at the end instead of asked.

Per step, what the table does not say:

- **1.** The outliers a person excludes go to a list in the state file,
  shown at every later ranking. Picture: the city,
  `--height sum:cyclomatic --footprint loc`.
- **2.** Picture: the Graph tab in module mode — the page's `dot` is not
  on every machine; `export --format plantuml` when a file is wanted.
  Exit: `/specy:architecture-extract-from-code` (§24.6).
- **3.** Picture: `--height history-file:churn_recent --carry
  history:risk_score`. Author names stay in the workspace; a shareable
  text says "one owner, 78 %", not who.
- **4.** Each row is classified by the page's seven kinds of stimulus,
  from the stack table; a row no table classifies is shown as
  unclassified. The agent PROPOSES a business name per use case and the
  person corrects it; the name is recorded as said by a person. Zero rows
  from a stack table is "not detected", never "none". Exit:
  `/specy:sysreq-extract-from-code` on the chains chosen.
- **5.** Prices are read from this run's `--estimate`, never remembered.
  An API key is preferred when one is configured (the fixture cost $0.06
  there, $1.03 through Claude Code), else Claude Code with its price
  said. Picture: `--height vocabulary:<word>` for a word the glossary
  flags. On a no, the agent reads the top hotspot types itself and writes
  what it finds as a model's explanation, origin "session".
- **6.** Without the Specy plugin the step stops at the verdict per module
  and prints the install line. `specy validate` runs on the result when
  the command is there.
- **`query`.** The schema is read with `sqlite_schema` and
  `pragma_table_info()`, which are `SELECT`s. Each query is saved as
  `.codegraph/queries/NN-<name>.sql` with its result, so a notebook claim
  cites a file.

### 24.3 The workspace, the state, the rhythm

```
<repo>/.codegraph/                 added to .git/info/exclude when created
├── discovery.json                 codegraph.discovery/1: the agent's
├── NOTEBOOK.md                    the person's
├── REPORT.md                      written at any stop (§24.7)
├── <root>.jsonl  <root>.db  <root>.history-metrics.jsonl  <root>.insights.{db,jsonl}
├── history.jsonl  domain-facts.json
└── queries/NN-<name>.{sql,json}   every query run, with its rows
```

- **`.git/info/exclude`, not `.gitignore`**: a client's tracked files are
  not edited, and `git status` stays what it was. Outside a git
  repository the directory is the same, step 3 is unavailable and said
  so.
- **`discovery.json`** (`codegraph.discovery/1`, a JSON Schema in
  `references/`):
  - `intake`: purpose, time, the provider allowed and its ceiling;
  - `corpus`: path, the commit extracted, languages, source roots,
    excluded paths with the reason and who gave it;
  - `steps`: per step, a status (`todo`, `done`, `partial`, `skipped`),
    the commit it ran at, and `findings` — the page's "Write down" list
    as fields, each value with its kind and anchor;
  - `questions`: what no file answers, with the step that raised it and
    who could answer;
  - `spend`: per run, the provider, model, calls and dollars the CLI
    reported — never a price;
  - `taught`: the terms already defined to this person.
- **Behind `HEAD`.** A session compares `corpus.commit` with `HEAD`, says
  by how many commits and files, and offers to redo the free steps
  (seconds). Step 5's records survive by fingerprint: a re-run pays for
  what changed.
- **The rhythm**, one file (`references/rhythm.md`), seven beats per step:
  1. *frame* — the question, its cost, what the person will hold after;
  2. *run* — outputs to files, never a wall of text;
  3. *show* — three to five rows and one picture;
  4. *read* — how to read them; a term is defined once (`taught`);
  5. *ask* — one to three things only a person knows; a skipped question
     becomes an open one;
  6. *write* — the notebook entry and the state;
  7. *gate* — two lines of recap, the next step's cost, then continue, go
     deeper, skip or stop.
- **Stopping is a success.** Every step leaves something to hold: the
  shortlist after 3, the reading order after 4, the glossary after 5, the
  model after 6.
- **One `serve` per session**, restarted with the step's bindings. With a
  browser tool attached the agent reads a screenshot before describing
  the city; without one it describes from the reports and gives the URL.
- **Predict, then reveal** is offered, off by default: the person names
  the module they expect to be worst before step 3 shows it. The gap is a
  finding.

### 24.4 `codegraph query` — SQL without `sqlite3`

```bash
codegraph query app.jsonl "SELECT kind, count(*) AS n FROM node GROUP BY kind"
codegraph query app.jsonl --file reach.sql --param id='java:com.acme.order/Order.discount(int)' --json
codegraph query --views            # the DDL of `node` and `dep`, for another client
```

- **Input:** a `model.jsonl`, through the cache as `analyze` reads it, or
  a `.db`. The model's store and nothing else.
- **The helper views have ONE definition**, in `@codegraph/analyzer`
  (`store/helper-views.ts` — `src/views.ts` already names the pipeline's
  predicate views), created in the connection's temp schema. The three
  copies in the docs are pinned equal to it. The engine is beside it
  (`store/query.ts`: `statementShape`, `queryStore`); the command only
  resolves flags, finds the store and moves bytes.
- **Read-only twice.** The handle is `readOnly`, and the text must be one
  statement beginning `SELECT`, `WITH`, `VALUES` or `EXPLAIN` — because
  the handle alone lets `VACUUM INTO` write a file. Anything else is a
  usage error (exit 2).
- **Parameters are bound, never spliced**: `--param name=value` → `:name`.
  An id holds parentheses and commas, and in Ruby, quotes.
- **Output:** an aligned table on stdout, cut at `--limit` (default 50)
  with the total on stderr; `--json` is `codegraph.queryResult/1`
  (`columns`, `rows`, `total`, `truncated`); `--csv`. The cut is the same
  in the three forms and `--all` lifts it; a JSON row is an array, because
  two columns may share a name.
- **Exit codes** as everywhere: 0; 2 for usage, and a statement SQLite
  refuses IS usage — a mistake in what was typed, carried with SQLite's
  message; 3 when the file is not a model. Never 1: that code says
  "a bug in codegraph", which a typo in a `SELECT` is not. *(The plan
  first said 1; M23a corrected it against `exit.ts`.)*

**Query files.** `plugin/queries/<name>.sql`: one statement, a header
comment naming the page it belongs to, its parameters declared. **Decision:
the pages and the query files are held equal by a test, not by an
include** — every `sql` block of the six pages and of the how-to equals a
query file, or sits in a short list of page-only blocks with its reason. A
shortcode that reads the file at build time is the better form; whether
Hugo mounts `../plugin/queries` is measured in M23a, and if it does the
copies disappear. *Measured (M23a, Hugo 0.170.1): it mounts, and
`resources.Get` renders the file in the HTML page — but the site's
Markdown twin of each page (`index.md`, Hextra's `.RawContent` templates)
prints the shortcode unexpanded, and that twin is what a model reads. The
copies stay, held by the test.*

### 24.5 What else the CLI gains

| Change | Why the walk needs it | When |
|---|---|---|
| `history --report hotspots --model M` — the joined report the page calls planned: revisions × lines, × cyclomatic, × cycle membership, × fix density (the page's four families: classic, branchy, tangled, fragile), on the path join `hidden` and `deadweight` already use (`crossGraph`) | the one block of the method with no command | M23b |
| `analyze --report entrypoints` and a reach report from an id | step 4 is "partly: Spring only, chains by query" | deferred; the query files are what they will be tested against |
| `codegraph doctor [DIR] --json` | preflight as one tested command | deferred |
| deep links in `serve` (a tab, an entity) | the agent could point at one building | deferred |

### 24.6 Specy: three changes there, one contract here

The contract between the two repositories is the workspace:
`.codegraph/discovery.json` and the artifacts beside it. Specy reads them
and never writes there; its own outputs stay in `specy/`.

| Step | Specy skill | The change, in `specy/skills`, with its own commits and release |
|---|---|---|
| 2 | `architecture-extract-from-code` → `.arch` | a `heuristics/codegraph.md`: the module graph as container and component candidates, external modules as external systems, entry and exit points as ports. Today it reads source only |
| 4 | `sysreq-extract-from-code` → `.sysreq` | a `heuristics/codegraph.md`: the stimulus inventory as the list of triggers, one EARS requirement per chain, limited to the chains the person chose |
| 6 | `domain-extract-from-code` → `.domain` | lookup order `.codegraph/`, then `specy/codegraph/`, then any `*.insights.jsonl`; when `discovery.json` is there, it takes the excluded paths, the names a person gave, and the hotspot ranks that order its refactoring report |

- **One consent wording.** The block of Specy's `heuristics/codegraph.md`
  §1.4 (show the cost, then ask; one yes per scope) is the text step 5
  uses. Specy, finding the run in `spend`, does not ask a second time.
- **Exits offered at the end, unchanged:** `domain-dialogue`,
  `domain-refactor`, `model-formats`, the Specy app's navigators,
  `specy validate`.
- **Not involved:** synthy (not a discovery concern), `exspec` (empty),
  arc-kit (third-party).
- `domain.md`'s "planned change" sentence is corrected in M23d.

### 24.7 The report

`.codegraph/REPORT.md` is rewritten at every stop, from the state file:
the findings of each step done, with kind and anchor; the hotspot
shortlist; **the questions for the team** — what no file can answer, a
deliverable of its own; what was spent; and what was NOT looked at, with
the reason (a skipped step, an excluded path, a feature the language's
extractor does not give). Its order follows the purpose given at intake:
due diligence leads with risk and ownership, migration with stimuli and
domain. It holds shares and counts, never an author's name.

### 24.8 Validation

What a test can hold, it holds — in `pnpm -r test`, with no model call:

| Property | Test |
|---|---|
| every command a skill writes exists | each fenced line beginning `codegraph` in `plugin/` is parsed with that command's `CommandSpec` (the specs are data, `args.ts`): an unknown flag or a value outside `choices` fails. Placeholders are a closed list (`$MODEL`, `$SRC`, `$WS`) |
| every query runs | each `queries/*.sql` on the five fixture stores, through the code `query` runs; the Java rows pinned to the tables the pages print |
| pages and skills run the same SQL | the equality of §24.4, over the 18 blocks |
| the views have one definition | the three docs copies equal `store/helper-views.ts`; `node.id` equals `renderId` on every fixture id, five languages |
| `query` writes nothing | every statement of §24.9's first row: exit 2, no file created, the store's sha256 unchanged |
| the state is what the pages ask for | three example files (cold, after the tour, complete) against the schema; the `findings` keys of each step equal that page's "Write down" items, a list edited with the page |
| budgets | 300 lines and 2 500 words per `SKILL.md`; 1 536 characters per `description` |
| the plugin is well-formed | `plugin.json`'s version equals the root `package.json`'s; `claude plugin validate plugin` where the CLI is present |

What a test cannot hold is the conversation. It is held twice, before a
release and not in CI, because each run is a paid session:

- **A scripted tour on PetClinic**, headless. The assertions are on FILES:
  `discovery.json` valid and steps 1–3 `done`; every finding with a kind
  and an anchor that resolves (the file exists at the recorded commit,
  the line is in range); `spend` empty; nothing listening outside
  loopback; `git status --porcelain` of the analyzed repository
  unchanged.
- **`claude plugin eval` cases**, scored against the no-plugin arm:
  triggering (the guide on "help me understand this codebase", not on
  "fix this bug"); the gate (no `explain` without a dry run and a yes);
  honesty (on the Ruby fixture, step 2 says wiring is not available).

Live gate of M23d, on a copy of the paid PetClinic store placed in a
workspace: step 5 plans exactly what `explain --dry-run` plans there (the
M21 gate's bytes, §22.6 — not "0 calls") and spends nothing; step 6's
`.domain` passes `specy validate`.

### 24.9 Hazards, each with the test that pins it

| Hazard | Pinned by |
|---|---|
| a read-only handle still writes files (`VACUUM INTO`, measured) | the one-statement rule; a test over `VACUUM INTO`, `ATTACH`, `PRAGMA writable_schema=ON`, `CREATE TEMP TABLE`, two statements, a comment hiding a `DELETE` |
| `serve` binds every interface by default | every `serve` line in the plugin carries `--host 127.0.0.1`: an assertion of the command test |
| the analyzed repository shows a new directory, or a tracked file edited | `.git/info/exclude`; the tour asserts `git status` unchanged |
| the model is behind `HEAD` and an anchor points at a moved line | each finding records its commit; the resume beat compares before any anchor is shown |
| a secret printed while listing providers | preflight tests presence only; an eval case sets a fake key and greps the transcript for it |
| the session compacts in the middle of a step | the step re-reads the state before each beat that writes; the budget test |
| an author's name in a deliverable | the report is built from fields that hold shares and counts; the tour greps it for every author of `history.jsonl` |
| a flag is renamed and a skill keeps the old one | the command test |
| zero rows read as "there are none" | the step names the stack tables it applied; the honesty eval |
| a price remembered from another session | the consent block is built from this run's `--estimate`; the state has no price field |

### 24.10 Milestone split

- **M23a — the skeleton, the guide, step 1, `query`.** *First step, before
  any of it:* in a live session, the guide calling a step skill by name
  and by file path (§24.1), and Hugo mounting `../plugin/queries`
  (§24.4). Then `store/views.ts` with the docs copies pinned;
  `codegraph query` with its args, dispatch, help, exit-code and
  stream-purity cases and the SEA smoke; `plugin/` with `discover`
  (preflight, intake, state, resume) and `discover-1-structure`; step 1's
  query files; the tests of §24.8 that need no session.
- **M23b — steps 2 and 3, the tour.** The joined hotspot report,
  test-first on the history fixture; `discover-2-boundaries`,
  `discover-3-activity`, the `query` skill; `--tour` and its brief; the
  city bindings per step; `REPORT.md`; `activity.md` loses its
  spreadsheet.
- **M23c — step 4.** The three layers as query files, the slice on facts
  and with candidates, overlap, residue; `stacks/spring.md` and one stack
  per other extractor language, each checked on the corpus that
  extractor's audit used — a stack with no checked table is listed as
  not covered.
- **M23d — steps 5 and 6, Specy.** The consent block, the scope proposal,
  the background run and its readings; `domain-facts`, the three
  readings, the hand-over; the three Specy changes, in its repository;
  `domain.md` corrected; the live gate.
- **M23e — distribution.** The marketplace file; a website how-to and a
  line on each discover page; `query-model-db.md` leading with
  `codegraph query`; the eval suite and its scores written here; README,
  CLAUDE.md, `docs/cli.md`; the release step (version, `claude plugin
  tag`).

**As built — M23a (2026-11-22).** On the worktree `discover-skills`
(branch `feat/m23-discover-skills`, base `main` cf7432a). As designed, with
what the measurements and the first live run changed:

- **The two measurements asked first.** *Skill by name or by path:* with
  the plugin loaded headless (`claude -p --plugin-dir plugin`, CLI
  2.1.330) the model invokes `codegraph:discover-1-structure` through the
  Skill tool and receives its text; left to itself, in two full runs of
  the guide, it read the step's `SKILL.md` by path instead. Both work; the
  guide keeps both sentences. *The Hugo mount:* §24.4.
- **Running the pages' SQL on five fixtures found six defects in the
  pages, all fixed in the same change.** (1) the documented `node` view
  rendered `ts:m/#23:2` for an anonymous TypeScript function, where
  `renderId` gives `ts:m#23:2` — three copies wrong at once, the one
  existing test ran Java only; (2) step 1's size and largest-type queries
  listed Java's kinds and returned nothing on Elixir: a type is now asked
  for by its trait, `TType`; (3) the size-per-module sum counted a nested
  type's lines twice (Java fixture: 246 for 221); (4) the branching query
  attributed a lambda to its method and a free function to whatever held
  it: each operation now counts in the nearest type around it, the sum the
  city draws, checked against the analyzer's own fold; (5) the kinds table
  printed 7 of the fixture's 12 rows; (6) the cycle and coupling outputs
  printed were not those of the commands above them. "The model header
  carries the commit" is true only with `--repo-commit`: the walk records
  `git rev-parse HEAD` in the state.
- **`node:sqlite`, three facts the engine rests on.** `prepare` compiles
  the first statement and silently drops what follows the `;` — a tail is
  refused, not ignored; a parameter nobody gave binds NULL — refused by
  name before the statement runs; a JS number binds as REAL — a whole
  number is bound as an integer.
- **The first live run failed usefully.** This machine's `~/.zshenv` sets
  `CODEGRAPH_HOME` to the main checkout, whose build has no `query`; the
  agent then answered the step's queries with a Python script of its own.
  Hence a seventh principle, in the guide and in `rhythm.md` — *a command
  that fails is reported, not replaced* — and a capability check at
  preflight (`codegraph query --views`): the version number does not tell
  two builds of 0.3.0 apart, the command does. The tool lookup became one
  line every command begins with
  (`[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"`),
  and the exclude file is asked for with `--path-format=absolute`.
- **The second live run** (PetClinic, a cold clone, Sonnet, headless, the
  intake answers given in the prompt): 25 turns, 102 s, $0.53. The state
  validates against the schema; six findings, each with a kind and an
  anchor that resolves to a saved file; `git status --porcelain` of the
  repository empty; nothing written outside `.codegraph/`; `spend` empty.
  PetClinic resolves 78.1 % of its type references without a classpath,
  under the page's "90 % and above is normal": the walk says so.
- **Smaller departures.** Placeholders are five (`$REPO`, `$WS`, `$ROOT`,
  `$SRC`, `$MODEL`), each defined in the skill that uses it. Step 1 runs
  no `import`: `query` builds the store. The workspace gains `reports/`
  and `<root>.extract.log`. A step's `findings` hold one finding per model
  under each key, and each key names the page's "Write down" item it
  answers (`x-page-item`), which is what the test compares. `capabilities.md`
  is rendered by a test helper (`CODEGRAPH_UPDATE_SNAPSHOTS=1` rewrites
  it), since the plugin has no build step. The pages hold 20 `sql` blocks,
  the 18 measured and the two views; `structure.md` and the how-to are
  covered, the other five pages listed with their milestone.
- **Gate.** 1 278 CLI tests and 669 analyzer tests green (142 of them
  the plugin's), typecheck and lint clean, `claude plugin validate plugin
  --strict` passes, the single-executable image passes its gates with
  `query` among them, the website builds. Not committed; README and
  CLAUDE.md wait for M23e as planned.

**As built — M23b (2026-11-22).** On the same worktree, on top of M23a,
uncommitted. As designed, with what building it and three live tours
changed:

- **The joined report**, `history --report hotspots --model FILE`, test-first
  on a hand-counted model and history. Three choices the plan left open.
  *Lines are counted once per file:* the outermost measured entities written
  in it — the nested-type double count of M23a again, this time in the SQL
  `activity.md` handed to a spreadsheet. *A cycle is a file's:* the size of
  its strongly connected component in the DECLARED file graph, the fold
  `hidden` and `deadweight` already use, not step 1's type-level components
  — the file is the unit of the report, and declared-only keeps "tangled" a
  fact. *A score of 0 is not ranked:* thirty revisions and no measured
  operation is "not measured", `-` in the table and `null` in the JSON, never
  the simplest of the busy files. `fragile` is revisions × fix density, which
  is the fixes, and is stated as that. `--rank` chooses the order (default
  `branchy`, the page's "sort by revisions × cyclomatic"). The join happens
  only when `--model` NAMES a model: a `model.jsonl` that sits in the
  directory must not change what the plain report prints.
- **Two additions the step needed and §24.5 did not list.** (1) `history
  --report summary --model` gains `cross-module`. The page's recipe — fold
  the coupling pairs to their first path segment — answers 0 % on every
  Maven layout, where that segment is `src`; and its thresholds are in
  commits, not pairs. It is now counted on commits, over the top-level
  directories below the directory the model's files share (paths, never
  ids). PetClinic: 40 of 165 commits, 24.2 %. (2) Each joined row says who
  holds the file WITHOUT A NAME: the main author's share, that author's row
  in `--report authors`, the day they were last seen. §24.2 already asked
  for "one owner, 78 %, not who" and no report gave a per-file share; the
  row number came from the second tour, whose agent caught itself saying
  three hotspots had one owner when the report could not show it. On
  PetClinic the five hotspots turn out to have two main authors.
- **A defect found on the way.** A `--model` with one invalid line loaded as
  an EMPTY union: `hidden` then printed "none — every co-changed pair is
  explained by a declared dependency path", exit 0. It is now a finding,
  exit 3, for every report that reads a model.
- **Step 2's four queries, on five languages.** Three more page defects,
  fixed with the query files: the stub table printed was not the query's
  first rows; names nothing declares, which the extractor files in the
  code's OWN package, were listed as the outside world (an `own` column now
  sets them apart — five on PetClinic, two rows on the fixture); a C#
  attribute is named by its class, `HttpGetAttribute`. The Spring-routes
  block became one statement with its list bound (`annotated-with.sql`,
  `:names` through `json_each`), checked on a hand-built Spring model since
  no fixture has Spring. Elixir and Ruby return no annotation, by their
  profile's own statement, which is what the test holds; `capabilities.md`
  gains "External code is filed under", read from the five fixtures.
  `activity.md` has no SQL left: 19 blocks on the pages, 13 of them query
  files or listed as a page's own.
- **The skills.** `discover-2-boundaries` (246 lines, 1 818 words),
  `discover-3-activity` (239, 1 862), `query` (135, 942). The schema names
  the findings of steps 2 and 3 (six and four keys), each tied to the item
  of its page it answers. The tour is not a skill: it is a section of
  `rhythm.md` saying how each beat is played when nothing is asked, and its
  brief is the first section of `REPORT.md` (`references/report.md`: six
  sections, ordered by the purpose given at intake, no name, no price, no
  advice). One city per step, held by a test: complexity for step 1, the
  Graph tab (by Spring role when there is Spring) for step 2, recent churn
  for step 3.
- **Three live tours** (Sonnet, headless, the prompt being the command and
  "nobody can answer"), each checked on FILES by one script: the state
  valid; steps 1–3 `done` at `HEAD`; every finding with an anchor that
  resolves; the questions collected and open; `spend` empty; no page
  served; no author of `history.jsonl` named in `REPORT.md`, `NOTEBOOK.md`
  or `discovery.json`; `git status --porcelain` empty.
  - *PetClinic*, a cold clone: 37 turns, 346 s, $0.98, 16 findings, 10
    questions. The agent invoked the three step skills BY NAME, where
    M23a's runs read them by path. It chose a two-year window by the page's
    rule, marked it a guess, and kept the whole-history summary beside it.
    It also assembled the state with `jq` and `mv`, and two writes failed
    before it recovered: `state.md` now says to write the state with the
    file tool, whole.
  - *rake* (Ruby, 3 228 commits): 37 turns, 253 s, $1.12, 17 findings. The
    report says what the tour could not do there — no annotation census,
    external code filed under `<ruby>` and `<gems>` so the stack is the
    gemspec's to give (it read it), no framework profile, a module is one
    file, untyped receivers dropped. The state was written with the file
    tool. Every saved report was read through a `python3` snippet: nothing
    was computed that way, but `rhythm.md` now says a saved result is read
    with the file tool or the command's own table.
  - *PetClinic again*, a fresh clone, with the text as it now stands: 40
    turns, 227 s, $1.04, every assertion holds. The state was written with
    the file tool; one shell call went through a script where the two
    earlier runs made 19 and 11; the shortlist says "five different main
    authors hold the six files (`Owner` and `Pet` share row 9)" and that
    the names are in `reports/authors.json` only.
  - A directory `.remember/` appears in each clone: another plugin's
    session hook on this machine, named by no tool call of the agent, and
    ignored by its own `.gitignore`.
  - The three runs cost $3.14 of Claude Code usage.
- **Gate.** 1 420 CLI tests, 691 analyzer and 56 scm tests green, typecheck
  and lint clean, `claude plugin validate plugin --strict` passes, the
  single-executable image passes its gates, the website builds. Not
  committed.

**As built — M23c (2026-11-23).** On the same worktree, on top of M23a and
M23b, uncommitted. As designed, with what measuring the page's four queries
and running the step on six codebases changed:

- **One CLI addition the plan did not list: `query --param-file NAME=FILE`.**
  The walk forbids a script between two commands, and step 4 is a chain of
  them: the inventory feeds the chains, the chains feed the ranking, the
  groups and the residue, step 3's reports feed two of those. Without it an
  agent retypes thirty ids on a command line. The flag binds `:NAME` to a
  file's whole text, always as text; `json_each(:NAME, '$.rows')` reads what
  a `--json` run saved. A result is then computed from a file a person can
  open. Eleven tests first; one name is bound once, by either flag.
- **The page's four queries, measured.** (1) *"Run it twice"* was false as
  written: the candidate targets of `--report wiring` are in-memory only
  (`framework/profile.ts` says so), never in the store, and no extractor of
  Java, C# or TypeScript writes an invocation that is not `declared` — the
  second run returned the first one's rows on three languages of five. (2)
  The walk ignored the `candidates` list of a `dynamic-candidate` edge, which
  is where an Elixir protocol call keeps its implementations: 1 row on facts,
  10 with them. (3) It did not enter a lambda, a local function or an arrow
  function, whose calls are edges FROM that entity. (4) The zero-callers
  query named Java's kinds — the M23a defect again — and listed as "nothing
  calls it" every implementation reached through its interface, every
  constructor and every `toString`.
- **The second run is now three stated inferences**: edges of another
  provenance; the candidates an edge lists; and dispatch — a call to an
  operation of a type may run the operation of the same name and arity in
  any type of the code below it. That last one is class-hierarchy analysis,
  an upper bound, and it subsumes what the wiring report would add. The C#
  fixture's `IsFree(IPriceable)` reaches 3 entities on facts and 9 with the
  candidates; the page prints those two numbers and a test holds them.
- **The three layers are one statement** (`entry-points.sql`), fed by a
  **stack table**: a JSON file of names, each with a kind of stimulus —
  `annotations`, `supertypes` (a type the framework calls: the entry points
  are the UNCALLED operations of every type below it, the callbacks and not
  the helpers), `types` (a GLOB on a type's name), `operations`, `entries`
  (an id a person named; an id that is not in the model comes back with a
  NULL kind instead of vanishing) and `conventional`, the names the language
  itself calls, copied from core's profile lexicon and held equal to it. A
  row no table names is `no caller` with a NULL stimulus: unclassified, as
  §24.2 asked. The kinds are eight, not seven: `inbound request` is what
  `@RequestMapping`, `[Route]` and a Rails action are — a request whose name
  does not say whether it reads or changes.
- **The residue is measured wider than a chain.** "Everything no chain
  reaches" listed every type that is only mentioned: a parameter's type, an
  exception thrown, a class extended. It is now what no type reachable from
  a classified entry point mentions by ANY edge, declared types and nested
  types included. The first version of that statement tied every type to
  its package and was always empty: found by a count from the model, which
  is why each step-4 statement has an in-memory oracle on the five fixtures
  (breadth-first walk, union-find, closure), and why six deliberate breaks
  of a rule were run against them — each fails one to four tests.
- **Nine query files**, ten with step 2's: `supertypes`, `entry-points`,
  `entry-point-kinds`, `reach`, `chains`, `chain-ranking`, `chain-groups`,
  `shared-types`, `residue`. The page shows the COMMAND and its rows on the
  Java fixture where it explains a query, and the nine statements at its
  end; the test maps a table to its file through the command. Groups are
  single-linkage on shared types over all types (`:min` percent, start at
  50), the types more than half the chains reach left out.
- **Three things SQLite taught, each a 20- to 150-fold cost.** `node.id` is
  computed per row, so `JOIN node ON n.id = list.id` is one pass over the
  model per list row: 40 s for Mastodon's residue, 0.26 s once turned into
  `WHERE n.id IN (…)`. `json_each(:param)` inside a correlated subquery
  parses the JSON once per outer row: 22 s for the inventory, 0.33 s with
  the lists read once (`AS MATERIALIZED`). A correlated `NOT EXISTS` over the
  type closure rebuilt its lookup per row: replaced by a set. The `query`
  skill now says the first two. In an `ORDER BY` expression a name is the
  input column, not the alias of the same name: `unclassified` sorted first
  until a test said last.
- **Five stack tables, each run on a real codebase and its rows read**
  (`references/stacks/*.json`, `references/stacks.md`; a test holds the
  kinds to the page's eight, the conventional names to core, and the Spring
  table to every entry-point annotation of the framework profile):

  | Table | Corpus | Entities | Found | Unclassified |
  |---|---|---|---|---|
  | `spring` | spring-petclinic `500158f` | 451 | 32 by annotation, 6 by supertype, `main` | 16 |
  | `aspnet` | dotnet/eShop `ab10e4c` | 7 386 | 14 by attribute, 44 by supertype | 392 |
  | `aspnet` | OrchardCore `045b6d1` | 107 668 | 399 by attribute, 587 by supertype | 2 252 |
  | `nestjs` | nestjs/nest `94df49d`, its 39 samples | 4 427 | 130 by decorator, 33 by supertype | 35 |
  | `phoenix` | plausible/analytics `418da46` | 11 810 | 170 by type name, 253 by operation name, 11 by behaviour | 839 |
  | `rails` | mastodon `v4.3.0` | 12 806 | 1 543 by supertype | 1 277 |

  On OrchardCore: the inventory 0.75 s, the chains of 905 entry points 1.0 s
  on facts (23 682 rows) and 43 s with candidates, the residue 2.2 s, the
  groups 2.3 s. Not covered, and said so on the page and in the reference:
  Jakarta EE, Micronaut, Quarkus, Azure Functions, Express, Fastify, Next.js,
  Sinatra, Grape, Hanami.
- **PetClinic's inventory, as the definition of done asks.** 55 rows: the 32
  entry points of `--report wiring`, id for id and annotation for
  annotation (two of them are not operations: a class-level
  `@RequestMapping` and a `@ModelAttribute` parameter, listed as markers);
  6 the supertype layer adds, checked in the source — `PetValidator.validate`
  and `supports`, `PetTypeFormatter.print` and `parse`,
  `PetClinicRuntimeHints.registerHints`, `WebConfiguration.addInterceptors`;
  and 17 with no caller: `main`, and 16 unclassified, of which 15 have no
  call site in the main source (bean properties a template or a binder
  reaches, two methods only the tests call) and 1 is wrong.
- **What the corpora showed the tables cannot find**, each stated where the
  agent reads it: an ASP.NET minimal API (`MapGet("/items", GetAllItems)` is
  not an edge at all in the C# model — the handler is unclassified, or
  absent when another handler calls it); a Phoenix route (a macro) and `use
  GenServer` (not a supertype without a trace: the callbacks are found by
  name); which Rails controller method is an action (no visibility in the
  model); a NestJS decorator whose package resolves to source outside the
  roots (filed as its file, not by name — seen on the nest monorepo itself).
- **A defect of the Java extractor, found and not fixed here.** Inside a
  lambda whose functional interface is not on the classpath, a call to a
  method of the enclosing class is not drawn: `cm -> cm.createCache("vets",
  cacheConfiguration())` in PetClinic, and `cm -> inLambdaBody()` in a
  three-method sample. The callee then shows as `no caller`, and a chain
  stops at the lambda. It belongs to the extractor's own milestone; the
  Spring notes name the PetClinic row.
- **The skill.** `discover-4-stimuli`, 269 lines and 2 051 words; the
  schema names its five findings (`inventory`, `unclassified`, `chains`,
  `useCases`, `residue`), tied to the page's three items. A use case's name
  is proposed by the agent and marked as proposed until a person gives one.
- **Two live runs of the step** (Sonnet, headless, on the PetClinic
  workspace the M23b tour left, steps 1 to 3 done; the prompt: resume, run
  the next step only, ask nothing, serve no page), each checked on FILES by
  one script: the state valid and four steps `done` at `HEAD`; the five
  findings of step 4, each with an anchor that resolves; the ten saved
  results and the table as applied; the inventory holding the 32 entry
  points of `--report wiring`; nothing extracted or mined again; `spend`
  empty; no author named; `git status --porcelain` empty.
  - *First run:* 41 turns, 238 s, $1.06, no failed tool call, no script. It
    resumed from the state alone and read the step's skill by path. It found
    the lambda row by itself, read the source and anchored the finding at
    `CacheConfiguration.java:37`; it named three use cases and marked each
    as proposed; it wrote "this table found no external event, internal
    event or temporal entry point. That says nothing about a scheduler
    configured outside the code". One assertion failed: `REPORT.md` still
    said three steps done — "the guide rewrites it at a stop, and this run
    only goes up to the gate". A gate where the session ends IS a stop: a
    step now rewrites the report when it writes the state (`rhythm.md`,
    beat 6; a tour, once, after step 3).
  - *Second run,* a fresh copy, with that change: 37 turns, 220 s, $1.02,
    every assertion holds; the report lists step 4 as done and cites its
    saved results. It checked twice that the state parses with `python3 -m
    json.tool`: `state.md` now says to read it back with the same tool. It
    did not open `stacks.md`, which the first run did.
  - The first run's "chain to read first" was a `@ModelAttribute` callback:
    it ties on hotspots with three POST handlers and reaches one more type.
    The page and the skill now put a command, a query, a request or an
    event before a `lifecycle` entry or a `framework callback` of the same
    rank. That sentence was written after the second run.
  - The two runs cost $2.08 of Claude Code usage.
- **Gate.** 1 602 CLI tests (431 of them the plugin's), 691 analyzer, 544
  core and 56 scm tests green, typecheck and lint clean, `claude plugin
  validate plugin --strict` passes, the single-executable image passes its
  gates and runs a step-4 query with `--param-file`, the website builds. Not
  committed. Not live-tested: the interactive path of step 4 (its three
  questions answered, a table extended by what a person says), `--step 4`
  entered directly, and any stack but Spring in a session — the four other
  tables were run through the same statements by hand.

**As built — M23d (2026-11-23).** On the same worktree, on top of M23a to
M23c, uncommitted; the Specy side on a new branch of its own repository. As
designed, with what measuring the two pages and three live runs changed:

- **The two pages, run before they were followed.** `meaning.md` read the
  records with `jq`, which the walk forbids, named OpenRouter and Cloudflare
  only, and printed a plan without its `models:` line; it now reads them with
  `codegraph insights`, names Claude Code, and prints the command's output.
  `domain.md` printed for `--framework spring` the bytes of the run without
  it (100 827 for 100 949), its purity query left out the standard library by
  `NOT LIKE 'java.%'` on every language — the C# fixture's `Acme.Order` read
  53.1 % pure with every `System` type counted as a library, 95.1 % with its
  own — and its order tied on every TypeScript, Elixir and Ruby module, so a
  ranking moved between two runs. Its "planned change" sentence is corrected
  (below). `stimuli.md` printed `25` where the command prints `25.0`: the
  test now compares a page's table with the command's own cells
  (`tableCells`, lifted out of `formatTable` in `query.ts`, no output
  changed), where it compared `String(value)`.
- **What a record is a function of, measured on the paid store.** On a copy,
  this branch plans the M21 gate's bytes (`240f75ce…3b8e`, 53 llm, 33
  template, 53 reuse). Three things move them, each now a reading rule of
  the page and of the skill: (1) *the metrics pass* — the walk's own model of
  the same commit, extracted at step 1 and measured, plans 90 llm and 16
  reuse against the same store; with the pass's 1 466 keys stripped it plans
  the gate's bytes exactly, so the cause is the fourteen measures each prompt
  shows, not the extractor's version; (2) *the provider* — the same command
  resolving to Claude Code (no key set) plans other bytes (`a502ba1a…`),
  because the estimate counts Claude Code's scaffolding in every prompt; the
  skill names `--provider` on every plan; (3) *the models and depth* — with
  Claude Code's default model instead of the store's, the plan is 106 calls
  and reuses nothing; the store's summary (`codegraph insights`) names its
  models and depth, and the skill plans with those. The 53 calls that remain are 2a79c8f's words (§22.6): the
  page now says a codegraph that asks other words plans those units again.
- **Three query files**, with the M23c discipline: an in-memory oracle on the
  five fixtures for each, then deliberate breaks — dropping the standard
  library, counting a stub of the code's own package as a library, dropping
  the supertypes from "reaches a library", any provenance, `entry` at depth
  1, any field, reads for writes — each failing one to six oracle tests; one
  break (an enum that is a stub) fails only the page-equality test, no
  fixture having one. `purity.sql` (domain.md) binds the standard library
  as `:stdlib`, a list of GLOB patterns from a five-row table on
  `meaning.md`, held equal to the test's and each pattern to a module its
  fixture references. `chain-position.sql` (meaning.md) counts, per type of
  step 4's chains, where chains start (`entry`), pass (`inside`), and leave
  the code (`edge`: the type calls or reads a library outside the standard
  library, or one is above it — without the supertypes a repository
  interface read as `inside`). `invariant-evidence.sql` (domain.md): per type,
  writes to its own fields, throw sites, both in one operation (`guarded`),
  and the enum-typed fields it writes. On PetClinic `guarded` is 0 for every
  type: its guards are `Assert.notNull` calls, not throw sites, which the
  page now says. The pages hold 26 `sql` blocks: the 21 query files and the
  how-to's five own; no discovery page is left uncovered.
- **The skills.** `discover-5-meaning` (266 lines, 2 036 words) and
  `discover-6-domain` (236, 1 748); the schema closes both steps' findings
  (seven and five keys, each tied to an item of its page's list, which gains
  "What was explained" on `meaning.md`) and gives a finding an `origin`
  (`explain` or `session`) for an `explanation`; a fourth example state,
  `complete.discovery.json`. The consent block is `references/consent.md`,
  the Specy skill's §1.4 block and question word for word. The test that
  read "no line carries `--yes`" is restated as what it guarded: one line in
  the plugin carries `--yes`, an `explain` run in step 5's Ask beat, with a
  stated `--scope`, `--provider` and `--max-calls`, after an `explain` that
  only plans and two that only estimate.
- **Specy** (`~/specy/skills`, worktree `.claude/worktrees/codegraph-discovery`,
  branch `feat/codegraph-discovery-workspace` from fa6f029, uncommitted; its
  main working tree holds someone's edits since 2026-11-17 and was not
  touched): `heuristics/codegraph.md` for `architecture-extract-from-code`
  and for `sysreq-extract-from-code`, `heuristics/codegraph-workspace.md` for
  `domain-extract-from-code` (lookup `.codegraph/`, then `specy/codegraph/`,
  then any side-car; excluded paths, names a person gave, hotspot ranks
  ordering the refactoring report, no second consent when `spend` or the
  `run` finding holds the answer), each wired into its `main.md` and
  `build.sh`, `dist/` rebuilt for the three skills against a clean export of
  `metamodels` HEAD (a build from its working tree would carry someone's
  uncommitted grammar). *Measured:* the plan's "§1.4" and "looks for
  `specy/codegraph/*.insights.jsonl`, then any `*.insights.jsonl`" describe
  that uncommitted working tree; the committed skill reads
  `specy/codegraph/model.insights.jsonl` alone, on JVM code only. The branch
  is written against the commit, so it will conflict with those edits in
  `codegraph.md` §1 and `main.md` step 4 when they land.
- **Three live runs** (Sonnet, headless, no provider key in the environment,
  each checked on FILES by one script):
  - *Step 5 on a copy of the paid store placed in a workspace* (the M23c
    workspace, steps 1–4 done, its model replaced by the paid one so that the
    store is the paid store whole; intake allowing OpenRouter up to $1; the
    consent answered no): 33 turns, 237 s, $0.93. The saved plan is the M21
    gate's bytes; the store and its side-car keep their sha256; the consent
    block was shown with "Estimated cost: unknown" and a nine-type scope as
    the cheaper line (33 calls); the readings came from the paid records,
    free; `spend` empty; every finding anchored. It found by itself that
    `Owner` is an entity at the edge of its seven chains (Spring's `Assert`
    and `ToStringCreator`) and `BaseEntity` "plumbing" inside all eleven. It
    rewrote `REPORT.md` through a `python3` script: `rhythm.md` now says the
    three files are written with the file tool; and it proposed the whole
    root, as the skill then said, where the page says not on a first visit:
    the skill now proposes the scope.
  - *Step 6 on the result, with the Specy branch loaded* (`--plugin-dir` of
    its `dist/`, which replaces the installed `specy@skills-dir` — measured
    with a session that cannot start, $0): 73 turns, 638 s, $2.80. Verdicts:
    `system` and the root package infrastructure, `owner`, `vet` and `model`
    undecided, the measures disagreeing. The Specy skill read
    `codegraph-workspace.md`, extracted nothing, ran no `explain`, wrote
    `specy/petclinic.domain` (two contexts, one aggregate, five entities,
    five commands, five queries, six preconditions, no event), a `.sysreq`
    and a refactoring report of 11 smells ordered by hotspot rank (first:
    `OwnerController`, a transaction script, fragile #1); `specy validate`
    passes on both, in the session and again in the checker; `git status`
    shows `specy/` and nothing else. One `python3` call read the dossier's
    shape.
  - *Step 5 with a no at intake and no store* (the M23c workspace as it
    was, its model measured by the pass): 55 turns, 237 s, $1.03. It planned
    and estimated through Claude Code as the provider that "would have been"
    (106 calls for the root, 50 for nine types), created no store, read five
    types itself and wrote them as explanations with `origin: "session"`,
    each anchored at a file and line, and the glossary from `codegraph
    vocabulary` as `derived`. Two of the checker's assertions failed, and
    both showed the text was silent: it wrote the step `partial` ("so a
    resume offers step 5 again") and no `said` finding, a no nobody gave.
    The skill now says the step is `done` after a no, a later yes being a new
    question, and `consent.md` that `said` is for an answer a person gave in
    the step. It also found that a scope of types gives no module record, so
    no purpose and no glossary: the page and the skill now propose the module
    that holds the chain and the shortlist (`owner`: 55 calls cold), the
    types alone as the cheaper option. It read the state through `python3`
    four times: `state.md` now says to read it with the file tool too.
  - Before the second run, a session with an unknown model (it stops before
    any call, $0) showed what a plugin directory does to an installed plugin
    of the same name: `--plugin-dir` of the Specy branch's `dist/` replaces
    `specy@skills-dir`, and `--safe-mode` drops every plugin's skills,
    `--plugin-dir` ones included.
  - The three runs cost $4.75 of Claude Code usage ($0.93, $2.80, $1.03).
- **Gate.** 1 697 CLI tests (526 of them in the six plugin suites), 691 analyzer, 544
  core, 96 llm and 56 scm tests green (run one package at a time: under a
  parallel run the analyzer's `scale.test.ts` times out at 5 s, as M21
  recorded, and passes alone); typecheck and lint clean; `claude plugin
  validate plugin --strict` passes; the website builds (`hugo --themesDir`
  the main checkout's themes; `pnpm -r build` fails on the website package
  in a worktree, which has no theme); the single-executable image passes its
  gates; the paid store's three files keep their sha256. Not committed, in
  either repository. Not live-tested: a yes and the paid run behind it, its
  `spend` entry, the consent asked of a person; the three changes made after
  the third run; step 6 without the Specy plugin (the install line); the
  architecture and requirements heuristics of Specy, which no session read;
  `--step 5` or `--step 6` entered directly; any corpus but PetClinic; and
  an enum-typed field whose enum is a stub, which no fixture has.

Definition of done: from a cold checkout of PetClinic and two install
commands, `/codegraph:discover <path> --tour` writes a valid workspace
with `git status` unchanged; a second session resumes at step 4 from the
state alone; no model call precedes a yes; every finding carries a kind
and an anchor that resolves; on a Ruby corpus the walk says what it
cannot do; the tests of §24.8 are green in `pnpm -r test`.

### 24.11 Deferred, explicitly

- **`codegraph doctor`.** The preflight is some forty lines of shell an
  agent adapts per system. It becomes a command when the desktop app
  needs the same answer — the daemon's registry and extension census are
  half of it.
- **Entry points and reach as `analyze` reports**, with the annotation and
  interface lists as framework-profile data (M10d's door).
- **Deep links in `serve`**, so the agent can point at one building.
- **Walk definitions shipped with the plugin** once M21 is merged: a walk
  naming each stimulus, a walk listing outbound systems, on the same
  estimate-and-consent machinery.
- **The insights store attached in `query`**, to join a concept with a
  role in one statement: M16c's finding on read-only handles and `-wal`
  files applies first.
- **Other agent hosts.** The files follow the Agent Skills format; only
  the frontmatter extensions and `${CLAUDE_PLUGIN_ROOT}` are Claude
  Code's.
- **A hard dependency on the Specy plugin**: across two marketplaces it
  needs a setting on the user's side.
- A data-flow diagram (`boundaries.md` says codegraph draws none), a walk
  over several repositories as one system, the desktop app running the
  walk.

## 25. Milestones

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
| M16c | Insights store — the first reader | ✅ (2026-09-21) the store opened as a READER (`query_only` on an ordinary connection — a read-only file handle stranded `-wal`/`-shm` beside the model; no migration, an older or foreign store refused) with `query`/`stats`/`runs` projecting rows, never blocks, and `answerInsight` (explained / failed / unknown) as the one rule both readers share; `codegraph insights` — summary, tab-separated lists by level / concept / confidence, one explanation whole (`--id`, a failed id answered with why, exit 3), `--failures`, `--runs`, `--json` — opening the store and nothing else, not even `explain.ts` (the provider SDK): 0.14–0.18 s and ~81 MB on Broadleaf's 28 206 records, the store's hash unchanged; `codegraph serve`'s one lookup route `/insight.json?id=…` (`--insights FILE`, reader opened on first request, 404 and a silent page when there is nothing) and the Navigate panel's explanation block for types and modules — kind restated and pinned, `@codegraph/insights` not imported even for types, block rendered generically, asked once per id, and marked as an INFERENCE in the page's own colour and badge family; screenshots reviewed on Broadleaf. Operations wait on member ids the navigator artifact does not carry |
| M17a | Code metrics — the pass | ✅ (2026-09-29, worktree `code-metrics`) `codegraph-metrics` (§18): big-code-analysis 2.2.0 as a library, a pass over any extractor's model, 14 keys in two families (METAMODEL §3.8) joined on anchors — exact, leading, contained, then the fold; the extractor's keys untouched, a re-run the identity, numbers in `JSON.stringify`'s spelling (the core gate re-encodes all four enriched fixtures byte for byte). Joined: fixtures 70/87 Java, 101/117 C#, 89/105 TypeScript, 96/103 Elixir; BroadleafCommerce 26 209/28 596 (98.9 % of what has text of its own) in 0.82 s; codegraph itself 7 887/8 125 in 0.27 s; the witness `sloc = ploc` on every exact join but the explained ones; zero ambiguous. `build.sh`/`test.sh --metrics`, `bin/codegraph-metrics`, `docs/metrics.md`, a note per profile |
| M17b | Code metrics — change history | ✅ (2026-10-02) `codegraph-metrics --history` → `<model>.history-metrics.jsonl`, a SIDE-CAR (§11 principle 1 kept: no history in `model.jsonl`, no core change): per file from one walk over the full commit graph (merges excluded — first-parent hid 65 % of Broadleaf's commits), per entity from one blame per file, at the model's commit and clocked at its time; codec and `HISTORY_MEASURES` in `@codegraph/scm`; `history:`/`history-file:` metrics in `city`/`serve`. Hand-countable synthetic-repository test; Broadleaf (18 776 commits) 2 983 files + 26 494 entities in 35 s, re-run byte-identical |
| M17c | Code metrics — wired in and shipped | ◐ (2026-10-03) a pass is a registry entry (`role: "pass"`) across catalogue, discovery and daemon; the app's job measures every fresh model (and re-measures when the installed passes change), a missing or failing pass costing the job nothing; `snapshots` deliberately not (the temporal store keeps no per-revision measures); `codegraph-metrics` formula + `depends_on` in every extractor formula; CI `metrics` + `metrics-native` on four Unix runners, each `cmp`-proving the four snapshots; `--licenses` (MPL source pointers, 189 crates); Humanizer 4 817/5 736 and Phoenix 1 227/1 247 joined — and the witness caught the Elixir extractor's heredoc `sloc` (§18.5). Pending: the first tagged release to exercise CI and the tap |
| M18a | Ruby extractor — profile + skeleton | ✅ (2026-10-13, worktree `ruby-extractor`) `rb` profile in core (the eleventh: the module is the file, `class` and `module` are types below it, mixins are `traitUsage`, no interface — §19.2); `extractors/ruby/` in Rust on Prism 1.9.0 (`ruby-prism`, pinned), no Ruby to build or run; the core table distilled from RBS 4.2.0 `core/` with RBS's own parser (915 constants: 304 classes, 26 modules, 585 values); walking skeleton — files, classes and modules (the wrapper rule, one entity per declaring file, reopenings `attachedTo` their primary, a `String` patch attached to `<ruby>/String`), methods and parameters, `require`/`require_relative` by path and by load root, superclasses and mixins resolved lexically, the `derived` import, stubs — → `fixtures/ruby/expected/model.jsonl` (24 files, 102 entities / 38 edges) byte-identical to core's encoder and profile-valid with zero issues; 60 cargo tests (50 unit, 10 contract: snapshot, CRLF + reversed creation order, the CLI contract) + 16 core gate tests; `codegraph validate` OK; `bin/codegraph-ruby`; `build.sh --ruby` (a 1.2 MB binary) / `test.sh --ruby` with the release-binary `cmp`; `ruby-test` written in CI, not yet run there |
| M18b | Ruby extractor — model | ✅ (2026-10-13, worktree `ruby-extractor`) `field` (an instance variable, its `attr_*`, a Struct member: one entity `@x`) and `constant` (keyed by full path, with its literal `value`); `Struct.new` / `Data.define` / `Class.new` / `Module.new` assigned to a constant as types, a `Struct.new` superclass as a `generated` inheritance; constant references resolved lexically then through the ancestors; the core table extended with superclasses, mixins and methods (RBS 4.2.0: 915 constants, 23 mixins, 2428 methods) so lookup crosses from the corpus into the VM's classes; the invocation tiers of §19.4 — `declared` where the receiver's class is written, `derived` for typed locals, typed instance variables and the sole-library-ancestor attribution, the language resolved with no edge, untyped receivers dropped and counted; `access` with read/write, `throws`, comments, `sloc` + `cyclomatic`, literals; the Ruby 1.8 require idioms, `load`, `autoload`, shebang scripts; `--explain-dropped`, every drop with its line → `fixtures/ruby/expected/model.jsonl` (27 files, 154 entities / 136 edges; 152 sites, 77.0 % resolved) byte-identical to core's encoder and profile-valid with zero issues; `ruby` in the metrics pass and the fifth `model.metrics.jsonl` (86 of 88 joined, `sloc = ploc` on all 86); 101 cargo tests (90 unit, 11 contract) + 24 core gate tests; the fixture in the analyzer, city, navigator, CLI `validate` and metrics suites; `validate`, `analyze`, `navigator`, `city --layout` and `serve` run on it, City and Navigate screenshots reviewed |
| M18c | Ruby extractor — audit + oracles + distribution | ✅ (2026-10-13, worktree `ruby-extractor`; CI not yet run) rake 13.2.1, rubygems 3.6.2, Mastodon 4.3.0 and rails 8.0.2 audited `validate`-clean (100 / 794 / 2 541 / 3 334 files; 77.8 / 54.4 / 31.2 / 57.0 % of sites resolved, Mastodon's `app/`+`lib/` 62.1 %; rails in 4.7 s). Seven defects found and fixed test-first: a library namespace the corpus reopens below dropped as `namespace-only` (592 `Rails.*` in Mastodon); class methods given by an `included` hook unseen (now read where literal — plain Ruby and ActiveSupport::Concern — and `derived`); a library mixin ignored as a class-side candidate (`validates` charged to ActiveRecord::Base); a per-type `dynamic` flag clouding both sides; a compact declaration's qualifier not read; a constant qualified by a subclass stubbed below `<gems>`; `--explain-dropped` not saying what decided a drop. Oracles: Packwerk 3.3.1 over Mastodon — 4 289 of its 4 335 cross-file references in the model (98.9 %), the rest the wrapper rule; rake booted under its own tests — 1 006 of 1 012 declared methods held by the VM on the same line, 1 533 of 2 829 observed calls already edges. The trace tool (`trace/codegraph_trace.rb`, one file) and `--trace`: `generated` `traitUsage`, `dynamic-candidate` invocations with `candidates`, no entity added — exercised end to end in a container and `validate`-clean. `fixtures/ruby` → 31 files, 181 entities / 153 edges, 177 sites, 76.3 %; metrics 106 of 109 joined. 119 cargo tests (107 unit, 12 contract) + 27 core gate tests. Distribution wired: `ruby-native` on four Unix runners, the release loop, `Formula/codegraph-ruby.rb`, the catalogue row; `docs/ruby-extractor.md` |
| M19a | Vocabulary — lexicon, split, artifact | ✅ (2026-10-26, five stacked PRs from #26 — #26 merged to main 2026-10-27, #27–#30 with #46 on 2026-11-05; Broadleaf 76 310 entities → 3 381 terms in 0.29 s, 2.9 MB, its top ten a commerce vocabulary after 13 words joined the shared list) `Profile.lexicon` on the eleven profiles (keywords, conventional names, affixes, separators — the profile half of #19), METAMODEL §5 row, printed by `profiles --lang`; `@codegraph/vocabulary`: one idiom-parametrized splitter with the acronym rule on Unicode categories, four term classes as tags (never filters), role weights recorded in the artifact, scopes = the fold's containers; `codegraph vocabulary` report, `--level`/`--scope`/`--class`/`--drift FILE`; five `vocabulary.json` snapshots byte-identical, closure and determinism properties; the coverage table of §20.1 filled on fixtures, Broadleaf, codegraph, Mastodon, Plausible |
| M19b | Vocabulary — cloud, tab, city channel | ✅ (2026-10-26, three stacked PRs from #31, merged to main with #46 on 2026-11-05; Broadleaf's cloud and its city raised by `order` are the demo images) deterministic spiral layout with an injected measurer and the no-overlap property; `--svg` with the fixture snapshot; `serve` builds `/vocabulary.json` and answers `/carriers.json?scope=&term=`; the sixth navigator tab (scope follows the selection, chips, table, carriers → reveal), literals pinned, types-only import; `vocabulary:<term>` metric source through the CLI hook, city unchanged; the two demo images under `docs/` and the README section — the issue's fourth criterion |
| M19c | Vocabulary — glossary in the explanation | ✅ (2026-11-12; merged 2026-11-05 with #46 and #42–#45; tested on Spring PetClinic in Broadleaf's place, §20.4) `words` on every insight block — the words of the unit's name, its parameters' and (for a type) its fields', each with `in`, `concern` (domain / technical / ambiguous), `sense`, `meaning`, in that entity's context, asked in the SAME call that explains it; `glossary` on the module block reconciling its types' entries with `polysemous`; `PROMPT_VERSION` 2, the words `.optional()` in the record schema so every existing side-car round-trips byte-identical — no new record type, no format change; the store at version 2 with the `insight_word` projection (rebuilt on `--import`); readers `insights --word/--glossary/--polysemy/--concerns`, `vocabulary --drift-insights`, `/glossary.json`, the entries shown as inferences in both panels; the PetClinic run priced by `--estimate` and measured; `docs/vocabulary.md` |
| M20a | Model providers — the Claude Code adapter | ✅ (2026-11-10, 94 `@codegraph/llm` tests) `claudeCodeClient` in `@codegraph/llm` (§21.1): `claude -p --output-format json --json-schema --system-prompt --tools "" --safe-mode --no-session-persistence`, the user prompt on stdin, `structured_output` / `usage` / `total_cost_usd` / `modelUsage` read into the port's response, every failure classified into the port's one error type; `findClaudeCode` (option → `CLAUDE_CODE_PATH` → PATH → known install locations, pure) and `resolveProvider` with the fixed precedence; fake-process tests, the boundary test unchanged |
| M20b | Model providers — wired and documented | ✅ (2026-11-10, live on Claude Code 2.1.322, Java fixture: 68 calls, 0 failed, 79 records — 70 explained, stamped `claude-sonnet-5-5`, 9 templated — decode-clean, eof `$1.03` for 307 896 + 54 688 tokens; the prompt side came in ≈ 2.7× the bare estimate — Claude Code's per-call scaffolding and schema, which the estimate now counts (§21.4): 280 481 estimated for the 307 896 billed) `--provider claude-code`, `--claude-path`, `--model` default per provider resolved before the plan (`sonnet`), the usage error naming the fix and the `--max-tokens` note; a live run on the Java fixture; `docs/cli.md`, `docs/insights.md`, README, CLAUDE.md and the website's explain pages name the port, the three adapters and the Anthropic API slot (§21.6) |
| M21a | Generalized walk — the seam | ✅ (2026-11-22, branch `feat/walk-generalized`) steps 1–2 of §22.6: a golden suite pins default `explain` (plan, prompts, fingerprints, side-car) on the five fixtures and is shown to bite; `WalkSpec` in `@codegraph/insights` with `explain` as the built-in spec and the engine files naming no Specy vocabulary (boundary test); goldens byte-identical, 0 calls planned on a copy of the paid PetClinic store, a toy second spec run end to end |
| M21b | Generalized walk — selectors and selection | ✅ (2026-11-22, branch `feat/walk-generalized`) steps 3–4: `selectors.ts` in `@codegraph/analyzer` (id, kind, trait, lang, name, module, file, `edge`, `edge-in`, and/or/not in the JSON form; edges read through the view; core's vocabulary or a usage error); the five selection rules of §22.3 as properties; `--scope` ≡ `--include id:` byte for byte |
| M21c | Generalized walk — definitions and their store | ✅ (2026-11-22, branch `feat/walk-generalized`) steps 5–6: `codegraph.walk/1` (defaults, field grammar → Zod → strict schema, entity instructions) compiled to a spec whose fingerprint hashes what the definition says — and nothing for the built-in; one store per walk (`<model>.N.walk.db` + export), no migration, a foreign name refused, a changed digest said before the spend; round trip the identity |
| M21d | Generalized walk — `codegraph walk` | ✅ (2026-11-22, branch `feat/walk-generalized`; live on PetClinic through Claude Code: 83 calls, 0 failed, 200 779 + 43 814 tokens, $0.94, a second run 0 calls; the estimate 12.4 % above the billed input and, on the guessed 500 per block, 5.3 % below the billed output — replaced by the run's means, operation 500, type 620, §22.5) steps 7–8: one shared runner under `walk` and `explain`, `explain` configurable (`--include`/`--exclude`/`--levels`/`--closure`/`--instructions`/`--walk`) with its blocks untouched, `insights --walk`; a live filtered walk on PetClinic measured against its estimate; docs with schema-checked examples |
| M22a | Python extractor — profile v2 + skeleton | ✅ (2026-11-22, worktree `python-extractor`, PR #51) §23.9: the parity script run first (CPython's `ast` against the recovered tree, on the fixture and on requests); `python` profile v2 in core (`decorator` and `lambda` no longer kinds, `annotationUse` and `throws` added, the module's name its path) and the registry test; `extractors/python/` in Rust on Ruff's parser pinned by tag, the typeshed table embedded and its generator beside it; the walking skeleton — decoding, import roots, classes / functions / methods / parameters at every nesting, absolute and relative imports with the submodule rule and re-export chains, bases, the stub roots `<builtins>` / `<stdlib>` / `<site>` — → `fixtures/python/expected/model.jsonl` byte-identical to core's encoder, profile-valid with zero issues; the core gate; `bin/codegraph-python`, `build.sh --python`, `test.sh --python` with the release-binary `cmp`; `python-test` in CI |
| M22b | Python extractor — model | ✅ (2026-11-22, worktree `python-extractor`, PR #51) `attribute` and `variable`; scopes and the name tiers of §23.4; every receiver shape with its provenance (`declared` where the class is written, `derived` for flow, for an annotation and for a sole library ancestor); star imports bound; `annotationUse` with written arguments, `access`, `reference`, `throws`; synthetic classes; `declaredType`; comments, `sloc` + `cyclomatic`, literals; `.pyi` and shebang files; `python` in the metrics pass and a sixth `model.metrics.jsonl`; the full fixture in every per-fixture suite; every CLI command verified on it; city and navigator screenshots reviewed |
| M22c | Python extractor — audit + oracles + distribution | ✅ (2026-11-23, worktree `python-extractor`, PR #51; `python-native` green on its four runners there, the release loop not yet run with a Python asset) as built: 81.6 / 73.4 / 81.9 / 77.0 / 78.7 % of sites resolved on requests / Django / Zulip / CPython 3.14.10 / 2.7.18; pyright agrees with `declared` at 98.6 % (requests), 98.3 % (Zulip) and 98.8 % (Django), and with `annotation-typed` at 99.1 % and 98.9 %, which stays `derived`; the rulings taken on the audit are in §23. As planned: requests, Django, Zulip, CPython 3.x `Lib/` and CPython 2.7.18 `Lib/` audited `validate`-clean; declarations equal to CPython's `ast` up to the stated folds; the import graph against grimp on Django; references against pyright per provenance, the annotation decision confirmed or reversed on those numbers; `trace/codegraph_trace.py` and `--trace`; binaries on four Unix runners, the registry entry, the formula, `--licenses`; `docs/python-extractor.md`, the website pages, README, CLAUDE.md |
| M23a | Discovery skills — skeleton, guide, step 1, `query` | §24.10, the two measurements first (a skill reached by name or by file path; Hugo mounting `../plugin/queries`); the helper views defined once in `@codegraph/analyzer` and the three docs copies pinned to it; `codegraph query` (bound parameters, read-only by handle and by a one-statement rule, `codegraph.queryResult/1`) in every CLI suite and the SEA smoke; `plugin/` with `discover` (preflight, intake, state, resume) and `discover-1-structure`; the session-free tests of §24.8 green. Step 1 runs on PetClinic from a cold checkout and a second session resumes from `.codegraph/discovery.json` alone |
| M23b | Discovery skills — steps 2–3, the tour | `history --report hotspots --model` with the four rank families, hand-counted on the history fixture; `discover-2-boundaries`, `discover-3-activity` and the `query` skill; `--tour` writing its brief and `REPORT.md` with no question asked; one city restyled per step; `activity.md` without its spreadsheet. On a non-Java corpus the tour says what it could not do |
| M23c | Discovery skills — step 4 | the three detection layers, the slice on facts and with candidates, overlap groups and the residue as query files; `stacks/spring.md` plus one checked stack per other extractor language, the rest listed as not covered. PetClinic's inventory equals the entry points of `--report wiring` plus a hand count of what the two other layers add |
| M23d | Discovery skills — steps 5–6, Specy | the consent block, the scope proposed from steps 3–4, the background run; `domain-facts`, the three readings and the hand-over; the three Specy changes of §24.6 in its repository; `domain.md` corrected. On a copy of the paid PetClinic store step 5 plans the M21 gate's bytes and spends nothing, and step 6's `.domain` passes `specy validate` |
| M23e | Discovery skills — distribution | the marketplace file; the website how-to and `query-model-db.md` leading with `codegraph query`; the eval suite and its scores stated in §24.8; README, CLAUDE.md, `docs/cli.md`; the release step. Installable by two commands |

## 26. Decisions made in this plan (deltas vs. the design doc)

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
| Code metrics (M17) | one Rust binary, `codegraph-metrics`, linking big-code-analysis as a library and run as a pass over any extractor's model, joined on anchors; not bca inside each extractor, not bca's CLI | the join needs nothing but `(file, start, end)`, which every entity carries (invariant 3); four FFI bridges would write the join four times; the CLI would ship 23 grammars and a wire format to translate, with no hold on number spelling or history's reference time |
| Who owns a measure (M17) | the extractor's keys (`sloc`, `cyclomatic`) are never touched; the pass owns a closed key list and replaces exactly it on every run | compiler-based, hand-counted values must not be second-guessed by a tree-sitter parse; owning a closed list makes a re-run the identity and a stale key impossible |
| Measure attribution (M17) | a space the model does not name is charged to the entity around it; span measures (`lloc`, Halstead, `mi`, `npm`/`npa`) only on an entity that is one space | the `cyclomatic` lambda rule, applied to every additive measure, so `sum:` counts code once; Halstead and MI do not add, so a union of spaces has none rather than a wrong one |
| Join tolerance (M17) | an exact span first; then the same last line with only annotation/attribute/decorator/comment lines between the two starts, brackets balanced; then containment | Spoon starts a method after its annotations, tree-sitter at them; the TypeScript compiler starts an exported class at its decorator, tree-sitter after — 9 814 of Broadleaf's 26 209 joins are this case; a gap holding code is never bridged |
| Measure numbers (M17) | four decimals, spelled as JavaScript's `Number::toString` | libm may differ in the last ulp across platforms, and contract §6 promises the same bytes on every OS; core's encoder is the spelling every other producer already matches |
| History measures (M17b) | a side-car `<model>.history-metrics.jsonl` (entities by natural key, files by model path), joined by the CLI; never `model.jsonl` | §11 principle 1: a window counts back from the commit's time, so history in the model would make snapshots of unchanged code differ; decided by the user over the first draft of §18.2 |
| History reference (M17b) | the model's `repository.commit`, else HEAD, `--ref` overriding; clocked at that commit's committer time; the full commit graph, merges excluded | the wall clock would change the bytes daily; first-parent (bca's default) hid 65 % of Broadleaf's commits from the file level while blame still credited them per entity |
| Passes in the app (M17c) | a registry entry with `role: "pass"`, its own contract `<pass> <model> --src <dir>`, run after the extractor; missing or failing never fails a job; never run over a model the user opened | the catalogue stays data (one row, no new mechanism); the user's measures are an addition to a page, not a condition of having one; a user's own file is not ours to rewrite |
| Shipping the pass (M17c) | one Homebrew formula every extractor formula depends on; built natively on four Unix runners, each proving the snapshots; the third-party notice embedded (`--licenses`) | the user asked for one binary installed with each extractor; native builds need no cross C toolchain for the grammars; MPL-2.0 asks where the source is |
| Ruby front end (M18) | Prism as a library plus a lexical constant resolver and an embedded table of what the VM defines; booting the application only as the `--trace` enrichment; tree-sitter-ruby and the type checkers rejected as baselines | Ruby binds nothing before it runs, and a legacy application does not boot; the lexical half of constant lookup is the one part that is statically honest, and Prism — CRuby's own parser — recovers from syntax errors, so even a broken file extracts |
| Ruby extractor host (M18) | written in Rust on `ruby-prism`, Prism pinned by exact version; no Ruby to build or to run, the core table's generator included (`ruby-rbs`) | a Ruby program parses with whichever Prism the machine's Ruby bundles, so two machines could write two models of one corpus; Ruby has no dependable single-binary packager; the repository already ships one Rust binary per platform (§18). The first extractor not written in the language it reads — nothing in the model depends on it |
| Ruby type identity (M18) | the module is the file; one entity per declaring file, a reopening `attachedTo` the primary declaration (the one writing a superclass, else first in canonical order); a body that only wraps class/module declarations declares nothing | Ruby has no namespace apart from its types and reopens them across files as a matter of course; both spellings of a nested class must be one key, and a namespace opened in fifty files must not be fifty buildings; containment ≠ attachment (invariant 5) is exactly "written here, belongs there" |
| Ruby external keys (M18) | `<ruby>` = the constants the VM defines before any file runs (RBS `core/`, pinned, named in the header); `<gems>` = everything else, the standard library included; a required feature is a stub module below `<gems>` named as written | the standard library is default and bundled gems whose set moves with every release, and keys must not move with it; core-only also makes the monkey-patch rule exact — the VM defined `String` first, so a corpus body of it is a reopening and a reference still names the VM's |
| Ruby call provenance (M18b) | `declared` exactly when the receiver's class is WRITTEN at the site (none, `self`, a constant, `Foo.new`); `derived` for what flow says (a local or an instance variable assigned `Foo.new`) and for the attribution of an undeclared self-call to a sole library ancestor; an untyped receiver is dropped, never guessed | invariant 2: a `declared`-only analysis must hold nothing a second assignment could falsify. `has_many` is the edge a Rails reader most wants and the one the source least proves — it is in the model, and it says what it is |
| Ruby language calls (M18b) | a method of `Object`/`Kernel`/`BasicObject`, of `Class`/`Module` on the class side, or of a literal is resolved, counted, and NOT an edge; a core method reached through a class the receiver is (`upcase` in a `String` subclass) is an edge to that stub | `puts` and `private` would give every method an arrow to `<ruby>/Kernel`: the largest hub of every city, meaning nothing. The rate still counts them, so a corpus is not penalised for using its language |
| Ruby fields and constants (M18b) | a field is the variable, `@x`, one entity with the `attr_*` that exposes it, owned by the root-most corpus ancestor that has it; a constant is keyed by its full path like a type; an accessor call is an `access`, not an `invocation` | the accessor is syntax over state (the C# property rule), and `@x` keeps the key apart from a `def x`; binding to the root-most ancestor makes a subclass's `@total` and its parent's ONE field, as they are one slot in the object |
| Ruby synthetic types (M18b) | `X = Struct.new(…)`, `Data.define`, `Class.new(Base)`, `Module.new` are types named by the constant; a Struct/Data superclass is `inheritance` to `<ruby>/Struct` with provenance `generated` | the constant IS the class's name in Ruby; `generated` because the call produces the class — the source writes no `class`, so no `declared`-only analysis should count it as written |
| Ruby hooks (M18c) | what an `included` hook gives is read statically where the idiom is literal — `base.extend(M)` in `def self.included(base)`; ActiveSupport::Concern's `ClassMethods`, `class_methods do`, `included do` — and used for LOOKUP only: no `traitUsage` is written, and a method found through a hook is `derived` | the plan left the idiom to `--trace`; the audit showed it carries nearly every shared class method of a Rails codebase (214 concerns in rails), a non-booting legacy application has no trace, and without it the attribution rule charges a concern's method to a library. Naming ActiveSupport::Concern in the extractor is the price: it is read by what the module WRITES, never by its name alone |
| Ruby attribution, class side (M18c) | a library module a type includes is one more library that could answer on its CLASS side | its hook may have extended the class: `validates` is ActiveModel::Validations'. Costs coverage — a controller that includes Pundit loses `before_action` — and buys the rule its soundness; the drop names both candidates, which is what a later `dynamic-candidate` edge would need |
| Ruby dynamic types (M18c) | "defines methods at run time" is per side: instances or the class itself | `define_method` in a class body says nothing about `where` or `scope`; one flag for both dropped every class-side call of any model with a computed accessor |
| Ruby namespaces (M18c) | a namespace no file gives a body to is a library's when the corpus proves the body exists elsewhere (a message no bare module answers, a class inheriting from a path nothing opens); otherwise it stays `namespace-only` | `class Rails::Patch` and `class Admin::Users` have the same shape; only evidence tells a gem from a Zeitwerk directory, and no name is trusted |
| Ruby compact declarations (M18c) | `class Admin::Users` reads `Admin` — a `reference`; a wrapper `module Admin; class Users` does not | the compact form needs the name to exist, the wrapper creates it: the one difference between the two spellings. It is also where the model and Packwerk part: Packwerk counts the wrapper's keyword as a reference (45 of 4 335 on Mastodon) |
| Ruby trace (M18c) | one Ruby file run by the user inside the booting project; mixins as `generated` `traitUsage` anchored on the type's declaration, observed calls as ONE `dynamic-candidate` invocation per site with its `candidates`; names and positions only, never a key; no entity added | running corpus code is the user's decision, not the extractor's; an observation is what ran once, which is exactly what `dynamic-candidate` says; and a model must have the same entities whether or not a trace was at hand |
| Ruby import layer (M18) | a constant resolving to a declaration in another file is ONE `derived` `import` per (file, target file), at the first site, absent where a `require` already states it | a Zeitwerk application writes no `require` — the reference is the load — so the one layer comparable across languages would be empty for every Rails corpus; `derived` keeps the inference out of any `declared`-only analysis |
| Vocabulary source (M19) | words are the model's `TNamed` names — every kept entity's name split by its profile's idiom; source text is never read | the words the issue names are what the model carries, with kind, containment and anchor; a lexer per language would be a third source reader outside the two the architecture licenses; the cost is coverage (no locals from Ruby and Elixir), measured per extractor and stated, not hidden |
| Where the vocabulary lives (M19) | `@codegraph/vocabulary`, a pure package with its own artifact `vocabulary.json`; never `model.jsonl`, never `analyzer`, never the metrics pass | a view model with a layout, like the city and the navigator; derived from names, hence recomputable — the opposite of a measure, and `metrics` holds measured numbers only (METAMODEL §3.8) |
| The idiom is profile data (M19, #19) | `Profile.lexicon`: keywords, conventional member names, technical additions, separators, prefixes, suffixes, the C# interface prefix, file-named modules; one splitter reads it | invariant 8: a profile is specifiable without being implemented; the algorithm knows no language, and a language without an extractor still gets its idiom |
| Term classes are tags (M19) | every token kept and tagged `domain / technical / keyword / short`; a consumer filters; the technical list is data with its digest in the artifact | "not shown" must stay distinguishable from "not there" (the §3.8 absence rule applied to words); drift needs the technical words; the list is contestable by construction, so it is overridable and named |
| Vocabulary weights (M19) | by role from traits — type and module 8, attribute 4, operation 3, parameter and local 1 — recorded in the artifact beside the raw occurrence count | a count without its scheme is not a fact (the city's `bindings` rule); the issue asks that a class name outweigh a buried variable, and nouns outweigh verbs whose prefix is technical |
| Vocabulary scopes (M19) | a scope's words are those of every entity whose fold container it is (`containingType`/`containingModule`); attachment not followed; operations on demand, not in the artifact | the same membership the city uses, so `vocabulary:<term>` measures the building whose words were counted; the navigator addresses types and modules only |
| Cloud layout (M19b) | pure deterministic geometry in the package — weight-ordered spiral, axis-aligned boxes, an injected text measurer with a monospace default; no `d3-cloud` | the demo image is an SVG the CLI writes and a fixture snapshots, so the layout must run in Node and give the same bytes; the browser passes `measureText` into the same function |
| Carriers are a lookup (M19b) | the artifact carries counts per (scope, term); the carrying entities come from `/carriers.json?scope=&term=` over the model `serve` holds | lists per term per scope would multiply the artifact for evidence a page asks for one word at a time; a static host degrades to no evidence rather than a bigger file (the `/insight.json` precedent) |
| Glossary tied to the entity (M19c) | each explained unit's block carries `words`: the words its name (and its parameters' or fields' names) is made of, with sense and concern in that entity's context, asked in the explanation call itself; the module block reconciles its types' words into `glossary`; scopes and the corpus roll up from the records | a meaning belongs to the entity that uses the word, and the context pack of that entity is the one place the pipeline has its source, facts and dependencies' explanations together; a scope has a vocabulary, not a meaning — the two earlier drafts (a standalone command over a term table; a second request per scope) asked at the wrong altitude |
| Glossary storage (M19c) | the insights store, version 2: an `insight_word (id, word, in, concern, sense, confidence)` projection written with the record and rebuilt on `--import`, indexed on `word`; the side-car stays the one source of truth | bought, so it shares the insights' lifecycle (migrated, never regenerated); a projection makes `--word` an index lookup without a second authoritative copy — the M16b rule (what is queried is a column over the JSON, what is fetched is the block) |
| Glossary wire format (M19c) | no new record type: `words`/`glossary` live inside `block`, `.optional()` in the record schema and required on the wire by `strictify`; `PROMPT_VERSION` 2 | M11 put the prompt version in every fingerprint so a better prompt re-explains what it improves — the designed case; a version-1 record decodes and re-encodes to its own bytes, so every existing side-car round-trips, and nothing is deleted by the bump |
| Words out of the chain (M19c) | every unit has two hashes: its fingerprint (stored) and its chain (the fingerprint without the words, over its dependencies' chains; never stored); a dependent hashes a dependency's chain, a module its types' whole fingerprints; a record stamped before is reused while that stamp matches | no caller's prompt shows a callee's words, only a module reads its types' — so a lexicon correction re-explains 10 PetClinic units instead of 53; a match on the old stamp implies one on the new, so no paid store is re-explained for the switch |
| Port and adapters (M20) | `LlmClient` is the port; OpenRouter, Cloudflare AI Gateway and Claude Code are adapters behind it, each holding its transport behind one function; the Anthropic API is a named empty slot (§21.6), not a stub | the walk, the store and the CLI never learn a provider; a fourth adapter is one file and one entry in `providers.ts` |
| Claude Code as a subprocess (M20) | the user's own `claude` binary in headless mode — `--safe-mode` (not `--bare`, which drops OAuth), tools off, no session, the system prompt replaced, the user prompt on stdin | the installation, login and version are the user's; no second SDK enters the workspace; argv has a 128 KB per-argument limit |
| Provider precedence (M20) | `auto` takes the single configured provider; with several, OpenRouter, then Cloudflare, then Claude Code, the reason naming the flag for the others; `--model` defaults per provider (`sonnet` on Claude Code) | an exported key is a deliberate act, an installed CLI is ambient; `openai/gpt-5.6-luna` means nothing to Claude Code |
| Python front end (M22) | Ruff's parser (`ruff_python_parser`, a git dependency pinned by tag, its commit in `Cargo.lock`) plus the compiler's scoping rules, an import resolver and a table distilled from typeshed `stdlib/`; CPython's `ast`, grimp and pyright as ORACLES; importing the project only as the `--trace` enrichment; ty deferred until it has an API to pin | Python binds names before it runs and nothing else. CPython's parser exists only inside a CPython: one grammar per interpreter, a file rejected whole at its first error, no Python 2 — while the recovered tree, measured on CPython 2.7.18's `Lib/` against `lib2to3`, holds every class, function and import statement (8 348 / 34 934 / 8 464, no file differing). The first parser here that is not the language's own, and so the first held by a parity oracle |
| Python extractor host (M22) | written in Rust; no Python to build or to run, the table's generator included (the same parser reads typeshed's 752 stubs with no error) | the §19 reasons, unchanged: an extractor in Python reads whichever grammar the machine's interpreter has, Python has no dependable single-binary packager, and the repository ships one Rust binary per platform. No bindgen this time: the closure is 60 Rust crates |
| Python module identity (M22) | the module is the file, keyed AND named by its path; a package is its `__init__.py`; no parent link between modules | a dotted name is not unique in a repository (`conftest`, `tests.test_models`) and depends on which directory is taken for a root — an inference, and a key must not move when a heuristic does. A namespace package has no `__init__` to be a parent, and a file is not written in another file (invariant 5) |
| Python import roots (M22) | relative imports by path arithmetic; a regular package names its own root (climb while `__init__.py`); the nearest root wins, a tie is dropped; namespace-package hits and `implicit-relative` counted on their own; `--import-root` for what no file betrays | `sys.path` is written nowhere. Each rule is a fact about the layout, not the language, and is counted as one (the §14.4 and §19.2 precedent) so a rate never hides which half resolved |
| Python external keys (M22) | `<builtins>` (what the interpreter binds before any file runs), `<stdlib>` (every module of typeshed's `VERSIONS` at a pinned commit, removed ones included, plus the Python 2.7 module index), `<site>` (everything else), a module named by the dotted name as written | unlike Ruby's default gems, the union of `VERSIONS` only grows, so keys do not move with the interpreter; and standard library against third party is the first cut a Python reader makes. A distribution's name is written nowhere in the source and is not guessed |
| Python call provenance (M22b) | `declared` when a name is bound by the scoping rules, or an attribute's receiver is a module, a class named at the site, or `self` along written bases; `derived` for flow, for an ANNOTATED receiver (counted `annotation-typed`), and for attribution to a sole library ancestor; an untyped receiver is dropped, never guessed | invariant 2: the interpreter never checks an annotation, so a `declared`-only analysis must not hold what it says. The tier is counted apart and measured against pyright in M22c — the decision is made to be reversible on numbers |
| Python profile corrections (M22a) | `decorator` → an `annotationUse` edge; `lambda` and function locals are not entities; `variable` is a module-level binding; `throws` added; `interfaceImplementation` kept and never written by the extractor | the decisions M10c, M13 and M18 took after the profile was written: a decorator application is annotation usage with arguments, a lambda contributes to what writes it, a local is flow. A module global is structure — it is what other files read |
| Python class stub keys (M22c) | one key per class: a `<site>` class at the dotted module (a stated guess, on class evidence only), a `<stdlib>` class where typeshed declares it; the import edge still names what the file wrote | fan-in on a library class means something only when every spelling of its import meets at one node — 12 classes had two keys on Zulip. Ruled on the audit, against §23.3's "the name as written at the site" |
