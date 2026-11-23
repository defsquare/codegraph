import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlite, parseSelector, type SqliteDatabase } from "@codegraph/analyzer";
import { contextPackFor, type ContextEnv } from "../src/context.js";
import { WALK_DEFINITION_KIND, compileDefinition, explainWalkIdentity, parseWalkDefinition, type CompiledWalk, type WalkDefinitionJson } from "../src/definition.js";
import { summaryOf } from "../src/explain-spec.js";
import { EXPLAIN_RECORDS, answerDigestOf, explainRecords, walkChange, walkRecords, type RecordFormat } from "../src/format.js";
import { planRun, type PlanEnv } from "../src/plan.js";
import { renderPrompts } from "../src/prompt.js";
import { memoryBook, quoteOf, storeBook, type RecordSource } from "../src/records.js";
import { executeRun } from "../src/run.js";
import {
  DOMAIN_CONCEPTS,
  OPERATION_OWNERS,
} from "../src/ddd.js";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  LEVELS,
  PROMPT_VERSION,
  WALK_RECORDS_KIND,
  InsightsHeader,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type Level,
  type WalkRecord,
  type WalkRecordsHeader,
} from "../src/schema.js";
import { resolveSelection } from "../src/selection.js";
import { InsightsFileError, decodeInsights, decodeRecords, encodeInsightsToString, encodeRecordsToString } from "../src/sidecar.js";
import { INSIGHTS_DB_VERSION, WalkMismatchError, insightsStorePathFor, walkSidecarPathFor, walkStorePathFor } from "../src/store.js";
import { sqliteInsightsStore } from "../src/store-sqlite.js";
import type { WalkSpec } from "../src/spec.js";
import { EXPLAIN } from "./fixture.js";
import { RUN_OPTIONS, WALK_OPTIONS, fieldsJsonArb, javaWalk, schemaCompleter, valueArb } from "./definition-fixture.js";

/**
 * ONE STORE PER WALK (PLAN.md §22.4, §22.6 step 6). A walk's records are kept
 * as explain's are — a SQLite working copy and its side-car export, the same
 * envelopes — with three differences: the block is checked by the walk's own
 * compiled schema, the header says which walk wrote the file (`walk`), and a
 * store or side-car of another walk is refused with its bytes untouched. A
 * changed definition of the same walk is not refused but told, before anything
 * is written; and a record read back from the store is quoted exactly as the
 * walk quoted it when it was put.
 */

const BASKET = "java:com.acme.order/Basket";

/** §22.2's example on all three levels, with a label at two of them and a list field: what the e2e suite runs. */
const TX: WalkDefinitionJson = {
  kind: WALK_DEFINITION_KIND,
  name: "tx-boundaries",
  version: "1",
  prompt: {
    task: { operation: "Say where the transaction starts and ends.", type: "Say which transactions this type takes part in.", module: "Say how this module bounds its transactions." },
    instructions: "Answer in English.",
    entities: [{ select: { id: BASKET }, instructions: "Basket is the cart; say which line it touches." }],
  },
  answer: {
    label: "boundary",
    fields: {
      operation: { boundary: { enum: ["starts", "joins", "none"] }, risks: "string[]" },
      type: { boundary: { enum: ["owns", "joins"], nullable: true }, notes: { list: { line: "number", text: "string" } } },
      module: { area: { type: "string", nullable: true } },
    },
  },
};

/** Same name, another task: a changed definition of the same walk. */
const TX_RETASKED: WalkDefinitionJson = { ...TX, prompt: { ...(TX["prompt"] as object), task: "Say where the transaction starts and ends, and why." } } as WalkDefinitionJson;

/** Another walk altogether. */
const RISK: WalkDefinitionJson = { kind: WALK_DEFINITION_KIND, name: "risk-review", answer: { fields: { operation: { risky: "boolean" } } } };

const compiledOf = (json: WalkDefinitionJson): CompiledWalk => compileDefinition(parseWalkDefinition(json));

function headerOf(compiled: CompiledWalk): WalkRecordsHeader {
  return {
    t: "header",
    kind: WALK_RECORDS_KIND,
    walk: { name: compiled.name, version: compiled.version, digest: compiled.digest, answerDigest: answerDigestOf(compiled.answer) },
    generatedBy: INSIGHTS_GENERATOR,
    promptVersion: PROMPT_VERSION,
    models: { leaf: "leaf-model", rollup: "rollup-model" },
    depth: 1,
    source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
  };
}

const EXPLAIN_HEADER: InsightsHeader = {
  t: "header",
  kind: INSIGHTS_KIND,
  generatedBy: INSIGHTS_GENERATOR,
  promptVersion: PROMPT_VERSION,
  metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" },
  depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};

const eof = (records: number, failed = 0): InsightsEof => ({
  t: "eof",
  counts: { records, llm: records, template: 0, reused: 0, failed },
  usage: { promptTokens: 10, completionTokens: 2 },
  generatedAt: "2026-11-21T00:00:00.000Z",
});

