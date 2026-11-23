import { typesDisagree } from "./glossary.js";
import { noStore, rememberedLookup, type Fetcher } from "./lookup.js";

export type { Fetcher } from "./lookup.js";

/**
 * A SELECTED NODE'S EXPLANATION — what `codegraph explain` wrote about it,
 * asked of the server the page came from (`insight.json?id=…`, the one route
 * of `codegraph serve` that is a lookup and not an artifact: tens of megabytes
 * of prose do not belong in navigator.json).
 *
 * QUIET BY DESIGN. Explanations are an extra. No store, no such route (the
 * app daemon, a static host, the Vite dev server), an id nobody explained, a
 * dropped connection — every one of them is `none`, and a page with no
 * explanations looks exactly as it did before this existed.
 *
 * THE SHAPE IS RESTATED, NOT IMPORTED. `@codegraph/insights` is zod, the
 * analyzer and the SQLite loader; not even a type import may tie the browser
 * bundle to it. The answer's `kind` is a literal here and `insight.test.ts`
 * pins it to the package's constant, as `guard.ts` does for the artifact.
 *
 * A WALK'S ANSWER (PLAN.md §22.5) comes from `serve --insights <model>.N.walk.db`:
 * the same envelope with `walk`, the walk's name, beside the status — told from
 * explain's by that key, never by the block's shape. Its block is read
 * generically (`walkFields`): the page holds no definition, so a field is shown
 * by what its value is.
 */
export const INSIGHT_ANSWER_KIND = "codegraph.insight/1";

/** A generic block's own keys, `@codegraph/insights`' `WALK_BLOCK_KEYS` restated (a test pins them): the rest are the walk's fields. */
export const WALK_BLOCK_KEYS = ["answer", "description", "confidence"] as const;

/** A field's value as shown: text (a scalar, an enum's value, nothing as a dash), a list, or an object's fields by name. */
export type WalkValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly WalkValue[] }
  | { readonly kind: "fields"; readonly fields: readonly WalkField[] };

export interface WalkField {
  readonly name: string;
  readonly value: WalkValue;
}

export type Insight =
  | { readonly status: "none" }
  | {
      readonly status: "explained";
      readonly id: string;
      readonly level: string;
      /** `llm`, or `template` for a trivial member explained with no model call. */
      readonly origin: string;
      readonly model: string | undefined;
      readonly confidence: number | undefined;
      readonly description: string;
      /** A type's domain concept, as the model classified it. */
      readonly concept: string | undefined;
      readonly block: Readonly<Record<string, unknown>>;
    }
  | {
      /** A walk's record: its answer and its fields, not explain's reading. */
      readonly status: "answered";
      readonly id: string;
      readonly walk: string;
      readonly level: string;
      readonly origin: string;
      readonly model: string | undefined;
      readonly confidence: number | undefined;
      readonly answer: string | undefined;
      readonly description: string;
      readonly fields: readonly WalkField[];
    }
  | {
      readonly status: "failed";
      readonly id: string;
      /** The walk that failed it; undefined: explain. */
      readonly walk: string | undefined;
      readonly model: string | undefined;
      readonly attempts: number | undefined;
      readonly reason: string;
    };

const NONE: Insight = { status: "none" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Structural, and never a throw: what cannot be shown is `none`. */
export function parseInsightAnswer(json: unknown): Insight {
  if (!isObject(json) || json["kind"] !== INSIGHT_ANSWER_KIND) return NONE;
  const id = stringOf(json["id"]);
  if (id === undefined) return NONE;
  // Present only on a walk's store; a `walk` that is no name is an answer this page cannot place.
  const walk = json["walk"];
  if (walk !== undefined && typeof walk !== "string") return NONE;
  if (json["status"] === "explained") {
    const record = json["record"];
    if (!isObject(record) || !isObject(record["block"])) return NONE;
    const block = record["block"];
    const description = stringOf(block["description"]);
    if (description === undefined) return NONE;
    if (walk !== undefined) {
      return {
        status: "answered",
        id,
        walk,
        level: stringOf(record["level"]) ?? "",
        origin: stringOf(record["origin"]) ?? "llm",
        model: stringOf(record["model"]),
        confidence: numberOf(block["confidence"]),
        answer: stringOf(block["answer"]),
        description,
        fields: walkFields(block),
      };
    }
    return {
      status: "explained",
      id,
      level: stringOf(record["level"]) ?? "",
      origin: stringOf(record["origin"]) ?? "llm",
      model: stringOf(record["model"]),
      confidence: numberOf(block["confidence"]),
      description,
      concept: stringOf(block["concept"]),
      block,
    };
  }
  if (json["status"] === "failed") {
    const failure = json["failure"];
    if (!isObject(failure) || !isObject(failure["reason"])) return NONE;
    const reason = failure["reason"];
    const status = numberOf(reason["status"]);
    return {
      status: "failed",
      id,
      walk,
      model: stringOf(failure["model"]),
      attempts: numberOf(failure["attempts"]),
      reason: `${stringOf(reason["kind"]) ?? "error"}${status === undefined ? "" : ` ${status}`}: ${stringOf(reason["message"]) ?? ""}`,
    };
  }
  return NONE;
}

export interface InsightLoader {
  load(id: string): Promise<Insight>;
}

/** One request per id, shared by concurrent askers and remembered; quiet where the server has no such route. */
export function createInsightLoader(fetcher: Fetcher = noStore): InsightLoader {
  const ask = rememberedLookup(parseInsightAnswer, NONE, fetcher);
  return { load: (id) => ask(`insight.json?id=${encodeURIComponent(id)}`) };
}

export interface BlockFact {
  readonly label: string;
  readonly values: readonly string[];
}

/** Shown in the panel's header already, or the text itself. */
const NOT_A_FACT: ReadonlySet<string> = new Set(["name", "description", "confidence", "concept"]);

const labelOf = (key: string): string => key.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number") return String(value);
  if (value === true) return "yes";
  return undefined;
}

