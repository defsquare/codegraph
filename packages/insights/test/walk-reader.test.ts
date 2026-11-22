import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlite, type SqliteDatabase } from "@codegraph/analyzer";
import { WALK_BLOCK_KEYS, WALK_DEFINITION_KIND, blockSchema, compileDefinition, explainWalkIdentity, parseWalkDefinition, type CompiledWalk, type WalkDefinitionJson } from "../src/definition.js";
import { EXPLAIN_RECORDS, answerDigestOf, explainRecords, walkReader, walkRecords, type RecordFormat } from "../src/format.js";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  WALK_RECORDS_KIND,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type WalkRecord,
  type WalkRecordsHeader,
} from "../src/schema.js";
import { InsightsFileError, decodeInsights, decodeRecords, encodeInsightsToString, encodeRecordsToString } from "../src/sidecar.js";
import { INSIGHT_ANSWER_KIND, InsightsStoreError, WalkMismatchError, answerInsight } from "../src/store.js";
import { sqliteInsightsStore, sqliteStoreReader, storedWalkIn } from "../src/store-sqlite.js";

/**
 * THE READERS OF A WALK'S STORE (PLAN.md §22.5, step 7b). `codegraph insights
 * --walk N` and `serve --insights FILE` hold no definition: they read a walk's
 * store with `walkReader(N)` — the walk's NAME is compared, never its answer,
 * and every block is read as it was stored — and they write nothing. A reader
 * that is handed only a file chooses its format from the file's header.
 */

const FP = "f".repeat(64);

const RISK: WalkDefinitionJson = {
  kind: WALK_DEFINITION_KIND,
  name: "risk",
  answer: {
    fields: {
      // `owner` is no reserved name: explain's operation label must not read it on a walk's block.
      operation: { owner: "string", risky: "boolean", notes: "string[]" },
      type: { level: { enum: ["low", "high"], nullable: true } },
      module: { area: { list: { name: "string", weight: "number" } } },
    },
  },
};
const compiled: CompiledWalk = compileDefinition(parseWalkDefinition(RISK));

const walkHeader = (walk: CompiledWalk): WalkRecordsHeader => ({
  t: "header",
  kind: WALK_RECORDS_KIND,
  walk: { name: walk.name, version: walk.version, digest: walk.digest, answerDigest: answerDigestOf(walk.answer) },
  generatedBy: INSIGHTS_GENERATOR,
  promptVersion: PROMPT_VERSION,
  models: { leaf: "leaf-model", rollup: "rollup-model" },
  depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
});
const EXPLAIN_HEADER: InsightsHeader = {
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" }, depth: 1, source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const eof = (records: number, failed = 0): InsightsEof => ({
  t: "eof", counts: { records, llm: records, template: 0, reused: 0, failed }, usage: { promptTokens: 10 * records, completionTokens: 2 * records }, generatedAt: "2026-11-21T10:00:00.000Z",
});

const OP = "java:com.acme.order/OrderService#place(Order)";
const TYPE = "java:com.acme.order/Order";
const MODULE = "java:com.acme.order";
const RECORDS: WalkRecord[] = [
  { t: "i", id: OP, level: "operation", kind: "method", origin: "llm", model: "leaf-served", fingerprint: FP, usage: { promptTokens: 100, completionTokens: 20, cost: 0.0001 },
    block: { answer: "It writes the order.", owner: "aggregate", risky: true, notes: ["unchecked total"], description: "Places an order.", confidence: 0.7 } },
  { t: "i", id: TYPE, level: "type", kind: "class", origin: "llm", fingerprint: FP, block: { answer: "Holds lines.", level: null, description: "An order.", confidence: 0.9 } },
  { t: "i", id: MODULE, level: "module", kind: "package", origin: "llm", fingerprint: FP, block: { answer: "Ordering.", area: [{ name: "orders", weight: 2 }], description: "The order module.", confidence: 0.4 } },
];
const FAILED: FailureRecord = { t: "f", id: "java:com.acme.order/Money", level: "type", members: ["java:com.acme.order/Money"], model: "rollup-model", reason: { kind: "provider", message: "too long", status: 400 }, attempts: 1, calls: 1 };
const SIDECAR = encodeRecordsToString(walkRecords(compiled), walkHeader(compiled), RECORDS, eof(3, 1), [FAILED]);