const FP = "a".repeat(64);
const txOperation = (id: string, boundary = "starts"): WalkRecord => ({
  t: "i", id, level: "operation", kind: "method", origin: "llm", fingerprint: FP,
  block: { answer: `Answer about ${id}.`, boundary, risks: [], description: `Description of ${id}.`, confidence: 0.5 },
});
const riskOperation = (id: string): WalkRecord => ({
  t: "i", id, level: "operation", kind: "method", origin: "llm", fingerprint: FP,
  block: { answer: "No.", risky: false, description: `Description of ${id}.`, confidence: 0.5 },
});
const explainOperation = (id: string): InsightRecord => ({
  t: "i", id, level: "operation", kind: "method", origin: "llm", fingerprint: FP,
  block: { name: "f", description: "Does f.", safe: true, idempotent: null, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.5 },
});

const exportOf = (store: { export(): Iterable<string> }): string => `${[...store.export()].join("\n")}\n`;
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const scratch = (): string => (dir = mkdtempSync(join(tmpdir(), "walk-store-")));
const open = (path: string): SqliteDatabase => loadSqlite().open(path);

/** A closed store file holding one side-car: a walk's when `format` is given, explain's otherwise. */
function storeFile(path: string, sidecar: string, format?: RecordFormat): string {
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("a walk's files sit beside the model, named by the walk", () => {
  it("<model>.N.walk.jsonl and <model>.N.walk.db; explain keeps <model>.insights.*", () => {
    expect(walkSidecarPathFor("/m/petclinic.jsonl", "tx-boundaries")).toBe("/m/petclinic.tx-boundaries.walk.jsonl");
    expect(walkStorePathFor("/m/petclinic.jsonl", "tx-boundaries")).toBe("/m/petclinic.tx-boundaries.walk.db");
    expect(walkSidecarPathFor("model", "a")).toBe("model.a.walk.jsonl");
    expect(walkStorePathFor("model", "a")).toBe("model.a.walk.db");
    expect(walkSidecarPathFor("/m/petclinic.jsonl", "explain")).toBe("/m/petclinic.insights.jsonl");
    expect(walkStorePathFor("/m/petclinic.jsonl", "explain")).toBe(insightsStorePathFor("/m/petclinic.insights.jsonl"));
  });

  it("refuses a name that is not a walk's: no path is ever built from it", () => {
    for (const name of ["../x", "a/b", "A", "", "insights", "1a"]) expect(() => walkSidecarPathFor("/m/model.jsonl", name), name).toThrow(/walk name/u);
  });
});

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

describe("the generic record codec: the block is checked by the walk's compiled schema", () => {
  const tx = compiledOf(TX);
  const format = walkRecords(tx);

  it("writes the walk in the header and the kind codegraph.walkRecords/1, and reads it back", () => {
    const text = encodeRecordsToString(format, headerOf(tx), [txOperation("o/b"), txOperation("o/a")], eof(2));
    const first = JSON.parse(text.split("\n")[0] ?? "") as Record<string, unknown>;
    expect(first["kind"]).toBe(WALK_RECORDS_KIND);
    expect(first["walk"]).toEqual({ name: "tx-boundaries", version: "1", digest: tx.digest, answerDigest: answerDigestOf(tx.answer) });
    expect(first).not.toHaveProperty("metamodel");
    const file = decodeRecords(format, text);
    expect(file.header).toEqual(headerOf(tx));
    expect(file.records.map((r) => r.id)).toEqual(["o/a", "o/b"]);
    expect(file.truncated).toBe(false);
  });

  it("refuses a block its schema rejects, on decode with the line number and on encode", () => {
    const text = encodeRecordsToString(format, headerOf(tx), [txOperation("o/a"), txOperation("o/b")], eof(2));
    const lines = text.trimEnd().split("\n");
    lines[2] = lines[2]!.replace('"boundary":"starts"', '"boundary":"sideways"');
    expect(() => decodeRecords(format, `${lines.join("\n")}\n`)).toThrow(/^line 3: invalid record of the walk "tx-boundaries": block\.boundary: /u);
    expect(() => encodeRecordsToString(format, headerOf(tx), [txOperation("o/a", "sideways")], eof(1))).toThrow();
    // An explain block is not this walk's either.
    expect(() => encodeRecordsToString(format, headerOf(tx), [explainOperation("o/a")], eof(1))).toThrow();
  });

  it("refuses a side-car of another walk, naming both: a walk's file to explain's decoder, explain's to a walk's, A's to B's", () => {
    const txText = encodeRecordsToString(format, headerOf(tx), [txOperation("o/a")], eof(1));
    const explainText = encodeInsightsToString(EXPLAIN_HEADER, [explainOperation("o/a")], eof(1));
    const risk = compiledOf(RISK);
    expect(() => decodeInsights(txText)).toThrow(InsightsFileError);
    expect(() => decodeInsights(txText)).toThrow(/line 1 is the header of the walk "tx-boundaries" \(codegraph\.walkRecords\/1\), not of the walk "explain" \(codegraph\.insights\/1\)/u);
    expect(() => decodeRecords(format, explainText)).toThrow(/line 1 is the header of the walk "explain" \(codegraph\.insights\/1\), not of the walk "tx-boundaries" \(codegraph\.walkRecords\/1\)/u);
    expect(() => decodeRecords(walkRecords(risk), txText)).toThrow(/line 1 is the header of the walk "tx-boundaries" .*, not of the walk "risk-review"/u);
    // A header that is no walk's at all is still told as before.
    expect(() => decodeRecords(format, '{"t":"header","kind":"codegraph.navigator/1"}\n')).toThrow(/line 1 is not a codegraph\.walkRecords\/1 header/u);
  });
});

// ---------------------------------------------------------------------------
// decode → import → export, for any walk
// ---------------------------------------------------------------------------

const wild = fc.string({ unit: "binary", maxLength: 12 });
const text = wild.filter((s) => !/\p{Surrogate}/u.test(s) && !s.includes("\u0000"));
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const usageArb = fc.record(
  { promptTokens: fc.nat(), completionTokens: fc.nat(), cost: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0 }) },
  { requiredKeys: ["promptTokens", "completionTokens"] },
);
const keyArb = fc.record({ lang: text, module: text, symbol: text, disambiguator: text }, { requiredKeys: ["lang", "module", "symbol"] });
const fingerprintArb = fc.stringMatching(/^[0-9a-f]{64}$/u);
const confidenceArb = fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => x + 0);

