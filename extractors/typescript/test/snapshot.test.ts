import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeModel,
  getProfile,
  RecordReader,
  selfReferences,
  unknownReferences,
  validateModel,
} from "@codegraph/core";
import { encodeToString } from "../src/model/writer.js";
import { extractFixture, SNAPSHOT } from "./harness.js";

/**
 * The fixture corpus → the committed snapshot, byte for byte. Validated by
 * core's reference READER (a devDependency of the tests, never of the
 * extractor): every line against its record schema, the sequence rules, the
 * trait-key rule, closure, and the TypeScript profile.
 */
describe("fixtures/typescript/src → expected/model.jsonl", () => {
  const output = encodeToString(extractFixture().model);

  it("reproduces the committed snapshot exactly", () => {
    expect(output).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("is accepted line by line by the reference reader (schemas, sections, trait keys, counts)", () => {
    const reader = new RecordReader();
    for (const line of output.split("\n")) reader.accept(line);
    const eof = reader.finish();
    expect(eof.counts.entities).toBeGreaterThan(0);
    expect(eof.counts.edges).toBeGreaterThan(0);
  });

  it("decodes to a model the TypeScript profile licenses, closed and free of self-edges", () => {
    const model = decodeModel(output.split("\n"));
    const profile = getProfile("ts");
    expect(profile).toBeDefined();
    expect(validateModel(model, profile!).map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
    expect(unknownReferences(model)).toEqual([]);
    expect(selfReferences(model)).toEqual([]);
  });

  it("names the extractor and the compiler that produced it", () => {
    const header = JSON.parse(output.split("\n")[0] as string) as { extractor: Record<string, unknown>; lang: string };
    expect(header.lang).toBe("ts");
    expect(header.extractor["name"]).toBe("codegraph-typescript");
    expect(header.extractor["typescript"]).toMatch(/^\d+\.\d+\.\d+/);
  });
});
