import { describe, expect, it } from "vitest";
import { EdgeRec, EntityRec } from "@codegraph/core";

import {
  DB_VERSION,
  EDGE_KEY_STORAGE,
  ENTITY_KEY_STORAGE,
  STORE_OPEN_OPTIONS,
  createSchema,
  traitContributedKeys,
} from "../src/store/schema.js";
import { loadSqlite, type SqliteDatabase } from "../src/store/sqlite.js";

/**
 * The DDL is frozen here (PLAN.md §9.3), against a REAL SQLite rather than
 * against its own source text: everything below is read back out of
 * `sqlite_master` and the pragmas after the schema has actually been created,
 * so a statement that parses but does not mean what it looks like cannot pass.
 *
 * Three different kinds of claim live in this file, and they fail for different
 * reasons:
 *
 *  1. the SNAPSHOT — the effective schema, so any DDL edit is a reviewable diff;
 *  2. the INVARIANTS — invariant 4 (no stored inverse) and "the store caches
 *     what the reader accepts" (no second, stricter gate), which are rules the
 *     snapshot would happily record the violation of;
 *  3. the DRIFT GUARD — every key core's wire can carry is accounted for in a
 *     real column of a real table, so adding a trait key to `core` fails the
 *     store until someone decides where it goes.
 */

function fresh(): SqliteDatabase {
  const db = loadSqlite().open(":memory:", STORE_OPEN_OPTIONS);
  createSchema(db);
  return db;
}

