import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PROVENANCES } from "../src/primitives.js";
import { EDGE_KINDS } from "../src/names.js";
import { SCHEMA_VERSION } from "../src/model.js";
import { containerContract } from "../src/container-contract.js";
import { recordJsonSchemas } from "../src/jsonschema.js";
import { SECTION_ORDER, WIRE_TRAITS } from "../src/wire.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemasDir = join(repoRoot, "schemas");

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => v as Obj;

function committed(name: string): Obj {
  return JSON.parse(readFileSync(join(schemasDir, name), "utf8")) as Obj;
}

describe("the published per-record schemas", () => {
  const schemas = recordJsonSchemas();

  it("covers every record type of the container contract", () => {
    expect(Object.keys(schemas).sort()).toEqual([...SECTION_ORDER].sort());
    for (const [tag, schema] of Object.entries(schemas)) {
      expect(schema["$id"], tag).toContain(SCHEMA_VERSION);
      expect(String(schema["description"]).length, tag).toBeGreaterThan(40);
    }
  });

  it("pins the entity record's identity fields — the natural key is not optional", () => {
    expect(schemas.e["required"]).toEqual(expect.arrayContaining(["t", "i", "k", "tr", "m", "s"]));
    // `d` is the one identity field that may be absent.
    expect(schemas.e["required"]).not.toContain("d");
  });

  /**
   * The rule the per-record schema CAN still enforce: every key a trait can put
   * on the wire is typed here. Only presence is left to the reader (§4 of the
   * container contract), because that needs the header's dictionary.
   */
  it("types every key any trait contributes", () => {
    const properties = Object.keys(asObj(schemas.e["properties"]));
    for (const [trait, schema] of Object.entries(WIRE_TRAITS)) {
      for (const key of Object.keys(schema.shape)) {
        expect(properties, `${trait}.${key}`).toContain(key);
      }
    }
  });

  it("requires an edge to carry its kind, both endpoints, provenance and evidence", () => {
    expect(schemas.x["required"]).toEqual(
      expect.arrayContaining(["t", "k", "f", "o", "p", "anchor"]),
    );
  });

  it("publishes the closed vocabularies as enums in the header", () => {
    const dict = asObj(asObj(asObj(schemas.header["properties"])["dict"])["properties"]);
    expect(asObj(asObj(dict["provenance"])["items"])["enum"]).toEqual([...PROVENANCES]);
    expect(asObj(asObj(dict["edges"])["items"])["enum"]).toEqual([...EDGE_KINDS]);
    expect(asObj(asObj(schemas.header["properties"])["dict"])["required"]).toEqual(
      expect.arrayContaining(["kinds", "traits", "edges", "provenance"]),
    );
  });

  it("makes the eof counts mandatory — truncation detection is not optional", () => {
    const counts = asObj(asObj(asObj(schemas.eof["properties"])["counts"]));
    expect(counts["required"]).toEqual(expect.arrayContaining(["files", "entities", "edges"]));
  });
});

describe("the committed schemas/ directory", () => {
  it("holds exactly the generated files and nothing stale", () => {
    expect(readdirSync(schemasDir).sort()).toEqual(
      [...SECTION_ORDER.map((tag) => `${tag}.record.schema.json`), "README.md"].sort(),
    );
  });

  it("is exactly what the generator produces — regenerating is a no-op", () => {
    // Same canonicalization as scripts/gen-schemas.ts.
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Obj).sort()) out[key] = canonicalize(asObj(value)[key]);
      return out;
    };
    for (const [tag, schema] of Object.entries(recordJsonSchemas())) {
      expect(committed(`${tag}.record.schema.json`), tag).toEqual(canonicalize(schema));
    }
    expect(readFileSync(join(schemasDir, "README.md"), "utf8")).toBe(containerContract());
  });
});

describe("the container contract — what JSON Schema cannot say", () => {
  const text = containerContract();

  it("states the section order", () => {
    expect(text).toContain("header → f* → e* → x* → eof");
  });

  it("names every record schema it publishes", () => {
    for (const tag of SECTION_ORDER) expect(text).toContain(`${tag}.record.schema.json`);
  });

  /** Generated from WIRE_TRAITS, so the published table cannot drift from code. */
  it("tabulates every trait's wire keys", () => {
    for (const [trait, schema] of Object.entries(WIRE_TRAITS)) {
      expect(text, trait).toContain(`\`${trait}\``);
      for (const key of Object.keys(schema.shape)) expect(text, `${trait}.${key}`).toContain(`\`${key}\``);
    }
  });

  it("says plainly that no rendered id is written", () => {
    expect(text).toContain("No rendered id string appears anywhere in the file");
  });

  it("states the rules a single line cannot carry", () => {
    for (const rule of ["Closure", "eof.counts", "Uniqueness", "byte-identical"]) {
      expect(text).toContain(rule);
    }
  });
});
