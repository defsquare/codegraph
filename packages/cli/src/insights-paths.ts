import { existsSync } from "node:fs";
import { loadSqlite } from "@codegraph/analyzer";
import { InsightsStoreError, insightsStorePathFor, sqliteInsightsStore, type InsightsStore } from "@codegraph/insights";
import { UsageError } from "./exit.js";

/**
 * WHERE A MODEL'S INSIGHTS LIVE. `explain` writes them and `insights` reads
 * them; both must agree, and the reader must not import the writer — that
 * module pulls in the provider SDK, which a query has no business loading.
 */

/** `X.jsonl` → `X.insights.jsonl`: the side-car sits beside the model. */
export function sidecarPathFor(modelPath: string): string {
  return modelPath.endsWith(".jsonl") ? `${modelPath.slice(0, -".jsonl".length)}.insights.jsonl` : `${modelPath}.insights.jsonl`;
}

/** `X.jsonl` → `X.insights.db`: the store sits beside the side-car it exports. */
export function storePathForModel(modelPath: string): string {
  return insightsStorePathFor(sidecarPathFor(modelPath));
}

/**
 * A store opened as a READER (`query_only`), or a usage error: a missing one
 * is not created, and one this build must not touch is named and left alone.
 * `flag` is the one that names another store (`--store FILE`).
 */
export function openInsightsReader(path: string, flag: string): InsightsStore {
  // Checked first: opening a path that does not exist would CREATE it, and asking must not leave a file behind.
  if (!existsSync(path)) {
    throw new UsageError(
      `no insights store at ${path}`,
      `'codegraph explain <model.jsonl>' creates it (and imports a side-car it finds there). Pass ${flag} FILE if it is elsewhere.`,
    );
  }
  const db = loadSqlite().open(path);
  try {
    return sqliteInsightsStore(db, { readOnly: true });
  } catch (error) {
    db.close();
    if (!(error instanceof InsightsStoreError)) throw error;
    throw new UsageError(`${path}: ${error.message}`, `Pass ${flag} FILE to read another store.`, { cause: error });
  }
}
