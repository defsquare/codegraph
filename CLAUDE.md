# Codegraph — CLAUDE.md

Codegraph extracts dependencies between code entities (classes, functions,
modules) from multi-language corpora — including non-compilable legacy — into a
trait-based metamodel (FamixNG-style), and analyzes the result in TypeScript:
dependency graphs, coupling, architecture, and eventually a **3D "code city"
visualization** (Three.js) of the code structure.

Pipeline: per-language **extractors** (Java/Spoon first) → versioned
**`model.json`** interchange files → TypeScript **analyzer** → reports and the
**city renderer**.

The full implementation plan, milestones, and locked design decisions live in
`PLAN.md`; the conceptual reference for every concept, its attributes, and its
relations is `METAMODEL.md` — read them before structural changes.

## Architecture

```
extractors/java/     Maven project (Spoon, noClasspath) → emits model.json. JVM code only.
schemas/             Generated JSON Schema — THE cross-language contract, committed.
packages/core/       @codegraph/core — traits, edges, language profiles (data),
                     Zod validation, JSON Schema export. Pure data + validation.
packages/analyzer/   @codegraph/analyzer — graph construction, derived indexes,
                     queries, metrics (coupling, cycles), exports. Pure computation.
packages/cli/        @codegraph/cli — `codegraph` command.
packages/viz/        (future) Three.js code city. The ONLY package that may import three.
fixtures/            Reference corpora + expected model.json snapshots.
```

### Hard boundaries (convenience does not override architecture)

- **`core` and `analyzer` never import Three.js** — they must run in Node with
  no DOM. `viz` reads analysis output; it never mutates the model and never
  re-derives graph facts the analyzer already computes.
- **Extractors contain no metamodel intelligence.** They emit JSON conforming
  to `schemas/model.schema.json` and nothing else. All trait/profile/validation
  logic lives once, in `core`. An extractor in any language (Java, Go, .NET…)
  must be able to conform using only the published schema.
- **`core` owns the vocabulary.** Trait names (`TNamed`, `TInvocable`,
  `TAttachedTo`…), edge kinds, and provenance values are canonical — never
  rename or alias them locally.

## Stack

- TypeScript, strict mode, `"module": "NodeNext"`; Node ≥ 22; pnpm workspace
- Zod v4 — one definition per trait yields the TS type, the runtime validator,
  and the JSON Schema (`z.toJSONSchema()`)
- Vitest + fast-check (property-based tests); tsup for builds
- Java 17+ / Maven / Spoon / Jackson for `extractors/java`
- (future) Three.js + Vite for `packages/viz` — Three.js must never leak into
  other packages' dependency graphs

## Commands

```bash
pnpm install
pnpm -r build                 # build all TS packages
pnpm -r test                  # all tests (unit + property)
pnpm run gen:schemas          # regenerate schemas/*.schema.json from core (commit the result)

cd extractors/java && ./mvnw package    # Maven Wrapper — `mvn` is NOT installed
java -jar target/codegraph-java.jar --src <dir> --out model.json
# needs a JDK on PATH; non-interactive shells do not source sdkman:
#   export JAVA_HOME="$HOME/.sdkman/candidates/java/25.0.4-tem"

./bin/codegraph analyze model.json --report deps   # after `pnpm -r build`
```

## Metamodel invariants (violating these is a bug, not a style choice)

1. **Traits, not hierarchy.** An entity is `{id, kind, traits[], ...trait keys}`.
   Never introduce an entity class hierarchy; capabilities compose as traits.
   The canonical test: a Clojure fn-var is `TNamed + TStructural + TInvocable`.
2. **Provenance on every edge**, always one of `declared | derived |
   dynamic-candidate | generated`. Never mix facts and inferences — an analysis
   that needs facts only filters on `declared`.
3. **Evidence everywhere:** entities and edges carry `anchor {file, span}`.
4. **Outgoing edges only.** Inverse indexes (incoming invocations, subtypes,
   importers…) are derived in memory by the analyzer, never serialized.
5. **Containment ≠ attachment.** `TChildOf`/`TWithChildren` = where it is
   written; `TAttachedTo` = what it semantically belongs to. Distinct, both kept.
6. **Stub discipline:** external types are degraded `isStub` nodes; their edges
   are kept. Internal-only view = filter stubs. Membership is decided by a
   **whitelist of corpus-declared ids — never by package/name prefix**
   (Spoon noClasspath invents plausible FQNs).
7. **Ids are opaque strings** (`lang:module/symbol#disambiguator`). The
   analyzer compares them, never parses them.
8. **Profiles are data.** A language profile must be specifiable without being
   implemented. Validation: `required ⊆ traits ⊆ required ∪ optional` per kind.
9. **Import graph is the first-class layer** — the only one comparable across
   all languages. Cross-language analyses use the intersection of the profiles
   involved.
10. **Graph closure is a tested property:** no edge, parent, or child may point
    to an unknown id (stubs count as known). Enforced by the property suite,
    not by convention.

## Code city visualization rules (when `packages/viz` exists)

- **Meaning controls appearance.** Every visual channel (height, footprint,
  color, glow) maps to a documented metric (LOC, fan-in, kind, provenance…).
  Color is semantic — never reused for aesthetics alone; no decorative effects.
- **The city renders the model, honestly.** Derived/`dynamic-candidate` edges
  must be visually distinguishable from `declared` facts. Never draw a
  relationship the model does not contain.
- **Per-frame paths allocate nothing.** Reuse vectors, colors, materials;
  instanced meshes for buildings. Visual richness does not permit GC pressure
  in the render loop.
- **Judge visible work at user-facing camera angles** — review screenshots of
  the actual render, not coordinates in code.

## Engineering rules

### Red-Green TDD is mandatory, properties as contract
- Every bug fix starts with the smallest deterministic failing test.
- The property suite (closure, no self-reference `from !== to`, provenance set,
  profile validity, deterministic sorted output) runs against **every**
  extractor output — it is the acceptance gate for any new extractor.
- Extractor cross-validation: when two extractors cover one language, the
  richer one (Spoon) is the oracle; the other's edge set must be a subset.
  Any gap is a missed resolution case, not noise.
- Never move a knob to keep an assertion green — when a test breaks because
  the model improved, restate it as the durable property it guards.

### Verify the deliverable
- Before handing off: `pnpm -r test`, `pnpm -r build`, typecheck green; for the
  Java extractor, `./mvnw package` + schema validation of its output.
- Verify new code is actually **imported, constructed, and called** — an
  unwired subsystem is not delivered.
- If `schemas/` changed, it was regenerated (`pnpm run gen:schemas`) and
  committed together with the `core` change that caused it.
- For visual changes: exercise them in the browser and read the resulting
  screenshot before claiming they work.

### Style
- Strict typing throughout; make state ownership visible.
- Comments explain constraints and non-obvious invariants, not narration.
  Keep per-function comments to 1–3 lines.
- Language-specific extraction quirks (e.g. "Spoon invents FQNs in
  noClasspath") belong as documented `notes` in the language profile, not as
  tribal knowledge in comments.

### Git
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`,
  `test:`), subject < 50 chars, present tense; scope by package when useful
  (`feat(core): …`, `feat(extractor-java): …`).
- Describe what the commit actually did — inspect the diff before naming it.
- One logical change per commit/PR. Never amend or force-push without an
  explicit request.
