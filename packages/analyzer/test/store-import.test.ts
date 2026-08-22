import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlError, readModelFileSync, readModelRecordsSync } from "@codegraph/core";

import {
  hydrateModel,
  importModel,
  openStore,
  readStoreRecords,
  storePathFor,
} from "../src/store/import.js";
import { loadSqlite } from "../src/store/sqlite.js";
import { STORE_OPEN_OPTIONS } from "../src/store/schema.js";

/**
 * THE ACID TEST: a cache that loses something is not a cache.
 *
 * The importer is core's record stream written down, and `readStoreRecords` is
 * that read back, so losslessness is stateable as an EQUALITY rather than as a
 * list of things we remembered to check — `[...readStoreRecords(db)]` must equal
 * `[...readModelRecordsSync(path)]`, record for record, key for key. Anything
 * the schema has no home for shows up here as a missing key, including keys no
 * fixture happens to use today, because the comparison is over whole records
 * rather than over the fields someone thought to assert.
 *
 * The second claim is about the FILE, not the rows: an import that dies must
 * leave nothing a later `analyze` would open as a cache. Rows go to a temporary
 * and the rename is the commit.
 */

const fixture = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);
const unicodeFixture = fileURLToPath(
  new URL("../../../fixtures/unicode/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-import-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function importInto(name: string, jsonlPath = fixture): string {
  return importModel(jsonlPath, join(scratch, `${name}.db`)).path;
}

describe("the store holds everything the file said", () => {
  const dbPath = importInto("roundtrip");

  it("hands back the identical record stream", () => {
    const db = openStore(dbPath);
    try {
      const fromStore = [...readStoreRecords(db)];
      const fromFile = [...readModelRecordsSync(fixture)];
      expect(fromStore.length).toBe(fromFile.length);
      // Whole records, so a key the schema forgot fails here rather than
      // silently going missing from an analysis six steps later.
      expect(fromStore).toEqual(fromFile);
    } finally {
      db.close();
    }
  });

  /**
   * And the same claim one level up, through core's own `ModelBuilder` — the
   * very code `readModelFileSync` uses, so a model hydrated from the cache
   * cannot diverge from one read off disk.
   */
  it("hydrates a model equal to the one read from the file", () => {
    const db = openStore(dbPath);
    try {
      expect(hydrateModel(db)).toEqual(readModelFileSync(fixture));
    } finally {
      db.close();
    }
  });

  /**
   * The fixture that exists because SQLite would order these ids differently
   * than the model does (fixtures/unicode/README.md). Ordering by the surrogate
   * the importer assigned is what keeps the corpus from being renumbered — and
   * a renumbered corpus is a repointed one, since a surrogate IS a reference.
   */
  it("survives ids whose canonical order SQLite disagrees with", () => {
    const path = importInto("unicode", unicodeFixture);
    const db = openStore(path);
    try {
      expect([...readStoreRecords(db)]).toEqual([...readModelRecordsSync(unicodeFixture)]);
      expect(hydrateModel(db)).toEqual(readModelFileSync(unicodeFixture));
    } finally {
      db.close();
    }
  });

  it("reports the counts the model declared", () => {
    const result = importModel(fixture, join(scratch, "counted.db"));
    const model = readModelFileSync(fixture);
    expect(result.counts.entities).toBe(model.entities.length);
    expect(result.counts.edges).toBe(model.edges.length);
    expect(result.bytes).toBeGreaterThan(0);
  });
});

/**
 * The keys the Java fixture never produces. Without this the round-trip test
 * above would pass while `space`, `extra` and an empty `comments` array were
 * quietly dropped — it can only compare what the fixture contains.
 */
describe("the keys no fixture exercises", () => {
  /** Rewrite one entity record in the fixture, keeping the file valid. */
  function withFirstEntity(name: string, edit: (record: Record<string, unknown>) => void): string {
    const lines = readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");
    const at = lines.findIndex((line) => line.startsWith('{"t":"e"'));
    const record = JSON.parse(lines[at]!) as Record<string, unknown>;
    edit(record);
    lines[at] = JSON.stringify(record);
    const path = join(scratch, `${name}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  it("keeps a `space` array, which no extractor emits yet", () => {
    const source = withFirstEntity("space", (record) => {
      record["space"] = ["type", "value"];
    });
    const db = openStore(importInto("space", source));
    try {
      expect([...readStoreRecords(db)]).toEqual([...readModelRecordsSync(source)]);
    } finally {
      db.close();
    }
  });

  /**
   * Records are loose by design: an extractor-specific key must survive a round
   * trip rather than be silently stripped. Both real corpora produce none, so
   * this is the only thing standing between `extra` and being dead code.
   */
  it("keeps a key core does not type", () => {
    const source = withFirstEntity("extra", (record) => {
      record["spoonShadow"] = true;
      record["vendorNote"] = { why: "noClasspath" };
    });
    const db = openStore(importInto("extra", source));
    try {
      const back = [...readStoreRecords(db)].find((r) => r.t === "e") as Record<string, unknown>;
      expect(back["spoonShadow"]).toBe(true);
      expect(back["vendorNote"]).toEqual({ why: "noClasspath" });
      expect([...readStoreRecords(db)]).toEqual([...readModelRecordsSync(source)]);
    } finally {
      db.close();
    }
  });

  /**
   * An empty array is not an absent key. `comments: []` has no rows in
   * `entity_comment`, exactly like an entity with no `TComment` — so presence
   * has to come from somewhere else, and it does: the trait set.
   */
  it("tells an empty array from an absent one", () => {
    const source = withFirstEntity("empty-comments", (record) => {
      const traits = record["tr"] as number[];
      record["comments"] = [];
      // TComment is dictionary index 1 in the Java fixture's header.
      if (!traits.includes(1)) traits.push(1);
    });
    const db = openStore(importInto("empty-comments", source));
    try {
      const back = [...readStoreRecords(db)].find((r) => r.t === "e") as Record<string, unknown>;
      expect(back["comments"], "an empty comments array came back absent").toEqual([]);
    } finally {
      db.close();
    }
  });
});

/**
 * `candidates` is the one array-valued key no trait contributes, so the trick
 * that saves the entity lists — presence follows the trait set — has nothing to
 * work with. `edge.candidate_count` exists for exactly this: NULL is absent,
 * 0 is an empty array.
 */
describe("an empty edge candidate list", () => {
  it("comes back empty, not absent", () => {
    const lines = readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");
    const at = lines.findIndex((line) => line.startsWith('{"t":"x"'));
    const record = JSON.parse(lines[at]!) as Record<string, unknown>;
    record["candidates"] = [];
    lines[at] = JSON.stringify(record);
    const source = join(scratch, "empty-candidates.jsonl");
    writeFileSync(source, `${lines.join("\n")}\n`, "utf8");

    const db = openStore(importInto("empty-candidates", source));
    try {
      const back = [...readStoreRecords(db)].filter((r) => r.t === "x");
      expect((back[0] as Record<string, unknown>)["candidates"]).toEqual([]);
      expect([...readStoreRecords(db)]).toEqual([...readModelRecordsSync(source)]);
    } finally {
      db.close();
    }
  });
});

describe("a failed import leaves nothing behind", () => {
  /**
   * The step-3 hazard one level up. A killed writer must not leave a database
   * that opens cleanly and holds half a corpus — so the rows go to a temporary
   * and the rename IS the commit.
   */
  it("writes no database when the model is unreadable", () => {
    const lines = readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");
    // Truncated: every line still parses as JSON, only the trailer is gone.
    const broken = join(scratch, "truncated.jsonl");
    writeFileSync(broken, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
    const target = join(scratch, "never-written.db");

    expect(() => importModel(broken, target)).toThrow(JsonlError);
    expect(existsSync(target), "a partial database was left where a cache would be found").toBe(
      false,
    );
  });

  it("leaves no temporary files either", () => {
    const strays = readdirSync(scratch).filter((name) => name.includes(".tmp-"));
    expect(strays).toEqual([]);
  });

  /**
   * THE PROPERTY THAT DISTINGUISHES A RENAME FROM A CLEANUP, and the one a user
   * feels. Writing straight to the target and deleting it on failure also
   * "leaves no database" — the test above passes either way, which mutation
   * testing showed. What it cannot survive is a re-import over a cache that
   * already works: a direct writer destroys the good cache before it knows the
   * new one will succeed, so a failed refresh costs the user the cache they had.
   *
   * It is also the testable half of the crash story. A killed process never runs
   * cleanup at all, and then a direct writer leaves a half-written `model.db`
   * that opens perfectly well and holds part of a corpus.
   */
  it("keeps the previous cache when a re-import fails", () => {
    const target = join(scratch, "refresh.db");
    importModel(fixture, target);
    const before = readFileSync(target);

    const lines = readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");
    const broken = join(scratch, "broken-refresh.jsonl");
    writeFileSync(broken, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

    expect(() => importModel(broken, target)).toThrow(JsonlError);

    expect(existsSync(target), "the working cache was destroyed by a failed refresh").toBe(true);
    expect(readFileSync(target).equals(before)).toBe(true);
    const db = openStore(target);
    try {
      expect(hydrateModel(db)).toEqual(readModelFileSync(fixture));
    } finally {
      db.close();
    }
  });

  it("refuses to open a store that does not exist", () => {
    expect(() => openStore(join(scratch, "absent.db"))).toThrow();
  });
});

/**
 * The fixture is 167 entities. Everything that has actually broken in this
 * project broke at corpus scale and was invisible below it (`scale.test.ts`),
 * so the round trip is stated once more at a size where prepared statements are
 * reused tens of thousands of times and the interning map has to hold up.
 *
 * Measured on apache/fineract (241 101 entities / 782 046 edges), which is too
 * slow for this suite: import 9.0s at 289MB peak — 133.7MB of JSONL becomes
 * 169.8MB of database — and all 1 029 842 records come back identical.
 */
describe("at a size the fixture cannot reach", () => {
  const SIZE = 20_000;

  function bigModel(): string {
    const dict = {
      kinds: ["package", "class"],
      traits: ["TNamed", "TModule", "TType", "TChildOf", "TSourceAnchor"],
      edges: ["reference"],
      provenance: ["declared"],
    };
    const lines = [
      JSON.stringify({
        t: "header",
        schemaVersion: "1.0.0",
        lang: "java",
        extractor: { name: "scale", version: "0.0.0" },
        root: "/corpus",
        dict,
      }),
      JSON.stringify({ t: "f", i: 0, path: "M.java" }),
      JSON.stringify({ t: "e", i: 0, k: 0, tr: [0, 1], m: 0, s: "m", name: "m", definedIn: [0], isStub: false }),
    ];
    for (let i = 1; i <= SIZE; i += 1) {
      lines.push(
        JSON.stringify({
          t: "e", i, k: 1, tr: [0, 2, 3, 4], m: 0, s: `T${i}`,
          name: `T${i}`, isStub: false, parent: 0, anchor: [0, i, i],
        }),
      );
    }
    for (let i = 1; i < SIZE; i += 1) {
      lines.push(JSON.stringify({ t: "x", k: 0, f: i, o: i + 1, p: 0, anchor: [0, i, i] }));
    }
    lines.push(
      JSON.stringify({ t: "eof", counts: { files: 1, entities: SIZE + 1, edges: SIZE - 1 } }),
    );
    const path = join(scratch, "big.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  it("round-trips a corpus-shaped model", () => {
    const source = bigModel();
    const result = importModel(source, join(scratch, "big.db"));
    expect(result.counts.entities).toBe(SIZE + 1);

    const db = openStore(result.path);
    try {
      // Streamed, not collected: holding both sides would say nothing about
      // whether the reader holds the corpus, which is the property that matters.
      const fromStore = readStoreRecords(db);
      let n = 0;
      for (const expected of readModelRecordsSync(source)) {
        const actual = fromStore.next();
        expect(actual.done, `store ran out after ${n} records`).toBe(false);
        expect(actual.value, `record ${n}`).toEqual(expected);
        n += 1;
      }
      expect(fromStore.next().done, "the store had extra records").toBe(true);
      expect(n).toBe(SIZE + 1 + (SIZE - 1) + 3);
    } finally {
      db.close();
    }
    // Deliberately heavy: ~0.4s alone, but `pnpm -r test` runs several
    // packages' workers on one machine and it has exceeded the 5s default
    // under that contention. A test that fails on a busy CI box and passes on
    // a quiet one teaches nobody anything, so the budget is stated.
  }, 30_000);

  /** Two interning maps, however many entities: MM-4, at scale. */
  it("still interns two trait sets across 20 000 entities", () => {
    const db = openStore(join(scratch, "big.db"));
    try {
      expect(db.prepare("SELECT count(*) AS n FROM trait_set").get()?.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("the importer's own decisions", () => {
  it("names the database after the model", () => {
    expect(basename(storePathFor("/tmp/x/fineract.jsonl"))).toBe("fineract.db");
    // Not `.jsonl.db`, and not a blanket string replace that could produce
    // `.jsonll` — a mistake this project has actually made.
    expect(storePathFor("/tmp/x/model.jsonl")).toBe("/tmp/x/model.db");
    expect(storePathFor("/tmp/x/model.txt")).toBe("/tmp/x/model.txt.db");
  });

  /**
   * MM-4, as rows: the interned set is the memoization key core's profile
   * validator already uses, and there must be far fewer of them than entities
   * or the interning is pointless.
   */
  it("interns trait sets instead of one row per entity per trait", () => {
    const db = openStore(importInto("traits"));
    try {
      const sets = db.prepare("SELECT count(*) AS n FROM trait_set").get()?.n as number;
      const entities = db.prepare("SELECT count(*) AS n FROM entity").get()?.n as number;
      expect(sets).toBeGreaterThan(1);
      expect(sets).toBeLessThan(entities / 5);
    } finally {
      db.close();
    }
  });

  /** Nothing renumbered: the ids in the database are the model's surrogates. */
  it("stores the model's own surrogates, not fresh row ids", () => {
    const db = openStore(importInto("ids"));
    try {
      const first = db.prepare("SELECT min(id) AS lo, max(id) AS hi FROM entity").get()!;
      const model = readModelFileSync(fixture);
      expect(first.lo).toBe(0);
      expect(first.hi).toBe(model.entities.length - 1);
    } finally {
      db.close();
    }
  });

  it("opens the store read-only, so an analysis cannot mutate its cache", () => {
    const db = openStore(importInto("readonly"));
    try {
      expect(() => db.exec("DELETE FROM entity")).toThrow();
    } finally {
      db.close();
    }
  });

  /**
   * The declarations are unenforced by choice (schema.ts), so this is the
   * standing audit that they nonetheless hold on real imported data.
   */
  it("produces a cache that passes a foreign-key audit", () => {
    const path = importInto("audit");
    const db = loadSqlite().open(path, STORE_OPEN_OPTIONS);
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
