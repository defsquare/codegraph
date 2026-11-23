import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELPER_VIEWS_SQL, importModel } from "@codegraph/analyzer";
import { DEFAULT_QUERY_LIMIT, parseInvocation, UsageError, type QueryOptions } from "../src/args.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { runSync } from "../src/main.js";
import { parseCsv } from "./artifact-grammar.js";

/**
 * `codegraph query`: SQL over a model's store, with no `sqlite3` on the
 * machine (PLAN.md §24.4).
 *
 * The engine — one statement, a keyword that reads, bound parameters — is the
 * analyzer's and is tested there (`store-query.test.ts`). What is checked here
 * is the COMMAND: what it accepts on a command line, where each byte goes
 * (rows on stdout, everything else on stderr), the three output forms saying
 * the same thing, the exit code of every refusal, and that a run leaves the
 * disk as it found it apart from the cache every reading command writes.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "codegraph-query-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A private copy of the fixture: the command writes the cache beside its model. */
const MODEL = join(scratch, "app.jsonl");
const STORE = join(scratch, "app.db");
beforeAll(() => {
  copyFileSync(FIXTURE, MODEL);
  importModel(MODEL, STORE);
});

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function query(...argv: string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = runSync(["query", ...argv], io);
  return { io, code };
}

function parsed(...argv: string[]): QueryOptions {
  const invocation = parseInvocation(["query", ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "query") throw new Error("not a query invocation");
  return invocation.options;
}

function usageError(...argv: string[]): UsageError {
  try {
    parseInvocation(["query", ...argv]);
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error(`expected a usage error for: query ${argv.join(" ")}`);
}

const KINDS = "SELECT kind, count(*) AS n FROM node WHERE is_stub = 0 GROUP BY kind ORDER BY n DESC, kind";

describe("query: the command line", () => {
  it("takes the model, then the statement", () => {
    expect(parsed("app.jsonl", "SELECT 1")).toEqual({
      views: false,
      model: "app.jsonl",
      sql: "SELECT 1",
      file: undefined,
      params: {},
      paramFiles: {},
      limit: DEFAULT_QUERY_LIMIT,
      format: "table",
    });
  });

  it("reads the statement from --file, with parameters by name", () => {
    expect(
      parsed("app.jsonl", "--file", "reach.sql", "--param", "id=java:a/B.c(int)", "--param", "n=3", "--json"),
    ).toEqual({
      views: false,
      model: "app.jsonl",
      sql: undefined,
      file: "reach.sql",
      params: { id: "java:a/B.c(int)", n: "3" },
      paramFiles: {},
      limit: DEFAULT_QUERY_LIMIT,
      format: "json",
    });
  });

  it("splits a parameter at its FIRST '=', and accepts the colon", () => {
    expect(parsed("m", "SELECT :a, :b", "--param", "a=x=y", "--param", ":b=").params).toEqual({ a: "x=y", b: "" });
  });

  it("--param-file names a file whose whole text is the value", () => {
    const options = parsed("m", "SELECT :rows, :id", "--param-file", "rows=queries/10-saved.json", "--param", "id=x");
    expect(options.paramFiles).toEqual({ rows: "queries/10-saved.json" });
    expect(options.params).toEqual({ id: "x" });
    // A path may hold an '=': the name ends at the first one.
    expect(parsed("m", "SELECT :a", "--param-file", ":a=dir=1/f.json").paramFiles).toEqual({ a: "dir=1/f.json" });
  });

  it("--limit N keeps N rows; --all keeps every one", () => {
    expect(parsed("m", "SELECT 1", "--limit", "5").limit).toBe(5);
    expect(parsed("m", "SELECT 1", "--all").limit).toBeUndefined();
    expect(parsed("m", "SELECT 1", "--csv").format).toBe("csv");
  });

  it("--views stands alone and reads no model", () => {
    expect(parsed("--views")).toMatchObject({ views: true, model: undefined, sql: undefined });
    expect(usageError("--views", "app.jsonl").message).toContain("--views");
    expect(usageError("--views", "--json").message).toContain("--views");
    expect(usageError("--views", "--param-file", "a=f").message).toContain("--param-file");
  });

  it.each([
    ["no model", [], "model.jsonl"],
    ["no statement", ["app.jsonl"], "--file"],
    ["a statement twice", ["app.jsonl", "SELECT 1", "--file", "q.sql"], "--file"],
    ["two output forms", ["app.jsonl", "SELECT 1", "--json", "--csv"], "--csv"],
    ["--all with --limit", ["app.jsonl", "SELECT 1", "--all", "--limit", "3"], "--all"],
    ["a limit of zero", ["app.jsonl", "SELECT 1", "--limit", "0"], "--limit"],
    ["a parameter with no '='", ["app.jsonl", "SELECT :a", "--param", "a"], "NAME=VALUE"],
    ["a parameter with no name", ["app.jsonl", "SELECT :a", "--param", "=x"], "NAME=VALUE"],
    ["a parameter name that is not a word", ["app.jsonl", "SELECT 1", "--param", "a b=x"], "NAME=VALUE"],
    ["one parameter twice", ["app.jsonl", "SELECT :a", "--param", "a=1", "--param", "a=2"], "twice"],
    ["a parameter file with no '='", ["app.jsonl", "SELECT :a", "--param-file", "a"], "NAME=FILE"],
    ["a parameter file with no file", ["app.jsonl", "SELECT :a", "--param-file", "a="], "NAME=FILE"],
    ["one parameter file twice", ["app.jsonl", "SELECT :a", "--param-file", "a=f", "--param-file", "a=g"], "twice"],
    ["one parameter as a value and as a file", ["app.jsonl", "SELECT :a", "--param", "a=1", "--param-file", "a=f"], "twice"],
  ])("refuses %s", (_label, argv, names) => {
    const error = usageError(...argv);
    expect(`${error.message}\n${error.hint ?? ""}`).toContain(names);
  });

  it("says to quote a statement the shell split into words", () => {
    const error = usageError("app.jsonl", "SELECT", "1");
    expect(error.message).toContain("3");
    expect(error.hint ?? "").toMatch(/quote/i);
  });

  it("documents both arguments in its usage line", () => {
    const { io, code } = query("--help");
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("usage: codegraph query <model.jsonl> [sql]");
    expect(io.stdout()).toContain("--param NAME=VALUE");
    expect(io.stdout()).toContain("--param-file NAME=FILE");
    expect(io.stdout()).toContain(`default: ${DEFAULT_QUERY_LIMIT}`);
  });
});

describe("query: the table", () => {
  it("prints an aligned table on stdout, and nothing else there", () => {
    const { io, code } = query(MODEL, KINDS);
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()).toEqual([
      "kind            n",
      "-------------  --",
      "method         43",
      "parameter      35",
      "attribute      21",
      "constructor    19",
      "class          14",
      "lambda          6",
      "localVariable   6",
      "package         3",
      "interface       2",
      "annotation      1",
      "enum            1",
      "record          1",
    ]);
  });

  it("says which store answered and how many rows, on stderr", () => {
    const { io } = query(MODEL, KINDS);
    expect(io.stderrLines()).toEqual([`cache: ${STORE}`, "12 rows."]);
  });

  it("is byte-identical across two runs, stderr included", () => {
    const first = query(MODEL, KINDS).io;
    const second = query(MODEL, KINDS).io;
    expect(second.stdout()).toBe(first.stdout());
    expect(second.stderr()).toBe(first.stderr());
  });

  it("prints the header and the count when there is no row", () => {
    const { io, code } = query(MODEL, "SELECT id, kind FROM node WHERE 0");
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()).toEqual(["id  kind", "--  ----"]);
    expect(io.stderr()).toContain("0 rows.");
  });

  it("writes NULL as NULL, and keeps a cell on its line", () => {
    const { io } = query(MODEL, "SELECT NULL AS a, 'two\nlines' AS b, 1.5 AS c");
    expect(io.stdoutLines()).toEqual(["a     b             c", "----  ----------  ---", "NULL  two\\nlines  1.5"]);
  });

  it("gives every number of a column the same decimals, so a share of 6.0 does not read as 6", () => {
    const { io } = query(MODEL, "VALUES (90.9, 1), (6.0, 20), (3.25, 300)");
    expect(io.stdoutLines()).toEqual(["column1  column2", "-------  -------", "  90.90        1", "   6.00       20", "   3.25      300"]);
  });

  it(`cuts at ${DEFAULT_QUERY_LIMIT} rows and says how many there were`, () => {
    const { io, code } = query(MODEL, "SELECT id FROM node ORDER BY ref");
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines().length).toBe(2 + DEFAULT_QUERY_LIMIT);
    expect(io.stderr()).toContain(`${DEFAULT_QUERY_LIMIT} of 179 rows shown`);
    expect(io.stderr()).toContain("--all");
  });

  it("--limit and --all move the cut", () => {
    expect(query(MODEL, "SELECT id FROM node", "--limit", "3").io.stdoutLines().length).toBe(2 + 3);
    const all = query(MODEL, "SELECT id FROM node", "--all").io;
    expect(all.stdoutLines().length).toBe(2 + 179);
    expect(all.stderr()).toContain("179 rows.");
  });
});

