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
 */
export const INSIGHT_ANSWER_KIND = "codegraph.insight/1";

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
  | { readonly status: "failed"; readonly id: string; readonly model: string | undefined; readonly attempts: number | undefined; readonly reason: string };

const NONE: Insight = { status: "none" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Structural, and never a throw: what cannot be shown is `none`. */
export function parseInsightAnswer(json: unknown): Insight {
  if (!isObject(json) || json["kind"] !== INSIGHT_ANSWER_KIND) return NONE;
  const id = stringOf(json["id"]);
  if (id === undefined) return NONE;
  if (json["status"] === "explained") {
    const record = json["record"];
    if (!isObject(record) || !isObject(record["block"])) return NONE;
    const block = record["block"];
    const description = stringOf(block["description"]);
    if (description === undefined) return NONE;
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
      model: stringOf(failure["model"]),
      attempts: numberOf(failure["attempts"]),
      reason: `${stringOf(reason["kind"]) ?? "error"}${status === undefined ? "" : ` ${status}`}: ${stringOf(reason["message"]) ?? ""}`,
    };
  }
  return NONE;
}

export type Fetcher = (url: string) => Promise<Response>;

export interface InsightLoader {
  load(id: string): Promise<Insight>;
}

/**
 * One request per id, shared by concurrent askers and remembered. A server
 * that answers the route with something that is not JSON (index.html, from a
 * dev server or a static host) has no such route: it is asked once, not once
 * per click.
 */
export function createInsightLoader(fetcher: Fetcher = (url) => fetch(url, { cache: "no-store" })): InsightLoader {
  const asked = new Map<string, Promise<Insight>>();
  let noRoute = false;

  const ask = async (id: string): Promise<Insight> => {
    try {
      // RELATIVE: under the app daemon the page lives at /<token>/, and so must this.
      const response = await fetcher(`insight.json?id=${encodeURIComponent(id)}`);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        noRoute = true;
        return NONE;
      }
      return parseInsightAnswer(json);
    } catch {
      return NONE;
    }
  };

  return {
    load(id) {
      if (noRoute) return Promise.resolve(NONE);
      let pending = asked.get(id);
      if (pending === undefined) {
        pending = ask(id);
        asked.set(id, pending);
      }
      return pending;
    },
  };
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

/**
 * The block as a list of facts, GENERICALLY: its shape moves with the prompt
 * version and differs per level, and a panel that named fields would lag every
 * change. What says nothing — null, empty, false — is dropped.
 */
export function blockFacts(block: Readonly<Record<string, unknown>>): BlockFact[] {
  return Object.entries(block).flatMap(([key, value]) => {
    if (NOT_A_FACT.has(key)) return [];
    const values = valuesOf(value);
    return values.length === 0 ? [] : [{ label: labelOf(key), values }];
  });
}
