import { makeView } from "@codegraph/analyzer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import {
  JUDGED_CONCERNS,
  businessJudged,
  concernDrift,
  type ConcernDrift,
  type WordJudgement,
} from "../src/concern-drift.js";
import { parseBusinessTerms, vocabularyDrift } from "../src/drift.js";
import { cls, graphOf, pkg, structural } from "./toy.js";

/**
 * The list against the model (PLAN.md §20.3, layer 3): what the deterministic
 * class says of a word, beside what the model judged it to be in each entity
 * whose names spell it. The model's judgements are inputs here, as the store
 * would hand them over; nothing is asked.
 */

const order = "java:com.acme.order";
const Order = `${order}/Order`;
const Service = `${order}/OrderService`;
const String_ = "java:java.lang/String";
const corpus = [
  pkg(order, "com.acme.order"),
  cls(Order, "Order", order),
  structural(`${Order}#sortOrder`, "attribute", "sortOrder", Order),
  cls(Service, "OrderService", order),
  pkg("java:java.lang", "java.lang", undefined, true),
  cls(String_, "String", "java:java.lang", true),
];
const graph = graphOf([{ lang: "java", entities: corpus }]);

const judged = (id: string, word: string, concern: WordJudgement["concern"], sense: string, inside: readonly string[] = [word]): WordJudgement => ({
  id,
  word,
  concern,
  sense,
  confidence: 0.8,
  in: inside,
});

const JUDGEMENTS: readonly WordJudgement[] = [
  judged(order, "order", "domain", "the ordering business", ["com.acme.order"]),
  judged(Order, "order", "domain", "a customer's request", ["Order"]),
  judged(Order, "sort", "technical", "arranging", ["sortOrder"]),
  judged(Service, "order", "domain", "a customer's request", ["OrderService"]),
  judged(Service, "service", "domain", "after-sales care", ["OrderService"]),
  judged(`${Order}.ship()`, "ship", "domain", "send it", ["ship"]),
  judged(String_, "string", "technical", "text"),
];

/** `[word, class, domain, technical, ambiguous, against ids]` per judged word. */
const rows = (words: ConcernDrift["words"]) =>
  words.map((w) => [w.word, w.class, ...JUDGED_CONCERNS.map((c) => w.concerns[c]), w.against.map((a) => a.id)]);

