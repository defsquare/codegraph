import { describe, expect, it } from "vitest";
import { EDGE_KINDS, TRAIT_NAMES } from "../src/names.js";
import { SPACES } from "../src/primitives.js";
import { Entity } from "../src/entity.js";
import { parseModel, SCHEMA_VERSION } from "../src/model.js";
import { validateEntity, validateModel, validateProfile, type Profile } from "../src/profile.js";
import { PROFILES, clojureProfile, getProfile, typescriptProfile } from "../src/profiles/index.js";

// Profiles are data; this suite is the check that the data stays inside the
// canonical vocabularies and keeps saying what each language actually is.
const profiles: readonly [string, Profile][] = Object.entries(PROFILES).sort(([a], [b]) =>
  a.localeCompare(b),
);

// The lang id is the EntityId prefix (METAMODEL.md §1.1), so it is part of the
// published contract: changing one invalidates every id an extractor emitted.
const EXPECTED_LANGS = [
  "clj",
  "csharp",
  "go",
  "java",
  "js",
  "php",
  "python",
  "rust",
  "ts",
] as const;

describe("the nine shipped profiles", () => {
  it("registers exactly nine profiles under unique langs", () => {
    expect(profiles).toHaveLength(9);
    expect(profiles.map(([lang]) => lang)).toEqual([...EXPECTED_LANGS].sort());
  });

  it("keys the registry by each profile's own lang", () => {
    for (const [lang, profile] of profiles) {
      expect(profile.lang).toBe(lang);
      expect(getProfile(lang)).toBe(profile);
    }
  });

  it("resolves nothing for an unknown lang, including Object.prototype names", () => {
    expect(getProfile("cobol")).toBeUndefined();
    expect(getProfile("constructor")).toBeUndefined();
    expect(getProfile("toString")).toBeUndefined();
  });

  it.each(profiles)("%s is valid against the canonical vocabularies", (_lang, profile) => {
    expect(validateProfile(profile)).toEqual([]);
  });

  it.each(profiles)("%s declares at least one kind and one edge kind", (_lang, profile) => {
    expect(Object.keys(profile.kinds).length).toBeGreaterThan(0);
    expect(profile.edges.length).toBeGreaterThan(0);
  });

  it.each(profiles)("%s uses only canonical trait names", (_lang, profile) => {
    const known = new Set<string>(TRAIT_NAMES);
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      for (const trait of [...spec.required, ...spec.optional]) {
        expect(known, `${profile.lang}.${kind}: ${trait}`).toContain(trait);
      }
    }
  });

  it.each(profiles)("%s uses only canonical edge kinds", (_lang, profile) => {
    const known = new Set<string>(EDGE_KINDS);
    for (const edge of profile.edges) {
      expect(known, `${profile.lang}: ${edge}`).toContain(edge);
    }
  });

  it.each(profiles)("%s never lists a trait as both required and optional", (_lang, profile) => {
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      const required = new Set<string>(spec.required);
      const overlap = spec.optional.filter((trait) => required.has(trait));
      expect(overlap, `${profile.lang}.${kind}`).toEqual([]);
    }
  });

  it.each(profiles)("%s lists no duplicate traits or edge kinds", (_lang, profile) => {
    for (const [kind, spec] of Object.entries(profile.kinds)) {
      expect(new Set(spec.required).size, `${profile.lang}.${kind}.required`).toBe(
        spec.required.length,
      );
      expect(new Set(spec.optional).size, `${profile.lang}.${kind}.optional`).toBe(
        spec.optional.length,
      );
    }
    expect(new Set(profile.edges).size, `${profile.lang}.edges`).toBe(profile.edges.length);
  });

  it.each(profiles)("%s documents its static-analysis blind spots", (_lang, profile) => {
    expect(profile.notes?.length ?? 0).toBeGreaterThan(0);
  });
});

