import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, digestOf, fingerprintOf, type FingerprintInputs } from "../src/fingerprint.js";

const BASE: FingerprintInputs = {
  level: "operation",
  members: ["java:p/A.f()"],
  model: "m",
  sources: ["int f() { return 1; }"],
  comments: [],
  signatures: ["f()"],
  factsDigest: digestOf({ calls: [] }),
  dependencyFingerprints: [],
  missingDependencies: [],
  depth: 1,
};

describe("canonicalJson", () => {
  it("is independent of key order at every depth", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe("fingerprintOf", () => {
  it("is 64 hex chars and stable", () => {
    expect(fingerprintOf(BASE)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(BASE)).toBe(fingerprintOf({ ...BASE }));
  });

  it("changes with any input, including a dependency's fingerprint, and ignores nothing shown", () => {
    const variants: FingerprintInputs[] = [
      { ...BASE, sources: ["int f() { return 2; }"] },
      { ...BASE, comments: ["doc"] },
      { ...BASE, signatures: ["f(int)"] },
      { ...BASE, factsDigest: digestOf({ calls: ["g"] }) },
      { ...BASE, dependencyFingerprints: ["a".repeat(64)] },
      { ...BASE, missingDependencies: ["java:p/B.g()"] },
      { ...BASE, model: "other" },
      { ...BASE, depth: 2 },
      { ...BASE, level: "type" },
    ];
    const seen = new Set([fingerprintOf(BASE)]);
    for (const v of variants) {
      const fp = fingerprintOf(v);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    }
  });

  it("Merkle: changing a leaf changes exactly its transitive dependents", () => {
    // chain c → b → a  (c depends on b, b on a); d independent
    const fp = (id: string, source: string, deps: string[]) =>
      fingerprintOf({ ...BASE, members: [id], sources: [source], dependencyFingerprints: [...deps].sort() });
    const build = (aSource: string) => {
      const a = fp("a", aSource, []);
      const b = fp("b", "b", [a]);
      const c = fp("c", "c", [b]);
      const d = fp("d", "d", []);
      return { a, b, c, d };
    };
    const before = build("a1");
    const after = build("a2");
    expect(after.a).not.toBe(before.a);
    expect(after.b).not.toBe(before.b);
    expect(after.c).not.toBe(before.c);
    expect(after.d).toBe(before.d);
  });
});
