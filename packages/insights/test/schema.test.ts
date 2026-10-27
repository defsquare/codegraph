import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONCEPT_DEFINITIONS, DOMAIN_CONCEPTS } from "../src/ddd.js";
import type { OperationBlock } from "../src/schema.js";
import {
  ANSWER_BLOCKS,
  BLOCKS,
  InsightRecord,
  LEVELS,
  PROMPT_VERSION,
  WORD_CONCERNS,
  clampConfidence,
  responseJsonSchema,
  responseSchemaName,
  sccResponseSchema,
  strictify,
} from "../src/schema.js";

/** Every object node in a JSON Schema, depth-first. */
function objectNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => objectNodes(n, out));
  else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["type"] === "object" && record["properties"] !== undefined) out.push(record);
    for (const value of Object.values(record)) objectNodes(value, out);
  }
  return out;
}

const FORBIDDEN = ["$schema", "$id", "minimum", "maximum", "minLength", "maxLength", "pattern", "format"];

describe("the response schemas are strict-compatible", () => {
  it.each(LEVELS.flatMap((level) => [[level, "block"] as const, [level, "scc"] as const]))(
    "%s/%s: every object requires all its properties and forbids extras; no constraint keywords",
    (level, shape) => {
      const schema = responseJsonSchema(level, shape);
      const objects = objectNodes(schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        const properties = Object.keys(object["properties"] as Record<string, unknown>);
        expect(object["additionalProperties"]).toBe(false);
        expect([...(object["required"] as string[])].sort()).toEqual([...properties].sort());
      }
      const text = JSON.stringify(schema);
      for (const keyword of FORBIDDEN) expect(text).not.toContain(`"${keyword}"`);
      expect(responseSchemaName(level, shape)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    },
  );

  it("emits enums for the closed vocabularies so the model cannot invent a concept", () => {
    const type = responseJsonSchema("type");
    const concept = (type["properties"] as Record<string, { enum?: string[] }>)["concept"];
    expect(concept?.enum).toEqual([...DOMAIN_CONCEPTS]);
  });

  it("strictify is idempotent", () => {
    for (const level of LEVELS) {
      const once = responseJsonSchema(level);
      expect(strictify(once)).toEqual(once);
    }
  });
});

describe("blocks and records", () => {
  it("every domain concept has a one-line definition for the prompt", () => {
    for (const concept of DOMAIN_CONCEPTS) expect(CONCEPT_DEFINITIONS[concept].length).toBeGreaterThan(20);
  });

  it("clamps confidence into [0, 1] instead of rejecting the block", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (c) => {
        const clamped = clampConfidence({ confidence: c }).confidence;
        expect(clamped).toBeGreaterThanOrEqual(0);
        expect(clamped).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("a cycle response is one block per member id", () => {
    const parsed = sccResponseSchema("operation").safeParse({ members: [] });
    expect(parsed.success).toBe(true);
    const bad = sccResponseSchema("operation").safeParse({ members: [{ id: "x" }] });
    expect(bad.success).toBe(false);
  });

  it("a record is discriminated by level and rejects a block from another level", () => {
    const operation: OperationBlock = {
      name: "bill",
      description: "Bills the order.",
      safe: false,
      idempotent: null,
      owner: "entity",
      handlesCommand: null,
      emits: [],
      preconditions: [],
      postconditions: [],
      invariantsEnforced: [],
      usesSpi: [],
      domainTerms: ["order"],
      confidence: 0.8,
    };
    const base = {
      t: "i",
      id: "java:p/A.bill()",
      kind: "method",
      origin: "llm",
      fingerprint: "a".repeat(64),
    };
    expect(InsightRecord.safeParse({ ...base, level: "operation", block: operation }).success).toBe(true);
    expect(InsightRecord.safeParse({ ...base, level: "type", block: operation }).success).toBe(false);
    expect(BLOCKS.operation.safeParse(operation).success).toBe(true);
  });
});

describe("the words of a unit's names (prompt 2, PLAN.md §20.3)", () => {
  const v1: OperationBlock = {
    name: "bill",
    description: "Bills the order.",
    safe: false,
    idempotent: null,
    owner: "entity",
    handlesCommand: null,
    emits: [],
    preconditions: [],
    postconditions: [],
    invariantsEnforced: [],
    usesSpi: [],
    domainTerms: ["order"],
    confidence: 0.8,
  };
  const word = { word: "bill", in: ["bill"], concern: "domain", sense: "invoice", meaning: "To charge the customer for the order.", confidence: 0.9 };
  const record = { t: "i", id: "java:p/A.bill()", level: "operation", kind: "method", origin: "llm", block: v1, fingerprint: "a".repeat(64) };

  it("is a new prompt: every fingerprint moves", () => {
    expect(PROMPT_VERSION).toBe("2");
  });

  it("decodes a record explained under prompt 1, and re-encodes it to its own bytes", () => {
    const parsed = InsightRecord.parse(record);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(record));
    expect("words" in parsed.block).toBe(false);
  });

  it("keeps a record's words and a module's glossary, after the block's own keys", () => {
    const parsed = InsightRecord.parse({ ...record, block: { ...v1, confidence: 0.8, words: [word] } });
    expect(Object.keys(parsed.block).slice(-2)).toEqual(["words", "confidence"]);
    const module = InsightRecord.parse({
      ...record,
      level: "module",
      kind: "package",
      block: {
        name: "billing",
        description: "Billing.",
        apis: [],
        spis: [],
        dependsOn: [],
        concepts: [],
        boundedContextHint: null,
        sharedKernelHint: null,
        ubiquitousLanguage: [],
        confidence: 0.5,
        glossary: [{ word: "bill", concern: "domain", sense: "invoice", meaning: "What a customer owes.", polysemous: true, senses: [{ in: "Invoice", sense: "invoice" }, { in: "Beak", sense: "a beak" }] }],
        words: [word],
      },
    });
    expect(Object.keys(module.block).slice(-3)).toEqual(["words", "glossary", "confidence"]);
  });

  it("asks every level for its words, and a module for its glossary, on the wire", () => {
    for (const level of LEVELS) {
      const schema = responseJsonSchema(level);
      expect(schema["required"]).toContain("words");
      const items = ((schema["properties"] as Record<string, { items?: Record<string, unknown> }>)["words"]?.items ?? {}) as Record<string, unknown>;
      expect(Object.keys(items["properties"] as object)).toEqual(["word", "in", "concern", "sense", "meaning", "confidence"]);
      expect((items["properties"] as Record<string, { enum?: string[] }>)["concern"]?.enum).toEqual([...WORD_CONCERNS]);
    }
    expect(responseJsonSchema("module")["required"]).toContain("glossary");
    expect(responseJsonSchema("type")["required"]).not.toContain("glossary");
  });

  it("refuses an answer without its words, though a record may lack them", () => {
    expect(BLOCKS.operation.safeParse(v1).success).toBe(true);
    expect(ANSWER_BLOCKS.operation.safeParse(v1).success).toBe(false);
    expect(ANSWER_BLOCKS.operation.safeParse({ ...v1, words: [] }).success).toBe(true);
    expect(sccResponseSchema("operation").safeParse({ members: [{ id: "x", block: v1 }] }).success).toBe(false);
    expect(sccResponseSchema("operation").safeParse({ members: [{ id: "x", block: { ...v1, words: [word] } }] }).success).toBe(true);
    expect(ANSWER_BLOCKS.operation.safeParse({ ...v1, words: [{ ...word, concern: "layer" }] }).success).toBe(false);
  });
});
