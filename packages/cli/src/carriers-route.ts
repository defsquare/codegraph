import { TERM_CLASSES, type CarrierIndex, type CarriersAnswer, type TermClass } from "@codegraph/vocabulary";
import type { LookupAnswer } from "./insight-route.js";

/**
 * `/carriers.json?term=…[&scope=…][&class=…][&limit=…]` — the second lookup
 * of `codegraph serve` (PLAN.md §20.2): which names of a stored scope carry a
 * word, each with what it added to the row. The vocabulary artifact counts
 * and never lists, so the evidence is asked for one row at a time, answered by
 * `@codegraph/vocabulary`'s carrier index over the model the server holds.
 *
 * No scope is the corpus. An unknown scope or term is 404, as an unknown id is
 * on `/insight.json`; a request that cannot be asked — no term, a class that
 * is none, a limit that is no whole number — is 400, and so is a text the
 * scope speaks as two terms, with the classes to choose from.
 *
 * THE INDEX IS BUILT AT THE FIRST ANSWERABLE REQUEST, reading every kept
 * entity once; the function that builds it (and the graph it holds) is then
 * dropped, so a page nobody clicks costs nothing and a clicked one holds the
 * index alone.
 */

export const CARRIERS_ROUTE = "/carriers.json";

const USAGE = "carriers.json needs ?term=<word>, and takes &scope=<module or type id>&class=<class>&limit=<n>";

export interface CarriersLookup {
  handle(query: URLSearchParams): LookupAnswer;
}

export function carriersLookup(build: () => CarrierIndex): CarriersLookup {
  let pending: (() => CarrierIndex) | undefined = build;
  let index: CarrierIndex | undefined;

  return {
    handle(query) {
      const term = query.get("term");
      const termClass = query.get("class");
      const limit = query.get("limit");
      if (term === null || term === "") return refused(USAGE);
      if (termClass !== null && !(TERM_CLASSES as readonly string[]).includes(termClass)) {
        return refused(`carriers.json: no class ${JSON.stringify(termClass)}; the classes are ${TERM_CLASSES.join(", ")}`);
      }
      if (limit !== null && !/^\d+$/u.test(limit)) return refused(`carriers.json: a limit is a whole number >= 0, not ${JSON.stringify(limit)}`);

      if (index === undefined && pending !== undefined) {
        index = pending();
        pending = undefined;
      }
      const scope = query.get("scope");
      const answer = (index as CarrierIndex).answer({
        term,
        ...(scope === null || scope === "" ? {} : { scope }),
        ...(termClass === null ? {} : { class: termClass as TermClass }),
        ...(limit === null ? {} : { limit: Number(limit) }),
      });
      return { status: statusOf(answer), body: JSON.stringify(answer) };
    },
  };
}

function statusOf(answer: CarriersAnswer): number {
  switch (answer.status) {
    case "found":
      return 200;
    case "ambiguous":
      return 400;
    case "unknown-scope":
    case "unknown-term":
      return 404;
  }
}

function refused(error: string): LookupAnswer {
  return { status: 400, body: JSON.stringify({ error }) };
}
