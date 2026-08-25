import { existsSync } from "node:fs";
import { readModelRecordsSync } from "@codegraph/core";

import { importModel, writeModelRows } from "./import.js";
import { DB_VERSION, STORE_OPEN_OPTIONS } from "./schema.js";
import { loadSqlite, type SqliteDatabase } from "./sqlite.js";

/**
 * THE TEMPORAL STORE (M9b, PLAN §11.2): `codegraph import --at <sha>` appends
 * one extracted snapshot to a `model.db`, keyed by the NATURAL key so "the
 * same entity across two snapshots" is key equality (invariant 7) — no diff
 * heuristics, no surrogate leaking across files.
 *
 * Unlike the single-model import, this path writes IN PLACE, inside one
 * journaled transaction: the store accumulates revisions that each cost a
 * full extraction, so the drop-and-regenerate lifecycle of the cache does not
 * apply — a version mismatch here is an ERROR to surface, never a file to
 * throw away (`cache.ts` enforces the same from the outside).
 *
 * The FLAT tables always mirror the most recently imported snapshot, so
 * `analyze`/`export` against the store answer for that revision; the
 * `*_version` tables hold every snapshot. Anonymous entities (positional
 * disambiguators) get version rows like everything else, but their keys shift
 * under edits — their timelines are not meaningful and lineage does not track
 * them (PLAN §11, principle 3; documented, not silent).
 */

export class TemporalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalStoreError";
  }
}

export interface RevisionRef {
  readonly id: number;
  readonly sha: string;
  /** Commit time, unix seconds; null when the import did not carry one. */
  readonly time: number | null;
}

export interface TemporalImportResult {
  readonly path: string;
  readonly revision: RevisionRef;
  /** Rows written for this revision. */
  readonly counts: { readonly entities: number; readonly edges: number };
  /** Revisions the store now holds, this one included. */
  readonly revisions: number;
}

/** A natural key inside one store; `lang` lives once, in the store's meta. */
export interface StoredKey {
  readonly module: string;
  readonly symbol: string;
  readonly disambiguator?: string | undefined;
}

/**
 * Append the model extracted at `revision.sha` to the store at `dbPath`,
 * creating the store if it does not exist. Imports should arrive in commit
 * order; `time` is what queries order by when given.
 */
export function importModelAt(
  jsonlPath: string,
  dbPath: string,
  revision: { readonly sha: string; readonly time?: number | undefined },
): TemporalImportResult {
  // A fresh store comes from the plain importer — same schema, same rows,
  // atomically renamed into place — and this call then only appends.
  const created = !existsSync(dbPath);
  if (created) importModel(jsonlPath, dbPath);

  const db = loadSqlite().open(dbPath, STORE_OPEN_OPTIONS);
  let inTransaction = false;
  try {
    const version = metaOf(db, "dbVersion");
    if (version !== String(DB_VERSION)) {
      throw new TemporalStoreError(
        `the store at ${dbPath} was built for store version ${version ?? "unknown"}; this build ` +
          `writes ${DB_VERSION}. A store holding revisions is never regenerated automatically — ` +
          `import each revision again into a new store.`,
      );
    }
    const existing = db.prepare("SELECT id FROM revision WHERE sha = ?").get(revision.sha);
    if (existing !== undefined) {
      throw new TemporalStoreError(
        `revision ${revision.sha} is already in the store — a snapshot is imported once.`,
      );
    }

    db.exec("BEGIN");
    inTransaction = true;

    // The flat tables mirror the LATEST import. A store this call just
    // created already holds this very model; otherwise clear and rewrite.
    if (!created) {
      for (const table of FLAT_TABLES) db.exec(`DELETE FROM ${table}`);
      writeModelRows(db, jsonlPath);
    }

    const revisionId = nextRevisionId(db);
    db.prepare("INSERT INTO revision(id, sha, time) VALUES (?, ?, ?)").run(
      revisionId,
      revision.sha,
      revision.time ?? null,
    );
    const counts = writeVersions(db, jsonlPath, revisionId);

    const revisions = Number(
      Object.values(db.prepare("SELECT count(*) AS n FROM revision").get() ?? {})[0] ?? 0,
    );
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('revisions', ?)").run(
      String(revisions),
    );

    db.exec("COMMIT");
    inTransaction = false;

    return {
      path: dbPath,
      revision: { id: revisionId, sha: revision.sha, time: revision.time ?? null },
      counts,
      revisions,
    };
  } finally {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction already died with the connection; nothing to undo.
      }
    }
    db.close();
  }
}

