---
title: Documentation
type: docs
description: "See the structure of a codebase you did not write — even one that no longer compiles."
---

Codegraph extracts a dependency model from sources alone, with no build, and lets you query it, walk it as a 3D city, browse every dependency to its source line, replay its history, and have it explained bottom-up. The [landing page](/) says why; these pages say how.

The documentation is in four parts, each for a different moment:

{{< cards >}}
  {{< card link="tutorials" title="Tutorials" icon="academic-cap" subtitle="Learn by doing: your first city, reading it, the navigator, history replay, explanations, SQL." >}}
  {{< card link="how-to" title="How-to guides" icon="clipboard-check" subtitle="Solve one problem: CI gates, facts-only views, complexity cities, Spring roles, temporal stores, extractor authoring." >}}
  {{< card link="reference" title="Reference" icon="book-open" subtitle="Look it up: every command and option, the interchange format, the metamodel, artifacts, the SQLite store." >}}
  {{< card link="explanation" title="Explanation" icon="light-bulb" subtitle="Understand why: traits, provenance, extraction without compiling, identity, the city as a model, prior art." >}}
{{< /cards >}}

## Sixty-second start

Node 22+, pnpm and a JDK 17+ on `PATH`. Codegraph runs from a clone today.

```bash
git clone https://gitlab.com/jgrodziski/codegraph.git && cd codegraph
pnpm install && pnpm -r build
(cd extractors/java && ./mvnw -B package)

java -jar extractors/java/target/codegraph-java.jar --src ~/src/gson/gson/src/main/java --out gson.jsonl
./bin/codegraph validate gson.jsonl
./bin/codegraph city gson.jsonl --serve --host 127.0.0.1     # http://localhost:4177
```

The [first tutorial](/docs/tutorials/first-city/) walks through every step.

## Limitations, up front

- **Two languages today: Java and C#.** Nine language profiles exist on paper; the shipped extractors are Spoon for Java (needs a JDK 17+) and Roslyn for C# (needs the .NET 10 SDK to build; the binary it produces needs nothing). A Clojure adapter is next.
- **No build means imperfect resolution.** Without a classpath some references stay unresolved; they become stubs, honest but still gaps. Keep one package to one source root per run.
- **`explain` costs money and needs a network.** It is the only command that does; `--dry-run` and `--estimate` come first.
- **Not a linter.** Codegraph reports structure, coupling and cycles, not style or bugs.
- **Runs from a clone.** No npm package or binary release yet.

Source: [gitlab.com/jgrodziski/codegraph](https://gitlab.com/jgrodziski/codegraph). License: not yet chosen; until a `LICENSE` file lands, all rights reserved.
