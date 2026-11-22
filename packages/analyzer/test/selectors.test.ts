import { EDGE_KINDS, PROFILES, TRAIT_NAMES, type Edge, type Entity, type EntityId } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { buildGraph, type CodeGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { sortIds } from "../src/order.js";
import {
  SELECTOR_TERMS,
  SelectorError,
  compileSelector,
  formatTerm,
  parseSelector,
  parseTerm,
  selectorToJson,
  type Selector,
} from "../src/selectors.js";
import { declaredOnly, identityView, internalOnly, type View } from "../src/views.js";
import {
  csharpFixture,
  edge,
  elixirGraph,
  javaFixture,
  javaGraph,
  method,
  pkg,
  rubyGraph,
  toyModel,
  typescriptGraph,
} from "./fixture.js";

/**
 * Selectors (PLAN §22.3), each term HAND-COUNTED against `fixtures/java/src`.
 * Every expected id list below was derived by reading the `.java` sources —
 * the declarations, `extends`/`implements` clauses, annotation sites and calls
 * cited beside it — never by running the selector. The model only supplies the
 * SPELLING of an id.
 */

const graph = javaGraph();
const O = (symbol: string): EntityId => `java:com.acme.order/${symbol}`;
const A = (symbol: string): EntityId => `java:com.acme.order.adapter/${symbol}`;
const L = (symbol: string): EntityId => `java:com.acme.order.legacy/${symbol}`;
const BATCH_ANON = O("Batch#com/acme/order/Batch.java:48:32");
const NOTIF = (pos: string): EntityId => O(`Notifications#com/acme/order/Notifications.java:${pos}`);

function select(text: string, view: View = identityView, on: CodeGraph = graph): readonly EntityId[] {
  return compileSelector(parseTerm(text), on, view).matchingIds();
}

function json(value: unknown, view: View = identityView, on: CodeGraph = graph): readonly EntityId[] {
  return compileSelector(parseSelector(value), on, view).matchingIds();
}

const sorted = (ids: readonly EntityId[]): readonly EntityId[] => sortIds(ids);

describe("id: — the rendered id, verbatim", () => {
  it("selects exactly the anonymous class's constructor, `#`, `:`, `/`, `<`, `>` and `(` included", () => {
    const id = `${BATCH_ANON}.<init>()`;
    expect(select(`id:${id}`)).toEqual([id]);
  });

  it("selects nothing for an id the model does not declare (an id is not a pattern)", () => {
    expect(select("id:java:com.acme.order/Basket.Line.<init>(")).toEqual([]);
  });
});

describe("kind:", () => {
  it("kind:interface — Discountable.java:4 and Priceable.java:4 (stub interfaces are `class` in noClasspath)", () => {
    expect(select("kind:interface")).toEqual([O("Discountable"), O("Priceable")]);
  });

  it("kind:package — the 3 corpus packages + the 7 external ones the sources import or use", () => {
    // com.megacorp.ledger (LedgerClient), java.io (System.out's PrintStream), java.lang,
    // java.lang.annotation (Audited.java:3-4), java.time (Reporting.java:3),
    // java.util (Basket.java:3-4), java.util.function (Notifications.java:3, Batch.java:42).
    expect(select("kind:package")).toEqual(
      sorted([
        "java:com.acme.order",
        "java:com.acme.order.adapter",
        "java:com.acme.order.legacy",
        "java:com.megacorp.ledger",
        "java:java.io",
        "java:java.lang",
        "java:java.lang.annotation",
        "java:java.time",
        "java:java.util",
        "java:java.util.function",
      ]),
    );
  });
});

describe("trait:", () => {
  it("trait:TComment — the 25 Javadoc comments; Order.java:32's `//` comment is a statement's, not the method's", () => {
    expect(select("trait:TComment")).toEqual(
      sorted([
        O("AbstractOrder"),
        O("Audited"),
        O("Basket"),
        O("Basket.Cursor"),
        O("Basket.Line"),
        O("Basket.Line.Discount"),
        O("Batch"),
        O("Batch.allocator()"),
        O("Batch.priced()"),
        O("Batch.running()"),
        O("Batch.size()"),
        O("Channel"),
        O("Discountable"),
        O("EmptyBasketException"),
        O("Money"),
        O("Notifications"),
        O("Order"),
        O("Order.MAX_LINES"),
        O("Order.trail"),
        O("OrderService"),
        O("Priceable"),
        O("Reporting"),
        O("StockGuard"),
        A("LedgerAdapter"),
        L("List"),
      ]),
    );
  });

  it("trait:TWithValue — `MAX_LINES = 4 * 25` and `value() default \"\"`; `trail` is final but not constant", () => {
    expect(select("trait:TWithValue")).toEqual([O("Audited.value()"), O("Order.MAX_LINES")]);
  });
});

describe("lang: — the language of the model that declares the entity", () => {
  const union = buildGraph(loadModels([javaFixture(), csharpFixture()]).union);
  const javaIds = sorted([...new Set(javaFixture().entities.map((entity) => entity.id))]);
  const csharpIds = sorted([...new Set(csharpFixture().entities.map((entity) => entity.id))]);

  it("lang:java on a Java + C# union is every id the Java file declares, and none of the C# file's", () => {
    expect(select("lang:java", identityView, union)).toEqual(javaIds);
    expect(select("lang:csharp", identityView, union)).toEqual(csharpIds);
  });

  it("a language core knows but the union lacks matches nothing (and is not an error)", () => {
    expect(select("lang:ts", identityView, union)).toEqual([]);
  });
});

describe("name: — the entity's own TNamed name", () => {
  it("name:price — the six `price()` declarations: AbstractOrder:20, Batch:53, Channel:10, Money:15, Notifications:25, Priceable:6", () => {
    expect(select("name:price")).toEqual(
      sorted([
        O("AbstractOrder.price()"),
        `${BATCH_ANON}.price()`,
        O("Channel.price()"),
        O("Money.price()"),
        `${NOTIF("22:32")}.price()`,
        O("Priceable.price()"),
      ]),
    );
  });

  it("name:*Order — whole-name match, case-sensitive: AbstractOrder and Order, not OrderService nor `order` parameters", () => {
    expect(select("name:*Order")).toEqual([O("AbstractOrder"), O("Order")]);
  });

  it("a package name is `.`-segmented: `*` stays in one segment, `**` crosses", () => {
    expect(select("name:com.acme.order.*")).toEqual([
      "java:com.acme.order.adapter",
      "java:com.acme.order.legacy",
    ]);
    expect(select("name:com.acme.**")).toEqual([
      "java:com.acme.order",
      "java:com.acme.order.adapter",
      "java:com.acme.order.legacy",
    ]);
  });

  it("an entity with no name (a constructor, a lambda) never matches, not even `name:**`", () => {
    const named = select("name:**");
    expect(named).not.toContain(O("Money.<init>(long)"));
    expect(named).not.toContain(NOTIF("8:47"));
    // 179 entities, 19 constructors and 6 lambdas carry no `name`.
    expect(named).toHaveLength(179 - 19 - 6);
  });
});

describe("module: — the nearest containing module's name (a module is its own)", () => {
  const legacy = [
    "java:com.acme.order.legacy",
    L("List"),
    L("List.<init>(java.lang.String,com.acme.order.legacy.List)"),
    L("List.<init>(java.lang.String,com.acme.order.legacy.List)#param:head"),
    L("List.<init>(java.lang.String,com.acme.order.legacy.List)#param:tail"),
    L("List.head"),
    L("List.head()"),
    L("List.length()"),
    L("List.tail"),
  ];
  const adapter = [
    "java:com.acme.order.adapter",
    A("LedgerAdapter"),
    // LedgerAdapter.java declares no constructor: Spoon emits the implicit default one.
    A("LedgerAdapter.<init>()"),
    A("LedgerAdapter.post(java.lang.Object)"),
    A("LedgerAdapter.post(java.lang.Object)#param:document"),
    A("LedgerAdapter.trail"),
  ];

  it("module:com.acme.order.legacy — legacy/List.java: the class, 2 fields, 1 constructor + 2 parameters, 2 methods, and the package", () => {
    expect(select("module:com.acme.order.legacy")).toEqual(sorted(legacy));
  });

  it("module:com.acme.order.* — the two sub-packages, not com.acme.order itself; `new AuditTrail()` is a parentless stub", () => {
    expect(select("module:com.acme.order.*")).toEqual(sorted([...legacy, ...adapter]));
  });

  it("module:java.* stops at one segment, module:java.** reaches java.lang.annotation and java.util.function", () => {
    const oneSegment = [
      "java:java.io",
      "java:java.io/PrintStream",
      "java:java.lang",
      "java:java.lang/Comparable",
      "java:java.lang/Object",
      "java:java.lang/Override",
      "java:java.lang/Runnable",
      "java:java.lang/RuntimeException",
      "java:java.lang/String",
      "java:java.lang/StringBuilder",
      "java:java.lang/System",
      "java:java.time",
      "java:java.time/LocalDate",
      "java:java.util",
      "java:java.util/ArrayList",
      "java:java.util/Arrays",
      "java:java.util/List",
    ];
    expect(select("module:java.*")).toEqual(sorted(oneSegment));
    expect(select("module:java.**")).toEqual(
      sorted([
        ...oneSegment,
        "java:java.lang.annotation",
        "java:java.lang.annotation/Retention",
        "java:java.lang.annotation/RetentionPolicy",
        "java:java.util.function",
        "java:java.util.function/Consumer",
        "java:java.util.function/IntFunction",
      ]),
    );
  });

  it("an entity with no module never matches: OrderService.java:18's `new Invoice(…)` and LedgerAdapter.java:8's `new AuditTrail()`", () => {
    expect(json({ not: { module: "**" } })).toEqual(sorted([O("Invoice"), A("AuditTrail")]));
  });
});

describe("file: — the anchor's file, `/`-segmented", () => {
  it("file:**/legacy/*.java — List.java's 8 declarations (the package has no anchor)", () => {
    expect(select("file:**/legacy/*.java")).toEqual(
      sorted([
        L("List"),
        L("List.<init>(java.lang.String,com.acme.order.legacy.List)"),
        L("List.<init>(java.lang.String,com.acme.order.legacy.List)#param:head"),
        L("List.<init>(java.lang.String,com.acme.order.legacy.List)#param:tail"),
        L("List.head"),
        L("List.head()"),
        L("List.length()"),
        L("List.tail"),
      ]),
    );
  });

  it("file:**/adapter/** — LedgerAdapter.java's class, implicit constructor, method, parameter and field", () => {
    expect(select("file:**/adapter/**")).toEqual(
      sorted([
        A("LedgerAdapter"),
        A("LedgerAdapter.<init>()"),
        A("LedgerAdapter.post(java.lang.Object)"),
        A("LedgerAdapter.post(java.lang.Object)#param:document"),
        A("LedgerAdapter.trail"),
      ]),
    );
  });

  it("file:*.java matches nothing: every source sits below com/acme/order/, and `*` does not cross `/`", () => {
    expect(select("file:*.java")).toEqual([]);
    expect(select("file:**.java").length).toBeGreaterThan(100);
  });
});

describe("edge: — the entity WRITES an edge of that kind", () => {
  const annotated = sorted([
    O("AbstractOrder.price()"), // AbstractOrder.java:19 @Override
    O("Audited"), // Audited.java:7 @Retention
    `${BATCH_ANON}.price()`, // Batch.java:52 @Override
    O("Channel.price()"), // Channel.java:9 @Override
    O("Money.price()"), // Money.java:14 @Override
    `${NOTIF("22:32")}.price()`, // Notifications.java:24 @Override
    O("Order.discount(int)"), // Order.java:29 @Audited + :30 @Override
    O("Reporting.max(java.util.List)"), // Reporting.java:23 @Audited
    A("LedgerAdapter.post(java.lang.Object)"), // LedgerAdapter.java:10 @Override
  ]);

  it("edge:annotationUse — 10 annotation sites on 9 declarations", () => {
    expect(select("edge:annotationUse")).toEqual(annotated);
  });

  it("edge:annotationUse>name:Audited — Order.java:29 and Reporting.java:23", () => {
    expect(select("edge:annotationUse>name:Audited")).toEqual([
      O("Order.discount(int)"),
      O("Reporting.max(java.util.List)"),
    ]);
  });

  it("edge:annotationUse>name:Override — the 7 `@Override` sites", () => {
    expect(select("edge:annotationUse>name:Override")).toEqual(
      annotated.filter((id) => id !== O("Audited") && id !== O("Reporting.max(java.util.List)")),
    );
  });

  it("edge:throws — StockGuard.java:13 and :18, two throw statements in one method", () => {
    expect(select("edge:throws")).toEqual([O("StockGuard.ensure(int)")]);
  });

  it("edge:invocation>edge:throws — nothing: no corpus code calls `ensure`", () => {
    expect(select("edge:invocation>edge:throws")).toEqual([]);
  });

  it("edge:invocation>edge:invocation>name:PrintStream — the callers of `log` (Notifications.java:8, 11 twice, 26)", () => {
    expect(select("edge:invocation>edge:invocation>name:PrintStream")).toEqual(
      sorted([NOTIF("8:47"), NOTIF("11:22"), NOTIF("11:65"), `${NOTIF("22:32")}.price()`]),
    );
  });

  it("edge:invocation>id:…Money.<init>(long) — `new Money(…)` at Money.java:7 and :11", () => {
    expect(select("edge:invocation>id:java:com.acme.order/Money.<init>(long)")).toEqual([
      O("Money.times(int)"),
      O("Money.zero()"),
    ]);
  });

  it("a term matches the entity itself: a type does not have its methods' edges", () => {
    expect(select("edge:invocation")).not.toContain(O("Money"));
    expect(select("edge:annotationUse>name:Audited")).not.toContain(O("Order"));
  });
});

describe("edge-in: — an edge of that kind points AT the entity (the derived inverse)", () => {
  it("edge-in:inheritance — the four `extends` targets: Order:6, LedgerAdapter:6, EmptyBasketException:4, Discountable:4", () => {
    expect(select("edge-in:inheritance")).toEqual(
      sorted([
        O("AbstractOrder"),
        "java:com.megacorp.ledger/LedgerClient",
        "java:java.lang/RuntimeException",
        O("Priceable"),
      ]),
    );
  });

  it("edge-in:interfaceImplementation — AbstractOrder:4 → Discountable; Channel:4 and Money:4 → Priceable (an anonymous class writes no clause)", () => {
    expect(select("edge-in:interfaceImplementation")).toEqual([O("Discountable"), O("Priceable")]);
    expect(select("edge-in:interfaceImplementation<name:Money")).toEqual([O("Priceable")]);
  });

  it("edge-in:inheritance<module:com.acme.order — not LedgerClient, extended from the adapter package", () => {
    expect(select("edge-in:inheritance<module:com.acme.order")).toEqual(
      sorted([O("AbstractOrder"), "java:java.lang/RuntimeException", O("Priceable")]),
    );
  });

  it("edge-in:invocation<edge:throws — what the throwing method calls: StockGuard.java:13 and :16", () => {
    expect(select("edge-in:invocation<edge:throws")).toEqual([
      O("EmptyBasketException.<init>(java.lang.String)"),
      O("StockGuard.check(int)"),
    ]);
  });
});

describe("edges are read through the view", () => {
  // The import statements: Order:3, OrderService:3, LedgerAdapter:3 (com.megacorp.ledger,
  // recorded `derived`); Audited:3-4, Reporting:3, Basket:3-4, Reporting:4/:6,
  // Notifications:3 (recorded `declared`).
  it("edge:import — both importing packages; declaredOnly drops the adapter, whose only import is derived", () => {
    expect(select("edge:import")).toEqual(["java:com.acme.order", "java:com.acme.order.adapter"]);
    expect(select("edge:import", declaredOnly)).toEqual(["java:com.acme.order"]);
  });

  it("edge-in:import — five imported packages; declaredOnly loses com.megacorp.ledger", () => {
    const declared = [
      "java:java.lang.annotation",
      "java:java.time",
      "java:java.util",
      "java:java.util.function",
    ];
    expect(select("edge-in:import")).toEqual(sorted([...declared, "java:com.megacorp.ledger"]));
    expect(select("edge-in:import", declaredOnly)).toEqual(sorted(declared));
  });

  it("edge:import>name:com.megacorp.* sees facts only under declaredOnly — no provenance syntax needed", () => {
    expect(select("edge:import>name:com.megacorp.*")).toEqual([
      "java:com.acme.order",
      "java:com.acme.order.adapter",
    ]);
    expect(select("edge:import>name:com.megacorp.*", declaredOnly)).toEqual([]);
  });

  it("internalOnly: a stub matches nothing, and no edge to a stub is seen", () => {
    expect(select("edge:import", internalOnly)).toEqual([]);
    expect(select("kind:class", internalOnly)).not.toContain("java:java.lang/String");
    expect(select("kind:class")).toContain("java:java.lang/String");
  });

  it("the matcher carries the view it was compiled under", () => {
    expect(compileSelector(parseTerm("kind:class"), graph, declaredOnly).view).toEqual(declaredOnly.descriptor);
  });
});

describe("glob separators come from the profile's lexicon, per kind", () => {
  it("TypeScript module names are paths: `*` stays in a directory, and `.` is not a separator", () => {
    const ts = typescriptGraph();
    const direct = select("name:packages/order/src/*", identityView, ts);
    expect(direct).toContain("ts:packages%2Forder%2Fsrc%2Fmoney.ts");
    expect(direct).not.toContain("ts:packages%2Forder%2Fsrc%2Flegacy%2Flist.ts");
    expect(select("name:packages/order/src/**", identityView, ts)).toContain(
      "ts:packages%2Forder%2Fsrc%2Flegacy%2Flist.ts",
    );
  });

  it("a `**` filling whole segments also stands for none, as a shell globstar does", () => {
    const ts = typescriptGraph();
    // `legacy/acme.ts` is at the root: the leading `**/` matches zero directories.
    expect(select("name:**/legacy/*", identityView, ts)).toEqual(
      sorted([
        "ts:legacy%2Facme-report.ts",
        "ts:legacy%2Facme.ts",
        "ts:packages%2Forder%2Fsrc%2Flegacy%2Flist.ts",
      ]),
    );
    expect(select("name:packages/order/src/**/money.ts", identityView, ts)).toEqual([
      "ts:packages%2Forder%2Fsrc%2Fmoney.ts",
    ]);
    // Not segment-aligned: `**` is any text, `legacy-lib` included.
    expect(select("name:**legacy*", identityView, ts)).toContain("ts:legacy-lib");
  });

  it("a Ruby constant path is `::`-segmented", () => {
    const rb = rubyGraph();
    const one = select("name:AcmeOrder::*", identityView, rb);
    const all = select("name:AcmeOrder::**", identityView, rb);
    expect(one.length).toBeGreaterThan(0);
    expect(all).toEqual(expect.arrayContaining([...one]));
    // AcmeOrder::Order::MAX_LINES is two segments below AcmeOrder.
    expect(one.some((id) => id.includes("MAX_LINES"))).toBe(false);
    expect(all.some((id) => id.includes("MAX_LINES"))).toBe(true);
  });

  it("an Elixir defmodule name is `.`-segmented, its file module `/`-segmented", () => {
    const ex = elixirGraph();
    expect(select("name:AcmeOrder.Pricing.*", identityView, ex)).toEqual(
      expect.arrayContaining([
        "ex:lib%2Facme_order%2Fpricing%2Fpremium.ex/AcmeOrder%2EPricing%2EPremium",
        "ex:lib%2Facme_order%2Fpricing%2Fstandard.ex/AcmeOrder%2EPricing%2EStandard",
      ]),
    );
    expect(select("module:lib/acme_order/pricing/*", identityView, ex)).toContain(
      "ex:lib%2Facme_order%2Fpricing%2Fpremium.ex/AcmeOrder%2EPricing%2EPremium",
    );
    expect(select("module:lib/*", identityView, ex)).toEqual([]);
  });
});

describe("the text grammar", () => {
  it("takes an id: payload verbatim to the end — `>`, `<`, `:` and `#` included", () => {
    expect(parseTerm("id:a:b/c#d>e<f")).toEqual({ type: "id", id: "a:b/c#d>e<f" });
    expect(parseTerm("edge:invocation>id:x>y<z")).toEqual({
      type: "edge",
      kind: "invocation",
      to: { type: "id", id: "x>y<z" },
    });
  });

  it("splits edge:KIND>TERM at the first `>` and edge-in:KIND<TERM at the first `<`; terms nest", () => {
    expect(parseTerm("edge-in:invocation<edge:throws>name:E*")).toEqual({
      type: "edgeIn",
      kind: "invocation",
      from: { type: "edge", kind: "throws", to: { type: "name", glob: "E*" } },
    });
  });

  it("formats every term back to its text, and composition to none", () => {
    expect(formatTerm(parseTerm("edge:invocation>module:java.sql*"))).toBe("edge:invocation>module:java.sql*");
    expect(formatTerm({ type: "all", of: [] })).toBeUndefined();
    expect(formatTerm({ type: "edge", kind: "invocation", to: { type: "not", of: { type: "kind", kind: "class" } } })).toBeUndefined();
  });

  it("has a JSON form for every selector", () => {
    const selector: Selector = {
      type: "any",
      of: [
        { type: "edge", kind: "annotationUse", to: { type: "name", glob: "Transactional" } },
        { type: "not", of: { type: "edgeIn", kind: "invocation" } },
      ],
    };
    expect(selectorToJson(selector)).toEqual({
      any: [{ edge: { kind: "annotationUse", to: { name: "Transactional" } } }, { not: { edgeIn: { kind: "invocation" } } }],
    });
    expect(parseSelector(selectorToJson(selector))).toEqual(selector);
  });

  it("names its prefixes once", () => {
    expect(SELECTOR_TERMS).toEqual(["id", "kind", "trait", "lang", "name", "module", "file", "edge", "edge-in"]);
  });
});

describe("cost: linear in the edges, whatever the nesting", () => {
  /** LAYERS × WIDTH methods; every method calls every method of the next layer. */
  const LAYERS = 6;
  const WIDTH = 20;
  const entities: Entity[] = [pkg("java:p")];
  const edges: Edge[] = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    for (let i = 0; i < WIDTH; i++) {
      entities.push(method(`java:p/T.m${layer}_${i}()`, "java:p"));
      if (layer + 1 < LAYERS) {
        for (let j = 0; j < WIDTH; j++) edges.push(edge("invocation", `java:p/T.m${layer}_${i}()`, `java:p/T.m${layer + 1}_${j}()`));
      }
    }
  }
  const base = buildGraph(loadModels(toyModel(entities, edges)).union);

  it("evaluates each nested edge node at most once per entity, and never rescans graph.edges", () => {
    let adjacencyReads = 0;
    let edgeListReads = 0;
    const counted: CodeGraph = {
      ...base,
      outgoing: (id) => {
        adjacencyReads++;
        return base.outgoing(id);
      },
      incoming: (id) => {
        adjacencyReads++;
        return base.incoming(id);
      },
      get edges() {
        edgeListReads++;
        return base.edges;
      },
    };
    // Five edge nodes. Unmemoized, one layer-0 method alone costs WIDTH^4 = 160 000 reads.
    const edgeNodes = 5;
    const matcher = compileSelector(
      parseTerm("edge:invocation>edge:invocation>edge:invocation>edge-in:invocation<edge:invocation"),
      counted,
      identityView,
    );
    const matched = matcher.matchingIds();
    expect(matched).toHaveLength((LAYERS - 3) * WIDTH);
    expect(adjacencyReads).toBeLessThanOrEqual(edgeNodes * base.entities.size);
    expect(edgeListReads).toBe(0);
  });
});

