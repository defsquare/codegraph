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

One Homebrew tap: the app and the command in one install, each language's
extractor in its own. No JDK, no .NET, nothing else to install.

```bash
brew install --cask defsquare/tap/codegraph                  # Codegraph.app + the `codegraph` command
brew install defsquare/tap/codegraph-java                    # the Java extractor, a native image

codegraph-java --src ~/src/gson/gson/src/main/java --out gson.jsonl
codegraph validate gson.jsonl
codegraph serve gson.jsonl --host 127.0.0.1                  # http://localhost:4177
```

The [first tutorial](/docs/tutorials/first-city/) walks through every step;
[Install](/docs/how-to/install/) has the Linux and Windows lines, the other
extractors, and the build from a clone.

## Limitations, up front

- **Four languages today: Java, C#, TypeScript and Elixir.** Nine language profiles exist on paper; the shipped extractors are [Spoon for Java](/docs/reference/java-extractor/), [Roslyn for C#](/docs/reference/csharp-extractor/), [the compiler API for TypeScript](/docs/reference/typescript-extractor/) and [the compiler's parser for Elixir](https://github.com/defsquare/codegraph/blob/main/docs/elixir-extractor.md). Each is a self-contained binary; the TypeScript one runs on Node 22. A Clojure adapter is next.
- **No build means imperfect resolution.** Without a classpath some references stay unresolved; they become stubs, honest but still gaps. Keep one package to one source root per run.
- **`explain` costs money and needs a network.** It is the only command that does; `--dry-run` and `--estimate` come first.
- **Not a linter.** Codegraph reports structure, coupling and cycles, not style or bugs.
- **Platform coverage is uneven.** macOS gets the app and every extractor from the tap; Linux gets the extractors from Homebrew and the command as a release download; Windows gets release binaries for the command, Java and C#, and `npx` for TypeScript. The Elixir extractor is built for Apple silicon and Linux x64 only.

Source: [github.com/defsquare/codegraph](https://github.com/defsquare/codegraph). License: [MIT](https://github.com/defsquare/codegraph/blob/main/LICENSE).
