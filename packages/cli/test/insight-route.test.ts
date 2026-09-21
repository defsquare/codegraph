import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  INSIGHT_ANSWER_KIND,
  PROMPT_VERSION,
  decodeInsights,
  encodeInsightsToString,
  sqliteInsightsStore,
  type FailureRecord,
  type InsightRecord,
  type InsightsHeader,
} from "@codegraph/insights";
import { directoryAssets } from "../src/assets.js";
import { insightLookup } from "../src/insight-route.js";
import { captureIo } from "../src/io.js";
import { startArtifactServer } from "../src/serve.js";

/**
 * `/insight.json?id=…`: the one DYNAMIC route of `codegraph serve` — a selected
 * node's explanation, answered from the store at request time. Everything else
 * the page loads is an artifact built once; this cannot be (26 MB of prose does
 * not belong in navigator.json), so it is a lookup.
 */

const HEADER: InsightsHeader = {
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" }, depth: 1, source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const ORDER = "java:com.acme.order/Order";
const RECORD: InsightRecord = {
  t: "i", id: ORDER, level: "type", kind: "class", origin: "llm", model: "m-served", fingerprint: "a".repeat(64),
  block: { name: "Order", description: "A customer's order.", concept: "aggregate", eventKind: null, interfaceRole: null, aggregateRoot: true, containedIn: null, syncPattern: null, identity: "id", fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.9 },
};
const FAILED: FailureRecord = { t: "f", id: "java:com.acme.order", level: "module", members: ["java:com.acme.order"], model: "m", reason: { kind: "provider", message: "no credits", status: 402 }, attempts: 1, calls: 1 };

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "insight-route-"));
  db = join(dir, "model.insights.db");
  const store = sqliteInsightsStore(loadSqlite().open(db));
  store.importFile(decodeInsights(encodeInsightsToString(HEADER, [RECORD], { t: "eof", counts: { records: 1, llm: 1, template: 0, reused: 0, failed: 1 }, usage: { promptTokens: 1, completionTokens: 1 }, generatedAt: "2026-09-21T00:00:00.000Z" }, [FAILED])));
  store.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const query = (id?: string): URLSearchParams => new URLSearchParams(id === undefined ? {} : { id });

describe("insightLookup", () => {
  it("answers an explained id with its record, a failed one with why, an unknown one with 404", () => {
    const lookup = insightLookup(db);
    try {
      const found = lookup.handle(query(ORDER));
      expect(found.status).toBe(200);
      expect(JSON.parse(found.body)).toEqual({ kind: INSIGHT_ANSWER_KIND, id: ORDER, status: "explained", record: RECORD });
      const failed = lookup.handle(query("java:com.acme.order"));
      expect(failed.status).toBe(200);
      expect(JSON.parse(failed.body)).toMatchObject({ status: "failed", failure: { reason: { status: 402 } } });
      const unknown = lookup.handle(query("java:nope/Nothing"));
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ kind: INSIGHT_ANSWER_KIND, id: "java:nope/Nothing", status: "unknown" });
      expect(lookup.handle(query()).status).toBe(400);
    } finally {
      lookup.close();
    }
  });

  it("with no store there is nothing to say — 404, quietly, and asking creates no file", () => {
    const absent = join(dir, "absent.insights.db");
    const lookup = insightLookup(absent);
    expect(lookup.handle(query(ORDER)).status).toBe(404);
    expect(readdirSync(dir)).not.toContain("absent.insights.db");
    lookup.close();
  });

  it("finds a store that comes to exist AFTER the server started: `explain` may be run while the page is open", () => {
    const late = join(dir, "late.insights.db");
    const lookup = insightLookup(late);
    expect(lookup.handle(query(ORDER)).status).toBe(404);
    const store = sqliteInsightsStore(loadSqlite().open(late));
    store.importFile(decodeInsights(encodeInsightsToString(HEADER, [RECORD], { t: "eof", counts: { records: 1, llm: 1, template: 0, reused: 0, failed: 0 }, usage: { promptTokens: 1, completionTokens: 1 }, generatedAt: "t" })));
    store.close();
    expect(lookup.handle(query(ORDER)).status).toBe(200);
    lookup.close();
  });

  it("a file that is not an insights store is 404 for the page, not a crash for the server", () => {
    const other = join(dir, "other.db");
    const foreign = loadSqlite().open(other);
    foreign.exec("CREATE TABLE entity (id INTEGER PRIMARY KEY)");
    foreign.close();
    const lookup = insightLookup(other);
    expect(lookup.handle(query(ORDER)).status).toBe(404);
    lookup.close();
  });
});

describe("the artifact server answers lookup routes", () => {
  const servers: Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
  });

  it("GET /insight.json?id=… is answered at request time, uncached; artifacts and the jail are as before", async () => {
    const assets = mkdtempSync(join(tmpdir(), "codegraph-serve-"));
    writeFileSync(join(assets, "index.html"), "<!doctype html><title>fake</title>");
    const lookup = insightLookup(db);
    let closed = false;
    const server = startArtifactServer({
      routes: { "/navigator.json": `{"kind":"codegraph.navigator/1"}` },
      lookups: { "/insight.json": lookup.handle },
      onClose: () => {
        lookup.close();
        closed = true;
      },
      label: "codegraph", assets: directoryAssets(assets), port: 0, io: captureIo(),
    });
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const found = await fetch(`${base}/insight.json?id=${encodeURIComponent(ORDER)}`);
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(((await found.json()) as { record: { id: string } }).record.id).toBe(ORDER);
    expect((await fetch(`${base}/insight.json?id=nope`)).status).toBe(404);
    expect((await fetch(`${base}/navigator.json`)).status).toBe(200);
    expect((await fetch(`${base}/insight.json?id=x`, { method: "POST" })).status).toBe(405);

    await new Promise((resolve) => server.close(() => resolve(undefined)));
    expect(closed).toBe(true);
  });
});
