import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  WALK_DEFINITION_KIND,
  WALK_RECORDS_KIND,
  answerDigestOf,
  compileDefinition,
  decodeInsights,
  decodeRecords,
  encodeInsightsToString,
  encodeRecordsToString,
  parseWalkDefinition,
  sqliteInsightsStore,
  walkRecords,
  walkStorePathFor,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type WalkRecord,
  type WalkRecordsHeader,
} from "@codegraph/insights";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `codegraph insights --walk N` (PLAN.md §22.5, step 7b): a walk's store read
 * as explain's is — from the store alone, writing nothing — in the walk's own
 * words. Its summary, lists, `--id`, `--failures` and `--runs` are generic;
 * what only explain's blocks carry (a concept, words) is answered "none".
 * Without `--walk`, or with `--walk explain`, `insights` is what it was.
 */

const compiled = compileDefinition(parseWalkDefinition({
  kind: WALK_DEFINITION_KIND,
  name: "risk",
  answer: {
    fields: {
      operation: { owner: "string", risky: "boolean", notes: "string[]" },
      type: { level: { enum: ["low", "high"], nullable: true } },
      module: { area: { list: { name: "string", weight: "number" } } },
    },
  },
}));
const WALK_HEADER: WalkRecordsHeader = {
  t: "header", kind: WALK_RECORDS_KIND,
  walk: { name: "risk", version: compiled.version, digest: compiled.digest, answerDigest: answerDigestOf(compiled.answer) },
  generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, models: { leaf: "leaf-model", rollup: "rollup-model" }, provider: "openrouter", depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const FP = "f".repeat(64);
const OP = "java:com.acme.order/OrderService#place(Order)";
const TYPE = "java:com.acme.order/Order";
const MODULE = "java:com.acme.order";
const WALK_RECORDS: WalkRecord[] = [
  { t: "i", id: OP, level: "operation", kind: "method", file: "src/OrderService.java", origin: "llm", model: "leaf-served", fingerprint: FP, usage: { promptTokens: 100, completionTokens: 20, cost: 0.0001 },
    block: { answer: "It writes the order\nand never checks the total.", notes: ["unchecked total", "no lock"], owner: "aggregate", risky: true, description: "Places an order.", confidence: 0.7 } },
  { t: "i", id: TYPE, level: "type", kind: "class", origin: "llm", model: "rollup-served", fingerprint: FP, block: { answer: "Holds lines.", level: null, description: "An order.\nWith lines.", confidence: 0.9 } },
  { t: "i", id: MODULE, level: "module", kind: "package", origin: "llm", model: "rollup-served", fingerprint: FP, block: { answer: "Ordering.", area: [{ name: "orders", weight: 2 }], description: "The order module.", confidence: 0.4 } },
];
const WALK_FAILED: FailureRecord = { t: "f", id: "java:com.acme.order/Money", level: "type", members: ["java:com.acme.order/Money"], model: "rollup-model", reason: { kind: "provider", message: "too long", status: 400 }, attempts: 1, calls: 1 };
const eof = (records: number, failed: number): InsightsEof => ({
  t: "eof", counts: { records, llm: records, template: 0, reused: 0, failed }, usage: { promptTokens: 30, completionTokens: 6 }, generatedAt: "2026-11-21T10:05:00.000Z",
});

const EXPLAIN_HEADER: InsightsHeader = {
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" }, depth: 1, source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const EXPLAIN_RECORDS: InsightRecord[] = [
  { t: "i", id: OP, level: "operation", kind: "method", origin: "llm", fingerprint: FP,
    block: { name: "place", description: "Places.", safe: false, idempotent: null, owner: "aggregate", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.5 } },
  { t: "i", id: TYPE, level: "type", kind: "class", origin: "llm", fingerprint: FP,
    block: { name: "Order", description: "An order.", concept: "aggregate", eventKind: null, interfaceRole: null, aggregateRoot: true, containedIn: null, syncPattern: null, identity: "id", fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.8 } },
];
const EXPLAIN_FAILED: FailureRecord = { ...WALK_FAILED, model: "m" };

let dir: string;
let model: string;
let walkStore: string;
let explainStore: string;
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "insights-walk-"));
  model = join(dir, "model.jsonl");
  // Never opened: the path only says which stores.
  writeFileSync(model, "not a model\n");
  walkStore = walkStorePathFor(model, "risk");
  const format = walkRecords(compiled);
  const store = sqliteInsightsStore(loadSqlite().open(walkStore), { format });
  store.importFile(decodeRecords(format, encodeRecordsToString(format, WALK_HEADER, WALK_RECORDS, eof(3, 1), [WALK_FAILED])));
  const run = store.beginRun({ header: WALK_HEADER, startedAt: "2026-11-21T10:00:00.000Z", pid: 1 });
  store.finishRun(run, { eof: eof(3, 1), failures: [WALK_FAILED], calls: 4 });
  store.close();

  explainStore = join(dir, "model.insights.db");
  const explain = sqliteInsightsStore(loadSqlite().open(explainStore));
  explain.importFile(decodeInsights(encodeInsightsToString(EXPLAIN_HEADER, EXPLAIN_RECORDS, eof(2, 1), [EXPLAIN_FAILED])));
  explain.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function insights(...argv: string[]) {
  const io = captureIo();
  const code = runSync(["insights", model, ...argv], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("codegraph insights --walk N: a walk's store, in the walk's words", () => {
  it("the summary names the walk and its definition, counts answers, and says nothing of concepts or words", () => {
    const { code, out, err } = insights("--walk", "risk");
    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
    expect(out.trimEnd().split("\n")).toEqual([
      `insights: ${walkStore}`,
      `  walk: risk, version 1 (definition ${compiled.digest.slice(0, 12)})`,
      "  3 records: 1 operation, 1 type, 1 module (3 answered)",
      "  models: leaf-model (operations), rollup-model (types, modules); depth 1; provider openrouter",
      "  1 failure owed — 'codegraph insights --walk risk --failures' lists them, 'codegraph walk … --retry-failed' under the same definition redoes them",
      "  these records cost 100 prompt + 20 completion tokens, $0.0001 (their own usage; failed and replaced calls are in the ledger only)",
      "  ledger: 1 run, 4 calls, 30 prompt + 6 completion tokens",
    ]);
  });

  it("--json is the summary's document, naming the walk; the header is the walk's", () => {
    const doc = JSON.parse(insights("--walk", "risk", "--json").out) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["kind", "walk", "store", "header", "stats", "runs"]);
    expect(doc).toMatchObject({ kind: "codegraph.insightsSummary/1", walk: "risk", store: walkStore, header: WALK_HEADER, stats: { records: 3, failures: 1, byConcept: {}, withoutWords: 0 } });
  });

  it("--id prints the block generically: the answer, every field by name, the description; confidence in the envelope", () => {
    const { code, out } = insights("--walk", "risk", "--id", OP);
    expect(code).toBe(EXIT.OK);
    expect(out.trimEnd().split("\n")).toEqual([
      OP,
      "  operation (method) · walk risk · confidence 0.70",
      "  src/OrderService.java · llm · leaf-served · 100 + 20 tokens, $0.0001",
      "",
      "answer: It writes the order",
      "  and never checks the total.",
      "notes:",
      "  - unchecked total",
      "  - no lock",
      "owner: aggregate",
      "risky: true",
      "description: Places an order.",
    ]);
    expect(insights("--walk", "risk", "--id", TYPE).out).toContain("\n\nanswer: Holds lines.\nlevel: —\ndescription: An order.\n  With lines.\n");
    expect(insights("--walk", "risk", "--id", MODULE).out).toContain("\n\nanswer: Ordering.\narea:\n  - name: orders\n    weight: 2\ndescription: The order module.\n");
  });

  it("--id --json is the record as the store holds it", () => {
    expect(JSON.parse(insights("--walk", "risk", "--id", OP, "--json").out)).toEqual(WALK_RECORDS[0]);
  });

  it("--id of a unit that failed says why, in the walk's words; an unknown one names the walk", () => {
    const failed = insights("--walk", "risk", "--id", "java:com.acme.order/Money");
    expect(failed.code).toBe(EXIT.FINDINGS);
    expect(failed.err.trimEnd().split("\n")).toEqual([
      "java:com.acme.order/Money is not answered by the walk \"risk\": provider 400: too long (1 attempt, model rollup-model).",
      "Once the cause is dealt with: codegraph walk … --retry-failed, under the same definition",
    ]);
    const unknown = insights("--walk", "risk", "--id", "java:nope/Nothing");
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.err).toContain(`no record of the walk "risk" for 'java:nope/Nothing' in ${walkStore}`);
    expect(unknown.err).toContain("'codegraph insights --walk risk --level type' lists what the store holds");
  });

  it("lists by level and confidence: id, level (a walk has no concept), confidence, the description's first line", () => {
    expect(insights("--walk", "risk", "--level", "type").out.trimEnd()).toBe(`${TYPE}\ttype\t0.90\tAn order.`);
    expect(insights("--walk", "risk", "--min-confidence", "0.5").out.trimEnd().split("\n")).toEqual([`${OP}\toperation\t0.70\tPlaces an order.`, `${TYPE}\ttype\t0.90\tAn order.`]);
    expect(insights("--walk", "risk", "--max-confidence", "0.5", "--limit", "1").out.trimEnd()).toBe(`${MODULE}\tmodule\t0.40\tThe order module.`);
    const doc = JSON.parse(insights("--walk", "risk", "--level", "operation", "--json").out) as { kind: string; rows: Record<string, unknown>[] };
    expect(doc.kind).toBe("codegraph.insightsList/1");
    // A walk names a field `owner`: explain's "owned by" label must not read it.
    expect(doc.rows[0]).not.toHaveProperty("concept");
  });

  it("--failures and --runs are the walk's, in its words", () => {
    expect(insights("--walk", "risk", "--failures").out.trimEnd()).toBe("java:com.acme.order/Money\ttype\tprovider 400\t1 attempt\ttoo long");
    expect(insights("--walk", "risk", "--runs").out.trimEnd()).toBe("#1\t2026-11-21T10:00:00.000Z → 2026-11-21T10:05:00.000Z\tleaf-model, rollup-model\t3 answered, 0 templated, 0 reused, 1 failed\t4 calls, 30 + 6 tokens");
  });

  it("--concept and the word reports answer none — never an empty table, never a crash", () => {
    const cases: readonly (readonly [readonly string[], string, string, string])[] = [
      [["--concept", "aggregate"], "--concept", "concept", "concepts"],
      [["--level", "type", "--concept", "aggregate"], "--concept", "concept", "concepts"],
      [["--word", "order"], "--word", "words", "words"],
      [["--glossary", MODULE], "--glossary", "words", "glossaries"],
      [["--polysemy"], "--polysemy", "words", "words"],
      [["--concerns"], "--concerns", "words", "words"],
    ];
    for (const [argv, flag, what, explains] of cases) {
      const text = insights("--walk", "risk", ...argv);
      expect(text.code, flag).toBe(EXIT.OK);
      expect(text.out, flag).toBe("");
      expect(text.err, flag).toBe(`none: a walk's blocks carry no ${what} — the walk "risk" answers its own fields; explain's ${explains} are read by 'codegraph insights ${flag} …' without --walk.\n`);
      const json = insights("--walk", "risk", ...argv, "--json");
      expect(json.code, flag).toBe(EXIT.OK);
      expect(json.err, flag).toBe("");
      expect(JSON.parse(json.out), flag).toEqual({ kind: "codegraph.insightsNone/1", walk: "risk", asked: flag, none: `a walk's blocks carry no ${what}` });
    }
  });

  it("reads the store and nothing else: not a byte changes, not a file appears", () => {
    const before = sha256(walkStore);
    const listing = readdirSync(dir).sort();
    for (const argv of [[], ["--json"], ["--id", OP], ["--level", "type"], ["--failures"], ["--runs"], ["--concept", "x"], ["--word", "order"]]) insights("--walk", "risk", ...argv);
    expect(sha256(walkStore)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(listing);
  });
});

describe("codegraph insights --walk N: no store, or another walk's", () => {
  it("a missing store names the walk and the path, and creates nothing", () => {
    const { code, out, err } = insights("--walk", "absent");
    expect(code).toBe(EXIT.USAGE);
    expect(out).toBe("");
    expect(err).toContain(`no store of the walk "absent" at ${join(dir, "model.absent.walk.db")}`);
    expect(err).toContain("'codegraph walk <model.jsonl> --name absent' (or a --walk FILE naming it) creates it");
    expect(readdirSync(dir)).not.toContain("model.absent.walk.db");
  });

  it("another walk's store at that path is refused as the store refuses it, bytes untouched", () => {
    const other = join(dir, "model.other.walk.db");
    copyFileSync(walkStore, other);
    try {
      const before = sha256(other);
      const { code, err } = insights("--walk", "other");
      expect(code).toBe(EXIT.USAGE);
      expect(err).toContain(`${other}: this store holds the records of the walk "risk" (codegraph.walkRecords/1), not of the walk "other" (codegraph.walkRecords/1): a store is opened only by the walk that wrote it; it was left untouched`);
      expect(err).toContain("--walk NAME reads N's");
      expect(sha256(other)).toBe(before);
      // explain's store is not a walk's, nor the reverse.
      expect(insights("--walk", "risk", "--store", explainStore).err).toContain('of the walk "explain" (codegraph.insights/1), not of the walk "risk"');
      expect(insights("--walk", "explain", "--store", walkStore).err).toContain('of the walk "risk" (codegraph.walkRecords/1), not of the walk "explain"');
    } finally {
      rmSync(other, { force: true });
    }
  });

  it("refuses a name no walk can have, before any path is built from it", () => {
    for (const name of ["insights", "Risk", "../x"]) {
      const { code, err } = insights("--walk", name);
      expect(code, name).toBe(EXIT.USAGE);
      expect(err, name).toContain("is not a walk name");
    }
  });
});

describe("codegraph insights --store FILE: whichever walk's store the file is", () => {
  it("reads a walk's store as that walk's, chosen from its header — and explain's as explain's", () => {
    const viaStore = insights("--store", walkStore);
    expect(viaStore.code).toBe(EXIT.OK);
    expect(viaStore.out).toBe(insights("--walk", "risk").out);
    expect(insights("--store", walkStore, "--id", OP).out).toBe(insights("--walk", "risk", "--id", OP).out);
    expect(insights("--store", explainStore).out).toBe(insights().out);
  });
});

describe("--walk explain, or no --walk: explain's insights, unchanged", () => {
  it("prints exactly what no flag prints, for every question", () => {
    for (const argv of [[], ["--json"], ["--id", OP], ["--id", TYPE, "--json"], ["--level", "type"], ["--concept", "aggregate"], ["--word", "order"], ["--failures"], ["--runs"], ["--id", "java:com.acme.order/Money"], ["--id", "java:nope"]]) {
      expect(insights("--walk", "explain", ...argv), argv.join(" ")).toEqual(insights(...argv));
    }
    // explain's own words stand: a concept, records explained under prompt 1.
    expect(insights().out).toMatch(/\(2 explained, 0 templated\)/u);
    expect(insights().out).toMatch(/2 explained under prompt 1/u);
    expect(insights("--concept", "aggregate").out.trimEnd()).toBe(`${TYPE}\taggregate\t0.80\tAn order.`);
  });
});
