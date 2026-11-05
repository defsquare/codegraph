import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadSqlite, loadModels } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  WORD_CONCERNS,
  decodeInsights,
  encodeInsightsToString,
  sqliteInsightsStore,
  type InsightRecord,
  type InsightsHeader,
  type WordConcern,
  type WordEntry,
} from "@codegraph/insights";
import {
  JUDGED_CONCERNS,
  buildVocabulary,
  operationScope,
  vocabularyCloudSvg,
  vocabularyToJsonString,
} from "@codegraph/vocabulary";
import { describe, expect, it } from "vitest";
import type { VocabularyOptions } from "../src/args.js";
import { vocabularyCommand } from "../src/commands/vocabulary.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph vocabulary` over the committed Spoon output. The counts are
 * `@codegraph/vocabulary`'s (its own suite); what is checked here is the
 * command: which scope, class and report each flag picks, the streams, the
 * usage errors and the exit codes.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const ABSTRACT_ORDER = "java:com.acme.order/AbstractOrder";

function options(overrides: Partial<VocabularyOptions> = {}): VocabularyOptions {
  return {
    models: [FIXTURE],
    level: "corpus",
    scope: undefined,
    top: undefined,
    termClass: "domain",
    weights: {},
    technical: undefined,
    drift: undefined,
    driftInsights: false,
    insights: undefined,
    out: undefined,
    svg: undefined,
    json: false,
    internalOnly: false,
    declaredOnly: false,
    noCache: true,
    ...overrides,
  };
}

function vocabularyTo(overrides: Partial<VocabularyOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = vocabularyCommand(options(overrides), io);
  return { io, code };
}

