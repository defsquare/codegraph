import { describe, expect, it } from "vitest";

import {
  NaturalKey,
  compareNaturalKeys,
  duplicateNaturalKeys,
  naturalKeyIndex,
  naturalKeyIssues,
  naturalKeysEqual,
  renderId,
  sortByNaturalKey,
} from "../src/identity.js";

/**
 * METAMODEL.md §1.1 / MM-1. Identity is the tuple; the rendered id is a display
 * projection. The tests that matter here are the ones that keep the projection
 * honest: it must reproduce the frozen Java id scheme exactly, and it must
 * never map two distinct keys onto one string.
 */

const NUL = "\u0000";

describe("renderId reproduces the frozen id scheme (EntityIds.java)", () => {
  it("renders a module as itself, with no symbol part", () => {
    expect(renderId({ lang: "java", module: "com.acme.order", symbol: "" })).toBe(
      "java:com.acme.order",
    );
    expect(renderId({ lang: "java", module: "<unnamed>", symbol: "" })).toBe("java:<unnamed>");
  });

  it("renders types, nested types and members", () => {
    const cases: [NaturalKey, string][] = [
      [
        { lang: "java", module: "com.acme.order", symbol: "OrderService" },
        "java:com.acme.order/OrderService",
      ],
      [
        { lang: "java", module: "com.acme.order", symbol: "OrderService.Inner" },
        "java:com.acme.order/OrderService.Inner",
      ],
      [
        {
          lang: "java",
          module: "com.acme.order",
          symbol: "OrderService.bill(com.acme.order.Order)",
        },
        "java:com.acme.order/OrderService.bill(com.acme.order.Order)",
      ],
      [
        { lang: "java", module: "com.acme.order", symbol: "OrderService.<init>()" },
        "java:com.acme.order/OrderService.<init>()",
      ],
    ];
    for (const [key, rendered] of cases) expect(renderId(key)).toBe(rendered);
  });

  it("renders anonymous entities, parameters and locals through the disambiguator", () => {
    expect(
      renderId({
        lang: "java",
        module: "com.acme.order",
        symbol: "OrderService",
        disambiguator: "src/main/java/OrderService.java:42",
      }),
    ).toBe("java:com.acme.order/OrderService#src/main/java/OrderService.java:42");

    expect(
      renderId({
        lang: "java",
        module: "com.acme.order",
        symbol: "OrderService.bill(com.acme.order.Order)",
        disambiguator: "param:order",
      }),
    ).toBe("java:com.acme.order/OrderService.bill(com.acme.order.Order)#param:order");

    expect(
      renderId({
        lang: "java",
        module: "com.acme.order",
        symbol: "OrderService.bill(com.acme.order.Order)",
        disambiguator: "local:total:19",
      }),
    ).toBe("java:com.acme.order/OrderService.bill(com.acme.order.Order)#local:total:19");
  });

  it("keeps the M2 overload pair apart — the collision the FQN form exists for", () => {
    const utilList = renderId({
      lang: "java",
      module: "com.acme.order",
      symbol: "Archive.archive(java.util.List)",
    });
    const legacyList = renderId({
      lang: "java",
      module: "com.acme.order",
      symbol: "Archive.archive(com.acme.order.legacy.List)",
    });
    expect(utilList).not.toBe(legacyList);
  });
});

describe("a malformed key is refused rather than rendered", () => {
  const bad: [string, NaturalKey][] = [
    ["a lang carrying the lang/module separator", { lang: "ja:va", module: "m", symbol: "s" }],
    ["a module carrying the module/symbol separator", { lang: "java", module: "a/b", symbol: "s" }],
    ["a module carrying the disambiguator separator", { lang: "java", module: "a#b", symbol: "s" }],
    ["a symbol carrying the disambiguator separator", { lang: "java", module: "m", symbol: "a#b" }],
    ["an empty lang", { lang: "", module: "m", symbol: "s" }],
    ["an empty module", { lang: "java", module: "", symbol: "s" }],
    [
      "a present-but-empty disambiguator",
      { lang: "java", module: "m", symbol: "s", disambiguator: "" },
    ],
    [
      "a NUL anywhere (the index separator)",
      { lang: "java", module: `m${NUL}x`, symbol: "s" },
    ],
  ];

  for (const [why, key] of bad) {
    it(`rejects ${why}`, () => {
      expect(naturalKeyIssues(key).length).toBeGreaterThan(0);
      expect(() => renderId(key)).toThrow(/malformed natural key/);
      expect(NaturalKey.safeParse(key).success).toBe(false);
    });
  }

  it("accepts what the extractor actually emits", () => {
    const real: NaturalKey[] = [
      { lang: "java", module: "com.acme.order", symbol: "" },
      { lang: "java", module: "java.util", symbol: "List" },
      { lang: "java", module: "m", symbol: "T.m(int[],java.lang.String)" },
      { lang: "java", module: "m", symbol: "T", disambiguator: "a/b/C.java:7" },
    ];
    for (const key of real) {
      expect(naturalKeyIssues(key)).toEqual([]);
      expect(NaturalKey.safeParse(key).success).toBe(true);
    }
  });
});

/**
 * Injectivity, exhaustively over an alphabet built from the separators
 * themselves — the only inputs that could collide. A random-string check would
 * essentially never produce a collision even if rendering were broken.
 */
