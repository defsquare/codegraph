import { accessSync, closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DB_VERSION,
  HELPER_VIEWS_SQL,
  QueryRefused,
  createHelperViews,
  importModel,
  openCache,
  openStore,
  queryStore,
  type QueryRefusal,
  type QueryResult,
  type SqliteDatabase,
  type SqliteValue,
} from "@codegraph/analyzer";
import type { QueryOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, type IoSink } from "../io.js";

/**
 * `codegraph query <model.jsonl> [sql] [--file FILE] [--param NAME=VALUE]… [--param-file NAME=FILE]…`.
 *
 * SQL over a model's store, with the SQLite that is already in this binary —
 * so an ad-hoc question needs no `sqlite3` on the machine, and an agent
 * following the discovery walk has one way to ask it (PLAN.md §24.4).
 *
 * The engine is the analyzer's (`queryStore`): ONE statement, beginning with a
 * keyword that reads, its parameters bound by name. This command resolves the
 * flags, finds the store, and moves bytes (decision 7).
 *
 * STREAM PURITY (decision 3): stdout carries the rows, in the form asked for,
 * and nothing else. Which store answered and how many rows there were — said
 * every time, because "0 rows" is an answer — are stderr.
 *
 * EVERY REFUSAL IS A USAGE ERROR (exit 2), SQLite's included: a statement that
 * does not compile is a mistake in what was typed, never a bug in codegraph
 * (exit 1) and never a finding about the model (exit 3). The one exit 3 is a
 * file that is not a model at all, as everywhere else.
 */
export function queryCommand(options: QueryOptions, io: IoSink): ExitCode {
  if (options.views) {
    io.out(HELPER_VIEWS_SQL);
    return EXIT.OK;
  }

  // The parser guarantees a model outside --views; the type cannot say so.
  const path = options.model as string;
  const sql = options.sql ?? readStatement(options.file as string);

  const source = openQueryable(path, io);
  if (source === undefined) return EXIT.FINDINGS;

  try {
    createHelperViews(source.db);
    const result = run(source.db, sql, options);
    io.out(FORMATTERS[options.format](result));
    errLine(io, countLine(result));
    return EXIT.OK;
  } finally {
    source.close();
  }
}

function readStatement(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the path exists and is a readable file, or type the statement after the model.",
      { cause: error },
    );
  }
}

/** `--param` values arrive as text. One that reads as a number is bound as that number. */
function paramValue(text: string): SqliteValue {
  if (/^-?\d+$/.test(text)) {
    const whole = Number(text);
    return Number.isSafeInteger(whole) ? whole : BigInt(text);
  }
  return /^-?\d+\.\d+$/.test(text) ? Number(text) : text;
}

/**
 * `--param-file NAME=FILE`: the file's whole text, bound as TEXT whatever it
 * reads as. It is how one statement builds on another's saved rows —
 * `json_each(:NAME, '$.rows')` over a `--json` result — without anybody
 * retyping a list of ids on a command line.
 */
function paramFileText(name: string, file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${file}, given as --param-file ${name}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the path exists and is a readable file: its whole text is what :" + name + " is bound to.",
      { cause: error },
    );
  }
}

function run(db: SqliteDatabase, sql: string, options: QueryOptions): QueryResult {
  const params: Record<string, SqliteValue> = {};
  for (const [name, text] of Object.entries(options.params)) params[name] = paramValue(text);
  for (const [name, file] of Object.entries(options.paramFiles)) params[name] = paramFileText(name, file);
  try {
    return queryStore(db, sql, { params, limit: options.limit });
  } catch (error) {
    if (error instanceof QueryRefused) throw new UsageError(...refusalText(error), { cause: error });
    throw error;
  }
}

const SCHEMA_HINT =
  "List what there is: codegraph query <model> \"SELECT type, name FROM sqlite_schema ORDER BY name\". " +
  "The views node and dep are always there; 'codegraph query --views' prints them.";