function usageErrorOf(overrides: Partial<VocabularyOptions>): UsageError {
  try {
    vocabularyTo(overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error("expected a usage error");
}

/** A file in a fresh temporary directory. */
function file(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-")), name);
  writeFileSync(path, text);
  return path;
}

/** The table rows of a text report, each as its cells. */
function rows(stdout: string): readonly (readonly string[])[] {
  return stdout
    .split("\n")
    .filter((line) => /^ {2}\S+ +(domain|technical|keyword|short) /u.test(line))
    .map((line) => line.trim().split(/ +/u));
}

interface WordsJson {
  kind: string;
  report: string;
  level: string;
  scope: string | null;
  view: { name: string };
  weights: Record<string, number>;
  technical: { words: number; sha256: string };
  class: string;
  top: number;
  scopes: {
    level: string;
    id?: string;
    name: string;
    kind?: string;
    parent?: string | null;
    distinct: number;
    distinctDomain: number;
    shown: number;
    total: number;
    terms: { text: string; class: string; weight: number; occurrences: number; carriers: number; modules: number; types: number }[];
  }[];
}

describe("vocabulary: the corpus's words", () => {
  const { io, code } = vocabularyTo();

  it("prints the corpus's heaviest domain words as a table, and nothing else on stdout", () => {
    expect(code).toBe(EXIT.OK);
    expect(rows(io.stdout()).slice(0, 3)).toEqual([
      ["order", "domain", "40", "12", "12", "3", "4"],
      ["price", "domain", "18", "6", "6", "1", "6"],
      ["basket", "domain", "16", "2", "2", "1", "2"],
    ]);
    expect(io.stdout()).toContain("TERM");
    expect(io.stdout()).not.toContain("cache:");
    expect(io.stderr()).toContain("cache: not used");
  });

  it("states the view, the weights and the technical list it counted under", () => {
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("codegraph vocabulary — words");
    expect(lines).toContain(`models:    ${FIXTURE}`);
    expect(lines).toContain("level:     corpus");
    expect(lines).toContain("view:      all (nothing filtered — stubs and inferred edges included)");
    expect(lines).toContain(
      "weights:   module 8 · type 8 · operation 3 · attribute 4 · parameter 1 · local 1 · other 1 · qualifier 1",
    );
    expect(lines.find((line) => line.startsWith("technical: "))).toMatch(
      /^technical: 138 shared words \(sha256 [0-9a-f]{12}\) \+ each language's own$/u,
    );
  });

  it("says what the corpus counted, and how much of the table it shows", () => {
    const lines = io.stdoutLines();
    expect(lines).toContain("corpus src");
    expect(lines).toContain(
      "  152 entities: 127 speak (module 3 · type 19 · operation 43 · attribute 21 · parameter 35 · local 6), 25 unnamed",
    );
    expect(lines).toContain("  85 distinct terms, 73 domain · weight 503 · 146 occurrences");
    expect(lines).toContain("  domain: 40 of 73 terms (--top 40), by weight descending, ties by term");
    expect(rows(io.stdout())).toHaveLength(40);
  });

  it("shows another class, or every class, with --class", () => {
    const all = vocabularyTo({ termClass: "all" }).io.stdout();
    expect(all).toContain("  all classes: 40 of 85 terms (--top 40), by weight descending, ties by term");
    const technical = rows(vocabularyTo({ termClass: "technical" }).io.stdout());
    expect(technical.map(([, termClass]) => termClass)).toEqual(technical.map(() => "technical"));
    expect(technical.length).toBeGreaterThan(0);
  });

  it("shows the N heaviest with --top", () => {
    const stdout = vocabularyTo({ top: 2 }).io.stdout();
    expect(rows(stdout).map(([term]) => term)).toEqual(["order", "price"]);
    expect(stdout).toContain("  domain: 2 of 73 terms (--top 2), by weight descending, ties by term");
  });

  it("is byte-identical across runs", () => {
    expect(vocabularyTo().io.stdout()).toBe(io.stdout());
  });

  it("counts under the view", () => {
    const internal = vocabularyTo({ internalOnly: true }).io;
    expect(internal.stdoutLines()).toContain("view:      internalOnly (internalOnly)");
  });
});

describe("vocabulary: --json", () => {
  it("says the same thing as one JSON object", () => {
    const { io, code } = vocabularyTo({ json: true, top: 2 });
    expect(code).toBe(EXIT.OK);
    const json = JSON.parse(io.stdout()) as WordsJson;
    expect(json).toMatchObject({
      kind: "codegraph.vocabularyReport/1",
      report: "words",
      level: "corpus",
      scope: null,
      view: { name: "all" },
      weights: { module: 8, qualifier: 1 },
      technical: { words: 138 },
      class: "domain",
      top: 2,
    });
    expect(json.scopes).toHaveLength(1);
    expect(json.scopes[0]).toMatchObject({ level: "corpus", name: "src", distinct: 85, distinctDomain: 73, shown: 2, total: 73 });
    expect(json.scopes[0]?.terms).toEqual([
      { text: "order", class: "domain", weight: 40, occurrences: 12, carriers: 12, modules: 3, types: 4 },
      { text: "price", class: "domain", weight: 18, occurrences: 6, carriers: 6, modules: 1, types: 6 },
    ]);
  });
});

describe("vocabulary: --level module|type, the cognitive-load report", () => {
  it("prints one block per module, by distinct terms descending, ties by id", () => {
    const { io, code } = vocabularyTo({ level: "module" });
    expect(code).toBe(EXIT.OK);
    const titles = io.stdoutLines().filter((line) => line.startsWith("module "));
    expect(titles).toEqual([
      "module java:com.acme.order (package com.acme.order)",
      "module java:com.acme.order.adapter (package com.acme.order.adapter)",
      "module java:com.acme.order.legacy (package com.acme.order.legacy)",
    ]);
    expect(io.stdoutLines()).toContain("3 modules, ranked by distinct terms descending, ties by id");
    expect(io.stdoutLines()).toContain("  77 distinct terms, 66 domain · weight 433 · 126 occurrences");
  });

  it("shows 10 words per block by default, --top N otherwise", () => {
    const blocks = (stdout: string) => stdout.split("\nmodule ").slice(1).map((block) => rows(`\n${block}`).length);
    expect(blocks(vocabularyTo({ level: "module" }).io.stdout())).toEqual([10, 6, 7]);
    expect(blocks(vocabularyTo({ level: "module", top: 3 }).io.stdout())).toEqual([3, 3, 3]);
  });

  it("ranks the types the same way, and says so in JSON", () => {
    const json = JSON.parse(vocabularyTo({ level: "type", json: true }).io.stdout()) as WordsJson;
    expect(json.scopes).toHaveLength(19);
    expect(json.top).toBe(10);
    const distinct = json.scopes.map((scope) => scope.distinct);
    expect(distinct).toEqual([...distinct].sort((a, b) => b - a));
    expect(json.scopes.every((scope) => scope.level === "type" && scope.parent !== undefined)).toBe(true);
  });
});

describe("vocabulary: --scope", () => {
  it("prints one stored scope, a type or a module", () => {
    const { io } = vocabularyTo({ scope: ABSTRACT_ORDER, termClass: "all" });
    expect(io.stdoutLines()).toContain("scope:     java:com.acme.order/AbstractOrder");
    expect(io.stdoutLines()).toContain("type java:com.acme.order/AbstractOrder (class AbstractOrder)");
    expect(rows(io.stdout()).map(([term, termClass, weight]) => [term, termClass, weight])).toEqual([
      ["abstract", "keyword", "8"],
      ["order", "domain", "8"],
      ["reference", "domain", "8"],
      ["total", "domain", "4"],
      ["price", "domain", "3"],
    ]);
    expect(vocabularyTo({ scope: "java:com.acme.order.adapter" }).io.stdoutLines()).toContain(
      "module java:com.acme.order.adapter (package com.acme.order.adapter)",
    );
  });

  it("counts an operation on demand, inside its stored scope", () => {
    const { io, code } = vocabularyTo({ scope: `${ABSTRACT_ORDER}.price()` });
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()).toContain(
      `operation ${ABSTRACT_ORDER}.price() (method price), counted on demand, inside ${ABSTRACT_ORDER}`,
    );
    expect(rows(io.stdout())).toEqual([["price", "domain", "3", "1", "1", "1", "6"]]);
    const json = JSON.parse(vocabularyTo({ scope: `${ABSTRACT_ORDER}.price()`, json: true }).io.stdout()) as WordsJson;
    expect(json.scope).toBe(`${ABSTRACT_ORDER}.price()`);
    expect(json.scopes[0]).toMatchObject({ level: "operation", kind: "method", parent: ABSTRACT_ORDER });
  });

  it("refuses an id the model does not declare", () => {
    const error = usageErrorOf({ scope: "java:com.acme/Nothing" });
    expect(error.message).toBe("unknown scope 'java:com.acme/Nothing'");
    expect(error.hint ?? "").toContain("module, type or operation");
  });

  it("refuses an external entity: a stub speaks no words", () => {
    expect(usageErrorOf({ scope: "java:com.megacorp.ledger" }).message).toBe(
      "java:com.megacorp.ledger is external (a stub): its name was chosen elsewhere, so it speaks no words",
    );
  });

  it("refuses a member that is no operation, naming the scope that counts it", () => {
    const model = readModelFileSync(FIXTURE);
    const member = model.entities.find((entity) => entity.traits.includes("TStructural") && !entity.isStub);
    const error = usageErrorOf({ scope: member?.id ?? "" });
    expect(error.message).toBe(`${member?.id} is a ${member?.kind}, not a module, type or operation`);
    expect(error.hint ?? "").toMatch(/^Its words are counted in /u);
  });
});

describe("vocabulary: --weights and --technical", () => {
  it("lays the typed weights over the defaults, and says so", () => {
    const { io } = vocabularyTo({ weights: { type: 0, qualifier: 0 } });
    expect(io.stdoutLines()).toContain(
      "weights:   module 8 · type 0 · operation 3 · attribute 4 · parameter 1 · local 1 · other 1 · qualifier 0",
    );
    // `order` names types and qualifies the packages; `price` does neither.
    expect(rows(io.stdout()).slice(0, 2)).toEqual([
      ["price", "domain", "18", "6", "6", "1", "6"],
      ["order", "domain", "14", "12", "12", "3", "4"],
    ]);
  });

  it("replaces the shared technical list with the file's words", () => {
    const path = file("technical.txt", "# ours\norder\nprice\n");
    const { io } = vocabularyTo({ technical: path });
    // Replaced whole: `adapter`, shared plumbing, is a domain word now.
    expect(rows(io.stdout()).map(([term]) => term).slice(0, 3)).toEqual(["adapter", "basket", "channel"]);
    expect(io.stdoutLines().find((line) => line.startsWith("technical: "))).toMatch(
      /^technical: 2 shared words from .*technical\.txt \(sha256 [0-9a-f]{12}\) \+ each language's own$/u,
    );
    expect(rows(vocabularyTo({ technical: path, termClass: "technical" }).io.stdout()).map(([term]) => term)).toContain("order");
  });

  it("refuses a technical line that is not one word, by its line number", () => {
    const error = usageErrorOf({ technical: file("technical.txt", "dto\nvalue object\nHTTPServer\n") });
    expect(error.message).toContain("2 lines of");
    expect(error.hint ?? "").toContain("line 2: value object");
    expect(error.hint ?? "").toContain("line 3: HTTPServer");
  });

  it("refuses a technical file it cannot read", () => {
    expect(usageErrorOf({ technical: "/nonexistent/technical.txt" }).message).toContain("cannot read /nonexistent/technical.txt");
  });
});

describe("vocabulary: --drift", () => {
  const glossary = file("glossary.txt", "# the business\nOrder\nOrder Line\nCustomer\nPayment Schedule\n2024\n");

  it("lists the business terms no scope says, then the ones it says, then the code's own words", () => {
    const { io, code } = vocabularyTo({ drift: glossary });
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("codegraph vocabulary — drift");
    expect(lines).toContain(`glossary:  ${glossary}, 4 business terms`);
    expect(lines).toContain("never said: 2 of 4 business terms, a word the corpus never says");
    expect(lines.find((line) => line.trimStart().startsWith("Customer"))).toMatch(/^ {2}Customer +missing customer$/u);
    expect(lines.find((line) => line.trimStart().startsWith("Payment Schedule"))).toMatch(
      /^ {2}Payment Schedule +missing payment, schedule$/u,
    );
    expect(lines).toContain("said: 2 of 4 business terms");
    expect(lines.some((line) => /^ {2}Order Line$/u.test(line))).toBe(true);
    expect(lines.find((line) => line.startsWith("code only: "))).toBe(
      "code only: 40 of 71 domain words no business term contains (--top 40), by weight descending, ties by term",
    );
    expect(lines.find((line) => /^ {2}price /u.test(line))).toMatch(/^ {2}price +18 +6$/u);
    // A finding: the code does not say what the business says.
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("2 business terms the corpus never says — exiting 3 (findings).");
    expect(io.stderr()).toContain("warning: line 6 of");
    expect(io.stderr()).toContain("names no word, skipped: 2024");
  });

  it("names, by module, the one module saying a term, or how many do", () => {
    const lines = vocabularyTo({ drift: glossary, level: "module" }).io.stdoutLines();
    expect(lines).toContain("level:     module");
    expect(lines).toContain("never said: 2 of 4 business terms, no module says all their words");
    expect(lines.find((line) => line.trimStart().startsWith("Order Line"))).toMatch(
      /^ {2}Order Line +1 module: java:com\.acme\.order$/u,
    );
    expect(lines.find((line) => /^ {2}Order {2,}/u.test(line))).toMatch(/^ {2}Order +3 modules$/u);
    expect(lines.find((line) => line.startsWith("  TERM"))).toMatch(/^ {2}TERM +WEIGHT +OCC +MODULES$/u);
  });

  it("exits 0 when every business term is said", () => {
    const { code, io } = vocabularyTo({ drift: file("glossary.txt", "Order\nOrder Line\n") });
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()).toContain("never said: none of 2 business terms");
  });

  it("says the same thing as one JSON object", () => {
    const json = JSON.parse(vocabularyTo({ drift: glossary, level: "module", json: true, top: 1 }).io.stdout()) as {
      kind: string;
      report: string;
      level: string;
      glossary: { path: string; terms: number; wordless: { line: number; text: string }[] };
      business: { text: string; words: string[]; said: boolean; scopes?: string[]; missing: string[] }[];
      codeOnly: { shown: number; total: number; top: number; words: { text: string; weight: number; occurrences: number; scopes: number }[] };
    };
    expect(json).toMatchObject({ kind: "codegraph.vocabularyReport/1", report: "drift", level: "module" });
    expect(json.glossary).toEqual({ path: glossary, terms: 4, wordless: [{ line: 6, text: "2024" }] });
    expect(json.business[1]).toEqual({
      text: "Order Line",
      words: ["order", "line"],
      said: true,
      scopes: ["java:com.acme.order"],
      missing: [],
    });
    expect(json.business[2]).toMatchObject({ text: "Customer", said: false, scopes: [], missing: ["customer"] });
    expect(json.codeOnly).toMatchObject({ shown: 1, top: 1 });
    expect(json.codeOnly.words).toHaveLength(1);
  });

  it("refuses a glossary that holds no business term", () => {
    expect(usageErrorOf({ drift: file("glossary.txt", "# nothing yet\n\n") }).message).toContain("holds no business term");
  });
});