describe("concernDrift: the list's class beside the model's concern, word by word", () => {
  it("counts every judgement of a kept entity under its word and the class the list gives it there", () => {
    const report = concernDrift(graph, JUDGEMENTS);
    expect(rows(report.words)).toEqual([
      ["order", "domain", 3, 0, 0, []],
      ["service", "technical", 1, 0, 0, [Service]],
      ["sort", "domain", 0, 1, 0, [Order]],
    ]);
    expect(report.compared).toEqual({ entries: 5, entities: 3 });
  });

  it("leaves out, and counts, records of no entity of this model and of entities no kept view holds", () => {
    // `ship()` is not in the model (explained against another version of it); a stub never speaks.
    expect(concernDrift(graph, JUDGEMENTS).leftOut).toEqual({ unknown: 1, notKept: 1 });
    const internal = concernDrift(graph, [judged(order, "order", "domain", "x")], {
      view: makeView("none", () => false, () => false),
    });
    expect(internal.compared).toEqual({ entries: 0, entities: 0 });
    expect(internal.leftOut).toEqual({ unknown: 0, notKept: 1 });
  });

  it("lists a technical word the model judged domain somewhere, and a domain word it judged technical, with the entities that did", () => {
    const report = concernDrift(graph, JUDGEMENTS);
    expect(report.technicalJudgedDomain.map((w) => [w.word, w.against.map((a) => [a.id, a.sense, a.in])])).toEqual([
      ["service", [[Service, "after-sales care", ["OrderService"]]]],
    ]);
    expect(report.domainJudgedTechnical.map((w) => [w.word, w.against.map((a) => [a.id, a.sense, a.in])])).toEqual([
      ["sort", [[Order, "arranging", ["sortOrder"]]]],
    ]);
  });

  it("lists the judgements against a class most confident first, then by entity", () => {
    const sure = { ...judged(Service, "sort", "technical", "arranging"), confidence: 0.9 };
    const unsure = { ...judged(order, "sort", "technical", "arranging"), confidence: 0.3 };
    const tied = { ...judged(Order, "sort", "technical", "arranging"), confidence: 0.3 };
    const [sort] = concernDrift(graph, [unsure, tied, sure]).domainJudgedTechnical;
    expect(sort?.against.map((a) => a.id)).toEqual([Service, order, Order]);
  });

  it("an ambiguous judgement is counted, and is against neither class", () => {
    const report = concernDrift(graph, [judged(Service, "service", "ambiguous", "both")]);
    expect(rows(report.words)).toEqual([["service", "technical", 0, 0, 1, []]]);
    expect(report.technicalJudgedDomain).toEqual([]);
  });

  it("classifies under the list it is given: a word moved onto it changes sections", () => {
    const report = concernDrift(graph, JUDGEMENTS, { technical: ["order"] });
    expect(rows(report.words)).toEqual([
      ["order", "technical", 3, 0, 0, [order, Order, Service]],
      ["service", "domain", 1, 0, 0, []],
      ["sort", "domain", 0, 1, 0, [Order]],
    ]);
    expect(report.technicalJudgedDomain.map((w) => w.word)).toEqual(["order"]);
    expect(report.technical).toEqual(buildVocabulary(graph, { technical: ["order"] }).technical);
  });

  it("decides a class per entity's language: Go reserves `select`, Java does not", () => {
    const go = "go:shop";
    const mixed = graphOf([
      { lang: "java", entities: [pkg(order, "com.acme.order"), cls(`${order}/Select`, "Select", order)] },
      { lang: "go", entities: [pkg(go, "shop"), cls(`${go}/selectAll`, "selectAll", go)] },
    ]);
    const report = concernDrift(mixed, [
      judged(`${order}/Select`, "select", "technical", "a query"),
      judged(`${go}/selectAll`, "select", "technical", "a query"),
    ]);
    expect(rows(report.words)).toEqual([
      ["select", "domain", 0, 1, 0, [`${order}/Select`]],
      ["select", "keyword", 0, 1, 0, []],
    ]);
  });

  it("ranks each list by the entries against it, most first, ties by word", () => {
    const report = concernDrift(graph, [
      judged(Order, "basket", "technical", "a container"),
      judged(Order, "sort", "technical", "arranging"),
      judged(Service, "sort", "technical", "arranging"),
    ]);
    expect(report.domainJudgedTechnical.map((w) => [w.word, w.against.length])).toEqual([
      ["sort", 2],
      ["basket", 1],
    ]);
  });

  const ids = [order, Order, Service, `${Order}#sortOrder`, String_, `${order}/Gone`];
  const judgement = fc.record({
    id: fc.constantFrom(...ids),
    word: fc.constantFrom("order", "service", "sort", "line", "type"),
    concern: fc.constantFrom(...JUDGED_CONCERNS),
    sense: fc.constantFrom("a", "b"),
    confidence: fc.constantFrom(0.2, 0.9),
    in: fc.array(fc.constantFrom("Order", "sortOrder"), { maxLength: 2 }),
  });

  it("conserves: every judgement is compared once under its own word, or left out, whatever the order", () => {
    fc.assert(
      fc.property(
        fc.array(judgement, { maxLength: 30 }).chain((all) => fc.tuple(fc.constant(all), fc.shuffledSubarray(all, { minLength: all.length }))),
        ([all, shuffled]) => {
          const report = concernDrift(graph, all);
          expect(concernDrift(graph, shuffled)).toEqual(report);
          const kept = all.filter((j) => graph.entity(j.id) !== undefined && !graph.isStub(j.id));
          expect(report.compared.entries).toBe(kept.length);
          for (const w of report.words) {
            const mine = kept.filter((j) => j.word === w.word);
            for (const c of JUDGED_CONCERNS) expect(w.concerns[c]).toBe(mine.filter((j) => j.concern === c).length);
            const opposite = w.class === "technical" ? "domain" : w.class === "domain" ? "technical" : undefined;
            expect(w.against.length).toBe(mine.filter((j) => j.concern === opposite).length);
          }
          expect(report.technicalJudgedDomain).toEqual(report.words.filter((w) => w.class === "technical" && w.concerns.domain > 0).sort((a, b) => b.against.length - a.against.length || (a.word < b.word ? -1 : 1)));
          expect(report.domainJudgedTechnical.every((w) => w.class === "domain" && w.against.length > 0)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("businessJudged: the business list against both", () => {
  const artifact = buildVocabulary(graph);
  const report = concernDrift(graph, JUDGEMENTS);
  const terms = (...lines: string[]) => parseBusinessTerms(lines.join("\n")).terms;

  it("gives each business word the classes the corpus says it under and the model's judgements of it", () => {
    expect(businessJudged(artifact, terms("Order", "Order Service", "Customer"), report)).toEqual([
      { text: "Order", words: [{ word: "order", classes: ["domain"], concerns: { domain: 3, technical: 0, ambiguous: 0 }, drift: [] }], said: true, drift: false },
      {
        text: "Order Service",
        words: [
          { word: "order", classes: ["domain"], concerns: { domain: 3, technical: 0, ambiguous: 0 }, drift: [] },
          { word: "service", classes: ["technical"], concerns: { domain: 1, technical: 0, ambiguous: 0 }, drift: ["list"] },
        ],
        said: true,
        drift: true,
      },
      { text: "Customer", words: [{ word: "customer", classes: [], concerns: { domain: 0, technical: 0, ambiguous: 0 }, drift: [] }], said: false, drift: false },
    ]);
  });

  it("drifts on a word the model judged technical somewhere, though the list calls it domain; on both, for both reasons", () => {
    const [sortOrder] = businessJudged(artifact, terms("Sort Order"), report);
    expect(sortOrder?.words.map((w) => [w.word, w.drift])).toEqual([["sort", ["model"]], ["order", []]]);
    expect(sortOrder?.drift).toBe(true);
    const both = concernDrift(graph, [judged(Service, "service", "technical", "a layer")]);
    expect(businessJudged(artifact, terms("Service"), both)[0]?.words[0]?.drift).toEqual(["list", "model"]);
  });

  it("says a term is said exactly when the corpus-level drift does", () => {
    const glossary = terms("Order", "Sort Order", "Order Customer", "service", "Ship");
    const said = vocabularyDrift(artifact, glossary).business.map((t) => t.scopes.length > 0);
    expect(businessJudged(artifact, glossary, report).map((t) => t.said)).toEqual(said);
    expect(said).toEqual([true, true, false, true, false]);
  });

  it("refuses an artifact counted under another technical list", () => {
    expect(() => businessJudged(buildVocabulary(graph, { technical: ["order"] }), terms("Order"), report)).toThrow(/another technical list/u);
  });
});
