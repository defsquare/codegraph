import type { FailureRecord, InsightRecord, InsightsEof, InsightsHeader } from "./schema.js";
import type { InsightsFile } from "./sidecar.js";

/**
 * THE INSIGHTS STORE (PLAN.md §17): `<model>.insights.db`, the working copy of
 * what a run BOUGHT. This file is the port — what `explain` needs from a store
 * and nothing a SQL engine would leak; `store-sqlite.ts` is the adapter.
 *
 * NOT A CACHE. `model.db` is regenerated on any doubt because the model says
 * everything it holds; nothing here can be recomputed, so a store is MIGRATED
 * (a ladder on `user_version`), a newer one is refused untouched, and nothing
 * falls back silently to a second copy.
 *
 * THE SIDE-CAR IS THE EXPORT. `export()` yields the lines of
 * `<model>.insights.jsonl`, and `decode → importFile → export` reproduces a
 * decodable file byte for byte. The `run` ledger is the only state a side-car
 * does not carry, and it is declared losable.
 */

/** Bumped with every migration appended to the adapter's ladder — never regenerated. */
export const INSIGHTS_DB_VERSION = 1;

/** `PRAGMA application_id`: "CGI1". A SQLite file that is not ours is refused, not migrated. */
export const INSIGHTS_APPLICATION_ID = 0x43474931;

export class InsightsStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InsightsStoreError";
  }
}

/** The side-car as last written from this store: what an outside edit is measured against. */
export interface ExportStamp {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RunStart {
  readonly header: InsightsHeader;
  /** ISO-8601, from the caller's clock: the store reads none. */
  readonly startedAt: string;
  /** The writing process, so a later run can tell a live writer from a dead one. */
  readonly pid?: number;
}

export interface RunHandle {
  readonly id: number;
}

/** A run with no end: still going, or killed. Only the caller can tell which. */
export interface OpenRun {
  readonly id: number;
  readonly startedAt: string;
  readonly pid: number | undefined;
  /** Records this run committed before it stopped. */
  readonly records: number;
}

export interface RunEnd {
  /** The trailer the export will carry; `counts.records` is the store's total. */
  readonly eof: InsightsEof;
  /** Every unit still owed an explanation: REPLACES the failure table. */
  readonly failures: readonly FailureRecord[];
  readonly calls?: number;
  readonly aborted?: string;
}

export interface InsightsStore {
  /** Nothing imported, no run begun: a side-car found beside it is imported, not compared. */
  isEmpty(): boolean;
  header(): InsightsHeader | undefined;
  /** The last FINISHED state's trailer; undefined while a run is open or after a kill. */
  eof(): InsightsEof | undefined;
  /** Every record, in side-car order. */
  records(): InsightRecord[];
  /** id → fingerprint, without reading a block. */
  fingerprints(): Map<string, string>;
  /** The records that exist among `ids`, in side-car order. */
  get(ids: readonly string[]): InsightRecord[];
  failures(): FailureRecord[];
  exported(): ExportStamp | undefined;
  openRuns(): OpenRun[];

  /** Replace the store's content with a decoded side-car, in one transaction. The ledger is kept. */
  importFile(file: InsightsFile): void;
  /** End a run that will never end itself (its process is gone). */
  closeRun(id: number, aborted: string): void;
  beginRun(start: RunStart): RunHandle;
  /** One transaction per finished UNIT: its records in, its failure row out. Half a cycle is never stored. */
  putUnit(run: RunHandle, unitId: string, records: readonly InsightRecord[]): void;
  /** A failure is written when it happens, not at the next boundary. */
  fail(run: RunHandle, failure: FailureRecord): void;
  finishRun(run: RunHandle, end: RunEnd): void;

  /** The side-car's lines, in order, without the trailing newline. */
  export(): Iterable<string>;
  markExported(stamp: ExportStamp): void;
  close(): void;
}

/** `X.insights.jsonl` → `X.insights.db`: the store sits beside the side-car it exports. */
export function insightsStorePathFor(sidecarPath: string): string {
  return sidecarPath.endsWith(".jsonl") ? `${sidecarPath.slice(0, -".jsonl".length)}.db` : `${sidecarPath}.db`;
}