describe("query: --json and --csv say what the table says", () => {
  it("--json is one codegraph.queryResult/1 document, a row per line", () => {
    const { io, code } = query(MODEL, KINDS, "--json", "--limit", "2");
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe(
      [
        "{",
        '  "kind": "codegraph.queryResult/1",',
        '  "columns": ["kind", "n"],',
        '  "rows": [',
        '    ["method", 43],',
        '    ["parameter", 35]',
        "  ],",
        '  "total": 12,',
        '  "truncated": true',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("--json with no row is still a document with its columns", () => {
    const { io } = query(MODEL, "SELECT id FROM node WHERE 0", "--json");
    expect(JSON.parse(io.stdout())).toEqual({
      kind: "codegraph.queryResult/1",
      columns: ["id"],
      rows: [],
      total: 0,
      truncated: false,
    });
  });

  it("--json carries NULL, numbers and text as JSON has them", () => {
    const { io } = query(MODEL, "SELECT NULL AS a, 2 AS b, 1.5 AS c, 'x\"y' AS d", "--json");
    expect((JSON.parse(io.stdout()) as { rows: unknown[][] }).rows).toEqual([[null, 2, 1.5, 'x"y']]);
  });

  it("--csv is a header and one line per row, quoted where it must be", () => {
    const { io, code } = query(MODEL, "SELECT id, name, NULL AS missing FROM node WHERE kind = 'method' ORDER BY id", "--csv", "--all");
    expect(code).toBe(EXIT.OK);
    const table = parseCsv(io.stdout());
    expect(table.header).toEqual(["id", "name", "missing"]);
    expect(table.rows.length).toBe(43);
    // An id with a comma in it — two parameters — survives as ONE field.
    const withComma = table.rows.find((row) => table.column(row, "id").includes(","));
    expect(withComma, "the fixture has a method of two parameters").toBeDefined();
    for (const row of table.rows) expect(table.column(row, "missing")).toBe("");
  });

  it("the three forms hold the same rows", () => {
    const sql = "SELECT id, kind FROM node WHERE kind IN ('class', 'interface') AND is_stub = 0 ORDER BY id";
    const json = JSON.parse(query(MODEL, sql, "--json", "--all").io.stdout()) as { rows: string[][] };
    const csv = parseCsv(query(MODEL, sql, "--csv", "--all").io.stdout());
    const table = query(MODEL, sql, "--all").io.stdoutLines().slice(2);
    expect(json.rows.length).toBe(16);
    expect(csv.rows).toEqual(json.rows);
    expect(table.map((line) => line.split(/\s{2,}/))).toEqual(json.rows);
  });
});

describe("query: where the statement and the store come from", () => {
  it("--views prints the two helper views and reads nothing", () => {
    const { io, code } = query("--views");
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe(HELPER_VIEWS_SQL);
    expect(io.stderr()).toBe("");
  });

  it("reads the statement from a file, comments and all", () => {
    const file = join(scratch, "kinds.sql");
    writeFileSync(file, `-- kinds, stubs excluded\n${KINDS};\n`, "utf8");
    const fromFile = query(MODEL, "--file", file).io;
    expect(fromFile.stdout()).toBe(query(MODEL, KINDS).io.stdout());
  });

  it("binds --param by name: an id with parentheses needs no escaping", () => {
    const { io, code } = query(MODEL, "SELECT kind FROM node WHERE id = :id", "--param", "id=java:com.acme.order/Order.discount(int)", "--json");
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(io.stdout()) as { rows: unknown[][] }).rows).toEqual([["method"]]);
  });

  it("binds a parameter that reads as a number as a number, and anything else as text", () => {
    const { io } = query(
      MODEL,
      "SELECT typeof(:i), typeof(:r), typeof(:t), typeof(:e)",
      "--param", "i=-12", "--param", "r=0.5", "--param", "t=12a", "--param", "e=",
      "--json",
    );
    expect((JSON.parse(io.stdout()) as { rows: unknown[][] }).rows).toEqual([["integer", "real", "text", "text"]]);
  });

  /**
   * What `--param-file` is for: one saved result feeds the next statement. The
   * rows a `--json` run wrote are read back with `json_each`, so a walk can
   * build on a file a person can open instead of on a list retyped by hand.
   */
  it("binds --param-file to the whole text of the file: a saved result is read back row for row", () => {
    const saved = join(scratch, "10-kinds.json");
    const first = query(MODEL, KINDS, "--all", "--json").io.stdout();
    writeFileSync(saved, first, "utf8");

    const { io, code } = query(
      MODEL,
      "SELECT json_extract(j.value, '$[0]') AS kind, json_extract(j.value, '$[1]') AS n FROM json_each(:saved, '$.rows') j ORDER BY j.key",
      "--param-file", `saved=${saved}`,
      "--all", "--json",
    );
    expect(code).toBe(EXIT.OK);
    const rows = (text: string): unknown[][] => (JSON.parse(text) as { rows: unknown[][] }).rows;
    expect(rows(io.stdout())).toEqual(rows(first));
    expect(rows(first).length).toBe(12);
  });

  it("binds a file's text as text, whatever it reads as, and joins it with the model", () => {
    const number = join(scratch, "n.txt");
    writeFileSync(number, "42", "utf8");
    const typed = query(MODEL, "SELECT typeof(:n), :n", "--param-file", `n=${number}`, "--json").io.stdout();
    expect((JSON.parse(typed) as { rows: unknown[][] }).rows).toEqual([["text", "42"]]);

    const ids = join(scratch, "ids.json");
    writeFileSync(ids, JSON.stringify(["java:com.acme.order/Order.discount(int)", "java:nowhere/Nothing"]), "utf8");
    const joined = query(
      MODEL,
      "SELECT j.value AS id, n.kind FROM json_each(:ids) j LEFT JOIN node n ON n.id = j.value ORDER BY j.key",
      "--param-file", `ids=${ids}`,
      "--json",
    ).io.stdout();
    expect((JSON.parse(joined) as { rows: unknown[][] }).rows).toEqual([
      ["java:com.acme.order/Order.discount(int)", "method"],
      ["java:nowhere/Nothing", null],
    ]);
  });

  it("accepts a model.db itself, and then names no cache", () => {
    const { io, code } = query(STORE, KINDS);
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()[2]).toBe("method         43");
    expect(io.stderrLines()).toEqual(["12 rows."]);
  });

  it("builds the store beside a model that has none", () => {
    const dir = mkdtempSync(join(scratch, "fresh-"));
    const model = join(dir, "m.jsonl");
    copyFileSync(FIXTURE, model);
    const { io, code } = query(model, "SELECT count(*) AS n FROM node");
    expect(code).toBe(EXIT.OK);
    expect(io.stdoutLines()).toEqual(["  n", "---", "179"]);
    expect(existsSync(join(dir, "m.db"))).toBe(true);
  });

  it.runIf(process.getuid?.() !== 0)("answers from a temporary store when none can be written beside the model", () => {
    const dir = mkdtempSync(join(scratch, "readonly-"));
    const model = join(dir, "m.jsonl");
    copyFileSync(FIXTURE, model);
    chmodSync(dir, 0o555);
    try {
      const { io, code } = query(model, "SELECT count(*) AS n FROM node");
      expect(code).toBe(EXIT.OK);
      expect(io.stdoutLines()[2]).toBe("179");
      expect(io.stderr()).toContain("cache: not used");
      expect(readdirSync(dir)).toEqual(["m.jsonl"]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe("query: every refusal is a usage error, and says what to type", () => {
  it.each([
    ["a statement that does not read", "DELETE FROM entity", "SELECT, WITH, VALUES, EXPLAIN"],
    ["VACUUM INTO", `VACUUM INTO '${join(scratch, "copy.db")}'`, "VACUUM"],
    ["two statements", "SELECT 1; SELECT 2", "ONE statement"],
    ["an unknown column", "SELECT nope FROM node", "no such column: nope"],
    ["an unknown table", "SELECT * FROM nodes", "no such table: nodes"],
    ["a parameter nobody gave", "SELECT id FROM node WHERE id = :id", "--param"],
    ["a positional parameter", "SELECT ?", ":name"],
  ])("%s exits 2 with nothing on stdout", (_label, sql, names) => {
    const { io, code } = query(MODEL, sql);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(names);
    expect(io.stderr()).not.toContain("bug in codegraph");
    expect(io.stderr()).not.toMatch(/\n\s+at /);
  });

  it("a parameter the statement does not name exits 2", () => {
    const { io, code } = query(MODEL, "SELECT 1", "--param", "id=x");
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain(":id");
  });

  it("a parameter file that cannot be read, or that the statement does not name, exits 2", () => {
    const absent = join(scratch, "absent.json");
    const unread = query(MODEL, "SELECT :rows", "--param-file", `rows=${absent}`);
    expect(unread.code).toBe(EXIT.USAGE);
    expect(unread.io.stdout()).toBe("");
    expect(unread.io.stderr()).toContain(absent);
    expect(unread.io.stderr()).toContain("--param-file rows");

    const present = join(scratch, "present.json");
    writeFileSync(present, "[]", "utf8");
    const unnamed = query(MODEL, "SELECT 1", "--param-file", `rows=${present}`);
    expect(unnamed.code).toBe(EXIT.USAGE);
    expect(unnamed.io.stderr()).toContain(":rows");
  });

  it("an unreadable model, statement file or foreign database exits 2", () => {
    expect(query(join(scratch, "absent.jsonl"), "SELECT 1").code).toBe(EXIT.USAGE);
    expect(query(MODEL, "--file", join(scratch, "absent.sql")).code).toBe(EXIT.USAGE);

    const foreign = join(scratch, "foreign.db");
    importModel(MODEL, foreign);
    // A real SQLite file that is not a store: the header page of one, alone.
    writeFileSync(foreign, readFileSync(foreign).subarray(0, 16));
    const { io, code } = query(foreign, "SELECT 1");
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("not a codegraph store");
  });

  it("a file that is not a model is a FINDING about the file (exit 3), with the command that says why", () => {
    const dir = mkdtempSync(join(scratch, "broken-"));
    const broken = join(dir, "broken.jsonl");
    writeFileSync(broken, '{"t":"header"}\nnot json\n', "utf8");
    const { io, code } = query(broken, "SELECT 1");
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(`codegraph validate ${broken}`);
  });
});

describe("query writes nothing (PLAN.md §24.9)", () => {
  it("no refused statement leaves a file, and the store is byte for byte what it was", () => {
    const dir = mkdtempSync(join(scratch, "sealed-"));
    mkdirSync(join(dir, "out"));
    const model = join(dir, "m.jsonl");
    copyFileSync(FIXTURE, model);
    expect(query(model, "SELECT 1").code).toBe(EXIT.OK); // builds the cache, once
    const store = join(dir, "m.db");
    const before = sha(store);

    const target = (name: string): string => join(dir, "out", name);
    const attempts = [
      `VACUUM INTO '${target("vacuum.db")}'`,
      `ATTACH DATABASE '${target("attached.db")}' AS other`,
      "PRAGMA writable_schema = ON",
      "CREATE TEMP TABLE t AS SELECT 1 AS a",
      `SELECT 1; VACUUM INTO '${target("tail.db")}'`,
      "/* SELECT */ DELETE FROM entity",
      `-- SELECT 1\nVACUUM INTO '${target("hidden.db")}'`,
      "WITH a AS (SELECT 1) DELETE FROM entity",
    ];
    for (const sql of attempts) {
      const { io, code } = query(model, sql);
      expect(code, sql).toBe(EXIT.USAGE);
      expect(io.stdout(), sql).toBe("");
    }

    expect(readdirSync(join(dir, "out"))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["m.db", "m.jsonl", "out"]);
    expect(sha(store)).toBe(before);
  });
});
