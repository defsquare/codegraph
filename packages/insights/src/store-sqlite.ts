import type { SqliteDatabase, SqliteRow, SqliteValue } from "@codegraph/analyzer";
import {
  FailureRecord,
  InsightRecord,
  InsightsEof,
  InsightsHeader,
  LEVELS,
  type Level,
} from "./schema.js";
import { conceptLabel, type RecordSummary } from "./records.js";
import { LEVEL_RANK, sortFailures, sortRecords, type InsightsFile } from "./sidecar.js";
import {
  INSIGHTS_APPLICATION_ID,
  INSIGHTS_DB_VERSION,
  InsightsStoreError,
  type ExportStamp,
  type InsightQuery,
  type InsightRow,
  type InsightStats,
  type InsightsStore,
  type OpenRun,
  type RunEnd,
  type RunHandle,
  type RunRow,
  type RunStart,
  type StoreOpenOptions,
} from "./store.js";

/**
 * THE SQLITE ADAPTER of the insights store (PLAN.md §17.1). It takes an OPEN
 * database — the caller owns the path and the binding (`loadSqlite()` in the
 * analyzer stays the one module naming Node's SQLite builtin) — so this package
 * still touches no filesystem of its own.
 *
 * THE ENVELOPE IS COLUMNS, THE BLOCK IS TEXT. What a planner or a reader
 * selects on (id, level, fingerprint, the natural key, usage) is a column;
 * the block is the JSON the side-car carries, whose shape moves with
 * `PROMPT_VERSION` — tables per field would make every prompt change a
 * migration. `concept`/`confidence` are generated columns over it.
 *
 * ROWID TABLES, deliberately: a record is a kilobyte or more of block, and a
 * `WITHOUT ROWID` b-tree keeps whole rows in its interior pages — measured on
 * Broadleaf's 28 206 records, 96 MB against 57 MB, for no faster read.
 *
 * ORDER IS DECIDED IN JS. The side-car sorts ids by UTF-16 code units and
 * SQLite compares TEXT as UTF-8 bytes; the two disagree above U+FFFF, so no
 * `ORDER BY id` here is ever the export order.
 *
 * TEXT IS UTF-8, READ AS A C STRING. A lone surrogate in a column comes back
 * as U+FFFD, and Node's binding returns TEXT only up to its first U+0000 — an id
 * would come back SHORTER, silently. So a column string holding U+0000 is
 * refused at write; everything a model or a provider worded (block, reason,
 * metadata) is stored as JSON text, where both are escapes and survive.
 */

/** Index i takes a store from version i to i+1. Append; never edit a shipped entry. */
const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE run (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pid INTEGER,
  provider TEXT,
  leaf TEXT NOT NULL,
  rollup TEXT NOT NULL,
  depth INTEGER NOT NULL,
  llm INTEGER, template INTEGER, reused INTEGER, failed INTEGER, calls INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  aborted TEXT
);

