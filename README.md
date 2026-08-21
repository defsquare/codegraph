# Codegraph

Extract dependencies between code entities — classes, functions, modules — from
multi-language corpora, **including non-compilable legacy code**, into a
trait-based metamodel, and analyze the result: dependency graphs, coupling,
cycles, architecture, and eventually a 3D "code city".

```
┌──────────────────┐    ┌───────────────────┐    ┌──────────────────────┐
│ Extractors       │    │ JSON interchange  │    │ TypeScript analyzer  │
│ (native tooling) │ ─▶ │ model.jsonl       │ ─▶ │ validate → graph →   │
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
| `extractors/java` | Maven/Spoon extractor (noClasspath), emits `model.jsonl` |
| `schemas/` | Generated JSON Schema — the committed cross-language contract |
| `fixtures/` | Reference corpora + expected `model.jsonl` snapshots |

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
cd extractors/java && ./mvnw -B package   # the wrapper; no local Maven needed
java -jar target/codegraph-java.jar --src <dir> --out model.jsonl
```

Analysis — the `codegraph` CLI. Every command takes one or more `model.jsonl`
paths and loads them as a single union, so multi-language analysis is just a
longer argument list:

```bash
codegraph validate model.jsonl [--json]

codegraph analyze  model.jsonl --report deps|cycles|coupling
                   [--level module|type] [--internal-only] [--declared-only]
                   [--json] [--top N]

codegraph export   model.jsonl --format dot|json|csv|plantuml
                   [--level module|type] [--internal-only] [--declared-only]
                   [--out FILE]

codegraph profiles [--lang java] [--json]
```

After `pnpm -r build`, run it from the clone as `./bin/codegraph …` — an
executable that finds its own `dist/`, so it works from a worktree and from a
symlink on your `PATH`:

```bash
ln -s "$PWD/bin/codegraph" ~/.local/bin/codegraph
```

`pnpm --filter @codegraph/cli exec codegraph …` works too.

```bash
# is this extractor output conformant?
codegraph validate model.jsonl

# which packages are most coupled?
codegraph analyze model.jsonl --report coupling --top 20

# a picture, and nothing but the picture, in graph.dot
codegraph export model.jsonl --format dot > graph.dot

# the package dependencies, as a PlantUML package diagram
codegraph export model.jsonl --format plantuml --level module > modules.puml
```

### PlantUML: the element follows the fold level

`--format plantuml` renders **what the node is**, because the node's nature
differs by level:

| `--level` | Element | Why |
|---|---|---|
| `module` | `package` | every node carries `TModule` — it *is* a package |
| `type` | `class` | every node carries `TType` |

So a module-level diagram contains **no `class` statement at all**: its boxes
are PlantUML packages, and they are exactly the modules the fold selected —
walking `TChildOf` to the nearest `TModule` ancestor, never splitting a name or
an id (invariant 7).

```plantuml
title codegraph — module-level dependencies, view all
package "com.acme.order" as java_com_acme_order {
}
package "java.util" as java_java_util <<stub>> #line.dashed {
}
java_com_acme_order --> java_java_util : 15
java_com_acme_order ..> java_com_megacorp_ledger : 6
```

Every channel is a documented fact and nothing else: a solid `-->` means all
aggregated base edges are `declared`, a dashed `..>` means at least one is an
inference, the label is how many base edges were folded, `<<stub>>` plus a
dashed outline is an entity the corpus does not declare, and the title carries
the level and the view — an analysis picture without its view is not a fact. A
stereotype that would only repeat the element (`package "x" <<package>>`) is
dropped, and the legend describes only the encodings the diagram actually drew.

**stdout is the artifact; stderr is everything human.** Warnings, fold
diagnostics and summaries never touch stdout, so a redirect always yields a
clean file. There is no ANSI colour, and identical inputs give byte-identical
output.

**Exit codes** distinguish a broken tool from a broken model — `0` success,
`1` an internal bug in codegraph, `2` a usage error, `3` findings (the tool
worked; the input did not). A CI job gating on model quality checks for `3`.