/** Every table the single-model import fills — the temporal tables excluded. */
const FLAT_TABLES = [
  "meta",
  "kind",
  "trait",
  "edge_kind",
  "provenance",
  "file",
  "trait_set",
  "trait_set_member",
  "entity",
  "entity_comment",
  "entity_defined_in",
  "entity_parameter",
  "entity_local_variable",
  "edge",
  "edge_candidate",
] as const;

function metaOf(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value as string | undefined;
}

function nextRevisionId(db: SqliteDatabase): number {
  const row = db.prepare("SELECT max(id) AS m FROM revision").get();
  const max = row?.m as number | null;
  return max === null || max === undefined ? 0 : max + 1;
}

/** '' = no disambiguator: NULLs are pairwise distinct under UNIQUE. */
const NONE = "";

/**
 * One streaming pass over the model: natural keys interned, one
 * `entity_version` row per key, edges aggregated to
 * (from, to, kind, provenance) counts. Never holds the corpus — only the
 * per-surrogate key assignment, which any keyed store needs.
 */
function writeVersions(
  db: SqliteDatabase,
  jsonlPath: string,
  revisionId: number,
): { entities: number; edges: number } {
  // The store's interned keys, loaded once: appending revision K+1 must reuse
  // the ids revisions 1..K assigned, or key equality across time is lost.
  const keyIds = new Map<string, number>();
  for (const row of db
    .prepare("SELECT id, module, symbol, disambiguator FROM entity_key")
    .iterate()) {
    keyIds.set(
      `${row.module as string}\u0000${row.symbol as string}\u0000${row.disambiguator as string}`,
      row.id as number,
    );
  }
  let nextKeyId = keyIds.size === 0 ? 0 : Math.max(...keyIds.values()) + 1;

  const insertKey = db.prepare(
    "INSERT INTO entity_key(id, module, symbol, disambiguator) VALUES (?, ?, ?, ?)",
  );
  const keyOf = (module: string, symbol: string, disambiguator: string): number => {
    const at = `${module}\u0000${symbol}\u0000${disambiguator}`;
    let id = keyIds.get(at);
    if (id !== undefined) return id;
    id = nextKeyId;
    nextKeyId += 1;
    keyIds.set(at, id);
    insertKey.run(id, module, symbol, disambiguator);
    return id;
  };

  // First declaration wins (OR IGNORE): a repeated natural key is a
  // conformance finding the flat store keeps both rows of; keyed by identity
  // there is only one row to have.
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entity_version(revision_id, key_id, kind, is_stub, loc, file) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );

  let kinds: readonly string[] = [];
  let edgeKinds: readonly string[] = [];
  let provenances: readonly string[] = [];
  const files: string[] = [];
  /** Per surrogate: the symbol (a module's is its path) and the key id. */
  const symbols: string[] = [];
  const keyBySurrogate: number[] = [];
  let entities = 0;

  const aggregated = new Map<string, { from: number; to: number; kind: number; p: number; count: number }>();

  for (const record of readModelRecordsSync(jsonlPath)) {
    switch (record.t) {
      case "header":
        kinds = record.dict.kinds;
        edgeKinds = record.dict.edges;
        provenances = record.dict.provenance;
        break;
      case "f":
        files.push(record.path);
        break;
      case "e": {
        // The module's path is its own symbol (MM-1); canonical order puts the
        // module first, so `record.m` always resolves backward.
        symbols.push(record.s);
        const modulePath = record.m === record.i ? record.s : (symbols[record.m] as string);
        const symbol = record.m === record.i ? "" : record.s;
        const keyId = keyOf(modulePath, symbol, record.d ?? NONE);
        keyBySurrogate.push(keyId);
        const anchor = record.anchor;
        insertEntity.run(
          revisionId,
          keyId,
          kinds[record.k] ?? "",
          record.isStub === true ? 1 : 0,
          anchor === undefined ? null : anchor[2] - anchor[1] + 1,
          anchor === undefined ? null : files[anchor[0]] ?? null,
        );
        entities += 1;
        break;
      }
      case "x": {
        const from = keyBySurrogate[record.f] as number;
        const to = keyBySurrogate[record.o] as number;
        const at = `${from}:${to}:${record.k}:${record.p}`;
        const found = aggregated.get(at);
        if (found === undefined) {
          aggregated.set(at, { from, to, kind: record.k, p: record.p, count: 1 });
        } else {
          found.count += 1;
        }
        break;
      }
      case "eof":
        break;
    }
  }

  const insertEdge = db.prepare(
    "INSERT INTO edge_version(revision_id, from_key, to_key, kind, provenance, count) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Sorted inserts: the table's content order is deterministic, so two stores
  // built from the same snapshots dump identically.
  const rows = [...aggregated.values()].sort(
    (a, b) => a.from - b.from || a.to - b.to || a.kind - b.kind || a.p - b.p,
  );
  for (const row of rows) {
    insertEdge.run(
      revisionId,
      row.from,
      row.to,
      edgeKinds[row.kind] ?? "",
      provenances[row.p] ?? "",
      row.count,
    );
  }

  return { entities, edges: rows.length };
}

