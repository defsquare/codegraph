import type { EntityId } from "@codegraph/core";
import { folderFor, type CodeGraph, type View } from "@codegraph/analyzer";
import { GLOSSARY_ANSWER_KIND, answerGlossary, type GlossaryAnswer, type Place, type Placement } from "@codegraph/insights";
import type { LookupAnswer, StoreReader } from "./insight-route.js";

/**
 * `/glossary.json?term=…[&scope=…][&limit=…]` — the third lookup of `codegraph
 * serve` (PLAN.md §20.3): what the explained entities under a scope said a
 * word means, from the store's `insight_word` projection, through the same
 * reader as `/insight.json`. The answer is `@codegraph/insights`'; which
 * entities are under a scope is the model's, by the fold the vocabulary counts
 * with, so a word's carriers and its glossary are of the same entities.
 *
 * QUIET LIKE `/insight.json`: no store, or one this build must not read, is a
 * 404 the page ignores. An unknown scope is 404, as on `/carriers.json`; a
 * request that cannot be asked — no term, a limit that is no whole number —
 * is 400.
 *
 * THE PLACEMENT IS BUILT AT THE FIRST REQUEST A STORE CAN ANSWER, reading
 * every kept entity once; the function that builds it (and the graph it
 * holds) is then dropped.
 */

export const GLOSSARY_ROUTE = "/glossary.json";

const USAGE = "glossary.json needs ?term=<word>, and takes &scope=<module or type id>&limit=<n>";

export interface GlossaryLookup {
  handle(query: URLSearchParams): LookupAnswer;
}

export function glossaryLookup(reader: StoreReader, build: () => Placement): GlossaryLookup {
  let pending: (() => Placement) | undefined = build;
  let placement: Placement | undefined;

  return {
    handle(query) {
      const term = query.get("term");
      const limit = query.get("limit");
      if (term === null || term === "") return refused(USAGE);
      if (limit !== null && !/^\d+$/u.test(limit)) return refused(`glossary.json: a limit is a whole number >= 0, not ${JSON.stringify(limit)}`);

      const store = reader.get();
      if (store === undefined) return answered({ kind: GLOSSARY_ANSWER_KIND, status: "no-store" });
      if (placement === undefined && pending !== undefined) {
        placement = pending();
        pending = undefined;
      }
      const scope = query.get("scope");
      return answered(
        answerGlossary(
          store,
          { term, ...(scope === null || scope === "" ? {} : { scope }), ...(limit === null ? {} : { limit: Number(limit) }) },
          placement as Placement,
        ),
      );
    },
  };
}

/**
 * Where the model folds each kept entity — the vocabulary's rule: a non-stub
 * entity the view keeps, under its containing module and type. Entities that
 * share a place share its object.
 */
export function modelPlacement(graph: CodeGraph, view: View): Placement {
  const folder = folderFor(graph);
  const shared = new Map<string, Place>();
  const places = new Map<EntityId, Place>();
  for (const id of graph.ids()) {
    const entity = graph.entity(id);
    if (entity === undefined || graph.isStub(id) || !view.entity(entity, graph)) continue;
    const module = folder.containingModule(id);
    const type = folder.containingType(id);
    const key = `${module ?? ""}\u0000${type ?? ""}`;
    let place = shared.get(key);
    if (place === undefined) {
      place = { ...(module === undefined ? {} : { module }), ...(type === undefined ? {} : { type }) };
      shared.set(key, place);
    }
    places.set(id, place);
  }
  return (id) => places.get(id);
}

function answered(answer: GlossaryAnswer): LookupAnswer {
  return { status: answer.status === "found" ? 200 : 404, body: JSON.stringify(answer) };
}

function refused(error: string): LookupAnswer {
  return { status: 400, body: JSON.stringify({ error }) };
}
