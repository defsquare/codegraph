# Codegraph

**See the structure of a codebase you did not write — even one that no longer
compiles.**

Codegraph turns source code into a dependency model you can query, draw as a
3D city, browse dependency by dependency, replay through its git history, and
have a language model explain bottom-up. It does this without building the
code: the Java extractor runs on sources alone, no classpath, no jars, so it
works on the legacy that nobody can compile any more.

Four questions, four commands:

| Question | Command | What you get |
|---|---|---|
| What does this codebase look like? | `codegraph city --serve` | a 3D city: packages are districts, classes are buildings sized by real metrics, dependencies are arcs |
| What exactly depends on what? | `codegraph navigator --serve` | a browsable tree with every incoming and outgoing dependency, the member that carries it, and the source line that proves it |
| How did it get this way? | `codegraph scm` / `replay` | churn, hotspots, ownership, co-change, and a city whose timeline scrubs the years |
| What does it mean? | `codegraph explain` | one plain-language explanation per method, class and package, written leaves-first so every summary rests on already-explained parts |

Plus the plumbing you need to trust the answers: `validate` for the model,
`analyze` for coupling and cycles, `export` for DOT, CSV, JSON and PlantUML.

## Quick start

You need **Node 22+**, **pnpm** (`corepack enable pnpm`) and a **JDK 17+** on
`PATH`. Codegraph is not on npm yet; you run it from a clone.

```bash
git clone https://gitlab.com/jgrodziski/codegraph.git && cd codegraph
pnpm install && pnpm -r build
(cd extractors/java && ./mvnw -B package)        # the wrapper; no local Maven needed
ln -s "$PWD/bin/codegraph" ~/.local/bin/codegraph   # optional, works from a symlink
```

Now point it at some Java. Any tree of `.java` files works; it does not have
to build.

```bash
# 1. extract: sources in, one model file out (no compilation)
java -jar extractors/java/target/codegraph-java.jar --src ~/src/gson/gson/src/main/java --out gson.jsonl

# 2. is the model sound?
codegraph validate gson.jsonl

# 3. look at it
codegraph city gson.jsonl --serve --host 127.0.0.1        # http://localhost:4177
codegraph navigator gson.jsonl --serve --host 127.0.0.1   # http://localhost:4178
```

On google/gson (about 3,600 entities) extraction takes seconds and every
report runs well under a second. On apache/fineract (a 127 MB model) each
command completes in about twelve seconds.

`--host 127.0.0.1` keeps the pages on your machine. Without it the servers
bind every interface, which is convenient on a LAN and wrong for a sensitive
codebase.

For C#, the extractor is a self-contained binary — nothing to install on the
machine that runs it. Building it needs the .NET 10 SDK:

```bash
./build.sh --csharp                                       # → extractors/csharp/dist/<rid>/codegraph-csharp
extractors/csharp/dist/linux-x64/codegraph-csharp --src ~/src/eShop/src --out eshop.jsonl
```

Both extractors take the same flags and exit codes (`schemas/README.md` §8),
so every command below works on either model.

## Usage

### Ask the analyzer

```bash
codegraph analyze gson.jsonl --report coupling --top 20      # most depended-upon packages
codegraph analyze gson.jsonl --report cycles                  # tangles + the cheapest edges to cut; exit 3 if any
codegraph analyze gson.jsonl --report deps --level type       # class-level dependency list
codegraph export  gson.jsonl --format plantuml --level module > modules.puml
codegraph export  gson.jsonl --format dot > graph.dot
```

Two switches change every answer, and every answer says which were on:
`--internal-only` drops everything outside the corpus, `--declared-only`
drops every inference and keeps only what the source literally says.

### Build the city you want

Height and footprint are metrics you choose. The defaults are lines of code
and member count; the extractor also emits cyclomatic complexity:

```bash
codegraph city gson.jsonl --serve --height sum:cyclomatic --footprint loc
codegraph city petclinic.jsonl --serve --framework spring     # color by Spring role
```

Arcs appear when you select something: orange for fan-in, blue for fan-out,
desaturated when the dependency is an inference rather than a declared fact,
and red for the edges whose cut would break a cycle. Hover a building for
its raw numbers. Unmeasured metrics are drawn at the minimum and labelled as
unmeasured rather than faked.

### Mine the history

```bash
codegraph scm ~/src/gson --out gson-history.jsonl
codegraph history gson-history.jsonl --report hotspots --top 20
codegraph history gson-history.jsonl --report hidden --model gson.jsonl
#   ^ files that change together though no declared dependency links them
codegraph history gson-history.jsonl --report deadweight --model gson.jsonl
#   ^ declared dependencies that history never exercised together
```

To watch the structure evolve, sample the repository at its tags into a
temporal store and replay it:

