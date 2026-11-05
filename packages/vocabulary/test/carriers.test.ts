import { fileURLToPath } from "node:url";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadModels, makeView, type CodeGraph } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import { CARRIERS_ANSWER_KIND, CARRIERS_LIMIT, vocabularyCarriers, type Carrier } from "../src/carriers.js";
import { DEFAULT_WEIGHTS } from "../src/weight.js";
import { graphOf as toyGraph, method, orderCorpus, pkg } from "./toy.js";

/**
 * A scope's term, back to the names that carry it (PLAN.md §20.2): the
 * evidence the artifact counts and does not list. Each carrier's share is
 * what the row counted from it, so a row is the sum of its carriers.
 */

const FIXTURES = ["java", "csharp", "typescript", "elixir", "ruby", "unicode"] as const;

function fixtureGraph(fixture: string): CodeGraph {
  const model = readModelFileSync(
    fileURLToPath(new URL(`../../../fixtures/${fixture}/expected/model.jsonl`, import.meta.url)),
  );
  return buildGraph(loadModels(model, { sources: [`fixtures/${fixture}`] }).union);
}

const brief = (carrier: Carrier) => [carrier.name, carrier.role, carrier.weight, `line ${carrier.anchor?.span[0] ?? "—"}`];

describe("the carriers of `order` in the Java fixture, counted by hand", () => {
  const graph = fixtureGraph("java");
  const artifact = buildVocabulary(graph);
  const index = vocabularyCarriers(graph, artifact);

  // fixtures/java/README.md: weight 40, 12 occurrences, 12 carriers.
  it("lists the corpus's twelve, heaviest first, then by id", () => {
    const answer = index.answer({ term: "order" });
    expect(answer).toMatchObject({
      kind: CARRIERS_ANSWER_KIND,
      status: "found",
      scope: { level: "corpus", name: "src" },
      term: { text: "order", class: "domain" },
      weight: 40,
      occurrences: 12,
      total: 12,
    });
    if (answer.status !== "found") return;
    // Ties by id: Notifications' four parameters, then OrderService's local and parameter.
    expect(answer.carriers.map(brief)).toEqual([
      ["com.acme.order", "module", 8, "line —"],
      ["AbstractOrder", "type", 8, "line 4"],
      ["Order", "type", 8, "line 6"],
      ["OrderService", "type", 8, "line 9"],
      ["com.acme.order.adapter", "module", 1, "line —"],
      ["com.acme.order.legacy", "module", 1, "line —"],
      ["order", "parameter", 1, "line 8"],
      ["order", "parameter", 1, "line 10"],
      ["order", "parameter", 1, "line 21"],
      ["order", "parameter", 1, "line 32"],
      ["order", "local", 1, "line 24"],
      ["order", "parameter", 1, "line 17"],
    ]);
  });

  // The navigator's rule: a type or a module carries its id, a member the
  // type (else the module) a page reveals for it.
  it("gives a type or a module its id, a member its owner, and every carrier its anchor", () => {
    const answer = index.answer({ term: "order" });
    if (answer.status !== "found") throw new Error(answer.status);
    const [module, , order] = answer.carriers;
    expect(module).toMatchObject({ id: "java:com.acme.order", name: "com.acme.order" });
    expect(module).not.toHaveProperty("owner");
    expect(order).toMatchObject({ id: "java:com.acme.order/Order", anchor: { file: "com/acme/order/Order.java" } });
    const members = answer.carriers.filter((carrier) => carrier.role === "parameter" || carrier.role === "local");
    for (const member of members) {
      expect(member).not.toHaveProperty("id");
      expect(member.owner).toMatch(/^java:com\.acme\.order\/(OrderService|Notifications|Order|AbstractOrder)/u);
      expect(member.anchor?.span[0]).toBeGreaterThan(0);
    }
  });

  it("answers within a type's scope, and within a module's", () => {
    const type = index.answer({ scope: "java:com.acme.order/OrderService", term: "order" });
    expect(type).toMatchObject({ status: "found", scope: { level: "type", id: "java:com.acme.order/OrderService", name: "OrderService" } });
    if (type.status !== "found") return;
    expect(type.carriers.every((carrier) => carrier.id === "java:com.acme.order/OrderService" || carrier.owner === "java:com.acme.order/OrderService")).toBe(true);
    const module = index.answer({ scope: "java:com.acme.order", term: "order" });
    expect(module).toMatchObject({ status: "found", scope: { level: "module" } });
  });

  it("lists at most `limit` carriers and always counts them whole", () => {
    const answer = index.answer({ term: "order", limit: 3 });
    expect(answer).toMatchObject({ status: "found", total: 12 });
    if (answer.status === "found") expect(answer.carriers.map((carrier) => carrier.name)).toEqual(["com.acme.order", "AbstractOrder", "Order"]);
    expect(CARRIERS_LIMIT).toBeGreaterThanOrEqual(100);
    expect(() => index.answer({ term: "order", limit: -1 })).toThrow(RangeError);
    expect(() => index.answer({ term: "order", limit: 1.5 })).toThrow(RangeError);
  });

  it("says an unknown scope, or a term the scope does not speak, is unknown", () => {
    expect(index.answer({ scope: "java:com.acme.order/Nowhere", term: "order" })).toEqual({
      kind: CARRIERS_ANSWER_KIND,
      status: "unknown-scope",
      scope: "java:com.acme.order/Nowhere",
    });
    expect(index.answer({ term: "zebra" })).toMatchObject({ status: "unknown-term", term: "zebra", scope: { level: "corpus" } });
    expect(index.answer({ term: "order", class: "technical" })).toMatchObject({ status: "unknown-term", class: "technical" });
    // An operation is no stored scope: its words are `vocabulary --scope`'s.
    expect(index.answer({ scope: "java:com.acme.order/OrderService.bill(com.acme.order.Order)", term: "order" })).toMatchObject({
      status: "unknown-scope",
    });
  });
});

