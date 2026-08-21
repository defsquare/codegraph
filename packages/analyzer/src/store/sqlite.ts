/**
 * The ONE place `node:sqlite` enters this codebase (PLAN.md §9.3).
 *
 * WHY A LOADER FUNCTION AND NOT AN IMPORT. `node:sqlite` is experimental, so
 * loading it prints
 *
 *   (node:1234) ExperimentalWarning: SQLite is an experimental feature ...
 *
 * on stderr, once per process. Several CLI end-to-end tests assert
 * `stderr === ""` on the spawned binary — `codegraph --help`, the dispatch
 * tests, `validate` on a clean model — and users pipe stderr around. A tool
 * that mutters at every invocation about its own implementation choice is
 * leaking that choice into its interface, so the warning is suppressed at the
 * one moment it can be, and nowhere else.
 *
 * That moment cannot be reached by a static import. ESM evaluates every
 * `import` declaration BEFORE any statement of the importing module body, so
 * source that reads
 *
 *   process.emitWarning = quiet;                    // never runs first
 *   import { DatabaseSync } from "node:sqlite";     // ...this already ran
 *
 * has emitted the warning before the patch exists. `createRequire()` produces
 * an ordinary function, so the load happens when this function is CALLED,
 * which is the only ordering in which a patch can precede it.
 *
 * `await import("node:sqlite")` would also load at call time — and is rejected
 * for a different reason: it is async, and codegraph's read path is
 * synchronous end to end (`readModelRecordsSync`, `readModelFileSync`). One
 * `await` here would propagate up through every caller to `main`.
 *
 * AND THE BUNDLER AGREES, for a reason of its own. esbuild rewrites a static
 * `from "node:sqlite"` to `from "sqlite"` in the tsup output — it strips the
 * `node:` prefix for specifiers outside its known-builtins list. Harmless for
 * most builtins, since `node:fs` and `fs` both resolve; fatal for this one,
 * which is PREFIX-ONLY (`require("sqlite")` is MODULE_NOT_FOUND). So the built
 * binary would not merely be noisy, it would refuse to start. The string in
 * `require("node:sqlite")` below is an argument to a `createRequire` result and
 * therefore opaque to the bundler — it survives the build verbatim.
 *
 * WHAT ENFORCES THIS, since no single test covers the whole rule:
 * `store-sqlite.test.ts` spawns a process and asserts the load writes nothing
 * to stderr, which is what a hoisted import breaks; `source-hygiene.test.ts`
 * asserts exactly one source file in the workspace names the builtin at all,
 * which is what a second, equally quiet loader breaks.
 */

import { createRequire } from "node:module";

/** What SQLite can hold. Codegraph writes no blobs, but a reader may see one. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/** A result row. NOTE: `node:sqlite` returns these with a NULL prototype. */
export type SqliteRow = Record<string, SqliteValue>;

/**
 * A prepared statement, described by what the store needs rather than by what
 * `node:sqlite` happens to offer — see `SqliteApi`.
 */
export interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteValue[]): SqliteRow | undefined;
  all(...params: SqliteValue[]): SqliteRow[];
  /** Row-at-a-time. The import and hydrate paths use this, never `all()`. */
  iterate(...params: SqliteValue[]): IterableIterator<SqliteRow>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Options this codebase actually passes; a superset of them is fine. */
export interface SqliteOpenOptions {
  readOnly?: boolean;
  /** Create the file if absent. `node:sqlite` defaults this to true. */
  open?: boolean;
  /**
   * SQLite's own default is OFF; `node:sqlite` overrides it to ON. Two
   * different defaults for one setting is reason enough for the store never to
   * inherit either — see `STORE_OPEN_OPTIONS` in `schema.ts`.
   */
  enableForeignKeyConstraints?: boolean;
}

/**
 * THE SEAM. This interface is deliberately written as a description of the
 * store's needs, not as a re-export of `node:sqlite`'s types: PLAN.md §9.3
 * keeps a `better-sqlite3` fallback open for Node builds without the builtin,
 * and stating the surface here means adding one is a matter of satisfying this
 * type at this one site rather than auditing every call site in the store.
 */
export interface SqliteApi {
  open(path: string, options?: SqliteOpenOptions): SqliteDatabase;
}

/** Shape of the builtin module, as much of it as we bind. */
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: SqliteOpenOptions) => SqliteDatabase;
}

const require = createRequire(import.meta.url);

/**
 * Load with the ExperimentalWarning swallowed, then put `emitWarning` back
 * exactly as found — including if the load throws, which is why this is a
 * `finally` and not a trailing assignment.
 *
 * The filter is on the warning TYPE, not on its wording. `require()` here is
 * synchronous and loads one specific builtin, so the only code that can warn
 * inside this window is that builtin's initialization; matching the message
 * text would instead couple us to a sentence Node is free to reword. Anything
 * that is NOT an experimental warning still reaches stderr — a real problem
 * during the load must not be hidden by the suppression of a cosmetic one.
 */
function requireQuietly(): NodeSqliteModule {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
    if (type === "ExperimentalWarning") return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    return require("node:sqlite") as NodeSqliteModule;
  } finally {
    process.emitWarning = emitWarning;
  }
}

let cached: SqliteApi | undefined;

/**
 * The SQLite binding, loaded on first use and memoized.
 *
 * Memoized because this is a seam, not because `require` is slow: the value
 * every caller holds must be the same one, so a future fallback decides which
 * implementation is in play once per process rather than once per call.
 *
 * @throws if the runtime has no SQLite — with the reason, since "cannot find
 * module node:sqlite" tells a user nothing about what to do next.
 */
export function loadSqlite(): SqliteApi {
  if (cached) return cached;

  let sqlite: NodeSqliteModule;
  try {
    sqlite = requireQuietly();
  } catch (cause) {
    throw new Error(
      `SQLite is unavailable in this runtime (node ${process.version}). ` +
        "The analysis store needs node:sqlite, which is built in from Node 22.5.0 " +
        "and absent from builds configured --without-sqlite. " +
        "The .jsonl model remains fully usable: it is the interchange format, " +
        "and model.db is only a cache of it.",
      { cause },
    );
  }

  cached = {
    // `options ?? {}`, never `options`: node:sqlite validates by ARITY, so an
    // explicit `undefined` is not an omitted argument and throws
    // ERR_INVALID_ARG_TYPE. Forwarding an optional parameter straight through
    // would turn "the caller passed nothing" into "the caller passed garbage".
    open: (path, options) => new sqlite.DatabaseSync(path, options ?? {}),
  };
  return cached;
}