```bash
codegraph snapshots ~/src/gson --extractor extractors/java/target/codegraph-java.jar --tags --src gson/src/main/java --store gson.db
codegraph timeline java:com.google.gson/Gson --store gson.db
codegraph replay --store gson.db --history gson-history.jsonl --serve
```

`snapshots` is resumable; rerunning it skips the revisions already held.

### Let a model explain it

```bash
codegraph explain gson.jsonl --src ~/src/gson/gson/src/main/java --dry-run   # the plan, no call
codegraph explain gson.jsonl --src ... --estimate --price-in 0.10 --price-out 0.60   # tokens and cost, no call
OPENROUTER_API_KEY=… codegraph explain gson.jsonl --src ... --max-calls 50
```

Explanations go to `gson.insights.jsonl` beside the model and never into it.
Re-running redoes only the units whose inputs changed. On the reference
fixture a full run was 68 calls and about six cents. Cloudflare AI Gateway is
the other supported provider.

### Feed it to something else

`codegraph export --format json|csv` gives you the folded graph;
`codegraph import gson.jsonl` gives you `gson.db`, a SQLite file you can query
directly (see the [SQL cookbook](docs/sql-cookbook.md));
`codegraph domain-facts` gives one pre-joined dossier per class for
domain-model extraction. Every artifact is deterministic, so it diffs cleanly
in a repository or a CI job.

The complete option list for every command is in
[`docs/cli.md`](docs/cli.md) and in `codegraph <command> --help`.

## Why codegraph

Plenty of tools draw dependency graphs. Codegraph exists because most of them
demand a build, and because the ones that don't tend to guess quietly. Its
design bets are:

- **Facts and inferences never mix.** Every edge carries a provenance:
  `declared`, `derived`, `dynamic-candidate` or `generated`. A dependency
  the extractor resolved from the source is a different thing from one it
  inferred from a framework annotation, and every report, picture and
  export keeps the two visibly apart. You can always ask for facts only.
- **Every claim points at a line.** Entities and edges carry a source anchor.
  If the navigator says class A depends on class B through method `m`, it
  shows you the file and span where that happens.
- **Legacy is the target, not the exception.** The Java extractor runs Spoon
  without a classpath. What cannot be resolved becomes an explicit stub whose
  edges are kept, and stubs are decided by a whitelist of what the corpus
  declares, never by guessing from a package name.
- **One model, many languages.** Extractors emit a versioned line-based JSON
  file against a published JSON Schema and know nothing about the metamodel.
  Everything clever, from validation to metrics to the city, lives once, in
  TypeScript, so adding a language is writing a producer for one contract.
  Entities are trait compositions rather than a class hierarchy, which is what
  lets a Clojure function var, a Go method with a receiver, and a Java class
  live in one graph.
- **Pictures mean something.** In the city every visual channel maps to a
  documented metric and colour is never decorative. The renderer draws the
  model and nothing the model does not contain.
- **Time is part of the structure.** History mining, temporal snapshots and
  replay are built in, because who changed what together is a dependency the
  source cannot show you.
- **Boring outputs on purpose.** stdout is the artifact and stderr is for
  humans; no colour codes; byte-identical output for identical input; exit
  codes that separate a bug in codegraph from a finding about your code.

## Limitations

Read these before you commit an afternoon.

- **Java only, today.** The metamodel and the language profiles cover nine
  languages on paper, but the only shipped extractor is Java (JVM sources).
  A second language is the next milestone; a Clojure adapter is designed.
- **No build means imperfect resolution.** Without a classpath Spoon cannot
  resolve every reference; on the reference corpus resolution is around
  94%, and the rest are stubs. A stub is honest, but it is still a gap.
- **Keep one package to one source root per run.** `--src` is repeatable,
  but the same package declared under several roots at once (main and test
  sources, or one package split across modules) confuses noClasspath
  resolution; pass such roots in separate runs.
- **`explain` costs money and needs a network.** It is the only command that
  does. `--dry-run` and `--estimate` tell you what it would do first, and
  `--max-calls` caps it.
- **Not a linter.** Codegraph reports structure, coupling and cycles; it does
  not judge style or find bugs.
- **Runs from a clone.** There is no npm package or binary release yet.
- **Big models want memory.** A 100 MB model loads in the navigator in about
  a second, but the extractor and the analyzer are single-process Node and
  JVM tools; a monorepo of millions of lines is untested.

## How it works

```
   sources ──▶  extractor  ──▶  model.jsonl  ──▶  analyzer  ──▶  reports, exports
  (any state)  (Java/Spoon)   (the contract)      (TypeScript)      city.json ──▶ 3D city
                                   │                                navigator.json ──▶ navigator
                              schemas/*.json                        model.db ──▶ SQL, time
                            (published JSON Schema)                 *.insights.jsonl ──▶ explanations
```

