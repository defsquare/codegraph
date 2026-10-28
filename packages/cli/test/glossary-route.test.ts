import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, identityView, loadModels, loadSqlite, makeView } from "@codegraph/analyzer";
import {
  GLOSSARY_ANSWER_KIND,
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  decodeInsights,
  encodeInsightsToString,
  sqliteInsightsStore,
  type InsightRecord,
  type InsightsHeader,
  type WordConcern,
  type WordEntry,
} from "@codegraph/insights";
import { glossaryLookup, modelPlacement } from "../src/glossary-route.js";
import { storeReader } from "../src/insight-route.js";

/**
 * `/glossary.json?term=…[&scope=…][&limit=…]`: what the explained entities under
 * a scope said a word means (PLAN.md §20.3), from the store `/insight.json`
 * reads, placed by the model `serve` holds.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const graph = buildGraph(loadModels(readModelFileSync(FIXTURE), { sources: [FIXTURE] }).union);
const MODULE = "java:com.acme.order";
const ORDER = "java:com.acme.order/Order";
const SERVICE = "java:com.acme.order/OrderService";
const BILL = "java:com.acme.order/OrderService.bill(com.acme.order.Order)";

const said = (word: string, concern: WordConcern, sense: string, inside: string[], confidence = 0.8): WordEntry =>
  ({ word, in: inside, concern, sense, meaning: `${sense}, here.`, confidence });

function record(id: string, level: "module" | "type" | "operation", words: WordEntry[] | undefined, glossary?: object[]): InsightRecord {
  const block =
    level === "module"
      ? { name: "M", description: "A module.", apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.6, glossary: glossary ?? [] }
      : level === "type"
        ? { name: "T", description: "A type.", concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: false, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.7 }
        : { name: "op", description: "Bills.", safe: false, idempotent: false, owner: "domainService", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.7 };
  const kind = level === "module" ? "package" : level === "type" ? "class" : "method";
  return { t: "i", id, level, kind, origin: "llm", model: "strong/model", fingerprint: "a".repeat(64), block: { ...block, ...(words === undefined ? {} : { words }) } } as InsightRecord;
}

const dir = mkdtempSync(join(tmpdir(), "glossary-route-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function storeAt(name: string, records: readonly InsightRecord[]): string {
  const header: InsightsHeader = {
    t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
    models: { leaf: "cheap/model", rollup: "strong/model" }, provider: "openrouter", depth: 1,
    source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
  };
  const path = join(dir, name);
  const store = sqliteInsightsStore(loadSqlite().open(path));
  const eof = { t: "eof" as const, counts: { records: records.length, llm: records.length, template: 0, reused: 0, failed: 0 }, usage: { promptTokens: 0, completionTokens: 0 }, generatedAt: "2026-10-28T10:00:00.000Z" };
  store.importFile(decodeInsights(encodeInsightsToString(header, records, eof)));
  store.close();
  return path;
}

const RECORDS = [
  record(MODULE, "module", [said("order", "domain", "the ordering business", ["com.acme.order"])], [
    { word: "order", concern: "domain", sense: "a customer's request", meaning: "What a customer asks for.", polysemous: false, senses: [] },
  ]),
  record(ORDER, "type", [said("order", "domain", "a customer's request", ["Order"])]),
  record(SERVICE, "type", [said("order", "domain", "a customer's request", ["OrderService"]), said("service", "domain", "after-sales care", ["OrderService"], 0.6)]),
  record(BILL, "operation", [said("bill", "domain", "to invoice", ["bill"]), said("order", "domain", "the order billed", ["order"])]),
  // No such entity in this model: explained against another version of it.
  record("java:com.acme.order/Refund", "type", [said("order", "domain", "a refunded order", ["orderId"])]),
];
const STORE = storeAt("model.insights.db", RECORDS);

function lookup(path = STORE, view = identityView) {
  let builds = 0;
  const reader = storeReader(path);
  const handle = glossaryLookup(reader, () => {
    builds += 1;
    return modelPlacement(graph, view);
  });
  const ask = (query: Record<string, string>) => {
    const answer = handle.handle(new URLSearchParams(query));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> };
  };
  return { ask, builds: () => builds, close: () => reader.close() };
}

const ids = (body: Record<string, unknown>): string[] => (body["entries"] as { id: string; owner?: string }[]).map((e) => (e.owner === undefined ? e.id : `${e.id} in ${e.owner}`));

describe("glossary.json", () => {
  it("answers the corpus when no scope is named: every entry of an entity the model holds, and the modules' reconciliations", () => {
    const { ask, close } = lookup();
    const corpus = ask({ term: "order" });
    expect(corpus.status).toBe(200);
    expect(corpus.body).toMatchObject({ kind: GLOSSARY_ANSWER_KIND, status: "found", term: "order", total: { entries: 4, glossary: 1 }, withoutWords: 0 });
    // Refund is not in this model: left out. An operation names the type a page reveals for it.
    expect(ids(corpus.body)).toEqual([MODULE, ORDER, SERVICE, `${BILL} in ${SERVICE}`]);
    expect(ask({ term: "order", scope: "" }).body).toEqual(corpus.body);
    close();
  });

  it("answers a type with the type and its members, a module with what folds into it — the carriers' fold", () => {
    const { ask, close } = lookup();
    expect(ids(ask({ term: "order", scope: SERVICE }).body)).toEqual([SERVICE, `${BILL} in ${SERVICE}`]);
    expect(ask({ term: "order", scope: SERVICE }).body["glossary"]).toEqual([]);
    expect(ids(ask({ term: "order", scope: MODULE }).body)).toEqual([MODULE, ORDER, SERVICE, `${BILL} in ${SERVICE}`]);
    expect(ask({ term: "order", scope: MODULE }).body["glossary"]).toMatchObject([{ id: MODULE, entry: { sense: "a customer's request", meaning: "What a customer asks for." } }]);
    // `adapter` is another module: nothing of com.acme.order folds into it.
    expect(ask({ term: "order", scope: "java:com.acme.order.adapter" }).body).toMatchObject({ status: "found", entries: [], glossary: [] });
    expect(ids(ask({ term: "order", limit: "1" }).body)).toEqual([MODULE]);
    close();
  });

  it("is 404 for a scope that is no module or type of the model — an operation, an unknown id, a stub", () => {
    const { ask, close } = lookup();
    expect(graph.isStub("java:java.lang/String")).toBe(true);
    for (const scope of [BILL, "java:nowhere", "java:java.lang/String"]) {
      expect(ask({ term: "order", scope })).toEqual({ status: 404, body: { kind: GLOSSARY_ANSWER_KIND, status: "unknown-scope", scope } });
    }
    close();
  });

  it("places by the page's view: an entity the view drops is under no scope, and no scope itself", () => {
    const noMethods = makeView("noMethods", (entity) => entity.kind !== "method", () => true);
    const { ask, close } = lookup(STORE, noMethods);
    expect(ids(ask({ term: "order" }).body)).toEqual([MODULE, ORDER, SERVICE]);
    const noOrder = makeView("noOrder", (entity) => entity.id !== ORDER, () => true);
    const without = lookup(STORE, noOrder);
    expect(without.ask({ term: "order", scope: ORDER }).body).toMatchObject({ status: "unknown-scope" });
    without.close();
    close();
  });

  it("is 400 for a request it cannot ask: no term, a limit that is no whole number — and builds nothing for it", () => {
    const { ask, builds, close } = lookup();
    for (const query of [{}, { term: "" }, { term: "order", limit: "-1" }, { term: "order", limit: "2.5" }]) {
      const answer = ask(query);
      expect(answer.status, JSON.stringify(query)).toBe(400);
      expect(answer.body["error"]).toMatch(/glossary\.json/u);
    }
    expect(builds()).toBe(0);
    close();
  });

  it("with no store it is 404, quietly: no file created, no placement built — and a store that comes later is found", () => {
    const late = join(dir, "late.insights.db");
    const { ask, builds, close } = lookup(late);
    expect(ask({ term: "order" })).toEqual({ status: 404, body: { kind: GLOSSARY_ANSWER_KIND, status: "no-store" } });
    expect(readdirSync(dir)).not.toContain("late.insights.db");
    expect(builds()).toBe(0);
    storeAt("late.insights.db", RECORDS.slice(0, 2));
    expect(ids(ask({ term: "order" }).body)).toEqual([MODULE, ORDER]);
    ask({ term: "order", scope: ORDER });
    // Built once, at the first request a store could answer.
    expect(builds()).toBe(1);
    close();
  });
});
