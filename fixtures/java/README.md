# `fixtures/java` — the reference corpus for the Spoon extractor

A small, plausible order-management corpus (13 files, ~250 lines) that exercises
every extraction hazard PLAN.md §5.3 names. It is the acceptance corpus for
`extractors/java`: the snapshot `model.json` the integration test compares
against is produced from **this** tree, and every row of the table below is a
behaviour a reviewer can check by eye.

```bash
cd extractors/java && ./mvnw -B package
java -jar target/codegraph-java.jar --src ../../fixtures/java/src --out model.json
```

`--src fixtures/java/src` is the analysis root, so `anchor.file` values read
`com/acme/order/OrderService.java` — package directories, no `src/` prefix.

## This corpus does not compile, on purpose

`javac` reports **12 errors, all in two files**, and every one of them is
`cannot find symbol` / `package does not exist` for a type the corpus
deliberately never declares:

| Missing type | Where | Why it is missing |
|---|---|---|
| `com.megacorp.ledger.LedgerClient` | imported by `OrderService`, extended by `LedgerAdapter` | an external library that is not on the classpath — the ordinary legacy case |
| `com.acme.order.Invoice` | used by `OrderService.bill`, **never imported** | Spoon must *invent* this FQN from the enclosing package |
| `com.acme.order.adapter.AuditTrail` | used by `LedgerAdapter`, **never imported** | the same invention, in a *different* package, proving it follows the enclosing package |

**Do not "fix" these.** Codegraph exists to extract from non-compilable legacy;
a corpus that compiles cleanly cannot test noClasspath behaviour at all. Every
other file compiles — if `javac` ever reports an error outside
`OrderService.java` and `LedgerAdapter.java`, the corpus has a real typo.

## What each file pins