const said = (word: string, concern: WordConcern, sense: string, inside: string[], confidence = 0.8): WordEntry =>
  ({ word, in: inside, concern, sense, meaning: `${sense}, here.`, confidence });

/** A record as 'codegraph explain' writes one, carrying these words; none is a prompt-1 record. */
function record(id: string, level: "module" | "type" | "operation", words: WordEntry[] | undefined): InsightRecord {
  const block =
    level === "module"
      ? { name: "M", description: "A module.", apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.6, glossary: [] }
      : level === "type"
        ? { name: "T", description: "A type.", concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: false, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.7 }
        : { name: "op", description: "Bills.", safe: false, idempotent: false, owner: "domainService", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.7 };
  const kind = level === "module" ? "package" : level === "type" ? "class" : "method";
  return { t: "i", id, level, kind, origin: "llm", model: "strong/model", fingerprint: "a".repeat(64), block: { ...block, ...(words === undefined ? {} : { words }) } } as InsightRecord;
}

/** An insights store in `dir`, holding these records. */
function storeWith(dir: string, records: readonly InsightRecord[]): string {
  const header: InsightsHeader = {
    t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL,
    models: { leaf: "cheap/model", rollup: "strong/model" }, provider: "openrouter", depth: 1,
    source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
  };
  const path = join(dir, "model.insights.db");
  const store = sqliteInsightsStore(loadSqlite().open(path));
  const eof = { t: "eof" as const, counts: { records: records.length, llm: records.length, template: 0, reused: 0, failed: 0 }, usage: { promptTokens: 0, completionTokens: 0 }, generatedAt: "2026-10-28T10:00:00.000Z" };
  store.importFile(decodeInsights(encodeInsightsToString(header, records, eof)));
  store.close();
  return path;
}

