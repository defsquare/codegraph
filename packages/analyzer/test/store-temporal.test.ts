import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Entity, type Model } from "@codegraph/core";

import { cacheStatus, openCache } from "../src/store/cache.js";
import { hydrateModel, openStore } from "../src/store/import.js";
import { loadSqlite } from "../src/store/sqlite.js";
import { STORE_OPEN_OPTIONS } from "../src/store/schema.js";
import {
  TemporalStoreError,
  importModelAt,
  listRevisions,
  readEntityHistory,
  readTimeline,
} from "../src/store/temporal.js";

/**
 * The temporal store (M9b): three snapshots of one tiny corpus, appended with
 * `importModelAt`, and every lifespan below is hand-counted from the story:
 *
 *   rev A (t=1000)  class A (loc 20)   class B (loc 10)   edge A -imports-> B
 *   rev B (t=2000)  A grows to 35      B is GONE          C appears (loc 5), A -> C
 *   rev C (t=3000)  A shrinks to 30                       C grows (loc 8),  A -> C
 *
 * Identity across snapshots is the NATURAL key — no diff heuristics: B's
 * disappearance and C's late birth are pure key-set differences.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-temporal-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40) } as const;

const moduleId = renderId({ lang: "java", module: "app", symbol: "" });
const id = (symbol: string): string => renderId({ lang: "java", module: "app", symbol });

function appModule(): Entity {
  return {
    id: moduleId,
    kind: "package",
    traits: ["TModule"],
    definedIn: ["app/package-info.java"],
    isStub: false,
  } as unknown as Entity;
}

function type(symbol: string, loc: number): Entity {
  return {
    id: id(symbol),
    kind: "class",
    traits: ["TNamed", "TType", "TSourceAnchor"],
    name: symbol,
    isStub: false,
    anchor: { file: `app/${symbol}.java`, span: [1, loc] },
  } as unknown as Entity;
}

function model(entities: Entity[], edges: [string, string][]): Model {
  return {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo",
    entities,
    edges: edges.map(([from, to]) => ({
      edge: "import",
      from: id(from),
      to: id(to),
      provenance: "declared",
      anchor: { file: `app/${from}.java`, span: [1, 1] },
    })),
  } as unknown as Model;
}

const REVISIONS: { sha: string; time: number; model: Model }[] = [
  { sha: SHA.a, time: 1000, model: model([appModule(), type("A", 20), type("B", 10)], [["A", "B"]]) },
  { sha: SHA.b, time: 2000, model: model([appModule(), type("A", 35), type("C", 5)], [["A", "C"]]) },
  { sha: SHA.c, time: 3000, model: model([appModule(), type("A", 30), type("C", 8)], [["A", "C"]]) },
];

function jsonlOf(name: string, snapshot: Model): string {
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, encodeModelToString(snapshot), "utf8");
  return path;
}

/** A store holding all three revisions, freshly built at `name`. */
function buildStore(name: string): string {
  const dbPath = join(scratch, `${name}.db`);
  for (const [index, revision] of REVISIONS.entries()) {
    importModelAt(jsonlOf(`${name}-r${index}`, revision.model), dbPath, {
      sha: revision.sha,
      time: revision.time,
    });
  }
  return dbPath;
}

const storePath = buildStore("story");