/** `head — second (rest, …)`; a transition reads `from → to (operation)`. */
function objectText(value: Record<string, unknown>): string | undefined {
  const parts = Object.entries(value).flatMap(([, part]) => {
    if (Array.isArray(part)) {
      const items = part.map(scalarText).filter((item): item is string => item !== undefined);
      return items.length === 0 ? [] : [items.join(", ")];
    }
    const text = scalarText(part);
    return text === undefined ? [] : [text];
  });
  if (parts.length === 0) return undefined;
  const [head = "", second, ...rest] = parts;
  if ("from" in value && "to" in value && second !== undefined) return `${head} → ${second}${rest.length === 0 ? "" : ` (${rest.join(", ")})`}`;
  return `${head}${second === undefined ? "" : ` — ${second}`}${rest.length === 0 ? "" : ` (${rest.join(", ")})`}`;
}

function valuesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = isObject(item) ? objectText(item) : scalarText(item);
      return text === undefined ? [] : [text];
    });
  }
  if (isObject(value)) {
    // An object OF lists (a state machine) is listed field by field; an object of scalars is one line.
    if (!Object.values(value).some(Array.isArray)) {
      const text = objectText(value);
      return text === undefined ? [] : [text];
    }
    return Object.entries(value).flatMap(([key, part]) => {
      const items = valuesOf(part);
      if (items.length === 0) return [];
      return Array.isArray(part) && part.every((item) => !isObject(item)) ? [`${labelOf(key)}: ${items.join(", ")}`] : items;
    });
  }
  const text = scalarText(value);
  return text === undefined ? [] : [text];
}

/** `order (domain) — a customer's request. Its meaning.` — the head of a word entry and of a glossary entry alike. */
function definitionText(item: Record<string, unknown>): string | undefined {
  const [word, concern, sense, meaning] = ["word", "concern", "sense", "meaning"].map((key) => stringOf(item[key]));
  if (word === undefined || concern === undefined || sense === undefined) return undefined;
  return `${word} (${concern}) — ${sense}.${meaning === undefined || meaning === "" ? "" : ` ${meaning}`}`;
}

/**
 * THE GLOSSARY'S TWO SHAPES (M19c), read by name: generically, a word entry
 * put the identifiers it is in where a definition reads, and a glossary entry
 * lost the types that disagree on it. An item of any other shape falls back.
 */
const DEFINED: Readonly<Record<string, (item: Record<string, unknown>) => string | undefined>> = {
  words(item) {
    const head = definitionText(item);
    const inside = item["in"];
    const confidence = numberOf(item["confidence"]);
    if (head === undefined || !Array.isArray(inside) || confidence === undefined) return undefined;
    const names = inside.filter((name): name is string => typeof name === "string");
    return `${head} In ${names.join(", ")} · ${confidence.toFixed(2)}`;
  },
  glossary(item) {
    const head = definitionText(item);
    const senses = item["senses"];
    if (head === undefined || !Array.isArray(senses)) return undefined;
    const disagree = senses.flatMap((s) => (isObject(s) && typeof s["in"] === "string" && typeof s["sense"] === "string" ? [`${s["in"]} — ${s["sense"]}`] : []));
    return typesDisagree({ polysemous: item["polysemous"], senses }) ? `${head} Its types disagree: ${disagree.join("; ")}` : head;
  },
};

/**
 * The block as a list of facts, GENERICALLY: its shape moves with the prompt
 * version and differs per level, and a panel that named fields would lag every
 * change. What says nothing — null, empty, false — is dropped. The glossary's
 * two lists are the exception (`DEFINED`).
 */
export function blockFacts(block: Readonly<Record<string, unknown>>): BlockFact[] {
  return Object.entries(block).flatMap(([key, value]) => {
    if (NOT_A_FACT.has(key)) return [];
    const defined = Object.hasOwn(DEFINED, key) ? DEFINED[key] : undefined;
    const values =
      defined !== undefined && Array.isArray(value)
        ? value.flatMap((item) => {
            const text = isObject(item) ? (defined(item) ?? objectText(item)) : scalarText(item);
            return text === undefined ? [] : [text];
          })
        : valuesOf(value);
    return values.length === 0 ? [] : [{ label: labelOf(key), values }];
  });
}

const SHOWN_APART: ReadonlySet<string> = new Set(WALK_BLOCK_KEYS);

/** A value as what it is: nothing (null, an empty string) a dash, a boolean or a number its value, a list each item, an object its fields. */
function walkValue(value: unknown): WalkValue {
  if (Array.isArray(value)) return { kind: "list", items: value.map(walkValue) };
  if (isObject(value)) return { kind: "fields", fields: Object.entries(value).map(([name, part]) => ({ name, value: walkValue(part) })) };
  if (value === null || value === undefined || value === "") return { kind: "text", text: "—" };
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number" || typeof value === "boolean") return { kind: "text", text: String(value) };
  return { kind: "text", text: JSON.stringify(value) };
}

/**
 * A walk's block as its FIELDS, by name, in block order — the order the walk
 * wrote them — less its own keys (answer, description, confidence), which the
 * panel shows apart. Nothing is dropped: `false` is an answer.
 */
export function walkFields(block: Readonly<Record<string, unknown>>): WalkField[] {
  return Object.entries(block).flatMap(([name, value]) => (SHOWN_APART.has(name) ? [] : [{ name, value: walkValue(value) }]));
}
