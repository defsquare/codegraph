import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSIGHT_ANSWER_KIND as CANONICAL_KIND } from "@codegraph/insights";
import { INSIGHT_ANSWER_KIND, blockFacts, createInsightLoader, parseInsightAnswer, type Fetcher } from "../src/insight.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ORDER = "java:com.acme.order/Order";

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const explained = (id = ORDER): unknown => ({
  kind: CANONICAL_KIND, id, status: "explained",
  record: {
    t: "i", id, level: "type", kind: "class", origin: "llm", model: "strong/model-served", fingerprint: "a".repeat(64),
    block: { name: "Order", description: "A customer's order.", concept: "aggregate", aggregateRoot: true, identity: "id", eventKind: null, fields: [], invariants: [{ name: "non-negative total", predicate: "total >= 0", enforcement: "rejection" }], exposes: ["total", "addLine"], domainTerms: [], confidence: 0.9 },
  },
});

const respond = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the explanation's bundle boundary", () => {
  /** The insights package is zod, the analyzer and the SQLite loader: none of it may reach the browser. */
  it("never imports @codegraph/insights — not even for types; the shape is restated here", () => {
    const offenders = sourceFiles(SRC).filter((path) => /from\s+"@codegraph\/insights"/u.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  /** THE DRIFT ALARM, as for the navigator artifact's kind. */
  it("restates the answer's kind exactly", () => {
    expect(INSIGHT_ANSWER_KIND).toBe(CANONICAL_KIND);
  });
});

describe("parseInsightAnswer", () => {
  it("reads an explained record down to what the panel shows", () => {
    expect(parseInsightAnswer(explained())).toEqual({
      status: "explained", id: ORDER, level: "type", origin: "llm", model: "strong/model-served", confidence: 0.9,
      description: "A customer's order.", concept: "aggregate",
      block: expect.objectContaining({ identity: "id" }) as unknown,
    });
  });

  it("reads a failure down to why", () => {
    const answer = parseInsightAnswer({ kind: CANONICAL_KIND, id: ORDER, status: "failed", failure: { model: "m", attempts: 2, reason: { kind: "provider", status: 402, message: "no credits" } } });
    expect(answer).toEqual({ status: "failed", id: ORDER, model: "m", attempts: 2, reason: "provider 402: no credits" });
  });

  it("anything else — another kind, a record without a block, not an object — is nothing to show, never a throw", () => {
    expect(parseInsightAnswer({ kind: "codegraph.navigator/1" })).toEqual({ status: "none" });
    expect(parseInsightAnswer({ kind: CANONICAL_KIND, id: ORDER, status: "explained", record: { id: ORDER } })).toEqual({ status: "none" });
    expect(parseInsightAnswer({ kind: CANONICAL_KIND, id: ORDER, status: "unknown" })).toEqual({ status: "none" });
    expect(parseInsightAnswer(null)).toEqual({ status: "none" });
    expect(parseInsightAnswer("<!doctype html>")).toEqual({ status: "none" });
  });
});

describe("the loader: quiet, and asked once", () => {
  it("fetches insight.json RELATIVE to the page (the app daemon serves under a token), with the id encoded", async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (url) => {
      urls.push(url);
      return Promise.resolve(respond(200, explained()));
    };
    const answer = await createInsightLoader(fetcher).load(ORDER);
    expect(answer.status).toBe("explained");
    expect(urls).toEqual([`insight.json?id=${encodeURIComponent(ORDER)}`]);
  });

  it("a 404, a server that is not codegraph's, a dropped connection: all are 'none' — a page with no explanations looks as it did", async () => {
    expect(await createInsightLoader(() => Promise.resolve(respond(404, { kind: CANONICAL_KIND, id: ORDER, status: "unknown" }))).load(ORDER)).toEqual({ status: "none" });
    expect(await createInsightLoader(() => Promise.resolve(new Response("<!doctype html>", { status: 200 }))).load(ORDER)).toEqual({ status: "none" });
    expect(await createInsightLoader(() => Promise.reject(new TypeError("fetch failed"))).load(ORDER)).toEqual({ status: "none" });
  });

  it("asks once per id, however often the node is reselected — and stops asking a server that has no such route", async () => {
    let calls = 0;
    const loader = createInsightLoader(() => {
      calls += 1;
      return Promise.resolve(respond(200, explained()));
    });
    await Promise.all([loader.load(ORDER), loader.load(ORDER)]);
    await loader.load(ORDER);
    expect(calls).toBe(1);

    // The Vite dev server and a static host answer index.html for anything: after one such answer, no more requests.
    let probes = 0;
    const absent = createInsightLoader(() => {
      probes += 1;
      return Promise.resolve(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    });
    await absent.load("a");
    await absent.load("b");
    expect(probes).toBe(1);
  });
});

describe("blockFacts: the block as the panel lists it", () => {
  it("keeps what says something — named things, lists, true flags — and drops nulls, empties and what the header already shows", () => {
    const parsed = parseInsightAnswer(explained());
    if (parsed.status !== "explained") throw new Error("expected an explained answer");
    expect(blockFacts(parsed.block)).toEqual([
      { label: "aggregate root", values: ["yes"] },
      { label: "identity", values: ["id"] },
      { label: "invariants", values: ["non-negative total — total >= 0 (rejection)"] },
      { label: "exposes", values: ["total", "addLine"] },
    ]);
  });

  it("renders a state machine and nested hints without inventing structure", () => {
    expect(blockFacts({ stateMachine: { states: ["NEW", "PAID"], transitions: [{ from: "NEW", to: "PAID", operation: "pay" }] }, boundedContextHint: { name: "Ordering", rationale: "owns the order lifecycle" } })).toEqual([
      { label: "state machine", values: ["states: NEW, PAID", "NEW → PAID (pay)"] },
      { label: "bounded context hint", values: ["Ordering — owns the order lifecycle"] },
    ]);
  });
});