describe("rendering is injective over the nastiest legal components", () => {
  // The pieces overlap on purpose: `a`, `b` and every concatenation of them
  // (`a.b`, `a/b`, `ab`) all appear, so any separator that is not reserved —
  // or a separator dropped altogether — produces a REACHABLE collision. An
  // alphabet of unrelated words would let a broken renderer pass.
  const langs = ["java", "a", "b", "a.b", "ab"];
  const modules = ["m", "a", "b", "a.b", "ab", "<unnamed>", "m:x", "m(x)"];
  const symbols = ["", "a", "b", "a.b", "a/b", "ab", "S.m(a.b.C)", "a:b"];
  const disambiguators = [undefined, "a", "b", "a.b", "F.java:1", "x#y"];

  const keys: NaturalKey[] = [];
  for (const lang of langs)
    for (const module of modules)
      for (const symbol of symbols)
        for (const disambiguator of disambiguators) keys.push({ lang, module, symbol, disambiguator });

  it("never maps two distinct keys onto one rendered id", () => {
    const rendered = new Set(keys.map(renderId));
    expect(rendered.size).toBe(keys.length);
  });

  it("never maps two distinct keys onto one index", () => {
    const indexed = new Set(keys.map(naturalKeyIndex));
    expect(indexed.size).toBe(keys.length);
  });

  it("distinguishes an absent disambiguator from any present one", () => {
    const absent = { lang: "java", module: "m", symbol: "s" };
    const present = { lang: "java", module: "m", symbol: "s", disambiguator: "d" };
    expect(naturalKeysEqual(absent, present)).toBe(false);
    expect(naturalKeyIndex(absent)).not.toBe(naturalKeyIndex(present));
    expect(renderId(absent)).not.toBe(renderId(present));
  });
});

describe("canonical order is defined on the key, not on the rendered string", () => {
  it("orders component by component", () => {
    const keys: NaturalKey[] = [
      { lang: "java", module: "b", symbol: "a" },
      { lang: "clj", module: "z", symbol: "a" },
      { lang: "java", module: "a", symbol: "z" },
      { lang: "java", module: "b", symbol: "a", disambiguator: "d" },
    ];
    expect(sortByNaturalKey(keys, (k) => k).map(renderId)).toEqual([
      "clj:z/a",
      "java:a/z",
      "java:b/a",
      "java:b/a#d",
    ]);
  });

  /**
   * Every component participates in identity, and therefore in the order.
   * Exhaustive over the four rather than generative: a random pair almost never
   * differs in exactly one component, so a comparator that silently ignores one
   * would keep passing.
   */
  it("separates two keys that differ in exactly one component", () => {
    const base: NaturalKey = { lang: "java", module: "m", symbol: "s", disambiguator: "d" };
    const perturbations: NaturalKey[] = [
      { ...base, lang: "clj" },
      { ...base, module: "n" },
      { ...base, symbol: "t" },
      { ...base, disambiguator: "e" },
      { ...base, disambiguator: undefined },
    ];
    for (const other of perturbations) {
      expect(naturalKeysEqual(base, other)).toBe(false);
      expect(compareNaturalKeys(base, other)).not.toBe(0);
      expect(renderId(base)).not.toBe(renderId(other));
      expect(naturalKeyIndex(base)).not.toBe(naturalKeyIndex(other));
    }
  });

  it("puts a missing disambiguator before any present one", () => {
    const bare: NaturalKey = { lang: "java", module: "m", symbol: "s" };
    const marked: NaturalKey = { lang: "java", module: "m", symbol: "s", disambiguator: "a" };
    expect(compareNaturalKeys(bare, marked)).toBeLessThan(0);
    expect(compareNaturalKeys(marked, bare)).toBeGreaterThan(0);
    expect(compareNaturalKeys(bare, { ...bare })).toBe(0);
  });

  /**
   * The reason the order is defined on the key at all: once `/` and `.` are
   * ordinary characters, sorting rendered ids answers a different question.
   */
  it("disagrees with sorting the rendered ids as strings", () => {
    const deep: NaturalKey = { lang: "java", module: "m.x", symbol: "a" };
    const shallow: NaturalKey = { lang: "java", module: "m", symbol: "z" };
    expect(compareNaturalKeys(shallow, deep)).toBeLessThan(0);
    expect(renderId(shallow) < renderId(deep)).toBe(false);
  });

  it("sorts a copy — the input is never mutated", () => {
    const keys: NaturalKey[] = [
      { lang: "java", module: "z", symbol: "" },
      { lang: "java", module: "a", symbol: "" },
    ];
    const before = [...keys];
    sortByNaturalKey(keys, (k) => k);
    expect(keys).toEqual(before);
  });
});

describe("natural-key uniqueness (MM-1)", () => {
  it("reports every claimant of a shared key, and nothing else", () => {
    const keys: NaturalKey[] = [
      { lang: "java", module: "m", symbol: "A" },
      { lang: "java", module: "m", symbol: "B" },
      { lang: "java", module: "m", symbol: "A" },
      { lang: "java", module: "m", symbol: "A", disambiguator: "d" },
      { lang: "java", module: "m", symbol: "A" },
    ];
    const duplicates = duplicateNaturalKeys(keys);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.key.symbol).toBe("A");
    expect(duplicates[0]!.positions).toEqual([0, 2, 4]);
  });

  it("treats keys differing only by disambiguator as distinct", () => {
    expect(
      duplicateNaturalKeys([
        { lang: "java", module: "m", symbol: "T", disambiguator: "F.java:1" },
        { lang: "java", module: "m", symbol: "T", disambiguator: "F.java:2" },
      ]),
    ).toEqual([]);
  });

  it("says nothing about a key set that is already unique", () => {
    expect(
      duplicateNaturalKeys([
        { lang: "java", module: "m", symbol: "" },
        { lang: "java", module: "m", symbol: "T" },
        { lang: "java", module: "m.x", symbol: "T" },
      ]),
    ).toEqual([]);
  });
});
