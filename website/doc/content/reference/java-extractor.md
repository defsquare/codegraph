---
title: Java extractor
linkTitle: Java extractor
weight: 9
---

`codegraph-java` 0.2.0 — the Spoon-based Java extractor. A separate Maven project in `extractors/java/`, JDK 17+, running Spoon in **noClasspath mode**, so the sources need not compile and no dependency jars are needed. It emits [`model.jsonl`](/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

```bash
cd extractors/java && ./mvnw -B package     # `mvn` is not installed; use the wrapper
java -jar target/codegraph-java.jar --src <dir> --out model.jsonl
```

A JDK must be on `PATH`; non-interactive shells do not source sdkman:

```bash
export JAVA_HOME=$HOME/.sdkman/candidates/java/25.0.4-tem
export PATH=$JAVA_HOME/bin:$PATH
```

## Synopsis

```
java -jar codegraph-java.jar [--src <dir>…] [--out <file>]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root to analyze; repeatable | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (a bar on a terminal, silence when piped), `plain` (one line per phase, no control characters), or `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--help` | print the help and exit | — |

### Repository provenance

Copied verbatim into the header; the extractor runs no git — whoever invokes it supplies the facts, as [`snapshots`](/reference/cli/snapshots/) does.

| Option | Meaning |
|---|---|
| `--repo-remote <url>` | normalized https clone URL, no `.git` suffix |
| `--repo-commit <sha>` | the sha this tree is at — a permalink, not a branch |
| `--repo-root <path>` | the analyzed root RELATIVE to the repository root (default: empty — they are the same directory) |
| `--repo-provider <p>` | `github` \| `gitlab`, only when the hostname does not say |

## Streams

stdout carries one thing: the finished run's `source:` roots and `model:` file, absolute. Progress and the **resolution summary** — how many type references Spoon resolved in noClasspath mode, how many entities and stubs were emitted, and how many edges — go to stderr, and progress never reaches a stream that is not a terminal unless asked for.

## The Java profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang java`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`.

| Kind | Required traits | Optional traits |
|---|---|---|
| `annotation` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `attribute` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithValue` |
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `constructor` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `enum` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `lambda` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TMetrics` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics`, `TWithValue` |
| `package` | `TNamed`, `TModule`, `TWithChildren` | `TComment`, `TChildOf` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `record` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |

**Edge kinds emitted:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference` · `annotationUse` · `throws`

| Java construct | Kind |
|---|---|
| package | `package` |
| class | `class` |
| interface | `interface` |
| enum | `enum` |
| record | `record` |
| annotation type | `annotation` |
| method | `method` |
| constructor | `constructor` — no `TNamed`, no `TTypedEntity` |
| lambda / anonymous class member owner | `lambda` — `TInvocable` without `TNamed` |
| field, enum constant | `attribute` |
| parameter | `parameter` |
| local variable | `localVariable` |

Ids for invocables carry **erased fully-qualified** parameter types: `…/OrderService.archive(java.util.List)` and `…/OrderService.archive(com.acme.order.legacy.List)` are different entities. Nameless entities are disambiguated by `file:line:column`.

## Stub discipline

Spoon in noClasspath mode **invents plausible fully-qualified names**. The rule:

1. Build a **whitelist of corpus-declared ids** in a first pass.
2. Anything referenced but not in the whitelist becomes a stub — `{kind: "class", traits: ["TNamed","TType"], isStub: true}` for a type, `{kind: "package", traits: ["TNamed","TModule","TWithChildren"], definedIn: [], isStub: true}` for a package.
3. **Never filter by package prefix.** Invented FQNs look exactly like real ones, and a prefix filter would launder them into facts.

Edges to stubs are kept; the internal-only view is the analyzer-side filter. `isStub` is contributed by `TModule` as well as `TType`, because the import graph is module-level: `import java.util.List` yields an edge to `java:java.util`, a package no corpus file declares.

A dangling **member** id is refused and reported, not stubbed: a `method` stub would need a degraded-member concept core does not have.

**Primitives, `void` and `<nulltype>` are not entities.** `declaredType` is omitted for them rather than letting `java:<unnamed>/int` be fabricated into a stub class named `int`. `TTypedEntity`'s value is optional even when the trait is declared, so omitting is legal and lossless.

See [Stubs](/reference/metamodel/stubs/) and [Extracting without compiling](/explanation/extracting-without-compiling/).

## Measures emitted

Carried in the `TMetrics` map. See [Measures and literals](/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | every type and invocable | lines of its own span that are neither blank nor comment-only, counted by a scanner that knows string and text-block literals, so a `"/*"` in the source does not swallow the rest of the file |
| `cyclomatic` | invocables only | 1 + `if` / `for` / foreach / `while` / `do` / non-default `case` label / `catch` / ternary / short-circuit `&&` and `\|\|` / switch pattern guard |

Purely syntactic, hence immune to the noClasspath resolution ceiling. A nested lambda or anonymous class does NOT contribute to its enclosing method: it is its own invocable and carries its own count. A type's complexity is therefore not stored — it is the sum over its members, which the consumer computes with `sum:cyclomatic`.

## Literal and annotation facts emitted

| Fact | Carried by | Notes |
|---|---|---|
| a written annotation with its arguments | an `annotationUse` edge, `arguments: NamedArgument[]` | the implicit `value =` is normalized explicit; an empty argument list is omitted on the wire and restored on read |
| a constant field initializer | `TWithValue` on the `attribute` | JLS compile-time constant expressions only |
| an annotation element `default` | `TWithValue` on the `method` | |
| a class literal in an argument | the `Literal` `{k:"type"}` **and** its own `reference` edge | a value never replaces a dependency |

A field that is `final` but whose initializer is CODE (`new StringBuilder()`) carries **nothing**: absence means "not constant". On commons-lang, `SAFE_MAX_ARRAY_LENGTH` (`static final`) states `2147483639`, while `SOFT_MAX_ARRAY_LENGTH` — the same `Integer.MAX_VALUE - 8` initializer, but not `final` — states nothing.

## Profile notes

The documented blind spots, verbatim from the profile.

- Measures (TMetrics, METAMODEL.md §3.8): `sloc` on every type and invocable — lines of its own span that are neither blank nor comment-only, counted by a scanner that knows string and text-block literals, so a `"/*"` in the source does not swallow the rest of the file. `cyclomatic` on invocables only: 1 + if / for / foreach / while / do / non-default case label / catch / ternary / short-circuit && and || / switch pattern guard. Purely syntactic, hence immune to the noClasspath resolution ceiling. A nested lambda or anonymous class does NOT contribute to its enclosing method: it is its own invocable and carries its own count. A type's complexity is therefore not stored — it is the sum over its members, which the consumer computes.
- Spoon in noClasspath mode invents plausible fully-qualified names for unresolved types. Corpus membership is therefore decided by a whitelist of ids actually declared by the corpus (built in a first pass); anything else is emitted as an isStub entity. Never decide membership by package or name prefix — invented FQNs look exactly like real ones and a prefix filter would launder them into facts.
- Reflection is invisible: Class.forName, Method.invoke, proxies, Spring XML/annotation wiring, ServiceLoader/META-INF/services, and JNDI lookups produce no edge. The import/invocation graph of a reflection-heavy corpus is a lower bound.
- Lombok-generated members (getters, setters, @Builder, @Data constructors) are emitted with provenance "generated" when the expansion is visible to Spoon, and are missing entirely when it is not.
- An interface's `extends` list is emitted as inheritance edges between types; interfaceImplementation is reserved for a class/enum/record `implements` clause, always with provenance "declared".
- A `throws` edge is emitted per written `throw` statement whose static exception type resolves, anchored at the throw site — the evidence a guard clause (`if (x) throw new E(...)`) leaves in the model. A method's `throws` CLAUSE stays a plain reference edge: it declares propagation, not a failure exit of this body. A rethrow (`throw e;`) targets the caught variable's static type; a throw whose type Spoon cannot name is dropped and counted, like any unidentifiable target.
- Static and on-demand (`import x.y.*`) imports are folded to module-level import edges; the wildcard case names the package, not the individual types it brings in.
- Overloads are distinguished by the id's signature disambiguator, so an unresolved parameter type changes the id — a resolution failure shows up as a stub target, never as a merged entity.
- Java generics are erased in the model: type arguments are emitted as reference edges from the declaring entity, and declaredType carries the raw type.
- noClasspath resolution rate, measured (M2 audit): 100.0% on apache/commons-lang (263 files, 133478 type references, 0 unresolved) and 77.8% on spring-petclinic (30 files, 2189 references, 487 unresolved, all of them Spring and Jakarta types whose jars are absent). The rate is a property of the corpus's DEPENDENCY SURFACE, not of the extractor: commons-lang is self-contained and depends on nothing but the JDK, which resolves against the runner's own classpath. A jar that is not on the classpath cannot be resolved by any extractor, so a corpus with third-party dependencies has a structural ceiling well below 100% and a single cross-corpus target number is not meaningful. The stub discipline, not the resolution rate, is the property worth asserting.
- The resolution rate counts neither type variables nor `<nulltype>`: neither names anything that could have a declaration, so counting them measures the corpus's writing style. This is not cosmetic — `<nulltype>`, Spoon's static type for the `null` literal, was ALL 1466 of commons-lang's originally-reported unresolved references, making the headline number a function of how many `return null;` statements the corpus contains.
- In noClasspath Spoon promotes an unresolvable RECEIVER to a type in the enclosing package: `typeHint -> typeHint.with(...)` and `cm.setStatisticsEnabled(...)` produced stub classes named `typeHint` and `cm` inside the corpus's own package on spring-petclinic. They are correctly stubbed (membership is the declared-id whitelist), and they are why the whitelist exists — but the stub set of a real corpus therefore contains a tail of entities named after local variables, and a stub count is not a count of external types.
- An array type is not an entity, and neither is its component where a member is concerned. `xs.length` and `int[]::new` declare their member on `int[]` / `Money[]`; folding that up names the component and states a fact the source never wrote. Such facts are dropped, not degraded — the dependency on the component is already carried by the written type reference that mentions it.
- An anonymous class has exactly one id, the `#file:line:column` form pass 1 declared. Spoon names it `Outer$N`, which renders as a plausible nested-type id in the corpus's own package; a reference resolved through that name gives one declared class two ids and launders the second into a stub. Type references must be resolved to their declaration before being named.
- Spoon materializes the implicit constructor of an anonymous class with synthetic parameters named `$anonymousN`. They are emitted (implicit members are, deliberately, so that `new Foo()` does not dangle), so the model contains a handful of parameter entities nobody wrote, carrying no anchor of their own — 5 of 15338 entities on commons-lang.

## The reference corpus

`fixtures/java/` is a small order-management corpus (13 files, ~250 lines) that exercises every extraction hazard, and the acceptance corpus for the extractor: the snapshot in `fixtures/java/expected/` is produced from that tree.

```bash
java -jar target/codegraph-java.jar --src ../../fixtures/java/src --out model.jsonl
```

**It does not compile, on purpose.** `javac` reports 12 errors, all in two files, and every one is `cannot find symbol` / `package does not exist` for a type the corpus deliberately never declares:

| Missing type | Where | Why it is missing |
|---|---|---|
| `com.megacorp.ledger.LedgerClient` | imported by `OrderService`, extended by `LedgerAdapter` | an external library that is not on the classpath — the ordinary legacy case |
| `com.acme.order.Invoice` | used by `OrderService.bill`, never imported | Spoon must *invent* this FQN from the enclosing package |
| `com.acme.order.adapter.AuditTrail` | used by `LedgerAdapter`, never imported | the same invention, in a *different* package, proving it follows the enclosing package |

What each file pins:

| File | Pins |
|---|---|
| `OrderService.java` | the id scheme's parameter-type rule (two `archive` overloads whose parameter types are `java.util.List` and `com.acme.order.legacy.List`); fabricated FQNs; member-level references into a stub type |
| `LedgerAdapter.java` | inheritance from an unresolvable external type, plus a second fabrication site in another package |
| `legacy/List.java` | recursion (`from == to`) and the simple-name collision partner |
| `Basket.java` | nested types invisible to `getAllTypes()`; an implicit default constructor with no valid source position; field read, write and compound assignment |
| `Order.java` | overloaded constructors with `this(…)`/`super(…)` delegation, and an access to an inherited field |
| `AbstractOrder.java` | `implements` between corpus types |
| `Discountable.java` | `interface extends interface` — an `inheritance` edge, not `interfaceImplementation` |
| `Money.java` | `record` implementing a corpus interface; the synthesised component field, accessor and canonical constructor |
| `Channel.java` | `enum` implementing a corpus interface; enum constants as `attribute` entities |
| `Audited.java` | the `annotation` kind, and an annotation use with an enum argument |
| `Notifications.java` | lambdas and an anonymous class — `TInvocable` without `TNamed`; members of an anonymous class |
| `Reporting.java` | three import forms (normal, on-demand, static); generic erasure, arrays, varargs |

Measured Spoon behaviour on this corpus (Spoon 11.5.0, `setNoClasspath(true)`, `setComplianceLevel(17)`, `setCommentEnabled(true)`):

- `getAllTypes()` returns 13 top-level types; `Basket.Line`, `Basket.Line.Discount` and `Basket.Cursor` are reachable only via `getNestedTypes()`.
- Exactly 4 references have `getTypeDeclaration() == null`: the three genuinely-missing types above and `<nulltype>`, Spoon's type for the `null` literal.
- 36 referenced types resolve, JDK types included — **resolvability is not corpus membership**, which is why the whitelist is the only membership test.
- 4 lambdas, 1 anonymous class, 9 implicit constructors with no valid position.

## Gotcha

Point `--src` at a single source root. A repository with several source roots for one package — main and test, or split across modules — confuses the resolver.
