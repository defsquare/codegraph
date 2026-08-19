# Codegraph

Extract dependencies between code entities — classes, functions, modules — from
multi-language corpora, **including non-compilable legacy code**, into a
trait-based metamodel, and analyze the result: dependency graphs, coupling,
cycles, architecture, and eventually a 3D "code city".

```
┌──────────────────┐    ┌───────────────────┐    ┌──────────────────────┐
│ Extractors       │    │ JSON interchange  │    │ TypeScript analyzer  │
│ (native tooling) │ ─▶ │ model.json        │ ─▶ │ validate → graph →   │
│ Java: Spoon      │    │ (versioned schema)│    │ queries → exports    │
└──────────────────┘    └───────────────────┘    └──────────────────────┘
```

Extractors are **federated behind one contract**: each uses the best native tool
for its language and only has to emit conforming JSON. Every bit of intelligence
about the metamodel — traits, profiles, validation, derived indexes, analyses —
lives once, in TypeScript.

## Why trait-based

There is no entity class hierarchy. An entity is `{ id, kind, traits[] }` plus
whatever attributes its traits contribute. The case that motivates the design: a
Clojure var holding a function is simultaneously named, a value holder, and
invocable — `[TNamed, TStructural, TInvocable]`. No tree can place it;
composition expresses it directly.

Four rules make the model trustworthy rather than merely rich:

- **Provenance on every edge** — `declared | derived | dynamic-candidate |
  generated`. Facts and inferences are never mixed; a facts-only analysis
  filters on `declared`.
- **Evidence everywhere** — entities *and* edges carry `anchor { file, span }`,
  so every dependency claim is auditable back to a source line.
- **Containment ≠ attachment** — where code is *written* (`TChildOf` /
  `TWithChildren`) and what it semantically *belongs to* (`TAttachedTo`, e.g. a
  Go receiver) are distinct relations, both kept.
- **Stub discipline** — types outside the corpus become degraded `isStub` nodes,
  decided by a whitelist of corpus-declared ids, never by name prefix.

## Layout

| Path | Contents |
|---|---|
| `packages/core` | `@codegraph/core` — traits, edges, language profiles, Zod validation, JSON Schema export |
| `packages/analyzer` | `@codegraph/analyzer` — graph construction, derived indexes, queries, metrics |
| `packages/cli` | `@codegraph/cli` — the `codegraph` command |
| `packages/viz` | *(future)* Three.js code city — the only package allowed to depend on `three` |
| `extractors/java` | Maven/Spoon extractor (noClasspath), emits `model.json` |
| `schemas/` | Generated JSON Schema — the committed cross-language contract |
| `fixtures/` | Reference corpora + expected `model.json` snapshots |

## Getting started

Requires **Node ≥ 22** and **pnpm** (`corepack enable pnpm`).

```bash
pnpm install
pnpm -r build          # build all TypeScript packages
pnpm -r test           # unit + property tests
pnpm run ci            # build + typecheck + test, what CI runs
pnpm run gen:schemas   # regenerate schemas/*.schema.json (commit the result)
```

Java extractor:

```bash
cd extractors/java && mvn package
java -jar target/codegraph-java.jar --src <dir> --out model.json
```

Analysis:

```bash
pnpm --filter @codegraph/cli exec codegraph analyze model.json --report deps
```

## Status

| # | Milestone | State |
|---|---|---|
| M0 | Bootstrap — workspace builds, CI green | ✅ |
| M1 | Core metamodel — traits, 9 profiles, validation, JSON Schema | ✅ |
| M2 | Java extractor — fixture corpus → schema- and profile-valid `model.json` | ✅ |
| M3 | Analyzer — import graph, type deps, cycles, coupling, exports | ✅ |
| M4 | CLI + property suite end-to-end on a real Java repo | ⬜ |
| M5 | 2nd language — clj-kondo adapter, cross-language import graph | ⬜ |

The M2 output over the reference corpus is committed as
[`fixtures/java/expected/model.json`](fixtures/java/expected/model.json) — 166
entities (26 stubs) and 173 edges, pretty-printed and sorted so that any change
to what the extractor claims about known code shows up as a reviewable diff.

M3 runs that snapshot through the whole pipeline in the test suite, and was
verified against two real corpora extracted with the M2 extractor: google/gson
(3 624 entities / 8 834 edges) and apache/commons-lang (15 338 / 24 631). On
commons-lang the analyzer stages take ~190 ms end to end and the most
depended-upon types come out as `StringUtils` (Ca 39), `ArrayUtils` (33),
`ToStringStyle` and `ObjectUtils` (19) — which is the answer a human would give.

Every number the analyzer reports carries the **fold level** and the **view** it
was computed under. `internalOnly` drops stubs, `declaredOnly` drops inferences;
neither is the "true" answer, and a coupling number without its view is not a
fact. Renderings keep the distinction visible: in DOT a solid edge is a declared
fact and a dashed one contains an inference, and stub nodes are dashed and grey.

## Documentation

- [`PLAN.md`](PLAN.md) — implementation plan, phases, milestones, locked decisions
- [`METAMODEL.md`](METAMODEL.md) — conceptual reference: every concept, its attributes and relations
- [`CLAUDE.md`](CLAUDE.md) — architecture boundaries and metamodel invariants