const EXPLAIN_RECORD: InsightRecord = {
  t: "i", id: OP, level: "operation", kind: "method", origin: "llm", fingerprint: FP,
  block: { name: "place", description: "Places.", safe: false, idempotent: null, owner: "aggregate", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.5 },
};
const EXPLAIN_SIDECAR = encodeInsightsToString(EXPLAIN_HEADER, [EXPLAIN_RECORD], eof(1));

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const exportOf = (store: { export(): Iterable<string> }): string => `${[...store.export()].join("\n")}\n`;
const open = (path: string): SqliteDatabase => loadSqlite().open(path);

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const scratch = (): string => (dir = mkdtempSync(join(tmpdir(), "walk-reader-")));

/** A closed store file: the walk's side-car imported by its own definition, or explain's. */
function storeOf(path: string, sidecar: string, format?: RecordFormat): string {
  if (format === undefined) {
    const store = sqliteInsightsStore(open(path));
    store.importFile(decodeInsights(sidecar));
    store.close();
  } else {
    const store = sqliteInsightsStore(open(path), { format });
    store.importFile(decodeRecords(format, sidecar));
    store.close();
  }
  return path;
}

/** An open that is expected to be refused, its connection closed whatever happens — as every CLI reader closes it. */
function opening(path: string, attempt: (db: SqliteDatabase) => { close(): void } | { store: { close(): void } }): void {
  const db = open(path);
  let opened: { close(): void } | { store: { close(): void } };
  try {
    opened = attempt(db);
  } catch (error) {
    db.close();
    throw error;
  }
  if ("store" in opened) opened.store.close();
  else opened.close();
}

/** sha256 and directory listing: what "a reader wrote nothing" compares. */
function untouched(path: string, folder: string): () => void {
  const sha = sha256(path);
  const listing = readdirSync(folder).sort();
  return () => {
    expect(sha256(path)).toBe(sha);
    expect(readdirSync(folder).sort()).toEqual(listing);
  };
}