/**
 * A store over the fixture's own ids, as 'codegraph explain' would leave it:
 * `service` judged domain in OrderService (the list calls it technical),
 * `trail` judged technical in LedgerAdapter (the list calls it domain), a
 * record of an entity the model does not have, and one explained under prompt 1.
 */
function storeOf(dir: string): string {
  return storeWith(dir, [
    record("java:com.acme.order/OrderService.bill(com.acme.order.Order)", "operation", [said("bill", "domain", "to invoice", ["bill"])]),
    record("java:com.acme.order.adapter/LedgerAdapter", "type", [
      said("ledger", "domain", "the books", ["LedgerAdapter"]),
      said("adapter", "technical", "a port's implementation", ["LedgerAdapter"]),
      said("trail", "technical", "an audit log", ["trail"], 0.7),
    ]),
    record("java:com.acme.order/Basket", "type", undefined),
    record("java:com.acme.order/Order", "type", [said("order", "domain", "a customer's request", ["Order"]), said("channel", "domain", "a sales channel", ["channel"])]),
    record("java:com.acme.order/OrderService", "type", [
      said("order", "domain", "a customer's request", ["OrderService"]),
      said("service", "domain", "after-sales care", ["OrderService"], 0.6),
      said("ledger", "domain", "the books", ["ledger"]),
    ]),
    record("java:com.acme.order/Refund", "type", [said("refund", "domain", "money back", ["Refund"])]),
    record("java:com.acme.order", "module", [said("order", "domain", "the ordering business", ["com.acme.order"])]),
  ]);
}

