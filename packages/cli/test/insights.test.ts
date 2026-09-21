import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  decodeInsights,
  encodeInsightsToString,
  sqliteInsightsStore,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
} from "@codegraph/insights";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `codegraph insights` reads the STORE — never the model, never the side-car,
 * never a provider — so these tests build a real store on disk and run the
 * command in-process against it.
 */

const HEADER: InsightsHeader = {
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "cheap/model", rollup: "strong/model" }, provider: "openrouter", depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const FP = "a".repeat(64);
const ORDER = "java:com.acme.order/Order";
const operation = (id: string, origin: "llm" | "template" = "llm"): InsightRecord => ({
  t: "i", id, level: "operation", kind: "method", origin, fingerprint: FP,
  block: { name: "total", description: "Sums the order lines.", safe: true, idempotent: true, owner: "aggregate", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.8 },
});
const type = (id: string, concept: "aggregate" | "valueType" | "entity", confidence: number): InsightRecord => ({
  t: "i", id, level: "type", kind: "class", name: id.slice(id.lastIndexOf("/") + 1), file: "src/Order.java", origin: "llm", model: "strong/model-served", fingerprint: FP,
  usage: { promptTokens: 1200, completionTokens: 300, cost: 0.002 },
  block: { name: "Order", description: `A customer's order.\nIt owns its lines and guards the total.`, concept, eventKind: null, interfaceRole: null, aggregateRoot: true, containedIn: null, syncPattern: null, identity: "id", fields: [], invariants: [{ name: "non-negative total", predicate: "total >= 0", enforcement: "rejection" }], stateMachine: null, relatesTo: [], exposes: ["total"], dependsOn: [], domainTerms: ["order"], confidence },
});
const RECORDS = [operation(`${ORDER}.total()`), operation(`${ORDER}.getId()`, "template"), type(ORDER, "aggregate", 0.9), type("java:com.acme.order/Money", "valueType", 0.35)];
const FAILED: FailureRecord = {
  t: "f", id: "java:com.acme.order", level: "module", members: ["java:com.acme.order"], model: "strong/model",
  reason: { kind: "provider", message: "This request requires more credits.", status: 402, retryable: false }, attempts: 2, calls: 1,
};
const eof = (records: number): InsightsEof => ({
  t: "eof", counts: { records, llm: 3, template: 1, reused: 0, failed: 1 }, usage: { promptTokens: 2400, completionTokens: 600, cost: 0.0041 }, generatedAt: "2026-09-20T10:05:00.000Z",
});

