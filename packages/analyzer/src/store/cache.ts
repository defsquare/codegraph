/**
 * THE AUTOMATIC CACHE (PLAN.md §9.3).
 *
 * `codegraph import` is explicit and unconditional. This is the other half: a
 * command handed a `.jsonl` builds the sibling `.db` if it needs to, reuses it
 * if it can, and must be right about which — without being asked.
 *
 * MIGRATION IS REGENERATION. There is no ALTER path and never will be: the
 * database holds nothing the model does not already say, so a `dbVersion` that
 * does not match this build's is not a schema to upgrade, it is a file to throw
 * away. The same goes for a store that will not open at all.
 *
 * STALENESS IS SIZE AND MTIME, not a content hash. Hashing 133MB costs more
 * than the parse the cache exists to avoid, which would make the check more
 * expensive than the miss. The trade is stated rather than hidden: a model
 * rewritten within the filesystem's timestamp resolution AND to exactly the
 * same byte count would be missed. Every real edit changes one or the other,
 * and `--no-cache` is the escape hatch for anyone who does not want to rely on
 * that.
 *
 * FAILING TO CACHE IS NOT FAILING. A read-only directory, a full disk, a store
 * written by a future version — none of them are reasons to refuse the user an
 * answer. Every one of them degrades to reading the `.jsonl`, which is the
 * contract and always works.
 */

import { statSync } from "node:fs";

import { DB_VERSION, STORE_OPEN_OPTIONS } from "./schema.js";
import { importModel, openStore, storePathFor } from "./import.js";
import { loadSqlite, type SqliteDatabase } from "./sqlite.js";

/** Why a store could not be reused — or that it can. */
export type CacheState =
  /** Present, current, and describing this exact model file. */
  | "fresh"
  /** No store beside the model yet. */
  | "missing"
  /** The model changed after the store was built. */
  | "stale"
  /** Built by a different version of the schema; regenerate, never migrate. */
  | "version"
  /** Present but unreadable — corrupt, truncated, or not a database at all. */
  | "unreadable";

export interface CacheStatus {
  readonly state: CacheState;
  /** Where the store is, or would be. */
  readonly path: string;
  /** One clause, for the note a command puts on stderr. */
  readonly reason: string;
}

/**
 * Can the store beside `jsonlPath` answer for it?
 *
 * Opens the candidate read-only and asks it about itself. Nothing here trusts
 * the file NAME: a `.db` sitting next to a model proves nothing, and the meta
 * row it carries is what says which model it was built from.
 */
export function cacheStatus(jsonlPath: string, dbPath = storePathFor(jsonlPath)): CacheStatus {
  const at = (state: CacheState, reason: string): CacheStatus => ({ state, path: dbPath, reason });

  let source: ReturnType<typeof statSync>;
  try {
    source = statSync(jsonlPath);
  } catch {
    // The model itself is unreadable; that is the caller's problem to report,
    // not a cache verdict. Say "missing" so nothing tries to reuse a store.
    return at("missing", "the model could not be read");
  }

  let db: SqliteDatabase;
  try {
    // `readOnly` is what refuses to create a missing file. NOT `open: false`,
    // which means "construct the handle but defer opening" — with it every
    // query below throws, every store reads as unreadable, and the cache
    // rebuilds itself on every single run while looking like it works.
    db = loadSqlite().open(dbPath, { ...STORE_OPEN_OPTIONS, readOnly: true });
  } catch {
    return at("missing", "no store beside the model");
  }

  try {
    const meta = new Map<string, string>();
    for (const row of db.prepare("SELECT key, value FROM meta").iterate()) {
      meta.set(row.key as string, row.value as string);
    }

    const version = Number(meta.get("dbVersion") ?? -1);
    if (version !== DB_VERSION) {
      return at("version", `built for store version ${version}, this build reads ${DB_VERSION}`);
    }
    if (meta.get("sourceBytes") !== String(source.size)) {
      return at("stale", "the model has changed size since the store was built");
    }
    if (meta.get("sourceMtimeMs") !== String(source.mtimeMs)) {
      return at("stale", "the model has been modified since the store was built");
    }
    return at("fresh", "reused");
  } catch {
    // Corrupt, truncated, or a `.db` that is not one of ours.
    return at("unreadable", "the store could not be read");
  } finally {
    try {
      db.close();
    } catch {
      // Nothing to do: we were only ever reading it.
    }
  }
}

export interface OpenedCache {
  readonly db: SqliteDatabase;
  readonly path: string;
  /** True when this call built the store rather than reusing one. */
  readonly built: boolean;
  /** Why it was built, when it was — the `CacheStatus.reason` that forced it. */
  readonly reason: string;
  /** Wall time spent importing; 0 when the store was reused. */
  readonly buildMs: number;
}

/** What `openCache` found, and — when it found nothing — why. */
export interface CacheAttempt {
  /** The store, ready to query. Undefined when there is none to use. */
  readonly store: OpenedCache | undefined;
  /** One clause naming what happened, for the note a command puts on stderr. */
  readonly reason: string;
}

/**
 * The store for `jsonlPath`, built if it has to be.
 *
 * NEVER THROWS FOR THE MODEL'S SAKE. A `.jsonl` the record reader refuses is a
 * FINDING about that file, and the reading path already knows how to say so —
 * with the reader's own message, the failing line, and exit 3. Turning it into
 * an exception here would replace a diagnosis with a crash, and the crash would
 * be blamed on codegraph rather than on the file. So a refused model simply
 * means no cache, and the caller reads it the old way and reports properly.
 *
 * The same is true of every other reason there might be no store: a read-only
 * directory, a full disk, a database from a future version. None of them are
 * reasons to deny the user an answer.
 */
export function openCache(jsonlPath: string, dbPath?: string): CacheAttempt {
  const target = dbPath ?? storePathFor(jsonlPath);
  const status = cacheStatus(jsonlPath, target);

  if (status.state === "fresh") {
    try {
      return {
        store: { db: openStore(target), path: target, built: false, reason: status.reason, buildMs: 0 },
        reason: status.reason,
      };
    } catch {
      return { store: undefined, reason: "the store could not be opened" };
    }
  }

  const started = performance.now();
  try {
    importModel(jsonlPath, target);
  } catch (error) {
    return {
      store: undefined,
      reason:
        error instanceof Error && error.name === "JsonlError"
          ? "the model could not be read"
          : "no store could be written beside the model",
    };
  }
  const buildMs = performance.now() - started;

  try {
    return {
      store: { db: openStore(target), path: target, built: true, reason: status.reason, buildMs },
      reason: status.reason,
    };
  } catch {
    return { store: undefined, reason: "the store could not be opened" };
  }
}