function rows<T>(db: SqliteDatabase, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

function columnsOf(db: SqliteDatabase, table: string): string[] {
  return rows<{ name: string }>(db, `pragma table_info(${table})`).map((c) => c.name);
}

/** The effective schema, as SQLite reports it after creating it. */
function digest(db: SqliteDatabase): string {
  const out: string[] = [];
  const tables = rows<{ name: string; sql: string }>(
    db,
    "select name, sql from sqlite_master where type='table' order by name",
  );

  for (const table of tables) {
    const cols = rows<{ name: string; type: string; notnull: number; pk: number }>(
      db,
      `pragma table_info(${table.name})`,
    )
      .map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? ` PK${c.pk}` : ""}`)
      .join(", ");
    out.push(`${table.name}(${cols})${/without\s+rowid/i.test(table.sql) ? " WITHOUT ROWID" : ""}`);

    const indexes = rows<{ name: string; unique: number; origin: string }>(
      db,
      `pragma index_list(${table.name})`,
    ).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const index of indexes) {
      const on = rows<{ name: string | null }>(db, `pragma index_info(${index.name})`)
        .map((c) => c.name ?? "?")
        .join(", ");
      // Auto-created indexes are labelled by their ORIGIN, not their generated
      // name: `<pk>` and `<u>` are stable, `sqlite_autoindex_x_1` is not.
      out.push(`  ${index.unique ? "unique " : ""}index ${index.origin === "c" ? index.name : `<${index.origin}>`} (${on})`);
    }
  }
  return out.join("\n");
}

/**
 * The committed shape. Regenerating this is a deliberate act with a reviewable
 * diff — which is the entire point. Bump `DB_VERSION` alongside any change:
 * migration is regeneration, so an old cache must be recognised as old.
 */
const EXPECTED = `edge(id INTEGER PK1, kind_id INTEGER NOT NULL, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, provenance_id INTEGER NOT NULL, anchor_file_id INTEGER NOT NULL, anchor_start INTEGER NOT NULL, anchor_end INTEGER NOT NULL, is_read INTEGER, is_write INTEGER, source_file_id INTEGER, candidate_count INTEGER, extra TEXT)
  index edge_from (from_id, kind_id)
  index edge_provenance (provenance_id)
  index edge_to (to_id, kind_id)
edge_candidate(edge_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, candidate_id INTEGER NOT NULL) WITHOUT ROWID
  index edge_candidate_target (candidate_id)
  unique index <pk> (edge_id, ord)
edge_kind(id INTEGER PK1, name TEXT NOT NULL)
  unique index <u> (name)
edge_version(revision_id INTEGER NOT NULL PK1, from_key INTEGER NOT NULL PK2, to_key INTEGER NOT NULL PK3, kind TEXT NOT NULL PK4, provenance TEXT NOT NULL PK5, count INTEGER NOT NULL) WITHOUT ROWID
  index edge_version_keys (from_key, to_key)
  unique index <pk> (revision_id, from_key, to_key, kind, provenance)
entity(id INTEGER PK1, kind_id INTEGER NOT NULL, trait_set_id INTEGER NOT NULL, module_id INTEGER NOT NULL, symbol TEXT NOT NULL, disambiguator TEXT, name TEXT, signature TEXT, parent_id INTEGER, attached_to_id INTEGER, declared_type_id INTEGER, is_stub INTEGER, anchor_file_id INTEGER, anchor_start INTEGER, anchor_end INTEGER, space TEXT, extra TEXT)
  index entity_anchor_file (anchor_file_id)
  index entity_kind (kind_id)
  index entity_natural_key (module_id, symbol, disambiguator)
  index entity_parent (parent_id)
  index entity_trait_set (trait_set_id)
entity_comment(entity_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, text TEXT NOT NULL) WITHOUT ROWID
  unique index <pk> (entity_id, ord)
entity_defined_in(entity_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, file_id INTEGER NOT NULL) WITHOUT ROWID
  unique index <pk> (entity_id, ord)
entity_key(id INTEGER PK1, module TEXT NOT NULL, symbol TEXT NOT NULL, disambiguator TEXT NOT NULL)
  unique index <u> (module, symbol, disambiguator)
entity_local_variable(entity_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, variable_id INTEGER NOT NULL) WITHOUT ROWID
  index entity_local_target (variable_id)
  unique index <pk> (entity_id, ord)
entity_parameter(entity_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, parameter_id INTEGER NOT NULL) WITHOUT ROWID
  index entity_parameter_target (parameter_id)
  unique index <pk> (entity_id, ord)
entity_version(revision_id INTEGER NOT NULL PK1, key_id INTEGER NOT NULL PK2, kind TEXT NOT NULL, is_stub INTEGER NOT NULL, loc INTEGER, file TEXT) WITHOUT ROWID
  index entity_version_key (key_id, revision_id)
  unique index <pk> (revision_id, key_id)
file(id INTEGER PK1, path TEXT NOT NULL)
  unique index <u> (path)
kind(id INTEGER PK1, name TEXT NOT NULL)
  unique index <u> (name)
meta(key TEXT NOT NULL PK1, value TEXT NOT NULL) WITHOUT ROWID
  unique index <pk> (key)
provenance(id INTEGER PK1, name TEXT NOT NULL)
  unique index <u> (name)
revision(id INTEGER PK1, sha TEXT NOT NULL, time INTEGER)
  unique index <u> (sha)
trait(id INTEGER PK1, name TEXT NOT NULL)
  unique index <u> (name)
trait_set(id INTEGER PK1)
trait_set_member(trait_set_id INTEGER NOT NULL PK1, ord INTEGER NOT NULL PK2, trait_id INTEGER NOT NULL) WITHOUT ROWID
  unique index <pk> (trait_set_id, ord)
  index trait_set_member_by_trait (trait_id)`;

describe("the schema, as SQLite actually creates it", () => {
  it("matches the committed shape", () => {
    const db = fresh();
    try {
      expect(digest(db)).toBe(EXPECTED);
    } finally {
      db.close();
    }
  });

  it("declares a version, so an old cache can be recognised as old", () => {
    expect(Number.isInteger(DB_VERSION)).toBe(true);
    expect(DB_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("invariant 4: outgoing facts only", () => {
  const db = fresh();
  const tables = rows<{ name: string }>(
    db,
    "select name from sqlite_master where type='table' and name not like 'sqlite_%'",
  ).map((t) => t.name);
  const indexes = rows<{ name: string }>(
    db,
    "select name from sqlite_master where type='index' and name not like 'sqlite_%'",
  ).map((i) => i.name);

  /**
   * The inverse relations the analyzer derives — incoming invocations,
   * children, subtypes, importers — must not become rows. An INDEX over
   * outgoing facts is the database's version of "derived in memory": it stores
   * no fact the model did not already state, and cannot go stale against it.
   */
  it("keeps the inverse lookups as indexes, never as tables", () => {
    expect(indexes).toContain("edge_to");
    expect(indexes).toContain("entity_parent");
    expect(tables).not.toContain("edge_to");
    expect(tables).not.toContain("entity_parent");
  });

  it("has no table whose NAME claims to hold an inverse", () => {
    // Whole-word matching: `entity_defined_in` is a forward fact and must not
    // be caught by a substring like "_in".
    const banned = [
      "child", "children", "incoming", "inbound", "inverse", "reverse",
      "subtype", "subtypes", "dependent", "dependents", "importer", "importers",
      "caller", "callers", "backref",
    ];
    const offenders = tables.filter((name) =>
      name.split("_").some((word) => banned.includes(word)),
    );
    expect(offenders).toEqual([]);
  });

  it("stores each edge once, in the direction the model states it", () => {
    // There is one edge table, and its columns are from/to — not a symmetric
    // pair table and not two rows per relation.
    expect(tables.filter((name) => name === "edge").length).toBe(1);
    expect(columnsOf(db, "edge")).toContain("from_id");
    expect(columnsOf(db, "edge")).toContain("to_id");
  });
});

/**
 * The rule step 3 settled for the record stream, restated for the store: two
 * gates on one format drift. A model the reader accepts must be cacheable, so
 * findings that `codegraph validate` exists to REPORT must not become import
 * failures. Both cases below are real conformance findings.
 */
describe("the store caches what the reader accepts", () => {
  function seed(db: SqliteDatabase): void {
    db.exec("insert into trait_set(id) values (0)");
    db.exec("insert into kind(id, name) values (0, 'class')");
    db.exec("insert into edge_kind(id, name) values (0, 'references')");
    db.exec("insert into provenance(id, name) values (0, 'declared')");
    db.exec("insert into file(id, path) values (0, 'A.java')");
  }

  const insertEntity =
    "insert into entity(id, kind_id, trait_set_id, module_id, symbol, disambiguator) values (?, 0, 0, ?, ?, ?)";

  /**
   * The duplicate carries a DISAMBIGUATOR, and that detail is the whole test.
   * SQLite treats NULLs as distinct in a unique index, so two rows differing
   * only by a NULL disambiguator would slip past a UNIQUE constraint and the
   * assertion would pass whether or not one existed — which is exactly why the
   * pre-M6 sketch wrote `ifnull(disambiguator,'')`. Found by mutation: the
   * first version of this test used NULL and did not notice a UNIQUE index.
   */
  it("accepts two entities claiming one natural key", () => {
    const db = fresh();
    try {
      seed(db);
      db.prepare(insertEntity).run(0, 0, "", null);
      db.prepare(insertEntity).run(1, 0, "Same", "L12");
      // A UNIQUE index here would make `import` fail on exactly the model
      // `validate` is meant to describe.
      db.prepare(insertEntity).run(2, 0, "Same", "L12");
      // And the NULL case, which is a duplicate identity too — MM-1 says an
      // absent disambiguator is a value, not a wildcard.
      db.prepare(insertEntity).run(3, 0, "Other", null);
      db.prepare(insertEntity).run(4, 0, "Other", null);
      expect(rows(db, "select id from entity").length).toBe(5);
    } finally {
      db.close();
    }
  });

  it("accepts a self-edge", () => {
    const db = fresh();
    try {
      seed(db);
      db.prepare(insertEntity).run(0, 0, "", null);
      db.prepare(
        "insert into edge(id, kind_id, from_id, to_id, provenance_id, anchor_file_id, anchor_start, anchor_end) values (0, 0, 0, 0, 0, 0, 1, 1)",
      ).run();
      expect(rows(db, "select id from edge").length).toBe(1);
    } finally {
      db.close();
    }
  });

  /**
   * Not a default anyone inherited: SQLite says OFF, `node:sqlite` says ON.
   * The store says OFF on purpose — entity records reference entities that
   * sort later (`parent`, `declaredType`), so immediate constraints would
   * reject valid models, and closure is the record reader's job anyway.
   */
  it("opens with foreign keys off, explicitly", () => {
    const db = fresh();
    try {
      expect(rows<{ foreign_keys: number }>(db, "pragma foreign_keys")[0]?.foreign_keys).toBe(0);
    } finally {
      db.close();
    }

    // The control: it is off because we asked, not because it is off anyway.
    const inherited = loadSqlite().open(":memory:");
    try {
      expect(
        rows<{ foreign_keys: number }>(inherited, "pragma foreign_keys")[0]?.foreign_keys,
        "node:sqlite no longer defaults foreign keys ON — the explicit option may be moot",
      ).toBe(1);
    } finally {
      inherited.close();
    }
  });

  /**
   * Unenforced is not decorative. `PRAGMA foreign_key_check` reads the same
   * declarations to audit rows that are already there, which `foreign_keys=ON`
   * cannot do — it only governs new writes.
   */
  it("keeps the REFERENCES clauses auditable even unenforced", () => {
    const db = fresh();
    try {
      seed(db);
      db.prepare(insertEntity).run(0, 0, "", null);
      // A parent that does not exist: accepted on the way in, findable later.
      db.exec("update entity set parent_id = 4242 where id = 0");
      const violations = rows<{ table: string; parent: string }>(db, "pragma foreign_key_check");
      expect(violations.map((v) => [v.table, v.parent])).toContainEqual(["entity", "entity"]);
    } finally {
      db.close();
    }
  });
});

describe("the schema is checked against core's tables", () => {
  const db = fresh();
  const entityKeys = Object.keys(ENTITY_KEY_STORAGE);
  const edgeKeys = Object.keys(EDGE_KEY_STORAGE);

  /**
   * The anti-drift claim of docs/model-encoding.md §3.3, made mechanical:
   * `core` owns the vocabulary, and the store must have somewhere to put every
   * key that vocabulary can produce.
   */
  it("accounts for every key a trait contributes", () => {
    const missing = traitContributedKeys().filter((key) => !entityKeys.includes(key));
    expect(missing, "core contributes a key the store has nowhere to put").toEqual([]);
  });

  it("accounts for every key an entity record can carry", () => {
    const wire = Object.keys(EntityRec.shape).filter((key) => key !== "t");
    expect(wire.slice().sort()).toEqual(entityKeys.slice().sort());
  });

  it("accounts for every key an edge record can carry", () => {
    const wire = Object.keys(EdgeRec.shape).filter((key) => key !== "t");
    expect(wire.slice().sort()).toEqual(edgeKeys.slice().sort());
  });

  /**
   * And the mapping is not merely declared — each destination must exist. A
   * renamed column would otherwise leave the table pointing at nothing and the
   * mistake would only surface at import.
   */
  it("points every key at a real column of a real table", () => {
    const wrong: string[] = [];
    for (const [key, where] of Object.entries({ ...ENTITY_KEY_STORAGE, ...EDGE_KEY_STORAGE })) {
      const actual = columnsOf(db, where.table);
      if (actual.length === 0) wrong.push(`${key}: no table ${where.table}`);
      for (const column of where.columns) {
        if (!actual.includes(column)) wrong.push(`${key}: ${where.table} has no ${column}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("what the M6 wire changed about the pre-M6 sketch", () => {
  const db = fresh();
  const entity = rows<{ name: string; notnull: number }>(db, "pragma table_info(entity)");

  /**
   * The sketch had `module_id INTEGER REFERENCES entity` and the note "NULL for
   * root modules". M6 removed that case: `m` is required on every entity record
   * and a module names ITSELF, so there is no entity without a module and NULL
   * would mean nothing.
   */
  it("makes module_id NOT NULL, because the wire made it required", () => {
    expect(entity.find((c) => c.name === "module_id")?.notnull).toBe(1);
    expect(EntityRec.shape.m.safeParse(undefined).success).toBe(false);
  });

  /**
   * `entity_trait(entity_id, trait_id)` would carry ~1.3M rows on fineract to
   * say 18 different things. Interning is also what MM-4 says the model means:
   * profile validity is a function of (kind, trait set).
   */
  it("interns trait sets instead of joining every entity to every trait", () => {
    const tables = rows<{ name: string }>(db, "select name from sqlite_master where type='table'");
    expect(tables.map((t) => t.name)).toContain("trait_set");
    expect(tables.map((t) => t.name)).not.toContain("entity_trait");
    expect(columnsOf(db, "entity")).toContain("trait_set_id");
  });

  /**
   * A trait set is an ordered sequence here, not a set, so an entity's `tr`
   * array survives the round trip exactly as written. At 18 distinct sets the
   * ordering costs nothing; getting it wrong would silently rewrite models.
   */
  it("keeps trait order, so the round trip is exact", () => {
    expect(columnsOf(db, "trait_set_member")).toContain("ord");
  });

  /** Loose records: an extractor-specific key must survive, not be stripped. */
  it("has somewhere to put keys core does not type", () => {
    expect(columnsOf(db, "entity")).toContain("extra");
    expect(columnsOf(db, "edge")).toContain("extra");
  });
});
