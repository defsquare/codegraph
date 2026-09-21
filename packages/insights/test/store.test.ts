import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type ModuleBlock,
  type OperationBlock,
  type TypeBlock,
} from "../src/schema.js";
import { decodeInsights, encodeInsightsToString } from "../src/sidecar.js";
import { INSIGHTS_APPLICATION_ID, INSIGHTS_DB_VERSION, InsightsStoreError, insightsStorePathFor } from "../src/store.js";
import { storeBook, summaryOf } from "../src/records.js";
import { sqliteInsightsStore } from "../src/store-sqlite.js";

const memory = () => sqliteInsightsStore(loadSqlite().open(":memory:"));

const HEADER: InsightsHeader = {
  t: "header",
  kind: INSIGHTS_KIND,
  generatedBy: INSIGHTS_GENERATOR,
  promptVersion: PROMPT_VERSION,
  metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" },
  provider: "openrouter",
  depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};

const OPERATION: OperationBlock = {
  name: "f", description: "Does f.", safe: true, idempotent: null, owner: "entity", handlesCommand: null,
  emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.5,
};
const TYPE: TypeBlock = {
  name: "T", description: "A type.", concept: "aggregate", eventKind: null, interfaceRole: null, aggregateRoot: true,
  containedIn: null, syncPattern: null, identity: "id", fields: [], invariants: [], stateMachine: null, relatesTo: [],
  exposes: [], dependsOn: [], domainTerms: [], confidence: 0.9,
};
const MODULE: ModuleBlock = {
  name: "M", description: "A module.", apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null,
  sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.4,
};

const FP = "a".repeat(64);
const op = (id: string, extra: Partial<InsightRecord> = {}): InsightRecord =>
  ({ t: "i", id, level: "operation", kind: "method", origin: "llm", block: OPERATION, fingerprint: FP, ...extra }) as InsightRecord;
const type = (id: string): InsightRecord => ({ t: "i", id, level: "type", kind: "class", origin: "llm", block: TYPE, fingerprint: FP });

const failure = (id: string, extra: Partial<FailureRecord> = {}): FailureRecord => ({
  t: "f", id, level: "operation", members: [id], model: "m",
  reason: { kind: "provider", message: "no credits", status: 402, retryable: false }, attempts: 1, calls: 1, ...extra,
});

const eof = (records: number, failed = 0): InsightsEof => ({
  t: "eof",
  counts: { records, llm: records, template: 0, reused: 0, failed },
  usage: { promptTokens: 10, completionTokens: 2, cost: 0.001 },
  generatedAt: "2026-09-19T00:00:00.000Z",
});

const exportOf = (store: { export(): Iterable<string> }): string => `${[...store.export()].join("\n")}\n`;

/* ── arbitraries: any side-car the schema admits, ids unique (the store keys on them) ── */

// What a model or a provider worded is JSON text in the store: anything JSON can say survives.
const wild = fc.string({ unit: "binary", maxLength: 12 });
// A COLUMN is UTF-8 read as a C string: no lone surrogate, no U+0000 (refused at write — see below).
// With the `u` flag a PAIRED surrogate is one code point and does not match; a lone one does.
const text = wild.filter((s) => !/\p{Surrogate}/u.test(s) && !s.includes("\u0000"));
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
const usageArb = fc.record(
  { promptTokens: fc.nat(), completionTokens: fc.nat(), cost: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0 }) },
  { requiredKeys: ["promptTokens", "completionTokens"] },
);
const keyArb = fc.record({ lang: text, module: text, symbol: text, disambiguator: text }, { requiredKeys: ["lang", "module", "symbol"] });
const confidence = fc.double({ noNaN: true, noDefaultInfinity: true });
const blockArb = {
  operation: fc.record({ name: wild, description: wild, confidence, domainTerms: fc.array(wild, { maxLength: 3 }), owner: fc.constantFrom("entity", "aggregate", "unknown") }).map((b) => ({ ...OPERATION, ...b })),
  type: fc.record({ name: text, description: wild, confidence, identity: fc.option(text, { nil: null }), concept: fc.constantFrom("entity", "aggregate", "valueType") }).map((b) => ({ ...TYPE, ...b })),
  module: fc.record({ name: text, description: wild, confidence, sharedKernelHint: fc.option(text, { nil: null }), boundedContextHint: fc.option(fc.record({ name: wild, rationale: wild }), { nil: null }) }).map((b) => ({ ...MODULE, ...b })),
};
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const recordArb = (id: string): fc.Arbitrary<InsightRecord> =>
  fc.constantFrom("operation", "type", "module").chain((level) =>
    fc
      .record({
        key: maybe(keyArb), kind: text, name: maybe(text), file: maybe(text), scc: maybe(fc.array(text, { maxLength: 3 })),
        origin: fc.constantFrom("llm", "template"), block: blockArb[level as "operation"], fingerprint: fc.stringMatching(/^[0-9a-f]{64}$/u),
        model: maybe(text), usage: maybe(usageArb), metadata: maybe(fc.dictionary(text, text, { maxKeys: 3 })),
      })
      .map((r) => strip({ t: "i", id, level, ...r }) as unknown as InsightRecord),
  );

