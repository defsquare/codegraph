/**
 * ONE READ-ONLY STATEMENT OVER A STORE (PLAN.md §24.4).
 *
 * This is the engine of `codegraph query`: SQL somebody wrote — a person, or
 * an agent following the discovery walk — run against `model.db`.
 *
 * READ-ONLY IS HELD TWICE, because once is not enough. A handle opened
 * `readOnly` refuses every write to the store, and still executes
 * `VACUUM INTO 'file'`, which writes a full copy of the database wherever the
 * text says (measured: 221 184 bytes from the Java fixture). The handle
 * protects the store, not the disk. So the TEXT is checked as well:
 *
 *  - it is ONE statement. SQLite's `prepare` compiles the first statement and
 *    silently ignores whatever follows the `;` — so `SELECT 1; DELETE …` would
 *    not delete, and would not say it had not. A tail is refused, not dropped;
 *  - it begins with a keyword that reads (`QUERY_STATEMENT_KEYWORDS`). A
 *    `WITH` can still introduce a write; that one the handle refuses.
 *
 * PARAMETERS ARE BOUND, NEVER SPLICED. An entity id holds parentheses and
 * commas, and in Ruby quotes. And they are checked by name before the
 * statement runs, in both directions: SQLite binds NULL to a parameter nobody
 * gave, which returns zero rows and reads as "there are none".
 *
 * Nothing here opens a file or creates a view: the caller hands an open
 * database, with `createHelperViews` applied if the statement wants them.
 */

import type { SqliteDatabase, SqliteNamedParameters, SqliteValue } from "./sqlite.js";

/** A statement must begin with one of these. Everything else is refused before SQLite sees it. */
export const QUERY_STATEMENT_KEYWORDS = ["SELECT", "WITH", "VALUES", "EXPLAIN"] as const;

/** What a statement's TEXT says about itself, found by scanning it — nothing is run. */
export interface StatementShape {
  /**
   * The first token, upper-cased when it is a word: `SELECT`, `VACUUM`. A
   * first token that is not a word is given as written (`(`). Empty when the
   * text holds no statement at all.
   */
  readonly keyword: string;
  /** The `:name` parameters, without the colon, once each, in order of first use. */
  readonly params: readonly string[];
  /** Parameters in a spelling that is not bound here (`?`, `?2`, `@name`, `$name`), as written. */
  readonly foreignParams: readonly string[];
  /** True when something other than space and comments follows the first statement's `;`. */
  readonly hasTail: boolean;
}

const isWordStart = (char: string): boolean => /[A-Za-z_]/.test(char);
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
const isSpace = (char: string): boolean => /\s/.test(char);

/**
 * Scan a statement's text the way SQLite's tokenizer delimits it: string
 * literals, the three quoted-identifier forms and both comment forms are
 * skipped whole, so a `;`, a `:name` or a keyword inside one is not seen.
 *
 * Not a parser, and it does not need to be one: it answers three questions
 * (first keyword, parameters, is there a second statement) that depend only
 * on where the tokens are.
 */
export function statementShape(sql: string): StatementShape {
  let keyword = "";
  let hasTail = false;
  let ended = false;
  const params: string[] = [];
  const foreignParams: string[] = [];

  /** Any real token: the first one names the statement, one after the `;` is a tail. */
  const token = (text: string, word: boolean): void => {
    if (ended) hasTail = true;
    else if (keyword === "") keyword = word ? text.toUpperCase() : text;
  };

  /** Skip a quoted run closed by `close`, where a doubled `close` is an escape. */
  const quoted = (from: number, close: string): number => {
    let at = from + 1;
    while (at < sql.length) {
      if (sql[at] === close) {
        if (sql[at + 1] === close && close !== "]") at += 2;
        else return at + 1;
      } else {
        at += 1;
      }
    }
    return at; // unterminated: SQLite will say so; nothing after it is a token
  };

  const wordFrom = (from: number): number => {
    let at = from;
    while (at < sql.length && isWordPart(sql[at]!)) at += 1;
    return at;
  };

  let at = 0;
  while (at < sql.length) {
    const char = sql[at]!;
    const next = sql[at + 1];

    if (isSpace(char)) {
      at += 1;
    } else if (char === "-" && next === "-") {
      const eol = sql.indexOf("\n", at);
      at = eol === -1 ? sql.length : eol + 1;
    } else if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", at + 2);
      at = close === -1 ? sql.length : close + 2;
    } else if (char === "'" || char === '"' || char === "`") {
      token(char, false);
      at = quoted(at, char);
    } else if (char === "[") {
      token(char, false);
      at = quoted(at, "]");
    } else if (char === ";") {
      // The first `;` ends the statement; a later one is an empty statement.
      if (keyword !== "") ended = true;
      at += 1;
    } else if (char === ":" && next !== undefined && isWordStart(next)) {
      const end = wordFrom(at + 1);
      const name = sql.slice(at + 1, end);
      token(`:${name}`, false);
      if (!params.includes(name)) params.push(name);
      at = end;
    } else if ((char === "@" || char === "$") && next !== undefined && isWordStart(next)) {
      const end = wordFrom(at + 1);
      token(sql.slice(at, end), false);
      foreignParams.push(sql.slice(at, end));
      at = end;
    } else if (char === "?") {
      let end = at + 1;
      while (end < sql.length && /[0-9]/.test(sql[end]!)) end += 1;
      token(sql.slice(at, end), false);
      foreignParams.push(sql.slice(at, end));
      at = end;
    } else if (isWordStart(char)) {
      const end = wordFrom(at);
      token(sql.slice(at, end), true);
      at = end;
    } else {
      token(char, false);
      at += 1;
    }
  }

  return { keyword, params, foreignParams, hasTail };
}

