import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QUERY_STATEMENT_KEYWORDS,
  QueryRefused,
  STORE_OPEN_OPTIONS,
  createHelperViews,
  importModel,
  loadSqlite,
  queryStore,
  statementShape,
  type QueryRefusal,
  type SqliteDatabase,
} from "../src/index.js";

/**
 * ONE READ-ONLY STATEMENT (PLAN.md §24.4, §24.9).
 *
 * `queryStore` is what `codegraph query` runs: text a person or an agent
 * wrote, over a store. Two things make that safe to hand to an agent, and a
 * read-only handle is only one of them — measured before this was written, a
 * handle opened `readOnly` still lets `VACUUM INTO 'file'` write a copy of the
 * database anywhere on disk. So the text is checked too: ONE statement, and it
 * begins with a keyword that reads.
 *
 * The second half of this file is the other thing a caller is trusting: that
 * a parameter is BOUND (an id holds parentheses, commas and, in Ruby, quotes),
 * that a parameter nobody gave is an error rather than a silent NULL — which
 * would print zero rows and read as "there are none" — and that the answer
 * says how many rows there were when it shows only some.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "codegraph-store-query-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const STORE = join(scratch, "model.db");
let db: SqliteDatabase;

beforeAll(() => {
  importModel(FIXTURE, STORE);
  db = loadSqlite().open(STORE, { ...STORE_OPEN_OPTIONS, readOnly: true });
  createHelperViews(db);
});
afterAll(() => db.close());

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function refusal(sql: string, params?: Record<string, string | number>): QueryRefusal | "accepted" {
  try {
    queryStore(db, sql, params === undefined ? {} : { params });
    return "accepted";
  } catch (error) {
    if (error instanceof QueryRefused) return error.reason;
    throw error;
  }
}

describe("statementShape: what the text is, without running it", () => {
  it("names the first keyword, whatever precedes it", () => {
    expect(statementShape("select 1").keyword).toBe("SELECT");
    expect(statementShape("  \n\t WITH a AS (SELECT 1) SELECT * FROM a").keyword).toBe("WITH");
    expect(statementShape("-- a header\n-- two lines\nVALUES (1)").keyword).toBe("VALUES");
    expect(statementShape("/* block\n comment */ explain query plan select 1").keyword).toBe("EXPLAIN");
  });

  it("is not fooled by a comment that hides the real verb", () => {
    expect(statementShape("/* SELECT */ DELETE FROM entity").keyword).toBe("DELETE");
    expect(statementShape("-- SELECT 1\nVACUUM INTO 'x'").keyword).toBe("VACUUM");
  });

  it("reports an empty text as having no keyword", () => {
    expect(statementShape("").keyword).toBe("");
    expect(statementShape("  -- only a comment\n").keyword).toBe("");
    expect(statementShape(";").keyword).toBe("");
  });

  it("names a first token that is not a word", () => {
    expect(statementShape("(SELECT 1)").keyword).toBe("(");
  });

  it("sees a second statement, and only a real one", () => {
    expect(statementShape("SELECT 1").hasTail).toBe(false);
    expect(statementShape("SELECT 1;").hasTail).toBe(false);
    expect(statementShape("SELECT 1;\n  -- done\n").hasTail).toBe(false);
    expect(statementShape("SELECT 1; /* nothing */ ;").hasTail).toBe(false);
    expect(statementShape("SELECT 1; DELETE FROM entity").hasTail).toBe(true);
    expect(statementShape("SELECT 1;SELECT 2").hasTail).toBe(true);
  });

  it("does not split on a semicolon inside a literal, an identifier or a comment", () => {
    expect(statementShape("SELECT 'a; DELETE FROM entity'").hasTail).toBe(false);
    expect(statementShape("SELECT 'it''s; here' AS x").hasTail).toBe(false);
    expect(statementShape('SELECT 1 AS "a;b"').hasTail).toBe(false);
    expect(statementShape("SELECT 1 AS `a;b`").hasTail).toBe(false);
    expect(statementShape("SELECT 1 AS [a;b]").hasTail).toBe(false);
    expect(statementShape("SELECT 1 -- ; DELETE FROM entity").hasTail).toBe(false);
    expect(statementShape("SELECT 1 /* ; DELETE */").hasTail).toBe(false);
  });

  it("lists the named parameters once each, in order of first use", () => {
    const shape = statementShape("SELECT :a, :b_2, :a FROM node WHERE id = :id");
    expect(shape.params).toEqual(["a", "b_2", "id"]);
    expect(shape.foreignParams).toEqual([]);
  });

  it("finds no parameter inside a literal, an identifier or a comment", () => {
    expect(statementShape("SELECT ':x', \":y\", [:z] -- :w\n /* :v */").params).toEqual([]);
  });

  it("names the parameter spellings it will not bind", () => {
    expect(statementShape("SELECT ?, ?2, @name, $other").foreignParams).toEqual(["?", "?2", "@name", "$other"]);
  });
});

