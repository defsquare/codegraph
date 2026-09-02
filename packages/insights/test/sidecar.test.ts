import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type OperationBlock,
} from "../src/schema.js";
import {
  decodeInsights,
  decodeJournal,
  encodeInsightsToString,
  encodeJournalLine,
  mergeRecords,
  sortRecords,
} from "../src/sidecar.js";

const HEADER: InsightsHeader = {
  t: "header",
  kind: INSIGHTS_KIND,
  generatedBy: INSIGHTS_GENERATOR,
  promptVersion: PROMPT_VERSION,
  metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" },
  depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};

const BLOCK: OperationBlock = {
  name: "f",
  description: "Does f.",
  safe: true,
  idempotent: true,
  owner: "entity",
  handlesCommand: null,
  emits: [],
  preconditions: [],
  postconditions: [],
  invariantsEnforced: [],
  usesSpi: [],
  domainTerms: [],
  confidence: 0.5,
};

function op(id: string, fingerprint = "0".repeat(64)): InsightRecord {
  return { t: "i", id, level: "operation", kind: "method", origin: "llm", fingerprint, block: BLOCK };
}

function eof(records: number): InsightsEof {
  return {
    t: "eof",
    counts: { records, llm: records, template: 0, reused: 0, failed: 0 },
    usage: { promptTokens: 1, completionTokens: 1 },
    generatedAt: "2026-09-02T00:00:00.000Z",
  };
}

const arbId = fc.stringMatching(/^java:[a-z]{1,4}\/[A-Z][a-z]{0,3}\.[a-z]{1,3}\(\)$/);

describe("the side-car round-trips and stays sorted", () => {
  it("encode → decode is the identity on sorted records, and the body is deterministic", () => {
    fc.assert(
      fc.property(fc.uniqueArray(arbId, { maxLength: 8 }), (ids) => {
        const records = ids.map((id) => op(id));
        const text = encodeInsightsToString(HEADER, records, eof(records.length));
        const again = encodeInsightsToString(HEADER, [...records].reverse(), eof(records.length));
        expect(again).toBe(text);
        const file = decodeInsights(text);
        expect(file.header).toEqual(HEADER);
        expect(file.records).toEqual(sortRecords(records));
        expect(file.truncated).toBe(false);
        expect(text.endsWith("\n")).toBe(true);
      }),
    );
  });

  it("reports a file with no eof, or with counts that disagree, as truncated", () => {
    const text = encodeInsightsToString(HEADER, [op("java:p/A.f()")], eof(1));
    const cut = text.split("\n").slice(0, 2).join("\n");
    expect(decodeInsights(cut).truncated).toBe(true);
    const lying = encodeInsightsToString(HEADER, [op("java:p/A.f()")], eof(7));
    expect(decodeInsights(lying).truncated).toBe(true);
  });

  it("rejects a foreign header and a malformed record", () => {
    expect(() => decodeInsights('{"t":"header","kind":"codegraph.navigator/1"}\n')).toThrow(/header/);
    expect(() => decodeInsights(`${JSON.stringify(HEADER)}\n{"t":"i","id":"x"}\n`)).toThrow(/invalid insight record/);
    expect(() => decodeInsights("")).toThrow(/empty/);
  });

  it("merges a journal over a base, journal winning, output sorted", () => {
    const base = [op("java:p/B.g()", "1".repeat(64)), op("java:p/A.f()", "1".repeat(64))];
    const journal = [op("java:p/A.f()", "2".repeat(64)), op("java:p/C.h()", "2".repeat(64))];
    const merged = mergeRecords(base, journal);
    expect(merged.map((r) => [r.id, r.fingerprint[0]])).toEqual([
      ["java:p/A.f()", "2"],
      ["java:p/B.g()", "1"],
      ["java:p/C.h()", "2"],
    ]);
  });

  it("reads a journal leniently, dropping a cut last line", () => {
    const text = encodeJournalLine(op("java:p/A.f()")) + encodeJournalLine(op("java:p/B.g()")).slice(0, 30);
    const { records, dropped } = decodeJournal(text);
    expect(records.map((r) => r.id)).toEqual(["java:p/A.f()"]);
    expect(dropped).toBe(1);
  });

  it("orders operations before types before modules, then by id", () => {
    const type: InsightRecord = {
      ...op("java:p/A"),
      level: "type",
      block: {
        name: "A",
        description: "",
        concept: "entity",
        eventKind: null,
        interfaceRole: null,
        aggregateRoot: null,
        containedIn: null,
        syncPattern: null,
        identity: null,
        fields: [],
        invariants: [],
        stateMachine: null,
        relatesTo: [],
        exposes: [],
        dependsOn: [],
        domainTerms: [],
        confidence: 1,
      },
    } as InsightRecord;
    const sorted = sortRecords([type, op("java:p/Z.z()"), op("java:p/A.f()")]);
    expect(sorted.map((r) => r.id)).toEqual(["java:p/A.f()", "java:p/Z.z()", "java:p/A"]);
  });
});
