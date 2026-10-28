import { describe, expect, it } from "vitest";
import { GLOSSARY_ANSWER_KIND as CANONICAL_KIND } from "@codegraph/insights";
import { GLOSSARY_ANSWER_KIND, createGlossaryLoader, glossaryUrl, parseGlossaryAnswer, type Fetcher } from "../src/glossary.js";

const MODULE = "java:com.acme.order";
const SERVICE = "java:com.acme.order/OrderService";
const BILL = "java:com.acme.order/OrderService.bill(com.acme.order.Order)";

const entry = (id: string, level: string, owner?: string) => ({
  id, level, kind: level === "operation" ? "method" : "class", name: id.slice(id.lastIndexOf("/") + 1), model: "m",
  ...(owner === undefined ? {} : { owner }),
  entry: { word: "order", in: ["OrderService"], concern: "domain", sense: "a customer's request", confidence: 0.8 },
});
const gloss = { id: MODULE, name: "com.acme.order", model: "m", entry: { word: "order", concern: "domain", sense: "a request", meaning: "What a customer asks for.", polysemous: true, senses: [{ in: "SortSpec", sense: "a sequence" }] } };
const found = (extra: object = {}) => ({
  kind: CANONICAL_KIND, status: "found", term: "order", scope: SERVICE, total: { entries: 3, glossary: 1 },
  entries: [entry(SERVICE, "type"), entry(BILL, "operation", SERVICE)], glossary: [gloss], withoutWords: 2, ...extra,
});
const respond = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the glossary's literal", () => {
  /** THE DRIFT ALARM: the page cannot import @codegraph/insights, even for types. */
  it("restates the answer's kind exactly", () => {
    expect(GLOSSARY_ANSWER_KIND).toBe(CANONICAL_KIND);
  });
});

describe("parseGlossaryAnswer", () => {
  it("reads a found answer down to what the tab lists", () => {
    expect(parseGlossaryAnswer(found())).toEqual({
      status: "found", term: "order", total: { entries: 3, glossary: 1 },
      entries: [entry(SERVICE, "type"), entry(BILL, "operation", SERVICE)], glossary: [gloss], withoutWords: 2,
    });
  });

  it("drops an entry it cannot show, keeps the rest", () => {
    const answer = parseGlossaryAnswer(found({ entries: [entry(SERVICE, "type"), { id: BILL }, null, { ...entry(BILL, "operation"), entry: { word: "order" } }], glossary: [gloss, { id: MODULE }] }));
    expect(answer.status === "found" && [answer.entries.map((e) => e.id), answer.glossary.length]).toEqual([[SERVICE], 1]);
  });

  it("an unknown scope is unknown; no store, another kind, anything malformed is nothing to show — never a throw", () => {
    expect(parseGlossaryAnswer({ kind: CANONICAL_KIND, status: "unknown-scope", scope: "x" })).toEqual({ status: "unknown" });
    expect(parseGlossaryAnswer({ kind: CANONICAL_KIND, status: "no-store" })).toEqual({ status: "none" });
    expect(parseGlossaryAnswer({ kind: "codegraph.carriers/1", status: "found" })).toEqual({ status: "none" });
    expect(parseGlossaryAnswer(found({ total: 3 }))).toEqual({ status: "none" });
    expect(parseGlossaryAnswer(found({ entries: "none" }))).toEqual({ status: "none" });
    expect(parseGlossaryAnswer(null)).toEqual({ status: "none" });
    expect(parseGlossaryAnswer("<!doctype html>")).toEqual({ status: "none" });
  });
});

describe("glossary.json", () => {
  it("asks for one word in one scope, the corpus by omission, relative to the page", () => {
    expect(glossaryUrl({ term: "order", scope: SERVICE })).toBe(`glossary.json?term=order&scope=${encodeURIComponent(SERVICE)}`);
    expect(glossaryUrl({ term: "order", scope: undefined })).toBe("glossary.json?term=order");
  });

  it("asks once per question, and once at all where there is no such route", async () => {
    const urls: string[] = [];
    const loader = createGlossaryLoader(((url) => {
      urls.push(url);
      return Promise.resolve(respond(200, found()));
    }) satisfies Fetcher);
    await Promise.all([loader.load({ term: "order", scope: SERVICE }), loader.load({ term: "order", scope: SERVICE })]);
    expect((await loader.load({ term: "order", scope: undefined })).status).toBe("found");
    expect(urls).toEqual([glossaryUrl({ term: "order", scope: SERVICE }), "glossary.json?term=order"]);

    // A 404 with the package's answer is an answer, and asking goes on.
    let asked = 0;
    const absent = createGlossaryLoader(() => {
      asked += 1;
      return Promise.resolve(respond(404, { kind: CANONICAL_KIND, status: "no-store" }));
    });
    expect(await absent.load({ term: "order", scope: undefined })).toEqual({ status: "none" });
    await absent.load({ term: "line", scope: undefined });
    expect(asked).toBe(2);
    // The app daemon has no such route: its bare 404 is not JSON, asked once.
    let probes = 0;
    const daemon = createGlossaryLoader(() => {
      probes += 1;
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    await daemon.load({ term: "order", scope: undefined });
    await daemon.load({ term: "line", scope: undefined });
    expect(probes).toBe(1);
  });
});
