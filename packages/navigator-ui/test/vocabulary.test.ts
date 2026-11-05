import { describe, expect, it } from "vitest";
import {
  CARRIERS_ANSWER_KIND as CANONICAL_CARRIERS_KIND,
  TERM_CLASSES as CANONICAL_CLASSES,
  VOCABULARY_ARTEFACT_KIND as CANONICAL_KIND,
} from "@codegraph/vocabulary";
import { buildIndexes } from "../src/model/indexes.js";
import { carrierNode, cloudWords, indexVocabulary, scopeChain, scopeForNode, wordRows } from "../src/model/words.js";
import {
  CARRIERS_ANSWER_KIND,
  TERM_CLASSES,
  VOCABULARY_ARTEFACT_KIND,
  carriersUrl,
  createCarriersLoader,
  loadVocabulary,
  parseCarriersAnswer,
  parseVocabularyArtifact,
  type Fetcher,
} from "../src/vocabulary.js";
import { artifact, vocabularyArtifact } from "./fixture.js";

/**
 * The Vocabulary tab's data (PLAN.md §20.2): the artifact at `vocabulary.json`,
 * the lookup at `carriers.json`, and the joins to the navigator on entity ids.
 */

const json = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the literals the page restates", () => {
  it("are the vocabulary package's own: the artifact kind, the answer kind, the classes in order", () => {
    expect(VOCABULARY_ARTEFACT_KIND).toBe(CANONICAL_KIND);
    expect(CARRIERS_ANSWER_KIND).toBe(CANONICAL_CARRIERS_KIND);
    expect([...TERM_CLASSES]).toEqual([...CANONICAL_CLASSES]);
  });
});

describe("vocabulary.json", () => {
  it("accepts a vocabulary artifact", () => {
    const parsed = parseVocabularyArtifact(vocabularyArtifact());
    expect(typeof parsed === "string" ? parsed : parsed.scopes).toHaveLength(4);
  });

  it("refuses another artifact, or one missing what the tab reads, saying which", () => {
    expect(parseVocabularyArtifact({ kind: "codegraph.navigator/1" })).toMatch(/codegraph\.vocabulary\/1/u);
    expect(parseVocabularyArtifact({ ...vocabularyArtifact(), scopes: undefined })).toMatch(/scopes/u);
    expect(parseVocabularyArtifact({ ...vocabularyArtifact(), weights: undefined })).toMatch(/weights/u);
    expect(parseVocabularyArtifact({ ...vocabularyArtifact(), scopes: [] })).toMatch(/no scope/u);
    expect(parseVocabularyArtifact([1])).toMatch(/not an object/u);
  });

  it("is absent when nothing is served there, and an error when the bytes are wrong", async () => {
    expect(await loadVocabulary(async () => json(404, ""))).toEqual({ status: "absent" });
    expect(await loadVocabulary(async () => json(200, "<!doctype html>"))).toEqual({ status: "absent" });
    expect(await loadVocabulary(async () => Promise.reject(new Error("refused")))).toEqual({ status: "absent" });
    expect(await loadVocabulary(async () => json(200, { kind: "codegraph.city/1" }))).toMatchObject({ status: "error" });
    expect(await loadVocabulary(async () => json(200, vocabularyArtifact()))).toMatchObject({ status: "ready" });
  });

  it("is fetched relative to the page, as the app daemon's token prefix needs", async () => {
    const asked: string[] = [];
    await loadVocabulary(async (url) => {
      asked.push(url);
      return json(404, "");
    });
    expect(asked).toEqual(["vocabulary.json"]);
  });
});

describe("the scope the tab shows", () => {
  const ix = buildIndexes(artifact());
  const vocabulary = indexVocabulary(vocabularyArtifact());

  it("is the corpus with nothing selected, a module's or a type's own, and a member's type", () => {
    expect(scopeForNode(ix, vocabulary, undefined)).toBe(0);
    expect(scopeForNode(ix, vocabulary, 0)).toBe(1); // p
    expect(scopeForNode(ix, vocabulary, 1)).toBe(2); // A
    expect(scopeForNode(ix, vocabulary, 2)).toBe(2); // m() of A
    expect(scopeForNode(ix, vocabulary, 5)).toBe(3); // n() of C
  });

  it("is the corpus for a node the vocabulary does not have: another view, a stub", () => {
    const other = indexVocabulary({ ...vocabularyArtifact(), scopes: [vocabularyArtifact().scopes[0]!] });
    expect(scopeForNode(ix, other, 1)).toBe(0);
  });

  it("sits in a chain from the corpus, through the stored scopes around it", () => {
    expect(scopeChain(vocabularyArtifact(), 2)).toEqual([0, 1, 2]);
    expect(scopeChain(vocabularyArtifact(), 0)).toEqual([0]);
  });
});