// ─────────────────────────────────────────────────────────────── queries

/** Chronological when times are given, import order otherwise. */
const REVISION_ORDER = "ORDER BY (time IS NULL), time, id";

/** One key's whole corpus life, for the replay city (M9c). */
export interface EntityHistoryEntry {
  readonly module: string;
  readonly symbol: string;
  /** '' = none — the store's encoding, kept as-is for renderId round-trips. */
  readonly disambiguator: string;
  /** The kind at the entity's LAST corpus revision. */
  readonly kind: string;
  /** The anchor file at that same revision; null when unanchored. The path
   * joins (ownership, co-change) key on this. */
  readonly file: string | null;
  /**
   * `[revision ordinal, loc]` per revision that DECLARES the key (stub
   * versions are not part of an entity's life — the replay city is the
   * internal city, and membership is corpus declaration, invariant 6).
   * `loc` is null when the version is declared but unanchored.
   */
  readonly series: readonly (readonly [number, number | null])[];
}

export interface EntityHistoryData {
  readonly lang: string;
  /** Chronological; series ordinals index into this array. */
  readonly revisions: readonly RevisionRef[];
  /** Every key with at least one corpus (non-stub) version, sorted by key. */
  readonly entities: readonly EntityHistoryEntry[];
}

/**
 * The whole store's entity time axis in one pass — the structural input the
 * replay city builds from (the dependency flows through the CLI, exactly as
 * history.jsonl reaches the analyzer as data). Derived at query time from
 * `entity_version`; nothing here is serialized (invariant 4 on time).
 */