| File | Pins | Why it is easy to get wrong |
|---|---|---|
| `OrderService.java` | **The id scheme's parameter-type rule.** Two `archive` overloads whose parameter types are `java.util.List` and `com.acme.order.legacy.List` — identical simple names, different packages. | METAMODEL.md §10's illustrative id writes `bill(Order)`. Under simple names both overloads render `archive(List)`, collapse into one id, and one method silently disappears from the model. Ids use erased **FQNs**: `…/OrderService.archive(java.util.List)` vs `…/OrderService.archive(com.acme.order.legacy.List)`. |
| `OrderService.java` | **Fabricated FQNs.** `Invoice` is used with no import and declared nowhere; Spoon reports the referenced type as `com.acme.order.Invoice` with `getTypeDeclaration() == null`. | A package-prefix membership filter (`startsWith("com.acme")`) classifies this fabrication as a corpus type and launders an invention into a fact. Membership is the pass-1 whitelist and nothing else. |
| `OrderService.java` | **Member-level references into a stub type**: `ledger.post(...)`, `ledger.archive(...)` on an unresolvable `LedgerClient`. | Per the `EdgeExtractor` decision these retarget to the declaring type's stub id, so an `invocation` edge legitimately ends at a `TType`, not an Invocable. Anything that assumes invocation targets are invocable breaks here. |
| `LedgerAdapter.java` | **Inheritance from an unresolvable external type**, plus a second fabrication site (`AuditTrail`) in `com.acme.order.adapter`. | Proves the invented package tracks the *enclosing* file, not one hard-coded prefix. The `inheritance` edge to a stub must survive; dropping unresolvable supertypes silently truncates the hierarchy. |
| `legacy/List.java` | **Recursion** (`length()` calls `tail.length()`) and the simple-name collision partner. | Recursion yields `from == to`. `Edge.selfReference()` exists and `Main` drops such edges; pass 3 should drop them at the source. A recursive method is also the cheapest way to produce a self-edge by accident. |
| `Basket.java` | **The `getAllTypes()` blind spot**: a static nested class `Line`, a nested-inside-nested `Line.Discount`, and a non-static inner `Cursor`. Measured: `getAllTypes()` returns 13 types and **none of these three**. | The name says "all". Nested types are reachable only by recursing `CtType.getNestedTypes()`. An extractor that trusts the name drops every inner class from both the whitelist and the entity set — and then every reference to them becomes a spurious stub. Ids: `…/Basket.Line`, `…/Basket.Line.Discount`, `…/Basket.Cursor` (dots, never Spoon's `$`). |
| `Basket.java` | **Implicit default constructor.** `Basket` declares none, so Spoon synthesises one with `isImplicit() == true` and **no valid source position**. | Anchors are required on every entity and edge, and spans are 1-based (a span starting at 0 is rejected by the schema). `Anchors.of` returns empty here by design; the extractor must anchor to the enclosing type or skip the member, never invent a line. Measured: **9** such constructors in this corpus (also `Money`'s canonical record ctor, `Channel`'s enum ctor, and the anonymous class's). |
| `Basket.java` | **Field read, write, and compound assignment.** `total += line.amount()` is one expression that both reads and writes `total`; `index++` does the same inside `Cursor`; `lines` is read from the inner class, i.e. an access to the *enclosing* instance's field. | `access` edges carry `isRead`/`isWrite`; a compound assignment must set **both**. Treating `+=` as a write only loses the read half of the coupling. |
| `Order.java` | **Overloaded constructors with `this(...)`/`super(...)` delegation**, and an access to an **inherited** field (`total`, declared in `AbstractOrder`). | Constructor ids are `…/Order.<init>(java.lang.String)` and `…/Order.<init>(java.lang.String,com.acme.order.Channel)`; per PLAN §5.1 a constructor carries **no TNamed and no TTypedEntity**. The inherited field access must resolve to `…/AbstractOrder.total` — emitting `…/Order.total` invents an entity that does not exist. |
| `AbstractOrder.java` | `implements` between corpus types (`interfaceImplementation`). | Straightforward, and the control case for the row below. |
| `Discountable.java` | **`interface extends interface`.** | This is an `inheritance` edge between types, **not** `interfaceImplementation` (java profile note). The `interface` kind has no `TWithImplements` at all, so getting this wrong fails profile validation rather than merely being wrong. |
| `Money.java` | `record` kind implementing a corpus interface. | Records have `TWithImplements` but **no** `TWithInheritances`; the trait set keys off the *kind*, not off a class/interface family. Spoon also synthesises the component field, its accessor, and the canonical constructor — the accessor `cents()` and the field `cents` share a name but are different entities with different ids. |
| `Channel.java` | `enum` kind implementing a corpus interface; three enum constants. | Same required-trait asymmetry as `record`. Enum constants are `CtEnumValue`, a `CtField` subclass: they are `attribute` entities, and an extractor filtering on `instanceof CtField` picks them up whether it meant to or not. |
| `Audited.java` | `annotation` kind, used on `Reporting.max`. | The only kind with **neither** `TWithInheritances` nor `TWithImplements`. Its member `value()` is a `CtMethod` with no body. Annotation *usages* surface as referenced types (`java.lang.Override`, `Retention`, `RetentionPolicy` all appear in this corpus's reference set). |
| `Notifications.java` | **Lambdas and an anonymous class: `TInvocable` without `TNamed`.** Measured positions: lambdas at lines 8, **11, 11**, and 15; anonymous class at line 22. | Nameless invocables are identified by `(file, startLine)`. See the collision below — lines 11 and 11 are not a typo. |
| `Notifications.java` | **Members of an anonymous class.** `price()` is declared inside `new Priceable() { … }`. | `EntityIds.forType` *rejects* anonymous classes, so `forMethod` cannot be used: the owner id comes from `forAnonymousClass`, then `forMethodIn(ownerId, method)`. Same for any parameter or local inside a lambda — use the `…Of` primitives. |
| `Reporting.java` | **Three import forms**: `import java.util.ArrayList` (normal), `import java.time.*` (on-demand), `import static java.util.Arrays.asList` (static). | Per the java profile, all three fold to module-level `import` edges and the wildcard names the **package**, not the types it brings in. See the open questions below. |
| `Reporting.java` | **Generic erasure, arrays, varargs.** `max(java.util.List<T>)` with `T extends Comparable<T>`; `first(java.util.List<T>)` with unbounded `T`; `join(String[])`; `lines(String...)`. | Ids erase: both generic methods take `java.util.List`. `max`'s declared return type erases to its bound (`java:java.lang/Comparable`), `first`'s unbounded `T` erases to `java:java.lang/Object` (JLS 4.6). Varargs render as the array form, so `lines(java.lang.String[])` and `join(java.lang.String[])` are indistinguishable by parameters alone — only the name separates them. |

## Questions this corpus forced, and how they were answered

These were not defects in the fixture. They are decisions the extractor could
not avoid making, and this corpus is what made each one visible instead of
latent. **All five are now decided**; the answers are recorded inline below and
pinned by `fixtures/java/expected/model.json`.

1. **Two lambdas on one line collide.** `Notifications.java:11` starts two
   lambdas, so the `(file, startLine)` disambiguator produces the *same* id
   twice: `java:com.acme.order/Notifications#com/acme/order/Notifications.java:11`.
   Ids must be unique per model. Either the disambiguator grows a column or an
   in-line ordinal, or the extractor deduplicates and loses one lambda. A lambda
   and an anonymous class sharing a line collide the same way.

   **ANSWERED (M2) — deduplicate, and this is a KNOWN LOSS.** The id scheme is
   locked for M2 (PLAN §4.6), so the extractor keeps the first lambda in AST
   order and drops the second: deterministic, never `HashMap`-dependent. The
   snapshot shows the cost — the corpus contains **5** nameless invocables
   (lambdas at lines 8, 11, 11, 15 and the anonymous class at 22) and the model
   contains **4**. Nothing else in the model is wrong: closure holds and the
   surviving lambda's edges are its own. But one real lambda is absent, and no
   assertion can currently tell that from a lambda that was never written.
   Closing this needs a column (or an ordinal) in the disambiguator, which is an
   id-scheme change and therefore a decision for M3, not a bug in a seam.
2. **An anonymous class has two possible ids.** Spoon reports
   `com.acme.order.Notifications$1` as a *resolved* referenced type. Routed
   through `forTypeReference` that becomes `java:com.acme.order/Notifications.1`;
   routed through `forAnonymousClass` it becomes
   `…/Notifications#com/acme/order/Notifications.java:22`. Both are reachable
   from ordinary code paths, and emitting one while referencing the other breaks
   graph closure. Normalise on the `#file:line` form.
3. **Not every unresolved reference is a stub type.** Measured, the corpus's
   unresolved reference set is exactly four entries: the three genuinely-missing
   types above **and `<nulltype>`**, Spoon's type for the `null` literal (from
   `T best = null` in `Reporting`). The resolved set likewise contains `int`,
   `long`, `boolean` and `void`. A stub synthesizer that stubs everything
   unresolved emits an entity named `<nulltype>`, and one that stubs everything
   not in the whitelist emits `java:<unnamed>/int`. Primitives, `void`, and
   `<nulltype>` must be filtered before pass 4.
4. **Wildcard imports target a package, not a type.** `import java.time.*`
   yields an edge to `java:java.time`, an id no entity declares — and
   `StubSynthesizer` only produces `TType` class stubs, so nothing closes that
   endpoint. Either synthesize stub *packages*, or target the wildcard at
   something that exists. The same question applies to the static import: does
   `import static java.util.Arrays.asList` target `java:java.util` or
   `java:java.util/Arrays`? Whatever is chosen, the snapshot pins it.
5. **`getReferencedTypes()` is per top-level type.** Because the nested types in
   `Basket` are absent from `getAllTypes()`, they are also absent from any
   reference walk built on it — a second reason the recursion in row 6 is not
   optional.

## Measured Spoon behaviour on this corpus

Spoon 11.5.0, `setNoClasspath(true)`, `setComplianceLevel(17)`,
`setCommentEnabled(true)`, `--src fixtures/java/src`:

- `getAllTypes()` → 13 top-level types; `Basket.Line`, `Basket.Line.Discount`
  and `Basket.Cursor` reachable only via `getNestedTypes()`.
- referenced with `getTypeDeclaration() == null` → exactly 4:
  `com.acme.order.Invoice`, `com.acme.order.adapter.AuditTrail`,
  `com.megacorp.ledger.LedgerClient`, `<nulltype>`.
- 36 referenced types resolve, including JDK types (`java.lang.String`,
  `java.util.List`, `java.time.LocalDate`) — **resolvability is not corpus
  membership**, which is why the whitelist is the only membership test.
- 4 lambdas (lines 8, 11, 11, 15), 1 anonymous class (line 22), 9 implicit
  constructors with no valid position.

Re-measure with a throwaway Spoon program, not from memory, whenever this
corpus changes.
