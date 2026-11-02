import type { Entity } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import { definitionSpeller, rankedWords } from "../src/define.js";
import { cls, graphOf, method, orderCorpus, pkg, structural } from "./toy.js";

/**
 * What `explain` asks a model to define (PLAN.md §20.3, layer 2): the words of
 * an entity's own name, each once, short and keyword words left out — and, for
 * a module's glossary, its words heaviest first.
 */

describe("definitionSpeller", () => {
  const graph = graphOf([
    {
      lang: "java",
      entities: [
        pkg("java:com.acme.order", "com.acme.order"),
        cls("java:com.acme.order/OrderService", "OrderService", "java:com.acme.order"),
        cls("java:com.acme.order/OrderOrder", "OrderOrder", "java:com.acme.order"),
        method("java:com.acme.order/OrderService.placeOrder()", "placeOrder", "java:com.acme.order/OrderService", { parameters: ["java:p#0", "java:p#1"] }),
        structural("java:p#0", "parameter", "x", "java:com.acme.order/OrderService.placeOrder()"),
        structural("java:p#1", "parameter", "newLine", "java:com.acme.order/OrderService.placeOrder()"),
        method("java:com.acme.order/OrderService.toString()", "toString", "java:com.acme.order/OrderService"),
        method("java:com.acme.order/OrderService.<init>()", undefined, "java:com.acme.order/OrderService"),
        structural("java:com.acme.order/OrderService.MAX_LINES", "attribute", "MAX_LINES", "java:com.acme.order/OrderService"),
      ],
    },
    {
      lang: "rb",
      entities: [
        { ...pkg("rb:lib/acme_order/order.rb", "lib/acme_order/order.rb"), kind: "file" } as Entity,
        { ...cls("rb:lib/acme_order/order.rb/AcmeOrder::OrderLine", "AcmeOrder::OrderLine", "rb:lib/acme_order/order.rb"), kind: "class" } as Entity,
      ],
    },
    { lang: "go", entities: [pkg("go:shop", "shop"), cls("go:shop/Type", "TypeOrder", "go:shop")] },
  ]);
  const words = definitionSpeller(graph);

  it("asks for every word of the name, technical ones included, in the order the name spells them", () => {
    expect(words("java:com.acme.order/OrderService")).toEqual(["order", "service"]);
    expect(words("java:com.acme.order/OrderService.placeOrder()")).toEqual(["place", "order"]);
    expect(words("java:com.acme.order/OrderService.MAX_LINES")).toEqual(["max", "lines"]);
  });

  it("asks once for a word the name spells twice", () => {
    expect(words("java:com.acme.order/OrderOrder")).toEqual(["order"]);
  });

  it("leaves out short words and the language's keywords", () => {
    expect(words("java:p#0")).toEqual([]);
    expect(words("java:p#1")).toEqual(["line"]);
    expect(words("go:shop/Type")).toEqual(["order"]);
  });

  it("asks for the own name only: a qualifier's words are its container's", () => {
    expect(words("java:com.acme.order")).toEqual(["order"]);
    expect(words("rb:lib/acme_order/order.rb/AcmeOrder::OrderLine")).toEqual(["order", "line"]);
    expect(words("rb:lib/acme_order/order.rb")).toEqual(["order"]);
  });

  it("asks nothing of a conventional name, an unnamed entity or an unknown id", () => {
    expect(words("java:com.acme.order/OrderService.toString()")).toEqual([]);
    expect(words("java:com.acme.order/OrderService.<init>()")).toEqual([]);
    expect(words("java:nowhere")).toEqual([]);
  });
});

describe("rankedWords", () => {
  const graph = graphOf([{ lang: "java", entities: orderCorpus() }]);
  const artifact = buildVocabulary(graph);

  it("lists a scope's words heaviest first, as its table orders them, without short or keyword words", () => {
    const scope = artifact.scopes.find((s) => s.id === "java:com.acme.order");
    expect(scope).toBeDefined();
    const expected = (scope?.terms ?? [])
      .map(([term]) => artifact.terms[term])
      .filter((term) => term?.class === "domain" || term?.class === "technical")
      .map((term) => term?.text);
    expect(rankedWords(artifact, "java:com.acme.order")).toEqual([...new Set(expected)]);
    expect(rankedWords(artifact, "java:com.acme.order")[0]).toBe("order");
  });

  it("lists a word once, whatever classes two languages give it", () => {
    const mixed = buildVocabulary(
      graphOf([
        { lang: "java", entities: [pkg("java:p", "shop"), cls("java:p/Type", "Type", "java:p")] },
        { lang: "go", entities: [pkg("go:q", "type"), cls("go:q/TypeShop", "TypeShop", "go:q")] },
      ]),
    );
    expect(rankedWords(mixed, "go:q")).toEqual(["shop"]);
    expect(rankedWords(mixed, undefined)).toEqual(["shop", "type"]);
  });

  it("knows no word of a scope the artifact does not hold", () => {
    expect(rankedWords(artifact, "java:nowhere")).toEqual([]);
  });
});