describe("walkReader: a walk's store read without its definition", () => {
  it("reads every record, failure, row and the header as stored, and exports what the writer would — writing nothing", () => {
    const folder = scratch();
    const path = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const unchanged = untouched(path, folder);
    const format = walkReader("risk");
    expect(format).toMatchObject({ name: "risk", kind: WALK_RECORDS_KIND, walk: undefined, readOnly: true });
    const store = sqliteInsightsStore(open(path), { readOnly: true, format });
    try {
      expect(store.header()).toEqual(walkHeader(compiled));
      expect(store.records()).toEqual(RECORDS);
      expect(store.get([TYPE])[0]?.block).toEqual(RECORDS[1]?.block);
      expect(store.failures()).toEqual([FAILED]);
      expect(exportOf(store)).toBe(SIDECAR);
      expect(store.query({ minConfidence: 0.5 }).map((row) => row.id)).toEqual([OP, TYPE]);
    } finally {
      store.close();
    }
    unchanged();
  });

  it("compares the walk's NAME only: a store written under other answer fields is read as stored", () => {
    const folder = scratch();
    const other = compileDefinition(parseWalkDefinition({ ...RISK, answer: { fields: { operation: { risk: { enum: ["low", "high"] } } } } } as WalkDefinitionJson));
    const sidecar = encodeRecordsToString(walkRecords(other), walkHeader(other), [{ ...RECORDS[0], block: { answer: "No.", risk: "low", description: "D.", confidence: 0.5 } } as WalkRecord], eof(1));
    const path = storeOf(join(folder, "model.risk.walk.db"), sidecar, walkRecords(other));
    const unchanged = untouched(path, folder);
    const store = sqliteInsightsStore(open(path), { readOnly: true, format: walkReader("risk") });
    try {
      expect(exportOf(store)).toBe(sidecar);
    } finally {
      store.close();
    }
    unchanged();
  });

  it("refuses another walk's store and explain's, bytes untouched, both walks named", () => {
    const folder = scratch();
    const walkStore = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const explainStore = storeOf(join(folder, "model.insights.db"), EXPLAIN_SIDECAR);
    const unchangedWalk = untouched(walkStore, folder);
    const unchangedExplain = untouched(explainStore, folder);
    expect(() => opening(walkStore, (db) => sqliteInsightsStore(db, { readOnly: true, format: walkReader("other") }))).toThrow(WalkMismatchError);
    expect(() => opening(walkStore, (db) => sqliteInsightsStore(db, { readOnly: true, format: walkReader("other") }))).toThrow(/of the walk "risk" \(codegraph\.walkRecords\/1\), not of the walk "other" \(codegraph\.walkRecords\/1\)/u);
    expect(() => opening(explainStore, (db) => sqliteInsightsStore(db, { readOnly: true, format: walkReader("risk") }))).toThrow(/of the walk "explain" \(codegraph\.insights\/1\), not of the walk "risk"/u);
    unchangedWalk();
    unchangedExplain();
  });

  it("writes NOTHING: a writer's open is refused before a byte, and the codec refuses it both ways", () => {
    const folder = scratch();
    const path = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const unchanged = untouched(path, folder);
    expect(() => opening(path, (db) => sqliteInsightsStore(db, { format: walkReader("risk") }))).toThrow(InsightsStoreError);
    expect(() => opening(path, (db) => sqliteInsightsStore(db, { format: walkReader("risk") }))).toThrow(/read without its definition.*read-only/u);
    unchanged();
    // Not even an empty file becomes a store under it.
    const fresh = join(folder, "fresh.walk.db");
    expect(() => opening(fresh, (db) => sqliteInsightsStore(db, { format: walkReader("risk") }))).toThrow(InsightsStoreError);
    expect(readFileSync(fresh).length).toBe(0);
    rmSync(fresh);
    expect(() => encodeRecordsToString(walkReader("risk"), walkHeader(compiled), RECORDS, eof(3))).toThrow(InsightsFileError);
    expect(() => decodeRecords(walkReader("risk"), SIDECAR)).toThrow(InsightsFileError);
    // Its record schema refuses every line, whoever would write one with it.
    expect(walkReader("risk").record.safeParse(RECORDS[0]).success).toBe(false);
    unchanged();
  });

  it("is never explain's: explain's reader is explain's own format", () => {
    expect(() => walkReader("explain")).toThrow(/EXPLAIN_RECORDS/u);
  });
});

describe("a reader handed only a file chooses its format from the header", () => {
  it("storedWalkIn names the walk a store's header names, and writes nothing — none for a store with no header, a missing meta or no SQLite at all", () => {
    const folder = scratch();
    const walkStore = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const explainStore = storeOf(join(folder, "model.insights.db"), EXPLAIN_SIDECAR);
    const unchanged = untouched(walkStore, folder);
    const peek = (path: string): ReturnType<typeof storedWalkIn> => {
      const db = open(path);
      try {
        return storedWalkIn(db);
      } finally {
        db.close();
      }
    };
    expect(peek(walkStore)).toEqual({ kind: WALK_RECORDS_KIND, name: "risk", answerDigest: answerDigestOf(compiled.answer) });
    expect(peek(explainStore)).toEqual({ kind: INSIGHTS_KIND, name: "explain" });
    unchanged();

    const empty = join(folder, "empty.db");
    sqliteInsightsStore(open(empty)).close();
    expect(peek(empty)).toBeUndefined();
    const foreign = join(folder, "foreign.db");
    const db = open(foreign);
    db.exec("CREATE TABLE entity (id INTEGER PRIMARY KEY)");
    db.close();
    expect(peek(foreign)).toBeUndefined();
  });

  it("sqliteStoreReader: explain's store as explain's, a walk's with its reader; a named walk must be the store's", () => {
    const folder = scratch();
    const walkStore = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const custom = explainWalkIdentity({ instructions: "Answer in French." });
    const customSidecar = encodeInsightsToString({ ...EXPLAIN_HEADER, walk: custom } as InsightsHeader, [EXPLAIN_RECORD], eof(1));
    const explainStore = storeOf(join(folder, "model.insights.db"), customSidecar, explainRecords(custom));
    const unchangedWalk = untouched(walkStore, folder);
    const unchangedExplain = untouched(explainStore, folder);

    const chosen = sqliteStoreReader(open(walkStore), undefined);
    try {
      expect(chosen.walk).toBe("risk");
      expect(chosen.store.records()).toEqual(RECORDS);
    } finally {
      chosen.store.close();
    }
    const explained = sqliteStoreReader(open(explainStore), undefined);
    try {
      expect(explained.walk).toBeUndefined();
      expect(explained.store.records()).toEqual([EXPLAIN_RECORD]);
    } finally {
      explained.store.close();
    }
    const named = sqliteStoreReader(open(walkStore), "risk");
    expect(named.walk).toBe("risk");
    named.store.close();
    expect(() => opening(walkStore, (db) => sqliteStoreReader(db, "explain"))).toThrow(/of the walk "risk" .*not of the walk "explain"/u);
    expect(() => opening(explainStore, (db) => sqliteStoreReader(db, "risk"))).toThrow(/of the walk "explain" .*not of the walk "risk"/u);
    expect(() => opening(walkStore, (db) => sqliteStoreReader(db, "other"))).toThrow(WalkMismatchError);
    unchangedWalk();
    unchangedExplain();
  });
});