describe("vocabulary: --drift-insights, the list against what a model judged", () => {
  const store = storeOf(mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-store-")));
  const judged = (overrides: Partial<VocabularyOptions> = {}) => vocabularyTo({ driftInsights: true, insights: store, ...overrides });

  it("lists the technical words a model called domain somewhere, then the reverse, each with the entities that did", () => {
    const { io, code } = judged();
    const lines = io.stdoutLines();
    expect(lines[0]).toBe("codegraph vocabulary — drift-insights");
    expect(lines[2]).toBe(`insights:  ${store}, judged by cheap/model (operations), strong/model (types, modules)`);
    const report = lines.slice(lines.indexOf("") + 1);
    expect(report).toEqual([
      "compared: 10 word entries from 5 explained entities",
      "",
      "technical by the list, judged domain: 1 of 2 technical words, the most judgements against first",
      "  service  domain 1",
      `    0.60  "after-sales care"  OrderService in java:com.acme.order/OrderService`,
      "",
      "domain by the list, judged technical: 1 of 5 domain words, the most judgements against first",
      "  trail  technical 1",
      `    0.70  "an audit log"  trail in java:com.acme.order.adapter/LedgerAdapter`,
    ]);
    // The judgements are inferences: they never make a finding.
    expect(code).toBe(EXIT.OK);
    expect(io.stderr()).toContain("note: 1 record a model wrote under prompt 1 defines no words; the next 'codegraph explain' re-explains it.");
    expect(io.stderr()).toContain("note: 1 explained record names no entity of this model (explained against another version of it): left out.");
  });

  it("shows a word's five surest judgements against it, and says how many more --json holds", () => {
    const types = ["Basket", "Batch", "Channel", "Money", "Notifications", "Order", "OrderService"];
    const crowded = storeWith(
      mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-crowded-")),
      // The surest last by name: what is shown is decided by confidence, not by id.
      types.map((name, i) => record(`java:com.acme.order/${name}`, "type", [said("adapter", "domain", "a go-between", [name], 0.3 + i / 10)])),
    );
    const lines = vocabularyTo({ driftInsights: true, insights: crowded }).io.stdoutLines();
    const from = lines.indexOf("  adapter  domain 7");
    expect(lines.slice(from + 1, from + 7).map((line) => line.split(/ {2,}/u).at(-1))).toEqual([
      ...types.slice(2).reverse().map((name) => `${name} in java:com.acme.order/${name}`),
      "… and 2 more (--json lists every one)",
    ]);
    const json = JSON.parse(vocabularyTo({ driftInsights: true, insights: crowded, json: true }).io.stdout()) as {
      technicalJudgedDomain: { words: { against: unknown[] }[] };
    };
    expect(json.technicalJudgedDomain.words[0]?.against).toHaveLength(7);
  });

  it("--top cuts each list, and says so", () => {
    const lines = judged({ technical: file("tech.txt", "order\nchannel\nledger\n"), top: 1 }).io.stdoutLines();
    // The file replaces the shared list whole: `adapter` and `service` are domain words under it.
    expect(lines).toContain("technical by the list, judged domain: 3 of 3 technical words (1 shown, --top 1), the most judgements against first");
    expect(lines).toContain("domain by the list, judged technical: 2 of 4 domain words (1 shown, --top 1), the most judgements against first");
    expect(lines.filter((line) => /^ {2}\S/u.test(line))).toEqual(["  order  domain 3", "  adapter  technical 1"]);
  });

  it("over a store whose records define no word, says there is nothing to compare", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-empty-"));
    const empty = join(dir, "model.insights.db");
    sqliteInsightsStore(loadSqlite().open(empty)).close();
    const { io, code } = vocabularyTo({ driftInsights: true, insights: empty });
    expect(code).toBe(EXIT.OK);
    const lines = io.stdoutLines();
    expect(lines).toContain("compared: no word entry — no explained entity of this model defines a word");
    expect(lines).toContain("technical by the list, judged domain: no technical word judged");
    expect(lines).toContain("domain by the list, judged technical: no domain word judged");
  });

  it("classifies under the list --technical gives", () => {
    const lines = judged({ technical: file("tech.txt", "trail\nadapter\n") }).io.stdoutLines();
    expect(lines).toContain("technical by the list, judged domain: none of 2 technical words");
    expect(lines).toContain("domain by the list, judged technical: none of 5 domain words");
  });

  it("with --drift, sets the business terms against both, and still exits 3 on a term the corpus never says", () => {
    const glossary = file("glossary.txt", "Order Service\nLedger\nCustomer\n");
    const { io, code } = judged({ drift: glossary });
    const lines = io.stdoutLines();
    expect(lines).toContain(`glossary:  ${glossary}, 3 business terms`);
    const from = lines.indexOf("business terms against both: 1 of 3 drift, a word the list or a model does not call domain");
    expect(from).toBeGreaterThan(0);
    expect(lines.slice(from + 1).map((line) => line.trimEnd().split(/ {2,}/u))).toEqual([
      [""],
      ["", "TERM", "WORD", "LIST", "MODEL", "DRIFT"],
      ["", "Order Service", "order", "domain", "domain 3"],
      ["", "service", "technical", "domain 1", "list"],
      ["", "Ledger", "ledger", "domain", "domain 2"],
      ["", "Customer", "customer", "not said", "not judged"],
    ]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("1 business term the corpus never says — exiting 3 (findings).");
  });

  it("says the same thing as one JSON object", () => {
    const glossary = file("glossary.txt", "Order Service\n");
    const json = JSON.parse(judged({ drift: glossary, json: true, top: 1 }).io.stdout()) as Record<string, unknown>;
    expect(json).toMatchObject({
      kind: "codegraph.vocabularyReport/1",
      report: "drift-insights",
      insights: { path: store, models: { leaf: "cheap/model", rollup: "strong/model" }, withoutWords: 1, leftOut: { unknown: 1, notKept: 0 } },
      compared: { entries: 10, entities: 5 },
      technicalJudgedDomain: { judged: 2, total: 1, shown: 1, top: 1 },
      domainJudgedTechnical: { judged: 5, total: 1, shown: 1, top: 1 },
      glossary: { path: glossary, terms: 1, wordless: [] },
      business: [
        {
          text: "Order Service",
          said: true,
          drift: true,
          words: [
            { word: "order", classes: ["domain"], concerns: { domain: 3, technical: 0, ambiguous: 0 }, drift: [] },
            { word: "service", classes: ["technical"], concerns: { domain: 1, technical: 0, ambiguous: 0 }, drift: ["list"] },
          ],
        },
      ],
    });
    expect((json["technicalJudgedDomain"] as { words: unknown[] }).words).toEqual([
      {
        word: "service",
        class: "technical",
        concerns: { domain: 1, technical: 0, ambiguous: 0 },
        against: [{ id: "java:com.acme.order/OrderService", word: "service", concern: "domain", sense: "after-sales care", confidence: 0.6, in: ["OrderService"] }],
      },
    ]);
  });

  it("reads the store beside the first model by default, and writes nothing there", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-beside-"));
    const model = join(dir, "model.jsonl");
    copyFileSync(FIXTURE, model);
    const bytes = readFileSync(storeOf(dir));
    const before = readdirSync(dir).sort();
    const { io, code } = vocabularyTo({ models: [model], driftInsights: true });
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()[2]).toMatch(new RegExp(`^insights: {2}${join(dir, "model.insights.db").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")},`, "u"));
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(join(dir, "model.insights.db")).equals(bytes)).toBe(true);
  });

  it("refuses a store that is not there, naming the flag that points at another", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-none-")), "model.insights.db");
    const error = usageErrorOf({ driftInsights: true, insights: missing });
    expect(error.message).toBe(`no insights store at ${missing}`);
    expect(error.hint).toContain("--insights FILE");
  });

  it("knows the concerns a model may judge: the insights block's, restated", () => {
    expect(JUDGED_CONCERNS).toEqual(WORD_CONCERNS);
  });
});