CREATE TABLE insight (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  file TEXT,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  scc TEXT,
  origin TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  metadata TEXT,
  block TEXT NOT NULL,
  concept TEXT GENERATED ALWAYS AS (block ->> '$.concept') VIRTUAL,
  confidence REAL GENERATED ALWAYS AS (block ->> '$.confidence') VIRTUAL,
  run_id INTEGER REFERENCES run(id)
);
CREATE INDEX insight_concept ON insight(concept) WHERE concept IS NOT NULL;
CREATE INDEX insight_run ON insight(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE failure (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  members TEXT NOT NULL,
  key_lang TEXT, key_module TEXT, key_symbol TEXT, key_disambiguator TEXT,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  reason_kind TEXT GENERATED ALWAYS AS (reason ->> '$.kind') VIRTUAL,
  status INTEGER GENERATED ALWAYS AS (reason ->> '$.status') VIRTUAL,
  attempts INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
  run_id INTEGER REFERENCES run(id)
);
`,
];

const INSIGHT_COLUMNS =
  "id, level, kind, name, file, key_lang, key_module, key_symbol, key_disambiguator, scc, origin, fingerprint, model, prompt_tokens, completion_tokens, cost, metadata, block";
const FAILURE_COLUMNS =
  "id, level, members, key_lang, key_module, key_symbol, key_disambiguator, model, reason, attempts, calls, prompt_tokens, completion_tokens, cost";

/**
 * SQLite's default host-parameter ceiling is far above this; a chunk keeps
 * `get()` independent of it — and is the most records `export()` ever holds.
 */
const GET_CHUNK = 500;

/** A column value; a string is checked for the one character the binding cannot read back. */
function nullable(value: SqliteValue | undefined): SqliteValue {
  if (typeof value === "string" && value.includes("\u0000")) {
    throw new InsightsStoreError(`a store column cannot hold U+0000 (in ${JSON.stringify(value)}): it would be read back cut short`);
  }
  return value === undefined ? null : value;
}
const text = (row: SqliteRow, column: string): string | undefined => (row[column] === null ? undefined : (row[column] as string));
const number = (row: SqliteRow, column: string): number | undefined => (row[column] === null ? undefined : Number(row[column]));

function pragma(db: SqliteDatabase, name: string): number {
  return Number(db.prepare(`PRAGMA ${name}`).get()?.[name] ?? 0);
}

/** Refuse before writing a byte: a store that is not ours, or is from a later build, is left as found. */
function migrate(db: SqliteDatabase, readOnly: boolean): void {
  const version = pragma(db, "user_version");
  const tables = Number(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.["n"] ?? 0);
  if (tables > 0 && pragma(db, "application_id") !== INSIGHTS_APPLICATION_ID) {
    throw new InsightsStoreError("this SQLite file is not an insights store (it holds other tables and carries no insights application id)");
  }
  if (readOnly) {
    // A reader brings nothing up to date: an empty file is not a store, and an older one waits for a run to migrate it.
    if (tables === 0) throw new InsightsStoreError("this file is not an insights store (it is empty)");
    if (version < INSIGHTS_DB_VERSION) {
      throw new InsightsStoreError(`this insights store is at version ${version} and this build reads ${INSIGHTS_DB_VERSION}; any 'codegraph explain' run on it migrates it`);
    }
  }
  if (version > INSIGHTS_DB_VERSION) {
    throw new InsightsStoreError(
      `this insights store was written by a newer codegraph (store version ${version}, this build reads up to ${INSIGHTS_DB_VERSION}); it was left untouched`,
    );
  }
  // A reader runs no migration and sets nothing that lands in the file; SQLite enforces the rest.
  if (readOnly) {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    return;
  }
  // synchronous = NORMAL is WAL's intended setting: a commit survives the PROCESS dying (kill, OOM, Ctrl-C —
  // what a long run actually meets) without an fsync per unit; only a power cut can lose the last few commits,
  // never the file. Measured on Broadleaf: 9 892 templated units, 37 s of fsync at FULL.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  for (let from = version; from < INSIGHTS_DB_VERSION; from += 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[from] ?? "");
      db.exec(`PRAGMA application_id = ${INSIGHTS_APPLICATION_ID}; PRAGMA user_version = ${from + 1};`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new InsightsStoreError(`migrating the insights store from version ${from} failed; it was left at version ${from}`, { cause: error });
    }
  }
}

function keyOf(row: SqliteRow): InsightRecord["key"] {
  const lang = text(row, "key_lang");
  if (lang === undefined) return undefined;
  const disambiguator = text(row, "key_disambiguator");
  return { lang, module: text(row, "key_module") ?? "", symbol: text(row, "key_symbol") ?? "", ...(disambiguator === undefined ? {} : { disambiguator }) };
}

function usageOf(row: SqliteRow): InsightRecord["usage"] {
  const promptTokens = number(row, "prompt_tokens");
  if (promptTokens === undefined) return undefined;
  const cost = number(row, "cost");
  return { promptTokens, completionTokens: number(row, "completion_tokens") ?? 0, ...(cost === undefined ? {} : { cost }) };
}

/** Absent stays absent: a NULL column is a key the record never had. */
function defined<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

function recordOf(row: SqliteRow): InsightRecord {
  const scc = text(row, "scc");
  const metadata = text(row, "metadata");
  return InsightRecord.parse(
    defined({
      t: "i",
      id: row["id"],
      key: keyOf(row),
      level: LEVELS[Number(row["level"])],
      kind: row["kind"],
      name: text(row, "name"),
      file: text(row, "file"),
      scc: scc === undefined ? undefined : (JSON.parse(scc) as unknown),
      origin: row["origin"],
      block: JSON.parse(row["block"] as string) as unknown,
      fingerprint: row["fingerprint"],
      model: text(row, "model"),
      usage: usageOf(row),
      metadata: metadata === undefined ? undefined : (JSON.parse(metadata) as unknown),
    }),
  );
}

function failureOf(row: SqliteRow): FailureRecord {
  return FailureRecord.parse(
    defined({
      t: "f",
      id: row["id"],
      key: keyOf(row),
      level: LEVELS[Number(row["level"])],
      members: JSON.parse(row["members"] as string) as unknown,
      model: row["model"],
      reason: JSON.parse(row["reason"] as string) as unknown,
      attempts: Number(row["attempts"]),
      calls: Number(row["calls"]),
      usage: usageOf(row),
    }),
  );
}

export function sqliteInsightsStore(db: SqliteDatabase, options: StoreOpenOptions = {}): InsightsStore {
  migrate(db, options.readOnly === true);

  const insertInsight = db.prepare(`INSERT OR REPLACE INTO insight (${INSIGHT_COLUMNS}, run_id) VALUES (${"?, ".repeat(18)}?)`);
  const insertFailure = db.prepare(`INSERT OR REPLACE INTO failure (${FAILURE_COLUMNS}, run_id) VALUES (${"?, ".repeat(14)}?)`);
  const deleteFailure = db.prepare("DELETE FROM failure WHERE id = ?");
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const dropMeta = db.prepare("DELETE FROM meta WHERE key = ?");

  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const meta = (key: string): unknown => {
    const value = getMeta.get(key)?.["value"];
    return typeof value === "string" ? (JSON.parse(value) as unknown) : undefined;
  };

  /** Validated BEFORE the first bind, so a bad member aborts its unit with nothing written. */
  const writeRecord = (input: InsightRecord, run: number | null): void => {
    const r = InsightRecord.parse(input);
    insertInsight.run(
      nullable(r.id), LEVEL_RANK[r.level], nullable(r.kind), nullable(r.name), nullable(r.file),
      nullable(r.key?.lang), nullable(r.key?.module), nullable(r.key?.symbol), nullable(r.key?.disambiguator),
      r.scc === undefined ? null : JSON.stringify(r.scc),
      r.origin, nullable(r.fingerprint), nullable(r.model),
      nullable(r.usage?.promptTokens), nullable(r.usage?.completionTokens), nullable(r.usage?.cost),
      r.metadata === undefined ? null : JSON.stringify(r.metadata),
      JSON.stringify(r.block),
      run,
    );
  };

  const writeFailure = (input: FailureRecord, run: number | null): void => {
    const f = FailureRecord.parse(input);
    insertFailure.run(
      nullable(f.id), LEVEL_RANK[f.level as Level], JSON.stringify(f.members),
      nullable(f.key?.lang), nullable(f.key?.module), nullable(f.key?.symbol), nullable(f.key?.disambiguator),
      nullable(f.model), JSON.stringify(f.reason),
      f.attempts, f.calls,
      nullable(f.usage?.promptTokens), nullable(f.usage?.completionTokens), nullable(f.usage?.cost),
      run,
    );
  };

  /** One statement per arity, prepared on first use: a prompt asks for ONE record, an export for chunks. */
  const selectByIds = new Map<number, ReturnType<SqliteDatabase["prepare"]>>();
  const get = (ids: readonly string[]): InsightRecord[] => {
    const out: InsightRecord[] = [];
    for (let start = 0; start < ids.length; start += GET_CHUNK) {
      const chunk = ids.slice(start, start + GET_CHUNK);
      let statement = selectByIds.get(chunk.length);
      if (statement === undefined) {
        statement = db.prepare(`SELECT ${INSIGHT_COLUMNS} FROM insight WHERE id IN (${chunk.map(() => "?").join(", ")})`);
        selectByIds.set(chunk.length, statement);
      }
      for (const row of statement.all(...chunk)) out.push(recordOf(row));
    }
    return sortRecords(out);
  };

  // `->`, not `->>`: the JSON text keeps U+0000 and lone surrogates as ESCAPES, which a TEXT value would not survive.
  const selectSummary = db.prepare(
    "SELECT level, block -> '$.description' AS description, block -> '$.owner' AS owner, block -> '$.concept' AS concept, block -> '$.boundedContextHint.name' AS context FROM insight WHERE id = ?",
  );
  const jsonString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  };
  const summary = (id: string): RecordSummary | undefined => {
    const row = selectSummary.get(id);
    if (row === undefined) return undefined;
    const level = LEVELS[Number(row["level"])] as Level;
    return {
      description: jsonString(row["description"]) ?? "",
      concept: conceptLabel(level, { owner: jsonString(row["owner"]), concept: jsonString(row["concept"]), context: jsonString(row["context"]) }),
    };
  };

  /** Every id in SIDE-CAR order — decided here, in JS (see the header) — without reading a block. */
  const orderedIds = (): string[] => {
    const statement = db.prepare("SELECT id, level FROM insight");
    statement.setReturnArrays(true);
    const index = [...(statement.iterate() as unknown as Iterable<[string, number]>)];
    index.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return index.map((entry) => entry[0]);
  };

  const ROW_COLUMNS =
    "id, level, kind, name, file, origin, model, confidence, block -> '$.description' AS description, block -> '$.owner' AS owner, block -> '$.concept' AS block_concept, block -> '$.boundedContextHint.name' AS context";
  const rowOf = (row: SqliteRow): InsightRow => {
    const level = LEVELS[Number(row["level"])] as Level;
    return {
      id: row["id"] as string,
      level,
      kind: row["kind"] as string,
      name: text(row, "name"),
      file: text(row, "file"),
      origin: row["origin"] as InsightRow["origin"],
      model: text(row, "model"),
      confidence: Number(row["confidence"]),
      description: jsonString(row["description"]) ?? "",
      concept: conceptLabel(level, { owner: jsonString(row["owner"]), concept: jsonString(row["block_concept"]), context: jsonString(row["context"]) }),
    };
  };

  const query = (q: InsightQuery): InsightRow[] => {
    const where: string[] = [];
    const params: SqliteValue[] = [];
    if (q.level !== undefined) {
      where.push("level = ?");
      params.push(LEVEL_RANK[q.level]);
    }
    if (q.concept !== undefined) {
      where.push("concept = ?");
      params.push(q.concept);
    }
    if (q.minConfidence !== undefined) {
      where.push("confidence >= ?");
      params.push(q.minConfidence);
    }
    if (q.maxConfidence !== undefined) {
      where.push("confidence <= ?");
      params.push(q.maxConfidence);
    }
    // `ids` in chunks, like get(); no ids means one statement over the filter alone.
    const chunks: (readonly string[] | undefined)[] = [];
    if (q.ids === undefined) chunks.push(undefined);
    else for (let start = 0; start < q.ids.length; start += GET_CHUNK) chunks.push(q.ids.slice(start, start + GET_CHUNK));
    const rows: InsightRow[] = [];
    for (const chunk of chunks) {
      const clauses = chunk === undefined ? where : [...where, `id IN (${chunk.map(() => "?").join(", ")})`];
      const sql = `SELECT ${ROW_COLUMNS} FROM insight${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}`;
      for (const row of db.prepare(sql).iterate(...params, ...(chunk ?? []))) rows.push(rowOf(row));
    }
    // Side-car order, decided in JS (see the header); the limit cuts AFTER it.
    rows.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return q.limit === undefined ? rows : rows.slice(0, q.limit);
  };

  const stats = (): InsightStats => {
    const byLevel = { operation: 0, type: 0, module: 0 };
    for (const row of db.prepare("SELECT level, count(*) AS n FROM insight GROUP BY level").all()) byLevel[LEVELS[Number(row["level"])] as Level] = Number(row["n"]);
    const byOrigin = { llm: 0, template: 0 };
    for (const row of db.prepare("SELECT origin, count(*) AS n FROM insight GROUP BY origin").all()) byOrigin[row["origin"] as "llm" | "template"] = Number(row["n"]);
    const concepts = db.prepare("SELECT concept, count(*) AS n FROM insight WHERE concept IS NOT NULL GROUP BY concept").all();
    const byConcept = Object.fromEntries(concepts.map((row) => [row["concept"] as string, Number(row["n"])] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const spent = db.prepare("SELECT total(prompt_tokens) AS p, total(completion_tokens) AS c, sum(cost) AS cost FROM insight").get();
    const cost = spent === undefined ? undefined : number(spent, "cost");
    return {
      records: byLevel.operation + byLevel.type + byLevel.module,
      failures: Number(db.prepare("SELECT count(*) AS n FROM failure").get()?.["n"] ?? 0),
      byLevel,
      byOrigin,
      byConcept,
      usage: { promptTokens: Number(spent?.["p"] ?? 0), completionTokens: Number(spent?.["c"] ?? 0), ...(cost === undefined ? {} : { cost }) },
    };
  };

  const runs = (): RunRow[] =>
    db.prepare("SELECT * FROM run ORDER BY id").all().map((row) => {
      const cost = number(row, "cost");
      const promptTokens = number(row, "prompt_tokens");
      const llm = number(row, "llm");
      return {
        id: Number(row["id"]),
        startedAt: row["started_at"] as string,
        finishedAt: text(row, "finished_at"),
        provider: text(row, "provider"),
        models: { leaf: row["leaf"] as string, rollup: row["rollup"] as string },
        depth: Number(row["depth"]),
        counts: llm === undefined ? undefined : { llm, template: number(row, "template") ?? 0, reused: number(row, "reused") ?? 0, failed: number(row, "failed") ?? 0, calls: number(row, "calls") },
        usage: promptTokens === undefined ? undefined : { promptTokens, completionTokens: number(row, "completion_tokens") ?? 0, ...(cost === undefined ? {} : { cost }) },
        aborted: text(row, "aborted"),
      };
    });

  const records = (): InsightRecord[] => {
    const out: InsightRecord[] = [];
    for (const row of db.prepare(`SELECT ${INSIGHT_COLUMNS} FROM insight`).iterate()) out.push(recordOf(row));
    return sortRecords(out);
  };

  const failures = (): FailureRecord[] =>
    sortFailures(db.prepare(`SELECT ${FAILURE_COLUMNS} FROM failure`).all().map(failureOf));

  const header = (): InsightsHeader | undefined => {
    const value = meta("header");
    return value === undefined ? undefined : InsightsHeader.parse(value);
  };

  const eof = (): InsightsEof | undefined => {
    const value = meta("eof");
    return value === undefined ? undefined : InsightsEof.parse(value);
  };

  return {
    isEmpty: () => getMeta.get("header") === undefined,
    header,
    eof,
    records,
    failures,
    query,
    stats,
    runs,

    fingerprints() {
      const out = new Map<string, string>();
      const statement = db.prepare("SELECT id, fingerprint FROM insight");
      statement.setReturnArrays(true);
      for (const row of statement.iterate() as unknown as Iterable<[string, string]>) out.set(row[0], row[1]);
      return out;
    },

    summary,
    get,

    exported() {
      return meta("exported") as ExportStamp | undefined;
    },

    openRuns(): OpenRun[] {
      return db
        .prepare(
          "SELECT id, started_at, pid, (SELECT count(*) FROM insight WHERE insight.run_id = run.id) AS records FROM run WHERE finished_at IS NULL ORDER BY id",
        )
        .all()
        .map((row) => ({ id: Number(row["id"]), startedAt: row["started_at"] as string, pid: number(row, "pid"), records: Number(row["records"]) }));
    },

    importFile(file: InsightsFile) {
      transaction(() => {
        db.exec("DELETE FROM insight; DELETE FROM failure;");
        for (const record of file.records) writeRecord(record, null);
        for (const failure of file.failures) writeFailure(failure, null);
        setMeta.run("header", JSON.stringify(InsightsHeader.parse(file.header)));
        if (file.eof === undefined) dropMeta.run("eof");
        else setMeta.run("eof", JSON.stringify(InsightsEof.parse(file.eof)));
        dropMeta.run("exported");
      });
    },

    closeRun(id, aborted) {
      db.prepare("UPDATE run SET finished_at = started_at, aborted = ? WHERE id = ? AND finished_at IS NULL").run(aborted, id);
    },

    beginRun(start: RunStart): RunHandle {
      return transaction(() => {
        const h = InsightsHeader.parse(start.header);
        const { lastInsertRowid } = db
          .prepare("INSERT INTO run (started_at, pid, provider, leaf, rollup, depth) VALUES (?, ?, ?, ?, ?, ?)")
          .run(start.startedAt, nullable(start.pid), nullable(h.provider), h.models.leaf, h.models.rollup, h.depth);
        setMeta.run("header", JSON.stringify(h));
        // The trailer describes a finished state; until this run ends there is none.
        dropMeta.run("eof");
        return { id: Number(lastInsertRowid) };
      });
    },

    putUnit(run, unitId, unit) {
      transaction(() => {
        for (const record of unit) writeRecord(record, run.id);
        deleteFailure.run(unitId);
      });
    },

    fail(run, failure) {
      writeFailure(failure, run.id);
    },

    finishRun(run, end: RunEnd) {
      transaction(() => {
        const e = InsightsEof.parse(end.eof);
        db.exec("DELETE FROM failure");
        for (const failure of end.failures) writeFailure(failure, run.id);
        setMeta.run("eof", JSON.stringify(e));
        db.prepare(
          "UPDATE run SET finished_at = ?, llm = ?, template = ?, reused = ?, failed = ?, calls = ?, prompt_tokens = ?, completion_tokens = ?, cost = ?, aborted = ? WHERE id = ?",
        ).run(
          e.generatedAt, e.counts.llm, e.counts.template, e.counts.reused, e.counts.failed, nullable(end.calls),
          e.usage.promptTokens, e.usage.completionTokens, nullable(e.usage.cost), nullable(end.aborted), run.id,
        );
      });
    },

    *export() {
      const h = header();
      if (h === undefined) throw new InsightsStoreError("the insights store is empty: there is nothing to export");
      yield JSON.stringify(h);
      // A chunk of consecutive ids at a time: the side-car never has to exist in memory (M16b).
      const ids = orderedIds();
      for (let start = 0; start < ids.length; start += GET_CHUNK) {
        for (const record of get(ids.slice(start, start + GET_CHUNK))) yield JSON.stringify(record);
      }
      for (const failure of failures()) yield JSON.stringify(failure);
      const e = eof();
      if (e !== undefined) yield JSON.stringify(e);
    },

    markExported(stamp) {
      setMeta.run("exported", JSON.stringify({ path: stamp.path, size: stamp.size, mtimeMs: stamp.mtimeMs }));
    },

    close() {
      db.close();
    },
  };
}