describe("one text, two terms", () => {
  // `final` is a Java keyword; a language with no lexicon says it as a domain word.
  const graph = toyGraph([
    { lang: "java", entities: [...orderCorpus(), method("java:com.acme.order/Order.isFinal()", "isFinal", "java:com.acme.order/Order")] },
    { lang: "cobol", entities: [pkg("cobol:final", "final")] },
  ]);
  const artifact = buildVocabulary(graph);
  const index = vocabularyCarriers(graph, artifact);

  it("asks for the class where a scope speaks both", () => {
    expect(artifact.terms.filter((term) => term.text === "final").map((term) => term.class)).toEqual(["domain", "keyword"]);
    expect(index.answer({ term: "final" })).toEqual({
      kind: CARRIERS_ANSWER_KIND,
      status: "ambiguous",
      scope: { level: "corpus", name: artifact.corpus.name },
      term: "final",
      classes: ["domain", "keyword"],
    });
    expect(index.answer({ term: "final", class: "domain" })).toMatchObject({
      status: "found",
      total: 1,
      carriers: [{ id: "cobol:final", role: "module" }],
    });
    expect(index.answer({ term: "final", class: "keyword" })).toMatchObject({
      status: "found",
      carriers: [{ name: "isFinal", role: "operation", owner: "java:com.acme.order/Order" }],
    });
  });
});

describe("a row is the sum of its carriers", () => {
  it.each(FIXTURES)("in fixtures/%s, for every term of every scope", (fixture) => {
    const graph = fixtureGraph(fixture);
    const artifact = buildVocabulary(graph);
    const index = vocabularyCarriers(graph, artifact);
    let rows = 0;
    for (const scope of artifact.scopes) {
      for (const [term, weight, occurrences, carriers] of scope.terms) {
        const entry = artifact.terms[term];
        if (entry === undefined) throw new Error(`term ${term}`);
        const answer = index.answer({
          ...(scope.id === undefined ? {} : { scope: scope.id }),
          term: entry.text,
          class: entry.class,
          limit: Number.MAX_SAFE_INTEGER,
        });
        if (answer.status !== "found") throw new Error(`${scope.name} ${entry.text}: ${answer.status}`);
        expect(answer.total).toBe(carriers);
        expect(answer.carriers).toHaveLength(carriers);
        expect(answer.carriers.reduce((sum, carrier) => sum + carrier.weight, 0)).toBe(weight);
        expect(answer.carriers.reduce((sum, carrier) => sum + carrier.occurrences, 0)).toBe(occurrences);
        rows += 1;
      }
    }
    expect(rows).toBeGreaterThan(0);
  });
});

describe("the counting it answers under", () => {
  const graph = fixtureGraph("java");
  const noLocals = makeView("noLocals", (entity) => entity.kind !== "localVariable", () => true);

  it("is the artifact's, or it refuses: other weights, another technical list, another view", () => {
    const artifact = buildVocabulary(graph);
    expect(() => vocabularyCarriers(graph, artifact, { weights: { ...DEFAULT_WEIGHTS, type: 9 } })).toThrow(/other options/u);
    expect(() => vocabularyCarriers(graph, artifact, { technical: [] })).toThrow(/other options/u);
    expect(() => vocabularyCarriers(graph, artifact, { view: noLocals })).toThrow(/other options/u);
  });

  it("answers an artifact built under a view with that view", () => {
    const artifact = buildVocabulary(graph, { view: noLocals });
    const answer = vocabularyCarriers(graph, artifact, { view: noLocals }).answer({ term: "order" });
    // The local `order` of `archive` is not kept: eleven carriers, weight 39.
    expect(answer).toMatchObject({ status: "found", total: 11, weight: 39 });
  });
});