// These are claims about the languages themselves. They must fail loudly if a
// later edit "tidies" a profile into saying something the language does not do.
describe("structural claims that must not silently regress", () => {
  it("Go has no inheritance — neither the edge kind nor the trait", () => {
    const go = PROFILES["go"];
    expect(go).toBeDefined();
    expect(go?.edges).not.toContain("inheritance");
    for (const spec of Object.values(go?.kinds ?? {})) {
      expect([...spec.required, ...spec.optional]).not.toContain("TWithInheritances");
    }
  });

  it("Go carries composition as embedding and attaches methods to their receiver", () => {
    const go = PROFILES["go"];
    expect(go?.edges).toContain("embedding");
    expect(go?.kinds["method"]?.required).toContain("TAttachedTo");
    expect(go?.kinds["method"]?.required).toContain("TChildOf");
  });

  it("Rust has no inheritance — neither the edge kind nor the trait", () => {
    const rust = PROFILES["rust"];
    expect(rust).toBeDefined();
    expect(rust?.edges).not.toContain("inheritance");
    for (const spec of Object.values(rust?.kinds ?? {})) {
      expect([...spec.required, ...spec.optional]).not.toContain("TWithInheritances");
    }
  });

  it("Rust reifies the impl block: attached, anonymous, owning its methods (METAMODEL §7)", () => {
    const impl = PROFILES["rust"]?.kinds["impl"];
    expect(impl).toBeDefined();
    expect(impl?.required).toContain("TAttachedTo");
    expect(impl?.required).toContain("TWithChildren");
    expect(impl?.required).toContain("TSourceAnchor");
    expect([...(impl?.required ?? []), ...(impl?.optional ?? [])]).not.toContain("TNamed");
  });

  it("Clojure licenses the composition no hierarchy can express (METAMODEL §3.7)", () => {
    const clj = PROFILES["clj"];
    expect(clj).toBeDefined();
    const wanted = ["TNamed", "TStructural", "TInvocable"];
    // required ⊆ {TNamed,TStructural,TInvocable} ⊆ required ∪ optional.
    const licensing = Object.entries(clj?.kinds ?? {}).filter(([, spec]) => {
      const allowed = new Set<string>([...spec.required, ...spec.optional]);
      return (
        spec.required.every((trait) => wanted.includes(trait)) &&
        wanted.every((trait) => allowed.has(trait))
      );
    });
    expect(licensing.length).toBeGreaterThan(0);
  });

  // The declaration above says the profile ALLOWS the composition. This runs it:
  // a real fn-var entity, parsed by the Entity schema and validated against the
  // shipped Clojure profile. It is the acceptance case of the whole trait design
  // (METAMODEL §3.7, PLAN Phase 1 deliverable) and must never regress to a
  // profile-shape assertion.
  it("validates a real Clojure fn-var as TNamed + TStructural + TInvocable", () => {
    const clj = clojureProfile;
    const fnVar = Entity.parse({
      id: "clj:acme.order/bill",
      kind: "function",
      traits: ["TNamed", "TStructural", "TInvocable"],
      name: "bill",
      signature: "([order] [order opts])",
    });

    expect(validateEntity(clj, fnVar)).toEqual([]);

    // Named, value holder and invocable at once — and the trait set is exactly
    // the kind's required set, so nothing optional is propping it up.
    expect([...clj.kinds["function"]!.required].sort()).toEqual([
      "TInvocable",
      "TNamed",
      "TStructural",
    ]);

    // Dropping any one of the three breaks it: all three are load-bearing.
    for (const dropped of ["TNamed", "TStructural", "TInvocable"] as const) {
      const partial = {
        ...fnVar,
        traits: fnVar.traits.filter((t) => t !== dropped),
      } as unknown as Entity;
      expect(
        validateEntity(clj, partial).map((i) => i.code),
        `dropping ${dropped}`,
      ).toEqual(["missing-required-trait"]);
    }
  });

  it("carries the fn-var through a full model round-trip under its own profile", () => {
    const model = parseModel({
      schemaVersion: SCHEMA_VERSION,
      lang: "clj",
      extractor: { name: "clj-kondo-adapter", version: "0.0.0" },
      root: "/corpus",
      entities: [
        {
          id: "clj:acme.order/bill",
          kind: "function",
          traits: ["TNamed", "TStructural", "TInvocable"],
          name: "bill",
          signature: "([order])",
        },
        {
          id: "clj:acme.tax/apply-tax",
          kind: "function",
          traits: ["TNamed", "TStructural", "TInvocable"],
          name: "apply-tax",
          signature: "([amount])",
        },
      ],
      edges: [
        {
          edge: "invocation",
          from: "clj:acme.order/bill",
          to: "clj:acme.tax/apply-tax",
          provenance: "declared",
          anchor: { file: "src/acme/order.clj", span: [12, 12] },
        },
      ],
    });
    expect(validateModel(model, clojureProfile)).toEqual([]);
  });

  it("PHP is the only profile with fileInclude and traitUsage", () => {
    for (const [lang, profile] of profiles) {
      const expected = lang === "php";
      expect(profile.edges.includes("fileInclude"), `${lang}.fileInclude`).toBe(expected);
      expect(profile.edges.includes("traitUsage"), `${lang}.traitUsage`).toBe(expected);
    }
    expect(PROFILES["php"]?.kinds["codeFile"]).toBeDefined();
  });

  // Every language has external types (JDK, npm, crates.io, Composer…), so
  // every profile must be able to hold the canonical degraded stub of
  // METAMODEL §6 / PLAN §5.2 — otherwise that language cannot be extracted.
  it.each(profiles)("%s can represent the canonical TNamed+TType stub", (_lang, profile) => {
    const holders = Object.entries(profile.kinds).filter(([, spec]) => {
      const allowed = new Set<string>([...spec.required, ...spec.optional]);
      return allowed.has("TNamed") && allowed.has("TType");
    });
    expect(holders.length, `${profile.lang} has no kind licensing TNamed+TType`).toBeGreaterThan(0);

    for (const [kind] of holders) {
      const stub = {
        id: `${profile.lang}:external/Thing`,
        kind,
        traits: ["TNamed", "TType"],
        name: "Thing",
        isStub: true,
      } as unknown as Entity;
      expect(validateEntity(profile, stub), `${profile.lang}.${kind}`).toEqual([]);
    }
  });

  it("TypeScript is the only profile declaring declaration spaces (METAMODEL §1.4)", () => {
    for (const [lang, profile] of profiles) {
      if (lang === "ts") expect(profile.space, "ts must declare space").toBeDefined();
      else expect(profile.space, `${lang} must not declare space`).toBeUndefined();
    }
  });

  it("TypeScript's space map covers every kind, with type-only types", () => {
    const space = typescriptProfile.space ?? {};
    const known = new Set<string>(SPACES);
    for (const kind of Object.keys(typescriptProfile.kinds)) {
      const spaces = space[kind];
      expect(spaces, `ts.${kind} has no space`).toBeDefined();
      expect(spaces?.length ?? 0).toBeGreaterThan(0);
      for (const s of spaces ?? []) expect(known).toContain(s);
    }
    // The erasure claim: interfaces and type aliases leave nothing at runtime.
    expect(space["interface"]).toEqual(["type"]);
    expect(space["typeAlias"]).toEqual(["type"]);
    expect(space["class"]).toEqual(["type", "value"]);
    expect(space["function"]).toEqual(["value"]);
  });

  it("TypeScript's kinds are a strict superset of JavaScript's", () => {
    const js = Object.keys(PROFILES["js"]?.kinds ?? {});
    const ts = new Set(Object.keys(typescriptProfile.kinds));
    expect(js.length).toBeGreaterThan(0);
    for (const kind of js) expect(ts, `ts is missing js kind ${kind}`).toContain(kind);
    expect(ts.size).toBeGreaterThan(js.length);
  });
});