const HINTS: Readonly<Record<QueryRefusal, string>> = {
  empty: "Quote one statement after the model, or pass --file FILE.",
  "not-read-only": "query never writes: not to the store, not to another file.",
  "several-statements": "Run them one at a time.",
  "foreign-parameter": "Then: --param NAME=VALUE, once per parameter.",
  "missing-parameter": "Give each one: --param NAME=VALUE, or --param-file NAME=FILE for a file's text.",
  "unknown-parameter": "Drop it, or name it in the statement as :NAME.",
  sqlite: SCHEMA_HINT,
};

function refusalText(error: QueryRefused): [message: string, hint: string] {
  const message = error.reason === "sqlite" ? `SQLite refused the statement: ${error.message}` : error.message;
  return [message, HINTS[error.reason]];
}

interface Queryable {
  readonly db: SqliteDatabase;
  close(): void;
}

const SQLITE_MAGIC = "SQLite format 3\u0000";

/** A store is told from a model by its first bytes, never by its file name. */
function isSqliteFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.toString("latin1") === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

/**
 * The store to query: the file itself when it is one, else the model's cache,
 * built or reused exactly as `analyze` does — and, when no cache can be had
 * beside the model, a temporary store that is deleted on the way out.
 *
 * Returns undefined, having said why, when the file is not a model: that is a
 * finding about the file (exit 3), which `validate` details.
 */
function openQueryable(path: string, io: IoSink): Queryable | undefined {
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    throw new UsageError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the path exists and is a readable file.",
      { cause: error },
    );
  }

  if (isSqliteFile(path)) return openGivenStore(path);

  const attempt = openCache(path);
  if (attempt.store !== undefined) {
    const db = attempt.store.db;
    errLine(io, `cache: ${attempt.store.path}`);
    return { db, close: () => db.close() };
  }
  if (attempt.reason === "the model could not be read") return notAModel(path, io);

  // FAILING TO CACHE IS NOT FAILING (store/cache.ts): a read-only directory or
  // a store kept for its revisions still deserves an answer.
  const directory = mkdtempSync(join(tmpdir(), "codegraph-query-"));
  const discard = (): void => rmSync(directory, { recursive: true, force: true });
  try {
    const store = join(directory, "model.db");
    importModel(path, store);
    const db = openStore(store);
    errLine(io, `cache: not used — ${attempt.reason}. Querying a temporary store.`);
    return {
      db,
      close: () => {
        db.close();
        discard();
      },
    };
  } catch (error) {
    discard();
    if (error instanceof Error && error.name === "JsonlError") return notAModel(path, io);
    throw error;
  }
}

function notAModel(path: string, io: IoSink): undefined {
  errLine(io, `codegraph: cannot query ${path}: it is not a model.jsonl the reader accepts`);
  errLine(io, `Run 'codegraph validate ${path}' for the detail.`);
  return undefined;
}

/** A `.db` handed over directly: it must be a store, and of the version this build reads. */
function openGivenStore(path: string): Queryable {
  const foreign = (cause: unknown): UsageError =>
    new UsageError(
      `${path} is a SQLite file, but not a codegraph store`,
      "Pass a model.jsonl, or the model.db that 'codegraph import' wrote beside one.",
      { cause },
    );

  let db: SqliteDatabase;
  try {
    db = openStore(path);
  } catch (error) {
    throw foreign(error);
  }

  let version: number;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dbVersion'").get();
    version = Number(row?.value ?? Number.NaN);
  } catch (error) {
    db.close();
    throw foreign(error);
  }
  if (version !== DB_VERSION) {
    db.close();
    throw new UsageError(
      `${path} is a store of version ${Number.isNaN(version) ? "unknown" : version}; this build reads ${DB_VERSION}`,
      "Pass the model.jsonl it was built from: its store is rebuilt when it has to be.",
    );
  }
  return { db, close: () => db.close() };
}

