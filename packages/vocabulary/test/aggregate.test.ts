import { createHash } from "node:crypto";
import type { Entity } from "@codegraph/core";
import { composeViews, internalOnly, makeView } from "@codegraph/analyzer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import { VOCABULARY_ARTEFACT_KIND, VOCABULARY_GENERATOR, vocabularyToJsonString, type VocabularyArtifact } from "../src/artifact.js";
import { DEFAULT_TECHNICAL, TERM_CLASSES } from "../src/classify.js";
import { DEFAULT_WEIGHTS, ROLES } from "../src/weight.js";
import { expectClosed } from "./closure.js";
import { cls, graphOf, method, orderCorpus, pkg, structural } from "./toy.js";

/**
 * Aggregation (PLAN.md §20.1): every kept, named entity's words, weighted by
 * its role, summed into the scopes the FOLD puts it in — its type, its module,
 * the corpus. The corpus below is counted by hand, word by word.
 */

const java = (entities: readonly Entity[]) => graphOf([{ lang: "java", entities }]);

/** A scope's table as `term → [weight, occurrences, carriers]`, in row order. */
function table(artifact: VocabularyArtifact, index: number): readonly (readonly [string, number, number, number])[] {
  return (artifact.scopes[index]?.terms ?? []).map(([term, w, n, c]) => [artifact.terms[term]?.text ?? "?", w, n, c]);
}

const NO_ROLES = Object.fromEntries(ROLES.map((role) => [role, 0]));

describe("the hand-counted corpus", () => {
  const graph = java(orderCorpus());
  const artifact = buildVocabulary(graph);

  it("states what it is, and under which scheme it counted", () => {
    expect(artifact.kind).toBe(VOCABULARY_ARTEFACT_KIND);
    expect(artifact.generatedBy).toBe(VOCABULARY_GENERATOR);
    expect(artifact.view).toEqual({ name: "all", filters: [] });
    expect(artifact.corpus).toEqual({ name: "java", roots: ["toy/java"] });
    expect(artifact.langs).toEqual(["java"]);
    expect(artifact.weights).toEqual(DEFAULT_WEIGHTS);
    expect(artifact.classes).toEqual(TERM_CLASSES);
    const digest = createHash("sha256").update([...DEFAULT_TECHNICAL].sort().join("\n"), "utf8").digest("hex");
    expect(artifact.technical).toEqual({ words: DEFAULT_TECHNICAL.length, sha256: digest });
  });

  it("interns every word once, sorted, with its class and its spread", () => {
    expect(artifact.terms).toEqual([
      { text: "acme", class: "domain", modules: 2, types: 0 },
      { text: "billing", class: "domain", modules: 1, types: 0, exclusive: 2 },
      { text: "com", class: "technical", modules: 2, types: 0 },
      { text: "get", class: "technical", modules: 1, types: 1, exclusive: 1 },
      { text: "invoice", class: "domain", modules: 1, types: 1, exclusive: 2 },
      { text: "line", class: "domain", modules: 1, types: 2, exclusive: 1 },
      { text: "lines", class: "domain", modules: 1, types: 1, exclusive: 1 },
      { text: "order", class: "domain", modules: 2, types: 1 },
      { text: "qty", class: "domain", modules: 1, types: 1, exclusive: 1 },
      { text: "total", class: "domain", modules: 1, types: 1, exclusive: 1 },
    ]);
  });

  it("orders the scopes root, modules, types, each with its parent scope", () => {
    expect(artifact.scopes.map(({ level, id, name, kind, parent }) => ({ level, id, name, kind, parent }))).toEqual([
      { level: "corpus", id: undefined, name: "java", kind: undefined, parent: undefined },
      { level: "module", id: "java:com.acme.order", name: "com.acme.order", kind: "package", parent: 0 },
      { level: "module", id: "java:com.acme.order.billing", name: "com.acme.order.billing", kind: "package", parent: 1 },
      { level: "type", id: "java:com.acme.order.billing/Invoice", name: "Invoice", kind: "class", parent: 2 },
      { level: "type", id: "java:com.acme.order/Order", name: "Order", kind: "class", parent: 1 },
      // A nested type is its own scope, under its outer type.
      { level: "type", id: "java:com.acme.order/Order$Line", name: "Line", kind: "class", parent: 4 },
    ]);
  });

  it("weighs each word by the role of its carrier, a qualifier at 1", () => {
    // order: the package (8), `order.` qualifying billing (1), the class (8), orderLine (1).
    expect(table(artifact, 0)).toEqual([
      ["order", 18, 4, 4],
      ["line", 9, 2, 2],
      ["billing", 8, 1, 1],
      ["invoice", 8, 1, 1],
      ["lines", 4, 1, 1],
      ["qty", 4, 1, 1],
      ["total", 4, 2, 2],
      ["get", 3, 1, 1],
      ["acme", 2, 2, 2],
      ["com", 2, 2, 2],
    ]);
    expect(artifact.scopes[0]).toMatchObject({
      entities: 12,
      roles: { module: 2, type: 3, operation: 1, attribute: 2, parameter: 1, local: 1, other: 0 },
      skipped: { unnamed: 1, conventional: 1, numeric: 0 },
      distinct: 10,
      distinctDomain: 8,
      weight: 62,
      occurrences: 17,
    });
  });

  it("folds a member into its nearest type and module, never the outer type", () => {
    expect(table(artifact, 1)).toEqual([
      ["order", 17, 3, 3],
      ["line", 9, 2, 2],
      ["lines", 4, 1, 1],
      ["qty", 4, 1, 1],
      ["total", 4, 2, 2],
      ["get", 3, 1, 1],
      ["acme", 1, 1, 1],
      ["com", 1, 1, 1],
    ]);
    expect(table(artifact, 2)).toEqual([
      ["billing", 8, 1, 1],
      ["invoice", 8, 1, 1],
      ["acme", 1, 1, 1],
      ["com", 1, 1, 1],
      ["order", 1, 1, 1],
    ]);
    expect(table(artifact, 3)).toEqual([["invoice", 8, 1, 1]]);
    expect(table(artifact, 4)).toEqual([
      ["order", 9, 2, 2],
      ["lines", 4, 1, 1],
      ["total", 4, 2, 2],
      ["get", 3, 1, 1],
      ["line", 1, 1, 1],
    ]);
    expect(table(artifact, 5)).toEqual([
      ["line", 8, 1, 1],
      ["qty", 4, 1, 1],
    ]);
    expect(artifact.scopes.map((scope) => scope.entities)).toEqual([12, 10, 2, 1, 7, 2]);
    expect(artifact.scopes[4]).toMatchObject({
      roles: { ...NO_ROLES, type: 1, operation: 1, attribute: 1, parameter: 1, local: 1 },
      skipped: { unnamed: 1, conventional: 1, numeric: 0 },
    });
  });

  it("never counts a stub, nor makes one a scope", () => {
    expect(artifact.terms.map((term) => term.text)).not.toContain("string");
    expect(artifact.scopes.map((scope) => scope.id)).not.toContain("java:java.lang");
    expect(artifact.diagnostics).toEqual({ unplaced: [], withoutLexicon: [] });
  });

  it("is closed", () => {
    expectClosed(artifact, graph);
  });
});

