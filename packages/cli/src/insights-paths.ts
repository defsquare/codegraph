import { existsSync } from "node:fs";
import { loadSqlite } from "@codegraph/analyzer";
import {
  EXPLAIN_WALK_NAME,
  InsightsStoreError,
  WalkMismatchError,
  insightsStorePathFor,
  sqliteInsightsStore,
  sqliteStoreReader,
  type InsightsStore,
  type StoreReading,
} from "@codegraph/insights";
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
  if (!existsSync(path)) throw noStore(path, flag);
  const db = loadSqlite().open(path);
  try {
    return sqliteInsightsStore(db, { readOnly: true });
  } catch (error) {
    db.close();
    if (!(error instanceof InsightsStoreError)) throw error;
    throw new UsageError(`${path}: ${error.message}`, `Pass ${flag} FILE to read another store.`, { cause: error });
  }
}

function noStore(path: string, flag: string): UsageError {
  return new UsageError(
    `no insights store at ${path}`,
    `'codegraph explain <model.jsonl>' creates it (and imports a side-car it finds there). Pass ${flag} FILE if it is elsewhere.`,
  );
}

/**
 * A store opened as a READER of the walk `walk` — "explain" for explain's, exactly `openInsightsReader` — or, `walk`
 * undefined, of whichever walk its header names (`--store FILE`): explain's, or a walk's read as stored, with no
 * definition (`walkReader`). The same refusals, the store's words, nothing written; a walk's are named as the walk's.
 */
export function openStoreReader(path: string, walk: string | undefined, flag: string): StoreReading {
  const named = walk !== undefined && walk !== EXPLAIN_WALK_NAME;
  if (!existsSync(path)) {
    if (!named) throw noStore(path, flag);
    throw new UsageError(
      `no store of the walk "${walk}" at ${path}`,
      `'codegraph walk <model.jsonl> --name ${walk}' (or a --walk FILE naming it) creates it. Pass ${flag} FILE if it is elsewhere.`,
    );
  }
  const db = loadSqlite().open(path);
  try {
    return sqliteStoreReader(db, walk);
  } catch (error) {
    db.close();
    if (!(error instanceof InsightsStoreError)) throw error;
    const hint =
      named && error instanceof WalkMismatchError
        ? `Each walk keeps its own store (explain's is <model>.insights.db, a walk N's <model>.N.walk.db): --walk NAME reads N's, ${flag} FILE whichever walk's a file is.`
        : `Pass ${flag} FILE to read another store.`;
    throw new UsageError(`${path}: ${error.message}`, hint, { cause: error });
  }
}