/** A block of `compiled`'s level: the declared fields from the grammar's own value arbitraries, the three every block carries. */
function blockArb(compiled: CompiledWalk, level: Level): fc.Arbitrary<Record<string, unknown>> {
  const fields = Object.fromEntries(compiled.definition.answer.fields[level].map((field) => [field.name, valueArb(field.type)]));
  return fc.record({ answer: wild, ...fields, description: wild, confidence: confidenceArb });
}

function recordArb(compiled: CompiledWalk, id: string): fc.Arbitrary<WalkRecord> {
  return fc.constantFrom(...LEVELS).chain((level) =>
    fc
      .record({
        key: maybe(keyArb), kind: text, name: maybe(text), file: maybe(text), scc: maybe(fc.array(text, { maxLength: 3 })),
        origin: fc.constantFrom("llm", "template"), block: blockArb(compiled, level), fingerprint: fingerprintArb,
        model: maybe(text), usage: maybe(usageArb), metadata: maybe(fc.dictionary(text, text, { maxKeys: 3 })),
      })
      .map((r) => strip({ t: "i", id, level, ...r }) as WalkRecord),
  );
}

const failureArb = (id: string): fc.Arbitrary<FailureRecord> =>
  fc
    .record({
      key: maybe(keyArb), level: fc.constantFrom(...LEVELS), members: fc.array(text.filter((s) => s !== ""), { minLength: 1, maxLength: 3 }),
      model: text,
      reason: fc.record({ kind: fc.constantFrom("provider", "invalid-answer", "error"), message: wild, status: maybe(fc.integer({ min: 100, max: 599 })), retryable: maybe(fc.boolean()) }).map(strip),
      attempts: fc.integer({ min: 1, max: 9 }), calls: fc.nat(9), usage: maybe(usageArb),
    })
    .map((f) => strip({ t: "f", id, ...f }) as FailureRecord);

/** Any grammar-shaped definition (its own fields per level, maybe a label): compiled, with a side-car of its records. */
const walkFileArb = fc
  .record({ operation: fieldsJsonArb, type: fieldsJsonArb, module: fieldsJsonArb, version: fc.stringMatching(/^[0-9a-z.]{1,6}$/u) })
  .map(({ operation, type, module, version }) => compiledOf({ kind: WALK_DEFINITION_KIND, name: "generated", version, answer: { fields: { operation, type, module } } } as WalkDefinitionJson))
  .chain((compiled) => {
    const ids = fc.uniqueArray(text.filter((s) => s !== ""), { maxLength: 8 });
    return fc
      .tuple(ids, ids)
      .chain(([recordIds, failureIds]) => fc.tuple(fc.tuple(...recordIds.map((id) => recordArb(compiled, id))), fc.tuple(...failureIds.map(failureArb)), usageArb, fc.boolean()))
      .map(([records, failures, usage, ended]) => {
        const format = walkRecords(compiled);
        const whole = encodeRecordsToString(format, headerOf(compiled), records, { ...eof(records.length, failures.length), usage }, failures);
        // A file cut short (no trailer) round-trips as one: the store does not invent an end.
        const sidecar = ended ? whole : `${whole.split("\n").slice(0, -2).join("\n")}\n`;
        return { compiled, format, sidecar };
      });
  });

