import { describe, expect, it } from "vitest";
import { Model, parseModel, SCHEMA_VERSION } from "../src/model.js";

/**
 * The worked example of METAMODEL §10 / PLAN §4.6, completed with the keys its
 * declared traits contribute (the doc's snippet elides `parameters`/`localVariables`).
 */
const billMethod = {
  id: "java:com.acme.order/OrderService.bill(Order)",
  kind: "method",
  traits: [
    "TNamed",
    "TInvocable",
    "TWithParameters",
    "TWithLocalVariables",
    "TWithInvocations",
    "TWithAccesses",
    "TTypedEntity",
    "TChildOf",
    "TSourceAnchor",
  ],
  name: "bill",
  signature: "bill(com.acme.order.Order)",
  declaredType: "java:com.acme.billing/Invoice",
  parent: "java:com.acme.order/OrderService",
  parameters: ["java:com.acme.order/OrderService.bill(Order)#order"],
  localVariables: [],
  anchor: { file: "OrderService.java", span: [15, 22] },
};

/** A degraded external type (METAMODEL §6): legitimate edge target, not a closure hole. */
const stubInvoice = {
  id: "java:com.acme.billing/Invoice",
  kind: "class",
  traits: ["TNamed", "TType"],
  name: "Invoice",
  isStub: true,
};

const billsTaxCalculator = {
  edge: "invocation",
  from: "java:com.acme.order/OrderService.bill(Order)",
  to: "java:com.acme.order/TaxCalculator.apply(double)",
  candidates: ["java:com.acme.order/TaxCalculator.apply(double)"],
  provenance: "declared",
  anchor: { file: "OrderService.java", span: [19, 19] },
};

const model = {
  schemaVersion: SCHEMA_VERSION,
  lang: "java",
  extractor: { name: "codegraph-spoon", version: "0.1.0", noClasspath: true },
  root: "/path/analyzed",
  entities: [billMethod, stubInvoice],
  edges: [billsTaxCalculator],
};

describe("Model", () => {
  it("pins the interchange contract version", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });

  it("parses the worked example model of METAMODEL §10 / PLAN §4.6", () => {
    const parsed = parseModel(model);
    expect(parsed.lang).toBe("java");
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
    const edge = parsed.edges[0];
    expect(edge?.edge).toBe("invocation");
    expect(edge?.provenance).toBe("declared");
  });

  it("preserves extractor-specific flags such as noClasspath", () => {
    const parsed = parseModel(model);
    expect(parsed.extractor.name).toBe("codegraph-spoon");
    expect(parsed.extractor["noClasspath"]).toBe(true);
  });

  it("does not check graph closure — a dangling target is the analyzer's concern", () => {
    const dangling = {
      ...model,
      edges: [{ ...billsTaxCalculator, to: "java:nowhere/Unknown.method()" }],
    };
    expect(Model.safeParse(dangling).success).toBe(true);
  });

  it("rejects a model with an empty lang or schemaVersion", () => {
    expect(Model.safeParse({ ...model, lang: "" }).success).toBe(false);
    expect(Model.safeParse({ ...model, schemaVersion: "" }).success).toBe(false);
  });

  it("rejects an extractor without name/version", () => {
    expect(Model.safeParse({ ...model, extractor: { noClasspath: true } }).success).toBe(false);
  });

  it("rejects an edge inside the model that lacks provenance", () => {
    const { provenance: _omitted, ...withoutProvenance } = billsTaxCalculator;
    expect(Model.safeParse({ ...model, edges: [withoutProvenance] }).success).toBe(false);
  });

  it("throws a readable aggregate error on invalid input", () => {
    expect(() => parseModel({ lang: "java" })).toThrow(/invalid model\.json/);
    expect(() => parseModel(null)).toThrow(/invalid model\.json/);
  });
});
