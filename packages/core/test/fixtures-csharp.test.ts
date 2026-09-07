import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { csharpProfile } from "../src/profiles/csharp.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M12 ACCEPTANCE GATE — the Java gate (fixtures-java.test.ts), replayed
 * for the second real extractor. The Roslyn side validates every line against
 * the per-record schemas and the sequence rules itself; what only this side
 * can say is that the composition is one the C# PROFILE licenses — TypeScript
 * data the extractor never sees (CLAUDE.md: "extractors contain no metamodel
 * intelligence"). And the strongest statement: two independent encoders, one
 * in C# and one here, write the same bytes for the same model.
 */

const SNAPSHOT = fileURLToPath(
  new URL("../../../fixtures/csharp/expected/model.jsonl", import.meta.url),
);

function loadSnapshot(): Model {
  return parseModel(readModelFileSync(SNAPSHOT));
}

describe("fixtures/csharp/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the C# profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), csharpProfile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    const dangling = unknownReferences(loadSnapshot());
    expect(dangling.map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges", () => {
    expect(selfReferences(loadSnapshot()).map((s) => s.path)).toEqual([]);
  });

  it("carries the evidence the stub discipline exists to prove (PLAN §13.4)", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));

    // A name Roslyn could not bind lands in the reserved module, named as
    // written — never in the corpus's own namespace, which a prefix test
    // would then launder into a fact.
    const unresolved = byId.get("csharp:<unresolved>/LedgerClient");
    expect(unresolved, "the unbound base type must appear in the model").toBeDefined();
    expect(isStubEntity(unresolved!)).toBe(true);
    expect(byId.has("csharp:Acme.Order.Adapter/LedgerClient")).toBe(false);

    // Resolvability is not membership: the BCL resolves against the embedded
    // reference pack and is still external, in its REAL namespace.
    expect(isStubEntity(byId.get("csharp:System/Exception")!)).toBe(true);
    expect(byId.has("csharp:<unresolved>/Exception")).toBe(false);

    // The corpus's own List, whose SIMPLE name is a BCL type's, is internal.
    expect(isStubEntity(byId.get("csharp:Acme.Order.Legacy/List")!)).toBe(false);

    // Arity is identity: Repository and Repository<T> are two entities.
    expect(isStubEntity(byId.get("csharp:Acme.Order/Repository")!)).toBe(false);
    expect(isStubEntity(byId.get("csharp:Acme.Order/Repository`1")!)).toBe(false);

    // Nested types are entities in their own right, parented by the outer type.
    const discount = byId.get("csharp:Acme.Order/Basket.Line.Discount");
    expect(discount).toBeDefined();
    expect((discount as Record<string, unknown>)["parent"]).toBe("csharp:Acme.Order/Basket.Line");

    // A partial type is ONE entity; its edges say which part wrote them.
    const orderParts = model.entities.filter((e) => e.id === "csharp:Acme.Order/Order");
    expect(orderParts).toHaveLength(1);
    const inherits = model.edges.find(
      (e) => e.edge === "inheritance" && e.from === "csharp:Acme.Order/Order",
    );
    expect(inherits?.to).toBe("csharp:Acme.Order/AbstractOrder");
    expect(inherits?.sourceFile).toBe("Acme/Order/Order.cs");
  });

  it("marks external namespaces as stubs, so filtering stubs yields the internal view", () => {
    const model = loadSnapshot();
    const internal = model.entities.filter((e) => !isStubEntity(e));
    const externalNamespaces = internal.filter(
      (e) => e.kind === "namespace" && !e.id.startsWith("csharp:Acme"),
    );
    expect(externalNamespaces.map((e) => e.id)).toEqual([]);
    // `using Newtonsoft.Json;` binds to nothing, and is still a written import.
    expect(isStubEntity(model.entities.find((e) => e.id === "csharp:Newtonsoft.Json")!)).toBe(true);
    expect(
      model.edges.some((e) => e.edge === "import" && e.to === "csharp:Newtonsoft.Json"),
    ).toBe(true);
  });

  it("folds every using directive to a module-level import, never to a type", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const imports = model.edges.filter((e) => e.edge === "import");
    expect(imports.length).toBeGreaterThan(0);
    for (const edge of imports) {
      expect(byId.get(edge.from)?.kind, edge.from).toBe("namespace");
      expect(byId.get(edge.to)?.kind, edge.to).toBe("namespace");
    }
    // `using static System.Math;` and the alias to List<string> name their namespaces.
    const fromOrder = new Set(imports.filter((e) => e.from === "csharp:Acme.Order").map((e) => e.to));
    expect(fromOrder.has("csharp:System")).toBe(true);
    expect(fromOrder.has("csharp:System.Collections.Generic")).toBe(true);
  });

  it("separates an interface's extends from a class's implements", () => {
    const model = loadSnapshot();
    const kindOf = (from: string, to: string): string | undefined =>
      model.edges.find((e) => e.from === from && e.to === to)?.edge;
    expect(kindOf("csharp:Acme.Order/IDiscountable", "csharp:Acme.Order/IPriceable")).toBe("inheritance");
    expect(kindOf("csharp:Acme.Order/AbstractOrder", "csharp:Acme.Order/IDiscountable")).toBe("interfaceImplementation");
    expect(kindOf("csharp:Acme.Order/Money", "csharp:Acme.Order/IPriceable")).toBe("interfaceImplementation");
    // An enum's underlying type is its declared type, not a base.
    const channel = model.entities.find((e) => e.id === "csharp:Acme.Order/Channel") as Record<string, unknown>;
    expect(channel["declaredType"]).toBe("csharp:System/Byte");
    // `: byte` is a written type reference, never an inheritance.
    expect(
      model.edges.filter((e) => e.from === "csharp:Acme.Order/Channel").map((e) => e.edge),
    ).toEqual(["reference"]);
  });

  it("keeps a lexical namespace parent only for a nested block declaration", () => {
    const model = loadSnapshot();
    const parentOf = (id: string): unknown =>
      (model.entities.find((e) => e.id === id) as Record<string, unknown> | undefined)?.["parent"];
    expect(parentOf("csharp:Acme.Order.Legacy")).toBe("csharp:Acme.Order");
    expect(parentOf("csharp:Acme.Order.Adapter")).toBeUndefined();
    expect(parentOf("csharp:Acme.Order.Extensions")).toBeUndefined();
  });

  /**
   * MEASURES (M10b, METAMODEL §3.8), HAND-COUNTED from `fixtures/csharp/src`:
   *
   *   Reporting.Max      foreach + `if (best == null || …)`     1 + 1 + 1 + 1 = 4
   *   Reporting.Join     one foreach                            1 + 1         = 2
   *   Reporting.First    one ternary                            1 + 1         = 2
   *   Reporting.Today    straight line                          1             = 1
   *   Reporting.Describe switch expression, 2 arms + discard    1 + 2         = 3
   *   StockGuard.Ensure  a guard `if` and one `catch`           1 + 1 + 1     = 3
   */
  it("carries hand-counted measures on the invocables of Reporting and StockGuard", () => {
    const model = loadSnapshot();
    const measure = (id: string, key: string): unknown => {
      const entity = model.entities.find((candidate) => candidate.id === id);
      expect(entity, id).toBeDefined();
      expect(entity?.traits, id).toContain("TMetrics");
      return ((entity as Record<string, unknown>)["metrics"] as Record<string, number>)[key];
    };
    expect(measure("csharp:Acme.Order/Reporting.Max`1(System.Collections.Generic.List`1)", "cyclomatic")).toBe(4);
    expect(measure("csharp:Acme.Order/Reporting.Join(System.String[])", "cyclomatic")).toBe(2);
    expect(measure("csharp:Acme.Order/Reporting.First`1(System.Collections.Generic.List`1)", "cyclomatic")).toBe(2);
    expect(measure("csharp:Acme.Order/Reporting.Today()", "cyclomatic")).toBe(1);
    expect(measure("csharp:Acme.Order/Reporting.Describe(Acme.Order.Channel)", "cyclomatic")).toBe(3);
    expect(measure("csharp:Acme.Order/StockGuard.Ensure(System.Int32)", "cyclomatic")).toBe(3);
    // `Max` spans lines 26–39 of Reporting.cs, every one of them code.
    expect(measure("csharp:Acme.Order/Reporting.Max`1(System.Collections.Generic.List`1)", "sloc")).toBe(14);
  });

  it("keeps every measure finite, non-negative, and sloc within its span", () => {
    const model = loadSnapshot();
    let measured = 0;
    for (const entity of model.entities) {
      const metrics = (entity as Record<string, unknown>)["metrics"] as Record<string, number> | undefined;
      if (metrics === undefined) {
        expect(entity.traits, entity.id).not.toContain("TMetrics");
        continue;
      }
      expect(entity.traits, entity.id).toContain("TMetrics");
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isFinite(value), `${entity.id}.${key}`).toBe(true);
        expect(value, `${entity.id}.${key}`).toBeGreaterThanOrEqual(0);
      }
      const sloc = metrics["sloc"];
      if (sloc !== undefined) {
        const anchor = SourceAnchor.parse((entity as Record<string, unknown>)["anchor"]);
        expect(sloc, entity.id).toBeLessThanOrEqual(anchor.span[1] - anchor.span[0] + 1);
      }
      expect(isStubEntity(entity), entity.id).toBe(false);
      measured += 1;
    }
    expect(measured).toBeGreaterThan(80);
  });

  /**
   * VALUES (M10c, METAMODEL §1.6), each readable in `fixtures/csharp/src`:
   *
   *   MaxLines = 4 * 25                       folded across the arithmetic
   *   Store = 10 / Web                        an enum member's integral constant
   *   AuditedAttribute(string tag = "")       a parameter default
   *   trail = new()                           readonly but not constant: no value
   *   [Audited("monthly")]                    positional argument, named after the parameter
   *   [Audited(LedgerClient.AuditTag, Verbose = true)]   unevaluated — honest about not folding
   *   [AttributeUsage(AttributeTargets.Method)]          an enum argument, type + NAME
   */
  it("carries the written values of the corpus, folded where the language folds them", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((entity) => [entity.id, entity]));
    const valueOf = (id: string): unknown =>
      (byId.get(id) as unknown as Record<string, unknown> | undefined)?.["value"];

    expect(valueOf("csharp:Acme.Order/Order.MaxLines")).toEqual({ k: "number", v: "100" });
    expect(valueOf("csharp:Acme.Order/Channel.Store")).toEqual({ k: "number", v: "10" });
    expect(valueOf("csharp:Acme.Order/Channel.Web")).toEqual({ k: "number", v: "0" });
    expect(valueOf("csharp:Acme.Order/AuditedAttribute.<init>(System.String)#param:tag")).toEqual({ k: "string", v: "" });
    const trail = byId.get("csharp:Acme.Order/Order.trail");
    expect(trail).toBeDefined();
    expect(trail?.traits).not.toContain("TWithValue");

    const uses = model.edges.filter((edge) => edge.edge === "annotationUse");
    const argumentsOf = (from: string, to: string): unknown => {
      const use = uses.find((edge) => edge.from === from && edge.to === to);
      expect(use, `${from} -> ${to}`).toBeDefined();
      return (use as unknown as { arguments: unknown[] }).arguments;
    };
    expect(argumentsOf("csharp:Acme.Order/Reporting.Max`1(System.Collections.Generic.List`1)", "csharp:Acme.Order/AuditedAttribute"))
      .toEqual([{ name: "tag", value: { k: "string", v: "monthly" } }]);
    expect(argumentsOf("csharp:Acme.Order/Order.Discount(System.Int32)", "csharp:Acme.Order/AuditedAttribute")).toEqual([
      { name: "tag", value: { k: "unevaluated", source: "LedgerClient.AuditTag" } },
      { name: "Verbose", value: { k: "boolean", v: true } },
    ]);
    expect(argumentsOf("csharp:Acme.Order/AuditedAttribute", "csharp:System/AttributeUsageAttribute")).toEqual([
      { name: "validOn", value: { k: "enum", type: "csharp:System/AttributeTargets", name: "Method" } },
    ]);
    // An attribute's arguments ride on the edge; they never leak as accesses.
    expect(model.edges.some((e) => e.edge === "access" && e.from === "csharp:Acme.Order/AuditedAttribute")).toBe(false);
  });

  it("closes over values: every id inside one resolves like an edge endpoint", () => {
    const model = loadSnapshot();
    const argumentIds = model.edges
      .filter((edge) => edge.edge === "annotationUse")
      .flatMap((edge) => (edge as unknown as { arguments: { value: { type?: string } }[] }).arguments)
      .map((argument) => argument.value.type)
      .filter((id): id is string => id !== undefined);
    expect(argumentIds.length).toBeGreaterThan(0);
    const declared = new Set(model.entities.map((entity) => entity.id));
    for (const id of argumentIds) expect(declared.has(id), id).toBe(true);
  });

  /**
   * MEMBERS AND THEIR EDGES (M12b): the C#-specific claims of PLAN §13.2, each
   * one readable in the fixture.
   */
  it("attaches extension methods to the extended type and resolves their call sites to the static method", () => {
    const model = loadSnapshot();
    const doubled = model.entities.find((e) => e.id === "csharp:Acme.Order.Extensions/MoneyExtensions.Doubled(Acme.Order.Money)");
    expect(doubled?.traits).toContain("TAttachedTo");
    expect((doubled as Record<string, unknown>)["attachedTo"]).toBe("csharp:Acme.Order/Money");
    expect((doubled as Record<string, unknown>)["parent"]).toBe("csharp:Acme.Order.Extensions/MoneyExtensions");
  });

  it("identifies nameless invocables by file:line:column, two on one line included", () => {
    const model = loadSnapshot();
    const lambdas = model.entities.filter((e) => e.kind === "lambda").map((e) => e.id);
    expect(lambdas).toContain("csharp:Acme.Order/Notifications#Acme/Order/Notifications.cs:19:22");
    expect(lambdas).toContain("csharp:Acme.Order/Notifications#Acme/Order/Notifications.cs:19:63");
    // Both belong to the method that wrote them; their parameters sit below their own id.
    const parentOf = (id: string): unknown => (model.entities.find((e) => e.id === id) as Record<string, unknown>)["parent"];
    expect(parentOf("csharp:Acme.Order/Notifications#Acme/Order/Notifications.cs:19:22")).toBe("csharp:Acme.Order/Notifications.Both(Acme.Order.Order)");
    expect(model.entities.some((e) => e.id === "csharp:Acme.Order/Basket#Acme/Order/Basket.cs:28:37#param:line")).toBe(true);
    // A local function is a named method below its invocable.
    const zero = model.entities.find((e) => e.id === "csharp:Acme.Order/Notifications.FreeOf(Acme.Order.Order)#fn:Zero()");
    expect(zero?.kind).toBe("method");
  });

  it("folds a call on an external member to its type, and keeps a corpus member precise", () => {
    const model = loadSnapshot();
    const invocations = model.edges.filter((e) => e.edge === "invocation");
    const targetsOf = (from: string): string[] => [...new Set(invocations.filter((e) => e.from === from).map((e) => e.to))].sort();
    expect(targetsOf("csharp:Acme.Order/Basket.Count")).toEqual(["csharp:System.Linq/Enumerable"]);
    expect(targetsOf("csharp:Acme.Order/Order.<init>(System.String)")).toEqual(["csharp:Acme.Order/Order.<init>(System.String,Acme.Order.Channel)"]);
    expect(targetsOf("csharp:Acme.Order/Notifications.NotifyShipped(Acme.Order.Order)")).toEqual(["csharp:Acme.Order/ShipmentHandler", "csharp:System/Action`1"]);
    // Accesses say whether they read or write.
    const total = model.edges.find((e) => e.edge === "access" && e.from === "csharp:Acme.Order/Basket.Add(Acme.Order.Basket.Line)" && e.to === "csharp:Acme.Order/Basket.total") as Record<string, unknown> | undefined;
    expect(total?.["isRead"]).toBe(true);
    expect(total?.["isWrite"]).toBe(true);
    // Throw sites: the guard and the rethrow, each anchored at its own statement.
    const throws = model.edges.filter((e) => e.edge === "throws" && e.from === "csharp:Acme.Order/StockGuard.Ensure(System.Int32)");
    expect(throws.map((e) => e.anchor.span[0]).sort()).toEqual([13, 21]);
    expect(new Set(throws.map((e) => e.to))).toEqual(new Set(["csharp:Acme.Order/EmptyBasketException"]));
  });

  it("separates facts from inferences: every edge carries a known provenance", () => {
    const model = loadSnapshot();
    const declared = model.edges.filter((e) => e.provenance === "declared");
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(model.edges.map((e) => e.provenance))).toEqual(new Set(["declared"]));
  });

  it("anchors every entity that claims TSourceAnchor to a 1-based span in the corpus", () => {
    const model = loadSnapshot();
    for (const entity of model.entities) {
      if (!entity.traits.includes("TSourceAnchor")) continue;
      const anchor = SourceAnchor.parse((entity as Record<string, unknown>)["anchor"]);
      expect(anchor.file, entity.id).not.toMatch(/^\//);
      expect(anchor.file, entity.id).not.toContain("\\");
      expect(anchor.span[0], entity.id).toBeGreaterThan(0);
    }
  });

  it("writes non-ASCII identifiers and text unescaped, as the encoder does", () => {
    const raw = readFileSync(SNAPSHOT, "utf8");
    expect(raw).toContain('"name":"Résumé"');
    expect(raw).toContain("«naïve»");
    expect(raw).not.toContain("\\u00");
  });
});