## Status

| # | Milestone | State |
|---|---|---|
| M0 | Bootstrap — workspace builds, CI green | ✅ |
| M1 | Core metamodel — traits, 9 profiles, validation, JSON Schema | ✅ |
| M2 | Java extractor — fixture corpus → schema- and profile-valid model | ✅ |
| M3 | Analyzer — import graph, type deps, cycles, coupling, exports | ✅ |
| M4 | CLI — `validate`, `analyze`, `export`, `profiles` + conformance gate | ✅ |
| M5 | Metamodel v2 — structured identity, canonical order, memoized validation | ✅ |
| M6 | JSONL interchange — streaming, surrogate references, per-record schemas | ✅ |
| M7 | SQLite analysis store — `codegraph import`, DB-backed analyzer | ⬜ |
| M8 | 2nd language — clj-kondo adapter, cross-language import graph | ⬜ |

The extractor's output over the reference corpus is committed as
[`fixtures/java/expected/model.jsonl`](fixtures/java/expected/model.jsonl) — 166
entities (26 stubs) and 173 edges, one record per line in canonical order, so
that any change to what the extractor claims about known code shows up as a
reviewable diff.

M6 replaced the single-JSON-document interchange with JSONL: identity travels as
the natural key `(module, symbol, disambiguator)` and every reference as a
file-scoped integer, so no rendered id string appears in a model file and
neither writer nor reader ever holds the whole document. apache/fineract went
from a 559.5MB `model.json` that Node could not read at all — one JSON document
is one JavaScript string, and that is past the ~512MB ceiling — to a 127.4MB
`model.jsonl` on which every command completes in about twelve seconds.

M3 runs that snapshot through the whole pipeline in the test suite, and was
verified against two real corpora extracted with the M2 extractor: google/gson
(3 624 entities / 8 834 edges) and apache/commons-lang (15 338 / 24 631). On
commons-lang the analyzer stages take ~190 ms end to end and the most
depended-upon types come out as `StringUtils` (Ca 39), `ArrayUtils` (33),
`ToStringStyle` and `ObjectUtils` (19) — which is the answer a human would give.

M4 puts that behind the CLI and adds the **conformance gate**: `checkConformance`
lives in the analyzer — so the CLI, the property suite and CI all ask the same
question — and checks closure, self-reference, provenance, the `candidates`
rule, profile validity, anchors and conflicting redeclaration. The suite stands
at **1 007 TypeScript tests** (plus 146 Java), including an end-to-end suite that
spawns the real binary and asserts on exit code, stdout and stderr separately.

Verified end to end on apache/commons-lang (15 338 entities / 24 631 edges):
`validate` returns clean in 0.7 s, and every report runs in under a second.
`analyze --report coupling` puts `org.apache.commons.lang3` first (Ca 13 / Ce 27)
ahead of `lang3.builder`, and flags `lang3.time`, `lang3.concurrent` and
`lang3.event` as maximally unstable leaf consumers — which is the answer a human
who knows the library would give. `--report cycles` finds the genuine 13-package
mutually-recursive core (`lang3` ↔ `builder` ↔ `math` ↔ `exception` …) and exits
`3`, because a dependency cycle is a finding about the architecture.

Every number the analyzer reports carries the **fold level** and the **view** it
was computed under. `internalOnly` drops stubs, `declaredOnly` drops inferences;
neither is the "true" answer, and a coupling number without its view is not a
fact. Renderings keep the distinction visible: in DOT a solid edge is a declared
fact and a dashed one contains an inference, and stub nodes are dashed and grey.

## Documentation

- [`PLAN.md`](PLAN.md) — implementation plan, phases, milestones, locked decisions
- [`METAMODEL.md`](METAMODEL.md) — conceptual reference: every concept, its attributes and relations
- [`CLAUDE.md`](CLAUDE.md) — architecture boundaries and metamodel invariants
- [`docs/city-model.md`](docs/city-model.md) — the city model's design: data
  structures, metric sources, algorithms, entry points, and what layout will consume
