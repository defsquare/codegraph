import { describe, expect, it } from "vitest";
import type { TraitName } from "../src/names.js";
import type { Entity } from "../src/entity.js";
import type { Edge } from "../src/edges.js";
import type { Model } from "../src/model.js";
import { SCHEMA_VERSION } from "../src/model.js";
import {
  type Profile,
  validateEntity,
  validateModel,
  validateProfile,
} from "../src/profile.js";

// Inline fixture: the real language profiles are owned elsewhere and must not
// become a dependency of the validator's own tests.
const demo: Profile = {
  lang: "demo",
  kinds: {
    class: {
      required: ["TNamed", "TType"],
      optional: ["TSourceAnchor", "TComment", "TWithChildren"],
    },
    method: {
      required: ["TNamed", "TInvocable"],
      optional: ["TSourceAnchor", "TChildOf"],
    },
    // The hierarchy-breaking composition: a Clojure-style fn-var.
    var: {
      required: ["TNamed", "TStructural", "TInvocable"],
      optional: [],
    },
  },
  edges: ["import", "invocation"],
};

function entity(
  id: string,
  kind: string,
  traits: TraitName[],
  rest: Record<string, unknown> = {},
): Entity {
  return { id, kind, traits, ...rest } as unknown as Entity;
}

function invocation(from: string, to: string, kind = "invocation"): Edge {
  return {
    edge: kind,
    from,
    to,
    provenance: "declared",
    anchor: { file: "Demo.java", span: [1, 1] },
  } as unknown as Edge;
}

function model(entities: Entity[], edges: Edge[], lang = "demo"): Model {
  return {
    schemaVersion: SCHEMA_VERSION,
    lang,
    extractor: { name: "test-extractor", version: "0.0.0" },
    root: "/corpus",
    entities,
    edges,
  } as unknown as Model;
}

const validClass = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
  name: "Order",
  isStub: false,
});

const codes = (issues: readonly { code: string }[]): string[] => issues.map((i) => i.code);

describe("validateEntity — required ⊆ traits ⊆ required ∪ optional", () => {
  it("accepts an entity whose traits sit inside the licensed window", () => {
    const withOptional = entity("demo:acme/Order", "class", ["TNamed", "TType", "TComment"], {
      name: "Order",
      isStub: false,
      comments: ["the order aggregate"],
    });
    expect(validateEntity(demo, validClass)).toEqual([]);
    expect(validateEntity(demo, withOptional)).toEqual([]);
  });

  it("accepts the trait composition no hierarchy can express", () => {
    const fnVar = entity("demo:acme/bill", "var", ["TNamed", "TStructural", "TInvocable"], {
      name: "bill",
      signature: "bill(order)",
    });
    expect(validateEntity(demo, fnVar)).toEqual([]);
  });

  it("rejects a missing required trait", () => {
    const missing = entity("demo:acme/Order", "class", ["TNamed"], { name: "Order" });
    expect(codes(validateEntity(demo, missing))).toEqual(["missing-required-trait"]);
  });

  it("rejects a trait outside required ∪ optional", () => {
    const extra = entity("demo:acme/Order", "class", ["TNamed", "TType", "TInvocable"], {
      name: "Order",
      isStub: false,
      signature: "Order()",
    });
    const issues = validateEntity(demo, extra);
    expect(codes(issues)).toEqual(["trait-not-allowed"]);
    expect(issues[0]?.message).toContain("TInvocable");
  });

  it("rejects a kind the profile does not declare, and stops there", () => {
    const alien = entity("demo:acme/Order", "record", ["TNamed", "TType"], {
      name: "Order",
      isStub: false,
    });
    expect(codes(validateEntity(demo, alien))).toEqual(["unknown-kind"]);
  });

  it("rejects malformed keys contributed by a declared trait", () => {
    const badName = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
      name: 42,
      isStub: false,
    });
    const issues = validateEntity(demo, badName);
    expect(codes(issues)).toEqual(["trait-keys-invalid"]);
    expect(issues[0]?.message).toContain("TNamed");
    expect(issues[0]?.path).toBe("demo:acme/Order");
  });

  it("reports a missing required trait key as invalid keys too", () => {
    const noSignature = entity("demo:acme/Order.bill()", "method", ["TNamed", "TInvocable"], {
      name: "bill",
    });
    expect(codes(validateEntity(demo, noSignature))).toEqual(["trait-keys-invalid"]);
  });
});