export function readEntityHistory(db: SqliteDatabase): EntityHistoryData {
  const lang = (metaOf(db, "lang") ?? "") as string;
  const revisions = listRevisions(db);
  const ordinalOf = new Map(revisions.map((revision, ordinal) => [revision.id, ordinal]));

  const entries = new Map<number, {
    module: string;
    symbol: string;
    disambiguator: string;
    kind: string;
    file: string | null;
    kindOrdinal: number;
    series: [number, number | null][];
  }>();
  for (const row of db
    .prepare(
      `SELECT v.key_id, v.revision_id, v.kind, v.loc, v.file,
              k.module, k.symbol, k.disambiguator
       FROM entity_version v
       JOIN entity_key k ON k.id = v.key_id
       WHERE v.is_stub = 0
       ORDER BY k.module, k.symbol, k.disambiguator, v.revision_id`,
    )
    .iterate()) {
    const ordinal = ordinalOf.get(row.revision_id as number);
    if (ordinal === undefined) continue;
    const keyId = row.key_id as number;
    let entry = entries.get(keyId);
    if (entry === undefined) {
      entry = {
        module: row.module as string,
        symbol: row.symbol as string,
        disambiguator: row.disambiguator as string,
        kind: row.kind as string,
        file: null,
        kindOrdinal: -1,
        series: [],
      };
      entries.set(keyId, entry);
    }
    entry.series.push([ordinal, row.loc as number | null]);
    // "Latest" kind and file are by CHRONOLOGICAL ordinal, which can differ
    // from the row order (revision ids) when imports arrived out of order.
    if (ordinal >= entry.kindOrdinal) {
      entry.kind = row.kind as string;
      entry.file = row.file as string | null;
      entry.kindOrdinal = ordinal;
    }
  }

  const entities = [...entries.values()].map(({ kindOrdinal: _, ...entry }) => ({
    ...entry,
    series: entry.series.sort((a, b) => a[0] - b[0]),
  }));
  return { lang, revisions, entities };
}

export function listRevisions(db: SqliteDatabase): RevisionRef[] {
  return [...db.prepare(`SELECT id, sha, time FROM revision ${REVISION_ORDER}`).iterate()].map(
    (row) => ({
      id: row.id as number,
      sha: row.sha as string,
      time: row.time as number | null,
    }),
  );
}

export interface TimelinePoint extends RevisionRef {
  readonly kind: string;
  readonly isStub: boolean;
  /** Anchor span lines at that revision; null when unanchored. */
  readonly loc: number | null;
  readonly file: string | null;
}

export interface Timeline {
  readonly key: StoredKey;
  /** First and last revision (chronological) containing the key. */
  readonly appeared: RevisionRef;
  readonly lastSeen: RevisionRef;
  /** True when the key is in the newest revision — it has not disappeared. */
  readonly presentInLatest: boolean;
  /** One point per revision that contains the key, chronological. */
  readonly series: readonly TimelinePoint[];
}

/**
 * The key's life, derived at query time (invariant 4 on the time axis):
 * `appeared`/`lastSeen` are the min/max over its version rows, never stored.
 * Undefined when no revision ever declared the key.
 */
export function readTimeline(db: SqliteDatabase, key: StoredKey): Timeline | undefined {
  const keyRow = db
    .prepare("SELECT id FROM entity_key WHERE module = ? AND symbol = ? AND disambiguator = ?")
    .get(key.module, key.symbol, key.disambiguator ?? NONE);
  if (keyRow === undefined) return undefined;
  const keyId = keyRow.id as number;

  const series: TimelinePoint[] = [
    ...db
      .prepare(
        `SELECT r.id, r.sha, r.time, v.kind, v.is_stub, v.loc, v.file
         FROM entity_version v JOIN revision r ON r.id = v.revision_id
         WHERE v.key_id = ? ORDER BY (r.time IS NULL), r.time, r.id`,
      )
      .iterate(keyId),
  ].map((row) => ({
    id: row.id as number,
    sha: row.sha as string,
    time: row.time as number | null,
    kind: row.kind as string,
    isStub: (row.is_stub as number) === 1,
    loc: row.loc as number | null,
    file: row.file as string | null,
  }));
  if (series.length === 0) return undefined;

  const revisions = listRevisions(db);
  const latest = revisions[revisions.length - 1];
  const appeared = series[0] as TimelinePoint;
  const lastSeen = series[series.length - 1] as TimelinePoint;
  return {
    key,
    appeared: { id: appeared.id, sha: appeared.sha, time: appeared.time },
    lastSeen: { id: lastSeen.id, sha: lastSeen.sha, time: lastSeen.time },
    presentInLatest: latest !== undefined && lastSeen.id === latest.id,
    series,
  };
}
