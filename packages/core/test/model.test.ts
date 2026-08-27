import { describe, expect, it } from "vitest";
import { Model, Repository, parseModel, SCHEMA_VERSION } from "../src/model.js";

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

/**
 * Repository provenance (METAMODEL §8a, M10a). The block is optional and holds
 * FACTS: a normalized https remote, the sha extracted, and the analyzed root
 * relative to the repository root. Every shape a URL projection would silently
 * mangle — an ssh remote, a `.git` suffix, an absolute or escaping root — is
 * refused here, so a consumer that concatenates them cannot produce a link
 * that 404s.
 */
describe("Model.repository", () => {
  const repository = {
    remote: "https://github.com/google/gson",
    commit: "4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1",
    root: "gson/src/main/java",
  };

  it("is optional — a model that does not know its repository says nothing", () => {
    expect(parseModel(model).repository).toBeUndefined();
    expect(Model.safeParse({ ...model, repository }).success).toBe(true);
  });

  it("carries the four facts, provider only when the hostname does not say", () => {
    const parsed = parseModel({ ...model, repository });
    expect(parsed.repository).toEqual(repository);
    expect(
      Repository.safeParse({ ...repository, provider: "gitlab" }).success,
    ).toBe(true);
    expect(Repository.safeParse({ ...repository, provider: "bitbucket" }).success).toBe(false);
  });

  it("refuses a remote that is not normalized https", () => {
    for (const remote of [
      "git@github.com:google/gson.git",
      "ssh://git@github.com/google/gson",
      "http://github.com/google/gson",
      "https://github.com/google/gson.git",
      "https://github.com/google/gson/",
      "",
    ]) {
      expect(Repository.safeParse({ ...repository, remote }).success, remote).toBe(false);
    }
  });

  it("refuses a commit that is not a sha — a branch name moves and is not a fact", () => {
    for (const commit of ["main", "HEAD", "", "4b9d4a", "4B9D4A51EA36D18A0E6E1C0BC0F3D1A8B3A5F0C1"]) {
      expect(Repository.safeParse({ ...repository, commit }).success, commit).toBe(false);
    }
  });

  it("refuses a root that is not repo-relative — the prefix every anchor is joined onto", () => {
    for (const root of ["/gson/src/main/java", "../gson", "gson/../../etc", "gson/src/", "./gson"]) {
      expect(Repository.safeParse({ ...repository, root }).success, root).toBe(false);
    }
    // The analyzed root IS the repository root: an empty prefix, not a missing one.
    expect(Repository.safeParse({ ...repository, root: "" }).success).toBe(true);
  });
});