describe("options", () => {
  const graph = java(orderCorpus());

  it("counts under the view, and says which", () => {
    const noLocals = makeView("noLocals", (entity) => entity.kind !== "localVariable", () => true);
    const view = composeViews(internalOnly, noLocals);
    const artifact = buildVocabulary(graph, { view });
    expect(artifact.view).toEqual(view.descriptor);
    expect(table(artifact, 0)).toContainEqual(["total", 3, 1, 1]);
    expect(artifact.scopes[0]?.entities).toBe(11);
  });

  it("weighs with the weights given, and records them; a word weighing 0 still occurs", () => {
    const weights = { ...DEFAULT_WEIGHTS, qualifier: 0, type: 5 };
    const artifact = buildVocabulary(graph, { weights });
    expect(artifact.weights).toEqual(weights);
    expect(table(artifact, 0)).toContainEqual(["acme", 0, 2, 2]);
    expect(table(artifact, 0)).toContainEqual(["invoice", 5, 1, 1]);
  });

  it("classifies with the technical list given, and records its digest, whatever its order", () => {
    const artifact = buildVocabulary(graph, { technical: ["order", "total"] });
    const reversed = buildVocabulary(graph, { technical: ["total", "order"] });
    expect(artifact.terms.find((term) => term.text === "order")?.class).toBe("technical");
    expect(artifact.terms.find((term) => term.text === "get")?.class).toBe("domain");
    expect(artifact.technical.words).toBe(2);
    expect(artifact.technical.sha256).toBe(createHash("sha256").update("order\ntotal", "utf8").digest("hex"));
    expect(reversed.technical).toEqual(artifact.technical);
  });

  it("names the corpus as asked", () => {
    expect(buildVocabulary(graph, { name: "acme" }).scopes[0]?.name).toBe("acme");
  });
});