const failureArb = (id: string): fc.Arbitrary<FailureRecord> =>
  fc
    .record({
      key: maybe(keyArb), level: fc.constantFrom("operation", "type", "module"), members: fc.array(text.filter((s) => s !== ""), { minLength: 1, maxLength: 3 }),
      model: text,
      reason: fc.record({ kind: fc.constantFrom("provider", "invalid-answer", "error"), message: wild, status: maybe(fc.integer({ min: 100, max: 599 })), retryable: maybe(fc.boolean()) }).map(strip),
      attempts: fc.integer({ min: 1, max: 9 }), calls: fc.nat(9), usage: maybe(usageArb),
    })
    .map((f) => strip({ t: "f", id, ...f }) as unknown as FailureRecord);

const ids = fc.uniqueArray(text.filter((s) => s !== ""), { maxLength: 8 });
const fileArb = fc
  .tuple(ids, ids)
  .chain(([recordIds, failureIds]) => fc.tuple(fc.tuple(...recordIds.map(recordArb)), fc.tuple(...failureIds.map(failureArb)), usageArb))
  .map(([records, failures, usage]) =>
    encodeInsightsToString(HEADER, records, { ...eof(records.length, failures.length), usage }, failures));

describe("the side-car is the store's export: decode → import → export is the identity", () => {
  it("for any side-car the schema admits", () => {
    fc.assert(
      fc.property(fileArb, (sidecar) => {
        const store = memory();
        try {
          store.importFile(decodeInsights(sidecar));
          expect(exportOf(store)).toBe(sidecar);
        } finally {
          store.close();
        }
      }),
      { numRuns: 150 },
    );
  });

  it("sorts ids as the side-car does — UTF-16 code units, not SQLite's UTF-8 bytes", () => {
    // U+FF5E sorts AFTER U+1F600 in UTF-16 units (0xFF5E > 0xD83D) and BEFORE it in code points.
    const sidecar = encodeInsightsToString(HEADER, [op("a/\u{1F600}"), op("a/～")], eof(2));
    const store = memory();
    store.importFile(decodeInsights(sidecar));
    expect(exportOf(store)).toBe(sidecar);
    expect(store.records().map((r) => r.id)).toEqual(["a/\u{1F600}", "a/～"]);
  });

  it("a file cut short (no trailer) exports as one: the store does not invent an end", () => {
    const whole = encodeInsightsToString(HEADER, [op("a")], eof(1));
    const cut = `${whole.split("\n").slice(0, -2).join("\n")}\n`;
    const store = memory();
    store.importFile(decodeInsights(cut));
    expect(exportOf(store)).toBe(cut);
    expect(decodeInsights(exportOf(store)).truncated).toBe(true);
  });

  it("refuses an id the binding would read back cut short, rather than store it", () => {
    const store = memory();
    const sidecar = decodeInsights(encodeInsightsToString(HEADER, [op("o/a\u0000b")], eof(1)));
    expect(() => store.importFile(sidecar)).toThrow(/U\+0000/u);
    expect(store.isEmpty()).toBe(true);
  });

  it("an empty store says so, and an imported one does not", () => {
    const store = memory();
    expect(store.isEmpty()).toBe(true);
    expect(store.header()).toBeUndefined();
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [], eof(0))));
    expect(store.isEmpty()).toBe(false);
    expect(store.header()).toEqual(HEADER);
  });
});

