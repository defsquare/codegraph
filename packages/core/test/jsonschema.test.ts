import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TRAIT_NAMES } from "../src/names.js";
import { MARKER_TRAITS } from "../src/traits.js";
import { SCHEMA_VERSION } from "../src/model.js";
import { modelJsonSchema, traitConditionals } from "../src/jsonschema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const committed = JSON.parse(
  readFileSync(join(repoRoot, "schemas", "model.schema.json"), "utf8"),
) as Record<string, unknown>;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => v as Obj;

function entityItems(schema: Obj): Obj {
  return asObj(asObj(asObj(schema["properties"])["entities"])["items"]);
}

function edgeVariants(schema: Obj): Obj[] {
  return asObj(asObj(asObj(schema["properties"])["edges"])["items"])["oneOf"] as Obj[];
}

describe("modelJsonSchema — the model envelope", () => {
  it("requires every field of METAMODEL §8", () => {
    const schema = modelJsonSchema();
    expect(schema["required"]).toEqual([
      "schemaVersion",
      "lang",
      "extractor",
      "root",
      "entities",
      "edges",
    ]);
    expect(schema["$id"]).toContain(SCHEMA_VERSION);
  });

  it("describes all nine edge kinds, each with provenance and anchor required", () => {
    const variants = edgeVariants(modelJsonSchema());
    const kinds = variants.map((v) => asObj(asObj(v["properties"])["edge"])["const"]);
    expect(kinds).toEqual([
      "import",
      "inheritance",
      "interfaceImplementation",
      "invocation",
      "access",
      "reference",
      "embedding",
      "traitUsage",
      "fileInclude",
    ]);
    for (const variant of variants) {
      const required = variant["required"] as string[];
      expect(required, JSON.stringify(asObj(variant["properties"])["edge"])).toEqual(
        expect.arrayContaining(["edge", "from", "to", "provenance", "anchor"]),
      );
      const provenance = asObj(asObj(variant["properties"])["provenance"]);
      expect(provenance["enum"]).toEqual([
        "declared",
        "derived",
        "dynamic-candidate",
        "generated",
      ]);
    }
  });

  it("only `access` adds isRead/isWrite", () => {
    for (const variant of edgeVariants(modelJsonSchema())) {
      const kind = asObj(asObj(variant["properties"])["edge"])["const"];
      const required = variant["required"] as string[];
      expect(required.includes("isRead"), `${String(kind)}.isRead`).toBe(kind === "access");
      expect(required.includes("isWrite"), `${String(kind)}.isWrite`).toBe(kind === "access");
    }
  });
});

describe("traitConditionals — the trait-key rule survives into the contract", () => {
  const conditionals = traitConditionals();
  const guarded = new Set(
    conditionals.map(
      (c) => asObj(asObj(asObj(asObj(c["if"])["properties"])["traits"])["contains"])["const"],
    ),
  );

  it("guards every key-contributing trait and no marker trait", () => {
    for (const trait of TRAIT_NAMES) {
      expect(guarded.has(trait), `${trait} conditional`).toBe(!MARKER_TRAITS.has(trait));
    }
    expect(conditionals).toHaveLength(TRAIT_NAMES.length - MARKER_TRAITS.size);
  });

  it("never lifts the trait schema's own additionalProperties — it would forbid sibling traits", () => {
    for (const conditional of conditionals) {
      expect(Object.keys(asObj(conditional["then"])).sort()).not.toContain("additionalProperties");
    }
  });

  it("requires a key only when the trait actually requires it (declaredType stays optional)", () => {
    const typed = conditionals.find(
      (c) =>
        asObj(asObj(asObj(asObj(c["if"])["properties"])["traits"])["contains"])["const"] ===
        "TTypedEntity",
    );
    expect(typed).toBeDefined();
    expect(asObj(typed?.["then"])["required"]).toBeUndefined();
    expect(Object.keys(asObj(asObj(typed?.["then"])["properties"]))).toEqual(["declaredType"]);

    const named = conditionals.find(
      (c) =>
        asObj(asObj(asObj(asObj(c["if"])["properties"])["traits"])["contains"])["const"] ===
        "TNamed",
    );
    expect(asObj(named?.["then"])["required"]).toEqual(["name"]);
  });
});

describe("the committed schemas/model.schema.json", () => {
  it("is exactly what the generator produces — regenerating is a no-op", () => {
    // Same canonicalization as scripts/gen-schemas.ts.
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Obj).sort()) out[key] = canonicalize(asObj(value)[key]);
      return out;
    };
    expect(committed).toEqual(canonicalize(modelJsonSchema()));
  });

  it("carries the trait conditionals — an extractor gets the whole rule from this file", () => {
    const allOf = entityItems(committed)["allOf"] as Obj[];
    expect(allOf).toBeDefined();
    expect(allOf).toHaveLength(TRAIT_NAMES.length - MARKER_TRAITS.size);
  });
});