function countLine(result: QueryResult): string {
  if (result.truncated) {
    return `${result.rows.length} of ${result.total} rows shown — --all prints every row, --limit N another count.`;
  }
  return `${result.total} ${result.total === 1 ? "row" : "rows"}.`;
}

// ---------------------------------------------------------------- the three forms

/** A cell as text. A blob (codegraph writes none) is shown the way SQL writes one. */
function cellText(value: SqliteValue): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString("hex")}'`;
  return String(value);
}

const ESCAPES: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** One row, one line: a line break inside a cell is written as the two characters `\n`. */
function tableCell(value: SqliteValue): string {
  return cellText(value).replace(/[\n\r\t]/g, (char) => ESCAPES[char] ?? char);
}

/**
 * An aligned table: the column names as the statement gives them, a rule, the
 * rows. A column whose every value is a number is right-aligned, so magnitudes
 * line up; NULL is written NULL so it cannot be read as an empty string.
 */
export function formatTable(result: QueryResult): string {
  const numeric = result.columns.map((_name, column) => {
    const values = result.rows.map((row) => row[column]).filter((value) => value !== null);
    return values.length > 0 && values.every((value) => typeof value === "number" || typeof value === "bigint");
  });
  // One number of decimals per column: `round(x, 1)` gives 6 for 6.0, and a
  // column reading 90.9, 6, 3.3 hides that all three are shares to one place.
  const decimals = result.columns.map((_name, column) => {
    if (numeric[column] !== true) return 0;
    const texts = result.rows.map((row) => row[column]).filter((value) => value !== null).map(String);
    if (texts.some((text) => /e/i.test(text))) return 0; // exponent form: leave as written
    return Math.max(0, ...texts.map((text) => (text.split(".")[1] ?? "").length));
  });
  const cells = result.rows.map((row) =>
    row.map((value, column) => {
      const places = decimals[column] ?? 0;
      return places > 0 && typeof value === "number" ? value.toFixed(places) : tableCell(value);
    }),
  );
  const widths = result.columns.map((name, column) =>
    Math.max(name.length, ...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]): string =>
    row
      .map((text, column) => {
        const width = widths[column] ?? 0;
        return numeric[column] === true ? text.padStart(width) : text.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  const lines = [line(result.columns), widths.map((width) => "-".repeat(width)).join("  "), ...cells.map(line)];
  return `${lines.join("\n")}\n`;
}

/** What JSON has for a cell: null, a number, a string. */
function jsonCell(value: SqliteValue): null | number | string {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return cellText(value);
}

/**
 * `codegraph.queryResult/1`, laid out by hand: ONE ROW PER LINE. A generic
 * pretty-printer puts every cell on its own line, which turns fifty rows of
 * four columns into two hundred lines that diff badly and read worse.
 */
export function formatJson(result: QueryResult): string {
  const array = (values: readonly unknown[]): string => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const rows = result.rows.map((row) => `    ${array(row.map(jsonCell))}`);
  return [
    "{",
    '  "kind": "codegraph.queryResult/1",',
    `  "columns": ${array(result.columns)},`,
    rows.length === 0 ? '  "rows": [],' : `  "rows": [\n${rows.join(",\n")}\n  ],`,
    `  "total": ${result.total},`,
    `  "truncated": ${result.truncated}`,
    "}",
    "",
  ].join("\n");
}

/** RFC 4180, LF-terminated as the other CSV exports are; NULL is an empty field. */
function csvField(value: SqliteValue | string): string {
  if (value === null) return "";
  const text = typeof value === "string" ? value : cellText(value);
  const quote = /[",\n\r]/.test(text) || text !== text.trim();
  return quote ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatCsv(result: QueryResult): string {
  const lines = [result.columns.map(csvField).join(","), ...result.rows.map((row) => row.map(csvField).join(","))];
  return `${lines.join("\n")}\n`;
}

const FORMATTERS: Readonly<Record<QueryOptions["format"], (result: QueryResult) => string>> = {
  table: formatTable,
  json: formatJson,
  csv: formatCsv,
};
