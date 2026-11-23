import { existsSync } from "node:fs";
import { loadSqlite } from "@codegraph/analyzer";
import { INSIGHT_ANSWER_KIND, answerInsight, sqliteStoreReader, type StoreReading } from "@codegraph/insights";

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
 *
 * WHOSE STORE IT IS, ITS HEADER SAYS (PLAN.md §22.5). Explain's is read as
 * explain's; a walk's (`--insights <model>.N.walk.db`) with that walk's reader,
 * and its answers name the walk. An empty store is nobody's yet: it is read as
 * explain's, and opened again at the next request until a header says whose.
 */

export interface LookupAnswer {
  readonly status: number;
  readonly body: string;
}

/** The store the lookups read, opened at the first request that finds it; `/glossary.json` reads the same one. */
export interface StoreReader {
  /** Undefined while there is no store this build may read; `walk` names a walk's. */
  get(): StoreReading | undefined;
  close(): void;
}

export function storeReader(storePath: string): StoreReader {
  let reading: StoreReading | undefined;
  // Opened empty: its walk is not known yet, so it is opened again by the next request.
  let provisional = false;
  return {
    get() {
      if (reading !== undefined && !provisional) return reading;
      reading?.store.close();
      reading = undefined;
      // Checked first: opening a missing path would CREATE it, and a page asking must not leave a file behind.
      if (!existsSync(storePath)) return undefined;
      const db = loadSqlite().open(storePath);
      try {
        reading = sqliteStoreReader(db, undefined);
        provisional = reading.store.isEmpty();
      } catch {
        // Not ours, from a newer build, or from an older one no explain has migrated yet: nothing this page can show.
        // `codegraph insights` says why.
        db.close();
      }
      return reading;
    },
    close() {
      reading?.store.close();
      reading = undefined;
    },
  };
}

export interface InsightLookup {
  handle(query: URLSearchParams): LookupAnswer;
}

export const INSIGHT_ROUTE = "/insight.json";

export function insightLookup(reader: StoreReader): InsightLookup {
  return {
    handle(query) {
      const id = query.get("id");
      if (id === null || id === "") return { status: 400, body: JSON.stringify({ error: "insight.json needs ?id=<entity id>" }) };
      const open = reader.get();
      const answer = open === undefined ? { kind: INSIGHT_ANSWER_KIND, id, status: "unknown" as const } : answerInsight(open.store, id, open.walk);
      return { status: answer.status === "unknown" ? 404 : 200, body: JSON.stringify(answer) };
    },
  };
}
