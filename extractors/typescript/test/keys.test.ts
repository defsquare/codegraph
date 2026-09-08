import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareKeys,
  disambiguated,
  escapeName,
  escapePath,
  keyIndex,
  memberKey,
  moduleKey,
  renderKey,
  unescape,
} from "../src/model/keys.js";

/**
 * The id scheme's escaping (PLAN.md §14.3): a file path is made of `/`, which
 * the rendered id reserves, so every key component percent-encodes exactly
 * `/`, `#`, `%` — and `.` in names. Injective and reversible, as a property.
 */
describe("key escaping", () => {
  it("encodes the three reserved characters in a path and leaves everything else alone", () => {
    expect(escapePath("src/acme/order.ts")).toBe("src%2Facme%2Forder.ts");
    expect(escapePath("promo#2024.ts")).toBe("promo%232024.ts");
    expect(escapePath("50%off.ts")).toBe("50%25off.ts");
    expect(escapePath("résumé.ts")).toBe("résumé.ts");
  });

  it("encodes `.` in a name, so a string-literal member never reads as nesting", () => {
    expect(escapeName("as.text")).toBe("as%2Etext");
    expect(escapeName("#secret")).toBe("%23secret");
    expect(escapeName("[Symbol.iterator]")).toBe("[Symbol%2Eiterator]");
    expect(escapeName("plainIdentifier$1")).toBe("plainIdentifier$1");
  });

  it("round-trips any string, path and name alike", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(unescape(escapePath(text))).toBe(text);
        expect(unescape(escapeName(text))).toBe(text);
      }),
    );
  });

  it("is injective: distinct paths never escape to one key", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(escapePath(a)).not.toBe(escapePath(b));
        expect(escapeName(a)).not.toBe(escapeName(b));
      }),
    );
  });

  it("never lets a reserved separator into a module or a `#` into a symbol", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(escapePath(text)).not.toMatch(/[/#]/);
        expect(escapeName(text)).not.toMatch(/[/#.]/);
      }),
    );
  });
});

describe("key shapes", () => {
  it("renders the display projection", () => {
    expect(renderKey(moduleKey("src%2Fa.ts"))).toBe("ts:src%2Fa.ts");
    expect(renderKey(memberKey(moduleKey("src%2Fa.ts"), "Order"))).toBe("ts:src%2Fa.ts/Order");
    expect(renderKey(memberKey(memberKey(moduleKey("m"), "Order"), "bill"))).toBe("ts:m/Order.bill");
    expect(renderKey(disambiguated(memberKey(moduleKey("m"), "f"), "12:7"))).toBe("ts:m/f#12:7");
    expect(renderKey(disambiguated(moduleKey("m"), "3:15"))).toBe("ts:m#3:15");
  });

  it("nests a disambiguator below the owner's own", () => {
    const arrow = disambiguated(memberKey(moduleKey("m"), "f"), "12:7");
    expect(renderKey(disambiguated(arrow, "param:x"))).toBe("ts:m/f#12:7#param:x");
  });

  it("orders by component, an absent disambiguator first, by code unit", () => {
    const keys = [
      disambiguated(memberKey(moduleKey("m"), "f"), "3:1"),
      memberKey(moduleKey("m"), "f"),
      moduleKey("m"),
      memberKey(moduleKey("a"), "z"),
      memberKey(moduleKey("m"), "F"),
    ];
    expect([...keys].sort(compareKeys).map(renderKey)).toEqual([
      "ts:a/z",
      "ts:m",
      "ts:m/F",
      "ts:m/f",
      "ts:m/f#3:1",
    ]);
  });

  it("indexes injectively: absent and present disambiguators never collide", () => {
    expect(keyIndex(moduleKey("m"))).not.toBe(keyIndex(disambiguated(moduleKey("m"), "x")));
    expect(keyIndex(memberKey(moduleKey("m"), "a"))).not.toBe(keyIndex(moduleKey("m.a")));
  });
});