describe("decode → import → export is the identity, for any walk's side-car (PLAN.md §22.4)", () => {
  it("over generated definitions and blocks, three levels, failures included, through the SQLite adapter", () => {
    fc.assert(
      fc.property(walkFileArb, ({ compiled, format, sidecar }) => {
        const store = sqliteInsightsStore(open(":memory:"), { format });
        try {
          store.importFile(decodeRecords(format, sidecar));
          expect(exportOf(store)).toBe(sidecar);
          // A walk has no words: the projection stays empty. Nor a concept — unless it declares a field of that name.
          expect(store.wordHits()).toEqual([]);
          if (!LEVELS.some((level) => compiled.definition.answer.fields[level].some((field) => field.name === "concept"))) expect(store.stats().byConcept).toEqual({});
        } finally {
          store.close();
        }
      }),
      { numRuns: 120 },
    );
  });

  it("the store quotes a record read back exactly as the walk quotes the record (its label, its description)", () => {
    const labelled = walkFileArb.filter(({ compiled }) => LEVELS.some((level) => compiled.definition.answer.fields[level].some((f) => f.type.kind !== "list" && f.type.kind !== "string[]")));
    fc.assert(
      fc.property(labelled, ({ compiled, format, sidecar }) => {
        const label = LEVELS.flatMap((level) => compiled.definition.answer.fields[level]).find((f) => f.type.kind !== "list" && f.type.kind !== "string[]")!.name;
        const withLabel = compileDefinition({ ...compiled.definition, answer: { ...compiled.definition.answer, label } });
        const spec = withLabel.spec(javaWalk().entityEnv);
        const store = sqliteInsightsStore(open(":memory:"), { format });
        try {
          const file = decodeRecords(format, sidecar);
          store.importFile(file);
          const book = storeBook(store, spec);
          for (const record of file.records) {
            expect(book.summary(record.id), record.id).toEqual(spec.quote(record));
            expect(quoteOf(spec, record)).toEqual(spec.quote(record));
          }
        } finally {
          store.close();
        }
      }),
      { numRuns: 80 },
    );
  });

  it("explain's quote reads only what it declares: its projection quotes as the whole record, from SQL as from memory", () => {
    const blockOf = {
      operation: fc.record({ owner: fc.constantFrom(...OPERATION_OWNERS), description: wild }).map((b) => ({ ...explainOperation("x").block, ...b })),
      type: fc.record({ concept: fc.constantFrom(...DOMAIN_CONCEPTS), description: wild }).map((b) => ({
        name: "T", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [],
        stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.5, ...b,
      })),
      module: fc.record({ boundedContextHint: fc.option(fc.record({ name: wild, rationale: wild }), { nil: null }), description: wild }).map((b) => ({
        name: "M", apis: [], spis: [], dependsOn: [], concepts: [], sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.5, ...b,
      })),
    };
    const explainRecordArb = (id: string) =>
      fc.constantFrom(...LEVELS).chain((level) => blockOf[level].map((block) => ({ t: "i", id, level, kind: "k", origin: "llm", fingerprint: FP, block }) as InsightRecord));
    fc.assert(
      fc.property(fc.uniqueArray(text.filter((s) => s !== ""), { minLength: 1, maxLength: 6 }).chain((ids) => fc.tuple(...ids.map(explainRecordArb))), (records) => {
        const store = sqliteInsightsStore(open(":memory:"));
        try {
          const file = decodeInsights(encodeInsightsToString(EXPLAIN_HEADER, records, eof(records.length)));
          store.importFile(file);
          const book = storeBook(store, EXPLAIN);
          for (const record of file.records) {
            expect(quoteOf(EXPLAIN, record)).toEqual(summaryOf(record));
            expect(book.summary(record.id)).toEqual(summaryOf(record));
            expect(store.summary(record.id)).toEqual(summaryOf(record));
          }
        } finally {
          store.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// The store is not a cache: another walk's store is refused, bytes untouched
// ---------------------------------------------------------------------------

describe("a store opened by a walk of another name is refused, its bytes untouched (PLAN.md §22.4)", () => {
  const tx = compiledOf(TX);
  const risk = compiledOf(RISK);
  const txSidecar = encodeRecordsToString(walkRecords(tx), headerOf(tx), [txOperation("o/a")], eof(1));
  const riskSidecar = encodeRecordsToString(walkRecords(risk), headerOf(risk), [riskOperation("o/a")], eof(1));
  const explainSidecar = encodeInsightsToString(EXPLAIN_HEADER, [explainOperation("o/a")], eof(1));

  /** Opening `path` as `format` (explain's when undefined, a reader when asked) throws a refusal naming both walks, and changes nothing on disk. */
  function refused(path: string, format: RecordFormat | undefined, both: readonly [string, string], readOnly = false): string {
    const before = sha256(path);
    const entries = readdirSync(dir!).sort();
    let message = "";
    const db = open(path);
    try {
      if (format === undefined) sqliteInsightsStore(db, { readOnly });
      else sqliteInsightsStore(db, { readOnly, format });
      throw new Error("opened");
    } catch (error) {
      expect(error).toBeInstanceOf(WalkMismatchError);
      message = (error as Error).message;
    } finally {
      db.close();
    }
    for (const name of both) expect(message).toContain(`the walk "${name}"`);
    expect(message).toMatch(/left untouched/u);
    expect(sha256(path)).toBe(before);
    expect(readdirSync(dir!).sort()).toEqual(entries);
    return message;
  }

  it("walk B opening walk A's store", () => {
    const path = storeFile(walkStorePathFor(join(scratch(), "model.jsonl"), "tx-boundaries"), txSidecar, walkRecords(tx));
    expect(refused(path, walkRecords(risk), ["tx-boundaries", "risk-review"])).toBe(
      'this store holds the records of the walk "tx-boundaries" (codegraph.walkRecords/1), not of the walk "risk-review" (codegraph.walkRecords/1): a store is opened only by the walk that wrote it; it was left untouched',
    );
  });

  it("a walk opening explain's store — and a pre-existing explain store (no walk key) is explain's", () => {
    const path = storeFile(join(scratch(), "model.insights.db"), explainSidecar);
    refused(path, walkRecords(tx), ["explain", "tx-boundaries"]);
    // Explain itself opens it as ever.
    const store = sqliteInsightsStore(open(path));
    expect(store.records().map((r) => r.id)).toEqual(["o/a"]);
    store.close();
  });

  it("explain opening a walk's store, as a writer and as a reader", () => {
    const path = storeFile(walkStorePathFor(join(scratch(), "model.jsonl"), "tx-boundaries"), txSidecar, walkRecords(tx));
    refused(path, undefined, ["tx-boundaries", "explain"]);
    refused(path, undefined, ["tx-boundaries", "explain"], true);
    refused(path, EXPLAIN_RECORDS, ["tx-boundaries", "explain"]);
  });

  it("a side-car of one walk imported into another's store: refused by the decoder, and by the store if decoded as its own", () => {
    const path = storeFile(walkStorePathFor(join(scratch(), "model.jsonl"), "risk-review"), riskSidecar, walkRecords(risk));
    const before = sha256(path);
    const store = sqliteInsightsStore(open(path), { format: walkRecords(risk) });
    try {
      expect(() => decodeRecords(walkRecords(risk), txSidecar)).toThrow(/the walk "tx-boundaries".*not of the walk "risk-review"/u);
      const theirs = decodeRecords(walkRecords(tx), txSidecar);
      expect(() => store.importFile(theirs)).toThrow(WalkMismatchError);
      expect(() => store.importFile(theirs)).toThrow(/this side-car holds the records of the walk "tx-boundaries" .*, not of the walk "risk-review"/u);
      expect(() => store.beginRun({ header: headerOf(tx), startedAt: "t" })).toThrow(/the walk "tx-boundaries".*not of the walk "risk-review"/u);
      expect(store.records().map((r) => r.block)).toEqual([riskOperation("o/a").block]);
    } finally {
      store.close();
    }
    expect(sha256(path)).toBe(before);
  });

  it("an empty store has no walk yet: any walk may begin it", () => {
    const path = join(scratch(), "model.risk-review.walk.db");
    sqliteInsightsStore(open(path)).close();
    const store = sqliteInsightsStore(open(path), { format: walkRecords(risk) });
    expect(store.isEmpty()).toBe(true);
    store.importFile(decodeRecords(walkRecords(risk), riskSidecar));
    store.close();
    refused(path, undefined, ["risk-review", "explain"]);
  });

  it("keeps the store at version 2: a walk's store needs no migration", () => {
    const path = storeFile(join(scratch(), "model.tx-boundaries.walk.db"), txSidecar, walkRecords(tx));
    const db = open(path);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: INSIGHTS_DB_VERSION });
    expect(INSIGHTS_DB_VERSION).toBe(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// The digest notice
// ---------------------------------------------------------------------------

describe("a changed definition of the same walk is told, not refused, and nothing is written before a run begins", () => {
  it("same name, another digest: opened; previous and current exposed; open + plan + compare write nothing", async () => {
    const tx = compiledOf(TX);
    const retasked = compiledOf(TX_RETASKED);
    expect(retasked.name).toBe(tx.name);
    expect(retasked.digest).not.toBe(tx.digest);
    const { path } = await walkedStore(scratch(), tx);
    const before = sha256(path);
    const entries = readdirSync(dir!).sort();

    const { walk, base, entityEnv } = javaWalk();
    const format = walkRecords(retasked);
    const store = sqliteInsightsStore(open(path), { format });
    const spec = retasked.spec(entityEnv);
    const inScope = resolveSelection(retasked.selection, { ...entityEnv, spec }).inScope;
    const plan = planRun(walk, storeBook(store, spec), { ...base, spec }, { ...WALK_OPTIONS, inScope });
    // The task moved every asked unit's fingerprint: all of them would be asked again.
    expect(plan.estimates.calls).toBeGreaterThan(0);
    // Another task, the same answer: the answer digest does not move, so the store is the walk's still.
    const answerDigest = answerDigestOf(tx.answer);
    expect(answerDigestOf(retasked.answer)).toBe(answerDigest);
    expect(walkChange(store.header(), format)).toEqual({
      previous: { name: "tx-boundaries", version: "1", digest: tx.digest, answerDigest },
      current: { name: "tx-boundaries", version: "1", digest: retasked.digest, answerDigest },
    });
    expect(walkChange(store.header(), walkRecords(tx))).toBeUndefined();
    store.close();
    expect(sha256(path)).toBe(before);
    expect(readdirSync(dir!).sort()).toEqual(entries);

    // The first write is the run's: once it begins, the file moves.
    const writer = sqliteInsightsStore(open(path), { format });
    writer.beginRun({ header: headerOf(retasked), startedAt: "2026-11-21T01:00:00.000Z" });
    expect(walkChange(writer.header(), format)).toBeUndefined();
    writer.close();
    expect(sha256(path)).not.toBe(before);
  });

  /**
   * Restated in step 7a (it read "a changed ANSWER keeps what was bought readable … only writes take the new shape"):
   * the fingerprint hashes the answer schema, so new fields re-ask every unit anyway, and a store holding both shapes
   * exported a side-car NEITHER definition decodes. So the answer joins the walk's identity and is refused like a name.
   */
  it("a changed ANSWER is another walk: its store, side-car and run header are refused like another name's, bytes untouched", () => {
    const v1 = compiledOf(RISK);
    const v2 = compiledOf({ ...RISK, answer: { fields: { operation: { risk: { enum: ["low", "high"] } } } } } as WalkDefinitionJson);
    expect(v2.name).toBe(v1.name);
    expect(answerDigestOf(v2.answer)).not.toBe(answerDigestOf(v1.answer));
    const old = encodeRecordsToString(walkRecords(v1), headerOf(v1), [riskOperation("o/a"), riskOperation("o/b")], eof(2));
    const path = storeFile(join(scratch(), "model.risk-review.walk.db"), old, walkRecords(v1));
    const before = sha256(path);
    const entries = readdirSync(dir!).sort();
    for (const readOnly of [false, true]) {
      const db = open(path);
      try {
        expect(() => sqliteInsightsStore(db, { readOnly, format: walkRecords(v2) })).toThrow(WalkMismatchError);
        expect(() => sqliteInsightsStore(db, { readOnly, format: walkRecords(v2) })).toThrow(
          /^this store holds the records of the walk "risk-review" \(codegraph\.walkRecords\/1\) under other answer fields: every unit would be asked again anyway, so a changed answer is another walk — under another name it keeps its own store; it was left untouched$/u,
        );
      } finally {
        db.close();
      }
    }
    expect(sha256(path)).toBe(before);
    expect(readdirSync(dir!).sort()).toEqual(entries);
    // The side-car of the old answer, to the new definition's decoder; the old header, to a run or an import of the new.
    expect(() => decodeRecords(walkRecords(v2), old)).toThrow(/^line 1 is the header of the walk "risk-review" \(codegraph\.walkRecords\/1\) under other answer fields: /u);
    const fresh = sqliteInsightsStore(open(join(dir!, "fresh.walk.db")), { format: walkRecords(v2) });
    try {
      expect(() => fresh.beginRun({ header: headerOf(v1), startedAt: "t" })).toThrow(/this run's header holds the records of the walk "risk-review" .* under other answer fields/u);
      expect(() => fresh.importFile(decodeRecords(walkRecords(v1), old))).toThrow(/this side-car holds the records of the walk "risk-review" .* under other answer fields/u);
      expect(() => encodeRecordsToString(walkRecords(v2), headerOf(v1), [], eof(0))).toThrow(/under other answer fields/u);
      expect(fresh.isEmpty()).toBe(true);
    } finally {
      fresh.close();
    }
  });

  it("the answer digest is the compiled blocks', canonically: a task, a label or a spelling moves it not; a field does", () => {
    const base = compiledOf(TX);
    const digest = answerDigestOf(base.answer);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(walkRecords(base).walk).toEqual({ name: base.name, version: base.version, digest: base.digest, answerDigest: digest });
    const answer = TX["answer"] as { label: string; fields: Record<string, Record<string, unknown>> };
    const same: readonly WalkDefinitionJson[] = [
      TX_RETASKED,
      { ...TX, version: "2" },
      { ...TX, answer: { fields: answer.fields } },
      // Field order and the long spelling of a scalar are not the block's shape.
      { ...TX, answer: { ...answer, fields: { module: { area: { type: "string", nullable: true } }, type: answer.fields["type"], operation: { risks: { type: "string[]" }, boundary: { enum: ["starts", "joins", "none"] } } } } },
    ] as WalkDefinitionJson[];
    for (const json of same) expect(answerDigestOf(compiledOf(json).answer), JSON.stringify(json)).toBe(digest);
    const other: readonly WalkDefinitionJson[] = [
      { ...TX, answer: { ...answer, fields: { ...answer.fields, module: { area: "string" } } } },
      { ...TX, answer: { ...answer, fields: { ...answer.fields, operation: { boundary: { enum: ["joins", "starts", "none"] }, risks: "string[]" } } } },
      { ...TX, answer: { ...answer, fields: { ...answer.fields, operation: { ...answer.fields["operation"], extra: "boolean" } } } },
    ] as WalkDefinitionJson[];
    for (const json of other) expect(answerDigestOf(compiledOf(json).answer), JSON.stringify(json)).not.toBe(digest);
  });

  it("the lenient read stays: a format naming no answer (a reader holding no definition) reads and exports the old blocks as stored", () => {
    const v1 = compiledOf(RISK);
    const v2 = compiledOf({ ...RISK, answer: { fields: { operation: { risk: { enum: ["low", "high"] } } } } } as WalkDefinitionJson);
    const old = encodeRecordsToString(walkRecords(v1), headerOf(v1), [riskOperation("o/a"), riskOperation("o/b")], eof(2));
    const path = storeFile(join(scratch(), "model.risk-review.walk.db"), old, walkRecords(v1));
    const before = sha256(path);
    const reader: RecordFormat = Object.freeze({ ...walkRecords(v2), walk: undefined });
    const store = sqliteInsightsStore(open(path), { readOnly: true, format: reader });
    try {
      expect(exportOf(store)).toBe(old);
      expect(store.get(["o/a"])[0]?.block).toEqual(riskOperation("o/a").block);
      expect(storeBook(store, v2.spec(javaWalk().entityEnv)).summary("o/a")).toEqual({ description: "Description of o/a.", concept: undefined });
    } finally {
      store.close();
    }
    expect(sha256(path)).toBe(before);
  });

  it("an empty store tells nothing; explain plain and customized tell each other", () => {
    expect(walkChange(undefined, walkRecords(compiledOf(TX)))).toBeUndefined();
    const custom = explainWalkIdentity({ instructions: "Answer in French." });
    expect(custom).toEqual({ name: "explain", version: PROMPT_VERSION, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(explainWalkIdentity({})).toBeUndefined();
    expect(explainWalkIdentity({ instructions: "  ", entities: [] })).toBeUndefined();
    expect(explainWalkIdentity({ instructions: " Answer in French.\n" })).toEqual(custom);
    expect(explainWalkIdentity({ instructions: "Answer in German." })?.digest).not.toBe(custom?.digest);
    expect(explainWalkIdentity({ entities: [{ select: parseSelector({ id: BASKET }), instructions: "Cart." }] })?.digest).not.toBe(custom?.digest);
    const customized = InsightsHeader.parse({ ...EXPLAIN_HEADER, walk: custom });
    expect(walkChange(EXPLAIN_HEADER, EXPLAIN_RECORDS)).toBeUndefined();
    expect(walkChange(EXPLAIN_HEADER, explainRecords(custom))).toEqual({ previous: undefined, current: custom });
    expect(walkChange(customized, EXPLAIN_RECORDS)).toEqual({ previous: custom, current: undefined });
    expect(walkChange(customized, explainRecords(custom))).toBeUndefined();
    // A plain explain's header gains no key; a customized one carries `walk` after `kind`.
    expect(JSON.stringify(InsightsHeader.parse(EXPLAIN_HEADER))).toBe(JSON.stringify(EXPLAIN_HEADER));
    expect(Object.keys(customized).slice(0, 3)).toEqual(["t", "kind", "walk"]);
    expect(() => InsightsHeader.parse({ ...EXPLAIN_HEADER, walk: { ...custom, name: "tx-boundaries" } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// End to end: a generic walk through a real store, closed and re-opened
// ---------------------------------------------------------------------------

/** Every unit's rendered prompts, as a run would render them against `book`. */
function promptsOf(book: RecordSource, env: PlanEnv): Map<string, string> {
  const { walk } = javaWalk();
  const contextEnv: ContextEnv = { ...env, records: book, depth: RUN_OPTIONS.depth, maxLines: RUN_OPTIONS.maxLines, terms: RUN_OPTIONS.terms };
  return new Map(walk.units.map((unit) => [unit.id, renderPrompts(contextPackFor(unit, contextEnv), RUN_OPTIONS.maxScc).map((p) => `${p.system}\n${p.user}`).join("\n----\n")]));
}

/** `compiled` run on the Java fixture with the schema completer into its own store file, as `codegraph walk` will. */
async function walkedStore(root: string, compiled: CompiledWalk, spec?: WalkSpec) {
  const { walk, base, entityEnv } = javaWalk();
  const used = spec ?? compiled.spec(entityEnv);
  const env: PlanEnv = { ...base, spec: used };
  const format = walkRecords(compiled);
  const path = walkStorePathFor(join(root, "model.jsonl"), compiled.name);
  const store = sqliteInsightsStore(open(path), { format });
  const inScope = resolveSelection(compiled.selection, { ...entityEnv, spec: used }).inScope;
  const options = { ...WALK_OPTIONS, inScope };
  const book = storeBook(store, used);
  const plan = planRun(walk, book, env, options);
  const run = store.beginRun({ header: headerOf(compiled), startedAt: "2026-11-21T00:00:00.000Z" });
  book.begin(run);
  const result = await executeRun<WalkRecord>(plan, env, book, schemaCompleter(walk), RUN_OPTIONS, { concurrency: 1, onFailure: (failure) => store.fail(run, failure) });
  store.finishRun(run, { eof: eof(result.counts.records, result.failures.length), failures: result.failures });
  const prompts = promptsOf(book, env);
  const exported = exportOf(store);
  store.close();
  return { path, plan, result, prompts, exported, env, options, format, spec: used };
}

describe("a generic walk end to end on the Java fixture, through a real store closed and re-opened", () => {
  it("re-opened: 0 calls, and every dependent's prompt is byte-identical to the one rendered before the close", { timeout: 60_000 }, async () => {
    const tx = compiledOf(TX);
    const first = await walkedStore(scratch(), tx);
    expect(first.result.failures).toEqual([]);
    expect(first.plan.estimates.calls).toBeGreaterThan(0);
    // Not vacuous: dependents quote both levels' labels and the descriptions.
    const all = [...first.prompts.values()].join("\n");
    expect(all).toMatch(/\[operation, boundary: starts\] \(.+\): Description of /u);
    expect(all).toMatch(/\[type, boundary: owns\] \(.+\): Description of /u);

    const store = sqliteInsightsStore(open(first.path), { format: first.format });
    try {
      const book = storeBook(store, first.spec);
      const again = planRun(javaWalk().walk, book, first.env, first.options);
      expect(again.estimates.calls).toBe(0);
      expect(again.estimates.byStatus.llm).toBe(0);
      const after = promptsOf(book, first.env);
      for (const [id, prompt] of first.prompts) expect(after.get(id), id).toBe(prompt);
      expect(exportOf(store)).toBe(first.exported);
    } finally {
      store.close();
    }
  });

  it("a spec that declares no projection is quoted from the whole record read back: the same prompts", { timeout: 60_000 }, async () => {
    const tx = compiledOf(TX);
    const { quoted: _quoted, ...whole } = tx.spec(javaWalk().entityEnv);
    const first = await walkedStore(scratch(), tx, whole);
    const store = sqliteInsightsStore(open(first.path), { format: first.format });
    try {
      const after = promptsOf(storeBook(store, whole), first.env);
      for (const [id, prompt] of first.prompts) expect(after.get(id), id).toBe(prompt);
      expect(after).toEqual(promptsOf(memoryBook(store.records(), whole), first.env));
    } finally {
      store.close();
    }
  });

  it("export → decode → import into a fresh store → export is identical; a block violating its schema is refused with its line", { timeout: 60_000 }, async () => {
    const tx = compiledOf(TX);
    const { exported, format } = await walkedStore(scratch(), tx);
    const fresh = sqliteInsightsStore(open(":memory:"), { format });
    fresh.importFile(decodeRecords(format, exported));
    expect(exportOf(fresh)).toBe(exported);
    fresh.close();
    const lines = exported.trimEnd().split("\n");
    const at = lines.findIndex((line) => line.includes('"level":"type"'));
    expect(at).toBeGreaterThan(0);
    const record = JSON.parse(lines[at]!) as { block: Record<string, unknown> };
    lines[at] = JSON.stringify({ ...record, block: { ...record.block, notes: [{ line: "one", text: "x" }] } });
    expect(() => decodeRecords(format, `${lines.join("\n")}\n`)).toThrow(new RegExp(`^line ${at + 1}: invalid record of the walk "tx-boundaries": block\\.notes\\.0\\.line: `, "u"));
  });
});

// ---------------------------------------------------------------------------
// Explain's own store, untouched
// ---------------------------------------------------------------------------

describe("an existing version-2 explain store opens, plans and exports as it did", () => {
  it("built by explain's own run on the Java fixture: re-opened, it plans 0 calls, writes nothing, exports the same bytes", { timeout: 60_000 }, async () => {
    const { walk, base } = javaWalk();
    const env: PlanEnv = { ...base, spec: EXPLAIN };
    const path = join(scratch(), "model.insights.db");
    const store = sqliteInsightsStore(open(path));
    const book = storeBook(store, EXPLAIN);
    const plan = planRun(walk, book, env, WALK_OPTIONS);
    const run = store.beginRun({ header: EXPLAIN_HEADER, startedAt: "2026-11-21T00:00:00.000Z" });
    book.begin(run);
    const result = await executeRun(plan, env, book, schemaCompleter(walk), RUN_OPTIONS, { concurrency: 1 });
    expect(result.failures).toEqual([]);
    store.finishRun(run, { eof: eof(result.counts.records), failures: [] });
    const prompts = promptsOf(book, env);
    const exported = exportOf(store);
    store.close();
    const before = sha256(path);

    const reopened = sqliteInsightsStore(open(path));
    const again = storeBook(reopened, EXPLAIN);
    expect(planRun(walk, again, env, WALK_OPTIONS).estimates.calls).toBe(0);
    expect(promptsOf(again, env)).toEqual(prompts);
    expect(walkChange(reopened.header(), EXPLAIN_RECORDS)).toBeUndefined();
    expect(exportOf(reopened)).toBe(exported);
    reopened.close();
    expect(sha256(path)).toBe(before);
    // Its header is the plain explain's: no `walk` key.
    expect(exported.split("\n")[0]).toBe(JSON.stringify(EXPLAIN_HEADER));
  });
});
