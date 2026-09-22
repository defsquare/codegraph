---
title: Install codegraph
linkTitle: Install
weight: 1
---

Codegraph is distributed from one Homebrew tap,
[defsquare/homebrew-tap](https://github.com/defsquare/homebrew-tap). The app
and the `codegraph` command are one install; every language extractor is its
own, so a user of one language never downloads the runtimes of the others.
Each install is a prebuilt binary that needs nothing else on the machine: no
JDK for Java, no .NET for C#, no Erlang for Elixir. The TypeScript extractor
is the one exception, an npm package that runs on Node 22.

**Before you start:** Homebrew, on macOS or Linux. Without it, every binary is
also a direct download; see [Without Homebrew](#without-homebrew).

## macOS

1. Install the app and the command.

   ```bash
   brew install --cask defsquare/tap/codegraph
   ```

   This puts `Codegraph.app` (signed and notarized, Apple silicon and Intel)
   in `/Applications` and the single-executable `codegraph` it carries on
   your `PATH`. If Homebrew answers *Refusing to load formula … from
   untrusted tap*, run `brew trust defsquare/tap` once and retry.

2. Install the extractor of each language you will extract.

   ```bash
   brew install defsquare/tap/codegraph-java         # a native image; no JDK needed
   brew install defsquare/tap/codegraph-csharp       # runtime and base class library inside; no .NET needed
   brew install defsquare/tap/codegraph-typescript   # the npm package, on Homebrew's node
   brew install defsquare/tap/codegraph-elixir       # Erlang and Elixir inside; Apple silicon only
   ```

3. Verify.

   ```bash
   codegraph --version      # 0.1.0
   codegraph-java --version
   codegraph profiles       # the nine language profiles core ships
   ```

   ```text
   lang    kinds  notes  edge kinds
   clj        10     13  import, interfaceImplementation, invocation, access, reference
   csharp     14      7  import, inheritance, interfaceImplementation, invocation, access, reference
   go         10      9  import, interfaceImplementation, invocation, access, reference, embedding
   java       12     15  import, inheritance, interfaceImplementation, invocation, access, reference, annotationUse, throws
   js          8     13  import, inheritance, invocation, access, reference
   php        12     10  import, inheritance, interfaceImplementation, invocation, access, reference, traitUsage, fileInclude
   python      9     10  import, inheritance, interfaceImplementation, invocation, access, reference
   rust       13     12  import, interfaceImplementation, invocation, access, reference
   ts         13     14  import, inheritance, interfaceImplementation, invocation, access, reference
   9 profiles. Run 'codegraph profiles --lang <lang>' for one language's full spec.
   ```

`brew upgrade` updates all of it. The app finds the extractors that are
installed; a folder whose language has none is answered with the install line
that fixes it.

If all you need is to analyse a `model.jsonl` somebody else produced, the cask
alone is enough. Everything except `explain` runs offline.

## Linux

Homebrew on Linux installs the extractors with the same lines (the Elixir one
on x64 only). There is no cask, so the `codegraph` command is a download: the
`codegraph-linux-x64` or `codegraph-linux-arm64` asset of the latest release.

```bash
brew install defsquare/tap/codegraph-java
curl -L -o ~/.local/bin/codegraph \
  https://github.com/defsquare/codegraph/releases/latest/download/codegraph-linux-x64
chmod +x ~/.local/bin/codegraph
codegraph --version      # 0.1.0
```

## Windows

The release carries `codegraph-win-x64.exe`, `codegraph-java-win-x64.exe` and
`codegraph-csharp-win-x64.exe`; put them on `PATH` under whatever names you
like. The TypeScript extractor is `npx codegraph-typescript` on Node 22. There
is no Elixir extractor for Windows.

## Without Homebrew

Every binary is an asset of the
[GitHub release](https://github.com/defsquare/codegraph/releases/latest), with
`SHA256SUMS` beside them:

| Asset | What it is |
|---|---|
| `codegraph-<platform>` | the command: CLI, daemon and both frontends in one Node single-executable |
| `codegraph-java-<platform>` | the Java extractor, a GraalVM native image |
| `codegraph-csharp-<platform>` | the C# extractor, a .NET single-file binary |
| `codegraph-elixir-<platform>` | the Elixir extractor (`osx-arm64`, `linux-x64`) |
| `Codegraph-<version>-<platform>.dmg` | the macOS app (`osx-arm64`, `osx-x64`) |

`<platform>` is one of `linux-x64`, `linux-arm64`, `osx-x64`, `osx-arm64`,
`win-x64`; Windows assets end in `.exe`. The TypeScript extractor is
`npx codegraph-typescript`, or `npm install -g codegraph-typescript`.

A binary a browser downloaded on macOS carries the quarantine attribute:
`xattr -d com.apple.quarantine <file>` once. Homebrew fetches with `curl`,
which sets none.

## From a clone

To work on codegraph itself. **Before you start:** Node 22 or newer, `git`,
and pnpm (`corepack enable pnpm`); then the toolchain of each extractor you
build: a JDK 17+ for Java, the .NET 10 SDK for C#, Erlang/OTP 27 and Elixir
for Elixir.

1. Clone the repository and build every package.

   ```bash
   git clone https://github.com/defsquare/codegraph.git && cd codegraph
   pnpm install && pnpm -r build
   ```

2. Put the command on your `PATH`. `bin/codegraph` resolves the built CLI
   relative to itself, so a symlink from anywhere works and a second checkout
   never reaches the first one's `dist/`.

   ```bash
   ln -s "$PWD/bin/codegraph" ~/.local/bin/codegraph
   ```

   If you get `codegraph: packages/cli/dist/index.js is missing`, the build
   did not run or did not finish; re-run `pnpm install && pnpm -r build` in
   the checkout the symlink points into.

3. Build the extractors you need. The Java one needs a JDK on `PATH`;
   non-interactive shells do not source sdkman, so export it explicitly if
   that is how your JDK is installed.

   ```bash
   export JAVA_HOME="$HOME/.sdkman/candidates/java/25.0.4-tem"
   export PATH="$JAVA_HOME/bin:$PATH"
   (cd extractors/java && ./mvnw -B package)    # → extractors/java/target/codegraph-java.jar; `mvn` is not needed
   ./build.sh --csharp                          # → extractors/csharp/dist/<rid>/codegraph-csharp
   ./build.sh --elixir                          # → bin/codegraph-elixir
   ```

   `bin/codegraph-typescript` is already built by step 1. The jar runs as
   `java -jar extractors/java/target/codegraph-java.jar`; every page of this
   documentation writes `codegraph-java`, and the two take the same flags.

## Using it at work

The code is [MIT-licensed](https://github.com/defsquare/codegraph/blob/main/LICENSE):
use it, modify it and ship it in a shared build, keeping the copyright and
permission notice with any copy.

## Related

- [Extract a model from a Java repository](/docs/how-to/extract-java/)
- [Your first code city](/docs/tutorials/first-city/)
- [CLI reference](/docs/reference/cli/)
- [Java extractor reference](/docs/reference/java-extractor/)
