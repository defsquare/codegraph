---
title: Install codegraph from a clone
linkTitle: Install
weight: 1
---

Codegraph is not published to npm yet, so you install it by building the
workspace and putting one script on your `PATH`. The Java extractor is a
separate build and you only need it if you are going to extract Java sources
yourself.

**Before you start:** Node 22 or newer, `git`, and pnpm (`corepack enable pnpm`).
A JDK 17+ is needed only for step 5.

## Install the CLI

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

3. Verify.

   ```bash
   codegraph --version      # 0.1.0
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

If you got `codegraph: packages/cli/dist/index.js is missing`, the build did not
run or did not finish; re-run `pnpm install && pnpm -r build` in the checkout the
symlink points into.

If all you need is to analyse a `model.jsonl` somebody else produced, stop here.
Everything except `explain` runs offline, and nothing below is required.

## Build the Java extractor

4. Set a JDK on `PATH`. Non-interactive shells do not source sdkman, so export
   it explicitly if that is how your JDK is installed:

   ```bash
   export JAVA_HOME="$HOME/.sdkman/candidates/java/25.0.4-tem"
   export PATH="$JAVA_HOME/bin:$PATH"
   ```

5. Build the jar with the Maven wrapper. There is no local Maven to install —
   `mvn` is not expected to exist.

   ```bash
   cd extractors/java && ./mvnw -B package
   ```

6. Verify the jar answers.

   ```bash
   java -jar extractors/java/target/codegraph-java.jar --help
   ```

   ```text
   codegraph-java 0.2.0 — Spoon-based Java extractor
   ```

{{< callout type="warning" >}}
There is no release channel yet: no npm package, no downloadable jar. Everything
here is the clone route, and a checkout you built is the only supported install.
{{< /callout >}}

## Using it at work

The code is [MIT-licensed](https://github.com/defsquare/codegraph/blob/main/LICENSE):
use it, modify it and ship it in a shared build, keeping the copyright and
permission notice with any copy.

## Related

- [Extract a model from a Java repository](/docs/how-to/extract-java/)
- [Your first code city](/docs/tutorials/first-city/)
- [CLI reference](/docs/reference/cli/)
- [Java extractor reference](/docs/reference/java-extractor/)
