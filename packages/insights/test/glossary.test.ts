import { describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  type GlossaryEntry,
  type InsightRecord,
  type InsightsHeader,
  type Level,
  type ModuleBlock,
  type OperationBlock,
  type RecordKey,
  type TypeBlock,
  type WordConcern,
  type WordEntry,
} from "../src/schema.js";
import { decodeInsights, encodeInsightsToString } from "../src/sidecar.js";
import { sqliteInsightsStore } from "../src/store-sqlite.js";
import {
  GLOSSARY_ANSWER_KIND,
  GLOSSARY_LIMIT,
  answerGlossary,
  concernsReport,
  moduleOf,
  polysemyReport,
  wordReport,
  wordsAbsence,
  type GlossaryAnswer,
  type Place,
  type Placement,
} from "../src/glossary.js";

/**
 * LAYER 3 OF PLAN.md §20.3: the readers of the words, over a real store. Two
 * modules that both speak `order`, one meaning a customer's request (and, in
 * one type, a sequence), the other a purchase order; a record a model wrote
 * under prompt 1; a template; and a record without a natural key.
 */

const HEADER: InsightsHeader = {
  t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
  models: { leaf: "m", rollup: "m" }, provider: "openrouter", depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const OPERATION: OperationBlock = {
  name: "f", description: "Does f.", safe: true, idempotent: null, owner: "entity", handlesCommand: null,
  emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.5,
};
const TYPE: TypeBlock = {
  name: "T", description: "A type.", concept: "aggregate", eventKind: null, interfaceRole: null, aggregateRoot: true,
  containedIn: null, syncPattern: null, identity: "id", fields: [], invariants: [], stateMachine: null, relatesTo: [],
  exposes: [], dependsOn: [], domainTerms: [], confidence: 0.9,
};
const MODULE: ModuleBlock = {
  name: "M", description: "A module.", apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null,
  sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.4,
};

const key = (module: string, symbol = "", disambiguator?: string): RecordKey => ({ lang: "java", module, symbol, ...(disambiguator === undefined ? {} : { disambiguator }) });
const word = (w: string, concern: WordConcern, sense: string, ins: string[] = [w], confidence = 0.8): WordEntry => ({ word: w, in: ins, concern, sense, meaning: `${sense}, here.`, confidence });
const gloss = (w: string, concern: WordConcern, sense: string, senses: GlossaryEntry["senses"] = []): GlossaryEntry => ({ word: w, concern, sense, meaning: `${sense}, reconciled.`, polysemous: senses.length > 0, senses });
const KINDS: Record<Level, string> = { operation: "method", type: "class", module: "package" };
const record = (id: string, level: Level, k: RecordKey | undefined, block: object, extra: Partial<InsightRecord> = {}): InsightRecord =>
  ({ t: "i", id, ...(k === undefined ? {} : { key: k }), level, kind: KINDS[level], name: id.slice(id.lastIndexOf("/") + 1), origin: "llm", block, fingerprint: "a".repeat(64), model: "m", ...extra }) as InsightRecord;

const ORDERING = "java:com.acme.order";
const BILLING = "java:com.acme.billing";
const RECORDS: InsightRecord[] = [
  record(ORDERING, "module", key("com.acme.order"), {
    ...MODULE,
    words: [word("order", "domain", "the ordering business", ["com.acme.order"])],
    glossary: [
      gloss("order", "domain", "a customer's request", [{ in: "Order", sense: "a customer's request" }, { in: "SortSpec", sense: "a sequence" }]),
      gloss("line", "domain", "an order line", [{ in: "Order", sense: "an order line" }, { in: "Text", sense: "a line of text" }]),
      gloss("total", "domain", "the sum"),
      gloss("price", "domain", "a unit price"),
      gloss("service", "technical", "a layer of the code"),
    ],
  }),
  record(`${ORDERING}/Order`, "type", key("com.acme.order", "Order"), {
    ...TYPE,
    words: [word("order", "domain", "a customer's request", ["Order"], 0.9), word("line", "domain", "an order line", ["lines"]), word("total", "domain", "the sum")],
  }),
  record(`${ORDERING}/SortSpec`, "type", key("com.acme.order", "SortSpec"), { ...TYPE, words: [word("order", "technical", "a sequence", ["sortOrder"], 0.6)] }),
  record(`${ORDERING}/Order.place(Order)`, "operation", key("com.acme.order", "Order.place", "(Order)"), {
    ...OPERATION,
    words: [word("place", "domain", "to submit"), word("order", "ambiguous", "the request, or its rank", ["order"], 0.5)],
  }),
  record(`${ORDERING}/Order.getId()`, "operation", key("com.acme.order", "Order.getId", "()"), OPERATION, { origin: "template" }),
  record(BILLING, "module", key("com.acme.billing"), {
    ...MODULE,
    words: [word("billing", "domain", "invoicing")],
    glossary: [gloss("order", "domain", "a purchase order"), gloss("total", "domain", "The  Sum "), gloss("price", "domain", "an amount due"), gloss("service", "domain", "a layer of the code")],
  }),
  record(`${BILLING}/Invoice`, "type", key("com.acme.billing", "Invoice"), { ...TYPE, words: [word("invoice", "domain", "a bill"), word("order", "domain", "a purchase order", ["orderRef"])] }),
  // Explained under prompt 1, before words were asked.
  record("java:com.acme.legacy/Old", "type", key("com.acme.legacy", "Old"), TYPE),
  // No natural key, and more words than any module: placed nowhere, and still last.
  record("loose/Thing", "type", undefined, { ...TYPE, words: ["order", "a", "b", "c", "d"].map((w) => word(w, "domain", `a loose ${w}`)) }),
];

const seeded = () => {
  const store = sqliteInsightsStore(loadSqlite().open(":memory:"));
  store.importFile(decodeInsights(encodeInsightsToString(HEADER, RECORDS, {
    t: "eof", counts: { records: RECORDS.length, llm: RECORDS.length - 1, template: 1, reused: 0, failed: 0 }, usage: { promptTokens: 1, completionTokens: 1 }, generatedAt: "2026-10-27T00:00:00.000Z",
  })));
  return store;
};

describe("wordReport: every entity whose names spell a word, by module, with the module's glossary entry", () => {
  it("groups by the records' module (their natural key's), the module itself first, then its types, then its operations", () => {
    const report = wordReport(seeded(), "order");
    expect(report.word).toBe("order");
    expect(report.modules.map((m) => [m.module, m.glossary.map((g) => `${g.id}: ${g.entry.sense}`), m.entries.map((e) => `${e.level} ${e.id} ${e.entry.concern}`)])).toEqual([
      [BILLING, [`${BILLING}: a purchase order`], [`type ${BILLING}/Invoice domain`]],
      [ORDERING, [`${ORDERING}: a customer's request`], [
        `module ${ORDERING} domain`,
        `type ${ORDERING}/Order domain`,
        `type ${ORDERING}/SortSpec technical`,
        `operation ${ORDERING}/Order.place(Order) ambiguous`,
      ]],
      // A record without a natural key is placed nowhere, and still answered.
      [undefined, [], ["type loose/Thing domain"]],
    ]);
  });

  it("an entry is what the projection holds: the identifiers it is in, concern, sense, confidence — its meaning is in the block", () => {
    const ordering = wordReport(seeded(), "order").modules[1];
    expect(ordering?.entries[1]).toEqual({
      id: `${ORDERING}/Order`, level: "type", kind: "class", name: "Order", key: key("com.acme.order", "Order"), model: "m",
      entry: { word: "order", in: ["Order"], concern: "domain", sense: "a customer's request", confidence: 0.9 },
    });
    expect(ordering?.glossary[0]?.entry).toEqual(RECORDS[0]?.level === "module" ? RECORDS[0].block.glossary?.[0] : undefined);
  });

  it("looks a word up as the splitter spells it — lowercase — and says how many records cannot answer at all", () => {
    const store = seeded();
    expect(wordReport(store, "ORDER")).toEqual(wordReport(store, "order"));
    expect(wordReport(store, "order").withoutWords).toBe(1);
    expect(wordReport(store, "nothing")).toEqual({ word: "nothing", modules: [], withoutWords: 1 });
  });

  it("keeps a module's glossary entry for a word none of its records' answers define", () => {
    // `price` is in both glossaries (their types were asked it) and in no record's words.
    expect(wordReport(seeded(), "price").modules.map((m) => [m.module, m.glossary.map((g) => g.entry.sense), m.entries.length])).toEqual([
      [BILLING, ["an amount due"], 0],
      [ORDERING, ["a unit price"], 0],
    ]);
  });
});

describe("polysemyReport: the words a module flagged, and the words its modules' senses differ on", () => {
  it("lays every module's entry for such a word side by side, the most contested first", () => {
    const { words, withoutWords } = polysemyReport(seeded());
    expect(words.map((w) => ({ ...w, entries: w.entries.map((e) => `${e.id}: ${e.entry.sense}`) }))).toEqual([
      // A customer's request and a sequence (the flag's), a purchase order (billing's): three senses.
      { word: "order", flagged: true, acrossModules: true, senses: 3, entries: [`${BILLING}: a purchase order`, `${ORDERING}: a customer's request`] },
      // Flagged by its one module, whose types disagree.
      { word: "line", flagged: true, acrossModules: false, senses: 2, entries: [`${ORDERING}: an order line`] },
      { word: "price", flagged: false, acrossModules: true, senses: 2, entries: [`${BILLING}: an amount due`, `${ORDERING}: a unit price`] },
      // One sense, judged domain here and technical there: a disagreement all the same.
      { word: "service", flagged: false, acrossModules: true, senses: 1, entries: [`${BILLING}: a layer of the code`, `${ORDERING}: a layer of the code`] },
    ]);
    // "the sum" and "The  Sum " are one sense: case and spacing aside. A word one module defines once is not listed.
    expect(withoutWords).toBe(1);
  });
});

describe("concernsReport: per module, how many of its words the model called domain, technical, ambiguous", () => {
  it("counts each word once per concern it was given, the most-worded module first, the records without a key last", () => {
    expect(concernsReport(seeded())).toEqual({
      modules: [
        // order is domain in Order, technical in SortSpec, ambiguous in place(): it counts under all three.
        { module: ORDERING, words: 4, concerns: { domain: 4, technical: 1, ambiguous: 1 } },
        { module: BILLING, words: 3, concerns: { domain: 3, technical: 0, ambiguous: 0 } },
        { module: undefined, words: 5, concerns: { domain: 5, technical: 0, ambiguous: 0 } },
      ],
      withoutWords: 1,
    });
  });
});

describe("a reader's answer for a record without words (PLAN.md §20.3)", () => {
  it("is prompt 1's when a model wrote it, a template's when none did, and nothing when it has words — none included", () => {
    const byId = new Map(RECORDS.map((r) => [r.id, r]));
    expect(wordsAbsence(byId.get("java:com.acme.legacy/Old") as InsightRecord)).toBe("prompt-1");
    expect(wordsAbsence(byId.get(`${ORDERING}/Order.getId()`) as InsightRecord)).toBe("templated");
    expect(wordsAbsence(byId.get(`${ORDERING}/Order`) as InsightRecord)).toBeUndefined();
    expect(wordsAbsence({ ...(byId.get(`${ORDERING}/Order`) as InsightRecord), block: { ...TYPE, words: [] } } as InsightRecord)).toBeUndefined();
  });
});

describe("moduleOf: where a record sits, rendered from its natural key — never parsed from its id", () => {
  it("is the module's id for any key of it, and undefined without a key or for one that cannot render", () => {
    expect(moduleOf(key("com.acme.order", "Order.place", "(Order)"))).toBe(ORDERING);
    expect(moduleOf(key("com.acme.order"))).toBe(ORDERING);
    expect(moduleOf(undefined)).toBeUndefined();
    // `/` is reserved in a key's components: a hand-edited side-car's key is placed nowhere rather than mis-rendered.
    expect(moduleOf({ lang: "java", module: "a/b", symbol: "C" })).toBeUndefined();
  });
});

describe("answerGlossary: what a page is told of a word under a scope (serve's /glossary.json)", () => {
  /** What the model folds each id into; `loose/Thing` it does not hold, `legacy/Old` it does. */
  const PLACES: Readonly<Record<string, Place>> = {
    [ORDERING]: { module: ORDERING },
    [`${ORDERING}/Order`]: { module: ORDERING, type: `${ORDERING}/Order` },
    [`${ORDERING}/SortSpec`]: { module: ORDERING, type: `${ORDERING}/SortSpec` },
    [`${ORDERING}/Order.place(Order)`]: { module: ORDERING, type: `${ORDERING}/Order` },
    [BILLING]: { module: BILLING },
    [`${BILLING}/Invoice`]: { module: BILLING, type: `${BILLING}/Invoice` },
    "java:com.acme.legacy/Old": { module: "java:com.acme.legacy", type: "java:com.acme.legacy/Old" },
  };
  const placement: Placement = (id) => PLACES[id];
  const found = (answer: GlossaryAnswer) => {
    if (answer.status !== "found") throw new Error(`expected found, got ${answer.status}`);
    return answer;
  };
  const lines = (answer: GlossaryAnswer) => found(answer).entries.map((e) => `${e.level} ${e.id} ${e.entry.concern}${e.owner === undefined ? "" : ` in ${e.owner}`}`);

  it("over the corpus: every placed entity's entry, modules then types then operations, and every module's reconciliation", () => {
    const answer = found(answerGlossary(seeded(), { term: "order" }, placement));
    expect(answer.kind).toBe(GLOSSARY_ANSWER_KIND);
    expect(answer.scope).toBeUndefined();
    expect(lines(answer)).toEqual([
      `module ${ORDERING} domain`,
      `type ${BILLING}/Invoice domain`,
      `type ${ORDERING}/Order domain`,
      `type ${ORDERING}/SortSpec technical`,
      // An operation is no node of the navigator: it names the type a page reveals instead.
      `operation ${ORDERING}/Order.place(Order) ambiguous in ${ORDERING}/Order`,
    ]);
    // `loose/Thing` says order too, and the model holds no such entity: left out, as the vocabulary leaves it.
    expect(answer.glossary.map((g) => `${g.id}: ${g.entry.sense}`)).toEqual([`${BILLING}: a purchase order`, `${ORDERING}: a customer's request`]);
    expect(answer.total).toEqual({ entries: 5, glossary: 2 });
    expect(answer.withoutWords).toBe(1);
  });

  it("an entry is the projection's, without the natural key a page has no use for; a glossary entry is whole", () => {
    const answer = found(answerGlossary(seeded(), { term: "order", scope: `${ORDERING}/SortSpec` }, placement));
    expect(answer.entries).toEqual([
      { id: `${ORDERING}/SortSpec`, level: "type", kind: "class", name: "SortSpec", model: "m", entry: { word: "order", in: ["sortOrder"], concern: "technical", sense: "a sequence", confidence: 0.6 } },
    ]);
    expect(found(answerGlossary(seeded(), { term: "order", scope: ORDERING }, placement)).glossary).toEqual([
      { id: ORDERING, name: ORDERING, model: "m", entry: RECORDS[0]?.level === "module" ? RECORDS[0].block.glossary?.[0] : undefined },
    ]);
  });

  it("under a module: what folds into it, its own glossary; under a type: the type and its members, no module's glossary", () => {
    const ordering = found(answerGlossary(seeded(), { term: "order", scope: ORDERING }, placement));
    expect(ordering.scope).toBe(ORDERING);
    expect(lines(ordering)).toEqual([
      `module ${ORDERING} domain`,
      `type ${ORDERING}/Order domain`,
      `type ${ORDERING}/SortSpec technical`,
      `operation ${ORDERING}/Order.place(Order) ambiguous in ${ORDERING}/Order`,
    ]);
    expect(ordering.glossary.map((g) => g.id)).toEqual([ORDERING]);

    const order = found(answerGlossary(seeded(), { term: "order", scope: `${ORDERING}/Order` }, placement));
    expect(lines(order)).toEqual([`type ${ORDERING}/Order domain`, `operation ${ORDERING}/Order.place(Order) ambiguous in ${ORDERING}/Order`]);
    expect(order.glossary).toEqual([]);
    expect(order.total).toEqual({ entries: 2, glossary: 0 });
  });

  it("a scope is a module or a type the model holds; an operation, an unknown id, a stranger's are not", () => {
    const store = seeded();
    for (const scope of [`${ORDERING}/Order.place(Order)`, "java:nowhere", "loose/Thing"]) {
      expect(answerGlossary(store, { term: "order", scope }, placement)).toEqual({ kind: GLOSSARY_ANSWER_KIND, status: "unknown-scope", scope });
    }
    // A scope nobody explained is a scope still: its answer is empty, not unknown.
    expect(found(answerGlossary(store, { term: "order", scope: "java:com.acme.legacy/Old" }, placement)).entries).toEqual([]);
  });

  it("asks the word as the splitter spells it, lowercase; a word nobody defined is found and empty", () => {
    const store = seeded();
    expect(answerGlossary(store, { term: "ORDER" }, placement)).toEqual(answerGlossary(store, { term: "order" }, placement));
    expect(answerGlossary(store, { term: "nothing" }, placement)).toEqual({
      kind: GLOSSARY_ANSWER_KIND, status: "found", term: "nothing", total: { entries: 0, glossary: 0 }, entries: [], glossary: [], withoutWords: 1,
    });
  });

  it("lists the first `limit` of each list and counts them all; a limit is a whole number", () => {
    const store = seeded();
    const cut = found(answerGlossary(store, { term: "order", limit: 2 }, placement));
    expect(cut.entries.map((e) => e.id)).toEqual([ORDERING, `${BILLING}/Invoice`]);
    expect(cut.glossary.map((g) => g.id)).toEqual([BILLING, ORDERING]);
    expect(cut.total).toEqual({ entries: 5, glossary: 2 });
    expect(found(answerGlossary(store, { term: "order", limit: 0 }, placement)).entries).toEqual([]);
    expect(GLOSSARY_LIMIT).toBe(200);
    expect(() => answerGlossary(store, { term: "order", limit: 1.5 }, placement)).toThrow(RangeError);
    expect(() => answerGlossary(store, { term: "order", limit: -1 }, placement)).toThrow(RangeError);
  });
});