describe("explain's projections are explain's", () => {
  it("a walk's store owes no words and labels no row — even when a walk names a field `owner`", () => {
    const folder = scratch();
    const path = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const store = sqliteInsightsStore(open(path), { readOnly: true, format: walkReader("risk") });
    try {
      expect(store.withoutWords()).toBe(0);
      expect(store.stats().withoutWords).toBe(0);
      expect(store.stats().byConcept).toEqual({});
      expect(store.query({}).map((row) => row.concept)).toEqual([undefined, undefined, undefined]);
    } finally {
      store.close();
    }
    // Explain's store keeps both: its operation's owner label, and its records owed words.
    const explainStore = storeOf(join(folder, "model.insights.db"), EXPLAIN_SIDECAR);
    const explained = sqliteInsightsStore(open(explainStore), { readOnly: true });
    try {
      expect(explained.query({}).map((row) => row.concept)).toEqual(["owned by aggregate"]);
      expect(explained.withoutWords()).toBe(1);
    } finally {
      explained.close();
    }
  });
});

describe("answerInsight names the walk whose store answered", () => {
  it("a walk's answer carries `walk` after `status`; explain's has no such key", () => {
    const folder = scratch();
    const path = storeOf(join(folder, "model.risk.walk.db"), SIDECAR, walkRecords(compiled));
    const store = sqliteInsightsStore(open(path), { readOnly: true, format: walkReader("risk") });
    try {
      const answered = answerInsight(store, OP, "risk");
      expect(JSON.stringify(answered)).toBe(JSON.stringify({ kind: INSIGHT_ANSWER_KIND, id: OP, status: "explained", walk: "risk", record: store.get([OP])[0] }));
      expect(answered).toMatchObject({ record: RECORDS[0] });
      expect(answerInsight(store, "java:com.acme.order/Money", "risk")).toEqual({ kind: INSIGHT_ANSWER_KIND, id: "java:com.acme.order/Money", status: "failed", walk: "risk", failure: FAILED });
      expect(answerInsight(store, "java:nope", "risk")).toEqual({ kind: INSIGHT_ANSWER_KIND, id: "java:nope", status: "unknown", walk: "risk" });
    } finally {
      store.close();
    }
    const explainStore = storeOf(join(folder, "model.insights.db"), EXPLAIN_SIDECAR);
    const explained = sqliteInsightsStore(open(explainStore), { readOnly: true, format: EXPLAIN_RECORDS });
    try {
      expect(Object.keys(answerInsight(explained, OP))).toEqual(["kind", "id", "status", "record"]);
    } finally {
      explained.close();
    }
  });
});

describe("a generic block's own keys", () => {
  it("are blockSchema's keys less the declared fields, in the order a block is written: what a reader shows apart from the fields", () => {
    const keys = Object.keys(blockSchema([{ name: "risky", type: { kind: "boolean", nullable: false } }]).shape);
    expect(keys).toEqual(["answer", "risky", "description", "confidence"]);
    expect(keys.filter((key) => key !== "risky")).toEqual([...WALK_BLOCK_KEYS]);
  });
});
