import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEP_VIEW_SQL,
  HELPER_VIEWS_SQL,
  NODE_VIEW_SQL,
  STORE_OPEN_OPTIONS,
  createHelperViews,
  hydrateModel,
  importModel,
  loadSqlite,
  openStore,
  type SqliteDatabase,
} from "../src/index.js";

/**
 * THE TWO HELPER VIEWS HAVE ONE DEFINITION (PLAN.md §24.4).
 *
 * `node` and `dep` are what every hand-written query over the store starts
 * from: `node.id` is the rendered id every report prints, `dep` is an edge with
 * its names resolved. They were three pasted copies in the documentation; they
 * are now this module's constants, which `codegraph query` creates and the
 * documentation is pinned to (the CLI's `helper-views-docs.test.ts`).
 *
 * What is held here is what a reader of ANY language's store relies on:
 *
 *  - `node.id` is `renderId`, entity for entity — five extractors, five
 *    disambiguator conventions, one expression;
 *  - `dep` loses no edge and invents none;
 *  - creating them writes nothing: they live in the connection's temp schema.
 */

const LANGUAGES = ["java", "csharp", "typescript", "elixir", "ruby"] as const;

function fixture(lang: string): string {
  return fileURLToPath(new URL(`../../../fixtures/${lang}/expected/model.jsonl`, import.meta.url));
}

const scratch = mkdtempSync(join(tmpdir(), "codegraph-helper-views-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function storeOf(lang: string): string {
  const path = join(scratch, `${lang}.db`);
  importModel(fixture(lang), path);
  return path;
}

function readOnly(path: string): SqliteDatabase {
  return loadSqlite().open(path, { ...STORE_OPEN_OPTIONS, readOnly: true });
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the helper views: one definition", () => {
  it("is the two statements, node then dep, and nothing else", () => {
    expect(NODE_VIEW_SQL.startsWith("CREATE TEMP VIEW node AS")).toBe(true);
    expect(DEP_VIEW_SQL.startsWith("CREATE TEMP VIEW dep AS")).toBe(true);
    expect(NODE_VIEW_SQL.trimEnd().endsWith(";")).toBe(true);
    expect(DEP_VIEW_SQL.trimEnd().endsWith(";")).toBe(true);
    expect(HELPER_VIEWS_SQL).toBe(`${NODE_VIEW_SQL}\n\n${DEP_VIEW_SQL}\n`);
  });

  it.each(LANGUAGES)("%s: node.id is renderId, entity for entity, in surrogate order", (lang) => {
    const path = storeOf(lang);
    const store = openStore(path);
    const expected = hydrateModel(store).entities.map((entity) => entity.id);
    store.close();
    expect(expected.length, "a fixture with no entity proves nothing").toBeGreaterThan(50);

    const db = readOnly(path);
    try {
      createHelperViews(db);
      const rendered = db.prepare("SELECT id FROM node ORDER BY ref").all().map((row) => row.id);
      expect(rendered).toEqual(expected);
    } finally {
      db.close();
    }
  });

  it.each(LANGUAGES)("%s: dep is the model's edges — none lost, none invented", (lang) => {
    const path = storeOf(lang);
    const store = openStore(path);
    const model = hydrateModel(store);
    store.close();
    const expected = model.edges
      .map((edge) => [edge.from, edge.to, edge.edge, edge.provenance].join(" | "))
      .sort();
    expect(expected.length).toBeGreaterThan(50);

    const db = readOnly(path);
    try {
      createHelperViews(db);
      const rows = db
        .prepare(
          `SELECT f.id AS from_id, t.id AS to_id, d.kind, d.provenance
             FROM dep d JOIN node f ON f.ref = d.from_ref JOIN node t ON t.ref = d.to_ref`,
        )
        .all()
        .map((row) => [row.from_id, row.to_id, row.kind, row.provenance].join(" | "))
        .sort();
      expect(rows).toEqual(expected);
    } finally {
      db.close();
    }
  });

  it("dep carries the anchor the navigator opens: a file and a line", () => {
    const db = readOnly(storeOf("java"));
    try {
      createHelperViews(db);
      const row = db
        .prepare("SELECT file, line FROM dep WHERE kind = 'inheritance' ORDER BY ref LIMIT 1")
        .get();
      expect(row?.file).toMatch(/\.java$/);
      expect(row?.line).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  /**
   * A type whose symbol equals its module's path. Comparing SYMBOLS to decide
   * "is this entity its own module?" renders the class as its own package —
   * two entities, one id. No fixture has a namesake, so one is built here.
   */
  it("keeps a type distinct from a module of the same name", () => {
    const model = join(scratch, "namesake.jsonl");
    const lines = [
      {
        t: "header",
        schemaVersion: "1.0.0",
        lang: "x",
        extractor: { name: "helper-views", version: "0.0.0" },
        root: "/corpus",
        dict: {
          kinds: ["package", "class"],
          traits: ["TNamed", "TModule", "TType", "TChildOf"],
          edges: ["reference"],
          provenance: ["declared"],
        },
      },
      { t: "f", i: 0, path: "A.java" },
      { t: "e", i: 0, k: 0, tr: [0, 1], m: 0, s: "A", name: "A", definedIn: [0], isStub: false },
      { t: "e", i: 1, k: 1, tr: [0, 2, 3], m: 0, s: "A", name: "A", isStub: false, parent: 0 },
      { t: "x", k: 0, f: 1, o: 0, p: 0, anchor: [0, 1, 1] },
      { t: "eof", counts: { files: 1, entities: 2, edges: 1 } },
    ];
    writeFileSync(model, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    const path = join(scratch, "namesake.db");
    importModel(model, path);

    const db = readOnly(path);
    try {
      createHelperViews(db);
      const ids = db.prepare("SELECT id FROM node ORDER BY ref").all().map((row) => row.id);
      expect(ids).toEqual(["x:A", "x:A/A"]);
    } finally {
      db.close();
    }
  });
});

describe("the helper views: created in the connection, never in the store", () => {
  it("leaves the store's bytes untouched on a read-only handle", () => {
    const path = storeOf("java");
    const before = sha(path);
    const db = readOnly(path);
    createHelperViews(db);
    expect(db.prepare("SELECT count(*) AS n FROM node").get()?.n).toBeGreaterThan(0);
    db.close();
    expect(sha(path)).toBe(before);
  });

  it("is gone with the connection: the next one does not see them", () => {
    const path = storeOf("java");
    const first = readOnly(path);
    createHelperViews(first);
    first.close();

    const second = readOnly(path);
    try {
      expect(() => second.prepare("SELECT count(*) FROM node")).toThrow(/no such table: node/);
    } finally {
      second.close();
    }
  });
});
