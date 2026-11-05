import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadModels } from "@codegraph/analyzer";
import { CARRIERS_ANSWER_KIND, buildVocabulary, vocabularyCarriers, type CarrierIndex } from "@codegraph/vocabulary";
import { carriersLookup } from "../src/carriers-route.js";

/**
 * `/carriers.json?term=…[&scope=…][&class=…][&limit=…]`: which names of a
 * stored scope carry a word (PLAN.md §20.2) — the evidence the vocabulary
 * artifact counts and never lists, looked up in the model `serve` holds.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const graph = buildGraph(loadModels(readModelFileSync(FIXTURE), { sources: [FIXTURE] }).union);
const artifact = buildVocabulary(graph);

function lookup() {
  let builds = 0;
  const handle = carriersLookup(() => {
    builds += 1;
    return vocabularyCarriers(graph, artifact);
  });
  const ask = (query: Record<string, string>) => {
    const answer = handle.handle(new URLSearchParams(query));
    return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> };
  };
  return { ask, builds: () => builds };
}

describe("carriers.json", () => {
  it("answers a corpus row when no scope is named, and a type's when one is", () => {
    const { ask } = lookup();
    expect(ask({ term: "order" })).toMatchObject({
      status: 200,
      body: { kind: CARRIERS_ANSWER_KIND, status: "found", scope: { level: "corpus" }, total: 12 },
    });
    expect(ask({ term: "order", scope: "" })).toMatchObject({ status: 200, body: { scope: { level: "corpus" } } });
    expect(ask({ term: "order", scope: "java:com.acme.order/Order", class: "domain", limit: "1" })).toMatchObject({
      status: 200,
      body: { scope: { level: "type", id: "java:com.acme.order/Order" }, carriers: [{ id: "java:com.acme.order/Order" }] },
    });
  });

  it("is 404 for a scope or a term it does not know, with the package's answer", () => {
    const { ask } = lookup();
    expect(ask({ term: "order", scope: "java:nowhere" })).toEqual({
      status: 404,
      body: { kind: CARRIERS_ANSWER_KIND, status: "unknown-scope", scope: "java:nowhere" },
    });
    expect(ask({ term: "zebra" })).toMatchObject({ status: 404, body: { status: "unknown-term" } });
  });

  it("is 400 for a request it cannot ask: no term, an unknown class, a limit that is no whole number", () => {
    const { ask, builds } = lookup();
    for (const query of [{}, { term: "" }, { term: "order", class: "noun" }, { term: "order", limit: "-1" }, { term: "order", limit: "2.5" }]) {
      const answer = ask(query);
      expect(answer.status, JSON.stringify(query)).toBe(400);
      expect(answer.body["error"]).toMatch(/carriers\.json/u);
    }
    // Refused before the index is built: a bad request costs nothing.
    expect(builds()).toBe(0);
  });

  it("builds the index once, at the first request it can answer", () => {
    const { ask, builds } = lookup();
    expect(builds()).toBe(0);
    ask({ term: "order" });
    ask({ term: "total" });
    expect(builds()).toBe(1);
  });

  it("is 400 where the scope speaks the text as two terms, naming the classes", () => {
    const ambiguous: CarrierIndex = {
      answer: () => ({ kind: CARRIERS_ANSWER_KIND, status: "ambiguous", scope: { level: "corpus", name: "c" }, term: "final", classes: ["domain", "keyword"] }),
    };
    const answer = carriersLookup(() => ambiguous).handle(new URLSearchParams({ term: "final" }));
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ status: "ambiguous", classes: ["domain", "keyword"] });
  });
});
