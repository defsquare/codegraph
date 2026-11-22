import { WALK_NAME_PATTERN } from "./definition.js";
import type { RecordFormat, StoredWalk, WalkMismatch } from "./format.js";
import {
  EXPLAIN_WALK_NAME,
  type FailureRecord,
  type GlossaryEntry,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type Level,
  type Origin,
  type RecordKey,
  type RecordUsage,
  type StoreHeader,
  type WalkRecord,
  type WordConcern,
  type WordEntry,
} from "./schema.js";
import type { RecordSummary } from "./records.js";
import type { InsightsFile } from "./sidecar.js";
import type { QuotedRecord } from "./spec.js";

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
 *
 * ONE STORE PER WALK (PLAN.md §22.4). A store is opened by ONE walk — its
 * `RecordFormat`, explain's by default — whose schemas check every record in and
 * out, and a store another walk wrote is refused before a byte is written, as a
 * foreign or newer file is. A walk named N keeps `<model>.N.walk.db`; explain
 * keeps `<model>.insights.db`.
 */

/** Bumped with every migration appended to the adapter's ladder — never regenerated. 2: `insight_word` (M19c). */
export const INSIGHTS_DB_VERSION = 2;

/** `PRAGMA application_id`: "CGI1". A SQLite file that is not ours is refused, not migrated. */
export const INSIGHTS_APPLICATION_ID = 0x43474931;

export class InsightsStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InsightsStoreError";
  }
}

/**
 * A store, or a side-car handed to it, of ANOTHER walk — or of the same walk under other answer fields (`reason`):
 * refused like a foreign file, both named, nothing written.
 */
export class WalkMismatchError extends InsightsStoreError {
  readonly found: StoredWalk;
  readonly expected: { readonly kind: string; readonly name: string };
  readonly reason: WalkMismatch;

  constructor(message: string, found: StoredWalk, expected: { readonly kind: string; readonly name: string }, reason: WalkMismatch = "walk") {
    super(message);
    this.name = "WalkMismatchError";
    this.found = found;
    this.expected = expected;
    this.reason = reason;
  }
}

/** The side-car as last written from this store: what an outside edit is measured against. */
export interface ExportStamp {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RunStart<H extends StoreHeader = InsightsHeader> {
  /** Of the store's own walk: a header naming another is refused (`WalkMismatchError`). */
  readonly header: H;
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
  /** Records a model wrote with no `words`: explained under prompt 1, before words were asked (M19c). */
  readonly withoutWords: number;
}

/** A word entry as `insight_word` holds it: all but `meaning`, which a reader that shows it reads from the block. */
export type ListedWord = Omit<WordEntry, "meaning">;

/** One record's entry for a word, with what a reader shows of the record (M19c). */
export interface WordHit {
  readonly id: string;
  readonly level: Level;
  readonly kind: string;
  readonly name: string | undefined;
  /** Where the record sits; a reader groups by it, never by parsing the id. */
  readonly key: RecordKey | undefined;
  readonly model: string | undefined;
  readonly entry: ListedWord;
}

/** One entry of a module record's `glossary`. */
export interface GlossaryHit {
  readonly id: string;
  readonly key: RecordKey | undefined;
  readonly name: string | undefined;
  readonly model: string | undefined;
  readonly entry: GlossaryEntry;
}

/** A word and a concern some record gave it, with that record's module (its natural key's). */
export interface ConcernRow {
  readonly lang: string | undefined;
  readonly module: string | undefined;
  readonly word: string;
  readonly concern: WordConcern;
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

export interface StoreOpenOptions<R extends WalkRecord = InsightRecord, H extends StoreHeader = InsightsHeader> {
  /**
   * For a READER (`codegraph insights`, the daemon): no migration, not a byte
   * written — SQLite itself refuses (`query_only`) — and a store that is not
   * already at this build's version is refused rather than brought to it.
   * Hand it an ordinary connection: a read-only FILE handle may not clean up
   * after itself and strands `-wal`/`-shm` beside the model.
   */
  readonly readOnly?: boolean;
  /**
   * The walk opening it (PLAN.md §22.4): its name is checked against the store's header before a byte is written,
   * and its schemas check every record written and read. Absent: explain's (`EXPLAIN_RECORDS`).
   */
  readonly format?: RecordFormat<R, H>;
}

/** Generic over the walk's record and header; the defaults are explain's, so every explain caller reads as before. */
export interface InsightsStore<R extends WalkRecord = InsightRecord, H extends StoreHeader = InsightsHeader> {
  /** Nothing imported, no run begun: a side-car found beside it is imported, not compared. */
  isEmpty(): boolean;
  header(): H | undefined;
  /** The last FINISHED state's trailer; undefined while a run is open or after a kill. */
  eof(): InsightsEof | undefined;
  /** Every record, in side-car order. */
  records(): R[];
  /** id → fingerprint, without reading a block. */
  fingerprints(): Map<string, string>;
  /** Explain's quote of one record (its concept rule), projected WITHOUT reading the rest of its block. */
  summary(id: string): RecordSummary | undefined;
  /**
   * The block's values at `paths` (dotted: `boundedContextHint.name`), projected in SQL without reading the rest of
   * it — what a walk's quote reads (`WalkSpec.quoted`); a path the block lacks is absent. Undefined with no record.
   */
  quoted(id: string, paths: readonly string[]): QuotedRecord | undefined;
  /** One record's `words`, projected likewise; undefined with no record, or one explained under prompt 1. */
  words(id: string): readonly WordEntry[] | undefined;
  /** The records that exist among `ids`, in side-car order. */
  get(ids: readonly string[]): R[];
  failures(): FailureRecord[];
  /** Rows matching a reader's filter, in side-car order. */
  query(query: InsightQuery): InsightRow[];
  stats(): InsightStats;
  /** Every record's words, in side-car order then block order; `word` keeps that word's, an index lookup (M19c). */
  wordHits(word?: string): WordHit[];
  /** The module records' glossary entries, in side-car order then block order; `word` keeps that word's. */
  glossaryEntries(word?: string): GlossaryHit[];
  /** Each (module, word, concern) the records' words hold, once; in no promised order. */
  concernRows(): ConcernRow[];
  /** `stats().withoutWords` alone. */
  withoutWords(): number;
  /** The ledger, oldest first. */
  runs(): RunRow[];
  exported(): ExportStamp | undefined;
  openRuns(): OpenRun[];

