import type { InsightRecord, StoreHeader, WalkRecord, WordEntry } from "./schema.js";
import { sortRecords } from "./sidecar.js";
import type { AnswerBlock, QuotedRecord, WalkSpec } from "./spec.js";
import type { InsightsStore, RunHandle } from "./store.js";

/**
 * WHAT A PROMPT QUOTES of an explained dependency: two short strings out of a
 * block of a kilobyte or more. A popular callee is quoted by thousands of
 * callers, so this — not the record — is what a source is asked for: the
 * store projects it in SQL, and a book keeps it once read. The walk's spec
 * says which two (`WalkSpec.quote`); a book is built for one spec.
 */
export interface RecordSummary {
  /** What flows upward: explain's is the block's `description`. */
  readonly description: string;
  /** A short label shown beside it, if the spec gives one (explain: the type's concept, the operation's owner, the module's context hint). */
  readonly concept: string | undefined;
}

/** The part of a spec a book needs: how a record is quoted, and what of it the quote reads. */
export type Quoting = Pick<WalkSpec, "quote" | "quoted">;

/** A path a quote may declare: identifiers, dotted. What a store may write into its SQL, and nothing else. */
export const QUOTE_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A block made of `(path, value)` pairs, in order: what a projection IS, whether
 * the values were read in JS or in SQL — one builder, so the two cannot differ.
 * A path under one already holding a value adds nothing (that value carries it).
 */
export function blockAt(values: Iterable<readonly [string, unknown]>): AnswerBlock {
  const out: Record<string, unknown> = {};
  const made = new Set<object>([out]);
  for (const [path, value] of values) {
    const segments = path.split(".");
    const last = segments.pop() ?? "";
    let target: Record<string, unknown> | undefined = out;
    for (const segment of segments) {
      const next: unknown = Object.hasOwn(target, segment) ? target[segment] : undefined;
      if (next === undefined) {
        const fresh: Record<string, unknown> = {};
        made.add(fresh);
        target[segment] = fresh;
        target = fresh;
      } else if (isObject(next) && made.has(next)) {
        target = next as Record<string, unknown>;
      } else {
        target = undefined;
        break;
      }
    }
    if (target !== undefined && !Object.hasOwn(target, last)) target[last] = value;
  }
  return out;
}

/** The block's values at `paths` — absent where the block has none (JSON `null` is a value) — as `blockAt` builds them. */
export function projectBlock(block: AnswerBlock, paths: readonly string[]): AnswerBlock {
  const values: [string, unknown][] = [];
  for (const path of paths) {
    let value: unknown = block;
    for (const segment of path.split(".")) {
      value = isObject(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
      if (value === undefined) break;
    }
    if (value !== undefined) values.push([path, value]);
  }
  return blockAt(values);
}

/** How `spec` quotes a record it holds whole: through its declared projection, as a store would answer it. */
export function quoteOf(spec: Quoting, record: QuotedRecord): RecordSummary {
  return spec.quote(spec.quoted === undefined ? record : { level: record.level, block: projectBlock(record.block, spec.quoted) });
}

/** A block's `words`. Explain's alone carry them: a definition may not declare the name (definition.ts). */
function wordsOf(block: AnswerBlock): readonly WordEntry[] | undefined {
  return block["words"] as readonly WordEntry[] | undefined;
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
  /** What a module's prompt quotes of one of its types (PLAN.md §20.3); undefined with no record, or one explained under prompt 1. */
  words(id: string): readonly WordEntry[] | undefined;
  size(): number;
}

/** Generic over the walk's record; explain's by default. */
export interface RecordBook<R extends WalkRecord = InsightRecord> extends RecordSource {
  /** A finished unit, whole — a cycle's members together. */
  put(unitId: string, records: readonly R[]): void | Promise<void>;
  /** EVERY record, in side-car order. Materializes them all: for tests and small corpora, never on a run's path. */
  all(): R[];
}

export type MemoryBook<R extends WalkRecord = InsightRecord> = RecordBook<R>;

/** Records held in memory, quoted by `spec`: a side-car read with no store beside it, and every test. */
export function memoryBook<R extends WalkRecord = InsightRecord>(records: Iterable<R>, spec: Quoting): MemoryBook<R> {
  const byId = new Map<string, R>();
  for (const record of records) byId.set(record.id, record);
  return {
    fingerprint: (id) => byId.get(id)?.fingerprint,
    summary: (id) => {
      const record = byId.get(id);
      return record === undefined ? undefined : quoteOf(spec, record);
    },
    words: (id) => {
      const record = byId.get(id);
      return record === undefined ? undefined : wordsOf(record.block);
    },
    size: () => byId.size,
    put: (_unitId, unit) => {
      for (const record of unit) byId.set(record.id, record);
    },
    all: () => sortRecords(byId.values()),
  };
}

/** A map is accepted wherever a source is: copied into a book quoted by `spec`, never written to. */
export function bookOf<R extends WalkRecord>(existing: RecordBook<R> | ReadonlyMap<string, R>, spec: Quoting): RecordBook<R> {
  return "fingerprint" in existing ? existing : memoryBook(existing.values(), spec);
}

export function sourceOf(existing: RecordSource | ReadonlyMap<string, WalkRecord>, spec: Quoting): RecordSource {
  return "fingerprint" in existing ? existing : memoryBook(existing.values(), spec);
}

export interface StoreBook<R extends WalkRecord = InsightRecord> extends RecordBook<R> {
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
 *
 * QUOTED BY ITS SPEC, put or read back (PLAN.md §22.4): a spec that declares
 * `quoted` is handed the store's SQL projection of a record read back — one
 * point query, no block parsed — and the same projection, made in JS, of one
 * put; one that declares none is handed the record read back whole.
 */
export function storeBook<R extends WalkRecord, H extends StoreHeader>(store: InsightsStore<R, H>, spec: Quoting): StoreBook<R> {
  const fingerprints = store.fingerprints();
  const summaries = new Map<string, RecordSummary>();
  const readBack = (id: string): RecordSummary | undefined => {
    if (spec.quoted !== undefined) {
      const projected = store.quoted(id, spec.quoted);
      return projected === undefined ? undefined : spec.quote(projected);
    }
    const record = store.get([id])[0];
    return record === undefined ? undefined : spec.quote(record);
  };
  let run: RunHandle | undefined;
  return {
    fingerprint: (id) => fingerprints.get(id),
    summary: (id) => {
      if (!fingerprints.has(id)) return undefined;
      let summary = summaries.get(id);
      if (summary === undefined) {
        summary = readBack(id);
        if (summary !== undefined) summaries.set(id, summary);
      }
      return summary;
    },
    // Unkept: a type's words are quoted once, by its module.
    words: (id) => (fingerprints.has(id) ? store.words(id) : undefined),
    size: () => fingerprints.size,
    begin: (handle) => {
      run = handle;
    },
    put: (unitId, unit) => {
      if (run === undefined) throw new Error("insights: no run has begun on this store book — put() is a run's commit");
      store.putUnit(run, unitId, unit);
      for (const record of unit) {
        fingerprints.set(record.id, record.fingerprint);
        summaries.set(record.id, quoteOf(spec, record));
      }
    },
    all: () => store.records(),
  };
}
