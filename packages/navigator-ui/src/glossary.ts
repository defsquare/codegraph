import { noStore, rememberedLookup, type Fetcher } from "./lookup.js";

export type { Fetcher } from "./lookup.js";

/**
 * WHAT THE EXPLANATIONS SAY A WORD MEANS, under the Vocabulary tab's clicked
 * word (PLAN.md §20.3): `glossary.json?term=…&scope=…`, the entries of the
 * explained entities under the tab's scope, looked up in the store
 * `insight.json` reads.
 *
 * RESTATED, NOT IMPORTED, as `insight.ts` restates its answer: the kind is a
 * literal pinned to `@codegraph/insights`' by `glossary.test.ts`, and the
 * shapes are this page's own. QUIET BY DESIGN: no store, no such route, an
 * answer this page cannot read — all are `none`, and the tab shows the counts
 * and the carriers as it did before explanations had words.
 */
export const GLOSSARY_ANSWER_KIND = "codegraph.glossary/1";

/** One explained entity's entry for the word: what its model judged it to mean there. */
export interface GlossaryWord {
  readonly id: string;
  readonly level: string;
  readonly kind: string;
  readonly name: string | undefined;
  readonly model: string | undefined;
  /** A member's type, else its module: the node a page reveals for it. */
  readonly owner?: string;
  readonly entry: {
    readonly word: string;
    /** The identifiers of the entity the word is in. */
    readonly in: readonly string[];
    readonly concern: string;
    readonly sense: string;
    readonly confidence: number;
  };
}

/** A module's reconciliation of what its types said of the word. */
export interface ModuleGloss {
  readonly id: string;
  readonly name: string | undefined;
  readonly model: string | undefined;
  readonly entry: {
    readonly word: string;
    readonly concern: string;
    readonly sense: string;
    readonly meaning: string;
    readonly polysemous: boolean;
    readonly senses: readonly { readonly in: string; readonly sense: string }[];
  };
}

export type Glossary =
  | { readonly status: "none" }
  /** The server does not know this scope: it was built from another model. */
  | { readonly status: "unknown" }
  | {
      readonly status: "found";
      readonly term: string;
      readonly total: { readonly entries: number; readonly glossary: number };
      readonly entries: readonly GlossaryWord[];
      readonly glossary: readonly ModuleGloss[];
      /** Records explained before words were asked (prompt 1): what no answer can show. */
      readonly withoutWords: number;
    };

const NONE: Glossary = { status: "none" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isWord(value: unknown): value is GlossaryWord {
  if (!isObject(value) || !isString(value["id"]) || !isString(value["level"]) || !isObject(value["entry"])) return false;
  const entry = value["entry"];
  return isString(entry["word"]) && Array.isArray(entry["in"]) && isString(entry["concern"]) && isString(entry["sense"]) && isNumber(entry["confidence"]);
}

function isGloss(value: unknown): value is ModuleGloss {
  if (!isObject(value) || !isString(value["id"]) || !isObject(value["entry"])) return false;
  const entry = value["entry"];
  return isString(entry["word"]) && isString(entry["concern"]) && isString(entry["sense"]) && isString(entry["meaning"]) && Array.isArray(entry["senses"]);
}

/** Structural, and never a throw: an entry this page cannot show is dropped, an answer it cannot read is `none`. */
export function parseGlossaryAnswer(json: unknown): Glossary {
  if (!isObject(json) || json["kind"] !== GLOSSARY_ANSWER_KIND) return NONE;
  if (json["status"] === "unknown-scope") return { status: "unknown" };
  const total = json["total"];
  if (json["status"] !== "found" || !isString(json["term"]) || !Array.isArray(json["entries"]) || !Array.isArray(json["glossary"])) return NONE;
  if (!isObject(total) || !isNumber(total["entries"]) || !isNumber(total["glossary"])) return NONE;
  return {
    status: "found",
    term: json["term"],
    total: { entries: total["entries"], glossary: total["glossary"] },
    entries: (json["entries"] as unknown[]).filter(isWord),
    glossary: (json["glossary"] as unknown[]).filter(isGloss),
    withoutWords: isNumber(json["withoutWords"]) ? json["withoutWords"] : 0,
  };
}

export interface GlossaryQuery {
  readonly term: string;
  /** A module's or a type's id; absent for the corpus. */
  readonly scope: string | undefined;
}

export interface GlossaryLoader {
  load(query: GlossaryQuery): Promise<Glossary>;
}

export function glossaryUrl(query: GlossaryQuery): string {
  const params = new URLSearchParams({ term: query.term });
  if (query.scope !== undefined) params.set("scope", query.scope);
  return `glossary.json?${params.toString()}`;
}

/** One request per (scope, term), shared and remembered; quiet where the server has no such route. */
export function createGlossaryLoader(fetcher: Fetcher = noStore): GlossaryLoader {
  const ask = rememberedLookup(parseGlossaryAnswer, NONE, fetcher);
  return { load: (query) => ask(glossaryUrl(query)) };
}