describe("reads that do not pay for blocks", () => {
  it("fingerprints() maps every id; get() returns what exists, in side-car order", () => {
    const store = memory();
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [type("t/A"), op("o/b", { fingerprint: "b".repeat(64) }), op("o/a")], eof(3))));
    expect(store.fingerprints()).toEqual(new Map([["o/a", FP], ["o/b", "b".repeat(64)], ["t/A", FP]]));
    expect(store.get(["t/A", "nope", "o/a"]).map((r) => r.id)).toEqual(["o/a", "t/A"]);
    expect(store.get([])).toEqual([]);
  });

  it("get() is not bounded by SQLite's parameter limit", () => {
    const store = memory();
    const many = Array.from({ length: 2500 }, (_, i) => op(`o/${String(i).padStart(4, "0")}`));
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, many, eof(many.length))));
    expect(store.get(many.map((r) => r.id))).toHaveLength(2500);
  });

  it("what a reader will ask for is a column: concept and confidence", () => {
    const db = loadSqlite().open(":memory:");
    const store = sqliteInsightsStore(db);
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [type("t/A"), op("o/a")], eof(2))));
    expect(db.prepare("SELECT id, confidence FROM insight WHERE concept = 'aggregate'").all()).toEqual([{ id: "t/A", confidence: 0.9 }]);
  });
});