describe("validateModel", () => {
  it("accepts a conforming model", () => {
    const callee = entity("demo:acme/Tax", "class", ["TNamed", "TType"], {
      name: "Tax",
      isStub: true,
    });
    const ok = model([validClass, callee], [invocation("demo:acme/Order", "demo:acme/Tax")]);
    expect(validateModel(ok, demo)).toEqual([]);
  });

  it("rejects an edge kind the profile does not license", () => {
    const bad = model([validClass], [invocation("demo:acme/Order", "demo:acme/Tax", "access")]);
    const issues = validateModel(bad, demo);
    expect(codes(issues)).toEqual(["edge-kind-not-allowed"]);
    expect(issues[0]?.path).toBe("edges[0]");
  });

  it("rejects an edge without a valid provenance", () => {
    const edge = {
      edge: "invocation",
      from: "demo:acme/Order",
      to: "demo:acme/Tax",
      anchor: { file: "Demo.java", span: [1, 1] },
    } as unknown as Edge;
    expect(codes(validateModel(model([validClass], [edge]), demo))).toEqual(["missing-provenance"]);
  });

  it("accepts an id redeclared identically (declaration merging, partial classes)", () => {
    const again = entity("demo:acme/Order", "class", ["TType", "TNamed"], {
      name: "Order",
      isStub: false,
    });
    expect(validateModel(model([validClass, again], []), demo)).toEqual([]);
  });

  it("rejects an id redeclared with a different kind or trait set", () => {
    const conflicting = entity("demo:acme/Order", "method", ["TNamed", "TInvocable"], {
      name: "Order",
      signature: "Order()",
    });
    const issues = validateModel(model([validClass, conflicting], []), demo);
    expect(codes(issues)).toEqual(["duplicate-entity-id"]);
    expect(issues[0]?.path).toBe("demo:acme/Order");
  });

  it("reports a duplicate id only once", () => {
    const a = entity("demo:acme/Order", "method", ["TNamed", "TInvocable"], {
      name: "Order",
      signature: "Order()",
    });
    const b = entity("demo:acme/Order", "method", ["TNamed", "TInvocable"], {
      name: "Order",
      signature: "Order()",
    });
    expect(codes(validateModel(model([validClass, a, b], []), demo))).toEqual([
      "duplicate-entity-id",
    ]);
  });

  it("rejects a model validated against another language's profile", () => {
    const issues = validateModel(model([validClass], [], "other"), demo);
    expect(codes(issues)).toEqual(["profile-lang-mismatch"]);
    expect(issues[0]?.path).toBe("lang");
  });

  it("does not check graph closure — stubs and unknown targets are analyzer business", () => {
    const dangling = model([validClass], [invocation("demo:acme/Order", "demo:jdk/Unknown")]);
    expect(validateModel(dangling, demo)).toEqual([]);
  });
});

describe("validateProfile", () => {
  it("accepts a profile built from the canonical vocabularies", () => {
    expect(validateProfile(demo)).toEqual([]);
  });

  it("rejects trait and edge names outside the canonical vocabularies", () => {
    const bogus = {
      lang: "bogus",
      kinds: { class: { required: ["TNamedd"], optional: [] } },
      edges: ["calls"],
    } as unknown as Profile;
    expect(codes(validateProfile(bogus)).sort()).toEqual(["unknown-edge-kind", "unknown-trait"]);
  });

  it("rejects a trait declared both required and optional", () => {
    const overlapping: Profile = {
      lang: "demo",
      kinds: { class: { required: ["TNamed"], optional: ["TNamed"] } },
      edges: [],
    };
    const issues = validateProfile(overlapping);
    expect(codes(issues)).toEqual(["required-optional-overlap"]);
    expect(issues[0]?.path).toBe("kinds.class");
  });
});