describe("what no scope holds", () => {
  it("counts an entity no module contains at the root alone, and names it", () => {
    const graph = java([pkg("java:p", "shop"), cls("java:p/Order", "Order", "java:p"), cls("java:Loose", "Loose")]);
    const artifact = buildVocabulary(graph);
    expect(artifact.diagnostics.unplaced).toEqual(["java:Loose"]);
    expect(table(artifact, 0)).toEqual([
      ["loose", 8, 1, 1],
      ["order", 8, 1, 1],
      ["shop", 8, 1, 1],
    ]);
    // A type is a scope whether or not a module holds it.
    expect(artifact.scopes.map((scope) => scope.id)).toEqual([undefined, "java:p", "java:Loose", "java:p/Order"]);
    expect(artifact.scopes[2]?.parent).toBe(0);
    expectClosed(artifact, graph);
  });

  it("splits a language with no lexicon by the universal rules, and says so", () => {
    const graph = graphOf([{ lang: "cobol", entities: [pkg("cobol:m", "PAYROLL-RUN"), cls("cobol:m/A", "toString", "cobol:m")] }]);
    const artifact = buildVocabulary(graph);
    expect(artifact.diagnostics.withoutLexicon).toEqual(["cobol"]);
    expect(artifact.terms.map((term) => term.text)).toEqual(["payroll", "run", "string", "to"]);
    expect(artifact.terms.find((term) => term.text === "run")?.class).toBe("technical");
  });
});

describe("a word said twice", () => {
  // Ruby names a class by its constant path and a file by its path: the
  // qualifier's words weigh 1, the own name's 8, and one entity is one carrier.
  const graph = graphOf([
    {
      lang: "rb",
      entities: [
        { ...pkg("rb:lib/acme_order/order.rb", "lib/acme_order/order.rb"), kind: "file" } as Entity,
        { ...cls("rb:lib/acme_order/order.rb/AcmeOrder::Order", "AcmeOrder::Order", "rb:lib/acme_order/order.rb"), kind: "class" } as Entity,
      ],
    },
  ]);
  const artifact = buildVocabulary(graph);

  it("counts every occurrence and one carrier per entity", () => {
    expect(table(artifact, 0)).toEqual([
      ["order", 18, 4, 2],
      ["acme", 2, 2, 2],
      ["lib", 1, 1, 1],
    ]);
    expectClosed(artifact, graph);
  });
});

describe("several languages", () => {
  // `type` is reserved by Go and a plain word to Java (on the shared technical
  // list): one word, two classes, so two terms — a class is decided per
  // language, never averaged.
  const graph = graphOf([
    { lang: "java", entities: [pkg("java:p", "shop"), cls("java:p/Type", "Type", "java:p")] },
    { lang: "go", entities: [pkg("go:q", "type")] },
  ]);
  const artifact = buildVocabulary(graph);

  it("interns a word once per class it takes", () => {
    expect(artifact.langs).toEqual(["go", "java"]);
    expect(artifact.terms.filter((term) => term.text === "type").map((term) => term.class)).toEqual(["technical", "keyword"]);
    expect(artifact.corpus.roots).toEqual(["toy/go", "toy/java"]);
    expectClosed(artifact, graph);
  });
});

describe("properties", () => {
  // Small corpora of packages, classes, members and parameters, named from
  // words the classes split differently, with the odd unnamed or conventional one.
  const WORDS = ["order", "Order", "line", "LINE", "getTotal", "toString", "acme_order", "HTTPServer", "id", "x", "new", "2024", "promo#2024"];
  const name = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((ws) => ws.join(""));
  const member = fc.record({ name: fc.option(name, { nil: undefined }), params: fc.array(name, { maxLength: 2 }) });
  const type = fc.record({ name, members: fc.array(member, { maxLength: 3 }), nested: fc.boolean() });
  const module = fc.record({ name, types: fc.array(type, { maxLength: 3 }) });
  const corpus = fc.array(module, { minLength: 1, maxLength: 3 }).map((modules) => {
    const entities: Entity[] = [];
    modules.forEach((m, mi) => {
      const mid = `java:m${mi}`;
      entities.push(pkg(mid, `com.acme.${m.name}`));
      m.types.forEach((t, ti) => {
        const parent = t.nested && ti > 0 ? `${mid}/T${ti - 1}` : mid;
        const tid = `${mid}/T${ti}`;
        entities.push(cls(tid, t.name, parent));
        t.members.forEach((mem, k) => {
          const id = `${tid}.m${k}`;
          const params = mem.params.map((_, p) => `${id}#p${p}`);
          entities.push(method(id, mem.name, tid, { parameters: params }));
          mem.params.forEach((p, i) => entities.push(structural(params[i] ?? "", "parameter", p, id)));
        });
      });
    });
    return entities;
  });

  it("is closed, and every kept entity lands in one module", () => {
    fc.assert(
      fc.property(corpus, (entities) => {
        const graph = java(entities);
        expectClosed(buildVocabulary(graph), graph);
      }),
    );
  });

  it("writes the same bytes whatever the order the entities arrive in", () => {
    fc.assert(
      fc.property(
        corpus.chain((entities) => fc.tuple(fc.constant(entities), fc.shuffledSubarray(entities, { minLength: entities.length }))),
        ([entities, shuffled]) => {
          const a = vocabularyToJsonString(buildVocabulary(java(entities)));
          const b = vocabularyToJsonString(buildVocabulary(java(shuffled)));
          expect(b).toBe(a);
        },
      ),
    );
  });
});