describe("storeBook (M16b): the walk reads the store, one record at a time", () => {
  const seeded = () => {
    const db = loadSqlite().open(":memory:");
    const store = sqliteInsightsStore(db);
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [type("t/A"), op("o/a"), op("o/b", { fingerprint: "b".repeat(64) })], eof(3))));
    return { db, store };
  };

  it("answers fingerprints from one scan and summaries by point lookup; an unknown id is undefined for both", () => {
    const { store } = seeded();
    const book = storeBook(store);
    expect(book.size()).toBe(3);
    expect(book.fingerprint("o/b")).toBe("b".repeat(64));
    expect(book.fingerprint("nope")).toBeUndefined();
    expect(book.summary("t/A")).toEqual({ description: "A type.", concept: "aggregate" });
    expect(book.summary("o/a")).toEqual({ description: "Does f.", concept: "owned by entity" });
    expect(book.summary("nope")).toBeUndefined();
    expect(book.all().map((r) => r.id)).toEqual(["o/a", "o/b", "t/A"]);
  });

  it("a summary is read ONCE however often it is quoted — a popular callee is in thousands of prompts", () => {
    // Spied BEFORE the store exists: it prepares its point lookup once, when it is created.
    const db = loadSqlite().open(":memory:");
    let reads = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("block -> '$.description'")) return statement;
      const get = statement.get.bind(statement);
      statement.get = (...params) => {
        reads += 1;
        return get(...params);
      };
      return statement;
    };
    const store = sqliteInsightsStore(db);
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [op("o/a")], eof(1))));
    const book = storeBook(store);
    for (let i = 0; i < 1000; i += 1) book.summary("o/a");
    expect(reads).toBe(1);
  });

  it("the store's summary IS the record's: what SQL projects equals what JS would, for any record", () => {
    fc.assert(
      fc.property(fc.uniqueArray(text.filter((s) => s !== ""), { minLength: 1, maxLength: 6 }).chain((ids) => fc.tuple(...ids.map(recordArb))), (records) => {
        const store = memory();
        try {
          store.importFile(decodeInsights(encodeInsightsToString(HEADER, records, eof(records.length))));
          for (const record of records) expect(store.summary(record.id)).toEqual(summaryOf(record));
          expect(store.summary("\u0001 no such id")).toBeUndefined();
        } finally {
          store.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("put() is the store's commit: refused before a run begins, visible to the very next read after", () => {
    const { store } = seeded();
    const book = storeBook(store);
    expect(() => book.put("o/c", [op("o/c")])).toThrow(/no run/u);
    const run = store.beginRun({ header: HEADER, startedAt: "t" });
    book.begin(run);
    store.fail(run, failure("o/c"));
    void book.put("o/c", [op("o/c", { fingerprint: "c".repeat(64) })]);
    expect(book.fingerprint("o/c")).toBe("c".repeat(64));
    expect(book.summary("o/c")).toEqual({ description: "Does f.", concept: "owned by entity" });
    expect(book.size()).toBe(4);
    expect(store.failures()).toEqual([]);
    // Re-explaining a unit replaces, it does not grow the book.
    void book.put("o/a", [op("o/a", { fingerprint: "d".repeat(64) })]);
    expect(book.size()).toBe(4);
    expect(store.fingerprints().get("o/a")).toBe("d".repeat(64));
  });
});

describe("export streams (M16b): the side-car never has to exist in memory", () => {
  it("yields the same bytes across chunk boundaries, in side-car order, reading a bounded slice at a time", () => {
    const db = loadSqlite().open(":memory:");
    const store = sqliteInsightsStore(db);
    // Ids whose UTF-16 and UTF-8 orders disagree, spread over several chunks of each level.
    const many = [
      ...Array.from({ length: 1300 }, (_, i) => op(`o/${i % 2 === 0 ? "\u{1F600}" : "～"}${String(i).padStart(4, "0")}`)),
      ...Array.from({ length: 700 }, (_, i) => type(`t/${String(i).padStart(4, "0")}`)),
    ];
    const sidecar = encodeInsightsToString(HEADER, many, eof(many.length, 1), [failure("o/x")]);
    store.importFile(decodeInsights(sidecar));

    let widest = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!/SELECT .*\bblock\b.* FROM insight/su.test(sql)) return statement;
      const all = statement.all.bind(statement);
      statement.all = (...params) => {
        const rows = all(...params);
        widest = Math.max(widest, rows.length);
        return rows;
      };
      return statement;
    };
    expect(exportOf(store)).toBe(sidecar);
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(500);
  });
});

describe("a run: one transaction per finished unit, failures when they happen", () => {
  it("putUnit stores every member and clears the unit's failure; the trailer is withdrawn until the run ends", () => {
    const store = memory();
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [op("o/a")], eof(1, 1), [failure("o/b", { members: ["o/b", "o/c"] })])));
    const run = store.beginRun({ header: HEADER, startedAt: "2026-09-19T10:00:00.000Z", pid: 42 });
    expect(store.eof()).toBeUndefined();
    store.putUnit(run, "o/b", [op("o/b", { scc: ["o/b", "o/c"] }), op("o/c", { scc: ["o/b", "o/c"] })]);
    expect(store.records().map((r) => r.id)).toEqual(["o/a", "o/b", "o/c"]);
    expect(store.failures()).toEqual([]);
    store.finishRun(run, { eof: eof(3), failures: [], calls: 1 });
    expect(store.eof()).toEqual(eof(3));
    expect(store.openRuns()).toEqual([]);
  });

  it("a unit is all or nothing: a record the schema rejects leaves no member behind and the failure standing", () => {
    const store = memory();
    const run = store.beginRun({ header: HEADER, startedAt: "t" });
    store.fail(run, failure("o/b"));
    const bad = { ...op("o/c"), fingerprint: "short" } as InsightRecord;
    expect(() => store.putUnit(run, "o/b", [op("o/b"), bad])).toThrow();
    expect(store.records()).toEqual([]);
    expect(store.failures().map((f) => f.id)).toEqual(["o/b"]);
  });

  it("fail() upserts — attempts move on — and finishRun REPLACES the table with what is still owed", () => {
    const store = memory();
    const run = store.beginRun({ header: HEADER, startedAt: "t" });
    store.fail(run, failure("o/a"));
    store.fail(run, failure("o/a", { attempts: 2 }));
    store.fail(run, failure("o/gone"));
    expect(store.failures().map((f) => [f.id, f.attempts])).toEqual([["o/a", 2], ["o/gone", 1]]);
    store.finishRun(run, { eof: eof(0, 1), failures: [failure("o/a", { attempts: 2 })] });
    expect(store.failures()).toEqual([failure("o/a", { attempts: 2 })]);
  });

  it("a killed run is an open run with its records AND its failures; closing it names why", () => {
    const db = loadSqlite().open(":memory:");
    const store = sqliteInsightsStore(db);
    const run = store.beginRun({ header: HEADER, startedAt: "2026-09-19T10:00:00.000Z", pid: 4242 });
    store.putUnit(run, "o/a", [op("o/a")]);
    store.fail(run, failure("o/b"));
    // No finishRun: the process died here.
    expect(store.openRuns()).toEqual([{ id: run.id, startedAt: "2026-09-19T10:00:00.000Z", pid: 4242, records: 1 }]);
    expect(store.records().map((r) => r.id)).toEqual(["o/a"]);
    expect(store.failures().map((f) => f.id)).toEqual(["o/b"]);
    store.closeRun(run.id, "interrupted");
    expect(store.openRuns()).toEqual([]);
    expect(db.prepare("SELECT aborted FROM run").all()).toEqual([{ aborted: "interrupted" }]);
  });

  it("the ledger survives an import; the content does not", () => {
    const db = loadSqlite().open(":memory:");
    const store = sqliteInsightsStore(db);
    const run = store.beginRun({ header: HEADER, startedAt: "t" });
    store.putUnit(run, "o/old", [op("o/old")]);
    store.finishRun(run, { eof: eof(1), failures: [] });
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [op("o/new")], eof(1))));
    expect(store.records().map((r) => r.id)).toEqual(["o/new"]);
    expect(db.prepare("SELECT count(*) AS n FROM run").get()).toEqual({ n: 1 });
  });
});