The model is a graph of entities and edges. An entity is `{id, kind, traits}`
plus the attributes its traits contribute; an edge is `{from, to, kind,
provenance, anchor}`. Identity is a structured natural key
(`lang, module, symbol, disambiguator`), never a parsed string. Inverse
indexes (who calls me, who imports me) are derived in memory and never stored,
so a model file has one direction of truth. The full reference is
[`METAMODEL.md`](METAMODEL.md).

| Package | Role |
|---|---|
| `extractors/java` | Spoon-based extractor; emits `model.jsonl` |
| `extractors/csharp` | Roslyn-based extractor (no MSBuild, BCL embedded); one self-contained binary per OS |
| `schemas/` | the generated JSON Schema every extractor must satisfy |
| `packages/core` | traits, edges, language profiles, validation |
| `packages/analyzer` | graph, views, folding, cycles, coupling, exports, SQLite store |
| `packages/scm` | git history miner |
| `packages/city`, `packages/viz` | city model, Three.js renderer |
| `packages/navigator`, `packages/navigator-ui` | navigator model, React browser |
| `packages/insights`, `packages/llm` | the explanation walk, the provider clients |
| `packages/cli` | the `codegraph` command |

## Documentation

- [`docs/cli.md`](docs/cli.md) — every command and option
- [`METAMODEL.md`](METAMODEL.md) — every concept, attribute and relation in the model
- [`docs/analyzer.md`](docs/analyzer.md) — the analysis pipeline, its algorithms and costs
- [`docs/model-encoding.md`](docs/model-encoding.md) — the JSONL interchange and the SQLite store
- [`docs/sql-cookbook.md`](docs/sql-cookbook.md) — querying `model.db` yourself
- [`docs/city-model.md`](docs/city-model.md), [`docs/city-render.md`](docs/city-render.md) — how the city is built and drawn
- [`docs/csharp-extractor.md`](docs/csharp-extractor.md) — running the C# extractor: the self-contained binary, the .NET runtime alone, or the SDK from source
- [`docs/navigator.md`](docs/navigator.md) — the navigator's design
- [`docs/insights.md`](docs/insights.md) — the explanation walk's design
- [`PLAN.md`](PLAN.md) — milestones, decisions and their rationale
- [`CLAUDE.md`](CLAUDE.md) — architecture boundaries and the metamodel invariants

## Status

Codegraph is pre-1.0 and is developed against real corpora
(google/gson, apache/commons-lang, apache/fineract, spring-petclinic). The
interchange format is versioned and the Java extractor's output over the
reference corpus is committed as a fixture, so any change in what it claims
about known code shows up as a diff.

| Milestone | State |
|---|---|
| Core metamodel, language profiles, JSON Schema | done |
| Java extractor (Spoon, no classpath) | done |
| Analyzer: dependencies, cycles, coupling, exports | done |
| CLI with conformance gate and property suite | done |
| JSONL interchange, SQLite analysis store | done |
| Git history mining, temporal store, city replay | done |
| 3D code city and the model navigator | done |
| Measures, literal values, Spring framework semantics | done |
| LLM explanations (`explain`) | done |
| Second language extractor (C#, Roslyn): one self-contained binary per OS, byte-identity smoke tests in CI on five platforms, audited on Humanizer, dotnet/eShop and OrchardCore | done |
| Clojure extractor (clj-kondo) | next |
| Published releases (npm, extractor jar) | planned |
| Project website and documentation site | planned, see [`WEBSITE.md`](WEBSITE.md) |

## Contributing

Bug fixes start with a failing test. The property suite, which checks graph
closure, provenance, determinism and profile validity over every extractor
output, is the acceptance gate for any new extractor. `pnpm run ci` runs what
the pipeline runs. Commits follow Conventional Commits with a package scope
(`feat(analyzer): …`). The architecture boundaries in
[`CLAUDE.md`](CLAUDE.md) are not negotiable; the open questions at the end of
each design doc are.

## Prior art and credits

- **Moose / FamixNG** (Pharo) — the trait-based metamodel is FamixNG's idea,
  reimplemented as data in TypeScript.
- **Spoon** (INRIA) — the Java source model that makes classpath-free
  extraction possible.
- **CodeCity** (Wettel & Lanza) — the city metaphor; codegraph adds
  provenance-aware arcs and time.
- **Structure101** — the tangle and feedback-set reports follow its
  "offending dependencies" idea.
- **Gource** and Adam Tornhill's *Your Code as a Crime Scene* — the history
  replay and the hotspot, ownership and co-change analyses.
- **Specy** — the domain vocabulary the explanations are written in.

## License

Not yet chosen. Until a `LICENSE` file lands in this repository, the code is
all rights reserved; open an issue if you need to use it before then.
