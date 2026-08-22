import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  STORE_OPEN_OPTIONS,
  hydrateModel,
  importModel,
  loadSqlite,
  openStore,
  type SqliteDatabase,
} from "@codegraph/analyzer";

/**
 * THE COOKBOOK IS EXECUTABLE.
 *
 * `docs/sql-cookbook.md` teaches people to query the store directly, which
 * makes it the one document that can be wrong in a way nobody notices: a
 * recipe that stopped matching the schema still LOOKS like SQL, and the reader
 * finds out at a prompt rather than in review. So every ```sql block in the
 * document is extracted and run, in document order, against a store built from
 * the committed fixture.
 *
 * Running is the floor, not the point. Three claims the document makes about
 * agreement with `codegraph` itself are checked as equalities, because those
 * are what a reader is actually trusting:
 *
 *  - the `node` view reproduces `renderId` — every id, in order;
 *  - the cycle recipe finds the modules `analyze --report cycles` finds;
 *  - the fan-in recipe counts what the model's edges say.
 */

const DOC = fileURLToPath(new URL("../../../docs/sql-cookbook.md", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cookbook-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every fenced ```sql block, in the order the document presents them. */
function sqlBlocks(): string[] {
  const markdown = readFileSync(DOC, "utf8");
  const blocks: string[] = [];
  const fence = /```sql\n([\s\S]*?)```/g;
  for (let match = fence.exec(markdown); match !== null; match = fence.exec(markdown)) {
    blocks.push(match[1]!.trim());
  }
  return blocks;
}

function freshStore(name: string): SqliteDatabase {
  const model = join(scratch, `${name}.jsonl`);
  copyFileSync(FIXTURE, model);
  const store = join(scratch, `${name}.db`);
  importModel(model, store);
  return loadSqlite().open(store, { ...STORE_OPEN_OPTIONS, readOnly: true });
}

/** A store with the document's own setup views applied. */
function prepared(name: string): SqliteDatabase {
  const db = freshStore(name);
  // The first two blocks ARE the setup; taking them from the document rather
  // than restating them here is the point — a broken view fails the recipes.
  for (const block of sqlBlocks().slice(0, 2)) db.exec(block);
  return db;
}

describe("every recipe in docs/sql-cookbook.md runs", () => {
  const blocks = sqlBlocks();

  it("finds the recipes to check", () => {
    // A regex that quietly matched nothing would make this whole file pass.
    expect(blocks.length).toBeGreaterThan(12);
    expect(blocks[0]).toContain("CREATE TEMP VIEW node");
    expect(blocks[1]).toContain("CREATE TEMP VIEW dep");
  });

  it("runs all of them against a real store, in document order", () => {
    const db = freshStore("run-all");
    try {
      const failures: string[] = [];
      for (const [index, block] of blocks.entries()) {
        try {
          if (block.startsWith("CREATE")) db.exec(block);
          else db.prepare(block).all();
        } catch (error) {
          const first = block.split("\n")[0];
          failures.push(
            `block ${index} (${first}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * A recipe that runs and returns nothing teaches nothing. Not every one can
   * produce rows on a 167-entity fixture — it has no cycles and no uncertain
   * dispatch, which is what a conforming corpus looks like — so the floor is
   * stated as a proportion rather than pretended to be all of them.
   */
  it("most of them return rows on the fixture", () => {
    const db = prepared("rows");
    try {
      const selects = blocks.filter((block) => !block.startsWith("CREATE"));
      const withRows = selects.filter((block) => db.prepare(block).all().length > 0);
      expect(withRows.length).toBeGreaterThanOrEqual(selects.length - 2);
    } finally {
      db.close();
    }
  });
});

describe("the claims the cookbook makes about agreeing with codegraph", () => {
  /**
   * The document says `node.id` "reproduces `renderId` exactly". That is the
   * claim every other recipe rests on — an id that renders wrong makes every
   * answer on the page name the wrong thing — so it is compared element by
   * element against the model the analyzer builds, in canonical order.
   */
  it("renders the same ids as the analyzer, in the same order", () => {
    const model = join(scratch, "ids.jsonl");
    copyFileSync(FIXTURE, model);
    const storePath = join(scratch, "ids.db");
    importModel(model, storePath);

    const store = openStore(storePath);
    const expected = hydrateModel(store).entities.map((entity) => entity.id);
    store.close();

    const db = prepared("ids-view");
    try {
      const rendered = db
        .prepare("SELECT id FROM node ORDER BY ref")
        .all()
        .map((row) => row.id as string);
      expect(rendered).toEqual(expected);
    } finally {
      db.close();
    }
  });

  /**
   * A corpus where a TYPE's symbol is identical to its MODULE's path.
   *
   * The `node` view decides "is this entity its own module?" to know whether
   * the symbol slot holds the module path or a symbol below it. Comparing the
   * two SYMBOLS looks equivalent and is not: for a namesake it renders the
   * class AS its own package, so two entities share one id and every recipe on
   * the page silently names the wrong thing.
   *
   * Found by mutation, twice — the same hazard survived the analyzer's parity
   * suite in step 7 and would have survived this file too. No real fixture has
   * a namesake, so the corpus is built here.
   */
  it("keeps a type distinct from a module of the same name", () => {
    const namesake = join(scratch, "namesake.jsonl");
    const lines = [
      {
        t: "header",
        schemaVersion: "1.0.0",
        lang: "x",
        extractor: { name: "cookbook", version: "0.0.0" },
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
    writeFileSync(namesake, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const storePath = join(scratch, "namesake.db");
    importModel(namesake, storePath);
    const store = openStore(storePath);
    const expected = hydrateModel(store).entities.map((entity) => entity.id);
    store.close();
    expect(expected, "the corpus itself must hold two distinct ids").toEqual(["x:A", "x:A/A"]);

    const db = loadSqlite().open(storePath, { ...STORE_OPEN_OPTIONS, readOnly: true });
    try {
      db.exec(sqlBlocks()[0]!);
      const rendered = db
        .prepare("SELECT id FROM node ORDER BY ref")
        .all()
        .map((row) => row.id as string);
      expect(rendered, "the cookbook's view collapsed a type onto its package").toEqual(expected);
    } finally {
      db.close();
    }
  });

  /**
   * Fan-in is the headline recipe. It is checked against the edges themselves
   * rather than against another query, so a mistake in the join cannot agree
   * with itself.
   */
  it("counts fan-in the way the model's edges do", () => {
    const model = join(scratch, "fanin.jsonl");
    copyFileSync(FIXTURE, model);
    const storePath = join(scratch, "fanin.db");
    importModel(model, storePath);

    const store = openStore(storePath);
    const hydrated = hydrateModel(store);
    store.close();

    const byTarget = new Map<string, number>();
    for (const edge of hydrated.edges) {
      byTarget.set(edge.to, (byTarget.get(edge.to) ?? 0) + 1);
    }
    const top = [...byTarget.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5);

    const db = prepared("fanin-view");
    try {
      const recipe = sqlBlocks().find((block) => block.includes("AS fan_in"))!;
      const rows = db.prepare(recipe).all().slice(0, 5);
      expect(rows.map((row) => [row.id, row.fan_in])).toEqual(top);
    } finally {
      db.close();
    }
  });

  /**
   * The cycle recipe's answer must be the set of modules the analyzer places in
   * a strongly connected component. The fixture has none — which is itself the
   * assertion: a recipe that reported cycles on an acyclic corpus would be
   * worse than one that reported none on a cyclic one.
   */
  it("finds no module cycle where the analyzer finds none", () => {
    const db = prepared("cycles");
    try {
      const recipe = sqlBlocks().find((block) => block.includes("module_in_a_cycle"))!;
      expect(db.prepare(recipe).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