  /** Replace the store's content with a decoded side-car, in one transaction. The ledger is kept. A side-car of another walk is refused. */
  importFile(file: InsightsFile<R, H>): void;
  /** End a run that will never end itself (its process is gone). */
  closeRun(id: number, aborted: string): void;
  /** The store's FIRST write of a run: nothing before it (open, plan, `walkChange`) writes a byte. */
  beginRun(start: RunStart<H>): RunHandle;
  /** One transaction per finished UNIT: its records in, its failure row out. Half a cycle is never stored. */
  putUnit(run: RunHandle, unitId: string, records: readonly R[]): void;
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
 *
 * A WALK'S STORE SAYS WHOSE IT IS (PLAN.md §22.5): its answers carry `walk`,
 * the walk's name, right after `status` — so a reader tells a walk's block
 * from explain's by the data, never by its shape. Explain's carry no such key.
 */
export const INSIGHT_ANSWER_KIND = "codegraph.insight/1";

/** `walk`: present on a walk's store only. */
interface AnswerOf {
  readonly kind: typeof INSIGHT_ANSWER_KIND;
  readonly id: string;
  readonly walk?: string;
}

export type InsightAnswer<R extends WalkRecord = InsightRecord> =
  | (AnswerOf & { readonly status: "explained"; readonly record: R })
  | (AnswerOf & { readonly status: "failed"; readonly failure: FailureRecord })
  | (AnswerOf & { readonly status: "unknown" });

/** `walk`: the name of the walk whose store this is; omitted for explain's. */
export function answerInsight<R extends WalkRecord = InsightRecord>(store: Pick<InsightsStore<R, StoreHeader>, "get" | "failures">, id: string, walk?: string): InsightAnswer<R> {
  const whose = walk === undefined ? {} : { walk };
  const record = store.get([id])[0];
  if (record !== undefined) return { kind: INSIGHT_ANSWER_KIND, id, status: "explained", ...whose, record };
  // Matched by member: a failed cycle is one failure row, and every one of its members is owed.
  const failure = store.failures().find((candidate) => candidate.id === id || candidate.members.includes(id));
  return failure === undefined ? { kind: INSIGHT_ANSWER_KIND, id, status: "unknown", ...whose } : { kind: INSIGHT_ANSWER_KIND, id, status: "failed", ...whose, failure };
}

/** `X.insights.jsonl` → `X.insights.db`: the store sits beside the side-car it exports. */
export function insightsStorePathFor(sidecarPath: string): string {
  return sidecarPath.endsWith(".jsonl") ? `${sidecarPath.slice(0, -".jsonl".length)}.db` : `${sidecarPath}.db`;
}

/**
 * `X.jsonl` → `X.N.walk.jsonl`: a walk's side-car beside the model, as explain's is `X.insights.jsonl` (which
 * `explain` itself gets). The name is checked first — it becomes part of a path, so `../` never reaches one.
 */
export function walkSidecarPathFor(modelPath: string, walk: string): string {
  if (!WALK_NAME_PATTERN.test(walk) || walk === "insights") {
    throw new InsightsStoreError(`${JSON.stringify(walk)} is not a walk name: one matches [a-z][a-z0-9-]*, and "insights" is reserved for explain's store`);
  }
  const stem = modelPath.endsWith(".jsonl") ? modelPath.slice(0, -".jsonl".length) : modelPath;
  return walk === EXPLAIN_WALK_NAME ? `${stem}.insights.jsonl` : `${stem}.${walk}.walk.jsonl`;
}

/** `X.jsonl` → `X.N.walk.db`: the walk's store, beside the side-car it exports. */
export function walkStorePathFor(modelPath: string, walk: string): string {
  return insightsStorePathFor(walkSidecarPathFor(modelPath, walk));
}
