import { existsSync } from "node:fs";
import { loadSqlite } from "@codegraph/analyzer";
import { INSIGHT_ANSWER_KIND, answerInsight, sqliteInsightsStore, type InsightsStore } from "@codegraph/insights";

/**
 * `/insight.json?id=…` — the ONE dynamic route of `codegraph serve` (PLAN.md
 * §17.3, M16c). Everything else the page loads is an artifact built once; a
 * selected node's explanation cannot be (tens of megabytes of prose do not
 * belong in navigator.json), so it is looked up in the insights store when
 * asked for. The shape of the answer is the insights package's
 * (`answerInsight`); this module opens the store and maps it to HTTP.
 *
 * QUIET BY DESIGN. No store, a store this build must not read, an id nobody
 * explained: all are 404 and the page shows nothing — explanations are an
 * extra, and a model with none must look exactly as it did. Only a request
 * that names no id is the caller's mistake (400).
 *
 * THE STORE IS OPENED WHEN FIRST NEEDED, as a reader, and kept: `explain` may
 * be run while the page is open — WAL lets it write under an open reader — and
 * a store that did not exist when the server started is found once it does.
 */

export interface LookupAnswer {
  readonly status: number;
  readonly body: string;
}

export interface InsightLookup {
  handle(query: URLSearchParams): LookupAnswer;
  close(): void;
}

export const INSIGHT_ROUTE = "/insight.json";

export function insightLookup(storePath: string): InsightLookup {
  let store: InsightsStore | undefined;

  const reader = (): InsightsStore | undefined => {
    if (store !== undefined) return store;
    // Checked first: opening a missing path would CREATE it, and a page asking must not leave a file behind.
    if (!existsSync(storePath)) return undefined;
    const db = loadSqlite().open(storePath);
    try {
      store = sqliteInsightsStore(db, { readOnly: true });
    } catch {
      // Not ours, or from a newer build: nothing this page can show. `codegraph insights` says why.
      db.close();
    }
    return store;
  };

  return {
    handle(query) {
      const id = query.get("id");
      if (id === null || id === "") return { status: 400, body: JSON.stringify({ error: "insight.json needs ?id=<entity id>" }) };
      const open = reader();
      const answer = open === undefined ? { kind: INSIGHT_ANSWER_KIND, id, status: "unknown" as const } : answerInsight(open, id);
      return { status: answer.status === "unknown" ? 404 : 200, body: JSON.stringify(answer) };
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}
