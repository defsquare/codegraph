import type { InsightRecord, Level } from "./schema.js";
import { sortRecords } from "./sidecar.js";
import type { InsightsStore, RunHandle } from "./store.js";

/**
 * WHAT A PROMPT QUOTES of an explained dependency: two short strings out of a
 * block of a kilobyte or more. A popular callee is quoted by thousands of
 * callers, so this — not the record — is what a source is asked for: the
 * store projects it in SQL, and a book keeps it once read.
 */
export interface RecordSummary {
  /** The block's `description`. */
  readonly description: string;
  /** The Specy word for it: the type's concept / the operation's owner / the module's context hint. */
  readonly concept: string | undefined;
}

/** THE one statement of the concept rule; the store's SQL projection feeds the same function. */
export function conceptLabel(level: Level, block: { owner?: string | undefined; concept?: string | undefined; context?: string | undefined }): string | undefined {
  switch (level) {
    case "operation":
      return block.owner === undefined || block.owner === "unknown" ? undefined : `owned by ${block.owner}`;
    case "type":
      return block.concept;
    case "module":
      return block.context === undefined ? undefined : `context: ${block.context}`;
  }
}

export function summaryOf(record: InsightRecord): RecordSummary {
  const concept =
    record.level === "operation"
      ? conceptLabel("operation", { owner: record.block.owner })
      : record.level === "type"
        ? conceptLabel("type", { concept: record.block.concept })
        : conceptLabel("module", { context: record.block.boundedContextHint?.name });
  return { description: record.block.description, concept };
}

/**
 * WHAT IS ALREADY EXPLAINED, as the walk reads it (PLAN.md §17.3, M16b).
 *
 * Two questions, deliberately apart, because they cost differently. A PLAN
 * asks `fingerprint(id)` of every unit — `reuse` or not — and needs no block.
 * A PROMPT asks `summary(id)` of what it quotes: a unit's dependencies and
 * parts, and only for a unit that is about to be sent. On a re-run that reuses
 * everything, not one block is read; on a cold one, each is read once.
 *
 * A BOOK is also where a run puts what it produces: after `put` returns, the
 * unit's members are visible to `fingerprint` and `summary` — which lets a
 * run hold no record of its own. Backed by the store, `put` IS the commit.
 */
export interface RecordSource {
  /** The record's fingerprint, never its block. */
  fingerprint(id: string): string | undefined;
  /** What a prompt quotes of an explained dependency — never the whole record. */
  summary(id: string): RecordSummary | undefined;
  size(): number;
}

export interface RecordBook extends RecordSource {
  /** A finished unit, whole — a cycle's members together. */
  put(unitId: string, records: readonly InsightRecord[]): void | Promise<void>;
  /** EVERY record, in side-car order. Materializes them all: for tests and small corpora, never on a run's path. */
  all(): InsightRecord[];
}

export type MemoryBook = RecordBook;

/** Records held in memory: a side-car read with no store beside it, and every test. */
export function memoryBook(records: Iterable<InsightRecord> = []): MemoryBook {
  const byId = new Map<string, InsightRecord>();
  for (const record of records) byId.set(record.id, record);
  return {
    fingerprint: (id) => byId.get(id)?.fingerprint,
    summary: (id) => {
      const record = byId.get(id);
      return record === undefined ? undefined : summaryOf(record);
    },
    size: () => byId.size,
    put: (_unitId, unit) => {
      for (const record of unit) byId.set(record.id, record);
    },
    all: () => sortRecords(byId.values()),
  };
}

/** A map is accepted wherever a source is: copied, never written to. */
export function bookOf(existing: RecordBook | ReadonlyMap<string, InsightRecord>): RecordBook {
  return "fingerprint" in existing ? existing : memoryBook(existing.values());
}

export function sourceOf(existing: RecordSource | ReadonlyMap<string, InsightRecord>): RecordSource {
  return "fingerprint" in existing ? existing : memoryBook(existing.values());
}

export interface StoreBook extends RecordBook {
  /** From here `put` commits to this run. Planning needs none; `put` before it is a bug, and says so. */
  begin(run: RunHandle): void;
}

/**
 * The store as a book. Fingerprints are read ONCE (an id and 64 hex digits per
 * record — megabytes where the blocks are hundreds) and kept in step with
 * every `put`; a summary is a point lookup the first time it is quoted and a
 * map hit after — two short strings per record, where the blocks would be
 * everything. Measured on Broadleaf with every prompt rendered: re-reading the
 * record per quote cost 1.5 GB and twice the time of holding them all.
 */
export function storeBook(store: InsightsStore): StoreBook {
  const fingerprints = store.fingerprints();
  const summaries = new Map<string, RecordSummary>();
  let run: RunHandle | undefined;
  return {
    fingerprint: (id) => fingerprints.get(id),
    summary: (id) => {
      if (!fingerprints.has(id)) return undefined;
      let summary = summaries.get(id);
      if (summary === undefined) {
        summary = store.summary(id);
        if (summary !== undefined) summaries.set(id, summary);
      }
      return summary;
    },
    size: () => fingerprints.size,
    begin: (handle) => {
      run = handle;
    },
    put: (unitId, unit) => {
      if (run === undefined) throw new Error("insights: no run has begun on this store book — put() is a run's commit");
      store.putUnit(run, unitId, unit);
      for (const record of unit) {
        fingerprints.set(record.id, record.fingerprint);
        summaries.set(record.id, summaryOf(record));
      }
    },
    all: () => store.records(),
  };
}