describe("never disposable: a store is migrated or refused, never rebuilt", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const scratch = (): string => (dir = mkdtempSync(join(tmpdir(), "insights-store-")));

  it("reopens what it wrote, and a clean close leaves ONE file beside the model", () => {
    const path = join(scratch(), "model.insights.db");
    const first = sqliteInsightsStore(loadSqlite().open(path));
    first.importFile(decodeInsights(encodeInsightsToString(HEADER, [op("o/a")], eof(1))));
    first.markExported({ path: "model.insights.jsonl", size: 12, mtimeMs: 34.5 });
    first.close();
    expect(readdirSync(dir!)).toEqual(["model.insights.db"]);
    const again = sqliteInsightsStore(loadSqlite().open(path));
    expect(again.records().map((r) => r.id)).toEqual(["o/a"]);
    expect(again.exported()).toEqual({ path: "model.insights.jsonl", size: 12, mtimeMs: 34.5 });
    again.close();
  });

  it("refuses a store written by a newer build — and leaves its bytes alone", () => {
    const path = join(scratch(), "model.insights.db");
    sqliteInsightsStore(loadSqlite().open(path)).close();
    const db = loadSqlite().open(path);
    db.exec(`PRAGMA user_version = ${INSIGHTS_DB_VERSION + 1}`);
    db.close();
    const before = readFileSync(path);
    expect(() => sqliteInsightsStore(loadSqlite().open(path))).toThrow(InsightsStoreError);
    expect(() => sqliteInsightsStore(loadSqlite().open(path))).toThrow(/newer/u);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses a SQLite file that is not an insights store (a model.db handed over by mistake)", () => {
    const path = join(scratch(), "model.db");
    const db = loadSqlite().open(path);
    db.exec("CREATE TABLE entity (id INTEGER PRIMARY KEY)");
    db.close();
    const before = readFileSync(path);
    expect(() => sqliteInsightsStore(loadSqlite().open(path))).toThrow(/not an insights store/u);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("stamps the file as ours", () => {
    const db = loadSqlite().open(":memory:");
    sqliteInsightsStore(db);
    expect(db.prepare("PRAGMA application_id").get()).toEqual({ application_id: INSIGHTS_APPLICATION_ID });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: INSIGHTS_DB_VERSION });
  });
});

describe("insightsStorePathFor", () => {
  it("sits beside the side-car it exports", () => {
    expect(insightsStorePathFor("/x/model.insights.jsonl")).toBe("/x/model.insights.db");
    expect(insightsStorePathFor("/x/custom.out")).toBe("/x/custom.out.db");
  });
});