describe("queryStore: what it refuses", () => {
  it("accepts exactly the four keywords that read", () => {
    expect([...QUERY_STATEMENT_KEYWORDS]).toEqual(["SELECT", "WITH", "VALUES", "EXPLAIN"]);
    expect(refusal("SELECT 1")).toBe("accepted");
    expect(refusal("WITH a(x) AS (VALUES (1)) SELECT x FROM a")).toBe("accepted");
    expect(refusal("VALUES (1), (2)")).toBe("accepted");
    expect(refusal("EXPLAIN QUERY PLAN SELECT * FROM node")).toBe("accepted");
  });

  it("refuses an empty text", () => {
    expect(refusal("")).toBe("empty");
    expect(refusal("-- nothing here")).toBe("empty");
  });

  // PLAN.md §24.9, first row. Each of these gets through a read-only handle or
  // would mislead if it silently did nothing.
  it.each([
    ["VACUUM INTO, which a read-only handle allows", `VACUUM INTO '${join(scratch, "copy.db")}'`],
    ["ATTACH", `ATTACH DATABASE '${join(scratch, "attached.db")}' AS other`],
    ["PRAGMA writable_schema", "PRAGMA writable_schema = ON"],
    ["CREATE TEMP TABLE", "CREATE TEMP TABLE t AS SELECT 1 AS a"],
    ["DELETE", "DELETE FROM entity"],
    ["DROP VIEW", "DROP VIEW node"],
    ["a comment hiding a DELETE", "/* SELECT */ DELETE FROM entity"],
    ["a line comment hiding a VACUUM", `-- SELECT 1\nVACUUM INTO '${join(scratch, "copy2.db")}'`],
  ])("refuses %s as not read-only", (_label, sql) => {
    expect(refusal(sql)).toBe("not-read-only");
  });

  it("refuses two statements rather than running the first and dropping the second", () => {
    expect(refusal("SELECT 1; SELECT 2")).toBe("several-statements");
    expect(refusal(`SELECT 1; VACUUM INTO '${join(scratch, "copy3.db")}'`)).toBe("several-statements");
  });

  it("lets SQLite refuse a write that a WITH introduces", () => {
    expect(refusal("WITH a AS (SELECT 1) DELETE FROM entity")).toBe("sqlite");
    expect(refusal("WITH a AS (SELECT 1) INSERT INTO node(ref) SELECT 1")).toBe("sqlite");
  });

  it("refuses a mistyped verb before SQLite sees it, naming the verbs that read", () => {
    try {
      queryStore(db, "SELEC 1");
      expect.unreachable("a mistyped verb must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryRefused);
      expect((error as QueryRefused).reason).toBe("not-read-only");
      expect((error as QueryRefused).message).toContain("SELECT, WITH, VALUES, EXPLAIN");
      expect((error as QueryRefused).message).toContain("SELEC");
    }
  });

  it("says SQLite's own words for a statement SQLite cannot compile", () => {
    try {
      queryStore(db, "SELECT nope FROM node");
      expect.unreachable("an unknown column must be refused");
    } catch (error) {
      expect((error as QueryRefused).reason).toBe("sqlite");
      expect((error as QueryRefused).message).toContain("no such column: nope");
    }
  });

  it("wrote nothing: no file appeared and the store is byte for byte what it was", () => {
    const before = sha(STORE);
    for (const sql of [
      `VACUUM INTO '${join(scratch, "v.db")}'`,
      `ATTACH DATABASE '${join(scratch, "a.db")}' AS other`,
      "PRAGMA writable_schema = ON",
      "CREATE TEMP TABLE t AS SELECT 1 AS a",
      `SELECT 1; VACUUM INTO '${join(scratch, "v2.db")}'`,
      "/* SELECT */ DELETE FROM entity",
      "WITH a AS (SELECT 1) DELETE FROM entity",
      `EXPLAIN VACUUM INTO '${join(scratch, "v3.db")}'`,
    ]) {
      refusal(sql);
    }
    expect(readdirSync(scratch).sort()).toEqual(["model.db"]);
    expect(existsSync(join(scratch, "v.db"))).toBe(false);
    expect(sha(STORE)).toBe(before);
    // ...and the views this connection holds are still there.
    expect(queryStore(db, "SELECT count(*) AS n FROM node").rows[0]?.[0]).toBeGreaterThan(0);
  });
});

describe("queryStore: parameters are bound, never spliced", () => {
  it("binds an id that holds parentheses and a comma", () => {
    const id = "java:com.acme.order/Order.discount(int)";
    const result = queryStore(db, "SELECT id, kind FROM node WHERE id = :id", { params: { id } });
    expect(result.rows).toEqual([[id, "method"]]);
  });

  it("binds a value that would end the statement if it were pasted in", () => {
    const hostile = "x'; DELETE FROM entity; --";
    const result = queryStore(db, "SELECT :v AS v", { params: { v: hostile } });
    expect(result.rows).toEqual([[hostile]]);
  });

  it("binds a number as a number", () => {
    const result = queryStore(db, "SELECT typeof(:n) AS t, :n + 1 AS next", { params: { n: 41 } });
    expect(result.rows).toEqual([["integer", 42]]);
  });

  it("refuses a parameter the statement names and nobody gave", () => {
    expect(refusal("SELECT id FROM node WHERE id = :id")).toBe("missing-parameter");
    try {
      queryStore(db, "SELECT :a, :b", { params: { a: 1 } });
      expect.unreachable();
    } catch (error) {
      expect((error as QueryRefused).message).toContain(":b");
      expect((error as QueryRefused).message).not.toContain(":a,");
    }
  });

  it("refuses a parameter given that the statement does not name", () => {
    expect(refusal("SELECT 1", { extra: "x" })).toBe("unknown-parameter");
  });

  it("refuses the spellings it does not bind, naming the one it does", () => {
    expect(refusal("SELECT ?")).toBe("foreign-parameter");
    try {
      queryStore(db, "SELECT @id");
      expect.unreachable();
    } catch (error) {
      expect((error as QueryRefused).message).toContain("@id");
      expect((error as QueryRefused).message).toContain(":id");
    }
  });
});

describe("queryStore: the answer", () => {
  it("gives the columns as written, in order, and the rows as arrays", () => {
    const result = queryStore(
      db,
      "SELECT kind, count(*) AS n FROM node WHERE is_stub = 0 GROUP BY kind ORDER BY n DESC, kind",
    );
    expect(result.columns).toEqual(["kind", "n"]);
    expect(result.rows[0]).toEqual(["method", 43]);
    expect(result.total).toBe(result.rows.length);
    expect(result.truncated).toBe(false);
  });

  it("keeps two columns of the same name apart", () => {
    const result = queryStore(db, "SELECT 1 AS a, 2 AS a");
    expect(result.columns).toEqual(["a", "a"]);
    expect(result.rows).toEqual([[1, 2]]);
  });

  it("names the columns of an answer with no row", () => {
    const result = queryStore(db, "SELECT id, kind FROM node WHERE 0");
    expect(result.columns).toEqual(["id", "kind"]);
    expect(result).toMatchObject({ rows: [], total: 0, truncated: false });
  });

  it("cuts at the limit and still counts every row", () => {
    const all = queryStore(db, "SELECT id FROM node ORDER BY ref");
    const cut = queryStore(db, "SELECT id FROM node ORDER BY ref", { limit: 5 });
    expect(all.total).toBeGreaterThan(100);
    expect(cut.rows).toEqual(all.rows.slice(0, 5));
    expect(cut.total).toBe(all.total);
    expect(cut.truncated).toBe(true);
  });

  it("is not truncated when the limit is exactly the row count", () => {
    const all = queryStore(db, "SELECT id FROM node");
    const exact = queryStore(db, "SELECT id FROM node", { limit: all.total });
    expect(exact.truncated).toBe(false);
    expect(exact.rows.length).toBe(all.total);
  });

  it("reads the schema with statements that are themselves SELECTs", () => {
    const tables = queryStore(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
    expect(tables.rows.map((row) => row[0])).toContain("entity");
    const columns = queryStore(db, "SELECT name FROM pragma_table_info('entity')");
    expect(columns.rows.map((row) => row[0])).toContain("module_id");
  });
});
