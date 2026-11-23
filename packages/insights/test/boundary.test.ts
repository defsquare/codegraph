import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanEnv } from "../src/plan.js";
import { memoryBook, storeBook, type RecordBook, type StoreBook } from "../src/records.js";
import type { InsightsStore } from "../src/store.js";

/**
 * THE SEAM HOLDS (PLAN.md §22.1). The engine reaches what explain decides —
 * the Specy vocabulary, its answer blocks, its templates, its words, its quote
 * rule, its estimate — only through the `WalkSpec` it is handed. So no engine
 * file imports explain's modules or names what they define, and a second walk
 * runs the same engine with nothing of explain in it (walk-spec.test.ts).
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The engine (§22.1), the seam itself, and the selection (§22.3) — a filter is the engine's, never a walk's. */
const ENGINE = ["spec.ts", "plan.ts", "run.ts", "context.ts", "prompt.ts", "records.ts", "fingerprint.ts", "selection.ts"];

/** What builds the walk: filter-blind (§22.3), so a record bought under one filter is reused under any other. */
const WALK_BUILDERS = ["units.ts", "order.ts"];

/** Explain's own modules: the Specy vocabulary, the templates, the built-in spec. */
const EXPLAIN_MODULES = ["ddd", "template", "explain-spec"];

/** What explain defines — there, or beside the record envelope in schema.ts. */
const EXPLAIN_NAMES = [
  // the Specy answer blocks and their schemas
  "ANSWER_BLOCKS", "BLOCKS", "BlockOf", "Block", "OperationBlock", "TypeBlock", "ModuleBlock", "sccResponseSchema", "responseJsonSchema",
  // the Specy vocabulary
  "DOMAIN_CONCEPTS", "CONCEPT_DEFINITIONS", "EVENT_KINDS", "INTERFACE_ROLES", "OPERATION_OWNERS", "ENFORCEMENTS", "SYNC_PATTERNS", "FIELD_KINDS", "INSIGHTS_METAMODEL",
  // the system text, the words, the templates, the quote rule, the estimate, the spec itself
  "systemPrompt", "restateWords", "readsWordsOf", "templateBlock", "conceptLabel", "summaryOf",
  "estimateCompletionTokens", "COMPLETION_TOKENS_PER_BLOCK", "COMPLETION_TOKENS_PER_WORD", "COMPLETION_TOKENS_PER_GLOSSARY_ENTRY", "EXPLAIN_WALK",
];

/** Explain's words in a string the engine would send. */
const EXPLAIN_TEXT = ["Specy", "Domain-Driven"];

const source = (file: string): string => readFileSync(`${SRC}${file}`, "utf8");

/** Code without its comments: a comment may cite explain; code may not reach it. Not a parser — URLs keep their `//`. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
}

function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*)["']\.\/([\w-]+)\.js["']/gu)].map((match) => match[1] ?? "");
}

const named = (text: string, name: string): boolean => new RegExp(`\\b${name}\\b`, "u").test(text);

describe("the walk seam", () => {
  it.each(ENGINE)("%s imports none of explain's modules", (file) => {
    expect(importsOf(source(file)).filter((module) => EXPLAIN_MODULES.includes(module))).toEqual([]);
  });

  it.each(ENGINE)("%s imports no walk definition: a definition compiles INTO a spec, the engine never reads one", (file) => {
    expect(importsOf(source(file))).not.toContain("definition");
    for (const name of ["WalkDefinition", "compileDefinition", "parseWalkDefinition", "customizeExplain"]) expect(named(code(source(file)), name), name).toBe(false);
  });

  it.each(ENGINE)("%s names nothing explain defines, and sends none of its words", (file) => {
    const text = code(source(file));
    expect(EXPLAIN_NAMES.filter((name) => named(text, name))).toEqual([]);
    expect(EXPLAIN_TEXT.filter((word) => text.includes(word))).toEqual([]);
  });

  it.each(WALK_BUILDERS)("%s knows nothing of selections: the walk is built over the whole model", (file) => {
    const text = code(source(file));
    expect(importsOf(source(file))).not.toContain("selection");
    for (const name of ["Selection", "Selector", "inScope", "selects"]) expect(named(text, name), name).toBe(false);
  });

  it("sees what it forbids: explain's spec imports and names it, and the engine's code survives the comment strip", () => {
    const explain = source("explain-spec.ts");
    expect(importsOf(explain)).toEqual(expect.arrayContaining(["ddd", "template"]));
    for (const name of ["ANSWER_BLOCKS", "Block", "templateBlock", "conceptLabel", "systemPrompt", "EXPLAIN_WALK"]) expect(named(code(explain), name), name).toBe(true);
    expect(code(explain)).toContain("Specy");
    expect(named(code(source("plan.ts")), "planRun")).toBe(true);
    expect(named(code(source("run.ts")), "executeRun")).toBe(true);
    expect(importsOf(source("plan.ts"))).toContain("spec");
    expect(importsOf(source("selection.ts"))).toContain("plan");
    expect(named(code(source("selection.ts")), "inScope")).toBe(true);
    expect(importsOf(source("definition.ts"))).toEqual(expect.arrayContaining(["spec", "selection"]));
    expect(named(code(source("definition.ts")), "compileDefinition")).toBe(true);
  });

  it("is required: an env or a book without a spec does not typecheck (`pnpm run typecheck` holds these)", () => {
    const unwired = (env: Omit<PlanEnv, "spec">): PlanEnv =>
      // @ts-expect-error — an env carries its walk; nothing defaults it
      env;
    // @ts-expect-error — a book quotes by its walk's rule; nothing defaults it
    const book = (): RecordBook => memoryBook([]);
    // @ts-expect-error — the store's book likewise
    const store = (s: InsightsStore): StoreBook => storeBook(s);
    expect([unwired, book, store].every((f) => typeof f === "function")).toBe(true);
  });
});