/** Why a statement was not run. `sqlite` is SQLite's own refusal, in its own words. */
export type QueryRefusal =
  | "empty"
  | "not-read-only"
  | "several-statements"
  | "foreign-parameter"
  | "missing-parameter"
  | "unknown-parameter"
  | "sqlite";

/**
 * A statement that was not run. Always the caller's text at fault, never the
 * store: a command maps it to a usage error, with `message` as the sentence.
 */
export class QueryRefused extends Error {
  readonly reason: QueryRefusal;

  constructor(reason: QueryRefusal, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueryRefused";
    this.reason = reason;
  }
}

export interface QueryOptions {
  /** Values for the statement's `:name` parameters, keyed without the colon. */
  readonly params?: Readonly<Record<string, SqliteValue>> | undefined;
  /** Keep at most this many rows; every row is still counted. Absent keeps them all. */
  readonly limit?: number | undefined;
}

export interface QueryResult {
  /** Column names as the statement gives them — two may be equal, which is why rows are arrays. */
  readonly columns: readonly string[];
  /** The rows kept, each in column order. */
  readonly rows: readonly (readonly SqliteValue[])[];
  /** How many rows the statement returned, kept or not. */
  readonly total: number;
  /** True when `rows` is fewer than `total`. */
  readonly truncated: boolean;
}

const list = (names: readonly string[]): string => names.map((name) => `:${name}`).join(", ");

/** The checks that need no database: what the text is, and whether the parameters match it. */
function checkStatement(sql: string, given: readonly string[]): void {
  const shape = statementShape(sql);
  if (shape.keyword === "") {
    throw new QueryRefused("empty", "the statement is empty");
  }
  if (!(QUERY_STATEMENT_KEYWORDS as readonly string[]).includes(shape.keyword)) {
    throw new QueryRefused(
      "not-read-only",
      `a query is one statement that reads, beginning with ${QUERY_STATEMENT_KEYWORDS.join(", ")}; this one begins with ${shape.keyword}`,
    );
  }
  if (shape.hasTail) {
    throw new QueryRefused(
      "several-statements",
      "a query is ONE statement; this text holds another after the ';' (SQLite would have ignored it without a word)",
    );
  }
  if (shape.foreignParams.length > 0) {
    const first = shape.foreignParams[0]!;
    const named = /^[@$]/.test(first) ? `:${first.slice(1)}` : ":name";
    throw new QueryRefused(
      "foreign-parameter",
      `parameter ${first} is not bound here: write it ${named} and give its value by name`,
    );
  }
  const missing = shape.params.filter((name) => !given.includes(name));
  if (missing.length > 0) {
    throw new QueryRefused(
      "missing-parameter",
      `the statement names ${list(missing)} and no value was given — SQLite would bind NULL and return nothing`,
    );
  }
  const unknown = given.filter((name) => !shape.params.includes(name));
  if (unknown.length > 0) {
    throw new QueryRefused(
      "unknown-parameter",
      shape.params.length === 0
        ? `a value was given for ${list(unknown)}, and the statement names no parameter`
        : `a value was given for ${list(unknown)}, and the statement names only ${list(shape.params)}`,
    );
  }
}

/**
 * Run one read-only statement and return its rows.
 *
 * @throws QueryRefused when the text is not one reading statement, when its
 * parameters and the values given do not match, or when SQLite refuses it
 * (unknown column, syntax, a write behind a `WITH`) — with SQLite's message.
 */
export function queryStore(db: SqliteDatabase, sql: string, options: QueryOptions = {}): QueryResult {
  const params = options.params ?? {};
  checkStatement(sql, Object.keys(params));

  const bound: SqliteNamedParameters = {};
  for (const [name, value] of Object.entries(params)) {
    // The binding stores a JS number as REAL, so `typeof(:n)` would say `real`
    // for 41. A whole number is bound as the INTEGER it is.
    bound[`:${name}`] = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
  }

  try {
    const statement = db.prepare(sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const rows: SqliteValue[][] = [];
    let total = 0;
    for (const row of statement.iterate(bound) as unknown as Iterable<SqliteValue[]>) {
      if (total < limit) rows.push(row);
      total += 1;
    }
    return { columns, rows, total, truncated: rows.length < total };
  } catch (error) {
    if (error instanceof QueryRefused) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new QueryRefused("sqlite", message, { cause: error });
  }
}