describe("vocabulary: --out", () => {
  it("writes the artifact beside the report, and confirms on stderr", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-")), "vocabulary.json");
    const { io, code } = vocabularyTo({ out: path, weights: { qualifier: 0 } });
    expect(code).toBe(EXIT.OK);
    expect(rows(io.stdout()).length).toBeGreaterThan(0);
    const graph = buildGraph(loadModels(readModelFileSync(FIXTURE), { sources: [FIXTURE] }).union);
    const weights = { module: 8, type: 8, attribute: 4, operation: 3, parameter: 1, local: 1, other: 1, qualifier: 0 };
    expect(io.files().get(path)).toBe(vocabularyToJsonString(buildVocabulary(graph, { weights })));
    expect(io.stderr()).toMatch(/wrote \d+ bytes to .*vocabulary\.json \(vocabulary, view all, 85 terms, 23 scopes\)\./u);
  });
});

describe("vocabulary: --svg", () => {
  const graph = buildGraph(loadModels(readModelFileSync(FIXTURE), { sources: [FIXTURE] }).union);
  const artifact = buildVocabulary(graph);
  const svgPath = (): string => join(mkdtempSync(join(tmpdir(), "codegraph-cli-vocabulary-")), "cloud.svg");

  it("draws the corpus cloud beside the report, and confirms on stderr", () => {
    const path = svgPath();
    const { io, code } = vocabularyTo({ svg: path });
    expect(code).toBe(EXIT.OK);
    expect(rows(io.stdout()).length).toBe(40);
    expect(io.files().get(path)).toBe(vocabularyCloudSvg(artifact, artifact.scopes[0]!));
    expect(io.stderr()).toMatch(/wrote \d+ bytes to .*cloud\.svg \(cloud of corpus src: 40 of 73 domain terms\)\./u);
  });

  it("draws the scope --scope names, with the class and the top it is given", () => {
    const path = svgPath();
    const { io } = vocabularyTo({ svg: path, scope: ABSTRACT_ORDER, termClass: "all", top: 3 });
    const scope = artifact.scopes.find((candidate) => candidate.id === ABSTRACT_ORDER)!;
    expect(io.files().get(path)).toBe(vocabularyCloudSvg(artifact, scope, { termClass: "all", top: 3 }));
    expect(io.stderr()).toContain("(cloud of type AbstractOrder: 3 of 5 terms).");
  });

  it("draws an operation counted on demand", () => {
    const path = svgPath();
    const { io } = vocabularyTo({ svg: path, scope: `${ABSTRACT_ORDER}.price()` });
    const scope = operationScope(graph, artifact, `${ABSTRACT_ORDER}.price()`, {})!;
    expect(io.files().get(path)).toBe(vocabularyCloudSvg(artifact, scope));
    expect(io.stderr()).toContain("(cloud of operation price: 1 domain term).");
  });
});

describe("vocabulary: through the real dispatcher", () => {
  it("runs from argv", () => {
    const io = captureIo();
    expect(run(["vocabulary", FIXTURE, "--no-cache", "--top", "1"], io)).toBe(EXIT.OK);
    expect(rows(io.stdout())).toEqual([["order", "domain", "40", "12", "12", "3", "4"]]);
  });

  it("reports a usage error raised by the command with exit 2", () => {
    const io = captureIo();
    expect(run(["vocabulary", FIXTURE, "--no-cache", "--scope", "nope"], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("codegraph: unknown scope 'nope'");
  });

  it("appears in the global help", () => {
    const io = captureIo();
    expect(run(["--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("vocabulary");
  });
});
