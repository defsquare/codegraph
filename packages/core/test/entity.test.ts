import { describe, expect, it } from "vitest";
import { Entity, isStubEntity } from "../src/entity.js";
import { TRAITS, traitSchemaFor } from "../src/traits.js";

describe("Entity", () => {
  it("parses the minimal node: id, kind, traits", () => {
    const e = Entity.parse({
      id: "java:com.acme.order/Order",
      kind: "class",
      traits: ["TNamed", "TType"],
      name: "Order",
      isStub: false,
    });
    expect(e.id).toBe("java:com.acme.order/Order");
    expect(e.kind).toBe("class");
    expect(e.traits).toEqual(["TNamed", "TType"]);
  });

  it("parses a node declaring no trait at all", () => {
    const e = Entity.parse({ id: "java:com.acme.order/Order", kind: "class", traits: [] });
    expect(e.traits).toEqual([]);
  });

  // METAMODEL.md §2, Validity: "every declared trait's keys are present and
  // well-typed". Profile-independent — TNamed contributes `name` in every
  // language — so it is the Entity schema's job, not only validateEntity's.
  it("obliges a declared trait to carry its keys", () => {
    const missingName = Entity.safeParse({
      id: "java:com.acme.order/Order",
      kind: "class",
      traits: ["TNamed", "TType"],
      isStub: false,
    });
    expect(missingName.success).toBe(false);
    expect(JSON.stringify(missingName.error?.issues)).toContain("TNamed");

    const missingSignature = Entity.safeParse({
      id: "java:com.acme.order/OrderService.bill(Order)",
      kind: "method",
      traits: ["TInvocable"],
    });
    expect(missingSignature.success).toBe(false);

    const badAnchor = Entity.safeParse({
      id: "java:com.acme.order/Order",
      kind: "class",
      traits: ["TSourceAnchor"],
      anchor: { file: "Order.java" },
    });
    expect(badAnchor.success).toBe(false);
  });

  it("asks nothing of a marker trait — its data lives in edges", () => {
    const marker = Entity.safeParse({
      id: "java:com.acme.order/Order.total",
      kind: "attribute",
      traits: ["TStructural", "TWithAccesses", "TWithInvocations"],
    });
    expect(marker.success).toBe(true);
  });

  it("rejects an empty kind, a missing id, and names outside the trait vocabulary", () => {
    expect(Entity.safeParse({ id: "java:a/B", kind: "", traits: [] }).success).toBe(false);
    expect(Entity.safeParse({ kind: "class", traits: [] }).success).toBe(false);
    expect(Entity.safeParse({ id: "java:a/B", kind: "class", traits: ["TWhatever"] }).success).toBe(false);
  });

  it("preserves trait-contributed keys through parsing", () => {
    const raw = {
      id: "java:com.acme.order/OrderService.bill(Order)",
      kind: "method",
      traits: ["TNamed", "TInvocable", "TChildOf", "TSourceAnchor"],
      name: "bill",
      signature: "bill(com.acme.order.Order)",
      parent: "java:com.acme.order/OrderService",
      anchor: { file: "OrderService.java", span: [15, 22] },
    };
    const e = Entity.parse(raw);
    expect(e).toEqual(raw);
    expect(traitSchemaFor(e.traits).safeParse(e).success).toBe(true);
  });

  it("takes the optional TS-family space and rejects values outside it", () => {
    const e = Entity.parse({
      id: "ts:src/model/Order",
      kind: "class",
      traits: ["TType"],
      isStub: false,
      space: ["type", "value"],
    });
    expect(e.space).toEqual(["type", "value"]);
    expect(Entity.safeParse({ id: "ts:src/model/Order", kind: "class", traits: [], space: ["runtime"] }).success).toBe(
      false,
    );
  });
});

describe("isStubEntity", () => {
  it("reads the TType-contributed flag", () => {
    const stub = Entity.parse({
      id: "java:javax.sql/DataSource",
      kind: "interface",
      traits: ["TType"],
      isStub: true,
    });
    const owned = Entity.parse({
      id: "java:com.acme.order/Order",
      kind: "class",
      traits: ["TType"],
      isStub: false,
    });
    expect(isStubEntity(stub)).toBe(true);
    expect(isStubEntity(owned)).toBe(false);
  });

  it("is false without TType, whatever stray keys the entity carries", () => {
    const method = Entity.parse({
      id: "java:com.acme.order/OrderService.bill(Order)",
      kind: "method",
      traits: ["TInvocable"],
      signature: "bill(com.acme.order.Order)",
      isStub: true,
    });
    expect(isStubEntity(method)).toBe(false);
  });
});

describe("the composition that motivates the design (METAMODEL.md §3.7)", () => {
  it("models a Clojure fn-var as TNamed + TStructural + TInvocable at once", () => {
    const fnVar = Entity.parse({
      id: "clj:acme.order/bill",
      kind: "var",
      traits: ["TNamed", "TStructural", "TInvocable"],
      name: "bill",
      signature: "(bill [order])",
    });

    // Named, value holder and invocable simultaneously — no tree-shaped hierarchy fits.
    expect(TRAITS.TNamed.safeParse(fnVar).success).toBe(true);
    expect(TRAITS.TStructural.safeParse(fnVar).success).toBe(true);
    expect(TRAITS.TInvocable.safeParse(fnVar).success).toBe(true);
    expect(traitSchemaFor(fnVar.traits).parse(fnVar)).toEqual(fnVar);
  });
});
