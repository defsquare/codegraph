import type { Carrier, ScopeRef, TermClass, VocabularyArtifact } from "@codegraph/vocabulary";

/**
 * THE VOCABULARY, AS THE PAGE RECEIVES IT (PLAN.md §20.2): the artifact
 * `codegraph serve` hands out at `vocabulary.json`, and the one lookup behind
 * it, `carriers.json?scope=…&term=…&class=…` — which names carry a word.
 *
 * RESTATED, NOT IMPORTED. `@codegraph/vocabulary`'s index is the analyzer,
 * core, zod and the SQLite loader; this bundle imports it for TYPES only, and
 * the layout through its `./cloud` entry, which imports nothing. The kinds and
 * the class vocabulary are literals here, pinned to the package's own by
 * `vocabulary.test.ts`.
 *
 * QUIET WHEN ABSENT, LOUD WHEN WRONG — the navigator's rule. No route (a
 * dropped file, a static host, the Vite dev server without VOCABULARY_JSON)
 * is `absent`, and the tab says how to get one; bytes that arrive and are no
 * vocabulary say so. The carriers are an extra: the app daemon holds no model
 * and has no such route, and the tab then shows the counts without evidence.
 */
export const VOCABULARY_ARTEFACT_KIND = "codegraph.vocabulary/1";
export const CARRIERS_ANSWER_KIND = "codegraph.carriers/1";
/** In the package's order: what the chips and the key list, and how ties of one text sort. */
export const TERM_CLASSES = ["domain", "technical", "keyword", "short"] as const;

export type Fetcher = (url: string) => Promise<Response>;

const noStore: Fetcher = (url) => fetch(url, { cache: "no-store" });

export type VocabularyLoad =
  | { readonly status: "ready"; readonly artifact: VocabularyArtifact }
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural, as the navigator's guard is: the builder's own suite pins the rows. */
export function parseVocabularyArtifact(json: unknown): VocabularyArtifact | string {
  if (!isObject(json)) return "vocabulary.json is not a vocabulary artifact (not an object).";
  if (json["kind"] !== VOCABULARY_ARTEFACT_KIND) {
    return `vocabulary.json is not a vocabulary artifact (kind ${JSON.stringify(json["kind"] ?? "missing")}, expected "${VOCABULARY_ARTEFACT_KIND}").`;
  }
  for (const key of ["terms", "scopes", "classes", "langs"]) {
    if (!Array.isArray(json[key])) return `this vocabulary artifact is missing its '${key}' array.`;
  }
  for (const key of ["weights", "technical", "view", "corpus"]) {
    if (!isObject(json[key])) return `this vocabulary artifact is missing its '${key}'.`;
  }
  if ((json["scopes"] as unknown[]).length === 0) return "this vocabulary artifact has no scope, not even the corpus.";
  return json as unknown as VocabularyArtifact;
}

/** The page's sibling `vocabulary.json` — RELATIVE, so the app daemon's `/<token>/` holds too. */
export async function loadVocabulary(fetcher: Fetcher = noStore): Promise<VocabularyLoad> {
  let response: Response;
  try {
    response = await fetcher("vocabulary.json");
  } catch {
    return { status: "absent" };
  }
  if (!response.ok) return { status: "absent" };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // index.html from a host that answers every path: no such artifact here.
    return { status: "absent" };
  }
  const parsed = parseVocabularyArtifact(json);
  return typeof parsed === "string" ? { status: "error", message: parsed } : { status: "ready", artifact: parsed };
}

export type Carriers =
  /** No such route, or an answer this page cannot read: nothing to show, said once. */
  | { readonly status: "none" }
  /** The server holds the model and does not know this scope or term — another build. */
  | { readonly status: "unknown" }
  | {
      readonly status: "found";
      readonly scope: ScopeRef;
      readonly term: { readonly text: string; readonly class: TermClass };
      readonly weight: number;
      readonly occurrences: number;
      readonly total: number;
      readonly carriers: readonly Carrier[];
    };

const NONE: Carriers = { status: "none" };

/** Structural, and never a throw. */
export function parseCarriersAnswer(json: unknown): Carriers {
  if (!isObject(json) || json["kind"] !== CARRIERS_ANSWER_KIND) return NONE;
  if (json["status"] === "unknown-scope" || json["status"] === "unknown-term") return { status: "unknown" };
  if (json["status"] !== "found" || !Array.isArray(json["carriers"]) || !isObject(json["term"]) || !isObject(json["scope"])) return NONE;
  const numbers = ["weight", "occurrences", "total"].map((key) => json[key]);
  if (!numbers.every((value) => typeof value === "number")) return NONE;
  const carriers = (json["carriers"] as unknown[]).filter(
    (carrier): carrier is Carrier => isObject(carrier) && typeof carrier["name"] === "string" && typeof carrier["weight"] === "number",
  );
  const [weight, occurrences, total] = numbers as [number, number, number];
  return {
    status: "found",
    scope: json["scope"] as unknown as ScopeRef,
    term: json["term"] as unknown as { text: string; class: TermClass },
    weight,
    occurrences,
    total,
    carriers,
  };
}

export interface CarriersQuery {
  /** A module's or a type's id; absent for the corpus. */
  readonly scope: string | undefined;
  readonly term: string;
  readonly class: TermClass;
}

export interface CarriersLoader {
  load(query: CarriersQuery): Promise<Carriers>;
}

export function carriersUrl(query: CarriersQuery): string {
  const params = new URLSearchParams({ term: query.term, class: query.class });
  if (query.scope !== undefined) params.set("scope", query.scope);
  return `carriers.json?${params.toString()}`;
}

/**
 * One request per (scope, term, class), shared and remembered. A server that
 * answers with something that is not JSON — the daemon's bare 404, index.html
 * — has no such route: asked once, not once per click.
 */
export function createCarriersLoader(fetcher: Fetcher = noStore): CarriersLoader {
  const asked = new Map<string, Promise<Carriers>>();
  let noRoute = false;

  const ask = async (query: CarriersQuery): Promise<Carriers> => {
    try {
      const response = await fetcher(carriersUrl(query));
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        noRoute = true;
        return NONE;
      }
      return parseCarriersAnswer(json);
    } catch {
      return NONE;
    }
  };

  return {
    load(query) {
      if (noRoute) return Promise.resolve(NONE);
      const key = carriersUrl(query);
      let pending = asked.get(key);
      if (pending === undefined) {
        pending = ask(query);
        asked.set(key, pending);
      }
      return pending;
    },
  };
}
