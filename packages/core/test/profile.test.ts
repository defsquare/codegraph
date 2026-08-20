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

  // METAMODEL.md §6 / PLAN.md §5.2: a stub stands for a type outside the corpus
  // and is degraded by construction, so it cannot satisfy a kind's full required
  // set. Exempting it from the lower bound is what makes stubs representable.
  it("exempts a stub from required traits it cannot possibly carry", () => {
    const strict: Profile = {
      lang: "demo",
      kinds: {
        class: {
          required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
          optional: ["TComment"],
        },
      },
      edges: [],
    };
    const stub = entity("demo:jdk/String", "class", ["TNamed", "TType"], {
      name: "String",
      isStub: true,
    });
    expect(validateEntity(strict, stub)).toEqual([]);
  });

  it("still holds a NON-stub of the same kind to its full required set", () => {
    const strict: Profile = {
      lang: "demo",
      kinds: {
        class: {
          required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
          optional: ["TComment"],
        },
      },
      edges: [],
    };
    const internal = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
      name: "Order",
      isStub: false,
    });
    expect(codes(validateEntity(strict, internal))).toEqual([
      "missing-required-trait",
      "missing-required-trait",
      "missing-required-trait",
    ]);
  });

  it("still applies the upper bound to a stub — it may not carry unlicensed traits", () => {
    const stubWithExtra = entity(
      "demo:jdk/String",
      "class",
      ["TNamed", "TType", "TInvocable"],
      { name: "String", isStub: true, signature: "String()" },
    );
    expect(codes(validateEntity(demo, stubWithExtra))).toEqual(["trait-not-allowed"]);
  });

  // METAMODEL §1.4: the type/value split is "only meaningful in profiles that
  // declare it". A profile that omits `space` licenses none — which is what
  // makes the sentence enforceable rather than decorative.
  describe("declaration space (METAMODEL §1.4)", () => {
    const spaced: Profile = {
      ...demo,
      space: { class: ["type", "value"], method: ["value"] },
    };

    it("accepts a space the profile licenses for that kind", () => {
      const cls = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
        name: "Order",
        isStub: false,
        space: ["type"],
      });
      expect(validateEntity(spaced, cls)).toEqual([]);
    });

    it("rejects a space the profile does not license for that kind", () => {
      const m = entity("demo:acme/Order.bill()", "method", ["TNamed", "TInvocable"], {
        name: "bill",
        signature: "bill()",
        space: ["type"],
      });
      const issues = validateEntity(spaced, m);
      expect(codes(issues)).toEqual(["space-not-allowed"]);
      expect(issues[0]?.message).toContain("type");
    });

    it("rejects any space at all in a profile that declares none", () => {
      const cls = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
        name: "Order",
        isStub: false,
        space: ["value"],
      });
      expect(codes(validateEntity(demo, cls))).toEqual(["space-not-allowed"]);
    });

    it("says nothing about an entity that omits space", () => {
      expect(validateEntity(spaced, validClass)).toEqual([]);
    });
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

  it("rejects a space entry for a kind the profile does not declare", () => {
    const stray: Profile = {
      lang: "demo",
      kinds: { class: { required: ["TNamed"], optional: [] } },
      edges: [],
      space: { interface: ["type"] },
    };
    const issues = validateProfile(stray);
    expect(codes(issues)).toEqual(["unknown-space-kind"]);
    expect(issues[0]?.path).toBe("space.interface");
  });

  it("rejects a declaration space outside the canonical vocabulary", () => {
    const bogus = {
      lang: "demo",
      kinds: { class: { required: ["TNamed"], optional: [] } },
      edges: [],
      space: { class: ["runtime"] },
    } as unknown as Profile;
    expect(codes(validateProfile(bogus))).toEqual(["unknown-space-kind"]);
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

/**
 * MM-4: profile validity is a function of `(kind, trait set)`, so the verdict
 * is computed once per distinct pair and shared. These tests exist for the
 * failure modes memoization ADDS — a verdict leaking across entities, across
 * the stub boundary, or across profiles — none of which the rules themselves
 * could ever exhibit.
 */
describe("verdicts are shared per (kind, trait set), never across their bounds", () => {
  it("names each entity in its own issues on a cache hit", () => {
    const first = entity("demo:acme/A", "class", ["TNamed"], { name: "A" });
    const second = entity("demo:acme/B", "class", ["TNamed"], { name: "B" });

    const one = validateEntity(demo, first);
    const two = validateEntity(demo, second);
    expect(codes(one)).toEqual(["missing-required-trait"]);
    expect(codes(two)).toEqual(["missing-required-trait"]);
    // The shared half is the verdict, not the subject.
    expect(one[0]!.path).toBe("demo:acme/A");
    expect(two[0]!.path).toBe("demo:acme/B");
    expect(one[0]!.message).toBe(two[0]!.message);
  });

  it("does not let a stub's exemption leak to a non-stub with the same traits", () => {
    const strict: Profile = {
      lang: "demo",
      kinds: { class: { required: ["TNamed", "TType", "TSourceAnchor"], optional: [] } },
      edges: [],
    };
    const traits: TraitName[] = ["TNamed", "TType"];
    const stub = entity("demo:jdk/String", "class", traits, { name: "String", isStub: true });
    const internal = entity("demo:acme/Order", "class", traits, { name: "Order", isStub: false });

    // Stub first, so a verdict keyed on (kind, traits) alone would wrongly
    // exempt the internal type on the second lookup — and the other way round.
    expect(validateEntity(strict, stub)).toEqual([]);
    expect(codes(validateEntity(strict, internal))).toEqual(["missing-required-trait"]);
    expect(validateEntity(strict, stub)).toEqual([]);
  });

  it("does not share verdicts between two profiles that name the same kind", () => {
    const lenient: Profile = {
      lang: "demo",
      kinds: { class: { required: ["TNamed"], optional: ["TType"] } },
      edges: [],
    };
    const strict: Profile = {
      lang: "demo",
      kinds: { class: { required: ["TNamed", "TType", "TSourceAnchor"], optional: [] } },
      edges: [],
    };
    const subject = entity("demo:acme/Order", "class", ["TNamed", "TType"], {
      name: "Order",
      isStub: false,
    });

    expect(validateEntity(lenient, subject)).toEqual([]);
    expect(codes(validateEntity(strict, subject))).toEqual(["missing-required-trait"]);
    expect(validateEntity(lenient, subject)).toEqual([]);
  });

  it("reaches the same verdict however the trait array is ordered", () => {
    const forward = entity("demo:acme/A", "class", ["TNamed", "TType", "TInvocable"], {
      name: "A",
      isStub: false,
      signature: "A()",
    });
    const backward = entity("demo:acme/B", "class", ["TInvocable", "TType", "TNamed"], {
      name: "B",
      isStub: false,
      signature: "B()",
    });
    expect(codes(validateEntity(demo, forward))).toEqual(["trait-not-allowed"]);
    expect(codes(validateEntity(demo, backward))).toEqual(["trait-not-allowed"]);
  });

  it("still checks trait KEYS per entity — the values differ even when the set does not", () => {
    const traits: TraitName[] = ["TNamed", "TType"];
    const wellFormed = entity("demo:acme/A", "class", traits, { name: "A", isStub: false });
    const nameless = entity("demo:acme/B", "class", traits, { isStub: false });

    expect(validateEntity(demo, wellFormed)).toEqual([]);
    expect(codes(validateEntity(demo, nameless))).toEqual(["trait-keys-invalid"]);
  });
});
