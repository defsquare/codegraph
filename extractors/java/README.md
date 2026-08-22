# codegraph-java — Spoon extractor

Reads a Java corpus (including legacy that does not compile) and emits a
`model.json` conforming to [`schemas/model.schema.json`](../../schemas/model.schema.json).

That schema is the **whole contract**. This extractor holds no metamodel
intelligence: it knows the Java id scheme, the trait composition per construct
(PLAN.md §5.1), and how to serialize. Traits, profiles and validation live once,
in `@codegraph/core`.

## Build

```bash
export JAVA_HOME="$HOME/.sdkman/candidates/java/25.0.4-tem"
export PATH="$JAVA_HOME/bin:$PATH"
cd extractors/java && ./mvnw -B package
```

**The `JAVA_HOME` export is not optional** and it is the thing that will bite
you first: non-interactive shells here have no `javac` on `PATH`, and `mvn` is
not installed at all — Maven comes from the committed wrapper (`./mvnw`). The
build targets release 17; JDK 25 and 21 are both installed and both work.

Output: `target/codegraph-java.jar` (shaded, main class
`dev.codegraph.spoon.Main`).

Tests: `./mvnw -B test`. They include a schema-validation pass — a representative
model is serialized and checked against `schemas/model.schema.json` with
`com.networknt:json-schema-validator`, i.e. against the same published contract a
Go or .NET extractor would use.

## Run

```bash
java -jar target/codegraph-java.jar --src src/main/java --out model.jsonl

# both options default: extract the current directory into <current-dir>-codegraph.jsonl
java -jar target/codegraph-java.jar
```

| Option | Meaning |
|---|---|
| `--src <dir>` | source root to analyze. Repeatable; defaults to the current directory. With several roots, anchors are relativized against their deepest common ancestor, which becomes the model's `root`. |
| `--out <file>` | where to write the model. Defaults to `<current-dir>-codegraph.jsonl`, i.e. next to the corpus and named after it. |
| `--progress <mode>` | `auto` (default), `plain` or `none` — see below |
| `--no-progress` | same as `--progress none` |
| `--help` | usage |

Exit codes: `0` success, `1` failure, `2` bad usage, `3` an extraction pass is
not implemented yet.

Two runs over the same corpus produce **byte-identical** output: entities are
sorted by id, edges by `(edge, from, to, anchor.file, anchor.span[0])`, trait
lists are emitted in the canonical vocabulary order, indentation is LF, and no
`HashMap`/`HashSet` iteration order reaches the file.

## Progress

A long extraction says what it is doing. `--progress auto` — the default — draws
a single-line bar on `stderr` **only when stderr is a terminal**; redirected or
piped, the run is byte-identical to one built without progress at all, because
`stderr` is a read format here, not a log. `--progress plain` prints one line per
phase with no control characters (the CI form), and `--progress none` prints
nothing.

```
✓ compile      2,466 files  2.4s
✓ comments     2,466 files  0.3s
✓ model        2,466 files  3.3s
✓ imports      2,466 files  1.2s
✓ link doc     2,466 files  0.3s
✓ whitelist    3,847 types  1.1s
✓ entities     4,442 types & lambdas  0.5s
✓ edges        7 relation kinds  4.4s
✓ stubs        3,893 references  0.0s
✓ write        307,264 records  0.8s
```

The first five phases are Spoon's own build (pass 0), reported per compilation
unit through `Environment.setSpoonProgress` — on a real corpus that is most of
the wall clock. The rest are the extractor's passes, in the order `Main`
documents. Two rules the bar keeps:

- **A total is claimed only when it is measured.** A phase whose size is not
  known up front shows a spinner and a running count, never a percentage against
  a guess. `write` learns its total once the writer has planned the file.
- **The unit is what is walked, not what is emitted.** `entities 4,442 types &
  lambdas` is the number of declaration sites traversed; each yields a subtree,
  which is why the summary below reports far more entities.

Redraws are throttled to ~12/s, so a per-file callback over a large corpus
cannot turn stderr into the bottleneck.

## The stderr summary

`stdout` stays free for piping; the run reports to `stderr`:

```
RESOLUTION SUMMARY
  type references : 1483
  resolved        : 1298
  unresolved      : 185
  resolution rate : 87.5%
  entities        : 642 (stubs: 118)
  edges           : 2104 (self-edges dropped: 12)
```

- **type references** — every type reference in the Spoon model, type variables
  excluded (a `T` has no declaration to resolve to).
- **resolved / unresolved / resolution rate** — how many had a reachable
  declaration (`getTypeDeclaration() != null`). This is the number M2 is judged
  on (PLAN.md §5.3: target ≥ ~85% in `noClasspath` mode). A low rate means the
  corpus's dependencies were unavailable, and the resulting graph is a **lower
  bound**, not a wrong answer.
- **entities (stubs: n)** — nodes written, stubs included. A stub is a type
  referenced by the corpus but declared outside it, degraded to
  `{kind: "class", traits: ["TNamed","TType"], isStub: true}`. Their edges are
  kept; the internal-only view is the analyzer filtering `isStub`.
- **edges (self-edges dropped: n)** — the metamodel forbids `from == to`
  (METAMODEL.md §4). Recursion is legal Java, so those edges are dropped and
  counted rather than treated as an error.

Note that "resolved" is **not** "internal". `java.lang.String` resolves and is
external; an invented FQN does not resolve and is external too. Which is which is
decided by `CorpusWhitelist` alone.

## Reading a Java model honestly

- **`noClasspath` invents names.** Over a corpus whose only file declares
  `com.acme.order.OrderService`, Spoon reported references to
  `com.acme.order.Order` and `com.acme.order.Invoice` — classes that exist
  nowhere. It assumes the enclosing package for anything it cannot resolve.
  Corpus membership is therefore decided **only** by a whitelist of ids the
  corpus actually declares (pass 1), never by a package or name prefix, which
  would launder those fabrications into facts.
- **Ids embed erased, fully-qualified parameter types**
  (`java:com.acme.order/OrderService.bill(com.acme.order.Order)`). METAMODEL.md
  §10's example writes `bill(Order)`, but simple names collide —
  `f(java.util.List)` and `f(java.awt.List)` are legal overloads that would merge
  into one entity. Generics are erased (`List<String>` → `java.util.List`),
  arrays render as `T[]`, varargs as arrays, type variables as their bound.
- **Reflection is invisible.** `Class.forName`, `Method.invoke`, proxies, Spring
  XML/annotation wiring, `ServiceLoader`, JNDI: no edge. Documented in the Java
  profile's `notes`, not discovered per-analysis.

## Layout

```
model/           Jackson POJOs mirroring the interchange format.
                 Entity.Builder couples each trait to the key it contributes.
EntityIds        THE id scheme. Every id comes from here.
Anchors          Spoon positions → root-relative, 1-based SourceAnchors.
ResolutionStats  the stderr summary.
CorpusWhitelist  pass 1 — what the corpus declares.
EntityExtractor  pass 2 — nodes.
EdgeExtractor    pass 3 — relations.
StubSynthesizer  pass 4 — degraded nodes for what 2 and 3 referenced.
Main             the CLI and the pass order (documented in its javadoc).
```
