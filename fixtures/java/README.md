# fixtures/java — the reference corpus for the Spoon extractor (PLAN.md §5.3)

`src/` is the extraction root: `java -jar codegraph-java.jar --src fixtures/java/src --out model.json`.
Anchor paths in the emitted model are therefore relative to `src/`, e.g.
`com/acme/order/OrderService.java`.

This corpus is **deliberately not compilable**. Roughly half of its type
references cannot be resolved — that is the point. A fixture that compiles
cleanly would exercise none of the noClasspath behaviour M2 exists to survive.

## What each file pins

| File | Exercises |
|---|---|
| `com/acme/order/OrderService.java` | overloads, a constructor, a lambda, a nested class, a static import, an unresolvable external import, and the invented-FQN hazard |
| `com/acme/order/Order.java` | `record` — implicit canonical constructor and accessors with no valid source position |
| `com/acme/order/Channel.java` | `enum` — implements, never extends |
| `com/acme/order/Audited.java` | `annotation` — neither extends nor implements |
| `com/acme/order/Taxing.java` | `interface` — `extends` is inheritance, never implementation |
| `com/acme/order/TaxCalculator.java` | a declared implementation of a corpus interface; a local variable |
| `com/acme/billing/AbstractService.java` | a second package; cross-package inheritance and import |

Together they produce all twelve kinds the Java profile declares: `package`,
`class`, `interface`, `enum`, `record`, `annotation`, `method`, `constructor`,
`lambda`, `attribute`, `parameter`, `localVariable`.

## The three type-reference populations, and why they must stay mixed

1. **Declared here** — `Order`, `TaxCalculator`, `Channel`, `AbstractService`.
2. **Invented by Spoon** — `Invoice` is declared nowhere, yet Spoon reports it as
   `com.acme.order.Invoice` by assuming the enclosing package. It is byte-for-byte
   indistinguishable from population 1 by any prefix test, so a prefix filter would
   launder a fabrication into a corpus fact. It must come out as `isStub: true`.
3. **Outside the corpus** — `com.nonexistent.external.MissingLib` (unresolvable) and
   `java.util.List` / `java.util.ArrayList` (resolvable against the JDK). The second
   pair pins that *resolvability is not membership*.

Do not "fix" this corpus by declaring `Invoice` or dropping the missing import:
removing population 2 removes the only executable evidence for PLAN.md §5.2.

No expected `model.json` snapshot is committed yet — the extraction passes are
still landing, and a snapshot taken now would pin a half-built model. The
acceptance gate meanwhile is schema validation plus the properties in
`extractors/java/src/test/java/dev/codegraph/spoon/`.
