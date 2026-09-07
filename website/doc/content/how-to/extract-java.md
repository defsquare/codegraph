---
title: Extract a model from a Java repository
linkTitle: Extract Java
weight: 2
---

The Java extractor runs Spoon in `noClasspath` mode: it needs sources and
nothing else — no build, no jars, no classpath. This guide covers choosing the
source root, reading the resolution summary, and the one decision a multi-module
repository forces on you.

**Before you start:** a built `codegraph-java.jar` and a JDK on `PATH`
(see [Install](/how-to/install/)).

## Extract one source root

1. Point `--src` at a source root — the directory the package hierarchy starts
   under, not the repository root.

   ```bash
   java -jar extractors/java/target/codegraph-java.jar \
     --src fixtures/java/src --out acme.jsonl
   ```

   `stdout` carries only the roots and the model path, so it is safe to capture.
   The summary goes to `stderr`:

   ```text
   RESOLUTION SUMMARY
     type references : 636
     resolved        : 601
     unresolved      : 35
     resolution rate : 94.5%
     entities        : 179 (stubs: 27)
     edges           : 188 (self-edges dropped: 0)
   ```

   Progress is a bar on a terminal and silent when piped. Use `--progress plain`
   for a CI log (one line per phase, no control characters) or `--no-progress`
   for neither.

2. Check the model before you analyse it. The same check is the conformance gate
   every extractor must pass.

   ```bash
   codegraph validate acme.jsonl
   ```

   ```text
   checked 1 model — 179 entities (27 stubs), 188 edges, lang java

   OK — every model conforms: closure, no self-reference, provenance, candidates, profile, anchors, ids.
   ```

## Read the summary

- **`resolution rate`** is the share of type references Spoon could resolve
  without a classpath. On the reference fixture it is 94.5%; the corpus is
  deliberately non-compilable, and the missing 5.5% are the three types it never
  declares plus Spoon's `<nulltype>`.
- **`stubs`** are the degraded entities standing in for everything the corpus
  does not declare — `java.lang.String` as much as an absent vendor library.
  Their edges are kept, so the picture stays honest about its gaps. Membership
  is decided by a whitelist of corpus-declared types, never by a package-name
  prefix, because `noClasspath` invents plausible fully-qualified names for
  types it cannot find.
- A falling resolution rate between two runs of the same corpus means references
  stopped resolving — usually a source root that moved.

To see the model without stubs, pass `--internal-only` to any analysis command;
see [Get a facts-only answer](/how-to/facts-only-view/).

## Decide how to handle a multi-module repository

`--src` is repeatable, and a repository whose modules share packages needs it to
be. The choice matters, so make it deliberately.

**If the modules reference each other, then extract them in one run.** Spoon
resolves across every root it was given:

```bash
java -jar codegraph-java.jar --src modA --src modB --out both.jsonl
```

```text
  resolution rate : 100.0%
  entities        : 11 (stubs: 2)
```

The cross-module dependency comes out as a **declared** fact
(`java:com.b -> java:com.a`).

**If you extract each module separately, then expect stubs and conflicts.** Each
run only knows its own root, so the other module's types become stubs in it. The
union still loads — every analysis command takes several models — but the same
type is a class in one file and a stub in the other:

```bash
codegraph validate modA.jsonl modB.jsonl
```

```text
  error   duplicate-id/duplicate-id-conflict  …
          id "java:com.a/A" is declared 2 times and the declarations disagree on kind or traits
```

and the dependency degrades from `->` (declared) to `~>` (derived).

Separate models are the right answer only when the modules genuinely do not
share packages — a Java service and a Kotlin one, or two products in one
monorepo.

{{< callout type="warning" >}}
Do not point one run at both `src/main/java` and `src/test/java` of the same
module. The same package under two roots is what confuses `noClasspath`
resolution; extract main, and extract test as its own model if you need it.
{{< /callout >}}

## Record where the sources came from

If you want the city and the navigator to link back to a hosted repository, hand
the extractor the facts — it runs no git itself:

```bash
java -jar codegraph-java.jar --src src/main/java --out gson.jsonl \
  --repo-remote https://github.com/google/gson \
  --repo-commit b3f4ca2 --repo-root gson/src/main/java
```

`codegraph snapshots` supplies these per frame on its own.

## Related

- [Compare two models of one corpus](/how-to/compare-snapshots/)
- [Gate a CI pipeline on model quality](/how-to/ci-gate/)
- [Java extractor reference](/reference/java-extractor/)
- [Why extraction needs no build](/explanation/extracting-without-compiling/)
