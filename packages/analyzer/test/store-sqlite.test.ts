import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadSqlite } from "../src/store/sqlite.js";
import { compareIds, sortIds } from "../src/order.js";

/**
 * `loadSqlite` exists to keep ONE fact out of codegraph's interface: that the
 * analysis store happens to be SQLite, and that Node's SQLite is experimental
 * and says so on stderr at every startup.
 *
 * The property is therefore about a STREAM, not about a return value — "loading
 * the binding writes nothing to stderr" — and stderr is only observable in a
 * real process. So the tests that matter here spawn one. Node ≥ 22.18 strips
 * types natively, so a probe can import the module's SOURCE and this suite
 * needs no build, matching the rest of the analyzer's tests (vitest.config.ts).
 *
 * WHAT GUARDS WHAT, since no single test covers the whole rule:
 *
 *  - here: the loader itself is quiet, and puts `process.emitWarning` back;
 *  - here: the CONTROL — a static import of the same builtin is NOT quiet, so
 *    the assertion above cannot pass vacuously on some future Node that stops
 *    warning;
 *  - `source-hygiene.test.ts`: no OTHER source file in the workspace mentions
 *    `node:sqlite`, which is the part a stderr assertion cannot see (a second,
 *    equally quiet loader would break nothing and drift forever);
 *  - `packages/cli/test/e2e-help.test.ts` and friends: the built binary's
 *    stderr is empty. The CLI reaches this module through the analyzer barrel,
 *    so a static import ANYWHERE in that graph fails those too — in fact
 *    harder than expected, because esbuild rewrites `node:sqlite` to `sqlite`
 *    in the bundle and that name does not resolve. Verified by mutation: the
 *    built CLI then cannot start at all.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-sqlite-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MODULE = new URL("../src/store/sqlite.ts", import.meta.url).href;

/**
 * Run a probe in its own process. `.mts` rather than `.ts`: a temp directory
 * has no package.json, so `.ts` would be read as CommonJS and `import` would
 * be a syntax error.
 */
