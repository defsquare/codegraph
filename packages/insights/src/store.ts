import type { FailureRecord, InsightRecord, InsightsEof, InsightsHeader, Level, Origin, RecordUsage } from "./schema.js";
import type { RecordSummary } from "./records.js";
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

/** A reader's filter (M16c). Every field narrows; none reads a block. */
export interface InsightQuery {
  readonly ids?: readonly string[];
  readonly level?: Level;
  /** A TYPE's concept, as the block spells it (`aggregate`, `valueType`…) — the indexed column. */
  readonly concept?: string;
  readonly minConfidence?: number;
  readonly maxConfidence?: number;
  /** Applied AFTER side-car ordering. */
  readonly limit?: number;
}

/** What a list shows of a record: the envelope and the summary, never the block. */
export interface InsightRow {
  readonly id: string;
  readonly level: Level;
  readonly kind: string;
  readonly name: string | undefined;
  readonly file: string | undefined;
  readonly origin: Origin;
  readonly model: string | undefined;
  readonly confidence: number;
  readonly description: string;
  /** The label a prompt quotes (`conceptLabel`): one rule, whoever asks. */
  readonly concept: string | undefined;
}

export interface InsightStats {
  readonly records: number;
  readonly failures: number;
  readonly byLevel: Readonly<Record<Level, number>>;
  readonly byOrigin: Readonly<Record<Origin, number>>;
  /** Types only, by the block's `concept`; sorted by key. */
  readonly byConcept: Readonly<Record<string, number>>;
  /**
   * What the records that EXIST cost, summed from their own usage — so it
   * survives an import, which the run ledger does not. Less than was spent:
   * a replaced record's and a failed call's tokens are in the ledger only.
   */
  readonly usage: RecordUsage;
}

/** One line of the ledger: what the side-car's single trailer could never say. */
export interface RunRow {
  readonly id: number;
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
  readonly provider: string | undefined;
  readonly models: { readonly leaf: string; readonly rollup: string };
  readonly depth: number;
  /** Undefined for a run that never finished. */
  readonly counts: { readonly llm: number; readonly template: number; readonly reused: number; readonly failed: number; readonly calls: number | undefined } | undefined;
  readonly usage: RecordUsage | undefined;
  readonly aborted: string | undefined;
}

export interface StoreOpenOptions {
  /**
   * For a READER (`codegraph insights`, the daemon): no migration, not a byte
   * written — SQLite itself refuses (`query_only`) — and a store that is not
   * already at this build's version is refused rather than brought to it.
   * Hand it an ordinary connection: a read-only FILE handle may not clean up
   * after itself and strands `-wal`/`-shm` beside the model.
   */
  readonly readOnly?: boolean;
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
  /** What a prompt quotes of one record, projected WITHOUT reading the rest of its block. */
  summary(id: string): RecordSummary | undefined;
  /** The records that exist among `ids`, in side-car order. */
  get(ids: readonly string[]): InsightRecord[];
  failures(): FailureRecord[];
  /** Rows matching a reader's filter, in side-car order. */
  query(query: InsightQuery): InsightRow[];
  stats(): InsightStats;
  /** The ledger, oldest first. */
  runs(): RunRow[];
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

/**
 * WHAT A PAGE IS TOLD ABOUT ONE ID (M16c) — the navigator's explanation panel
 * asks this of `codegraph serve`. Three answers, because "no explanation" is
 * two different facts: the unit was asked for and FAILED (say why), or nobody
 * ever asked (say nothing). The frontend restates `kind` as a literal and a
 * test pins the two equal, as it does for the navigator artifact.
 */
export const INSIGHT_ANSWER_KIND = "codegraph.insight/1";

export type InsightAnswer =
  | { readonly kind: typeof INSIGHT_ANSWER_KIND; readonly id: string; readonly status: "explained"; readonly record: InsightRecord }
  | { readonly kind: typeof INSIGHT_ANSWER_KIND; readonly id: string; readonly status: "failed"; readonly failure: FailureRecord }
  | { readonly kind: typeof INSIGHT_ANSWER_KIND; readonly id: string; readonly status: "unknown" };

export function answerInsight(store: InsightsStore, id: string): InsightAnswer {
  const record = store.get([id])[0];
  if (record !== undefined) return { kind: INSIGHT_ANSWER_KIND, id, status: "explained", record };
  // Matched by member: a failed cycle is one failure row, and every one of its members is owed.
  const failure = store.failures().find((candidate) => candidate.id === id || candidate.members.includes(id));
  return failure === undefined ? { kind: INSIGHT_ANSWER_KIND, id, status: "unknown" } : { kind: INSIGHT_ANSWER_KIND, id, status: "failed", failure };
}

/** `X.insights.jsonl` → `X.insights.db`: the store sits beside the side-car it exports. */
export function insightsStorePathFor(sidecarPath: string): string {
  return sidecarPath.endsWith(".jsonl") ? `${sidecarPath.slice(0, -".jsonl".length)}.db` : `${sidecarPath}.db`;
}