/** The fault as thrown — a SelectorError, never a bare Error. */
function fault(run: () => unknown): SelectorError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SelectorError);
    return error as SelectorError;
  }
  throw new Error("expected a SelectorError, nothing was thrown");
}

const ALL_KINDS = [...new Set(Object.values(PROFILES).flatMap((profile) => Object.keys(profile.kinds)))];

describe("errors name the vocabulary — never a silent empty match", () => {
  it("an unknown kind lists every kind core's profiles declare", () => {
    const error = fault(() => parseTerm("kind:clas"));
    expect(error.code).toBe("unknown-kind");
    for (const kind of ALL_KINDS) expect(error.message).toContain(kind);
    expect(error.valid).toEqual(expect.arrayContaining(ALL_KINDS));
  });

  it("an unknown trait lists TRAIT_NAMES", () => {
    const error = fault(() => parseTerm("trait:TNamd"));
    expect(error.code).toBe("unknown-trait");
    for (const trait of TRAIT_NAMES) expect(error.message).toContain(trait);
  });

  it("an unknown edge kind lists EDGE_KINDS, also inside a nested term", () => {
    for (const text of ["edge:invocaton", "edge-in:access<edge:invocaton>name:x"]) {
      const error = fault(() => parseTerm(text));
      expect(error.code).toBe("unknown-edge-kind");
      for (const kind of EDGE_KINDS) expect(error.message).toContain(kind);
    }
  });

  it("edge:KIND<TERM is an unknown edge kind (the `<` belongs to edge-in), and says so", () => {
    const error = fault(() => parseTerm("edge:invocation<name:x"));
    expect(error.code).toBe("unknown-edge-kind");
    expect(error.message).toContain("edge-in");
  });

  it("an unknown lang lists the profiles' langs", () => {
    const error = fault(() => parseTerm("lang:jav"));
    expect(error.code).toBe("unknown-lang");
    for (const lang of Object.keys(PROFILES)) expect(error.message).toContain(lang);
  });

  it("an unknown prefix, or no prefix at all, lists the terms", () => {
    for (const text of ["kinds:class", "class", "edgeIn:invocation"]) {
      const error = fault(() => parseTerm(text));
      expect(error.code).toBe("unknown-term");
      for (const term of SELECTOR_TERMS) expect(error.message).toContain(`${term}:`);
    }
  });

  it("an empty payload is an error, nested included", () => {
    for (const text of ["id:", "name:", "edge:", "edge:invocation>", "edge-in:invocation<"]) {
      expect(fault(() => parseTerm(text)).code, text).toBe("empty");
    }
  });

  it("a nested fault in text names the whole term", () => {
    expect(fault(() => parseTerm("edge:invocation>kind:clas")).message).toContain("edge:invocation>kind:clas");
  });

  it("a hand-built selector is checked too: compile refuses an unknown kind", () => {
    expect(fault(() => compileSelector({ type: "kind", kind: "clas" }, graph, identityView)).code).toBe("unknown-kind");
  });
});

