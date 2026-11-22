import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHT_ANSWER_KIND,
  PROMPT_VERSION,
  WALK_DEFINITION_KIND,
  WALK_RECORDS_KIND,
  answerDigestOf,
  compileDefinition,
  decodeRecords,
  encodeRecordsToString,
  parseWalkDefinition,
  sqliteInsightsStore,
  walkRecords,
  type FailureRecord,
  type InsightsEof,
  type WalkRecord,
  type WalkRecordsHeader,
} from "@codegraph/insights";
import { glossaryLookup } from "../src/glossary-route.js";
import { insightLookup, storeReader } from "../src/insight-route.js";

/**
 * `serve --insights FILE` on a WALK's store (PLAN.md §22.5, step 7b): the
 * reader is chosen from the store's header, so `/insight.json` answers the
 * walk's block — naming the walk, so the page tells it from explain's by the
 * data — where it used to be a quiet 404. The glossary has no store it may read
 * there (a walk's blocks carry no words) and says so as it does with none.
 */

const compiled = compileDefinition(parseWalkDefinition({
  kind: WALK_DEFINITION_KIND,
  name: "risk",
  answer: { fields: { operation: { risky: "boolean" }, type: { level: { enum: ["low", "high"] } } } },
}));
const format = walkRecords(compiled);
const HEADER: WalkRecordsHeader = {
  t: "header", kind: WALK_RECORDS_KIND,
  walk: { name: "risk", version: compiled.version, digest: compiled.digest, answerDigest: answerDigestOf(compiled.answer) },
  generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, models: { leaf: "m", rollup: "m" }, depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const ORDER = "java:com.acme.order/Order";
const RECORD: WalkRecord = { t: "i", id: ORDER, level: "type", kind: "class", origin: "llm", model: "m-served", fingerprint: "a".repeat(64), block: { answer: "Holds lines.", level: "high", description: "An order.", confidence: 0.9 } };
const FAILED: FailureRecord = { t: "f", id: "java:com.acme.order", level: "module", members: ["java:com.acme.order"], model: "m", reason: { kind: "provider", message: "no credits", status: 402 }, attempts: 1, calls: 1 };
const eof = (failed: number): InsightsEof => ({ t: "eof", counts: { records: 1, llm: 1, template: 0, reused: 0, failed }, usage: { promptTokens: 1, completionTokens: 1 }, generatedAt: "2026-11-21T00:00:00.000Z" });
const SIDECAR = encodeRecordsToString(format, HEADER, [RECORD], eof(1), [FAILED]);

let dir: string;
let db: string;
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const query = (params: Record<string, string>): URLSearchParams => new URLSearchParams(params);

function importInto(path: string): void {
  const store = sqliteInsightsStore(loadSqlite().open(path), { format });
  store.importFile(decodeRecords(format, SIDECAR));
  store.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "insight-route-walk-"));
  db = join(dir, "model.risk.walk.db");
  importInto(db);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("insight.json on a walk's store", () => {
  it("answers the walk's block, naming the walk after `status`; a failure and an unknown id name it too — and the store is untouched", () => {
    const before = sha256(db);
    const reader = storeReader(db);
    const lookup = insightLookup(reader);
    try {
      const found = lookup.handle(query({ id: ORDER }));
      expect(found.status).toBe(200);
      expect(Object.keys(JSON.parse(found.body) as object)).toEqual(["kind", "id", "status", "walk", "record"]);
      expect(JSON.parse(found.body)).toEqual({ kind: INSIGHT_ANSWER_KIND, id: ORDER, status: "explained", walk: "risk", record: RECORD });
      const failed = lookup.handle(query({ id: "java:com.acme.order" }));
      expect(failed.status).toBe(200);
      expect(JSON.parse(failed.body)).toEqual({ kind: INSIGHT_ANSWER_KIND, id: "java:com.acme.order", status: "failed", walk: "risk", failure: FAILED });
      const unknown = lookup.handle(query({ id: "java:nope/Nothing" }));
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ kind: INSIGHT_ANSWER_KIND, id: "java:nope/Nothing", status: "unknown", walk: "risk" });
    } finally {
      reader.close();
    }
    expect(sha256(db)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["model.risk.walk.db"]);
  });

  it("the glossary has no store it may read on a walk's: no-store, 404, as without any", () => {
    const reader = storeReader(db);
    const glossary = glossaryLookup(reader, () => {
      throw new Error("no placement is built for a store the glossary does not read");
    });
    try {
      const answer = glossary.handle(query({ term: "order" }));
      expect(answer.status).toBe(404);
      expect(JSON.parse(answer.body)).toEqual({ kind: "codegraph.glossary/1", status: "no-store" });
    } finally {
      reader.close();
    }
  });

  it("an EMPTY store is nobody's yet: answered as explain's until a walk writes into it, then as the walk's — never a crash", () => {
    const late = join(dir, "late.risk.walk.db");
    sqliteInsightsStore(loadSqlite().open(late)).close();
    const reader = storeReader(late);
    const lookup = insightLookup(reader);
    const glossary = glossaryLookup(reader, () => () => undefined);
    try {
      expect(lookup.handle(query({ id: ORDER }))).toEqual({ status: 404, body: JSON.stringify({ kind: INSIGHT_ANSWER_KIND, id: ORDER, status: "unknown" }) });
      expect(glossary.handle(query({ term: "order" })).status).toBe(200);
      importInto(late);
      const found = lookup.handle(query({ id: ORDER }));
      expect(found.status).toBe(200);
      expect(JSON.parse(found.body)).toMatchObject({ status: "explained", walk: "risk", record: { block: { answer: "Holds lines." } } });
      expect(glossary.handle(query({ term: "order" })).status).toBe(404);
    } finally {
      reader.close();
    }
  });
});
