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
    expect(model.edges.some((e) => e.from === "csharp:Acme.Order/Channel")).toBe(false);
  });

  it("keeps a lexical namespace parent only for a nested block declaration", () => {
    const model = loadSnapshot();
    const parentOf = (id: string): unknown =>
      (model.entities.find((e) => e.id === id) as Record<string, unknown> | undefined)?.["parent"];
    expect(parentOf("csharp:Acme.Order.Legacy")).toBe("csharp:Acme.Order");
    expect(parentOf("csharp:Acme.Order.Adapter")).toBeUndefined();
    expect(parentOf("csharp:Acme.Order.Extensions")).toBeUndefined();
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