describe("JSON errors carry the PATH of the fault", () => {
  const cases: readonly [string, unknown, string, string][] = [
    ["two keys", { kind: "class", trait: "TNamed" }, "", "one-key"],
    ["no key", {}, "", "one-key"],
    ["unknown key", { nam: "x" }, "", "unknown-key"],
    ["wrong type", { name: 3 }, "name", "wrong-type"],
    ["empty glob", { all: [{ name: "" }] }, "all[0].name", "empty"],
    ["unknown edge kind deep", { any: [{ kind: "class" }, { edge: { kind: "invocaton" } }] }, "any[1].edge.kind", "unknown-edge-kind"],
    ["edge without kind", { edge: {} }, "edge.kind", "missing-key"],
    ["edge with an unknown key", { edge: { kind: "invocation", target: { id: "x" } } }, "edge.target", "unknown-key"],
    ["edge-in with `to`", { edgeIn: { kind: "invocation", to: { id: "x" } } }, "edgeIn.to", "unknown-key"],
    ["edge not an object", { edge: "invocation" }, "edge", "wrong-type"],
    ["all not an array", { all: {} }, "all", "wrong-type"],
    ["not of an array", { not: [] }, "not", "not-an-object"],
    ["a nested text term", { any: ["kind:class"] }, "any[0]", "not-an-object"],
    ["null", null, "", "not-an-object"],
    ["unknown kind in edge.to", { edge: { kind: "invocation", to: { kind: "clas" } } }, "edge.to.kind", "unknown-kind"],
    ["unknown trait", { not: { trait: "TNamd" } }, "not.trait", "unknown-trait"],
    ["unknown lang", { lang: "jav" }, "lang", "unknown-lang"],
  ];

  it.each(cases)("%s → %s at `%s`", (_label, value, path, code) => {
    const error = fault(() => parseSelector(value));
    expect(error.path).toBe(path);
    expect(error.code).toBe(code);
    if (path !== "") expect(error.message).toContain(path);
  });

  it("an unknown key lists the keys a selector may have", () => {
    const error = fault(() => parseSelector({ nam: "x" }));
    for (const key of ["id", "kind", "trait", "lang", "name", "module", "file", "edge", "edgeIn", "all", "any", "not"]) {
      expect(error.message).toContain(key);
    }
  });

  it("a caller embedding a selector prefixes its own path", () => {
    const error = fault(() => parseSelector({ any: [{ kind: "class" }, { edge: { kind: "x" } }] }, { path: "prompt.entities[0].select" }));
    expect(error.path).toBe("prompt.entities[0].select.any[1].edge.kind");
    expect(error.message).toContain("prompt.entities[0].select.any[1].edge.kind");
  });
});
