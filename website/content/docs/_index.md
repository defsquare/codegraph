---
title: Documentation
type: docs
description: "See the structure of a codebase you did not write — even one that no longer compiles."
---

Codegraph extracts a dependency model from sources alone, with no build, and lets you query it, walk it as a 3D city, browse every dependency to its source line, replay its history, and have it explained bottom-up. The [landing page](/) says why; these pages say how.

New to a codebase and wondering where to start? [Discovering a codebase](/docs/discover/) is a guided walk in six questions, from what is there to what it means, with the commands that answer each one today.

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
git clone https://github.com/defsquare/codegraph.git && cd codegraph
pnpm install && pnpm -r build
(cd extractors/java && ./mvnw -B package)

java -jar extractors/java/target/codegraph-java.jar --src ~/src/gson/gson/src/main/java --out gson.jsonl
./bin/codegraph validate gson.jsonl
./bin/codegraph serve gson.jsonl --host 127.0.0.1            # http://localhost:4177
```

The [first tutorial](/docs/tutorials/first-city/) walks through every step.

## Limitations, up front

- **Three languages today: Java, C# and TypeScript.** Nine language profiles exist on paper; the shipped extractors are [Spoon for Java](/docs/reference/java-extractor/) (needs a JDK 17+), [Roslyn for C#](/docs/reference/csharp-extractor/) (needs the .NET 10 SDK to build; the binary it produces needs nothing) and [the compiler API for TypeScript](/docs/reference/typescript-extractor/) (Node 22, nothing else). A Clojure adapter is next.
- **No build means imperfect resolution.** Without a classpath some references stay unresolved; they become stubs, honest but still gaps. Keep one package to one source root per run.
- **`explain` costs money and needs a network.** It is the only command that does; `--dry-run` and `--estimate` come first.
- **Not a linter.** Codegraph reports structure, coupling and cycles, not style or bugs.
- **Runs from a clone.** No npm package or binary release yet.

Source: [github.com/defsquare/codegraph](https://github.com/defsquare/codegraph). License: [MIT](https://github.com/defsquare/codegraph/blob/main/LICENSE).
