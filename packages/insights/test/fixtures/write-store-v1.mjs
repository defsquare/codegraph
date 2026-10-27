// The version-1 store of store.test.ts's migration tests, written by the VERSION-1 build's own code
// (packages/insights/dist built at eb0fab4, the last commit whose store is version 1) to stand for the files
// users hold. store-v1.sql is `sqlite3 store-v1.insights.db .dump` plus the two PRAGMAs a dump does not
// carry; store-v1.insights.jsonl is the export that build wrote. Never regenerate them: this script stays
// to say what they hold, and it refuses any other build.
// Usage, from such a build: node write-store-v1.mjs <repo> <out-dir>
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const [repo, outDir] = process.argv.slice(2);
const { sqliteInsightsStore, decodeInsights, encodeInsightsToString, INSIGHTS_DB_VERSION, INSIGHTS_KIND, INSIGHTS_GENERATOR, INSIGHTS_METAMODEL } =
  await import(join(repo, "packages/insights/dist/index.js"));
const { loadSqlite } = await import(join(repo, "packages/analyzer/dist/index.js"));
if (INSIGHTS_DB_VERSION !== 1) throw new Error(`this is not the version-1 build (${INSIGHTS_DB_VERSION})`);

const header = (promptVersion, provider) => ({
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "openai/gpt-5.6-luna", rollup: "openai/gpt-5.6-luna" }, provider, depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
});
const OPERATION = {
  name: "total", description: "Sums the order's lines.", safe: true, idempotent: true, owner: "entity", handlesCommand: null,
  emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: ["order"], confidence: 0.8,
};
const TYPE = {
  name: "Order", description: "A customer's order.", concept: "aggregate", eventKind: null, interfaceRole: null, aggregateRoot: true,
  containedIn: null, syncPattern: null, identity: "reference", fields: [], invariants: [], stateMachine: null, relatesTo: [],
  exposes: [], dependsOn: [], domainTerms: ["order"], confidence: 0.9,
};
const MODULE = {
  name: "Ordering", description: "Takes orders.", apis: [], spis: [], dependsOn: [], concepts: [{ name: "Order", concept: "aggregate" }], boundedContextHint: { name: "Ordering", rationale: "its own words" },
  sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.6,
};
const key = (module, symbol, disambiguator) => ({ lang: "java", module, symbol, ...(disambiguator === undefined ? {} : { disambiguator }) });
const fp = (c) => c.repeat(64);
const usage = { promptTokens: 1400, completionTokens: 450, cost: 0.0004 };
const rec = (id, level, kind, block, extra) => ({ t: "i", id, level, kind, origin: "llm", block, fingerprint: fp("1"), model: "openai/gpt-5.6-luna", usage, ...extra });

// Explained under prompt 1: no words anywhere.
const prompt1 = [
  rec("java:com.acme.order/Order.total()", "operation", "method", OPERATION, { key: key("com.acme.order", "Order.total", "()"), name: "total", file: "com/acme/order/Order.java" }),
  rec("java:com.acme.order/Order.reference()", "operation", "method", { ...OPERATION, name: "reference", description: "Returns the reference." },
    { origin: "template", model: undefined, usage: undefined, key: key("com.acme.order", "Order.reference", "()"), name: "reference", file: "com/acme/order/Order.java" }),
  rec("java:com.acme.order/Basket.add(com.acme.order.Basket.Line)", "operation", "method", { ...OPERATION, name: "add", description: "Adds a line — « déjà » 注文 \u{1F4E6}." },
    { key: key("com.acme.order", "Basket.add", "(com.acme.order.Basket.Line)"), scc: ["java:com.acme.order/Basket.add(com.acme.order.Basket.Line)"] }),
  rec("java:com.acme.order/Order", "type", "class", TYPE, { key: key("com.acme.order", "Order"), name: "Order", file: "com/acme/order/Order.java", metadata: { note: "kept" } }),
  rec("java:com.acme.order/Basket", "type", "class", { ...TYPE, name: "Basket", concept: "entity", aggregateRoot: false }, { key: key("com.acme.order", "Basket"), name: "Basket" }),
  rec("java:com.acme.order", "module", "package", MODULE, { key: key("com.acme.order", "com.acme.order"), name: "com.acme.order" }),
];
const failures = [
  { t: "f", id: "java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)", level: "operation", members: ["java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)"],
    model: "openai/gpt-5.6-luna", reason: { kind: "provider", message: "no credits", status: 402, retryable: false }, attempts: 1, calls: 1 },
  { t: "f", id: "java:com.acme.order.legacy/List", level: "type", members: ["java:com.acme.order.legacy/List", "java:com.acme.order.legacy/Node"], key: key("com.acme.order.legacy", "List"),
    model: "openai/gpt-5.6-luna", reason: { kind: "invalid-answer", message: "missing `fields`" }, attempts: 2, calls: 2, usage: { promptTokens: 3000, completionTokens: 900 } },
];
const eof1 = { t: "eof", counts: { records: 6, llm: 5, template: 1, reused: 0, failed: 2 }, usage: { promptTokens: 7000, completionTokens: 2250, cost: 0.002 }, generatedAt: "2026-10-20T09:00:00.000Z" };

const path = join(outDir, "store-v1.insights.db");
rmSync(path, { force: true });
const store = sqliteInsightsStore(loadSqlite().open(path));
store.importFile(decodeInsights(encodeInsightsToString(header("1", "openrouter"), prompt1, eof1, failures)));
store.markExported({ path: "model.insights.jsonl", size: 4321, mtimeMs: 1760950800000 });

// Then a run of a build that already asks prompt 2 but still writes version 1 (PR #35): two units with words.
const run = store.beginRun({ header: header("2", "openrouter"), startedAt: "2026-10-27T10:00:00.000Z", pid: 4242 });
const words = [
  { word: "order", in: ["Order"], concern: "domain", sense: "a customer's request", meaning: "What a customer asked to buy.", confidence: 0.9 },
  { word: "reference", in: ["reference"], concern: "domain", sense: "the order's identity", meaning: "How an order is told apart.", confidence: 0.7 },
];
store.putUnit(run, "java:com.acme.order/Order", [rec("java:com.acme.order/Order", "type", "class", { ...TYPE, words }, { key: key("com.acme.order", "Order"), name: "Order", file: "com/acme/order/Order.java", fingerprint: fp("2") })]);
store.putUnit(run, "java:com.acme.order", [rec("java:com.acme.order", "module", "package", {
  ...MODULE,
  words: [{ word: "order", in: ["com.acme.order"], concern: "domain", sense: "the ordering business", meaning: "The package that takes orders.", confidence: 0.8 }],
  glossary: [{ word: "order", concern: "domain", sense: "a customer's request", meaning: "What a customer asked to buy.", polysemous: false, senses: [] }],
}, { key: key("com.acme.order", "com.acme.order"), name: "com.acme.order", fingerprint: fp("2") })]);
store.finishRun(run, {
  eof: { t: "eof", counts: { records: 6, llm: 2, template: 0, reused: 4, failed: 2 }, usage: { promptTokens: 3200, completionTokens: 1100, cost: 0.0009 }, generatedAt: "2026-10-27T10:05:00.000Z" },
  failures, calls: 2,
});
const sidecar = `${[...store.export()].join("\n")}\n`;
store.close();
writeFileSync(join(outDir, "store-v1.insights.jsonl"), sidecar);
console.log(`wrote ${path} (store version ${INSIGHTS_DB_VERSION})`);
