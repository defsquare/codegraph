# Codegraph — CLAUDE.md

Codegraph extracts dependencies between code entities (classes, functions,
modules) from multi-language corpora — including non-compilable legacy — into a
trait-based metamodel (FamixNG-style), and analyzes the result in TypeScript:
dependency graphs, coupling, architecture, and eventually a **3D "code city"
visualization** (Three.js) of the code structure.

Pipeline: per-language **extractors** (Java/Spoon first) → versioned
**`model.jsonl`** interchange files → TypeScript **analyzer** → reports and the
**city renderer**.

The full implementation plan, milestones, and locked design decisions live in
`PLAN.md`; the conceptual reference for every concept, its attributes, and its
relations is `METAMODEL.md` — read them before structural changes.

## Architecture

```
extractors/java/     Maven project (Spoon, noClasspath) → emits model.jsonl. JVM code only.
schemas/             Generated per-record JSON Schemas + the container contract
                     (README.md) — THE cross-language contract, committed.
packages/core/       @codegraph/core — traits, edges, language profiles (data),
                     Zod validation, JSON Schema export. Pure data + validation.
packages/analyzer/   @codegraph/analyzer — graph construction, derived indexes,
                     queries, metrics (coupling, cycles), exports. Pure computation.
packages/city/       @codegraph/city — the city MODEL: modules → districts,
                     types → buildings (dimensions from configurable metrics),
                     dependencies → roof-to-roof arrows. No placement, no
                     rendering. Pure computation.
packages/navigator/  @codegraph/navigator — the navigator MODEL: the browsable
                     tree (modules → types → operations/attributes) plus one
                     classified dependency row per base edge, carrying member,
                     provenance and anchor included. Pure computation.
packages/cli/        @codegraph/cli — `codegraph` command.
packages/viz/        @codegraph/viz — Three.js code city: renders a laid-out
                     city.json artifact (its ONLY input; guard-enforced). The
                     ONLY package that may import three. Vite app, no library.
packages/navigator-ui/ @codegraph/navigator-ui — React model navigator: a
                     virtualized tree with search beside a fan-in/fan-out
                     dependency view. Renders a navigator.json artifact (its
                     ONLY input; guard-enforced). The ONLY package that may
                     import react. Vite app, no library.
fixtures/            Reference corpora + expected model.jsonl snapshots.
```

### Hard boundaries (convenience does not override architecture)

- **`core`, `analyzer`, `city` and `navigator` never import Three.js or React**
  — they must run in Node with no DOM. `viz` reads the city model and
  `navigator-ui` the navigator model; neither mutates its model and neither
  re-derives graph facts the analyzer already computes.
- **A frontend imports its model package for TYPES ONLY.** A value import
  drags the whole Node pipeline (→ analyzer → core, zod, `node:sqlite`) into
  the browser bundle and breaks the build. Constants a frontend needs — the
  artifact `kind`, the dependency-role vocabulary — are restated as literals
  and pinned equal to the package's own by a test.
- **Extractors contain no metamodel intelligence.** They emit JSON conforming
  to `schemas/` — the per-record schemas AND the container contract — and
  nothing else. All trait/profile/validation
  logic lives once, in `core`. An extractor in any language (Java, Go, .NET…)
  must be able to conform using only the published schema.
- **The interchange is line-based and closed.** One JSON record per line,
  sections in order, identity as `(m, s, d)`, every reference a file-scoped
  surrogate — so a dangling reference is unwritable, not merely reportable. A
  producer that cannot close a reference drops it and says so.
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
java -jar target/codegraph-java.jar --src <dir> --out model.jsonl
# needs a JDK on PATH; non-interactive shells do not source sdkman:
#   export JAVA_HOME="$HOME/.sdkman/candidates/java/25.0.4-tem"

./bin/codegraph analyze model.jsonl --report deps  # after `pnpm -r build`
./bin/codegraph city model.jsonl --serve           # 3D city at http://localhost:4177
./bin/codegraph navigator model.jsonl --serve      # navigator at http://localhost:4178
#   both bind EVERY interface by default; --host 127.0.0.1 keeps them local
```

## Metamodel invariants (violating these is a bug, not a style choice)

1. **Traits, not hierarchy.** An entity is `{id, kind, traits[], ...trait keys}`.
   Never introduce an entity class hierarchy; capabilities compose as traits.
   The canonical test: a Clojure fn-var is `TNamed + TStructural + TInvocable`.
2. **Provenance on every edge**, always one of `declared | derived |
   dynamic-candidate | generated`. Never mix facts and inferences — an analysis
   that needs facts only filters on `declared`.
3. **Evidence everywhere:** entities and edges carry `anchor {file, span}`.
4. **Outgoing edges only.** Inverse indexes — incoming invocations, subtypes,
   importers, and `children` (the inverse of the stored `parent`) — are derived
   in memory by the analyzer, never serialized. v1 files still carry `children`;
   M6 drops the key while `TWithChildren` stays a declared trait.
5. **Containment ≠ attachment.** `TChildOf`/`TWithChildren` = where it is
   written; `TAttachedTo` = what it semantically belongs to. Distinct, both kept.
6. **Stub discipline:** external types are degraded `isStub` nodes; their edges
   are kept. Internal-only view = filter stubs. Membership is decided by a
   **whitelist of corpus-declared ids — never by package/name prefix**
   (Spoon noClasspath invents plausible FQNs).
7. **Identity is the natural key** `(lang, module, symbol, disambiguator?)`.
   A rendered id (`lang:module/symbol#disambiguator`, from core's `renderId`)
   is a display projection and is **never parsed** — v1 files carry only the
   rendered form, so the analyzer compares those strings as opaque tokens;
   from M6 the key is carried structurally and compared component-wise. `/` and
   `#` are reserved in the key's components so rendering stays injective (two
   keys can never collide into one id); encoding-level surrogates are not
   identity and never leave the file that assigns them.
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