function probe(name: string, source: string): { status: number | null; stdout: string; stderr: string } {
  const path = join(scratch, `${name}.mts`);
  writeFileSync(path, source, "utf8");
  const run = spawnSync(process.execPath, [path], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("loading the SQLite binding is silent", () => {
  it("says nothing on stderr, and works", () => {
    const run = probe(
      "quiet",
      `import { loadSqlite } from ${JSON.stringify(MODULE)};
       const db = loadSqlite().open(":memory:");
       db.exec("create table t(v text)");
       db.prepare("insert into t values (?)").run("ok");
       process.stdout.write(db.prepare("select v from t").get().v);
       db.close();
      `,
    );

    expect(run.stderr, "loading the store must not narrate its implementation").toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("ok");
  });

  /**
   * THE CONTROL. Without this, the assertion above would keep passing on a Node
   * that had stopped warning — the guard would be dead and nothing would say
   * so. This is also the exact failure mode the module's doc comment describes:
   * the import is hoisted above any patch the module body installs.
   */
  it("is not vacuous: a static import of the same builtin does warn", () => {
    const run = probe(
      "static",
      `import { DatabaseSync } from "node:sqlite";
       process.stdout.write(typeof DatabaseSync);
      `,
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("function");
    expect(run.stderr, "node no longer warns — loadSqlite's suppression is now pointless").toMatch(
      /ExperimentalWarning/,
    );
  });

  /**
   * Suppression must last exactly as long as the load. A loader that simply
   * left `process.emitWarning` muted would pass the first test and silently
   * swallow every later deprecation and warning in the process.
   */
  it("restores process.emitWarning, so later warnings still get through", () => {
    const run = probe(
      "restored",
      `import { loadSqlite } from ${JSON.stringify(MODULE)};
       loadSqlite();
       process.emitWarning("a later warning", "ExperimentalWarning");
      `,
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/a later warning/);
    expect(run.stderr, "the SQLite warning leaked out anyway").not.toMatch(/SQLite/);
  });

  it("leaves emitWarning identical, not merely equivalent", () => {
    const before = process.emitWarning;
    loadSqlite();
    expect(process.emitWarning).toBe(before);
  });
});

describe("the binding is a seam, not a re-export", () => {
  it("is memoized, so every caller holds the same implementation", () => {
    expect(loadSqlite()).toBe(loadSqlite());
  });

  /**
   * The interface in `sqlite.ts` is written from the store's needs so that a
   * `better-sqlite3` fallback can later satisfy it at that one site. That is
   * only true if the members it names are the ones actually exercised — so
   * every one of them is used here, `iterate` included: the import and hydrate
   * paths must stream rows, never `all()` a corpus into memory.
   */
  it("supports the whole surface the store was typed against", () => {
    const db = loadSqlite().open(":memory:");
    try {
      db.exec("create table e(i integer primary key, id text not null)");
      const insert = db.prepare("insert into e(i, id) values (?, ?)");
      expect(insert.run(1, "java:a/A").changes).toBe(1);
      insert.run(2, "java:b/B");

      expect(db.prepare("select id from e where i = ?").get(1)).toMatchObject({ id: "java:a/A" });
      expect(db.prepare("select id from e where i = ?").get(99)).toBeUndefined();
      expect(db.prepare("select count(*) as n from e").all()).toMatchObject([{ n: 2 }]);

      const streamed = [...db.prepare("select id from e order by i").iterate()];
      expect(streamed.map((row) => row.id)).toEqual(["java:a/A", "java:b/B"]);
    } finally {
      db.close();
    }
  });
});

/**
 * THE COLLATION CONTRACT, now stated against the real engine.
 *
 * `collation-contract.test.ts` proves the disagreement with `Buffer.compare` —
 * a MODEL of what SQLite does. This is the first step at which an actual SQLite
 * is available, so the claim is worth making against it directly: a BINARY
 * `ORDER BY` really does return the corpus in a different order than canonical.
 *
 * See fixtures/unicode/README.md. The rule: sorting belongs to the model, never
 * to the storage engine.
 */
describe("SQLite's own ordering is not codegraph's ordering", () => {
  const ids = ["Ascii", "\u{20000}Supplementary", "ＡFullwidth"];

  it("returns a different order than compareIds for the same rows", () => {
    const db = loadSqlite().open(":memory:");
    try {
      db.exec("create table t(id text not null)");
      const insert = db.prepare("insert into t values (?)");
      for (const id of ids) insert.run(id);

      const byEngine = [...db.prepare("select id from t order by id").iterate()].map(
        (row) => row.id as string,
      );

      expect(byEngine).not.toEqual(sortIds(ids));
      // And specifically: the engine puts the BMP character first, we do not.
      expect(byEngine[0]).toBe("Ascii");
      expect(byEngine[1]).toBe("ＡFullwidth");
      expect(sortIds(ids)[1]).toBe("\u{20000}Supplementary");
      expect(compareIds("\u{20000}Supplementary", "ＡFullwidth")).toBeLessThan(0);
    } finally {
      db.close();
    }
  });

  /**
   * The consequence, made concrete: a surrogate IS an entity's identity, so
   * reading rows back in the engine's order renumbers the corpus. Ordering by
   * the column the importer wrote in canonical order is what keeps it stable.
   */
  it("is stable again when ordered by the surrogate the importer assigned", () => {
    const db = loadSqlite().open(":memory:");
    try {
      db.exec("create table e(i integer primary key, id text not null)");
      const insert = db.prepare("insert into e(i, id) values (?, ?)");
      sortIds(ids).forEach((id, index) => insert.run(index + 1, id));

      const bySurrogate = [...db.prepare("select id from e order by i").iterate()].map(
        (row) => row.id as string,
      );
      expect(bySurrogate).toEqual(sortIds(ids));
    } finally {
      db.close();
    }
  });
});
