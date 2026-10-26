import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadModels } from "@codegraph/analyzer";
import { buildVocabulary, vocabularyToJsonString } from "@codegraph/vocabulary";
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
    out: undefined,
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
      /^technical: 125 shared words \(sha256 [0-9a-f]{12}\) \+ each language's own$/u,
    );
  });

  it("says what the corpus counted, and how much of the table it shows", () => {
    const lines = io.stdoutLines();
    expect(lines).toContain("corpus src");
    expect(lines).toContain(
      "  152 entities: 127 speak (module 3 · type 19 · operation 43 · attribute 21 · parameter 35 · local 6), 25 unnamed",
    );
    expect(lines).toContain("  85 distinct terms, 75 domain · weight 503 · 146 occurrences");
    expect(lines).toContain("  domain: 40 of 75 terms (--top 40), by weight descending, ties by term");
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
    expect(stdout).toContain("  domain: 2 of 75 terms (--top 2), by weight descending, ties by term");
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
      technical: { words: 125 },
      class: "domain",
      top: 2,
    });
    expect(json.scopes).toHaveLength(1);
    expect(json.scopes[0]).toMatchObject({ level: "corpus", name: "src", distinct: 85, distinctDomain: 75, shown: 2, total: 75 });
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
    expect(io.stdoutLines()).toContain("  77 distinct terms, 68 domain · weight 433 · 126 occurrences");
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
      "code only: 40 of 73 domain words no business term contains (--top 40), by weight descending, ties by term",
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