let dir: string;
let model: string;
let db: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "insights-cmd-"));
  model = join(dir, "model.jsonl");
  db = join(dir, "model.insights.db");
  // The command never opens the model: any bytes will do, and these would not parse.
  writeFileSync(model, "not a model\n");
  const store = sqliteInsightsStore(loadSqlite().open(db));
  store.importFile(decodeInsights(encodeInsightsToString(HEADER, RECORDS, eof(RECORDS.length), [FAILED])));
  const run = store.beginRun({ header: HEADER, startedAt: "2026-09-20T10:00:00.000Z", pid: 1 });
  store.finishRun(run, { eof: eof(RECORDS.length), failures: [FAILED], calls: 4 });
  store.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function insights(...argv: string[]) {
  const io = captureIo();
  const code = runSync(["insights", model, ...argv], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("codegraph insights: what was bought, at a glance", () => {
  it("with no filter prints the store's summary: records, concepts, what is owed, and the ledger's total spend", () => {
    const { code, out, err } = insights();
    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
    expect(out).toContain(db);
    expect(out).toMatch(/4 records: 2 operations, 2 types, 0 modules \(3 explained, 1 templated\)/u);
    expect(out).toMatch(/models: cheap\/model \(operations\), strong\/model \(types, modules\); depth 1; provider openrouter/u);
    expect(out).toMatch(/concepts: aggregate 1, valueType 1/u);
    expect(out).toMatch(/1 failure owed/u);
    expect(out).toMatch(/these records cost 2400 prompt \+ 600 completion tokens, \$0\.0040/u);
    expect(out).toMatch(/ledger: 1 run, 4 calls, 2400 prompt \+ 600 completion tokens, \$0\.0041/u);
  });

  it("--json is one kind-tagged document with the same facts", () => {
    const { code, out } = insights("--json");
    expect(code).toBe(EXIT.OK);
    const doc = JSON.parse(out) as { kind: string; store: string; stats: { records: number; byConcept: Record<string, number> }; runs: unknown[] };
    expect(doc.kind).toBe("codegraph.insightsSummary/1");
    expect(doc.store).toBe(db);
    expect(doc.stats.records).toBe(4);
    expect(doc.stats.byConcept).toEqual({ aggregate: 1, valueType: 1 });
    expect(doc.runs).toHaveLength(1);
  });

  it("reads the store and nothing else: the model is not parsed, and not a file appears or changes", () => {
    const before = readFileSync(db);
    insights();
    insights("--concept", "aggregate");
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["model.insights.db", "model.jsonl"]);
  });
});

describe("codegraph insights: a list", () => {
  it("--concept lists the types of that concept, one line each: id, concept, confidence, the description's first line", () => {
    const { code, out } = insights("--concept", "aggregate");
    expect(code).toBe(EXIT.OK);
    expect(out.trimEnd().split("\n")).toEqual([`${ORDER}\taggregate\t0.90\tA customer's order.`]);
  });

  it("--max-confidence finds what deserves a second look; --level and --limit narrow", () => {
    expect(insights("--max-confidence", "0.5").out).toContain("java:com.acme.order/Money\tvalueType\t0.35");
    expect(insights("--max-confidence", "0.5").out).not.toContain(`${ORDER}\t`);
    expect(insights("--level", "operation").out.trimEnd().split("\n")).toHaveLength(2);
    expect(insights("--level", "operation", "--limit", "1").out.trimEnd().split("\n")).toHaveLength(1);
  });

  it("a list that matches nothing says so on stderr and prints nothing", () => {
    const { code, out, err } = insights("--concept", "repository");
    expect(code).toBe(EXIT.OK);
    expect(out).toBe("");
    expect(err).toMatch(/no record matches/u);
  });

  it("--json lists rows — never blocks", () => {
    const doc = JSON.parse(insights("--level", "type", "--json").out) as { kind: string; rows: { id: string; concept: string; description: string; block?: unknown }[] };
    expect(doc.kind).toBe("codegraph.insightsList/1");
    expect(doc.rows.map((r) => r.id)).toEqual(["java:com.acme.order/Money", ORDER]);
    expect(doc.rows[1]?.description).toContain("guards the total");
    expect(doc.rows[0]?.block).toBeUndefined();
  });

  it("rejects a confidence that is not a number in [0, 1], and an unknown level", () => {
    expect(insights("--min-confidence", "high").code).toBe(EXIT.USAGE);
    expect(insights("--min-confidence", "1.5").code).toBe(EXIT.USAGE);
    expect(insights("--level", "package").code).toBe(EXIT.USAGE);
  });
});

describe("codegraph insights --id: one explanation, whole", () => {
  it("prints the envelope, the description in full, and the block", () => {
    const { code, out } = insights("--id", ORDER);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`${ORDER}\n`);
    expect(out).toMatch(/type \(class\) · aggregate · confidence 0\.90/u);
    expect(out).toMatch(/src\/Order\.java · llm · strong\/model-served · 1200 \+ 300 tokens, \$0\.0020/u);
    expect(out).toContain("A customer's order.\nIt owns its lines and guards the total.");
    expect(out).toContain('"predicate": "total >= 0"');
  });

  it("--json is the record exactly as the side-car carries it", () => {
    const { out } = insights("--id", ORDER, "--json");
    expect(JSON.parse(out)).toEqual(RECORDS[2]);
  });

  it("an id that FAILED is answered with why — exit 3, the reason and the status", () => {
    const { code, out, err } = insights("--id", "java:com.acme.order");
    expect(code).toBe(EXIT.FINDINGS);
    expect(out).toBe("");
    expect(err).toMatch(/not explained.*402.*requires more credits.*2 attempts/su);
  });

  it("an id the store has never heard of is a usage error naming it", () => {
    const { code, err } = insights("--id", "java:nope/Nothing");
    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("java:nope/Nothing");
  });
});

describe("codegraph insights --failures / --runs", () => {
  it("--failures lists what is owed, with the reason", () => {
    const { code, out } = insights("--failures");
    expect(code).toBe(EXIT.OK);
    expect(out.trimEnd()).toBe("java:com.acme.order\tmodule\tprovider 402\t2 attempts\tThis request requires more credits.");
  });

  it("--runs is the ledger, oldest first", () => {
    const { out } = insights("--runs");
    expect(out.trimEnd()).toBe("#1\t2026-09-20T10:00:00.000Z → 2026-09-20T10:05:00.000Z\tcheap/model, strong/model\t3 explained, 1 templated, 0 reused, 1 failed\t4 calls, 2400 + 600 tokens, $0.0041");
  });
});

describe("codegraph insights: no store, or not ours", () => {
  it("no store beside the model is a usage error that says how one comes to exist", () => {
    const io = captureIo();
    const lonely = join(dir, "lonely.jsonl");
    writeFileSync(lonely, "x\n");
    try {
      expect(runSync(["insights", lonely], io)).toBe(EXIT.USAGE);
      expect(io.stderr()).toMatch(/no insights store at .*lonely\.insights\.db/u);
      expect(io.stderr()).toMatch(/codegraph explain/u);
      // Asking must not create one.
      expect(readdirSync(dir)).not.toContain("lonely.insights.db");
    } finally {
      rmSync(lonely);
    }
  });

  it("--store names it directly, and a SQLite file that is not an insights store is refused", () => {
    expect(runSync(["insights", model, "--store", db, "--concept", "aggregate"], captureIo())).toBe(EXIT.OK);
    const other = join(dir, "other.db");
    const foreign = loadSqlite().open(other);
    foreign.exec("CREATE TABLE entity (id INTEGER PRIMARY KEY)");
    foreign.close();
    const io = captureIo();
    try {
      expect(runSync(["insights", model, "--store", other], io)).toBe(EXIT.USAGE);
      expect(io.stderr()).toMatch(/not an insights store/u);
    } finally {
      rmSync(other);
    }
  });
});
