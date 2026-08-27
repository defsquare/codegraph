import { describe, expect, it } from "vitest";
import { Literal, NamedArgument, literalReferences } from "../src/literal.js";

/**
 * The value door (METAMODEL §1.6). A Literal is what the SOURCE WRITES at a
 * declaration — an annotation argument, a constant initializer, a default —
 * and never runtime state. The tests below pin the two rules that make it
 * usable: the tag set is closed, and every id inside a value counts for
 * closure exactly like an edge endpoint.
 */

const enumValue = { k: "enum", type: "java:java.lang.annotation/RetentionPolicy", name: "RUNTIME" };

describe("Literal", () => {
  it("accepts every form §1.6 declares", () => {
    const forms: unknown[] = [
      { k: "string", v: "monthly" },
      { k: "string", v: "" },
      { k: "number", v: "9223372036854775807" },
      { k: "boolean", v: false },
      { k: "null" },
      enumValue,
      { k: "type", type: "java:com.acme.order/Money" },
      { k: "array", items: [{ k: "string", v: "a" }, { k: "string", v: "b" }] },
      { k: "annotation", type: "java:com.acme.order/Audited", arguments: [] },
      { k: "unevaluated", source: "LedgerClient.AUDIT_TAG" },
    ];
    for (const form of forms) {
      expect(Literal.safeParse(form).success, JSON.stringify(form)).toBe(true);
    }
  });

  it("refuses a tag outside the closed vocabulary", () => {
    expect(Literal.safeParse({ k: "lambda", v: "() -> 1" }).success).toBe(false);
    expect(Literal.safeParse({ v: "no tag" }).success).toBe(false);
  });

  /**
   * A JSON number cannot hold a Java `long`: 9223372036854775807 parses back as
   * 9223372036854776000. The value travels as canonical decimal TEXT, and the
   * declared type is what says how to read it.
   */
  it("carries a number as text, so a long survives the wire", () => {
    const long = "9223372036854775807";
    const parsed = Literal.parse({ k: "number", v: long });
    expect(parsed).toEqual({ k: "number", v: long });
    expect(String(Number(long))).not.toBe(long);
    // A number-shaped JSON value is not a number literal — the form is the text.
    expect(Literal.safeParse({ k: "number", v: 42 }).success).toBe(false);
  });

  it("accepts the decimal forms a compiler produces, and refuses prose", () => {
    for (const v of ["0", "-1", "1.5", "1.0E10", "-2.5e-3", "Infinity", "-Infinity", "NaN"]) {
      expect(Literal.safeParse({ k: "number", v }).success, v).toBe(true);
    }
    for (const v of ["", "0x1F", "12L", "one", "1_000"]) {
      expect(Literal.safeParse({ k: "number", v }).success, v).toBe(false);
    }
  });

  it("keeps an enum as a type reference plus a NAME — a member is never fabricated", () => {
    const parsed = Literal.parse(enumValue);
    expect(parsed).toEqual(enumValue);
    // §6 verbatim: the value names the constant, it does not point at one.
    expect(Literal.safeParse({ k: "enum", type: "java:x/E" }).success).toBe(false);
    expect(Literal.safeParse({ k: "enum", name: "RUNTIME" }).success).toBe(false);
  });

  it("nests: an array of annotations, each with arguments of its own", () => {
    const nested = {
      k: "array",
      items: [
        {
          k: "annotation",
          type: "java:com.acme.order/Audited",
          arguments: [
            { name: "value", value: { k: "string", v: "x" } },
            { name: "tags", value: { k: "array", items: [{ k: "null" }] } },
          ],
        },
      ],
    };
    expect(Literal.parse(nested)).toEqual(nested);
  });

  it("requires every argument to be named — an implicit name is normalized by the producer", () => {
    expect(NamedArgument.safeParse({ name: "value", value: { k: "null" } }).success).toBe(true);
    expect(NamedArgument.safeParse({ value: { k: "null" } }).success).toBe(false);
    expect(NamedArgument.safeParse({ name: "", value: { k: "null" } }).success).toBe(false);
  });
});

describe("literalReferences", () => {
  it("finds every id a value points at, wherever it is nested", () => {
    const value = Literal.parse({
      k: "array",
      items: [
        { k: "type", type: "java:a/A" },
        { k: "enum", type: "java:a/E", name: "ONE" },
        {
          k: "annotation",
          type: "java:a/Ann",
          arguments: [{ name: "value", value: { k: "type", type: "java:a/B" } }],
        },
        { k: "string", v: "not an id" },
      ],
    });
    expect(literalReferences(value)).toEqual([
      { path: ".items[0].type", id: "java:a/A" },
      { path: ".items[1].type", id: "java:a/E" },
      { path: ".items[2].type", id: "java:a/Ann" },
      { path: ".items[2].arguments[0].value.type", id: "java:a/B" },
    ]);
  });

  it("finds nothing in a value that names nothing", () => {
    expect(literalReferences(Literal.parse({ k: "unevaluated", source: "X.Y" }))).toEqual([]);
    expect(literalReferences(Literal.parse({ k: "null" }))).toEqual([]);
  });
});