function opened<T>(use: (db: ReturnType<typeof openStore>) => T): T {
  const db = openStore(storePath);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

describe("revisions", () => {
  it("holds the three snapshots, chronological", () => {
    const revisions = opened(listRevisions);
    expect(revisions.map((revision) => revision.sha)).toEqual([SHA.a, SHA.b, SHA.c]);
    expect(revisions.map((revision) => revision.time)).toEqual([1000, 2000, 3000]);
  });

  it("refuses the same sha twice — a snapshot is imported once", () => {
    expect(() =>
      importModelAt(jsonlOf("dup", REVISIONS[0]!.model), storePath, { sha: SHA.a, time: 1000 }),
    ).toThrow(TemporalStoreError);
    expect(opened(listRevisions)).toHaveLength(3);
  });

  it("counts itself in meta, so the cache can recognise a temporal store", () => {
    const revisions = opened((db) =>
      db.prepare("SELECT value FROM meta WHERE key = 'revisions'").get(),
    );
    expect(revisions?.value).toBe("3");
  });
});

describe("lifespans, derived at query time", () => {
  it("A lives through all three revisions with the hand-counted LOC series", () => {
    const timeline = opened((db) => readTimeline(db, { module: "app", symbol: "A" }));
    expect(timeline).toBeDefined();
    expect(timeline?.appeared.sha).toBe(SHA.a);
    expect(timeline?.lastSeen.sha).toBe(SHA.c);
    expect(timeline?.presentInLatest).toBe(true);
    expect(timeline?.series.map((point) => point.loc)).toEqual([20, 35, 30]);
    expect(timeline?.series.map((point) => point.kind)).toEqual(["class", "class", "class"]);
  });

  it("B appeared and DISAPPEARED: last seen at rev A, absent from the latest", () => {
    const timeline = opened((db) => readTimeline(db, { module: "app", symbol: "B" }));
    expect(timeline?.appeared.sha).toBe(SHA.a);
    expect(timeline?.lastSeen.sha).toBe(SHA.a);
    expect(timeline?.presentInLatest).toBe(false);
    expect(timeline?.series).toHaveLength(1);
  });

  it("C was born late, at rev B", () => {
    const timeline = opened((db) => readTimeline(db, { module: "app", symbol: "C" }));
    expect(timeline?.appeared.sha).toBe(SHA.b);
    expect(timeline?.presentInLatest).toBe(true);
    expect(timeline?.series.map((point) => point.loc)).toEqual([5, 8]);
  });

  it("answers undefined for a key no revision ever declared", () => {
    expect(opened((db) => readTimeline(db, { module: "app", symbol: "Nowhere" }))).toBeUndefined();
  });
});

describe("edge versions", () => {
  it("records A->B only at rev A, and A->C from rev B on", () => {
    const rows = opened((db) =>
      [...db
        .prepare(
          `SELECT r.sha AS sha, kf.symbol AS f, kt.symbol AS t, e.kind AS kind
           FROM edge_version e
           JOIN revision r ON r.id = e.revision_id
           JOIN entity_key kf ON kf.id = e.from_key
           JOIN entity_key kt ON kt.id = e.to_key
           ORDER BY r.id, kf.symbol, kt.symbol`,
        )
        .iterate()],
    );
    expect(rows.map((row) => [row.sha, row.f, row.t, row.kind])).toEqual([
      [SHA.a, "A", "B", "import"],
      [SHA.b, "A", "C", "import"],
      [SHA.c, "A", "C", "import"],
    ]);
  });
});

describe("the flat tables mirror the latest import", () => {
  it("hydrates to the rev-C model — analyze on the store answers for it", () => {
    const hydrated = opened(hydrateModel);
    expect(hydrated.entities.map((entity) => entity.id).sort()).toEqual(
      [moduleId, id("A"), id("C")].sort(),
    );
    const a = hydrated.entities.find((entity) => entity.id === id("A"));
    expect((a as { anchor?: { span: [number, number] } }).anchor?.span).toEqual([1, 30]);
  });
});

describe("keys are shared across revisions", () => {
  it("interns one entity_key per identity, however many revisions carry it", () => {
    const keys = opened((db) =>
      [...db.prepare("SELECT symbol FROM entity_key ORDER BY id").iterate()].map(
        (row) => row.symbol,
      ),
    );
    // module, A, B from rev A; C added by rev B; nothing new at rev C.
    expect(keys).toEqual(["", "A", "B", "C"]);
  });
});

describe("determinism", () => {
  it("two stores built from the same snapshots dump the same temporal rows", () => {
    const other = buildStore("again");
    const dump = (path: string): unknown => {
      const db = loadSqlite().open(path, { ...STORE_OPEN_OPTIONS, readOnly: true });
      try {
        return {
          revisions: [...db.prepare("SELECT * FROM revision ORDER BY id").iterate()],
          keys: [...db.prepare("SELECT * FROM entity_key ORDER BY id").iterate()],
          entities: [...db
            .prepare("SELECT * FROM entity_version ORDER BY revision_id, key_id")
            .iterate()],
          edges: [...db
            .prepare("SELECT * FROM edge_version ORDER BY revision_id, from_key, to_key")
            .iterate()],
        };
      } finally {
        db.close();
      }
    };
    expect(dump(other)).toEqual(dump(storePath));
  });
});

describe("entity history — the replay city's input", () => {
  it("mirrors every key's LOC series by revision ordinal", () => {
    const history = opened(readEntityHistory);
    expect(history.lang).toBe("java");
    expect(history.revisions.map((revision) => revision.sha)).toEqual([SHA.a, SHA.b, SHA.c]);
    expect(history.revisions.map((revision) => revision.time)).toEqual([1000, 2000, 3000]);

    const bySymbol = new Map(history.entities.map((entity) => [entity.symbol, entity]));
    expect(bySymbol.get("A")?.series).toEqual([[0, 20], [1, 35], [2, 30]]);
    expect(bySymbol.get("B")?.series).toEqual([[0, 10]]);
    expect(bySymbol.get("C")?.series).toEqual([[1, 5], [2, 8]]);
    expect(bySymbol.get("A")?.kind).toBe("class");
    expect(bySymbol.get("A")?.module).toBe("app");
    expect(bySymbol.get("A")?.file).toBe("app/A.java");
    // The module rides along (kind "package"); consumers filter by kind.
    expect(bySymbol.get("")?.kind).toBe("package");
  });

  it("keeps only CORPUS versions: stub revisions are not part of an entity's life", () => {
    // S is a stub at rev 1 (referenced, not declared) and declared at rev 2:
    // its corpus life starts at ordinal 1. X is stub-only and never lives.
    const dbPath = join(scratch, "stubs.db");
    const stub = (symbol: string): Entity =>
      ({ id: id(symbol), kind: "class", traits: ["TNamed", "TType"], name: symbol, isStub: true }) as unknown as Entity;
    importModelAt(
      jsonlOf("stubs-r0", model([appModule(), type("A", 10), stub("S"), stub("X")], [["A", "S"], ["A", "X"]])),
      dbPath,
      { sha: SHA.a, time: 1000 },
    );
    importModelAt(
      jsonlOf("stubs-r1", model([appModule(), type("A", 12), type("S", 7), stub("X")], [["A", "S"], ["A", "X"]])),
      dbPath,
      { sha: SHA.b, time: 2000 },
    );

    const db = openStore(dbPath);
    try {
      const history = readEntityHistory(db);
      const bySymbol = new Map(history.entities.map((entity) => [entity.symbol, entity]));
      expect(bySymbol.get("S")?.series).toEqual([[1, 7]]);
      expect(bySymbol.has("X")).toBe(false);
    } finally {
      db.close();
    }
  });

  /**
   * The replay links a building to the file it stood in AT THE SCRUBBED
   * REVISION, so the remote and the repo-relative root travel with the history
   * while the per-frame commit stays the revision's own sha (M10a DoD).
   */
  it("carries the repository facts of the latest import", () => {
    const dbPath = join(scratch, "repo-facts.db");
    const repository = {
      remote: "https://github.com/acme/demo",
      commit: SHA.a,
      root: "app/src",
    } as const;
    importModelAt(
      jsonlOf("repo-r0", { ...REVISIONS[0]!.model, repository } as Model),
      dbPath,
      { sha: SHA.a, time: 1000 },
    );
    importModelAt(
      jsonlOf("repo-r1", { ...REVISIONS[1]!.model, repository: { ...repository, commit: SHA.b } } as Model),
      dbPath,
      { sha: SHA.b, time: 2000 },
    );

    const db = openStore(dbPath);
    try {
      const history = readEntityHistory(db);
      expect(history.repository?.remote).toBe("https://github.com/acme/demo");
      expect(history.repository?.root).toBe("app/src");
      // Per-frame permalinks come from the revisions, never from this commit.
      expect(history.revisions.map((revision) => revision.sha)).toEqual([SHA.a, SHA.b]);
    } finally {
      db.close();
    }
  });

  it("says nothing when the snapshots knew no repository", () => {
    expect(opened(readEntityHistory).repository).toBeUndefined();
  });
});

describe("the cache never destroys a temporal store", () => {
  it("stands aside instead of regenerating when the model changes", () => {
    const dbPath = join(scratch, "protected.db");
    const jsonl = jsonlOf("protected", REVISIONS[0]!.model);
    importModelAt(jsonl, dbPath, { sha: SHA.a, time: 1000 });

    // Age the model so the store reads as stale.
    const stat = statSync(jsonl);
    utimesSync(jsonl, stat.atime, new Date(stat.mtimeMs + 5000));

    const status = cacheStatus(jsonl, dbPath);
    expect(status.state).toBe("temporal");

    const attempt = openCache(jsonl, dbPath);
    expect(attempt.store).toBeUndefined();
    expect(attempt.reason).toContain("revisions");

    // The revisions are still there — nothing overwrote the file.
    const db = openStore(dbPath);
    try {
      expect(listRevisions(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("still reuses a temporal store that is FRESH for its model", () => {
    const dbPath = join(scratch, "fresh.db");
    const jsonl = jsonlOf("fresh", REVISIONS[0]!.model);
    importModelAt(jsonl, dbPath, { sha: SHA.a, time: 1000 });
    expect(cacheStatus(jsonl, dbPath).state).toBe("fresh");
  });
});