describe("a scope's words", () => {
  const vocabulary = vocabularyArtifact();

  it("are the artifact's rows of the chosen classes, in its order", () => {
    expect(wordRows(vocabulary, 0, new Set(["domain"])).map((row) => [row.text, row.weight, row.carriers])).toEqual([
      ["order", 19, 3],
      ["account", 8, 1],
    ]);
    expect(wordRows(vocabulary, 2, new Set(TERM_CLASSES)).map((row) => `${row.text}:${row.class}`)).toEqual(["order:domain", "get:technical", "x:short"]);
    expect(wordRows(vocabulary, 0, new Set(["domain"]))[0]).toMatchObject({ modules: 1, types: 2, occurrences: 3 });
  });

  it("feed the cloud its N heaviest", () => {
    const rows = wordRows(vocabulary, 0, new Set(TERM_CLASSES));
    expect(cloudWords(rows, 2)).toEqual([
      { text: "order", weight: 19, class: "domain" },
      { text: "account", weight: 8, class: "domain" },
    ]);
  });
});

describe("carriers.json", () => {
  const found = {
    kind: CARRIERS_ANSWER_KIND,
    status: "found",
    scope: { level: "type", id: "java:p/A", name: "A" },
    term: { text: "order", class: "domain" },
    weight: 11,
    occurrences: 2,
    total: 2,
    carriers: [
      { id: "java:p/A", name: "A", kind: "class", role: "type", weight: 8, occurrences: 1 },
      { name: "order", kind: "parameter", role: "parameter", weight: 3, occurrences: 1, owner: "java:p/A" },
    ],
  };

  it("asks for one term of one class in one scope, the corpus by omission", () => {
    expect(carriersUrl({ scope: "java:p/A", term: "order", class: "domain" })).toBe("carriers.json?term=order&class=domain&scope=java%3Ap%2FA");
    expect(carriersUrl({ scope: undefined, term: "a&b", class: "short" })).toBe("carriers.json?term=a%26b&class=short");
  });

  it("reads a found answer, an unknown one, and nothing else", () => {
    expect(parseCarriersAnswer(found)).toMatchObject({ status: "found", total: 2, carriers: [{ name: "A" }, { name: "order" }] });
    expect(parseCarriersAnswer({ kind: CARRIERS_ANSWER_KIND, status: "unknown-term" })).toEqual({ status: "unknown" });
    expect(parseCarriersAnswer({ kind: CARRIERS_ANSWER_KIND, status: "ambiguous" })).toEqual({ status: "none" });
    expect(parseCarriersAnswer({ kind: "codegraph.insight/1", status: "found" })).toEqual({ status: "none" });
    expect(parseCarriersAnswer({ ...found, total: "2" })).toEqual({ status: "none" });
  });

  it("asks once per question, and once at all where there is no such route", async () => {
    let calls = 0;
    const answering: Fetcher = async () => {
      calls += 1;
      return json(200, found);
    };
    const loader = createCarriersLoader(answering);
    const query = { scope: "java:p/A", term: "order", class: "domain" } as const;
    await Promise.all([loader.load(query), loader.load(query)]);
    expect(calls).toBe(1);

    let bare = 0;
    const daemon = createCarriersLoader(async () => {
      bare += 1;
      return new Response(null, { status: 404 });
    });
    expect(await daemon.load(query)).toEqual({ status: "none" });
    expect(await daemon.load({ ...query, term: "account" })).toEqual({ status: "none" });
    expect(bare).toBe(1);
  });

  it("reveals a type or a module by its id, and a member by its owner", () => {
    const ix = buildIndexes(artifact());
    const [type, member] = found.carriers;
    expect(carrierNode(ix, type as never)).toBe(1);
    expect(carrierNode(ix, member as never)).toBe(1);
    expect(carrierNode(ix, { name: "z", kind: "class", role: "type", weight: 1, occurrences: 1, id: "java:elsewhere" })).toBeUndefined();
  });
});
